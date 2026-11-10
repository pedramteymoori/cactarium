package routes

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"image"
	"image/color"
	"image/jpeg"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"cactarium/server/lib/config"
)

func testJPEG(t *testing.T, w, h int, shade uint8) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, color.RGBA{shade, uint8(x), uint8(y), 255})
		}
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, nil); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func post(t *testing.T, url, ctype string, body []byte, token string) (int, string) {
	t.Helper()
	req, _ := http.NewRequest("POST", url, bytes.NewReader(body))
	req.Header.Set("Content-Type", ctype)
	if token != "" {
		req.Header.Set("X-Cactarium-Token", token)
	}
	r, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Body.Close()
	var b bytes.Buffer
	b.ReadFrom(r.Body)
	return r.StatusCode, b.String()
}

func TestBackgroundSettingsValidationAndMerge(t *testing.T) {
	_, api, _ := setup(t, "", true)
	st, m := call(t, "GET", api.URL+"/api/settings", "", "")
	bg := m["launcher"].(map[string]any)["background"].(map[string]any)
	if st != 200 || bg["kind"] != "none" || bg["pictures"] != "landscape" || bg["animation"] != "waves" ||
		bg["colours"] != "time" || bg["darkening"].(float64) != 100 {
		t.Fatalf("defaults: %d %v", st, bg)
	}
	if oc := bg["own_colours"].(map[string]any); oc["background"] != "#0a1f5c" || oc["light"] != "#4f8dff" {
		t.Fatalf("own colours default: %v", oc)
	}
	// A partial patch merges; darkening 0 ("Off") sticks and is not mistaken for missing.
	st, m = call(t, "POST", api.URL+"/api/settings", `{"launcher":{"background":{"kind":"animated","animation":"aquarium","darkening":0,"own_colours":{"light":"#AABBCC"}}}}`, "")
	bg = m["launcher"].(map[string]any)["background"].(map[string]any)
	if st != 200 || bg["kind"] != "animated" || bg["animation"] != "aquarium" || bg["darkening"].(float64) != 0 ||
		bg["pictures"] != "landscape" || bg["own_colours"].(map[string]any)["light"] != "#aabbcc" ||
		bg["own_colours"].(map[string]any)["background"] != "#0a1f5c" {
		t.Fatalf("merge: %d %v", st, bg)
	}
	for _, bad := range []string{
		`{"kind":"video"}`, `{"pictures":"sky"}`, `{"animation":"fire"}`, `{"colours":"red"}`,
		`{"darkening":101}`, `{"darkening":-5}`, `{"darkening":50.5}`,
		`{"own_colours":{"light":"blue"}}`, `{"own_colours":{"background":"#12345"}}`,
		`{"kind":"pictures","darkening":900}`, // nothing of a bad patch is applied
	} {
		st, _ = call(t, "POST", api.URL+"/api/settings", `{"launcher":{"background":`+bad+`}}`, "")
		if st != 400 {
			t.Errorf("%s: status %d, want 400", bad, st)
		}
	}
	_, m = call(t, "GET", api.URL+"/api/settings", "", "")
	if m["launcher"].(map[string]any)["background"].(map[string]any)["kind"] != "animated" {
		t.Fatal("a rejected patch changed the config")
	}
}

func TestLauncherBackgroundNoToken(t *testing.T) {
	srv, api, _ := setup(t, "s3cret", true)
	srv.store.Update(func(c *config.Config) { c.Launcher.Background.Kind = "animated" })
	r, body := get(t, api.URL+"/api/launcher/background")
	if r.StatusCode != 200 || !strings.Contains(body, `"kind":"animated"`) {
		t.Fatalf("%d %s", r.StatusCode, body)
	}
	if r, _ := get(t, api.URL+"/launcher/wallpaper?slot=morning"); r.StatusCode != 404 {
		t.Fatalf("no picture: %d", r.StatusCode)
	}
	if r, _ := get(t, api.URL+"/launcher/wallpaper?slot=../../config"); r.StatusCode != 404 {
		t.Fatalf("bad slot: %d", r.StatusCode)
	}
	// The management routes need the token.
	if st, _ := call(t, "GET", api.URL+"/api/launcher/wallpapers", "", ""); st != 401 {
		t.Fatalf("status without token: %d", st)
	}
}

