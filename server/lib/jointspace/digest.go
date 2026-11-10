package jointspace

import (
	"crypto/md5"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net/http"
	"strings"
	"sync"
)

// digestAuth implements RFC 2617 MD5 / qop=auth. The TV challenges every
// request on a fresh connection, so we cache the last challenge and bump nc
// to avoid a 401 round trip per call.
type digestAuth struct {
	mu        sync.Mutex
	user      string
	pass      string
	challenge map[string]string
	nc        int
}

func (d *digestAuth) setCreds(user, pass string) {
	d.mu.Lock()
	d.user, d.pass, d.challenge, d.nc = user, pass, nil, 0
	d.mu.Unlock()
}

func (d *digestAuth) creds() (string, string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.user, d.pass
}

// setChallenge parses a WWW-Authenticate header; false if it is not Digest.
func (d *digestAuth) setChallenge(h string) bool {
	if len(h) < 7 || !strings.EqualFold(h[:7], "digest ") {
		return false
	}
	ch := parseParams(h[7:])
	d.mu.Lock()
	d.challenge, d.nc = ch, 0
	d.mu.Unlock()
	return ch["nonce"] != ""
}

// authorize returns an Authorization header value, or "" with no challenge.
func (d *digestAuth) authorize(method, uri string) string {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.challenge == nil {
		return ""
	}
	ch := d.challenge
	d.nc++
	nc := fmt.Sprintf("%08x", d.nc)
	cn := randHex(8)
	ha1 := md5hex(d.user + ":" + ch["realm"] + ":" + d.pass)
	if strings.EqualFold(ch["algorithm"], "MD5-sess") {
		ha1 = md5hex(ha1 + ":" + ch["nonce"] + ":" + cn)
	}
	ha2 := md5hex(method + ":" + uri)
	var resp string
	qop := ""
	for _, q := range strings.Split(ch["qop"], ",") {
		if strings.TrimSpace(q) == "auth" {
			qop = "auth"
		}
	}
	if qop != "" {
		resp = md5hex(ha1 + ":" + ch["nonce"] + ":" + nc + ":" + cn + ":" + qop + ":" + ha2)
	} else {
		resp = md5hex(ha1 + ":" + ch["nonce"] + ":" + ha2)
	}
	parts := []string{
		fmt.Sprintf(`username=%q`, d.user),
		fmt.Sprintf(`realm=%q`, ch["realm"]),
		fmt.Sprintf(`nonce=%q`, ch["nonce"]),
		fmt.Sprintf(`uri=%q`, uri),
		fmt.Sprintf(`response=%q`, resp),
	}
	if ch["algorithm"] != "" {
		parts = append(parts, "algorithm="+ch["algorithm"])
	}
	if ch["opaque"] != "" {
		parts = append(parts, fmt.Sprintf(`opaque=%q`, ch["opaque"]))
	}
	if qop != "" {
		parts = append(parts, "qop=auth", "nc="+nc, fmt.Sprintf(`cnonce=%q`, cn))
	}
	return "Digest " + strings.Join(parts, ", ")
}

func (d *digestAuth) sign(req *http.Request) {
	if h := d.authorize(req.Method, req.URL.RequestURI()); h != "" {
		req.Header.Set("Authorization", h)
	}
}

func md5hex(s string) string {
	sum := md5.Sum([]byte(s))
	return hex.EncodeToString(sum[:])
}

func randHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// parseParams parses `k="v", k2=v2` lists (values may contain commas in quotes).
func parseParams(s string) map[string]string {
	out := map[string]string{}
	for len(s) > 0 {
		s = strings.TrimLeft(s, " ,")
		eq := strings.IndexByte(s, '=')
		if eq < 0 {
			break
		}
		key := strings.ToLower(strings.TrimSpace(s[:eq]))
		s = s[eq+1:]
		var val string
		if strings.HasPrefix(s, `"`) {
			end := 1
			for end < len(s) && s[end] != '"' {
				if s[end] == '\\' {
					end++
				}
				end++
			}
			if end > len(s) {
				end = len(s)
			}
			val = strings.ReplaceAll(s[1:end], `\"`, `"`)
			if end < len(s) {
				end++
			}
			s = s[end:]
		} else {
			end := strings.IndexByte(s, ',')
			if end < 0 {
				end = len(s)
			}
			val = strings.TrimSpace(s[:end])
			s = s[end:]
		}
		out[key] = val
	}
	return out
}
