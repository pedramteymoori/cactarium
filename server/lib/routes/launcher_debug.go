package routes

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync"
)

// Debug channel for the PHI hook, off unless launcher.debug is true.
//
// POST /api/launcher/debug queues one JavaScript snippet; the hook polls
// GET /api/launcher/debug once a second, runs the snippet inside PHI's page and
// posts the result to /api/home/diag as "debug-result". Code that runs there
// can call any PHI RPC, so posting needs (a) a loopback client, i.e. a shell on
// the TV, and (b) the X-Debug-Secret header with the secret written to
// var/debug.secret (mode 600). A custom header forces a CORS preflight, which
// nothing answers, so a web page in the TV's browser cannot post.
type debugQueue struct {
	mu     sync.Mutex
	secret string
	seq    int
	js     string
}

func (s *Server) debugOn() bool { return s.store.Get().Launcher.Debug }

// debugSecret creates the secret file next to the config on first use.
func (s *Server) debugSecret() (string, error) {
	s.dbg.mu.Lock()
	defer s.dbg.mu.Unlock()
	if s.dbg.secret != "" {
		return s.dbg.secret, nil
	}
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	sec := hex.EncodeToString(b)
	dir := filepath.Join(filepath.Dir(s.store.Path()), "var")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	if err := os.WriteFile(filepath.Join(dir, "debug.secret"), []byte(sec+"\n"), 0o600); err != nil {
		return "", err
	}
	s.dbg.secret = sec
	return sec, nil
}

func (s *Server) handleDebugPost(w http.ResponseWriter, r *http.Request) {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if ip := net.ParseIP(host); err != nil || ip == nil || !ip.IsLoopback() || !s.debugOn() {
		http.NotFound(w, r)
		return
	}
	sec, err := s.debugSecret()
	if err != nil || subtle.ConstantTimeCompare([]byte(r.Header.Get("X-Debug-Secret")), []byte(sec)) != 1 {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	b, err := io.ReadAll(io.LimitReader(r.Body, 64<<10))
	if err != nil || len(b) == 0 {
		http.Error(w, "empty", http.StatusBadRequest)
		return
	}
	s.dbg.mu.Lock()
	s.dbg.seq++
	s.dbg.js = string(b)
	id := s.dbg.seq
	s.dbg.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{"id": id})
}

func (s *Server) handleDebugGet(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Cache-Control", "no-store")
	if !s.debugOn() {
		http.NotFound(w, r)
		return
	}
	if _, err := s.debugSecret(); err != nil { // make the secret file exist as soon as debug is on
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	s.dbg.mu.Lock()
	id, js := s.dbg.seq, s.dbg.js
	s.dbg.js = ""
	s.dbg.mu.Unlock()
	if js == "" {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": id, "js": js})
}
