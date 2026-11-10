// Package config loads and atomically saves Cactarium's JSON config.
package config

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
)

type Config struct {
	Name       string     `json:"name"`
	Listen     string     `json:"listen"`
	Token      string     `json:"token,omitempty"`
	DeviceID   string     `json:"device_id"`
	JointSpace JointSpace `json:"jointspace"`
	MQTT       MQTT       `json:"mqtt"`
	Launcher   Launcher   `json:"launcher"`
}

// Launcher controls the Home-button hook that /phi-hook.js installs in the
// TV's native UI. Enabled is a pointer so "missing" can default to true.
type Launcher struct {
	Enabled *bool `json:"enabled"`
	// Layer picks how the hook brings the web UI in front of an app:
	// "page" (default: opens PHI's blank page so Scheduler's stack has a
	// window for the launcher, and closing Settings comes back to it) or
	// "state" (no PHI page; only sets the UI state, and PHI hands the screen
	// back to the app whenever one of its pages closes). See
	// docs/launcher.md.
	Layer string `json:"layer,omitempty"`
	// Weather enables the launcher's weather badge (Open-Meteo, no key).
	Weather Weather `json:"weather"`
	// BlockTitanOS keeps the TV from loading the TitanOS cloud launcher
	// (server/lib/netblock); the TV then uses its local offline launcher.
	BlockTitanOS bool `json:"block_titanos,omitempty"`
	// Debug turns on the hook's debug channel (server/launcher_debug.go).
	Debug bool `json:"debug,omitempty"`
	// Apps is the Apps row: TitanOS catalog codes in order, plus "tv" for the
	// TV input tile. Empty keeps the row from PHI's own app list.
	Apps []string `json:"apps,omitempty"`
	// Catalog selects which TitanOS app catalog Apps is looked up in.
	Catalog CatalogConfig `json:"catalog"`
	// Background is what the launcher draws behind the clock and rows.
	Background Background `json:"background"`
}

// What Background may hold. The dashboard, the TV app and the launcher all
// code against these exact strings.
var (
	BackgroundKinds      = []string{"none", "pictures", "animated"}
	BackgroundPictures   = []string{"landscape", "abstract", "own"}
	BackgroundAnimations = []string{"waves", "particles", "aquarium", "aurora", "glow", "constellations", "ripples"}
	BackgroundColours    = []string{"time", "night_blue", "sunset", "emerald", "ember", "silver", "own"}
)

// Background is the launcher's background (Glasshouse Home's Background
// section). Kind none is pure black; pictures shows one picture for each part
// of the day from a downloaded set or the owner's uploads; animated draws one
// of the canvas animations. Darkening is a percentage of the launcher's own
// scrim; it is a pointer so that 0 ("Off") is not mistaken for "missing".
type Background struct {
	Kind       string     `json:"kind"`
	Pictures   string     `json:"pictures"`
	Animation  string     `json:"animation"`
	Colours    string     `json:"colours"`
	OwnColours OwnColours `json:"own_colours"`
	Darkening  *int       `json:"darkening"`
}

// OwnColours are the water/sky and light colours behind colours "own", as #rrggbb.
type OwnColours struct {
	Background string `json:"background"`
	Light      string `json:"light"`
}

// DarkeningValue is the darkening, 100 when unset.
func (b Background) DarkeningValue() int {
	if b.Darkening == nil {
		return 100
	}
	return *b.Darkening
}

// SetDarkening stores v in a fresh pointer (Get hands out shallow copies).
func (b *Background) SetDarkening(v int) { b.Darkening = &v }

// ValidHexColour reports whether s is #rrggbb.
func ValidHexColour(s string) bool {
	if len(s) != 7 || s[0] != '#' {
		return false
	}
	for _, c := range s[1:] {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F') {
			return false
		}
	}
	return true
}

// OneOf reports whether v is in list.
func OneOf(v string, list []string) bool {
	for _, x := range list {
		if v == x {
			return true
		}
	}
	return false
}

// normalise replaces anything missing or invalid (a hand-edited config) with
// its default and reports whether it changed.
func (b *Background) normalise() bool {
	changed := false
	fix := func(p *string, list []string, def string) {
		if !OneOf(*p, list) {
			*p, changed = def, true
		}
	}
	fix(&b.Kind, BackgroundKinds, "none")
	fix(&b.Pictures, BackgroundPictures, "landscape")
	fix(&b.Animation, BackgroundAnimations, "waves")
	fix(&b.Colours, BackgroundColours, "time")
	if !ValidHexColour(b.OwnColours.Background) {
		b.OwnColours.Background, changed = "#0a1f5c", true
	}
	if !ValidHexColour(b.OwnColours.Light) {
		b.OwnColours.Light, changed = "#4f8dff", true
	}
	if b.Darkening == nil || *b.Darkening < 0 || *b.Darkening > 100 {
		b.SetDarkening(100)
		changed = true
	}
	b.OwnColours.Background = lower(b.OwnColours.Background)
	b.OwnColours.Light = lower(b.OwnColours.Light)
	return changed
}

func lower(s string) string {
	out := []byte(s)
	for i, c := range out {
		if c >= 'A' && c <= 'Z' {
			out[i] = c + 32
		}
	}
	return string(out)
}

