package routes

import (
	"context"
	"encoding/json"
	"sync"
	"time"
)

// What the dashboard shows about the TV itself (model, what is on screen, the
// HDMI ports) comes from the PHI bridge, which answers only while the TV's UI
// page is not frozen by a web app. The poll runs off the 5 s state poller so a
// frozen page never slows it, and keeps the last answer for a while.

const (
	phiInfoEvery   = 10 * time.Second
	phiInfoWait    = 3 * time.Second
	phiSourcesKeep = 45 * time.Second // older than this and the source is unknown, not stale
	phiModelRetry  = time.Minute
)

type SourceState struct {
	TypeID int    `json:"type_id"`
	Label  string `json:"label"`
}

type InputState struct {
	TypeID    int    `json:"type_id"`
	Port      int    `json:"port,omitempty"` // HDMI port number; 0 for the tuner
	Kind      string `json:"kind"`
	Name      string `json:"name"`
	Label     string `json:"label"`
	Connected *bool  `json:"connected"`
	Current   bool   `json:"current"`
}

type phiInfoCache struct {
	mu         sync.RWMutex
	model      string
	modelTried time.Time
	source     *SourceState
	inputs     []InputState
	at         time.Time
}

// sourceLabel names a PHI source type id (RpcSourceSwitch's enum). The
// TitanOS ones are verified on 55PUS8450/12: 9 is the Smart TV home, 14 an
// internet app, 26 the streaming channels.
func sourceLabel(id int, inputs []InputState) string {
	for _, in := range inputs {
		if in.TypeID == id && in.Kind == "hdmi" {
			return in.Name
		}
	}
	switch id {
	case 2, 3, 4, 11:
		return "HDMI"
	case 0, 5, 6, 7, 18, 19:
		return "TV"
	case 9:
		return "Home"
	case 14:
		return "App"
	case 26:
		return "Streaming channels"
	}
	return ""
}

func (s *Server) phiInfoLoop(ctx context.Context) {
	t := time.NewTicker(phiInfoEvery)
	defer t.Stop()
	for {
		s.refreshPHIInfo()
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

func (s *Server) refreshPHIInfo() {
	c := &s.phiInfo
	c.mu.RLock()
	needModel := c.model == "" && time.Since(c.modelTried) >= phiModelRetry
	c.mu.RUnlock()

	o, err := s.phi.call("sources", nil, phiInfoWait)
	if err != nil || !o.OK {
		return // PHI frozen or no hook: keep the last answer until it ages out
	}
	var res struct {
		Sources []struct {
			TypeID    int    `json:"typeId"`
			Name      string `json:"name"`
			Origname  string `json:"origname"`
			Kind      string `json:"kind"`
			Port      int    `json:"port"`
			Connected *bool  `json:"connected"`
			Current   bool   `json:"current"`
		} `json:"sources"`
		Current *int `json:"current"`
	}
	if json.Unmarshal(o.Result, &res) != nil || res.Current == nil {
		return
	}
	inputs := make([]InputState, 0, len(res.Sources))
	for _, x := range res.Sources {
		inputs = append(inputs, InputState{TypeID: x.TypeID, Port: x.Port, Kind: x.Kind, Name: x.Name, Label: x.Origname, Connected: x.Connected, Current: x.Current})
	}
	src := &SourceState{TypeID: *res.Current, Label: sourceLabel(*res.Current, inputs)}

	var model string
	if needModel {
		if mo, err := s.phi.call("RpcModelInfoGet", nil, phiInfoWait); err == nil && mo.OK {
			var m struct {
				Model string `json:"Model"`
			}
			_ = json.Unmarshal(mo.Result, &m)
			model = m.Model
		}
	}
	c.mu.Lock()
	c.source, c.inputs, c.at = src, inputs, time.Now()
	if needModel {
		c.modelTried = time.Now()
		if model != "" {
			c.model = model
		}
	}
	c.mu.Unlock()
}

// fillFromPHI adds the cached PHI answers to a state copy. The model falls
// back to the config's catalog model until PHI has answered.
func (s *Server) fillFromPHI(tv *TVState) {
	c := &s.phiInfo
	c.mu.RLock()
	defer c.mu.RUnlock()
	if c.model != "" {
		tv.Model = c.model
	}
	if c.source != nil && time.Since(c.at) < phiSourcesKeep {
		src := *c.source
		tv.Source = &src
		tv.Inputs = append([]InputState(nil), c.inputs...)
	}
}
