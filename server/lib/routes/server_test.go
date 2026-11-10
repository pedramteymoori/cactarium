package routes

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"cactarium/server/lib/config"
	"cactarium/server/lib/jointspace"
	"cactarium/server/lib/telemetry"
)

// fakeTV answers every call without auth (digest is covered in jointspace).
type fakeTV struct {
	mu    sync.Mutex
	vol   jointspace.Volume
	power string
	keys  []string
	ambi  string
	// noPower makes /6/powerstate answer 404, as TitanOS does on 55PUS8450/12.
	noPower bool
}

func (f *fakeTV) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var body map[string]any
	json.NewDecoder(r.Body).Decode(&body)
	post := r.Method == http.MethodPost
	switch r.URL.Path {
	case "/6/system":
		io.WriteString(w, `{"name":"Test TV","model":"X"}`)
	case "/6/powerstate":
		if f.noPower {
			http.NotFound(w, r)
			return
		}
		if post {
			f.power = body["powerstate"].(string)
			return
		}
		json.NewEncoder(w).Encode(map[string]string{"powerstate": f.power})
	case "/6/screenstate":
		io.WriteString(w, `{"screenstate":"On"}`)
	case "/6/audio/volume":
		if post {
			f.vol.Current = int(body["current"].(float64))
			f.vol.Muted = body["muted"].(bool)
			return
		}
		json.NewEncoder(w).Encode(f.vol)
	case "/6/input/key":
		f.keys = append(f.keys, body["key"].(string))
	case "/6/ambilight/power":
		if post {
			f.ambi = body["power"].(string)
			return
		}
		json.NewEncoder(w).Encode(map[string]string{"power": f.ambi})
	case "/6/ambilight/currentconfiguration":
		io.WriteString(w, `{"styleName":"FOLLOW_VIDEO"}`)
	case "/6/ambilight/supportedstyles":
		io.WriteString(w, `{"supportedStyles":[]}`)
	case "/6/ambilight/topology":
		io.WriteString(w, `{"layers":1}`)
	default:
		http.NotFound(w, r)
	}
}

func setup(t *testing.T, token string, paired bool) (*Server, *httptest.Server, *fakeTV) {
	t.Helper()
	tv := &fakeTV{vol: jointspace.Volume{Current: 10, Min: 0, Max: 60}, power: "On", ambi: "Off"}
	tvSrv := httptest.NewServer(tv)
	t.Cleanup(tvSrv.Close)
	store, err := config.Open(filepath.Join(t.TempDir(), "c.json"))
	if err != nil {
		t.Fatal(err)
	}
	store.Update(func(c *config.Config) { c.Token = token })
	user, pass := "", ""
	if paired {
		user, pass = "u", "p"
	}
	js := jointspace.New("x", user, pass)
	js.SetBaseURLs(tvSrv.URL, tvSrv.URL)
	srv := New(Options{Store: store, JS: js, Sampler: telemetry.NewSampler(0), Version: "test"})
	api := httptest.NewServer(srv.Handler())
	t.Cleanup(api.Close)
	srv.poll()
	return srv, api, tv
}

