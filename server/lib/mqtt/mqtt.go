// Package mqtt is a minimal MQTT 3.1.1 client (plain TCP, QoS 0 publish and
// subscribe, QoS 1 acknowledgement of incoming messages) using only the
// standard library.
package mqtt

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Options configures a Client.
type Options struct {
	Host     string
	Port     int
	ClientID string
	User     string
	Pass     string
	// KeepAlive defaults to 30s.
	KeepAlive   time.Duration
	WillTopic   string
	WillPayload []byte
	WillRetain  bool
	// OnConnect is called after every (re)connect, after resubscribe.
	OnConnect func(c *Client)
}

// Message is a received PUBLISH.
type Message struct {
	Topic   string
	Payload []byte
}

type subscription struct {
	filter string
	h      func(Message)
}

// Client is a reconnecting MQTT client. It is safe for concurrent use.
type Client struct {
	o Options

	mu        sync.Mutex
	subs      []subscription
	conn      net.Conn
	connected bool
	lastErr   string
	nextID    uint16

	writeMu sync.Mutex
}

// New creates a client. Call Run to start connecting.
func New(o Options) *Client {
	if o.KeepAlive <= 0 {
		o.KeepAlive = 30 * time.Second
	}
	if o.Port == 0 {
		o.Port = 1883
	}
	if o.ClientID == "" {
		var b [4]byte
		rand.Read(b[:])
		o.ClientID = "cactarium-" + hex.EncodeToString(b[:])
	}
	return &Client{o: o}
}

// Subscribe registers a handler for a topic filter (+ and # supported). It is
// remembered and re-sent on every connect.
func (c *Client) Subscribe(filter string, h func(Message)) {
	c.mu.Lock()
	c.subs = append(c.subs, subscription{filter, h})
	conn, up := c.conn, c.connected
	id := c.newID()
	c.mu.Unlock()
	if up && conn != nil {
		c.write(conn, buildSubscribe(id, []string{filter}))
	}
}

// Publish sends a QoS 0 message. It fails if not connected.
func (c *Client) Publish(topic string, payload []byte, retain bool) error {
	c.mu.Lock()
	conn, up := c.conn, c.connected
	c.mu.Unlock()
	if !up || conn == nil {
		return errors.New("mqtt: not connected")
	}
	return c.write(conn, buildPublish(topic, payload, retain))
}

// Connected reports whether a session is established.
func (c *Client) Connected() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.connected
}

// LastError returns the last connection error, or "" after a good connect.
func (c *Client) LastError() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.lastErr
}

func (c *Client) setErr(err error) {
	c.mu.Lock()
	if err == nil {
		c.lastErr = ""
	} else {
		c.lastErr = err.Error()
	}
	c.mu.Unlock()
}

// newID must be called with c.mu held.
func (c *Client) newID() uint16 {
	c.nextID++
	if c.nextID == 0 {
		c.nextID = 1
	}
	return c.nextID
}

func (c *Client) write(conn net.Conn, pkt []byte) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	_, err := conn.Write(pkt)
	if err != nil {
		conn.Close() // forces the read loop to notice
	}
	return err
}

// Run connects and keeps the session alive until ctx is done, reconnecting with
// exponential backoff (1s..30s). It sends DISCONNECT on exit.
func (c *Client) Run(ctx context.Context) {
	backoff := time.Second
	for ctx.Err() == nil {
		start := time.Now()
		err := c.session(ctx)
		if ctx.Err() != nil {
			return
		}
		if err != nil {
			c.setErr(err)
		}
		if time.Since(start) > 60*time.Second {
			backoff = time.Second
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		if backoff *= 2; backoff > 30*time.Second {
			backoff = 30 * time.Second
		}
	}
}

func (c *Client) session(ctx context.Context) error {
	addr := net.JoinHostPort(c.o.Host, strconv.Itoa(c.o.Port))
	d := net.Dialer{Timeout: 10 * time.Second}
	conn, err := d.DialContext(ctx, "tcp", addr)
	if err != nil {
		return err
	}
	defer conn.Close()

	if err := c.write(conn, c.buildConnect()); err != nil {
		return err
	}
	conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	typ, _, body, err := readPacket(conn)
	if err != nil {
		return fmt.Errorf("waiting for CONNACK: %w", err)
	}
	if typ != 2 || len(body) < 2 {
		return fmt.Errorf("expected CONNACK, got packet type %d", typ)
	}
	if body[1] != 0 {
		return connackError(body[1])
	}

	c.mu.Lock()
	c.conn = conn
	c.connected = true
	c.lastErr = ""
	filters := make([]string, 0, len(c.subs))
	for _, s := range c.subs {
		filters = append(filters, s.filter)
	}
	id := c.newID()
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		if c.conn == conn {
			c.conn = nil
			c.connected = false
		}
		c.mu.Unlock()
	}()

	if len(filters) > 0 {
		if err := c.write(conn, buildSubscribe(id, filters)); err != nil {
			return err
		}
	}

	done := make(chan struct{})
	defer close(done)
	go func() { // keepalive pings and shutdown
		t := time.NewTicker(c.o.KeepAlive / 2)
		defer t.Stop()
		for {
			select {
			case <-done:
				return
			case <-ctx.Done():
				c.write(conn, []byte{0xE0, 0})
				conn.Close()
				return
			case <-t.C:
				if c.write(conn, []byte{0xC0, 0}) != nil {
					return
				}
			}
		}
	}()

	if c.o.OnConnect != nil {
		c.o.OnConnect(c)
	}

	for {
		// Any traffic (PINGRESP at the latest) must arrive within 1.5x keepalive.
		conn.SetReadDeadline(time.Now().Add(c.o.KeepAlive * 3 / 2))
		typ, flags, body, err := readPacket(conn)
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			var ne net.Error
			if errors.As(err, &ne) && ne.Timeout() {
				return errors.New("keepalive timeout (no PINGRESP)")
			}
			return err
		}
		switch typ {
		case 3: // PUBLISH
			c.handlePublish(conn, flags, body)
		case 6: // PUBREL
			if len(body) >= 2 {
				c.write(conn, []byte{0x70, 2, body[0], body[1]})
			}
		}
		// SUBACK (9), PINGRESP (13), PUBACK etc. only refresh the deadline.
	}
}

