package main

import (
	"context"
	"sync"
	"time"

	"cactarium/server/lib/config"
	"cactarium/server/lib/ha"
	"cactarium/server/lib/mqtt"
	"cactarium/server/lib/routes"
)

// haRunner owns the MQTT client + HA bridge and restarts them when settings
// change. The server stays unaware of both.
type haRunner struct {
	parent context.Context
	store  *config.Store
	srv    *routes.Server

	mu     sync.Mutex
	cancel context.CancelFunc
	done   chan struct{}
	mq     *mqtt.Client
	bridge *ha.Bridge
}

func newHARunner(ctx context.Context, store *config.Store, srv *routes.Server) *haRunner {
	return &haRunner{parent: ctx, store: store, srv: srv}
}

// restart stops any running bridge and starts a new one if MQTT is enabled.
func (r *haRunner) restart() {
	r.stop()
	cfg := r.store.Get()
	if !cfg.MQTT.Enabled || cfg.MQTT.Host == "" || r.parent.Err() != nil {
		return
	}
	m := cfg.MQTT
	b := ha.New(ha.Settings{
		Prefix: m.Prefix, DiscoveryPrefix: m.DiscoveryPrefix, DeviceID: cfg.DeviceID,
		Interval: time.Duration(m.Interval) * time.Second,
	}, nil, r.snapshot, commands{r})
	mq := mqtt.New(mqtt.Options{
		Host: m.Host, Port: m.Port, ClientID: "cactarium-" + cfg.DeviceID, User: m.User, Pass: m.Pass,
		KeepAlive: 30 * time.Second,
		WillTopic: b.AvailabilityTopic(), WillPayload: []byte("offline"), WillRetain: true,
		OnConnect: b.OnConnect,
	})
	b.Attach(mq)

	ctx, cancel := context.WithCancel(r.parent)
	done := make(chan struct{})
	r.mu.Lock()
	r.cancel, r.done, r.mq, r.bridge = cancel, done, mq, b
	r.mu.Unlock()
	go func() {
		defer close(done)
		var wg sync.WaitGroup
		wg.Add(2)
		go func() { defer wg.Done(); mq.Run(ctx) }()
		go func() { defer wg.Done(); b.Run(ctx) }()
		wg.Wait()
	}()
}

// stop cancels the bridge and waits for it (so "offline" gets published).
func (r *haRunner) stop() {
	r.mu.Lock()
	cancel, done := r.cancel, r.done
	r.cancel, r.done, r.mq, r.bridge = nil, nil, nil, nil
	r.mu.Unlock()
	if cancel == nil {
		return
	}
	cancel()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
	}
}

func (r *haRunner) status() (enabled, connected bool, errMsg string) {
	enabled = r.store.Get().MQTT.Enabled
	r.mu.Lock()
	mq := r.mq
	r.mu.Unlock()
	if mq != nil {
		connected, errMsg = mq.Connected(), mq.LastError()
	}
	return
}

func (r *haRunner) snapshot() ha.Snapshot {
	st := r.srv.State()
	s := ha.Snapshot{
		Name: st.Name, DeviceID: st.Device, Version: st.Version,
		Reachable: st.TV.Reachable, Power: st.TV.Power, Screen: st.TV.Screen,
		Volume: st.TV.Volume.Current, VolumeMax: st.TV.Volume.Max, Muted: st.TV.Volume.Muted,
		Ambilight: st.TV.Ambilight.Power, CPU: st.Stats.CPUPercent, UptimeSec: st.Stats.UptimeSec,
		System: st.TV.System,
	}
	if st.Stats.MemTotalKB > 0 {
		s.MemPercent = 100 * float64(st.Stats.MemTotalKB-st.Stats.MemAvailKB) / float64(st.Stats.MemTotalKB)
	}
	if len(st.Stats.TempsC) > 0 {
		t := st.Stats.TempsC[0].C
		for _, x := range st.Stats.TempsC {
			if x.C > t {
				t = x.C
			}
		}
		s.TempC = &t
	}
	if st.Stats.WiFi != nil {
		d := st.Stats.WiFi.LevelDBm
		s.WiFiDBm = &d
	}
	return s
}

// publishSoon republishes state once the server's debounced poll has landed.
func (r *haRunner) publishSoon() {
	time.AfterFunc(700*time.Millisecond, func() {
		r.mu.Lock()
		b := r.bridge
		r.mu.Unlock()
		if b != nil {
			b.PublishState()
		}
	})
}

// commands adapts the server's command methods to ha.Commands.
type commands struct{ r *haRunner }

// The server's command methods already trigger publishSoon via OnCommand.
func (c commands) do(err error) error { return err }

func (c commands) Key(k string) error         { return c.do(c.r.srv.Key(k)) }
func (c commands) SetPower(on bool) error     { return c.do(c.r.srv.SetPower(on)) }
func (c commands) SetVolume(v int) error      { return c.do(c.r.srv.SetVolume(v)) }
func (c commands) SetMuted(m bool) error      { return c.do(c.r.srv.SetMuted(m)) }
func (c commands) SetAmbilight(on bool) error { return c.do(c.r.srv.SetAmbilight(on)) }
