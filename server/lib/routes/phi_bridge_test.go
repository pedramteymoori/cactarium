package routes

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"cactarium/server/lib/titancat"
)

func lan(r *http.Request) *http.Request { r.RemoteAddr = "198.51.100.20:5555"; return r }

// hookOnce plays the hook: takes one job and answers it with reply(job).
func hookOnce(t *testing.T, h http.Handler, reply func(j map[string]any) string) {
	t.Helper()
	req := httptest.NewRequest("GET", "/api/tv/phi/next", nil)
	req.RemoteAddr = "127.0.0.1:1"
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Errorf("next: %d", rec.Code)
		return
	}
	var j map[string]any
	json.Unmarshal(rec.Body.Bytes(), &j)
	req = httptest.NewRequest("POST", "/api/tv/phi/result", strings.NewReader(reply(j)))
	req.RemoteAddr = "127.0.0.1:1"
	h.ServeHTTP(httptest.NewRecorder(), req)
}

func TestPhiAllowlistAndAuth(t *testing.T) {
	srv, api, _ := setup(t, "s3cret", true)
	srv.phi.answer = 50 * time.Millisecond
	if code, _ := call(t, "POST", api.URL+"/api/tv/phi", `{"method":"RpcModelInfoGet"}`, ""); code != 401 {
		t.Fatalf("no token: %d", code)
	}
	if code, _ := call(t, "POST", api.URL+"/api/tv/reboot", ``, ""); code != 401 {
		t.Fatalf("reboot no token: %d", code)
	}
	for _, m := range []string{"RpcFactoryReset", "RpcWifiPasswordGet", "", "alert", "RpcPictureContrastSet"} {
		code, body := call(t, "POST", api.URL+"/api/tv/phi", `{"method":"`+m+`"}`, "s3cret")
		if code != 400 || body["error"] != "method not allowed" {
			t.Errorf("%q: %d %v", m, code, body)
		}
	}
}

func TestPhiTimeout(t *testing.T) {
	srv, api, _ := setup(t, "", true)
	srv.phi.answer = 50 * time.Millisecond
	code, body := call(t, "POST", api.URL+"/api/tv/phi", `{"method":"RpcModelInfoGet"}`, "")
	if code != 504 || body["error"] != "the TV's UI page did not answer" {
		t.Fatalf("%d %v", code, body)
	}
	// the abandoned job is not handed to a later poll
	srv.phi.hold = 20 * time.Millisecond
	req := httptest.NewRequest("GET", "/api/tv/phi/next", nil)
	req.RemoteAddr = "127.0.0.1:1"
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != 204 {
		t.Fatalf("next after timeout: %d", rec.Code)
	}
}

func TestPhiResultRouting(t *testing.T) {
	srv, api, _ := setup(t, "", true)
	h := srv.Handler()
	var wg sync.WaitGroup
	results := make([]string, 3)
	codes := make([]int, 3)
	methods := []string{"RpcModelInfoGet", "RpcPictureFormatGet", "RpcMixedVolumeGet"}
	for i, m := range methods {
		wg.Add(1)
		go func(i int, m string) {
			defer wg.Done()
			var code int
			var body map[string]any
			code, body = call(t, "POST", api.URL+"/api/tv/phi", `{"method":"`+m+`","params":{"a":1}}`, "")
			codes[i] = code
			if code == 200 {
				b, _ := json.Marshal(body["result"])
				results[i] = string(b)
			} else {
				results[i] = body["error"].(string)
			}
		}(i, m)
	}
	// Answer all three, out of order: reject the PictureFormat one.
	var pending []map[string]any
	for i := 0; i < 3; i++ {
		req := httptest.NewRequest("GET", "/api/tv/phi/next", nil)
		req.RemoteAddr = "127.0.0.1:1"
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		var j map[string]any
		json.Unmarshal(rec.Body.Bytes(), &j)
		if p, _ := json.Marshal(j["params"]); string(p) != `{"a":1}` {
			t.Errorf("params %s", p)
		}
		pending = append(pending, j)
	}
	for i := len(pending) - 1; i >= 0; i-- {
		j := pending[i]
		var body string
		id := int(j["id"].(float64))
		if j["method"] == "RpcPictureFormatGet" {
			body = `{"id":` + itoa(id) + `,"ok":false,"error":"boom"}`
		} else {
			body = `{"id":` + itoa(id) + `,"ok":true,"result":{"m":"` + j["method"].(string) + `"}}`
		}
		req := httptest.NewRequest("POST", "/api/tv/phi/result", strings.NewReader(body))
		req.RemoteAddr = "127.0.0.1:1"
		h.ServeHTTP(httptest.NewRecorder(), req)
	}
	wg.Wait()
	for i, m := range methods {
		if m == "RpcPictureFormatGet" {
			if codes[i] != 502 || results[i] != "boom" {
				t.Errorf("%s: %d %s", m, codes[i], results[i])
			}
		} else if codes[i] != 200 || results[i] != `{"m":"`+m+`"}` {
			t.Errorf("%s: %d %s", m, codes[i], results[i])
		}
	}
}

