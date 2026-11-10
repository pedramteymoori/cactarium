package telemetry

import (
	"os"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Proc is one process in a top list. MB is resident memory, Pct the share of
// one core used over a sample (100 = one full core).
type Proc struct {
	PID  int     `json:"pid"`
	Name string  `json:"name"`
	MB   float64 `json:"mb,omitempty"`
	Pct  float64 `json:"pct,omitempty"`
}

// TopByMemory returns the n largest processes by resident memory, with the
// count and the total resident MB. It reads /proc/<pid>/status for each, so
// it runs on request, never on the sampling tick.
func TopByMemory(n int) (top []Proc, count int, totalMB float64) {
	ents, _ := os.ReadDir("/proc")
	var kbTotal float64
	for _, e := range ents {
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		name, rss := "", 0.0
		for _, line := range strings.Split(readFile("/proc/"+e.Name()+"/status"), "\n") {
			if v, ok := strings.CutPrefix(line, "Name:"); ok {
				name = strings.TrimSpace(v)
			} else if v, ok := strings.CutPrefix(line, "VmRSS:"); ok {
				f := strings.Fields(v)
				if len(f) > 0 {
					rss, _ = strconv.ParseFloat(f[0], 64)
				}
			}
		}
		if name == "" {
			continue // exited while being read
		}
		count++
		if rss > 0 { // kernel threads have no VmRSS
			kbTotal += rss
			top = append(top, Proc{PID: pid, Name: name, MB: rss / 1024})
		}
	}
	sort.Slice(top, func(i, j int) bool { return top[i].MB > top[j].MB })
	if len(top) > n {
		top = top[:n]
	}
	return top, count, kbTotal / 1024
}

// TopByCPU samples every process's utime+stime twice, d apart, and returns the
// n busiest, with the whole machine's busy percentage over the same window.
func TopByCPU(d time.Duration, n int) (top []Proc, busy float64) {
	ticks := func() (map[int]procTicks, uint64, uint64) {
		out := map[int]procTicks{}
		ents, _ := os.ReadDir("/proc")
		for _, e := range ents {
			pid, err := strconv.Atoi(e.Name())
			if err != nil {
				continue
			}
			// The name sits in parentheses and may contain spaces, so split after the last ")".
			st := readFile("/proc/" + e.Name() + "/stat")
			l, r := strings.IndexByte(st, '('), strings.LastIndexByte(st, ')')
			if l < 0 || r < l {
				continue
			}
			f := strings.Fields(st[r+1:])
			if len(f) < 13 { // utime and stime are fields 14 and 15 of the whole line
				continue
			}
			u, _ := strconv.ParseUint(f[11], 10, 64)
			sy, _ := strconv.ParseUint(f[12], 10, 64)
			out[pid] = procTicks{name: st[l+1 : r], ticks: u + sy}
		}
		var busyT, totalT uint64
		if f := strings.Fields(firstLine(readFile("/proc/stat"))); len(f) > 4 {
			for i, v := range f[1:] {
				x, _ := strconv.ParseUint(v, 10, 64)
				if i >= 8 {
					break
				}
				totalT += x
				if i != 3 && i != 4 {
					busyT += x
				}
			}
		}
		return out, busyT, totalT
	}
	a, ab, at := ticks()
	time.Sleep(d)
	b, bb, bt := ticks()
	if bt > at {
		busy = float64(bb-ab) / float64(bt-at) * 100
	}
	// A core is one /proc/stat total divided by the core count of ticks, so
	// per-process use as a share of one core is its ticks over the wall-clock
	// ticks (100 per second).
	wall := d.Seconds() * 100
	for pid, nb := range b {
		na, ok := a[pid]
		if !ok || nb.ticks <= na.ticks || wall <= 0 {
			continue
		}
		top = append(top, Proc{PID: pid, Name: nb.name, Pct: float64(nb.ticks-na.ticks) / wall * 100})
	}
	sort.Slice(top, func(i, j int) bool { return top[i].Pct > top[j].Pct })
	if len(top) > n {
		top = top[:n]
	}
	return top, busy
}

type procTicks struct {
	name  string
	ticks uint64
}

func readFile(p string) string {
	b, _ := os.ReadFile(p)
	return string(b)
}

func firstLine(s string) string {
	l, _, _ := strings.Cut(s, "\n")
	return l
}