func TestWallpaperUploadServeRemove(t *testing.T) {
	srv, api, _ := setup(t, "tok", true)
	good := testJPEG(t, 64, 36, 10)
	up := func(slot string, body []byte) int {
		st, _ := post(t, api.URL+"/api/launcher/wallpapers/upload?slot="+slot, "image/jpeg", body, "tok")
		return st
	}
	if st := up("morning", good); st != 200 {
		t.Fatalf("upload: %d", st)
	}
	// Uploading chooses the owner's pictures; the file is private and has no leftovers.
	bg := srv.store.Get().Launcher.Background
	if bg.Kind != "pictures" || bg.Pictures != "own" {
		t.Fatalf("not chosen: %+v", bg)
	}
	path := filepath.Join(filepath.Dir(srv.store.Path()), "var", "home-wallpapers", "own", "morning.jpg")
	if st, err := os.Stat(path); err != nil || st.Mode().Perm() != 0o600 {
		t.Fatalf("stored file: %v %v", st, err)
	}
	if ents, _ := os.ReadDir(filepath.Dir(path)); len(ents) != 1 {
		t.Fatalf("temporary files left: %v", ents)
	}
	r, body := get(t, api.URL+"/launcher/wallpaper?slot=morning") // no token
	if r.StatusCode != 200 || r.Header.Get("Content-Type") != "image/jpeg" || body != string(good) {
		t.Fatalf("serve: %d %s", r.StatusCode, r.Header.Get("Content-Type"))
	}
	if r, _ := get(t, api.URL+"/launcher/wallpaper?slot=night"); r.StatusCode != 404 {
		t.Fatalf("empty slot: %d", r.StatusCode)
	}
	_, bgBody := get(t, api.URL+"/api/launcher/background")
	if !strings.Contains(bgBody, `"morning":true`) || !strings.Contains(bgBody, `"night":false`) {
		t.Fatalf("slots: %s", bgBody)
	}

	// Limits: size, dimensions, format, truncation, slot.
	if st := up("night", testJPEG(t, 1921, 10, 0)); st != 400 {
		t.Errorf("too wide: %d", st)
	}
	if st := up("night", testJPEG(t, 10, 1081, 0)); st != 400 {
		t.Errorf("too tall: %d", st)
	}
	if st := up("night", []byte("not a jpeg at all, just text")); st != 400 {
		t.Errorf("not a jpeg: %d", st)
	}
	if st := up("night", good[:len(good)/2]); st != 400 {
		t.Errorf("truncated: %d", st)
	}
	if st := up("night", append(append([]byte{}, good...), make([]byte, wallMaxBytes)...)); st != 413 {
		t.Errorf("over 5 MB: %d", st)
	}
	if st := up("noon", good); st != 400 {
		t.Errorf("slot: %d", st)
	}
	if _, err := os.Stat(strings.Replace(path, "morning", "night", 1)); err == nil {
		t.Error("a refused upload was stored")
	}

	// Remove one, then all.
	up("evening", good)
	if st, _ := post(t, api.URL+"/api/launcher/wallpapers/remove", "application/json", []byte(`{"slot":"morning"}`), "tok"); st != 200 {
		t.Fatalf("remove: %d", st)
	}
	if _, err := os.Stat(path); err == nil {
		t.Fatal("morning not removed")
	}
	if r, _ := get(t, api.URL+"/launcher/wallpaper?slot=evening"); r.StatusCode != 200 {
		t.Fatal("evening gone with morning")
	}
	if st, _ := post(t, api.URL+"/api/launcher/wallpapers/remove", "application/json", []byte(`{"slot":"x"}`), "tok"); st != 400 {
		t.Fatalf("bad slot: %d", st)
	}
	if st, _ := post(t, api.URL+"/api/launcher/wallpapers/remove", "application/json", []byte(`{"all":true}`), "tok"); st != 200 {
		t.Fatalf("remove all: %d", st)
	}
	if r, _ := get(t, api.URL+"/launcher/wallpaper?slot=evening"); r.StatusCode != 404 {
		t.Fatal("remove all left a picture")
	}
}