func itoa(n int) string { b, _ := json.Marshal(n); return string(b) }

func TestPhiHookRoutesLoopbackOnly(t *testing.T) {
	srv, _, _ := setup(t, "s3cret", true)
	h := srv.Handler()
	for _, rq := range []*http.Request{
		httptest.NewRequest("GET", "/api/tv/phi/next", nil),
		httptest.NewRequest("POST", "/api/tv/phi/result", strings.NewReader(`{"id":1,"ok":true}`)),
	} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, lan(rq))
		if rec.Code != http.StatusForbidden {
			t.Errorf("%s from LAN: %d", rq.URL.Path, rec.Code)
		}
	}
	// next from the TV itself needs no token and gives 204 when idle
	srv.phi.hold = 20 * time.Millisecond
	req := httptest.NewRequest("GET", "/api/tv/phi/next", nil)
	req.RemoteAddr = "127.0.0.1:9"
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != 204 {
		t.Errorf("idle next: %d", rec.Code)
	}
}

func TestRebootThroughPhi(t *testing.T) {
	srv, api, _ := setup(t, "s3cret", true)
	rebooted := make(chan struct{}, 1)
	srv.reboot = func() error { rebooted <- struct{}{}; return nil }
	srv.phi.grace = time.Hour
	h := srv.Handler()
	go hookOnce(t, h, func(j map[string]any) string {
		if j["method"] != "RpcRestartTV" {
			t.Errorf("method %v", j["method"])
		}
		return `{"id":` + itoa(int(j["id"].(float64))) + `,"ok":true,"result":{}}`
	})
	code, body := call(t, "POST", api.URL+"/api/tv/reboot", ``, "s3cret")
	if code != 202 || body["via"] != "phi" {
		t.Fatalf("%d %v", code, body)
	}
	select {
	case <-rebooted:
		t.Fatal("rebooted although PHI took the restart")
	case <-time.After(1500 * time.Millisecond):
	}
}

func TestRebootFallbackWhenHookSilent(t *testing.T) {
	srv, api, _ := setup(t, "s3cret", true)
	rebooted := make(chan struct{}, 1)
	srv.reboot = func() error { rebooted <- struct{}{}; return nil }
	srv.phi.restart = 50 * time.Millisecond
	code, body := call(t, "POST", api.URL+"/api/tv/reboot", ``, "s3cret")
	if code != 202 || body["via"] != "reboot" {
		t.Fatalf("%d %v", code, body)
	}
	select {
	case <-rebooted:
	case <-time.After(3 * time.Second):
		t.Fatal("reboot not called")
	}
}

func TestTitanCatalogEndpoint(t *testing.T) {
	srv, api, _ := setup(t, "s3cret", true)
	if code, _ := call(t, "GET", api.URL+"/api/titan/catalog", "", ""); code != 401 {
		t.Fatalf("no token: %d", code)
	}
	r, body := get(t, api.URL+"/api/titan/catalog", "X-Cactarium-Token", "s3cret")
	if r.StatusCode != 200 || strings.TrimSpace(body) != "[]" {
		t.Fatalf("empty: %d %q", r.StatusCode, body)
	}
	cache := filepath.Join(t.TempDir(), "cat.json")
	os.WriteFile(cache, []byte(`{"version":2,"fetched":"2026-01-01T00:00:00Z","apps":[{"code":"zed","name":"Zed","app_type":"NetTV"},{"code":"abc","name":"abc","app_type":"NetTV"},{"code":"Bad Code","name":"x"}]}`), 0o600)
	srv.catalog = titancat.New(cache, nil, "")
	_, body = get(t, api.URL+"/api/titan/catalog", "X-Cactarium-Token", "s3cret")
	var l []map[string]string
	json.Unmarshal([]byte(body), &l)
	if len(l) != 2 || l[0]["code"] != "abc" || l[1]["code"] != "zed" || l[0]["icon"] != "/launcher/titan-icon?code=abc" || l[1]["app_type"] != "NetTV" {
		t.Fatalf("%s", body)
	}
}

func TestLegacyRecentRemoved(t *testing.T) {
	srv, _, _ := setup(t, "", true)
	p := filepath.Join(filepath.Dir(srv.store.Path()), "launcher-recent.json")
	os.WriteFile(p, []byte("[]"), 0o600)
	srv.removeLegacyRecent()
	if _, err := os.Stat(p); err == nil {
		t.Fatal("still there")
	}
}
