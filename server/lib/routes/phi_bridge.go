package routes

import (
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// The PHI bridge: the dashboard asks for a PHI function (POST /api/tv/phi),
// the hook inside the TV's UI page long-polls GET /api/tv/phi/next, runs it and
// posts the outcome to POST /api/tv/phi/result. The native JSON-RPC socket
// refuses this server, so this is the only way to the TV's picture, sound and
// general settings. next and result take loopback clients only (the hook
// talks to localhost); the dashboard side takes the token and an allowlist
// (phi_allow.go).

const (
	phiAnswerWait = 5 * time.Second  // how long the dashboard request waits for the hook
	phiPollHold   = 25 * time.Second // how long a hook poll is held when there is no job
	rebootPhiWait = 3 * time.Second  // RpcRestartTV answer wait before rebooting directly
	rebootGrace   = 20 * time.Second // if the TV is still up after an accepted RpcRestartTV
)

type phiJob struct {
	ID     int             `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`

	res chan phiOutcome
}

type phiOutcome struct {
	OK     bool            `json:"ok"`
	Result json.RawMessage `json:"result"`
	Error  string          `json:"error"`
}

type phiBridge struct {
	mu      sync.Mutex
	seq     int
	queue   []*phiJob       // not yet handed to the hook
	out     map[int]*phiJob // handed out, waiting for a result
	wake    chan struct{}   // closed when a job is queued
	answer  time.Duration   // zero means phiAnswerWait; tests shorten these
	hold    time.Duration
	restart time.Duration
	grace   time.Duration
}

var errPhiTimeout = errors.New("the TV's UI page did not answer")

func dur(v, d time.Duration) time.Duration {
	if v > 0 {
		return v
	}
	return d
}

// call queues a job and waits for the hook's outcome.
func (b *phiBridge) call(method string, params json.RawMessage, wait time.Duration) (phiOutcome, error) {
	j := &phiJob{Method: method, Params: params, res: make(chan phiOutcome, 1)}
	b.mu.Lock()
	b.seq++
	j.ID = b.seq
	if b.out == nil {
		b.out = map[int]*phiJob{}
	}
	b.queue = append(b.queue, j)
	if b.wake != nil {
		close(b.wake)
		b.wake = nil
	}
	b.mu.Unlock()

	t := time.NewTimer(wait)
	defer t.Stop()
	select {
	case o := <-j.res:
		return o, nil
	case <-t.C:
		b.mu.Lock()
		for i, q := range b.queue {
			if q == j {
				b.queue = append(b.queue[:i], b.queue[i+1:]...)
				break
			}
		}
		delete(b.out, j.ID)
		b.mu.Unlock()
		return phiOutcome{}, errPhiTimeout
	}
}

// next returns the oldest queued job, waiting up to hold for one.
func (b *phiBridge) next(done <-chan struct{}, hold time.Duration) *phiJob {
	t := time.NewTimer(hold)
	defer t.Stop()
	for {
		b.mu.Lock()
		if len(b.queue) > 0 {
			j := b.queue[0]
			b.queue = b.queue[1:]
			b.out[j.ID] = j
			b.mu.Unlock()
			return j
		}
		if b.wake == nil {
			b.wake = make(chan struct{})
		}
		w := b.wake
		b.mu.Unlock()
		select {
		case <-w:
		case <-t.C:
			return nil
		case <-done:
			return nil
		}
	}
}

// finish routes a result to the request that waits for it; false if none does
// (it timed out already, or the id is unknown).
func (b *phiBridge) finish(id int, o phiOutcome) bool {
	b.mu.Lock()
	j := b.out[id]
	delete(b.out, id)
	b.mu.Unlock()
	if j == nil {
		return false
	}
	j.res <- o
	return true
}

func loopbackOnly(w http.ResponseWriter, r *http.Request) bool {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if ip := net.ParseIP(host); err != nil || ip == nil || !ip.IsLoopback() {
		writeErr(w, http.StatusForbidden, "only from the TV itself")
		return false
	}
	return true
}

// POST /api/tv/phi {"method":"RpcX","params":{...}}
func (s *Server) handlePhiCall(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Method string          `json:"method"`
		Params json.RawMessage `json:"params"`
	}
	if !decode(w, r, &req) {
		return
	}
	if !phiAllowed[req.Method] {
		writeErr(w, http.StatusBadRequest, "method not allowed")
		return
	}
	o, err := s.phi.call(req.Method, req.Params, dur(s.phi.answer, phiAnswerWait))
	if err != nil {
		writeErr(w, http.StatusGatewayTimeout, err.Error())
		return
	}
	if !o.OK {
		writeErr(w, http.StatusBadGateway, o.Error)
		return
	}
	res := o.Result
	if len(res) == 0 {
		res = json.RawMessage("null")
	}
	writeJSON(w, http.StatusOK, map[string]any{"result": res})
}