func (c *Client) handlePublish(conn net.Conn, flags byte, body []byte) {
	if len(body) < 2 {
		return
	}
	tl := int(body[0])<<8 | int(body[1])
	if len(body) < 2+tl {
		return
	}
	topic := string(body[2 : 2+tl])
	rest := body[2+tl:]
	qos := (flags >> 1) & 3
	if qos > 0 {
		if len(rest) < 2 {
			return
		}
		pid := rest[:2]
		rest = rest[2:]
		if qos == 1 {
			c.write(conn, []byte{0x40, 2, pid[0], pid[1]})
		} else {
			c.write(conn, []byte{0x50, 2, pid[0], pid[1]})
		}
	}
	payload := append([]byte(nil), rest...)
	c.mu.Lock()
	var hs []func(Message)
	for _, s := range c.subs {
		if topicMatch(s.filter, topic) {
			hs = append(hs, s.h)
		}
	}
	c.mu.Unlock()
	for _, h := range hs {
		h(Message{Topic: topic, Payload: payload})
	}
}

func connackError(code byte) error {
	switch code {
	case 1:
		return errors.New("connection refused: unacceptable protocol version")
	case 2:
		return errors.New("connection refused: client identifier rejected")
	case 3:
		return errors.New("connection refused: server unavailable")
	case 4:
		return errors.New("connection refused: bad username or password")
	case 5:
		return errors.New("connection refused: not authorized")
	}
	return fmt.Errorf("connection refused: code %d", code)
}

// topicMatch reports whether topic matches an MQTT filter with + and #.
func topicMatch(filter, topic string) bool {
	f := strings.Split(filter, "/")
	t := strings.Split(topic, "/")
	for i, fp := range f {
		if fp == "#" {
			return true
		}
		if i >= len(t) {
			return false
		}
		if fp != "+" && fp != t[i] {
			return false
		}
	}
	return len(f) == len(t)
}

// ---- wire format ----

func appendVarInt(b []byte, n int) []byte {
	for {
		d := byte(n % 128)
		n /= 128
		if n > 0 {
			d |= 0x80
		}
		b = append(b, d)
		if n == 0 {
			return b
		}
	}
}

func appendStr(b []byte, s string) []byte {
	b = append(b, byte(len(s)>>8), byte(len(s)))
	return append(b, s...)
}

func appendBytes(b, p []byte) []byte {
	b = append(b, byte(len(p)>>8), byte(len(p)))
	return append(b, p...)
}

func frame(first byte, body []byte) []byte {
	out := appendVarInt([]byte{first}, len(body))
	return append(out, body...)
}

func (c *Client) buildConnect() []byte {
	o := c.o
	var flags byte = 0x02 // clean session
	if o.WillTopic != "" {
		flags |= 0x04
		if o.WillRetain {
			flags |= 0x20
		}
	}
	if o.User != "" {
		flags |= 0x80
		if o.Pass != "" {
			flags |= 0x40
		}
	}
	ka := int(o.KeepAlive / time.Second)
	if ka > 65535 {
		ka = 65535
	}
	b := appendStr(nil, "MQTT")
	b = append(b, 4, flags, byte(ka>>8), byte(ka))
	b = appendStr(b, o.ClientID)
	if o.WillTopic != "" {
		b = appendStr(b, o.WillTopic)
		b = appendBytes(b, o.WillPayload)
	}
	if o.User != "" {
		b = appendStr(b, o.User)
		if o.Pass != "" {
			b = appendStr(b, o.Pass)
		}
	}
	return frame(0x10, b)
}

func buildSubscribe(id uint16, filters []string) []byte {
	b := []byte{byte(id >> 8), byte(id)}
	for _, f := range filters {
		b = appendStr(b, f)
		b = append(b, 0)
	}
	return frame(0x82, b)
}

func buildPublish(topic string, payload []byte, retain bool) []byte {
	var first byte = 0x30
	if retain {
		first |= 1
	}
	b := appendStr(nil, topic)
	b = append(b, payload...)
	return frame(first, b)
}

const maxPacket = 1 << 20

// readPacket reads one control packet: type, flags nibble, body.
func readPacket(r io.Reader) (typ, flags byte, body []byte, err error) {
	var h [1]byte
	if _, err = io.ReadFull(r, h[:]); err != nil {
		return
	}
	typ, flags = h[0]>>4, h[0]&0x0f
	n, mult := 0, 1
	for i := 0; ; i++ {
		if i == 4 {
			err = errors.New("mqtt: malformed remaining length")
			return
		}
		if _, err = io.ReadFull(r, h[:]); err != nil {
			return
		}
		n += int(h[0]&0x7f) * mult
		if h[0]&0x80 == 0 {
			break
		}
		mult *= 128
	}
	if n > maxPacket {
		err = fmt.Errorf("mqtt: packet too large (%d bytes)", n)
		return
	}
	body = make([]byte, n)
	if _, err = io.ReadFull(r, body); err != nil {
		return
	}
	return typ, flags, body, nil
}