func TestWallpaperSetFetchKeepsOnlyChosen(t *testing.T) {
	srv, api, _ := setup(t, "", true)
	files := map[string][]byte{}
	sets := map[string]wallSet{}
	for i, name := range []string{"landscape", "abstract"} {
		dir := ""
		if name == "abstract" {
			dir = "abstract/"
		}
		set := wallSet{dir: dir, sums: map[string]string{}}
		for j, slot := range wallSlots {
			data := testJPEG(t, 32, 18, uint8(i*40+j*5))
			sum := sha256.Sum256(data)
			set.sums[slot] = hex.EncodeToString(sum[:])
			files["/"+dir+slot+".jpg"] = data
		}
		sets[name] = set
	}
	var hits int32
	corrupt := ""
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		data, ok := files[r.URL.Path]
		if !ok {
			http.NotFound(w, r)
			return
		}
		if r.URL.Path == corrupt {
			data = append([]byte{}, data...)
			data[len(data)/2] ^= 0xff
		}
		w.Write(data)
	}))
	defer ts.Close()
	srv.wallBase, srv.wallSets = ts.URL+"/", sets

	fetch := func(set string) int {
		st, _ := post(t, api.URL+"/api/launcher/wallpapers/set", "application/json", []byte(`{"set":"`+set+`"}`), "")
		return st
	}
	root := filepath.Join(filepath.Dir(srv.store.Path()), "var", "home-wallpapers", "sets")

	if st := fetch("landscape"); st != 200 {
		t.Fatalf("fetch landscape: %d", st)
	}
	if bg := srv.store.Get().Launcher.Background; bg.Kind != "pictures" || bg.Pictures != "landscape" {
		t.Fatalf("not chosen: %+v", bg)
	}
	if r, body := get(t, api.URL+"/launcher/wallpaper?slot=night"); r.StatusCode != 200 || body != string(files["/night.jpg"]) {
		t.Fatalf("serve set: %d", r.StatusCode)
	}
	// A set that is complete is not downloaded again.
	before := atomic.LoadInt32(&hits)
	if st := fetch("landscape"); st != 200 || atomic.LoadInt32(&hits) != before {
		t.Fatalf("refetch: %d, %d extra requests", st, atomic.LoadInt32(&hits)-before)
	}
	// Choosing the other set removes the first.
	if st := fetch("abstract"); st != 200 {
		t.Fatalf("fetch abstract: %d", st)
	}
	if _, err := os.Stat(filepath.Join(root, "landscape")); err == nil {
		t.Fatal("landscape kept after abstract was chosen")
	}
	// None, or the owner's pictures, keeps no set at all.
	call(t, "POST", api.URL+"/api/settings", `{"launcher":{"background":{"kind":"none"}}}`, "")
	if _, err := os.Stat(filepath.Join(root, "abstract")); err == nil {
		t.Fatal("a set was kept with background none")
	}

	// Unknown set; a picture that does not match its pin; a missing one; no partial files.
	if st := fetch("sky"); st != 400 {
		t.Errorf("unknown set: %d", st)
	}
	corrupt = "/morning.jpg"
	if st := fetch("landscape"); st != 502 {
		t.Errorf("corrupt picture: %d", st)
	}
	corrupt = ""
	delete(files, "/night.jpg")
	if st := fetch("landscape"); st != 502 {
		t.Errorf("missing picture: %d", st)
	}
	if bg := srv.store.Get().Launcher.Background; bg.Kind != "none" {
		t.Errorf("a failed download chose the set: %+v", bg)
	}
	if ents, _ := os.ReadDir(filepath.Join(root, "landscape")); true {
		for _, e := range ents {
			if strings.HasPrefix(e.Name(), ".part") {
				t.Errorf("partial file left: %s", e.Name())
			}
		}
	}
}
