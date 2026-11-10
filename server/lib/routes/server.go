// Package server serves the dashboard and the JSON API, and keeps a cache of
// the TV's state. It deliberately knows nothing about MQTT or Home Assistant;
// main adapts the exported command methods to the HA bridge.
package routes

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"sync"
	"time"

	"cactarium/server/assets"
	"cactarium/server/lib/config"
	"cactarium/server/lib/jointspace"
	"cactarium/server/lib/telemetry"
	"cactarium/server/lib/titancat"
)

// Options configures New. Store and JS are required.
type Options struct {
	Store   *config.Store
	JS      *jointspace.Client
	Sampler *telemetry.Sampler
	Version string
	// Listen overrides config.listen when non-empty (the -listen flag).
	Listen string
	// MQTTStatus reports the HA bridge status for /api/state.
	MQTTStatus func() (enabled, connected bool, err string)
	// OnSettingsChanged is called after POST /api/settings saved the config.
	OnSettingsChanged func()
	// OnCommand is called after every TV command (HTTP or HA), so main can
	// republish the HA state.
	OnCommand func()
	// NetSync applies launcher.block_titanos (netblock.Sync).
	NetSync func(on bool) error
	// Catalog is the TitanOS app catalog behind /api/launcher/apps; may be nil.
	Catalog *titancat.Catalog
}

type Server struct {
	store      *config.Store
	js         *jointspace.Client
	sampler    *telemetry.Sampler
	version    string
	listen     string
	mqttStatus func() (bool, bool, string)
	onSettings func()
	onCommand  func()

	cache   cache
	pollMu  sync.Mutex
	refresh chan struct{}

	mu      sync.Mutex // guards pending and ambilight static caches
	pending *pendingPair
	styles  map[string]any
	topo    map[string]any

	diag diagRing

	// launcher extras (launcher_*.go); the zero values are production defaults
	phi        phiBridge
	phiInfo    phiInfoCache
	wx         weatherCache
	weatherURL string
	now        func() time.Time
	iconRoots  []string
	iconBases  []string
	reboot     func() error
	dbg        debugQueue
	netSync    func(on bool) error // applies launcher.block_titanos; nil in tests
	catalog    *titancat.Catalog
	wall       wallState
	wallBase   string                                                      // overrides the wallpaper sets' URL; tests only
	wallSets   map[string]wallSet                                          // overrides the pinned sets; tests only
	wallClient *http.Client                                                // nil = http.DefaultClient
	iconGet    func(ctx context.Context, u string) ([]byte, string, error) // titan-icon download; nil = HTTPS
}

func New(o Options) *Server {
	return &Server{
		store: o.Store, js: o.JS, sampler: o.Sampler, version: o.Version,
		listen: o.Listen, mqttStatus: o.MQTTStatus, onSettings: o.OnSettingsChanged, onCommand: o.OnCommand,
		refresh: make(chan struct{}, 1), netSync: o.NetSync, catalog: o.Catalog,
	}
}

