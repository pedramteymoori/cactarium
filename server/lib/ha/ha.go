// Package ha bridges the TV to Home Assistant over MQTT (discovery, state,
// availability and command topics).
//
// The MQTT client needs OnConnect at construction and the bridge needs the
// client, so create the bridge first with a nil client and Attach it later:
//
//	b := ha.New(ha.Settings{Prefix: "cactarium", DiscoveryPrefix: "homeassistant",
//		DeviceID: id, Interval: 10 * time.Second}, nil, snapshotFn, commands)
//	mq := mqtt.New(mqtt.Options{
//		Host: host, Port: port, User: user, Pass: pass,
//		WillTopic: b.AvailabilityTopic(), WillPayload: []byte("offline"), WillRetain: true,
//		OnConnect: b.OnConnect,
//	})
//	b.Attach(mq) // registers command subscriptions
//	go mq.Run(ctx)
//	go b.Run(ctx) // periodic state; publishes "offline" when ctx ends
//
// After a command, call b.PublishState().
package ha

import (
	"context"
	"encoding/json"
	"math"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"cactarium/server/lib/mqtt"
)

// Settings are the plain bridge settings.
type Settings struct {
	Prefix, DiscoveryPrefix, DeviceID string
	Interval                          time.Duration
}

// Snapshot is the data the bridge publishes.
type Snapshot struct {
	Name, DeviceID, Version string
	Reachable               bool
	Power, Screen           string
	Volume, VolumeMax       int
	Muted                   bool
	Ambilight               string
	CPU, MemPercent         float64
	TempC                   *float64
	UptimeSec               float64
	WiFiDBm                 *float64
	System                  map[string]any
}

// Commands are invoked for incoming HA commands.
type Commands interface {
	Key(key string) error
	SetPower(on bool) error
	SetVolume(v int) error
	SetMuted(m bool) error
	SetAmbilight(on bool) error
}

type publisher interface {
	Publish(topic string, payload []byte, retain bool) error
}

// Bridge is the Home Assistant MQTT bridge.
type Bridge struct {
	s        Settings
	snapshot func() Snapshot
	cmd      Commands

	mu      sync.Mutex
	pub     publisher
	subbed  bool
	hasTemp bool
	hasWiFi bool
}

// New creates a bridge. mq may be nil and supplied later via Attach.
func New(s Settings, mq *mqtt.Client, snapshot func() Snapshot, cmd Commands) *Bridge {
	if s.Interval <= 0 {
		s.Interval = 10 * time.Second
	}
	if s.Prefix == "" {
		s.Prefix = "cactarium"
	}
	if s.DiscoveryPrefix == "" {
		s.DiscoveryPrefix = "homeassistant"
	}
	b := &Bridge{s: s, snapshot: snapshot, cmd: cmd}
	if mq != nil {
		b.Attach(mq)
	}
	return b
}

// Attach sets the MQTT client and registers the command subscriptions (once).
func (b *Bridge) Attach(mq *mqtt.Client) {
	b.mu.Lock()
	b.pub = mq
	b.mu.Unlock()
	b.subscribe(mq)
}

func (b *Bridge) subscribe(mq *mqtt.Client) {
	b.mu.Lock()
	if b.subbed || mq == nil {
		b.mu.Unlock()
		return
	}
	b.subbed = true
	b.mu.Unlock()
	mq.Subscribe(b.base()+"/+/set", b.handle)
	mq.Subscribe(b.base()+"/button/+", b.handle)
}

func (b *Bridge) base() string { return b.s.Prefix + "/" + b.s.DeviceID }

// AvailabilityTopic is the retained online/offline topic (use it as the MQTT will).
func (b *Bridge) AvailabilityTopic() string { return b.base() + "/availability" }

// StateTopic is the retained JSON state topic.
func (b *Bridge) StateTopic() string { return b.base() + "/state" }

func (b *Bridge) publisher() publisher {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.pub
}

// OnConnect is for mqtt.Options.OnConnect: publishes discovery, availability
// and state.
func (b *Bridge) OnConnect(c *mqtt.Client) {
	b.mu.Lock()
	if b.pub == nil {
		b.pub = c
	}
	b.mu.Unlock()
	b.subscribe(c)
	b.onConnect()
}

