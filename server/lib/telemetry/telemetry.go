// Package telemetry samples hardware stats from /proc and /sys. Everything is
// best-effort: missing files leave zero values, so it also runs on macOS.
package telemetry

import (
	"context"
	"sync"
	"time"
)

type Stats struct {
	Time        int64      `json:"time"` // unix ms
	UptimeSec   float64    `json:"uptime_sec"`
	Load        [3]float64 `json:"load"`
	CPUPercent  float64    `json:"cpu_percent"`
	CPUCores    []float64  `json:"cpu_cores"`
	MemTotalKB  uint64     `json:"mem_total_kb"`
	MemAvailKB  uint64     `json:"mem_avail_kb"`
	SwapTotalKB uint64     `json:"swap_total_kb"`
	SwapFreeKB  uint64     `json:"swap_free_kb"`
	TempsC      []Temp     `json:"temps"`
	Net         []NetIf    `json:"net"`
	WiFi        *WiFi      `json:"wifi,omitempty"`
	Storage     []Disk     `json:"storage"`
	Flash       *Flash     `json:"flash,omitempty"`
	Hostname    string     `json:"hostname,omitempty"`
	Addresses   []string   `json:"addresses"`
	Procs       int        `json:"procs"`
	Process     Self       `json:"self"`
}

type Temp struct {
	Name string  `json:"name"`
	C    float64 `json:"c"`
}

type NetIf struct {
	Name    string  `json:"name"`
	RxBytes uint64  `json:"rx_bytes"`
	TxBytes uint64  `json:"tx_bytes"`
	RxRate  float64 `json:"rx_rate"`
	TxRate  float64 `json:"tx_rate"`
}

type WiFi struct {
	Iface    string  `json:"iface"`
	Quality  float64 `json:"quality"`
	LevelDBm float64 `json:"level_dbm"`
}

// Flash is the eMMC's own wear estimate: Wear is the band the JEDEC life-time
// register reports ("0-10%"), EOL its pre-end-of-life register
// ("Normal", "Warning", "Urgent").
type Flash struct {
	Wear string `json:"wear"`
	EOL  string `json:"eol"`
}

type Disk struct {
	Path   string `json:"path"`
	TotalB uint64 `json:"total_b"`
	FreeB  uint64 `json:"free_b"`
}

type Self struct {
	RSSKB      uint64 `json:"rss_kb"`
	Goroutines int    `json:"goroutines"`
}

// Sampler keeps the latest Stats; Snapshot is cheap and never blocks on I/O.
type Sampler struct {
	interval time.Duration
	root     string // filesystem root, "" for real; overridden in tests

	mu   sync.RWMutex
	cur  Stats
	prev *rawSample
}

// NewSampler returns a sampler; interval <= 0 means 2 s.
func NewSampler(interval time.Duration) *Sampler {
	if interval <= 0 {
		interval = 2 * time.Second
	}
	s := &Sampler{interval: interval}
	s.cur = s.sample()
	return s
}

// Start samples every interval until ctx is done.
func (s *Sampler) Start(ctx context.Context) {
	t := time.NewTicker(s.interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			st := s.sample()
			s.mu.Lock()
			s.cur = st
			s.mu.Unlock()
		}
	}
}

// Snapshot returns the last sample.
func (s *Sampler) Snapshot() Stats {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.cur
}
