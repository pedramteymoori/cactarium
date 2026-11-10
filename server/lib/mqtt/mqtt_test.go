package mqtt

import (
	"context"
	"net"
	"strconv"
	"sync"
	"testing"
	"time"
)

type pub struct {
	Topic   string
	Payload string
	Retain  bool
}

type fakeBroker struct {
	ln net.Listener

	mu       sync.Mutex
	conns    []net.Conn
	connects []connectInfo
	subs     []string
	pubs     []pub
	refuse   byte
}

type connectInfo struct {
	flags    byte
	clientID string
	user     string
	pass     string
	will     string
}

func newBroker(t *testing.T) *fakeBroker {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	b := &fakeBroker{ln: ln}
	go b.accept()
	t.Cleanup(func() { ln.Close(); b.dropAll() })
	return b
}

func (b *fakeBroker) port() int { return b.ln.Addr().(*net.TCPAddr).Port }

func (b *fakeBroker) accept() {
	for {
		c, err := b.ln.Accept()
		if err != nil {
			return
		}
		b.mu.Lock()
		b.conns = append(b.conns, c)
		b.mu.Unlock()
		go b.serve(c)
	}
}

func str(p []byte) (string, []byte) {
	n := int(p[0])<<8 | int(p[1])
	return string(p[2 : 2+n]), p[2+n:]
}

func (b *fakeBroker) serve(c net.Conn) {
	defer c.Close()
	for {
		typ, flags, body, err := readPacket(c)
		if err != nil {
			return
		}
		switch typ {
		case 1:
			_, rest := str(body) // protocol name
			ci := connectInfo{flags: rest[1]}
			rest = rest[4:]
			ci.clientID, rest = str(rest)
			if ci.flags&0x04 != 0 {
				ci.will, rest = str(rest)
				_, rest = str(rest)
			}
			if ci.flags&0x80 != 0 {
				ci.user, rest = str(rest)
			}
			if ci.flags&0x40 != 0 {
				ci.pass, _ = str(rest)
			}
			b.mu.Lock()
			b.connects = append(b.connects, ci)
			code := b.refuse
			b.mu.Unlock()
			c.Write([]byte{0x20, 2, 0, code})
		case 8:
			id := body[:2]
			rest := body[2:]
			var codes []byte
			for len(rest) > 0 {
				var f string
				f, rest = str(rest)
				rest = rest[1:]
				b.mu.Lock()
				b.subs = append(b.subs, f)
				b.mu.Unlock()
				codes = append(codes, 0)
			}
			c.Write(frame(0x90, append([]byte{id[0], id[1]}, codes...)))
		case 3:
			t, rest := str(body)
			b.mu.Lock()
			b.pubs = append(b.pubs, pub{t, string(rest), flags&1 != 0})
			b.mu.Unlock()
		case 12:
			c.Write([]byte{0xD0, 0})
		}
	}
}

func (b *fakeBroker) push(topic, payload string, qos1 bool) {
	b.mu.Lock()
	c := b.conns[len(b.conns)-1]
	b.mu.Unlock()
	if qos1 {
		body := appendStr(nil, topic)
		body = append(body, 0, 7)
		body = append(body, payload...)
		c.Write(frame(0x32, body))
		return
	}
	c.Write(buildPublish(topic, []byte(payload), false))
}

func (b *fakeBroker) dropAll() {
	b.mu.Lock()
	defer b.mu.Unlock()
	for _, c := range b.conns {
		c.Close()
	}
	b.conns = nil
}

func waitFor(t *testing.T, what string, f func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if f() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timeout waiting for %s", what)
}

func TestVarInt(t *testing.T) {
	for _, n := range []int{0, 127, 128, 16383, 16384, 2097151, 2097152, 268435455} {
		b := appendVarInt(nil, n)
		// decode
		v, m := 0, 1
		for _, d := range b {
			v += int(d&0x7f) * m
			m *= 128
		}
		if v != n {
			t.Errorf("varint %d -> %v -> %d", n, b, v)
		}
	}
	if b := appendVarInt(nil, 321); len(b) != 2 || b[0] != 0xC1 || b[1] != 0x02 {
		t.Errorf("321 encoded as %v", b)
	}
}