func (b *Bridge) onConnect() {
	snap := b.snapshot()
	b.publishDiscovery(snap)
	b.send(b.AvailabilityTopic(), []byte("online"), true)
	b.send(b.StateTopic(), stateJSON(snap), true)
}

func (b *Bridge) send(topic string, payload []byte, retain bool) {
	if p := b.publisher(); p != nil {
		p.Publish(topic, payload, retain)
	}
}

// Run publishes state every Interval until ctx is done, then publishes offline.
func (b *Bridge) Run(ctx context.Context) {
	t := time.NewTicker(b.s.Interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			b.send(b.AvailabilityTopic(), []byte("offline"), true)
			return
		case <-t.C:
			b.PublishState()
		}
	}
}

// PublishState publishes the current state (and discovery again if temperature
// or Wi-Fi sensors have newly appeared).
func (b *Bridge) PublishState() {
	snap := b.snapshot()
	b.mu.Lock()
	changed := (snap.TempC != nil && !b.hasTemp) || (snap.WiFiDBm != nil && !b.hasWiFi)
	b.mu.Unlock()
	if changed {
		b.publishDiscovery(snap)
	}
	b.send(b.StateTopic(), stateJSON(snap), true)
}

func onOff(v bool) string {
	if v {
		return "ON"
	}
	return "OFF"
}

func stateJSON(s Snapshot) []byte {
	m := map[string]any{
		"reachable": s.Reachable,
		"power":     onOff(strings.EqualFold(s.Power, "on")),
		"screen":    s.Screen,
		"volume":    s.Volume,
		"muted":     onOff(s.Muted),
		"ambilight": onOff(strings.EqualFold(s.Ambilight, "on")),
		"cpu":       round1(s.CPU),
		"memory":    round1(s.MemPercent),
		"uptime":    math.Round(s.UptimeSec),
	}
	if s.TempC != nil {
		m["temperature"] = round1(*s.TempC)
	}
	if s.WiFiDBm != nil {
		m["wifi_dbm"] = round1(*s.WiFiDBm)
	}
	out, _ := json.Marshal(m)
	return out
}

func round1(f float64) float64 {
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return 0
	}
	return math.Round(f*10) / 10
}

type entity struct {
	component, object string
	payload           map[string]any
}

func (b *Bridge) entities(s Snapshot) []entity {
	id := b.s.DeviceID
	dev := map[string]any{
		"identifiers":  []string{"cactarium_" + id},
		"name":         nonEmpty(s.Name, "Philips TV"),
		"manufacturer": "Philips",
		"model":        "TitanOS TV",
		"sw_version":   s.Version,
	}
	mk := func(component, object, name string, extra map[string]any) entity {
		p := map[string]any{
			"name":               name,
			"unique_id":          "cactarium_" + id + "_" + object,
			"object_id":          "cactarium_" + id + "_" + object,
			"has_entity_name":    true,
			"availability_topic": b.AvailabilityTopic(),
			"device":             dev,
		}
		for k, v := range extra {
			p[k] = v
		}
		return entity{component, object, p}
	}
	sw := func(object, name, tmpl, cmdTopic string) entity {
		return mk("switch", object, name, map[string]any{
			"state_topic":    b.StateTopic(),
			"value_template": tmpl,
			"command_topic":  b.base() + "/" + cmdTopic,
			"payload_on":     "ON",
			"payload_off":    "OFF",
			"state_on":       "ON",
			"state_off":      "OFF",
		})
	}
	sensor := func(object, name, field, unit, class string) entity {
		x := map[string]any{
			"state_topic":    b.StateTopic(),
			"value_template": "{{ value_json." + field + " }}",
			"state_class":    "measurement",
		}
		if unit != "" {
			x["unit_of_measurement"] = unit
		}
		if class != "" {
			x["device_class"] = class
		}
		return mk("sensor", object, name, x)
	}
	vmax := s.VolumeMax
	if vmax <= 0 {
		vmax = 60
	}
	es := []entity{
		sw("power", "Power", "{{ value_json.power }}", "power/set"),
		mk("number", "volume", "Volume", map[string]any{
			"state_topic":    b.StateTopic(),
			"value_template": "{{ value_json.volume }}",
			"command_topic":  b.base() + "/volume/set",
			"min":            0,
			"max":            vmax,
			"step":           1,
			"mode":           "slider",
		}),
		sw("mute", "Mute", "{{ value_json.muted }}", "mute/set"),
		sw("ambilight", "Ambilight", "{{ value_json.ambilight }}", "ambilight/set"),
		sensor("cpu", "CPU", "cpu", "%", ""),
		sensor("memory", "Memory", "memory", "%", ""),
	}
	if s.TempC != nil {
		es = append(es, sensor("temperature", "Temperature", "temperature", "°C", "temperature"))
	}
	es = append(es, func() entity {
		e := sensor("uptime", "Uptime", "uptime", "s", "duration")
		e.payload["state_class"] = "total_increasing"
		return e
	}())
	if s.WiFiDBm != nil {
		es = append(es, sensor("wifi", "Wi-Fi signal", "wifi_dbm", "dBm", "signal_strength"))
	}
	for _, k := range [][2]string{{"Home", "Home"}, {"Back", "Back"}, {"PlayPause", "Play/Pause"}, {"Source", "Source"}} {
		es = append(es, mk("button", "button_"+strings.ToLower(k[0]), k[1], map[string]any{
			"command_topic": b.base() + "/button/" + k[0],
			"payload_press": "PRESS",
		}))
	}
	return es
}

