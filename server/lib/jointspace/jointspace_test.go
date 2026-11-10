package jointspace

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

// digestServer verifies digest auth like the TV does and counts challenges.
func digestServer(t *testing.T, user, pass string, challenges *int32, h http.HandlerFunc) *httptest.Server {
	t.Helper()
	const realm, nonce = "XTV", "abc123"
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := parseParams(strings.TrimPrefix(r.Header.Get("Authorization"), "Digest "))
		ok := false
		if r.Header.Get("Authorization") != "" && p["nonce"] == nonce && p["username"] == user {
			ha1 := md5hex(user + ":" + realm + ":" + pass)
			ha2 := md5hex(r.Method + ":" + p["uri"])
			want := md5hex(ha1 + ":" + nonce + ":" + p["nc"] + ":" + p["cnonce"] + ":auth:" + ha2)
			ok = want == p["response"] && p["uri"] == r.URL.RequestURI()
		}
		if !ok {
			atomic.AddInt32(challenges, 1)
			w.Header().Set("WWW-Authenticate", `Digest realm="`+realm+`", nonce="`+nonce+`", qop="auth", algorithm=MD5`)
			w.WriteHeader(401)
			return
		}
		h(w, r)
	}))
}

func TestDigestRetryAndCachedChallenge(t *testing.T) {
	var ch int32
	srv := digestServer(t, "u", "p", &ch, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/6/powerstate":
			if r.Method == "POST" {
				b, _ := io.ReadAll(r.Body)
				if !strings.Contains(string(b), "Standby") {
					t.Errorf("body lost on retry: %s", b)
				}
				return
			}
			io.WriteString(w, `{"powerstate":"On"}`)
		case "/6/audio/volume":
			io.WriteString(w, `{"muted":false,"current":12,"min":0,"max":60}`)
		}
	})
	defer srv.Close()
	c := New("x", "u", "p")
	c.SetBaseURLs(srv.URL, srv.URL)
	ctx := context.Background()

	if err := c.SetPowerState(ctx, "Standby"); err != nil { // 401 then retry with body
		t.Fatal(err)
	}
	s, err := c.PowerState(ctx)
	if err != nil || s != "On" {
		t.Fatalf("%q %v", s, err)
	}
	v, err := c.Volume(ctx)
	if err != nil || v.Current != 12 || v.Max != 60 {
		t.Fatalf("%+v %v", v, err)
	}
	if ch != 1 {
		t.Fatalf("challenge should be cached, got %d challenges", ch)
	}
}

func TestDigestBadPassword(t *testing.T) {
	var ch int32
	srv := digestServer(t, "u", "p", &ch, func(http.ResponseWriter, *http.Request) {})
	defer srv.Close()
	c := New("x", "u", "wrong")
	c.SetBaseURLs(srv.URL, srv.URL)
	err := c.SendKey(context.Background(), "Home")
	var se *StatusError
	if err == nil || !asStatus(err, &se) || se.Code != 401 {
		t.Fatalf("want 401, got %v", err)
	}
	if ch != 2 {
		t.Fatalf("exactly one retry expected, challenges=%d", ch)
	}
}

func asStatus(err error, t **StatusError) bool {
	s, ok := err.(*StatusError)
	*t = s
	return ok
}

func TestSignatureKnownValue(t *testing.T) {
	// HMAC-SHA1(key="secret", msg="1234567890"+"1234") base64.
	got := Signature([]byte("secret"), json.Number("1234567890"), "1234")
	if got != "tEaulpscSsIhlF07n90xRqWzLHU=" {
		t.Fatalf("signature %s", got)
	}
}

func TestPairFlow(t *testing.T) {
	var grant map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/6/pair/request":
			io.WriteString(w, `{"error_id":"SUCCESS","auth_key":"KEY","timestamp":1700000000,"timeout":60}`)
		case "/6/pair/grant":
			if r.Header.Get("Authorization") == "" {
				w.Header().Set("WWW-Authenticate", `Digest realm="r", nonce="n", qop="auth"`)
				w.WriteHeader(401)
				return
			}
			json.NewDecoder(r.Body).Decode(&grant)
			io.WriteString(w, `{"error_id":"SUCCESS"}`)
		}
	}))
	defer srv.Close()
	c := New("x", "", "")
	c.SetBaseURLs(srv.URL, srv.URL)
	p, err := c.PairRequest(context.Background())
	if err != nil || p.AuthKey != "KEY" || len(p.DeviceID) != 32 {
		t.Fatalf("%+v %v", p, err)
	}
	u, pw, err := c.PairGrant(context.Background(), p, "c2VjcmV0", "1234") // "secret"
	if err != nil || u != p.DeviceID || pw != "KEY" {
		t.Fatalf("%q %q %v", u, pw, err)
	}
	auth := grant["auth"].(map[string]any)
	if auth["auth_timestamp"].(float64) != 1700000000 || auth["pin"] != "1234" ||
		auth["auth_signature"] != Signature([]byte("secret"), "1700000000", "1234") {
		t.Fatalf("grant body %v", grant)
	}
}

func TestSystemUnauthenticated(t *testing.T) {
	plain := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"name":"tv"}`)
	}))
	defer plain.Close()
	c := New("x", "", "")
	c.SetBaseURLs(plain.URL, "http://127.0.0.1:1")
	m, err := c.System(context.Background())
	if err != nil || m["name"] != "tv" {
		t.Fatalf("%v %v", m, err)
	}
	if c.Paired() {
		t.Fatal("should not be paired")
	}
}
