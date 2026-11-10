package routes

import (
	"net/http"

	"cactarium/server/assets"
)

// The Home-button hook (server/assets/phi-hook.js) runs inside the TV's own native UI,
// a file:// page with no token, so everything here is unauthenticated and
// read-only: two static files and one boolean.

// serveEmbedded writes one embedded file with an explicit content type. The
// hook must always be fetched fresh so an update never needs a power cycle.
func serveEmbedded(name, ctype string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		b, err := assets.FS.ReadFile(name)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", ctype)
		w.Header().Set("Cache-Control", "no-store") // the TV browser reused a cached phi-hook.js under no-cache
		_, _ = w.Write(b)
	}
}

// handleLauncherEnabled is the hook's kill switch. The PHI page's origin is
// "null" (file://), so the response needs a wildcard CORS header to be
// readable. If this endpoint fails, the hook keeps stock behaviour.
func (s *Server) handleLauncherEnabled(w http.ResponseWriter, r *http.Request) {
	l := s.store.Get().Launcher
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{"enabled": l.On(), "layer": l.Layer, "debug": l.Debug})
}