func nonEmpty(s, d string) string {
	if s == "" {
		return d
	}
	return s
}

func (b *Bridge) discoveryTopic(e entity) string {
	return b.s.DiscoveryPrefix + "/" + e.component + "/cactarium_" + b.s.DeviceID + "/" + e.object + "/config"
}

func (b *Bridge) publishDiscovery(s Snapshot) {
	for _, e := range b.entities(s) {
		data, err := json.Marshal(e.payload)
		if err != nil {
			continue
		}
		b.send(b.discoveryTopic(e), data, true)
	}
	b.mu.Lock()
	b.hasTemp = s.TempC != nil
	b.hasWiFi = s.WiFiDBm != nil
	b.mu.Unlock()
}

var keyRe = regexp.MustCompile(`^[A-Za-z0-9]{1,32}$`)

func parseOnOff(p []byte) (bool, bool) {
	switch strings.ToUpper(strings.TrimSpace(string(p))) {
	case "ON", "TRUE", "1":
		return true, true
	case "OFF", "FALSE", "0":
		return false, true
	}
	return false, false
}

func (b *Bridge) handle(m mqtt.Message) {
	b.handleMsg(m.Topic, m.Payload)
}

func (b *Bridge) handleMsg(topic string, payload []byte) {
	rel := strings.TrimPrefix(topic, b.base()+"/")
	if rel == topic {
		return
	}
	var err error
	switch {
	case rel == "power/set":
		if on, ok := parseOnOff(payload); ok {
			err = b.cmd.SetPower(on)
		}
	case rel == "mute/set":
		if on, ok := parseOnOff(payload); ok {
			err = b.cmd.SetMuted(on)
		}
	case rel == "ambilight/set":
		if on, ok := parseOnOff(payload); ok {
			err = b.cmd.SetAmbilight(on)
		}
	case rel == "volume/set":
		f, perr := strconv.ParseFloat(strings.TrimSpace(string(payload)), 64)
		if perr != nil || math.IsNaN(f) || math.IsInf(f, 0) {
			return
		}
		v := int(math.Round(f))
		max := b.snapshot().VolumeMax
		if max <= 0 {
			max = 60
		}
		if v < 0 {
			v = 0
		}
		if v > max {
			v = max
		}
		err = b.cmd.SetVolume(v)
	case rel == "key/set":
		if k := strings.TrimSpace(string(payload)); keyRe.MatchString(k) {
			err = b.cmd.Key(k)
		}
	case strings.HasPrefix(rel, "button/"):
		if k := strings.TrimPrefix(rel, "button/"); keyRe.MatchString(k) {
			err = b.cmd.Key(k)
		}
	default:
		return
	}
	_ = err
	b.PublishState()
}