func call(t *testing.T, method, url, body, token string) (int, map[string]any) {
	t.Helper()
	req, _ := http.NewRequest(method, url, strings.NewReader(body))
	if token != "" {
		req.Header.Set("X-Cactarium-Token", token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var m map[string]any
	json.NewDecoder(resp.Body).Decode(&m)
	return resp.StatusCode, m
}

func TestAPIHappyPath(t *testing.T) {
	_, api, tv := setup(t, "", true)

	code, st := call(t, "GET", api.URL+"/api/state", "", "")
	if code != 200 || st["version"] != "test" {
		t.Fatalf("%d %v", code, st)
	}
	tvm := st["tv"].(map[string]any)
	if tvm["reachable"] != true || tvm["paired"] != true || tvm["power"] != "On" {
		t.Fatalf("tv %v", tvm)
	}
	if tvm["volume"].(map[string]any)["current"].(float64) != 10 {
		t.Fatalf("volume %v", tvm["volume"])
	}

	code, st = call(t, "POST", api.URL+"/api/volume", `{"step":2}`, "")
	if code != 200 || st["tv"].(map[string]any)["volume"].(map[string]any)["current"].(float64) != 12 {
		t.Fatalf("volume step: %d %v", code, st)
	}
	call(t, "POST", api.URL+"/api/volume", `{"muted":true}`, "")
	if !tv.vol.Muted || tv.vol.Current != 12 {
		t.Fatalf("mute kept level? %+v", tv.vol)
	}
	call(t, "POST", api.URL+"/api/volume", `{"current":999}`, "")
	if tv.vol.Current != 60 {
		t.Fatalf("not clamped: %+v", tv.vol)
	}
	if code, _ = call(t, "POST", api.URL+"/api/key", `{"key":"Home"}`, ""); code != 200 || tv.keys[0] != "Home" {
		t.Fatalf("key %d %v", code, tv.keys)
	}
	if code, _ = call(t, "POST", api.URL+"/api/power", `{"state":"Standby"}`, ""); code != 200 || tv.power != "Standby" {
		t.Fatalf("power %d %s", code, tv.power)
	}
	if code, _ = call(t, "POST", api.URL+"/api/power", `{"state":"bogus"}`, ""); code != 400 {
		t.Fatalf("bad power %d", code)
	}
	call(t, "POST", api.URL+"/api/ambilight", `{"power":"On"}`, "")
	code, am := call(t, "GET", api.URL+"/api/ambilight", "", "")
	if code != 200 || am["power"] != "On" || am["topology"].(map[string]any)["layers"] == nil {
		t.Fatalf("ambilight %d %v", code, am)
	}
	code, stats := call(t, "GET", api.URL+"/api/stats", "", "")
	if code != 200 || stats["uptime_sec"] == nil {
		t.Fatalf("stats %d %v", code, stats)
	}
	code, set := call(t, "GET", api.URL+"/api/settings", "", "")
	if code != 200 || set["jointspace"].(map[string]any)["paired"] != true {
		t.Fatalf("settings %d %v", code, set)
	}
	// static files are served
	resp, _ := http.Get(api.URL + "/")
	if resp.StatusCode != 200 {
		t.Fatalf("index %d", resp.StatusCode)
	}
	resp.Body.Close()
}

func TestTokenAuth(t *testing.T) {
	_, api, _ := setup(t, "s3cret", true)
	if code, m := call(t, "GET", api.URL+"/api/state", "", ""); code != 401 || m["error"] == nil {
		t.Fatalf("no token: %d %v", code, m)
	}
	if code, _ := call(t, "GET", api.URL+"/api/state", "", "wrong"); code != 401 {
		t.Fatalf("wrong token: %d", code)
	}
	if code, _ := call(t, "GET", api.URL+"/api/state", "", "s3cret"); code != 200 {
		t.Fatalf("header token: %d", code)
	}
	if code, _ := call(t, "GET", api.URL+"/api/state?token=s3cret", "", ""); code != 200 {
		t.Fatalf("query token: %d", code)
	}
	resp, _ := http.Get(api.URL + "/ui/ui.css")
	if resp.StatusCode != 200 {
		t.Fatalf("static must not need token: %d", resp.StatusCode)
	}
	resp.Body.Close()
}

func TestUnpaired(t *testing.T) {
	_, api, tv := setup(t, "", false)
	_, st := call(t, "GET", api.URL+"/api/state", "", "")
	tvm := st["tv"].(map[string]any)
	if tvm["reachable"] != true || tvm["paired"] != false || tvm["power"] != "On" {
		t.Fatalf("%v", tvm)
	}
	if code, _ := call(t, "POST", api.URL+"/api/key", `{"key":"Home"}`, ""); code != 409 || len(tv.keys) != 0 {
		t.Fatalf("expected 409, got %d", code)
	}
}

func TestSettingsKeepPassAndNotify(t *testing.T) {
	srv, api, _ := setup(t, "", true)
	changed := 0
	srv.onSettings = func() { changed++ }
	body := `{"name":"Den","mqtt":{"enabled":true,"host":"ha.lan","port":1883,"user":"u","pass":"pw","prefix":"cactarium","discovery_prefix":"homeassistant","interval":10}}`
	if code, _ := call(t, "POST", api.URL+"/api/settings", body, ""); code != 200 {
		t.Fatal(code)
	}
	body = strings.Replace(strings.Replace(body, `"pass":"pw",`, "", 1), "Den", "Den2", 1)
	_, set := call(t, "POST", api.URL+"/api/settings", body, "")
	c := srv.store.Get()
	if c.MQTT.Pass != "pw" || c.Name != "Den2" || changed != 2 {
		t.Fatalf("%+v changed=%d", c, changed)
	}
	if m := set["mqtt"].(map[string]any); m["has_pass"] != true || m["pass"] != nil {
		t.Fatalf("pass leaked or missing flag: %v", m)
	}
	if code, _ := call(t, "POST", api.URL+"/api/settings", `{"mqtt":{"enabled":true}}`, ""); code != 400 {
		t.Fatalf("enabled without host: %d", code)
	}
}

func TestHomeDiag(t *testing.T) {
	_, api, _ := setup(t, "s3cret", true)
	// POST needs no token; GET of the ring does.
	if code, _ := call(t, "POST", api.URL+"/api/home/diag", `{"a":1}`, ""); code != 200 {
		t.Fatalf("post: %d", code)
	}
	if code, _ := call(t, "POST", api.URL+"/api/home/diag", `nope`, ""); code != 400 {
		t.Fatalf("bad post: %d", code)
	}
	if code, _ := call(t, "GET", api.URL+"/api/home/diag", "", ""); code != 401 {
		t.Fatalf("get without token: %d", code)
	}
	req, _ := http.NewRequest("GET", api.URL+"/api/home/diag", nil)
	req.Header.Set("X-Cactarium-Token", "s3cret")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 || !strings.Contains(string(b), `"a":1`) {
		t.Fatalf("get: %d %s", resp.StatusCode, b)
	}
}

func TestLauncherEndpointsNeedNoToken(t *testing.T) {
	srv, api, _ := setup(t, "s3cret", true)

	// kill switch: no token, CORS-readable from the file:// PHI page, default on
	resp, err := http.Get(api.URL + "/api/launcher/enabled")
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	json.NewDecoder(resp.Body).Decode(&m)
	resp.Body.Close()
	if resp.StatusCode != 200 || m["enabled"] != true || m["layer"] != "page" {
		t.Fatalf("enabled: %d %v", resp.StatusCode, m)
	}
	if resp.Header.Get("Access-Control-Allow-Origin") != "*" {
		t.Fatal("missing CORS header")
	}

	// settings (token required) flips it
	post := func(body string) int {
		req, _ := http.NewRequest("POST", api.URL+"/api/settings", strings.NewReader(body))
		req.Header.Set("X-Cactarium-Token", "s3cret")
		r, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		r.Body.Close()
		return r.StatusCode
	}
	if code := post(`{"launcher":{"enabled":false}}`); code != 200 {
		t.Fatalf("settings: %d", code)
	}
	if srv.store.Get().Launcher.On() {
		t.Fatal("not disabled")
	}
	_, m = call(t, "GET", api.URL+"/api/launcher/enabled", "", "")
	if m["enabled"] != false {
		t.Fatalf("still enabled: %v", m)
	}
	if code := post(`{"launcher":{"layer":"bogus"}}`); code != 400 {
		t.Fatalf("bad layer: %d", code)
	}
	if code := post(`{"name":"x"}`); code != 200 || srv.store.Get().Launcher.On() {
		t.Fatal("a save without a launcher block must keep the setting")
	}
	if code := post(`{"launcher":{"enabled":true,"layer":"page"}}`); code != 200 {
		t.Fatalf("settings: %d", code)
	}
	_, m = call(t, "GET", api.URL+"/api/launcher/enabled", "", "")
	if m["enabled"] != true || m["layer"] != "page" {
		t.Fatalf("%v", m)
	}
	// the settings GET reports it (dashboard checkbox)
	req, _ := http.NewRequest("GET", api.URL+"/api/settings", nil)
	req.Header.Set("X-Cactarium-Token", "s3cret")
	r, _ := http.DefaultClient.Do(req)
	var sg map[string]any
	json.NewDecoder(r.Body).Decode(&sg)
	r.Body.Close()
	if l, _ := sg["launcher"].(map[string]any); l == nil || l["enabled"] != true {
		t.Fatalf("settings launcher: %v", sg["launcher"])
	}

	// hook script and launcher page: no token, never cached
	for path, want := range map[string]string{
		"/phi-hook.js":           "__cactariumPhiHook",
		"/launcher":              "/launcher/launcher.js",
		"/launcher/launcher.js":  "cactarium-launcher",
		"/launcher/launcher.css": "#stage",
	} {
		r, err := http.Get(api.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(r.Body)
		r.Body.Close()
		if r.StatusCode != 200 || !strings.Contains(string(b), want) {
			t.Fatalf("%s: %d", path, r.StatusCode)
		}
		if r.Header.Get("Cache-Control") != "no-store" {
			t.Fatalf("%s Cache-Control=%q", path, r.Header.Get("Cache-Control"))
		}
	}
	r, _ = http.Get(api.URL + "/phi-hook.js")
	r.Body.Close()
	if ct := r.Header.Get("Content-Type"); !strings.HasPrefix(ct, "application/javascript") {
		t.Fatalf("content type %q", ct)
	}
}

// TitanOS has no /6/powerstate; the TV answering means it is on, and the 404
// must not turn the whole state into an error.
func TestPowerStateMissingMeansOn(t *testing.T) {
	srv, api, tv := setup(t, "", true)
	tv.mu.Lock()
	tv.noPower = true
	tv.mu.Unlock()
	srv.store.Update(func(c *config.Config) { c.Launcher.Catalog.Model = "55PUS8450/12" })
	srv.poll()
	_, st := call(t, "GET", api.URL+"/api/state", "", "")
	tvm := st["tv"].(map[string]any)
	if tvm["power"] != "On" || tvm["error"] != "" || tvm["model"] != "55PUS8450/12" {
		t.Fatalf("%v", tvm)
	}
}

func TestFillFromPHIKeepsFreshAnswersOnly(t *testing.T) {
	s := &Server{}
	s.phiInfo.model = "55PUS8450/12"
	s.phiInfo.source = &SourceState{TypeID: 9, Label: "Home"}
	s.phiInfo.at = time.Now()
	tv := TVState{Model: "from config"}
	s.fillFromPHI(&tv)
	if tv.Model != "55PUS8450/12" || tv.Source == nil || tv.Source.Label != "Home" {
		t.Fatalf("%+v", tv)
	}
	s.phiInfo.at = time.Now().Add(-time.Hour)
	tv = TVState{}
	s.fillFromPHI(&tv)
	if tv.Source != nil {
		t.Fatalf("stale source kept: %+v", tv.Source)
	}
}
