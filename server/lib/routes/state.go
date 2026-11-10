package routes

import (
	"context"
	"errors"
	"net/http"
	"sync"
	"time"

	"cactarium/server/lib/jointspace"
	"cactarium/server/lib/telemetry"
)

// State is the /api/state body.
type State struct {
	Version string          `json:"version"`
	Name    string          `json:"name"`
	Device  string          `json:"device_id"`
	TV      TVState         `json:"tv"`
	Stats   telemetry.Stats `json:"stats"`
	MQTT    MQTTState       `json:"mqtt"`
	Updated int64           `json:"updated"`
}

type TVState struct {
	Reachable bool              `json:"reachable"`
	Paired    bool              `json:"paired"`
	Error     string            `json:"error"`
	System    map[string]any    `json:"system"`
	Model     string            `json:"model"`
	Power     string            `json:"power"`
	Screen    string            `json:"screen"`
	Volume    jointspace.Volume `json:"volume"`
	Ambilight AmbilightState    `json:"ambilight"`
	// Source and Inputs come from the PHI bridge's "sources" method (see
	// phi_info.go); both are empty while PHI is frozen by a web app.
	Source *SourceState `json:"source,omitempty"`
	Inputs []InputState `json:"inputs,omitempty"`
}

type AmbilightState struct {
	Power  string         `json:"power"`
	Config map[string]any `json:"config"`
}

type MQTTState struct {
	Enabled   bool   `json:"enabled"`
	Connected bool   `json:"connected"`
	Error     string `json:"error"`
}

// cache holds the last TV poll.
type cache struct {
	mu      sync.RWMutex
	tv      TVState
	updated time.Time
}

func emptyTV() TVState {
	return TVState{System: map[string]any{}, Ambilight: AmbilightState{Config: map[string]any{}}}
}

const callTimeout = 4 * time.Second

// poll refreshes the cache from the TV. Calls are serialized so a command's
// follow-up poll never interleaves with the ticker's.
func (s *Server) poll() {
	s.pollMu.Lock()
	defer s.pollMu.Unlock()

	tv := emptyTV()
	tv.Paired = s.js.Paired()

	call := func(f func(ctx context.Context) error) {
		ctx, cancel := context.WithTimeout(context.Background(), callTimeout)
		defer cancel()
		if err := f(ctx); err != nil {
			tv.Error = err.Error()
		}
	}

	// 1925 needs no auth; if it answers the TV is up even when unpaired.
	ctx, cancel := context.WithTimeout(context.Background(), callTimeout)
	sys, err := s.js.System(ctx)
	cancel()
	if err == nil {
		tv.Reachable = true
		if sys != nil {
			tv.System = sys
		}
	}
	if tv.Reachable && tv.Paired {
		// TitanOS answers /6/powerstate with 404 (55PUS8450/12). Standby on
		// this TV is suspend-to-RAM, so when the TV answers at all it is on.
		call(func(ctx context.Context) error {
			p, err := s.js.PowerState(ctx)
			var se *jointspace.StatusError
			if errors.As(err, &se) && se.Code == http.StatusNotFound {
				err = nil
			}
			tv.Power = p
			return err
		})
		call(func(ctx context.Context) (err error) { tv.Screen, err = s.js.ScreenState(ctx); return })
		call(func(ctx context.Context) (err error) { tv.Volume, err = s.js.Volume(ctx); return })
		call(func(ctx context.Context) (err error) { tv.Ambilight.Power, err = s.js.AmbilightPower(ctx); return })
		call(func(ctx context.Context) error {
			m, err := s.js.AmbilightConfig(ctx)
			if m != nil {
				tv.Ambilight.Config = m
			}
			return err
		})
	}

	if tv.Reachable && tv.Power == "" {
		tv.Power = "On"
	}

	s.cache.mu.Lock()
	s.cache.tv, s.cache.updated = tv, time.Now()
	s.cache.mu.Unlock()
}

// Refresh asks the poller for an immediate, debounced TV poll.
func (s *Server) Refresh() {
	select {
	case s.refresh <- struct{}{}:
	default:
	}
}

// State returns the cached TV state with live stats and MQTT status.
func (s *Server) State() State {
	cfg := s.store.Get()
	s.cache.mu.RLock()
	tv, upd := s.cache.tv, s.cache.updated
	s.cache.mu.RUnlock()
	if tv.System == nil { // before the first poll
		tv = emptyTV()
		tv.Paired = s.js.Paired()
	}
	tv.Model = cfg.Launcher.Catalog.Model
	s.fillFromPHI(&tv)
	st := State{Version: s.version, Name: cfg.Name, Device: cfg.DeviceID, TV: tv}
	if !upd.IsZero() {
		st.Updated = upd.UnixMilli()
	}
	if s.sampler != nil {
		st.Stats = s.sampler.Snapshot()
	}
	st.MQTT.Enabled = cfg.MQTT.Enabled
	if s.mqttStatus != nil {
		st.MQTT.Enabled, st.MQTT.Connected, st.MQTT.Error = s.mqttStatus()
	}
	return st
}

// pollLoop polls every 5 s and on Refresh (debounced) until ctx is done.
func (s *Server) pollLoop(ctx context.Context) {
	s.poll()
	t := time.NewTicker(5 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.poll()
		case <-s.refresh:
			select { // debounce: let the TV apply the change and coalesce bursts
			case <-time.After(250 * time.Millisecond):
			case <-ctx.Done():
				return
			}
			select {
			case <-s.refresh:
			default:
			}
			s.poll()
			t.Reset(5 * time.Second)
		}
	}
}
