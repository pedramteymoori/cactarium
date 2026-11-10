package routes

import (
	"context"
	"net/http"
	"strconv"
	"time"

	"cactarium/server/lib/config"
	"cactarium/server/lib/jointspace"
)

type pendingPair struct {
	p       *jointspace.Pending
	started time.Time
}

const pairTTL = 5 * time.Minute

func (s *Server) handlePairStart(w http.ResponseWriter, r *http.Request) {
	var b struct {
		AppSecret string `json:"app_secret"`
	}
	if !decode(w, r, &b) {
		return
	}
	if b.AppSecret != "" {
		if err := s.store.Update(func(c *config.Config) { c.JointSpace.AppSecret = b.AppSecret }); err != nil {
			writeErr(w, 500, err.Error())
			return
		}
	}
	if s.store.Get().JointSpace.AppSecret == "" {
		fail(w, errBad("app_secret is required"))
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	p, err := s.js.PairRequest(ctx)
	if err != nil {
		fail(w, err)
		return
	}
	s.mu.Lock()
	s.pending = &pendingPair{p, time.Now()}
	s.mu.Unlock()
	writeJSON(w, 200, map[string]any{"ok": true, "pending": true})
}

func (s *Server) handlePairFinish(w http.ResponseWriter, r *http.Request) {
	var b struct {
		PIN string `json:"pin"`
	}
	if !decode(w, r, &b) {
		return
	}
	if b.PIN == "" {
		fail(w, errBad("pin is required"))
		return
	}
	s.mu.Lock()
	pp := s.pending
	s.mu.Unlock()
	if pp == nil || time.Since(pp.started) > pairTTL {
		fail(w, errBad("no pairing in progress; start again"))
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	user, pass, err := s.js.PairGrant(ctx, pp.p, s.store.Get().JointSpace.AppSecret, b.PIN)
	if err != nil {
		fail(w, err)
		return
	}
	if err := s.store.Update(func(c *config.Config) { c.JointSpace.User, c.JointSpace.Pass = user, pass }); err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	s.js.SetCredentials(user, pass)
	s.mu.Lock()
	s.pending = nil
	s.mu.Unlock()
	s.done(w)
}

func (s *Server) handlePairForget(w http.ResponseWriter, r *http.Request) {
	if err := s.store.Update(func(c *config.Config) { c.JointSpace.User, c.JointSpace.Pass = "", "" }); err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	s.js.SetCredentials("", "")
	s.done(w)
}

type mqttView struct {
	Enabled         bool   `json:"enabled"`
	Host            string `json:"host"`
	Port            int    `json:"port"`
	User            string `json:"user"`
	HasPass         bool   `json:"has_pass"`
	Prefix          string `json:"prefix"`
	DiscoveryPrefix string `json:"discovery_prefix"`
	Interval        int    `json:"interval"`
}

func (s *Server) handleSettingsGet(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, s.settingsView())
}

// settingsView is the /api/settings body.
func (s *Server) settingsView() map[string]any {
	c := s.store.Get()
	s.mu.Lock()
	pending := s.pending != nil && time.Since(s.pending.started) <= pairTTL
	s.mu.Unlock()
	return map[string]any{
		"name": c.Name,
		"mqtt": mqttView{c.MQTT.Enabled, c.MQTT.Host, c.MQTT.Port, c.MQTT.User, c.MQTT.Pass != "",
			c.MQTT.Prefix, c.MQTT.DiscoveryPrefix, c.MQTT.Interval},
		"jointspace": map[string]any{
			"host": c.JointSpace.Host, "paired": s.js.Paired(),
			"has_app_secret": c.JointSpace.AppSecret != "", "pairing_pending": pending,
		},
		"launcher": map[string]any{"enabled": c.Launcher.On(), "layer": c.Launcher.Layer, "block_titanos": c.Launcher.BlockTitanOS,
			"apps": append([]string{}, c.Launcher.Apps...), "catalog": c.Launcher.Catalog,
			"weather":    map[string]any{"latitude": c.Launcher.Weather.Latitude, "longitude": c.Launcher.Weather.Longitude},
			"background": backgroundView(c.Launcher.Background)},
		"token_set": c.Token != "",
	}
}

func (s *Server) handleSettingsSet(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Name string `json:"name"`
		MQTT *struct {
			Enabled         bool   `json:"enabled"`
			Host            string `json:"host"`
			Port            int    `json:"port"`
			User            string `json:"user"`
			Pass            string `json:"pass"`
			Prefix          string `json:"prefix"`
			DiscoveryPrefix string `json:"discovery_prefix"`
			Interval        int    `json:"interval"`
		} `json:"mqtt"`
		Launcher *struct {
			Enabled      *bool                 `json:"enabled"`
			Layer        string                `json:"layer"`
			BlockTitanOS *bool                 `json:"block_titanos"`
			Apps         *[]string             `json:"apps"`
			Catalog      *config.CatalogConfig `json:"catalog"`
			Weather      *struct {
				Latitude  *float64 `json:"latitude"`
				Longitude *float64 `json:"longitude"`
				Clear     bool     `json:"clear"`
			} `json:"weather"`
			Background *backgroundPatch `json:"background"`
		} `json:"launcher"`
	}
	if !decode(w, r, &b) {
		return
	}
	if b.MQTT != nil && b.MQTT.Enabled && b.MQTT.Host == "" {
		fail(w, errBad("mqtt host is required when enabled"))
		return
	}
	if l := b.Launcher; l != nil && l.Layer != "" && l.Layer != "state" && l.Layer != "page" {
		fail(w, errBad(`launcher layer must be "state" or "page"`))
		return
	}
	if l := b.Launcher; l != nil && l.Weather != nil && !l.Weather.Clear {
		wt := l.Weather
		if wt.Latitude == nil || wt.Longitude == nil {
			fail(w, errBad("weather needs both latitude and longitude"))
			return
		}
		if !(config.Weather{Latitude: wt.Latitude, Longitude: wt.Longitude}).Set() {
			fail(w, errBad("weather latitude must be -90..90 and longitude -180..180"))
			return
		}
	}
	if l := b.Launcher; l != nil && l.Apps != nil {
		if len(*l.Apps) > maxLauncherApps {
			fail(w, errBad("launcher apps: at most 100 entries"))
			return
		}
		for _, code := range *l.Apps {
			if !appCodeRE.MatchString(code) {
				fail(w, errBad("launcher apps: bad code "+strconv.Quote(code)))
				return
			}
		}
	}
	if l := b.Launcher; l != nil && l.Background != nil {
		trial := s.store.Get().Launcher.Background
		if err := l.Background.apply(&trial); err != nil {
			fail(w, err)
			return
		}
	}
	catalogChanged := false
	err := s.store.Update(func(c *config.Config) {
		if l := b.Launcher; l != nil {
			if l.Apps != nil {
				c.Launcher.Apps = append([]string(nil), *l.Apps...)
			}
			if k := l.Catalog; k != nil {
				old := c.Launcher.Catalog
				c.Launcher.Catalog = *k // empty market/locale fall back to the defaults
				c.Launcher.Catalog.Market, c.Launcher.Catalog.Locale = orDefault(k.Market, old.Market), orDefault(k.Locale, old.Locale)
				catalogChanged = c.Launcher.Catalog != old
			}
			if wt := l.Weather; wt != nil {
				if wt.Clear {
					c.Launcher.Weather = config.Weather{}
				} else {
					c.Launcher.Weather = config.Weather{Latitude: wt.Latitude, Longitude: wt.Longitude}
				}
			}
			if l.Background != nil {
				_ = l.Background.apply(&c.Launcher.Background) // validated above
			}
			if l.Enabled != nil {
				c.Launcher.SetEnabled(*l.Enabled)
			}
			if l.Layer != "" {
				c.Launcher.Layer = l.Layer
			}
			if l.BlockTitanOS != nil {
				c.Launcher.BlockTitanOS = *l.BlockTitanOS
			}
		}
		if b.Name != "" {
			c.Name = b.Name
		}
		if m := b.MQTT; m != nil {
			pass := c.MQTT.Pass // empty/missing pass keeps the old one
			c.MQTT = config.MQTT{Enabled: m.Enabled, Host: m.Host, Port: m.Port, User: m.User,
				Pass: pass, Prefix: m.Prefix, DiscoveryPrefix: m.DiscoveryPrefix, Interval: m.Interval}
			if m.Pass != "" {
				c.MQTT.Pass = m.Pass
			}
		}
	})
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	if l := b.Launcher; l != nil && l.Background != nil {
		bg := s.store.Get().Launcher.Background
		keep := ""
		if bg.Kind == "pictures" {
			keep = bg.Pictures
		}
		s.pruneWallpaperSets(keep) // only the chosen set stays on the TV
	}
	if l := b.Launcher; l != nil && l.BlockTitanOS != nil && s.netSync != nil {
		if err := s.netSync(*l.BlockTitanOS); err != nil {
			writeErr(w, 500, err.Error())
			return
		}
	}
	if catalogChanged && s.catalog != nil {
		s.catalog.Kick()
	}
	if s.onSettings != nil {
		s.onSettings()
	}
	s.handleSettingsGet(w, r)
}

func orDefault(v, def string) string {
	if v == "" {
		return def
	}
	return v
}