// Handler returns the full HTTP handler (static files + API).
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.Handle("GET /", noCache(http.FileServerFS(assets.FS)))
	// The dashboard (server/assets/ui.html, its CSS and scripts under /ui/) is served at "/".
	mux.Handle("GET /{$}", noCache(serveEmbedded("ui.html", "text/html; charset=utf-8")))

	mux.HandleFunc("POST /api/home/diag", s.handleHomeDiagPost)

	// Home-button hook and launcher page: no token (see launcher.go). The
	// launcher's assets (/launcher/*) come from the static handler above.
	mux.HandleFunc("GET /phi-hook.js", serveEmbedded("phi-hook.js", "application/javascript; charset=utf-8"))
	mux.HandleFunc("GET /launcher", serveEmbedded("launcher/index.html", "text/html; charset=utf-8"))
	// The TV app behind the launcher's Cactarium tile: the page carries the access
	// token, so it is served to the TV itself only (tvapp.go).
	mux.HandleFunc("GET /tvapp", s.handleTVAppPage)
	mux.HandleFunc("GET /api/tvapp", s.handleTVApp)
	mux.HandleFunc("GET /api/launcher/enabled", s.handleLauncherEnabled)
	mux.HandleFunc("GET /launcher/icon", s.handleLauncherIcon)
	mux.HandleFunc("GET /api/launcher/apps", s.handleLauncherApps)
	mux.HandleFunc("GET /launcher/titan-icon", s.handleTitanIcon)
	mux.HandleFunc("GET /api/launcher/weather", s.handleWeather)
	mux.HandleFunc("GET /api/launcher/background", s.handleLauncherBackground)
	mux.HandleFunc("GET /launcher/wallpaper", s.handleLauncherWallpaper)
	// The hook's side of the PHI bridge: loopback only (see phi_bridge.go).
	mux.HandleFunc("GET /api/tv/phi/next", s.handlePhiNext)
	mux.HandleFunc("POST /api/tv/phi/result", s.handlePhiResult)
	mux.HandleFunc("GET /api/launcher/debug", s.handleDebugGet)
	mux.HandleFunc("POST /api/launcher/debug", s.handleDebugPost)

	api := func(pattern string, h http.HandlerFunc) {
		mux.Handle(pattern, s.authed(h))
	}
	api("GET /api/state", s.handleState)
	api("GET /api/stats", func(w http.ResponseWriter, r *http.Request) {
		var st telemetry.Stats
		if s.sampler != nil {
			st = s.sampler.Snapshot()
		}
		writeJSON(w, 200, st)
	})
	api("GET /api/processes", s.handleProcesses)
	api("GET /api/cpu", s.handleCPUProcesses)
	api("POST /api/key", s.handleKey)
	api("POST /api/volume", s.handleVolume)
	api("POST /api/power", s.handlePower)
	api("GET /api/ambilight", s.handleAmbilight)
	api("GET /api/ambilight/live", s.handleAmbilightLive)
	api("POST /api/ambilight", s.handleAmbilightSet)
	api("POST /api/pair/start", s.handlePairStart)
	api("POST /api/pair/finish", s.handlePairFinish)
	api("POST /api/pair/forget", s.handlePairForget)
	api("GET /api/settings", s.handleSettingsGet)
	api("POST /api/settings", s.handleSettingsSet)
	api("GET /api/home/diag", s.handleHomeDiagGet)
	api("POST /api/tv/phi", s.handlePhiCall)
	api("POST /api/tv/reboot", s.handleTVReboot)
	api("GET /api/titan/catalog", s.handleTitanCatalog)
	api("GET /api/launcher/wallpapers", s.handleWallpapersGet)
	api("POST /api/launcher/wallpapers/upload", s.handleWallpaperUpload)
	api("POST /api/launcher/wallpapers/remove", s.handleWallpaperRemove)
	api("POST /api/launcher/wallpapers/set", s.handleWallpaperSet)
	return mux
}

// Run starts the TV poller and serves HTTP until ctx is cancelled.
func (s *Server) Run(ctx context.Context) error {
	addr := s.listen
	if addr == "" {
		addr = s.store.Get().Listen
	}
	hs := &http.Server{Addr: addr, Handler: s.Handler(), ReadHeaderTimeout: 10 * time.Second}
	s.removeLegacyRecent()
	go s.pollLoop(ctx)
	go s.phiInfoLoop(ctx)
	errc := make(chan error, 1)
	go func() { errc <- hs.ListenAndServe() }()
	select {
	case err := <-errc:
		return err
	case <-ctx.Done():
		sctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = hs.Shutdown(sctx)
		return nil
	}
}

func noCache(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		h.ServeHTTP(w, r)
	})
}

// authed enforces config.token on API routes. Hashing first makes the
// constant-time compare independent of the token length.
func (s *Server) authed(h http.HandlerFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if tok := s.store.Get().Token; tok != "" {
			got := r.Header.Get("X-Cactarium-Token")
			if got == "" {
				got = r.URL.Query().Get("token")
			}
			a, b := sha256.Sum256([]byte(got)), sha256.Sum256([]byte(tok))
			if subtle.ConstantTimeCompare(a[:], b[:]) != 1 {
				writeErr(w, http.StatusUnauthorized, "invalid or missing token")
				return
			}
		}
		h(w, r)
	})
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}

// fail maps an error to a status: validation 400, unpaired 409, else 502.
func fail(w http.ResponseWriter, err error) {
	var br badRequest
	switch {
	case errors.As(err, &br):
		writeErr(w, http.StatusBadRequest, err.Error())
	case errors.Is(err, errNotPaired):
		writeErr(w, http.StatusConflict, err.Error())
	default:
		writeErr(w, http.StatusBadGateway, err.Error())
	}
}

// decode reads a small JSON body; an empty body leaves v untouched.
func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	if err := json.NewDecoder(r.Body).Decode(v); err != nil && !errors.Is(err, io.EOF) {
		writeErr(w, http.StatusBadRequest, "invalid JSON body")
		return false
	}
	return true
}
