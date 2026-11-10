package routes

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func get(t *testing.T, url string, hdr ...string) (*http.Response, string) {
	t.Helper()
	req, _ := http.NewRequest("GET", url, nil)
	for i := 0; i+1 < len(hdr); i += 2 {
		req.Header.Set(hdr[i], hdr[i+1])
	}
	r, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(r.Body)
	r.Body.Close()
	return r, string(b)
}

func TestLauncherIconAllowlist(t *testing.T) {
	srv, api, _ := setup(t, "s3cret", true) // token set: the icon route must not need it
	base := t.TempDir()
	root := filepath.Join(base, "phi", "page")
	outside := filepath.Join(base, "secret")
	os.MkdirAll(filepath.Join(root, "assets/launcher/images"), 0o755)
	os.MkdirAll(outside, 0o755)
	os.WriteFile(filepath.Join(root, "assets/launcher/images/netflix.png"), []byte("\x89PNG-data"), 0o644)
	os.WriteFile(filepath.Join(root, "notes.txt"), []byte("text"), 0o644)
	os.WriteFile(filepath.Join(outside, "pw.png"), []byte("secret"), 0o644)
	os.Symlink(outside, filepath.Join(root, "escape"))                         // dir symlink out
	os.Symlink(filepath.Join(outside, "pw.png"), filepath.Join(root, "x.png")) // file symlink out
	srv.iconRoots = []string{root}
	srv.iconBases = []string{root, filepath.Join(root, "assets/launcher/images")}

	q := func(src string) string { return api.URL + "/launcher/icon?src=" + urlEnc(src) }

	// bare name (bundled asset), absolute path, file:// url, PHI's ?tag suffix
	for _, src := range []string{
		"netflix.png",
		filepath.Join(root, "assets/launcher/images/netflix.png"),
		"file://" + filepath.Join(root, "assets/launcher/images/netflix.png"),
		filepath.Join(root, "assets/launcher/images/netflix.png") + "?tag=0.123",
	} {
		r, body := get(t, q(src))
		if r.StatusCode != 200 || body != "\x89PNG-data" || r.Header.Get("Content-Type") != "image/png" {
			t.Fatalf("%q: %d %q %q", src, r.StatusCode, body, r.Header.Get("Content-Type"))
		}
	}
	// cache headers and conditional request
	r, _ := get(t, q("netflix.png"))
	etag := r.Header.Get("ETag")
	if etag == "" || !strings.Contains(r.Header.Get("Cache-Control"), "max-age") {
		t.Fatalf("headers %v", r.Header)
	}
	if r2, _ := get(t, q("netflix.png"), "If-None-Match", etag); r2.StatusCode != 304 {
		t.Fatalf("etag: %d", r2.StatusCode)
	}

	for name, src := range map[string]string{
		"dotdot":       filepath.Join(root, "../secret/pw.png"),
		"dotdot rel":   "../../secret/pw.png",
		"encoded":      "..%2f..%2fsecret/pw.png",
		"outside root": filepath.Join(outside, "pw.png"),
		"/etc/passwd":  "/etc/passwd",
		"not image":    filepath.Join(root, "notes.txt"),
		"dir symlink":  filepath.Join(root, "escape", "pw.png"),
		"file symlink": filepath.Join(root, "x.png"),
		"http":         "http://example.com/a.png",
		"empty":        "",
		"missing":      "nope.png",
		"nul":          "a\x00.png",
	} {
		if r, _ := get(t, q(src)); r.StatusCode != 404 {
			t.Errorf("%s: want 404, got %d", name, r.StatusCode)
		}
	}
	// default roots never include the temp dir
	srv.iconRoots, srv.iconBases = nil, nil
	if r, _ := get(t, q(filepath.Join(root, "assets/launcher/images/netflix.png"))); r.StatusCode != 404 {
		t.Errorf("default roots served a temp file: %d", r.StatusCode)
	}
}

