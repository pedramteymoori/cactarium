package routes

import (
	"context"
	"net/http"
)

// done answers a successful command with the freshly polled state, so the UI
// reflects the change without a second request.
func (s *Server) done(w http.ResponseWriter) {
	s.poll()
	writeJSON(w, 200, s.State())
}

func (s *Server) handleState(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, s.State())
}

func (s *Server) handleKey(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Key string `json:"key"`
	}
	if !decode(w, r, &b) {
		return
	}
	if err := s.Key(b.Key); err != nil {
		fail(w, err)
		return
	}
	s.done(w)
}

func (s *Server) handleVolume(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Current *int  `json:"current"`
		Muted   *bool `json:"muted"`
		Step    *int  `json:"step"`
	}
	if !decode(w, r, &b) {
		return
	}
	if b.Current == nil && b.Muted == nil && b.Step == nil {
		fail(w, errBad("current, muted or step is required"))
		return
	}
	step := 0
	if b.Step != nil {
		step = *b.Step
	}
	if err := s.setVolume(b.Current, b.Muted, step); err != nil {
		fail(w, err)
		return
	}
	s.done(w)
}

func (s *Server) handlePower(w http.ResponseWriter, r *http.Request) {
	var b struct {
		State string `json:"state"`
	}
	if !decode(w, r, &b) {
		return
	}
	if err := s.SetPowerState(b.State); err != nil {
		fail(w, err)
		return
	}
	s.done(w)
}

// passthrough runs a read-only authenticated call and relays its map.
func (s *Server) passthrough(w http.ResponseWriter, f func(ctx context.Context) (map[string]any, error)) {
	if !s.js.Paired() {
		fail(w, errNotPaired)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), callTimeout)
	defer cancel()
	m, err := f(ctx)
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, 200, m)
}

// handleAmbilight serves cached power/config; styles and topology never
// change at runtime so they are fetched once, on first success.
func (s *Server) handleAmbilight(w http.ResponseWriter, r *http.Request) {
	st := s.State()
	out := map[string]any{"power": st.TV.Ambilight.Power, "config": st.TV.Ambilight.Config}
	s.mu.Lock()
	if s.js.Paired() && st.TV.Reachable && (s.styles == nil || s.topo == nil) {
		ctx, cancel := context.WithTimeout(context.Background(), callTimeout)
		defer cancel()
		if s.styles == nil {
			if m, err := s.js.AmbilightStyles(ctx); err == nil {
				s.styles = m
			}
		}
		if s.topo == nil {
			if m, err := s.js.AmbilightTopology(ctx); err == nil {
				s.topo = m
			}
		}
	}
	out["styles"], out["topology"] = orEmpty(s.styles), orEmpty(s.topo)
	s.mu.Unlock()
	writeJSON(w, 200, out)
}

func orEmpty(m map[string]any) map[string]any {
	if m == nil {
		return map[string]any{}
	}
	return m
}

func (s *Server) handleAmbilightLive(w http.ResponseWriter, r *http.Request) {
	s.passthrough(w, s.js.AmbilightProcessed)
}

func (s *Server) handleAmbilightSet(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Power     string `json:"power"`
		Style     string `json:"style"`
		Algorithm string `json:"algorithm"`
	}
	if !decode(w, r, &b) {
		return
	}
	if b.Power == "" && b.Style == "" {
		fail(w, errBad("power or style is required"))
		return
	}
	if b.Power != "" {
		if b.Power != "On" && b.Power != "Off" {
			fail(w, errBad(`power must be "On" or "Off"`))
			return
		}
		if err := s.SetAmbilight(b.Power == "On"); err != nil {
			fail(w, err)
			return
		}
	}
	if b.Style != "" {
		if err := s.SetAmbilightStyle(b.Style, b.Algorithm); err != nil {
			fail(w, err)
			return
		}
	}
	s.done(w)
}
