package telemetry

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func write(t *testing.T, root, p, s string) {
	t.Helper()
	full := filepath.Join(root, p)
	os.MkdirAll(filepath.Dir(full), 0o755)
	if err := os.WriteFile(full, []byte(s), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestSampleFakeProc(t *testing.T) {
	root := t.TempDir()
	write(t, root, "/proc/uptime", "100.5 90.0\n")
	write(t, root, "/proc/loadavg", "0.10 0.20 0.30 1/100 5\n")
	write(t, root, "/proc/stat", "cpu 100 0 100 800 0 0 0 0\ncpu0 50 0 50 400 0 0 0 0\n")
	write(t, root, "/proc/meminfo", "MemTotal: 1000 kB\nMemAvailable: 400 kB\nSwapTotal: 800 kB\nSwapFree: 700 kB\n")
	write(t, root, "/sys/block/mmcblk0/device/life_time", "0x01 0x02\n")
	write(t, root, "/sys/block/mmcblk0/device/pre_eol_info", "0x01\n")
	write(t, root, "/proc/net/dev", "Inter-|\n face |\n  lo: 1 0 0 0 0 0 0 0 1 0\n wlan0: 1000 0 0 0 0 0 0 0 500 0\n"+
		" dummy0: 5 0 0 0 0 0 0 0 5 0\n sit0: 5 0 0 0 0 0 0 0 5 0\n ip6_vti0: 5 0 0 0 0 0 0 0 5 0\n p2p0: 5 0 0 0 0 0 0 0 5 0\n eth0: 0 0 0 0 0 0 0 0 0 0\n")
	write(t, root, "/proc/net/wireless", "Inter-| sta\n face | tus\n wlan0: 0000 60. -50. -256 0 0 0 0 0 0\n")
	write(t, root, "/proc/42/x", "")
	write(t, root, "/sys/class/thermal/thermal_zone0/temp", "45500\n")
	write(t, root, "/sys/class/thermal/thermal_zone0/type", "cpu\n")

	s := &Sampler{root: root}
	st := s.sample()
	if st.UptimeSec != 100.5 || st.Load[2] != 0.3 || st.MemTotalKB != 1000 || st.MemAvailKB != 400 || st.Procs != 1 {
		t.Fatalf("%+v", st)
	}
	if st.SwapTotalKB != 800 || st.SwapFreeKB != 700 {
		t.Fatalf("swap %+v", st)
	}
	if st.Flash == nil || st.Flash.Wear != "10-20%" || st.Flash.EOL != "Normal" {
		t.Fatalf("flash %+v", st.Flash)
	}
	if len(st.TempsC) != 1 || st.TempsC[0].C != 45.5 || st.TempsC[0].Name != "cpu" {
		t.Fatalf("temps %+v", st.TempsC)
	}
	if len(st.Net) != 1 || st.Net[0].Name != "wlan0" || st.Net[0].TxBytes != 500 {
		t.Fatalf("net %+v", st.Net)
	}
	if st.WiFi == nil || st.WiFi.Quality != 60 || st.WiFi.LevelDBm != -50 {
		t.Fatalf("wifi %+v", st.WiFi)
	}
	// second sample: rates and CPU
	write(t, root, "/proc/stat", "cpu 200 0 200 800 0 0 0 0\ncpu0 100 0 100 400 0 0 0 0\n")
	write(t, root, "/proc/net/dev", "wlan0: 3000 0 0 0 0 0 0 0 500 0\n")
	s.prev.at = s.prev.at.Add(-2 * time.Second)
	st = s.sample()
	if st.CPUPercent != 100 || len(st.CPUCores) != 1 {
		t.Fatalf("cpu %v %v", st.CPUPercent, st.CPUCores)
	}
	if r := st.Net[0].RxRate; r < 900 || r > 1001 {
		t.Fatalf("rx rate %v", r)
	}
}

func TestRealSystemNeverPanicsAndSnakeCase(t *testing.T) {
	s := NewSampler(time.Second)
	b, _ := json.Marshal(s.Snapshot())
	for _, k := range []string{`"uptime_sec"`, `"cpu_percent"`, `"mem_total_kb"`, `"temps"`, `"self"`, `"storage"`} {
		if !strings.Contains(string(b), k) {
			t.Errorf("missing %s in %s", k, b)
		}
	}
}
