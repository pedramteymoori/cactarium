package routes

import (
	"context"
	"errors"
	"fmt"
)

var errNotPaired = errors.New("TV is not paired")

// cmd runs one authenticated TV call, then schedules a state refresh. These
// are the methods main adapts to ha.Commands.
func (s *Server) cmd(f func(ctx context.Context) error) error {
	if !s.js.Paired() {
		return errNotPaired
	}
	ctx, cancel := context.WithTimeout(context.Background(), callTimeout)
	defer cancel()
	err := f(ctx)
	s.Refresh()
	if s.onCommand != nil {
		s.onCommand()
	}
	return err
}

func (s *Server) Key(key string) error {
	if key == "" {
		return errBad("key is required")
	}
	return s.cmd(func(ctx context.Context) error { return s.js.SendKey(ctx, key) })
}

func (s *Server) SetPowerState(state string) error {
	if state != "On" && state != "Standby" {
		return errBad(`state must be "On" or "Standby"`)
	}
	return s.cmd(func(ctx context.Context) error { return s.js.SetPowerState(ctx, state) })
}

func (s *Server) SetPower(on bool) error {
	if on {
		return s.SetPowerState("On")
	}
	return s.SetPowerState("Standby")
}

// SetVolume sets the level, keeping the mute flag.
func (s *Server) SetVolume(v int) error { return s.setVolume(&v, nil, 0) }

// SetMuted sets mute, keeping the level.
func (s *Server) SetMuted(m bool) error { return s.setVolume(nil, &m, 0) }

// setVolume reads the live volume first because the POST needs both fields
// and the cache may be up to 5 s old.
func (s *Server) setVolume(cur *int, muted *bool, step int) error {
	return s.cmd(func(ctx context.Context) error {
		v, err := s.js.Volume(ctx)
		if err != nil {
			return err
		}
		if cur != nil {
			v.Current = *cur
		}
		v.Current += step
		if muted != nil {
			v.Muted = *muted
		}
		if v.Max > 0 && v.Current > v.Max {
			v.Current = v.Max
		}
		if v.Current < v.Min {
			v.Current = v.Min
		}
		return s.js.SetVolume(ctx, v)
	})
}

func (s *Server) SetAmbilight(on bool) error {
	p := "Off"
	if on {
		p = "On"
	}
	return s.cmd(func(ctx context.Context) error { return s.js.SetAmbilightPower(ctx, p) })
}

func (s *Server) SetAmbilightStyle(style, algorithm string) error {
	if style == "" {
		return errBad("style is required")
	}
	return s.cmd(func(ctx context.Context) error { return s.js.SetAmbilightStyle(ctx, style, algorithm) })
}

// badRequest marks validation errors so handlers answer 400.
type badRequest string

func (e badRequest) Error() string { return string(e) }

func errBad(format string, a ...any) error { return badRequest(fmt.Sprintf(format, a...)) }
