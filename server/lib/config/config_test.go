package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestOpenDefaultsAndPersist(t *testing.T) {
	p := filepath.Join(t.TempDir(), "config.json")
	s, err := Open(p)
	if err != nil {
		t.Fatal(err)
	}
	c := s.Get()
	if c.Name != "Philips TV" || c.Listen != ":8090" || c.JointSpace.Host != "127.0.0.1" ||
		c.MQTT.Port != 1883 || c.MQTT.Prefix != "cactarium" || c.MQTT.DiscoveryPrefix != "homeassistant" || c.MQTT.Interval != 10 {
		t.Fatalf("bad defaults: %+v", c)
	}
	if !c.Launcher.On() || c.Launcher.Layer != "page" {
		t.Fatalf("launcher default: %+v", c.Launcher)
	}
	if k := c.Launcher.Catalog; k.Market != "NL" || k.Locale != "nl" || k.Model != "" || k.Firmware != "" || len(c.Launcher.Apps) != 0 {
		t.Fatalf("catalog default: %+v", c.Launcher)
	}
	if len(c.DeviceID) != 8 {
		t.Fatalf("device id %q", c.DeviceID)
	}
	st, err := os.Stat(p)
	if err != nil {
		t.Fatal(err)
	}
	if st.Mode().Perm() != 0o600 {
		t.Fatalf("mode %v", st.Mode())
	}
	if err := s.Update(func(c *Config) { c.Token = "x"; c.MQTT.Enabled = true }); err != nil {
		t.Fatal(err)
	}
	s2, err := Open(p)
	if err != nil {
		t.Fatal(err)
	}
	c2 := s2.Get()
	if c2.Token != "x" || !c2.MQTT.Enabled || c2.DeviceID != c.DeviceID {
		t.Fatalf("not persisted: %+v", c2)
	}
	ents, _ := os.ReadDir(filepath.Dir(p))
	if len(ents) != 1 {
		t.Fatalf("temp files left: %v", ents)
	}
}

func TestUpdateFailureRollsBack(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(filepath.Join(dir, "c.json"))
	if err != nil {
		t.Fatal(err)
	}
	os.RemoveAll(dir)
	if err := s.Update(func(c *Config) { c.Name = "nope" }); err == nil {
		t.Fatal("expected error")
	}
	if s.Get().Name != "Philips TV" {
		t.Fatal("not rolled back")
	}
}

func TestLauncherEnabledPersistsFalse(t *testing.T) {
	p := filepath.Join(t.TempDir(), "config.json")
	s, err := Open(p)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Update(func(c *Config) { c.Launcher.SetEnabled(false) }); err != nil {
		t.Fatal(err)
	}
	s2, err := Open(p)
	if err != nil {
		t.Fatal(err)
	}
	if s2.Get().Launcher.On() {
		t.Fatal("false was lost on reload (defaulted back to true)")
	}
	// An old config without a launcher block gets the default.
	if err := os.WriteFile(p, []byte(`{"name":"x"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	s3, err := Open(p)
	if err != nil {
		t.Fatal(err)
	}
	if !s3.Get().Launcher.On() {
		t.Fatal("missing launcher block should default to enabled")
	}
}

func TestBackgroundDefaultsAndNormalise(t *testing.T) {
	c := Defaults()
	b := c.Launcher.Background
	if b.Kind != "none" || b.Pictures != "landscape" || b.Animation != "waves" || b.Colours != "time" ||
		b.DarkeningValue() != 100 || b.OwnColours.Background != "#0a1f5c" || b.OwnColours.Light != "#4f8dff" {
		t.Fatalf("defaults: %+v", b)
	}
	// A hand-edited config with bad values falls back; darkening 0 is kept.
	bad := Config{}
	bad.Launcher.Background = Background{Kind: "movie", Pictures: "x", Animation: "y", Colours: "z",
		OwnColours: OwnColours{Background: "red", Light: "#ABCDEF"}}
	bad.Launcher.Background.SetDarkening(250)
	bad.applyDefaults()
	got := bad.Launcher.Background
	if got.Kind != "none" || got.Pictures != "landscape" || got.Animation != "waves" || got.Colours != "time" ||
		got.DarkeningValue() != 100 || got.OwnColours.Background != "#0a1f5c" || got.OwnColours.Light != "#abcdef" {
		t.Fatalf("normalised: %+v", got)
	}
	zero := Config{}
	zero.Launcher.Background.SetDarkening(0)
	zero.applyDefaults()
	if zero.Launcher.Background.DarkeningValue() != 0 {
		t.Fatal("darkening 0 (Off) was reset")
	}
}
