package routes

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"image/jpeg"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"cactarium/server/lib/config"
)

// The launcher's background (launcher.background in the config). The pictures
// are ported from Glasshouse Home's wallpapers (MIT, Copyright (c) 2026 Rory
// Gallagher; see NOTICE): four times of day, each with one picture, taken
// from a downloaded set or from the owner's own uploads. They live under
// <config dir>/var/home-wallpapers/:
//
//	sets/<landscape|abstract>/<slot>.jpg   downloaded when the set is chosen
//	own/<slot>.jpg                         uploaded from the dashboard
//
// Only the chosen set is kept; the owner's uploads are always kept.

const (
	wallMaxBytes  = 5 << 20 // one picture; Glasshouse's own limit
	wallMaxWidth  = 1920    // the launcher is drawn at 1920x1080
	wallMaxHeight = 1080
	wallFetchTime = 45 * time.Second

	// The sets come from a tag of Glasshouse's wallpaper repository, whose
	// files never change: each is pinned by SHA-256 below.
	defaultWallBase = "https://raw.githubusercontent.com/rorygallagher2024/glasshouse-wallpapers/v2/"
)

var wallSlots = []string{"morning", "afternoon", "evening", "night"}

type wallSet struct {
	dir  string // path under the base URL, with its trailing slash
	sums map[string]string
}

var defaultWallSets = map[string]wallSet{
	"landscape": {dir: "", sums: map[string]string{
		"morning":   "07b116a4e124b5fa7021638c4653fab3ee1ad55dedeaed75dbcb3cd31cb13cc5",
		"afternoon": "5c55ec973573e88f37805a65536ec1a07b5950de40ff19f9e54a30ef808f221c",
		"evening":   "651cf5c2123d35b4c06b2d317d3dc13e66806eea16a1d5e82c9e060eb8a1a743",
		"night":     "710be1cc3b9fb79f574f256eda6c64bb28e429c58e3a9d123ff6d5d40e8466eb",
	}},
	"abstract": {dir: "abstract/", sums: map[string]string{
		"morning":   "c8418d6a80e95c10644a2bad08b9355bea7bd337d32814e7fb298386ac3d7e56",
		"afternoon": "debe27bb99fb15cf51d82d9ad78363d6fa116f20913024d73c584182f040b3e0",
		"evening":   "1ccb4bbc5b176f26f643c84cdd255bac36707515093b64892630d5b3925e18d1",
		"night":     "189e934db4b5aff8608110e3cd4562cb70d50c32a044a1f8c441ac924baa84a7",
	}},
}

// wallState serialises the slow operations (an upload, a set download) so the
// dashboard can show what is going on and a second one is refused.
type wallState struct {
	mu   sync.Mutex
	busy string // "", "upload" or "set:<name>"
}

// begin claims the busy flag; the release it returns is safe to call twice, so
// a handler can release before it reports the status and still defer it.
func (w *wallState) begin(what string) (release func(), ok bool) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.busy != "" {
		return nil, false
	}
	w.busy = what
	var once sync.Once
	return func() {
		once.Do(func() {
			w.mu.Lock()
			w.busy = ""
			w.mu.Unlock()
		})
	}, true
}

func (w *wallState) current() string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.busy
}

func validWallSlot(slot string) bool { return config.OneOf(slot, wallSlots) }

func (s *Server) wallRoot() string {
	return filepath.Join(filepath.Dir(s.store.Path()), "var", "home-wallpapers")
}

// wallFile is where a picture of the given choice (a set's name, or "own") lives.
func (s *Server) wallFile(choice, slot string) string {
	if choice == "own" {
		return filepath.Join(s.wallRoot(), "own", slot+".jpg")
	}
	return filepath.Join(s.wallRoot(), "sets", choice, slot+".jpg")
}

func (s *Server) wallSetDefs() map[string]wallSet {
	if s.wallSets != nil {
		return s.wallSets
	}
	return defaultWallSets
}

func fileInfo(path string) os.FileInfo {
	st, err := os.Stat(path)
	if err != nil || !st.Mode().IsRegular() {
		return nil
	}
	return st
}