// GET /api/tv/phi/next: the hook's long poll.
func (s *Server) handlePhiNext(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*") // the hook runs from a file:// page
	w.Header().Set("Cache-Control", "no-store")
	if !loopbackOnly(w, r) {
		return
	}
	j := s.phi.next(r.Context().Done(), dur(s.phi.hold, phiPollHold))
	if j == nil {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	p := j.Params
	if len(p) == 0 {
		p = json.RawMessage("null")
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": j.ID, "method": j.Method, "params": p})
}

// POST /api/tv/phi/result: text/plain {"id":n,"ok":bool,"result"|"error"}.
func (s *Server) handlePhiResult(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	if !loopbackOnly(w, r) {
		return
	}
	b, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	var m struct {
		ID int `json:"id"`
		phiOutcome
	}
	if err != nil || json.Unmarshal(b, &m) != nil || m.ID == 0 {
		writeErr(w, http.StatusBadRequest, "bad result")
		return
	}
	s.phi.finish(m.ID, m.phiOutcome)
	w.WriteHeader(http.StatusNoContent)
}

// POST /api/tv/reboot: the TV's own restart through PHI, else a direct reboot.
func (s *Server) handleTVReboot(w http.ResponseWriter, r *http.Request) {
	reboot := s.reboot
	if reboot == nil {
		reboot = defaultReboot
	}
	o, err := s.phi.call("RpcRestartTV", nil, dur(s.phi.restart, rebootPhiWait))
	via := "phi"
	if err != nil || !o.OK {
		via = "reboot"
		log.Printf("restart requested by the dashboard: PHI did not take it, rebooting directly")
		writeJSON(w, http.StatusAccepted, map[string]any{"restarting": true, "via": via})
		go func() {
			time.Sleep(time.Second) // let the response and the log line out first
			if err := reboot(); err != nil {
				log.Printf("restart failed: %v", err)
			}
		}()
		return
	}
	log.Printf("restart requested by the dashboard through PHI")
	writeJSON(w, http.StatusAccepted, map[string]any{"restarting": true, "via": via})
	go func() {
		time.Sleep(dur(s.phi.grace, rebootGrace))
		log.Printf("TV still up after RpcRestartTV, rebooting directly")
		if err := reboot(); err != nil {
			log.Printf("restart failed: %v", err)
		}
	}()
}

// A plain "reboot" only signals init, and BusyBox init on TPN256E never
// handles it: /etc/init.d/rcS does not return, so init never leaves sysinit
// (SIGTERM stays pending on PID 1, seen on the TV). "-f" calls reboot(2)
// directly. That skips rcK, so flush first; it is still gentler than pulling
// the plug, which is what it replaces. The dashboard tries the TV's own
// RpcRestartTV through the hook before it comes here.
func defaultReboot() error {
	_ = exec.Command("/bin/sync").Run()
	time.Sleep(500 * time.Millisecond)
	_ = exec.Command("/bin/sync").Run()
	return exec.Command("/sbin/reboot", "-f").Run()
}

// GET /api/titan/catalog: the cached TitanOS catalog, for picking launcher.apps.
func (s *Server) handleTitanCatalog(w http.ResponseWriter, r *http.Request) {
	type entry struct {
		Code    string `json:"code"`
		Name    string `json:"name"`
		Icon    string `json:"icon"`
		AppType string `json:"app_type"`
	}
	out := []entry{}
	if s.catalog != nil {
		for _, a := range s.catalog.All() {
			if a.Code == "" || !appCodeRE.MatchString(a.Code) {
				continue
			}
			out = append(out, entry{a.Code, a.Name, "/launcher/titan-icon?code=" + url.QueryEscape(a.Code), a.AppType})
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name) })
	writeJSON(w, http.StatusOK, out)
}

// removeLegacyRecent deletes the launcher's old "recent" file, written by
// versions before the feature was removed.
func (s *Server) removeLegacyRecent() {
	_ = os.Remove(filepath.Join(filepath.Dir(s.store.Path()), "launcher-recent.json"))
}
