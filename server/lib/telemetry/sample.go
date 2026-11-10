package telemetry

import (
	"bufio"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// rawSample holds cumulative counters needed for rate calculations.
type rawSample struct {
	at    time.Time
	cpu   [][2]uint64 // per line of /proc/stat: busy, total (index 0 = all)
	netRx map[string]uint64
	netTx map[string]uint64
}

func (s *Sampler) path(p string) string { return s.root + p }

func (s *Sampler) read(p string) string {
	b, _ := os.ReadFile(s.path(p))
	return string(b)
}

// sample is only called from one goroutine at a time (constructor, then Start).
func (s *Sampler) sample() Stats {
	now := time.Now()
	st := Stats{Time: now.UnixMilli(), CPUCores: []float64{}, TempsC: []Temp{}, Net: []NetIf{}, Storage: []Disk{}, Addresses: []string{}}
	raw := &rawSample{at: now, netRx: map[string]uint64{}, netTx: map[string]uint64{}}

	if f := strings.Fields(s.read("/proc/uptime")); len(f) > 0 {
		st.UptimeSec, _ = strconv.ParseFloat(f[0], 64)
	}
	if f := strings.Fields(s.read("/proc/loadavg")); len(f) >= 3 {
		for i := 0; i < 3; i++ {
			st.Load[i], _ = strconv.ParseFloat(f[i], 64)
		}
	}
	s.cpu(&st, raw)
	s.mem(&st)
	s.temps(&st)
	s.net(&st, raw)
	s.wifi(&st)
	s.storage(&st)
	s.flash(&st)
	s.addresses(&st)
	s.self(&st)
	if ents, err := os.ReadDir(s.path("/proc")); err == nil {
		for _, e := range ents {
			if _, err := strconv.Atoi(e.Name()); err == nil && e.IsDir() {
				st.Procs++
			}
		}
	}
	s.prev = raw
	return st
}

func (s *Sampler) cpu(st *Stats, raw *rawSample) {
	for _, line := range strings.Split(s.read("/proc/stat"), "\n") {
		if !strings.HasPrefix(line, "cpu") {
			continue
		}
		f := strings.Fields(line)
		var total, idle uint64
		for i, v := range f[1:] {
			n, _ := strconv.ParseUint(v, 10, 64)
			if i >= 8 { // guest times are already counted in user/nice
				break
			}
			total += n
			if i == 3 || i == 4 { // idle + iowait
				idle += n
			}
		}
		raw.cpu = append(raw.cpu, [2]uint64{total - idle, total})
	}
	if s.prev == nil {
		return
	}
	pct := func(a, b [2]uint64) float64 {
		if b[1] <= a[1] {
			return 0
		}
		return float64(b[0]-a[0]) / float64(b[1]-a[1]) * 100
	}
	for i := 0; i < len(raw.cpu) && i < len(s.prev.cpu); i++ {
		p := pct(s.prev.cpu[i], raw.cpu[i])
		if i == 0 {
			st.CPUPercent = p
		} else {
			st.CPUCores = append(st.CPUCores, p)
		}
	}
}

func (s *Sampler) mem(st *Stats) {
	var free, buf, cache uint64
	haveAvail := false
	for _, line := range strings.Split(s.read("/proc/meminfo"), "\n") {
		f := strings.Fields(line)
		if len(f) < 2 {
			continue
		}
		v, _ := strconv.ParseUint(f[1], 10, 64)
		switch f[0] {
		case "MemTotal:":
			st.MemTotalKB = v
		case "MemAvailable:":
			st.MemAvailKB, haveAvail = v, true
		case "SwapTotal:":
			st.SwapTotalKB = v
		case "SwapFree:":
			st.SwapFreeKB = v
		case "MemFree:":
			free = v
		case "Buffers:":
			buf = v
		case "Cached:":
			cache = v
		}
	}
	if !haveAvail { // old kernels
		st.MemAvailKB = free + buf + cache
	}
}

func (s *Sampler) temps(st *Stats) {
	zones, _ := filepath.Glob(s.path("/sys/class/thermal/thermal_zone*"))
	sort.Strings(zones)
	for _, z := range zones {
		b, err := os.ReadFile(filepath.Join(z, "temp"))
		if err != nil {
			continue
		}
		milli, err := strconv.ParseFloat(strings.TrimSpace(string(b)), 64)
		if err != nil {
			continue
		}
		name, _ := os.ReadFile(filepath.Join(z, "type"))
		n := strings.TrimSpace(string(name))
		if n == "" {
			n = filepath.Base(z)
		}
		st.TempsC = append(st.TempsC, Temp{Name: n, C: milli / 1000})
	}
}

// virtualIface reports whether name is loopback or a kernel virtual/tunnel
// device that only adds noise next to the real eth/wlan interfaces.
func virtualIface(name string) bool {
	if name == "lo" {
		return true
	}
	for _, p := range []string{"dummy", "sit", "ip6tnl", "ip6_vti", "ip_vti", "tunl", "gre", "gretap", "erspan", "p2p"} {
		if strings.HasPrefix(name, p) {
			return true
		}
	}
	return false
}

func (s *Sampler) net(st *Stats, raw *rawSample) {
	sc := bufio.NewScanner(strings.NewReader(s.read("/proc/net/dev")))
	for sc.Scan() {
		name, rest, ok := strings.Cut(sc.Text(), ":")
		name = strings.TrimSpace(name)
		if !ok || virtualIface(name) {
			continue
		}
		f := strings.Fields(rest)
		if len(f) < 9 {
			continue
		}
		rx, _ := strconv.ParseUint(f[0], 10, 64)
		tx, _ := strconv.ParseUint(f[8], 10, 64)
		if rx == 0 && tx == 0 {
			continue // down or unused interface
		}
		n := NetIf{Name: name, RxBytes: rx, TxBytes: tx}
		raw.netRx[name], raw.netTx[name] = rx, tx
		if s.prev != nil {
			if dt := raw.at.Sub(s.prev.at).Seconds(); dt > 0 {
				if p, ok := s.prev.netRx[name]; ok && rx >= p {
					n.RxRate = float64(rx-p) / dt
				}
				if p, ok := s.prev.netTx[name]; ok && tx >= p {
					n.TxRate = float64(tx-p) / dt
				}
			}
		}
		st.Net = append(st.Net, n)
	}
}

func (s *Sampler) wifi(st *Stats) {
	lines := strings.Split(s.read("/proc/net/wireless"), "\n")
	for _, line := range lines {
		name, rest, ok := strings.Cut(line, ":")
		if !ok {
			continue // header lines have no colon after the iface name
		}
		f := strings.Fields(rest)
		if len(f) < 3 {
			continue
		}
		q, _ := strconv.ParseFloat(strings.TrimSuffix(f[1], "."), 64)
		l, _ := strconv.ParseFloat(strings.TrimSuffix(f[2], "."), 64)
		if l > 0 { // some drivers report level as unsigned 256-N
			l -= 256
		}
		st.WiFi = &WiFi{Iface: strings.TrimSpace(name), Quality: q, LevelDBm: l}
		return
	}
}

func (s *Sampler) storage(st *Stats) {
	paths := []string{"/mtd_rwarea", "/tmp"}
	if runtime.GOOS != "linux" {
		paths = append(paths, "/")
	}
	for _, p := range paths {
		var fs syscall.Statfs_t
		if err := syscall.Statfs(s.path(p), &fs); err != nil {
			continue
		}
		// Field widths differ between darwin, arm and arm64.
		bs := uint64(fs.Bsize)
		st.Storage = append(st.Storage, Disk{Path: p, TotalB: uint64(fs.Blocks) * bs, FreeB: uint64(fs.Bavail) * bs})
	}
}

// flash reads the eMMC life-time registers (sysfs, hex bytes: 0x01 is
// 0-10% used, 0x0A is 90-100%, 0x0B is past the estimate). The worse of the
// two (type A and B) counts. Absent on a Mac or a TV without eMMC.
func (s *Sampler) flash(st *Stats) {
	dev := "/sys/block/mmcblk0/device/"
	life := strings.Fields(s.read(dev + "life_time"))
	worst := 0
	for _, f := range life {
		if v, err := strconv.ParseUint(strings.TrimPrefix(f, "0x"), 16, 8); err == nil && int(v) > worst && v <= 0x0B {
			worst = int(v)
		}
	}
	if worst == 0 {
		return
	}
	wear := strconv.Itoa((worst-1)*10) + "-" + strconv.Itoa(worst*10) + "%"
	if worst == 0x0B {
		wear = "exceeded 100%"
	}
	eol := ""
	switch strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(s.read(dev+"pre_eol_info")), "0x")) {
	case "01":
		eol = "Normal"
	case "02":
		eol = "Warning"
	case "03":
		eol = "Urgent"
	}
	st.Flash = &Flash{Wear: wear, EOL: eol}
}

