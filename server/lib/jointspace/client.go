// Package jointspace is a client for the Philips JointSpace v6 REST API as
// served by TitanOS: unauthenticated on :1925, digest-authenticated HTTPS on
// :1926 with a self-signed certificate.
package jointspace

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"
)

const timeout = 4 * time.Second

// Client talks to one TV. It is safe for concurrent use.
type Client struct {
	host      string
	plainBase string // http://host:1925
	tlsBase   string // https://host:1926
	hc        *http.Client
	auth      digestAuth
}

// New returns a client; empty user/pass means unpaired.
func New(host, user, pass string) *Client {
	c := &Client{
		host:      host,
		plainBase: "http://" + net.JoinHostPort(host, "1925"),
		tlsBase:   "https://" + net.JoinHostPort(host, "1926"),
		hc: &http.Client{
			Timeout: timeout,
			Transport: &http.Transport{
				// The TV's certificate is self-signed.
				TLSClientConfig:     &tls.Config{InsecureSkipVerify: true},
				MaxIdleConns:        4,
				MaxIdleConnsPerHost: 2,
				IdleConnTimeout:     30 * time.Second,
				TLSHandshakeTimeout: timeout,
			},
		},
	}
	c.auth.setCreds(user, pass)
	return c
}

// SetBaseURLs overrides the plain and TLS base URLs (tests, port forwards).
func (c *Client) SetBaseURLs(plain, tlsURL string) {
	c.plainBase, c.tlsBase = strings.TrimRight(plain, "/"), strings.TrimRight(tlsURL, "/")
}

// SetCredentials replaces the digest credentials.
func (c *Client) SetCredentials(user, pass string) { c.auth.setCreds(user, pass) }

// Paired reports whether credentials are set.
func (c *Client) Paired() bool {
	u, p := c.auth.creds()
	return u != "" && p != ""
}

// Do performs an authenticated JSON call on :1926. in/out may be nil.
func (c *Client) Do(ctx context.Context, method, path string, in, out any) error {
	return c.do(ctx, c.tlsBase, &c.auth, method, path, in, out)
}

// doPlain performs an unauthenticated call on :1925.
func (c *Client) doPlain(ctx context.Context, method, path string, in, out any) error {
	return c.do(ctx, c.plainBase, nil, method, path, in, out)
}

// StatusError is returned for non-2xx responses.
type StatusError struct {
	Code int
	Body string
}

func (e *StatusError) Error() string {
	if e.Body == "" {
		return fmt.Sprintf("jointspace: HTTP %d", e.Code)
	}
	return fmt.Sprintf("jointspace: HTTP %d: %s", e.Code, e.Body)
}

func (c *Client) do(ctx context.Context, base string, da *digestAuth, method, path string, in, out any) error {
	var body []byte
	if in != nil {
		b, err := json.Marshal(in)
		if err != nil {
			return err
		}
		body = b
	}
	// At most one retry, after refreshing the digest challenge on a 401.
	for attempt := 0; ; attempt++ {
		var rd io.Reader
		if body != nil {
			rd = bytes.NewReader(body)
		}
		req, err := http.NewRequestWithContext(ctx, method, base+path, rd)
		if err != nil {
			return err
		}
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		if da != nil {
			da.sign(req)
		}
		resp, err := c.hc.Do(req)
		if err != nil {
			return err
		}
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
		resp.Body.Close()
		if resp.StatusCode == http.StatusUnauthorized && da != nil && attempt == 0 &&
			da.setChallenge(resp.Header.Get("WWW-Authenticate")) {
			continue
		}
		if resp.StatusCode < 200 || resp.StatusCode > 299 {
			msg := strings.TrimSpace(string(data))
			if len(msg) > 200 {
				msg = msg[:200]
			}
			return &StatusError{resp.StatusCode, msg}
		}
		if out == nil || len(bytes.TrimSpace(data)) == 0 {
			return nil
		}
		return json.Unmarshal(data, out)
	}
}