func TestTopicMatch(t *testing.T) {
	cases := []struct {
		f, t string
		ok   bool
	}{
		{"a/b", "a/b", true}, {"a/+", "a/b", true}, {"a/+", "a/b/c", false},
		{"a/#", "a/b/c", true}, {"#", "x/y", true}, {"a/+/c", "a/b/c", true},
		{"a/+/c", "a/b/d", false}, {"a/b", "a", false},
	}
	for _, c := range cases {
		if topicMatch(c.f, c.t) != c.ok {
			t.Errorf("match(%q,%q) want %v", c.f, c.t, c.ok)
		}
	}
}

func TestConnectSubscribePublish(t *testing.T) {
	b := newBroker(t)
	var mu sync.Mutex
	var got []Message
	var onConnects int
	c := New(Options{
		Host: "127.0.0.1", Port: b.port(), ClientID: "cid", User: "u", Pass: "p",
		WillTopic: "w/avail", WillPayload: []byte("offline"), WillRetain: true,
		OnConnect: func(c *Client) { mu.Lock(); onConnects++; mu.Unlock() },
	})
	if err := c.Publish("x", nil, false); err == nil {
		t.Fatal("publish before connect should fail")
	}
	c.Subscribe("dev/+/set", func(m Message) { mu.Lock(); got = append(got, m); mu.Unlock() })
	c.Subscribe("all/#", func(m Message) { mu.Lock(); got = append(got, m); mu.Unlock() })
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { c.Run(ctx); close(done) }()

	waitFor(t, "connected", c.Connected)
	waitFor(t, "subs", func() bool { b.mu.Lock(); defer b.mu.Unlock(); return len(b.subs) == 2 })
	b.mu.Lock()
	ci := b.connects[0]
	b.mu.Unlock()
	if ci.clientID != "cid" || ci.user != "u" || ci.pass != "p" || ci.will != "w/avail" ||
		ci.flags != 0x02|0x04|0x20|0x40|0x80 {
		t.Errorf("bad CONNECT: %+v", ci)
	}

	b.push("dev/power/set", "ON", false)
	b.push("all/x/y", "hi", true)
	b.push("other/topic", "no", false)
	waitFor(t, "messages", func() bool { mu.Lock(); defer mu.Unlock(); return len(got) == 2 })
	mu.Lock()
	if got[0].Topic != "dev/power/set" || string(got[0].Payload) != "ON" || string(got[1].Payload) != "hi" {
		t.Errorf("got %+v", got)
	}
	if onConnects != 1 {
		t.Errorf("onConnects=%d", onConnects)
	}
	mu.Unlock()

	if err := c.Publish("t/retained", []byte("v"), true); err != nil {
		t.Fatal(err)
	}
	if err := c.Publish("t/plain", []byte("w"), false); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "pubs", func() bool { b.mu.Lock(); defer b.mu.Unlock(); return len(b.pubs) == 2 })
	b.mu.Lock()
	if b.pubs[0] != (pub{"t/retained", "v", true}) || b.pubs[1] != (pub{"t/plain", "w", false}) {
		t.Errorf("pubs %+v", b.pubs)
	}
	b.mu.Unlock()

	cancel()
	<-done
	if c.Connected() {
		t.Error("still connected after Run")
	}
}

func TestReconnect(t *testing.T) {
	b := newBroker(t)
	var mu sync.Mutex
	n := 0
	c := New(Options{Host: "127.0.0.1", Port: b.port(), OnConnect: func(*Client) { mu.Lock(); n++; mu.Unlock() }})
	c.Subscribe("a/b", func(Message) {})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go c.Run(ctx)
	waitFor(t, "first connect", func() bool { mu.Lock(); defer mu.Unlock(); return n == 1 })
	b.dropAll()
	waitFor(t, "disconnect", func() bool { return !c.Connected() })
	waitFor(t, "reconnect", func() bool { mu.Lock(); defer mu.Unlock(); return n == 2 && c.Connected() })
	waitFor(t, "resubscribe", func() bool { b.mu.Lock(); defer b.mu.Unlock(); return len(b.subs) == 2 })
}

func TestConnackRefused(t *testing.T) {
	b := newBroker(t)
	b.refuse = 4
	c := New(Options{Host: "127.0.0.1", Port: b.port()})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go c.Run(ctx)
	waitFor(t, "error", func() bool { return c.LastError() != "" })
	if e := c.LastError(); e != "connection refused: bad username or password" {
		t.Errorf("err = %q", e)
	}
	if c.Connected() {
		t.Error("should not be connected")
	}
	_ = strconv.Itoa
}
