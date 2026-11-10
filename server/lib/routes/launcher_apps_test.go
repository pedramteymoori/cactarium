package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"cactarium/server/lib/config"
	"cactarium/server/lib/titancat"
)

// catalogServer serves a two-app catalog and returns a Catalog loaded from it.
func catalogServer(t *testing.T) *titancat.Catalog {
	t.Helper()
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{
			"collection": []titancat.App{
				{ID: 1, Code: "netflix", Name: "Netflix", URL: "localfunction:gotonetflix", AppType: "NetTV", Icon: "https://eu.app.titanos.tv:443/img/abc"},
				{ID: 826, Code: "npo_start", Name: "NPO Start", URL: "https://smarttv.npoplayer.nl/titanos.html", AppType: "NetTV", Icon: "https://evil.example/img/x"},
			},
			"pagination": map[string]any{"next_page": nil},
		})
	}))
	t.Cleanup(ts.Close)
	c := titancat.New("", ts.Client(), ts.URL)
	if err := c.Refresh(context.Background(), titancat.Query{Market: "NL", Locale: "nl", Model: "m", Firmware: "f"}); err != nil {
		t.Fatal(err)
	}
	return c
}

func TestLauncherApps(t *testing.T) {
	srv, api, _ := setup(t, "s3cret", true) // no token needed
	r, body := get(t, api.URL+"/api/launcher/apps")
	if r.StatusCode != 200 || body != "{\"apps\":[]}\n" {
		t.Fatalf("empty: %d %q", r.StatusCode, body)
	}
	srv.catalog = catalogServer(t)
	srv.store.Update(func(c *config.Config) { c.Launcher.Apps = []string{"npo_start", "tv", "gone", "netflix", "../x"} })
	r, body = get(t, api.URL+"/api/launcher/apps")
	if r.Header.Get("Access-Control-Allow-Origin") != "*" || r.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("headers %v", r.Header)
	}
	var got struct {
		Apps    []launcherApp `json:"apps"`
		Missing []string      `json:"missing"`
	}
	if err := json.Unmarshal([]byte(body), &got); err != nil {
		t.Fatal(err)
	}
	if len(got.Apps) != 3 || got.Apps[0].Code != "npo_start" || got.Apps[1].Code != "tv" || got.Apps[1].Name != "TV" ||
		got.Apps[1].URL != "" || got.Apps[2].Code != "netflix" ||
		got.Apps[0].URL != "https://smarttv.npoplayer.nl/titanos.html" || got.Apps[0].Icon != "/launcher/titan-icon?code=npo_start" {
		t.Fatalf("apps: %+v", got.Apps)
	}
	if len(got.Missing) != 2 || got.Missing[0] != "gone" || got.Missing[1] != "../x" {
		t.Fatalf("missing: %v", got.Missing)
	}
}

func TestTitanIcon(t *testing.T) {
	srv, api, _ := setup(t, "", true)
	srv.catalog = catalogServer(t)
	var asked []string
	srv.iconGet = func(_ context.Context, u string) ([]byte, string, error) {
		asked = append(asked, u)
		return []byte("RIFFxxxxWEBPVP8 "), "image/webp", nil
	}
	for _, bad := range []string{"", "NETFLIX", "../etc", "a/b", "unknown", "netflix%00", "x y"} {
		if r, _ := get(t, api.URL+"/launcher/titan-icon?code="+urlEnc(bad)); r.StatusCode != 404 {
			t.Fatalf("%q: %d", bad, r.StatusCode)
		}
	}
	if len(asked) != 0 {
		t.Fatalf("fetched for bad codes: %v", asked)
	}
	r, body := get(t, api.URL+"/launcher/titan-icon?code=netflix")
	if r.StatusCode != 200 || body != "RIFFxxxxWEBPVP8 " || r.Header.Get("Content-Type") != "image/webp" ||
		r.Header.Get("Cache-Control") != "public, max-age=86400" {
		t.Fatalf("icon: %d %q %v", r.StatusCode, body, r.Header)
	}
	if len(asked) != 1 || asked[0] != "https://eu.app.titanos.tv:443/img/width/164/height/164/quality/85/abc" {
		t.Fatalf("asked %v", asked)
	}
	if _, err := os.Stat(filepath.Join(srv.iconDir(), "netflix.webp")); err != nil {
		t.Fatal(err)
	}
	get(t, api.URL+"/launcher/titan-icon?code=netflix") // second hit comes from disk
	if len(asked) != 1 {
		t.Fatalf("not cached: %v", asked)
	}
	// icon on a foreign host is refused
	if r, _ := get(t, api.URL+"/launcher/titan-icon?code=npo_start"); r.StatusCode != 404 {
		t.Fatalf("foreign host: %d", r.StatusCode)
	}
}

func TestSettingsLauncherApps(t *testing.T) {
	_, api, _ := setup(t, "", true)
	code, _ := call(t, "POST", api.URL+"/api/settings", `{"launcher":{"apps":["tv","netflix"],"catalog":{"model":"M","firmware":"F"}}}`, "")
	if code != 200 {
		t.Fatalf("post: %d", code)
	}
	_, m := call(t, "GET", api.URL+"/api/settings", "", "")
	l := m["launcher"].(map[string]any)
	k := l["catalog"].(map[string]any)
	if len(l["apps"].([]any)) != 2 || k["model"] != "M" || k["firmware"] != "F" || k["market"] != "NL" {
		t.Fatalf("settings: %v", l)
	}
	if code, _ := call(t, "POST", api.URL+"/api/settings", `{"launcher":{"apps":["Bad Code"]}}`, ""); code != 400 {
		t.Fatalf("bad code: %d", code)
	}
}