// backgroundPatch is the partial update POST /api/settings accepts under
// launcher.background; every field is optional.
type backgroundPatch struct {
	Kind       *string `json:"kind"`
	Pictures   *string `json:"pictures"`
	Animation  *string `json:"animation"`
	Colours    *string `json:"colours"`
	OwnColours *struct {
		Background *string `json:"background"`
		Light      *string `json:"light"`
	} `json:"own_colours"`
	Darkening *int `json:"darkening"`
}

// apply validates the patch and merges it into b. b is only changed when the
// whole patch is valid.
func (p *backgroundPatch) apply(b *config.Background) error {
	next := *b
	pick := func(v *string, list []string, name string, dst *string) error {
		if v == nil {
			return nil
		}
		if !config.OneOf(*v, list) {
			return errBad(fmt.Sprintf("launcher background %s must be one of %s", name, strings.Join(list, ", ")))
		}
		*dst = *v
		return nil
	}
	if err := pick(p.Kind, config.BackgroundKinds, "kind", &next.Kind); err != nil {
		return err
	}
	if err := pick(p.Pictures, config.BackgroundPictures, "pictures", &next.Pictures); err != nil {
		return err
	}
	if err := pick(p.Animation, config.BackgroundAnimations, "animation", &next.Animation); err != nil {
		return err
	}
	if err := pick(p.Colours, config.BackgroundColours, "colours", &next.Colours); err != nil {
		return err
	}
	if oc := p.OwnColours; oc != nil {
		for _, c := range []struct {
			v    *string
			dst  *string
			name string
		}{{oc.Background, &next.OwnColours.Background, "background"}, {oc.Light, &next.OwnColours.Light, "light"}} {
			if c.v == nil {
				continue
			}
			if !config.ValidHexColour(*c.v) {
				return errBad("launcher background own_colours." + c.name + " must be #rrggbb")
			}
			*c.dst = strings.ToLower(*c.v)
		}
	}
	if p.Darkening != nil {
		if *p.Darkening < 0 || *p.Darkening > 100 {
			return errBad("launcher background darkening must be 0..100")
		}
		next.SetDarkening(*p.Darkening)
	}
	*b = next
	return nil
}

// backgroundView is the background as /api/settings and the launcher see it.
func backgroundView(b config.Background) map[string]any {
	return map[string]any{
		"kind": b.Kind, "pictures": b.Pictures, "animation": b.Animation, "colours": b.Colours,
		"own_colours": map[string]string{"background": b.OwnColours.Background, "light": b.OwnColours.Light},
		"darkening":   b.DarkeningValue(),
	}
}

// wallRevision changes whenever a picture of the chosen set or the choice itself does.
func (s *Server) wallRevision(choice string) string {
	h := sha256.New()
	h.Write([]byte(choice))
	for _, slot := range wallSlots {
		if st := fileInfo(s.wallFile(choice, slot)); st != nil {
			fmt.Fprintf(h, "|%s:%d-%d", slot, st.ModTime().UnixNano(), st.Size())
		}
	}
	return hex.EncodeToString(h.Sum(nil))[:12]
}

func (s *Server) wallSlotsOf(choice string) map[string]bool {
	out := map[string]bool{}
	for _, slot := range wallSlots {
		out[slot] = fileInfo(s.wallFile(choice, slot)) != nil
	}
	return out
}

// wallStatus describes the pictures: slots are those of the chosen set (the
// config's background.pictures), own the owner's uploads, sets which downloaded
// sets are complete.
func (s *Server) wallStatus() map[string]any {
	choice := s.store.Get().Launcher.Background.Pictures
	sets := map[string]bool{}
	for name := range s.wallSetDefs() {
		all := true
		for _, slot := range wallSlots {
			all = all && fileInfo(s.wallFile(name, slot)) != nil
		}
		sets[name] = all
	}
	busy := s.wall.current()
	return map[string]any{
		"ok": true, "choice": choice, "slots": s.wallSlotsOf(choice), "own": s.wallSlotsOf("own"),
		"sets": sets, "busy": busy, "revision": s.wallRevision(choice),
	}
}

