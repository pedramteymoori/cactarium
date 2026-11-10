package ha

import (
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"
)

type fakePub struct {
	mu   sync.Mutex
	msgs map[string]string
	ret  map[string]bool
}

func (f *fakePub) Publish(t string, p []byte, r bool) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.msgs[t] = string(p)
	f.ret[t] = r
	return nil
}

type fakeCmd struct {
	power *bool
	vol   int
	key   string
}

func (c *fakeCmd) Key(k string) error      { c.key = k; return nil }
func (c *fakeCmd) SetPower(on bool) error  { c.power = &on; return nil }
func (c *fakeCmd) SetVolume(v int) error   { c.vol = v; return nil }
func (c *fakeCmd) SetMuted(bool) error     { return nil }
func (c *fakeCmd) SetAmbilight(bool) error { return nil }

func newTest(snap Snapshot) (*Bridge, *fakePub, *fakeCmd) {
	fp := &fakePub{msgs: map[string]string{}, ret: map[string]bool{}}
	fc := &fakeCmd{}
	b := New(Settings{Prefix: "cactarium", DiscoveryPrefix: "homeassistant", DeviceID: "abcd1234", Interval: time.Second},
		nil, func() Snapshot { return snap }, fc)
	b.pub = fp
	return b, fp, fc
}

func TestDiscovery(t *testing.T) {
	b, fp, _ := newTest(Snapshot{Name: "TV", Version: "1", Power: "On", VolumeMax: 60})
	b.onConnect()
	base := "homeassistant/%s/cactarium_abcd1234/%s/config"
	must := [][2]string{{"switch", "power"}, {"number", "volume"}, {"switch", "mute"}, {"switch", "ambilight"},
		{"sensor", "cpu"}, {"sensor", "memory"}, {"sensor", "uptime"}, {"button", "button_home"}, {"button", "button_source"}}
	for _, m := range must {
		topic := strings.Replace(strings.Replace(base, "%s", m[0], 1), "%s", m[1], 1)
		if _, ok := fp.msgs[topic]; !ok {
			t.Errorf("missing discovery %s", topic)
		}
		if !fp.ret[topic] {
			t.Errorf("%s not retained", topic)
		}
	}
	if _, ok := fp.msgs["homeassistant/sensor/cactarium_abcd1234/temperature/config"]; ok {
		t.Error("temperature should be omitted")
	}
	var p map[string]any
	if err := json.Unmarshal([]byte(fp.msgs["homeassistant/number/cactarium_abcd1234/volume/config"]), &p); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"unique_id", "object_id", "availability_topic", "device", "state_topic", "value_template",
		"command_topic", "min", "max", "step", "mode"} {
		if _, ok := p[k]; !ok {
			t.Errorf("number missing %s", k)
		}
	}
	if p["command_topic"] != "cactarium/abcd1234/volume/set" || p["mode"] != "slider" {
		t.Errorf("bad number: %v", p)
	}
	dev := p["device"].(map[string]any)
	if dev["manufacturer"] != "Philips" || dev["model"] != "TitanOS TV" || dev["identifiers"].([]any)[0] != "cactarium_abcd1234" {
		t.Errorf("bad device %v", dev)
	}
	var sw map[string]any
	json.Unmarshal([]byte(fp.msgs["homeassistant/switch/cactarium_abcd1234/power/config"]), &sw)
	if sw["payload_on"] != "ON" || sw["payload_off"] != "OFF" {
		t.Errorf("bad switch %v", sw)
	}
	var btn map[string]any
	json.Unmarshal([]byte(fp.msgs["homeassistant/button/cactarium_abcd1234/button_home/config"]), &btn)
	if btn["payload_press"] != "PRESS" || btn["command_topic"] != "cactarium/abcd1234/button/Home" {
		t.Errorf("bad button %v", btn)
	}
	var cpu map[string]any
	json.Unmarshal([]byte(fp.msgs["homeassistant/sensor/cactarium_abcd1234/cpu/config"]), &cpu)
	if cpu["unit_of_measurement"] != "%" || cpu["state_class"] != "measurement" {
		t.Errorf("bad sensor %v", cpu)
	}
	if fp.msgs["cactarium/abcd1234/availability"] != "online" || !fp.ret["cactarium/abcd1234/availability"] {
		t.Error("availability not online/retained")
	}
	if _, ok := fp.msgs["cactarium/abcd1234/state"]; !ok {
		t.Error("no state")
	}
}

func TestOptionalSensorsAppearLater(t *testing.T) {
	temp := 55.0
	snap := Snapshot{}
	b, fp, _ := newTest(snap)
	b.snapshot = func() Snapshot { return snap }
	b.onConnect()
	snap.TempC = &temp
	b.PublishState()
	if _, ok := fp.msgs["homeassistant/sensor/cactarium_abcd1234/temperature/config"]; !ok {
		t.Error("temperature discovery not re-published")
	}
	if !strings.Contains(fp.msgs["cactarium/abcd1234/state"], `"temperature":55`) {
		t.Errorf("state: %s", fp.msgs["cactarium/abcd1234/state"])
	}
}

func TestCommands(t *testing.T) {
	b, fp, fc := newTest(Snapshot{VolumeMax: 60})
	b.handleMsg("cactarium/abcd1234/power/set", []byte("ON"))
	if fc.power == nil || !*fc.power {
		t.Fatal("SetPower(true) not called")
	}
	b.handleMsg("cactarium/abcd1234/power/set", []byte("garbage"))
	b.handleMsg("cactarium/abcd1234/volume/set", []byte("99.4"))
	if fc.vol != 60 {
		t.Errorf("vol=%d", fc.vol)
	}
	b.handleMsg("cactarium/abcd1234/button/Home", []byte("PRESS"))
	if fc.key != "Home" {
		t.Errorf("key=%q", fc.key)
	}
	b.handleMsg("cactarium/abcd1234/key/set", []byte("../x"))
	if fc.key != "Home" {
		t.Errorf("invalid key accepted: %q", fc.key)
	}
	if _, ok := fp.msgs["cactarium/abcd1234/state"]; !ok {
		t.Error("state not published after command")
	}
}
