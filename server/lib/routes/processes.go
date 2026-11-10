package routes

import (
	"net/http"
	"runtime"
	"time"

	"cactarium/server/lib/telemetry"
)

// The Metrics tab's two expandable lists. Both read /proc for every process, so
// the dashboard asks only while the list is open.

const cpuSampleFor = time.Second

// GET /api/processes: the biggest processes by resident memory.
func (s *Server) handleProcesses(w http.ResponseWriter, r *http.Request) {
	if runtime.GOOS != "linux" {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "only on the TV"})
		return
	}
	top, count, mb := telemetry.TopByMemory(12)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "count": count, "total_mb": mb, "top": top})
}

// GET /api/cpu: the busiest processes over a one-second sample.
func (s *Server) handleCPUProcesses(w http.ResponseWriter, r *http.Request) {
	if runtime.GOOS != "linux" {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "only on the TV"})
		return
	}
	top, busy := telemetry.TopByCPU(cpuSampleFor, 8)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "busy": busy, "top": top})
}