// handleLauncherBackground is the launcher's read of the background: no
// token, like the other launcher endpoints (launcher.go), and read-only.
func (s *Server) handleLauncherBackground(w http.ResponseWriter, r *http.Request) {
	b := s.store.Get().Launcher.Background
	v := backgroundView(b)
	v["ok"] = true
	if b.Kind == "pictures" {
		v["slots"] = s.wallSlotsOf(b.Pictures)
		v["revision"] = s.wallRevision(b.Pictures)
	} else {
		v["slots"] = map[string]bool{}
		v["revision"] = ""
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, v)
}

// handleLauncherWallpaper serves the chosen picture for one time of day to the
// launcher and to the dashboard's previews (no token: an <img> cannot send one).
func (s *Server) handleLauncherWallpaper(w http.ResponseWriter, r *http.Request) {
	slot := r.URL.Query().Get("slot")
	if !validWallSlot(slot) {
		http.NotFound(w, r)
		return
	}
	path := s.wallFile(s.store.Get().Launcher.Background.Pictures, slot)
	f, err := os.Open(path)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || !st.Mode().IsRegular() {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "image/jpeg")
	// Revalidated with Last-Modified, so a replaced picture shows at once.
	w.Header().Set("Cache-Control", "no-cache")
	http.ServeContent(w, r, "", st.ModTime(), f)
}

func (s *Server) handleWallpapersGet(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.wallStatus())
}

// checkJPEG accepts a whole, decodable JPEG within the launcher's frame. The
// dashboard re-encodes uploads, so anything else is not from it.
func checkJPEG(data []byte) error {
	if len(data) < 12 || len(data) > wallMaxBytes {
		return errors.New("the picture must be a JPEG of at most 5 MB")
	}
	cfg, err := jpeg.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return errors.New("not a valid JPEG")
	}
	if cfg.Width < 1 || cfg.Height < 1 || cfg.Width > wallMaxWidth || cfg.Height > wallMaxHeight {
		return fmt.Errorf("the picture must be at most %d x %d pixels", wallMaxWidth, wallMaxHeight)
	}
	// A full decode catches a truncated file that has a good header.
	if _, err := jpeg.Decode(bytes.NewReader(data)); err != nil {
		return errors.New("not a valid JPEG")
	}
	return nil
}

// writeFileAtomic writes next to path and renames, so a reader (or a power
// cut) never sees half a picture.
func writeFileAtomic(path string, data []byte) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".part-*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer os.Remove(name)
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(name, path)
}

// pruneWallpaperSets removes every downloaded set but keep ("" removes all):
// only the chosen set stays on the TV. A set still downloading is left alone.
func (s *Server) pruneWallpaperSets(keep string) {
	if strings.HasPrefix(s.wall.current(), "set:") {
		return
	}
	s.removeOtherWallpaperSets(keep)
}

func (s *Server) removeOtherWallpaperSets(keep string) {
	for name := range s.wallSetDefs() {
		if name != keep {
			_ = os.RemoveAll(filepath.Join(s.wallRoot(), "sets", name))
		}
	}
}

// chooseWallpapers makes pictures the launcher's background and drops the
// downloaded sets it does not use. The caller holds the wall busy flag.
func (s *Server) chooseWallpapers(pictures string) error {
	err := s.store.Update(func(c *config.Config) {
		c.Launcher.Background.Kind = "pictures"
		c.Launcher.Background.Pictures = pictures
	})
	if err != nil {
		return err
	}
	s.removeOtherWallpaperSets(pictures) // "own" matches no set: all go
	return nil
}