// CatalogConfig holds the query for TitanOS's public app catalog
// (server/lib/titancat). Model and Firmware have no default: the catalog is not
// fetched until both are set (the API answers 400 without a firmware).
type CatalogConfig struct {
	Market   string `json:"market"`
	Locale   string `json:"locale"`
	Model    string `json:"model"`
	Firmware string `json:"firmware"`
}

// Weather holds the location for the weather badge. Both must be set.
type Weather struct {
	Latitude  *float64 `json:"latitude,omitempty"`
	Longitude *float64 `json:"longitude,omitempty"`
}

// Set reports whether a usable location is configured.
func (w Weather) Set() bool {
	return w.Latitude != nil && w.Longitude != nil &&
		*w.Latitude >= -90 && *w.Latitude <= 90 && *w.Longitude >= -180 && *w.Longitude <= 180
}

// On reports whether the Cactarium launcher should replace the Home screen.
func (l Launcher) On() bool { return l.Enabled == nil || *l.Enabled }

// SetEnabled stores v in a fresh pointer (Get hands out shallow copies).
func (l *Launcher) SetEnabled(v bool) { l.Enabled = &v }

type JointSpace struct {
	Host      string `json:"host"`
	User      string `json:"user,omitempty"`
	Pass      string `json:"pass,omitempty"`
	AppSecret string `json:"app_secret,omitempty"`
}

type MQTT struct {
	Enabled         bool   `json:"enabled"`
	Host            string `json:"host"`
	Port            int    `json:"port"`
	User            string `json:"user,omitempty"`
	Pass            string `json:"pass,omitempty"`
	Prefix          string `json:"prefix"`
	DiscoveryPrefix string `json:"discovery_prefix"`
	Interval        int    `json:"interval"`
}

// Defaults returns a config with every default applied (no device id).
func Defaults() Config {
	c := Config{}
	c.applyDefaults()
	return c
}

// applyDefaults fills empty fields; it reports whether anything changed.
func (c *Config) applyDefaults() bool {
	changed := false
	setS := func(p *string, v string) {
		if *p == "" {
			*p, changed = v, true
		}
	}
	setS(&c.Name, "Philips TV")
	// Not 8080: Samba TV's cidclient holds 127.0.0.1:8080 on TPN256E firmware,
	// which blocks a wildcard bind on the same port.
	setS(&c.Listen, ":8090")
	setS(&c.JointSpace.Host, "127.0.0.1")
	setS(&c.MQTT.Prefix, "cactarium")
	setS(&c.MQTT.DiscoveryPrefix, "homeassistant")
	setS(&c.Launcher.Catalog.Market, "NL")
	setS(&c.Launcher.Catalog.Locale, "nl")
	if c.Launcher.Enabled == nil {
		c.Launcher.SetEnabled(true)
		changed = true
	}
	if c.Launcher.Layer != "state" && c.Launcher.Layer != "page" {
		c.Launcher.Layer, changed = "page", true
	}
	if c.Launcher.Background.normalise() {
		changed = true
	}
	if c.MQTT.Port == 0 {
		c.MQTT.Port, changed = 1883, true
	}
	if c.MQTT.Interval <= 0 {
		c.MQTT.Interval, changed = 10, true
	}
	return changed
}

// Store holds the current config and persists changes.
type Store struct {
	path string
	mu   sync.Mutex
	cur  Config
}

// Open loads path. A missing file yields defaults (with a fresh device id),
// which are saved immediately.
func Open(path string) (*Store, error) {
	s := &Store{path: path}
	data, err := os.ReadFile(path)
	missing := errors.Is(err, os.ErrNotExist)
	if err != nil && !missing {
		return nil, err
	}
	if !missing {
		if err := json.Unmarshal(data, &s.cur); err != nil {
			return nil, err
		}
	}
	changed := s.cur.applyDefaults()
	if s.cur.DeviceID == "" {
		b := make([]byte, 4)
		if _, err := rand.Read(b); err != nil {
			return nil, err
		}
		s.cur.DeviceID, changed = hex.EncodeToString(b), true
	}
	if missing || changed {
		if err := s.save(); err != nil {
			return nil, err
		}
	}
	return s, nil
}

// Path returns the file the store writes to.
func (s *Store) Path() string { return s.path }

// Get returns a copy of the current config.
func (s *Store) Get() Config {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.cur
}

// Update applies fn to a copy and saves; on save failure the change is dropped.
func (s *Store) Update(fn func(*Config)) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	next := s.cur
	fn(&next)
	next.applyDefaults()
	old := s.cur
	s.cur = next
	if err := s.save(); err != nil {
		s.cur = old
		return err
	}
	return nil
}

// save writes tmp + rename so a power cut never leaves a torn file.
func (s *Store) save() error {
	data, err := json.MarshalIndent(s.cur, "", "  ")
	if err != nil {
		return err
	}
	dir := filepath.Dir(s.path)
	tmp, err := os.CreateTemp(dir, ".config-*.tmp")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer os.Remove(name)
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(append(data, '\n')); err != nil {
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
	return os.Rename(name, s.path)
}