// addresses lists the host name and the global unicast addresses of the
// interfaces that are up, IPv4 first.
func (s *Sampler) addresses(st *Stats) {
	if s.root != "" {
		return
	}
	st.Hostname, _ = os.Hostname()
	ifs, err := net.Interfaces()
	if err != nil {
		return
	}
	var v4, v6 []string
	for _, ifc := range ifs {
		if ifc.Flags&net.FlagUp == 0 || ifc.Flags&net.FlagLoopback != 0 || virtualIface(ifc.Name) {
			continue
		}
		addrs, _ := ifc.Addrs()
		for _, a := range addrs {
			ipn, ok := a.(*net.IPNet)
			if !ok || !ipn.IP.IsGlobalUnicast() {
				continue
			}
			if ip4 := ipn.IP.To4(); ip4 != nil {
				v4 = append(v4, ip4.String())
			} else {
				v6 = append(v6, ipn.IP.String())
			}
		}
	}
	st.Addresses = append(v4, v6...)
}

func (s *Sampler) self(st *Stats) {
	st.Process.Goroutines = runtime.NumGoroutine()
	for _, line := range strings.Split(s.read("/proc/self/status"), "\n") {
		if strings.HasPrefix(line, "VmRSS:") {
			if f := strings.Fields(line); len(f) >= 2 {
				st.Process.RSSKB, _ = strconv.ParseUint(f[1], 10, 64)
			}
		}
	}
}