func (s *Server) handleWallpaperUpload(w http.ResponseWriter, r *http.Request) {
	slot := r.URL.Query().Get("slot")
	if !validWallSlot(slot) {
		writeErr(w, http.StatusBadRequest, "unknown wallpaper slot")
		return
	}
	release, ok := s.wall.begin("upload")
	if !ok {
		writeErr(w, http.StatusConflict, "wait for the other wallpaper change to finish")
		return
	}
	defer release()
	r.Body = http.MaxBytesReader(w, r.Body, wallMaxBytes)
	data, err := io.ReadAll(r.Body)
	if err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			writeErr(w, http.StatusRequestEntityTooLarge, "the picture must be at most 5 MB")
		} else {
			writeErr(w, http.StatusBadRequest, "the upload did not complete")
		}
		return
	}
	if err := checkJPEG(data); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := writeFileAtomic(s.wallFile("own", slot), data); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	// Uploading a picture chooses the owner's own.
	if err := s.chooseWallpapers("own"); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	release()
	writeJSON(w, http.StatusOK, s.wallStatus())
}

func (s *Server) handleWallpaperRemove(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Slot string `json:"slot"`
		All  bool   `json:"all"`
	}
	if !decode(w, r, &b) {
		return
	}
	if !b.All && !validWallSlot(b.Slot) {
		writeErr(w, http.StatusBadRequest, "unknown wallpaper slot")
		return
	}
	release, ok := s.wall.begin("remove")
	if !ok {
		writeErr(w, http.StatusConflict, "wait for the other wallpaper change to finish")
		return
	}
	defer release()
	slots := []string{b.Slot}
	if b.All {
		slots = wallSlots
	}
	for _, slot := range slots {
		if err := os.Remove(s.wallFile("own", slot)); err != nil && !errors.Is(err, os.ErrNotExist) {
			writeErr(w, http.StatusInternalServerError, err.Error())
			return
		}
	}
	release()
	writeJSON(w, http.StatusOK, s.wallStatus())
}

// fetchWallpaper downloads one picture of a set and checks it against its pin.
func (s *Server) fetchWallpaper(ctx context.Context, base string, set wallSet, slot string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, wallFetchTime)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+set.dir+slot+".jpg", nil)
	if err != nil {
		return nil, err
	}
	hc := s.wallClient
	if hc == nil {
		hc = http.DefaultClient
	}
	resp, err := hc.Do(req)
	if err != nil {
		return nil, errors.New("the wallpapers could not be downloaded")
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("the wallpapers could not be downloaded (HTTP %d)", resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, wallMaxBytes+1))
	if err != nil {
		return nil, errors.New("the wallpapers could not be downloaded")
	}
	sum := sha256.Sum256(data)
	if len(data) > wallMaxBytes || hex.EncodeToString(sum[:]) != set.sums[slot] || checkJPEG(data) != nil {
		return nil, errors.New("a wallpaper did not download intact; try again later")
	}
	return data, nil
}

// handleWallpaperSet downloads a picture set (the ones that are missing or do
// not match their pin) and chooses it. Only that set is kept.
func (s *Server) handleWallpaperSet(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Set string `json:"set"`
	}
	if !decode(w, r, &b) {
		return
	}
	set, ok := s.wallSetDefs()[b.Set]
	if !ok {
		writeErr(w, http.StatusBadRequest, "unknown wallpaper set")
		return
	}
	release, ok := s.wall.begin("set:" + b.Set)
	if !ok {
		writeErr(w, http.StatusConflict, "wait for the other wallpaper change to finish")
		return
	}
	defer release()
	base := s.wallBase
	if base == "" {
		base = defaultWallBase
	}
	for _, slot := range wallSlots {
		path := s.wallFile(b.Set, slot)
		if have, err := os.ReadFile(path); err == nil {
			if sum := sha256.Sum256(have); hex.EncodeToString(sum[:]) == set.sums[slot] {
				continue
			}
		}
		data, err := s.fetchWallpaper(r.Context(), base, set, slot)
		if err == nil {
			err = writeFileAtomic(path, data)
		}
		if err != nil {
			writeErr(w, http.StatusBadGateway, err.Error())
			return
		}
	}
	if err := s.chooseWallpapers(b.Set); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	release()
	writeJSON(w, http.StatusOK, s.wallStatus())
}
