package routes

import (
	"encoding/json"
	"log"
	"net/http"
	"sync"
	"time"
)

// The hook's diagnostics run in the TV's own browser, which has no token, so
// the POST endpoint is unauthenticated. It keeps the last diagRingSize
// reports in memory.
const diagRingSize = 200

type diagEntry struct {
	Time   time.Time       `json:"time"`
	Remote string          `json:"remote"`
	Report json.RawMessage `json:"report"`
}

type diagRing struct {
	mu      sync.Mutex
	entries []diagEntry
}

func (d *diagRing) add(e diagEntry) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if len(d.entries) >= diagRingSize {
		d.entries = append(d.entries[:0], d.entries[1:]...)
	}
	d.entries = append(d.entries, e)
}

func (d *diagRing) snapshot() []diagEntry {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]diagEntry{}, d.entries...)
}

func (s *Server) handleHomeDiagPost(w http.ResponseWriter, r *http.Request) {
	var raw json.RawMessage
	if !decode(w, r, &raw) {
		return
	}
	if !json.Valid(raw) {
		writeErr(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	s.diag.add(diagEntry{Time: time.Now().UTC(), Remote: r.RemoteAddr, Report: raw})
	log.Printf("home-diag: %s", raw)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleHomeDiagGet(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.diag.snapshot())
}