func urlEnc(s string) string { return url.QueryEscape(s) }

func TestLauncherWeather(t *testing.T) {
	srv, api, _ := setup(t, "s3cret", true)
	var hits atomic.Int32
	var fail atomic.Bool
	var gotQuery atomic.Value
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		gotQuery.Store(r.URL.RawQuery)
		if fail.Load() {
			http.Error(w, "down", 500)
			return
		}
		io.WriteString(w, `{"current_units":{"temperature_2m":"°C"},"current":{"temperature_2m":13.6,"weather_code":2}}`)
	}))
	defer up.Close()
	srv.weatherURL = up.URL
	clock := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
	srv.now = func() time.Time { return clock }

	// not configured: no upstream call
	_, body := get(t, api.URL+"/api/launcher/weather")
	if !strings.Contains(body, `"enabled":false`) || hits.Load() != 0 {
		t.Fatalf("unconfigured: %s hits=%d", body, hits.Load())
	}
	// configure through the token-protected settings API
	req, _ := http.NewRequest("POST", api.URL+"/api/settings", strings.NewReader(`{"launcher":{"weather":{"latitude":51.5,"longitude":-0.12}}}`))
	req.Header.Set("X-Cactarium-Token", "s3cret")
	if r, _ := http.DefaultClient.Do(req); r.StatusCode != 200 {
		t.Fatalf("settings %d", r.StatusCode)
	}
	read := func() map[string]any {
		_, b := get(t, api.URL+"/api/launcher/weather")
		var m map[string]any
		json.Unmarshal([]byte(b), &m)
		return m
	}
	m := read()
	w, _ := m["weather"].(map[string]any)
	if m["ok"] != true || w["temp"] != float64(14) || w["label"] != "Partly cloudy" || w["kind"] != "cloud" {
		t.Fatalf("%v", m)
	}
	if q, _ := gotQuery.Load().(string); !strings.Contains(q, "latitude=51.5000") || !strings.Contains(q, "current=temperature_2m%2Cweather_code") {
		t.Fatalf("query %q", q)
	}
	read()
	clock = clock.Add(29 * time.Minute)
	read()
	if hits.Load() != 1 {
		t.Fatalf("cached reads must not hit upstream: %d", hits.Load())
	}
	// after the TTL it refreshes; on failure it serves the stale value and backs off
	clock = clock.Add(2 * time.Minute)
	fail.Store(true)
	m = read()
	if hits.Load() != 2 || m["ok"] != true || m["stale"] != true {
		t.Fatalf("stale: %v hits=%d", m, hits.Load())
	}
	read()
	if hits.Load() != 2 {
		t.Fatalf("must back off after a failure: %d", hits.Load())
	}
	clock = clock.Add(3 * time.Minute)
	fail.Store(false)
	if m = read(); hits.Load() != 3 || m["stale"] != nil {
		t.Fatalf("recover: %v", m)
	}
	// changing the location invalidates the cache; invalid input is rejected; clear works
	post := func(body string) int {
		req, _ := http.NewRequest("POST", api.URL+"/api/settings", strings.NewReader(body))
		req.Header.Set("X-Cactarium-Token", "s3cret")
		r, _ := http.DefaultClient.Do(req)
		return r.StatusCode
	}
	if post(`{"launcher":{"weather":{"latitude":91,"longitude":0}}}`) != 400 || post(`{"launcher":{"weather":{"latitude":1}}}`) != 400 {
		t.Fatal("invalid location accepted")
	}
	post(`{"launcher":{"weather":{"latitude":40,"longitude":-3}}}`)
	read()
	if hits.Load() != 4 {
		t.Fatalf("new location must refetch: %d", hits.Load())
	}
	post(`{"launcher":{"weather":{"clear":true}}}`)
	if m = read(); m["enabled"] != false {
		t.Fatalf("clear: %v", m)
	}
}
