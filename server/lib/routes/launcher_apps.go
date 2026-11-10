package routes

import (
	"context"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"cactarium/server/lib/titancat"
)

// The launcher's Apps row: launcher.apps lists TitanOS catalog codes in order
// (plus "tv" for the TV input tile); the catalog (server/lib/titancat) supplies
// name, launch URL and icon. Unauthenticated and read-only like the other
// /api/launcher/* routes.

// appCodeRE is what a catalog code may look like; also guards the icon cache path.
var appCodeRE = regexp.MustCompile(`^[a-z0-9._+-]{1,64}$`)

const maxLauncherApps = 100

type launcherApp struct {
	Code       string `json:"code"`
	Name       string `json:"name"`
	URL        string `json:"url,omitempty"`
	AppType    string `json:"app_type,omitempty"`
	Resolution string `json:"resolution,omitempty"`
	Icon       string `json:"icon,omitempty"`
}

// catalogQuery is the configured catalog query.
func (s *Server) catalogQuery() titancat.Query {
	k := s.store.Get().Launcher.Catalog
	return titancat.Query{Market: k.Market, Locale: k.Locale, Model: k.Model, Firmware: k.Firmware}
}

// GET /api/launcher/apps -> {"apps":[...],"missing":[codes]}
func (s *Server) handleLauncherApps(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Cache-Control", "no-store")
	codes := s.store.Get().Launcher.Apps
	apps := []launcherApp{}
	if len(codes) == 0 {
		writeJSON(w, http.StatusOK, map[string]any{"apps": apps})
		return
	}
	missing := []string{}
	for _, code := range codes {
		if code == "tv" {
			apps = append(apps, launcherApp{Code: "tv", Name: "TV"})
			continue
		}
		var a titancat.App
		ok := false
		if s.catalog != nil && appCodeRE.MatchString(code) {
			a, ok = s.catalog.Lookup(code)
		}
		if !ok {
			missing = append(missing, code)
			continue
		}
		apps = append(apps, launcherApp{Code: code, Name: a.Name, URL: a.URL, AppType: a.AppType, Resolution: a.Resolution,
			Icon: "/launcher/titan-icon?code=" + url.QueryEscape(code)})
	}
	writeJSON(w, http.StatusOK, map[string]any{"apps": apps, "missing": missing})
}

// titanIconURL maps a catalog icon URL to the resized one, and only for an
// https titanos.tv host so the endpoint cannot be pointed at anything else.
func titanIconURL(icon string) (string, bool) {
	u, err := url.Parse(icon)
	if err != nil || u.Scheme != "https" || !(u.Hostname() == "titanos.tv" || strings.HasSuffix(u.Hostname(), ".titanos.tv")) {
		return "", false
	}
	if !strings.Contains(u.Path, "/img/") {
		return "", false
	}
	u.Path = strings.Replace(u.Path, "/img/", "/img/width/164/height/164/quality/85/", 1)
	return u.String(), true
}

func (s *Server) iconDir() string {
	return filepath.Join(filepath.Dir(s.store.Path()), "var", "titan-icons")
}

func downloadIcon(ctx context.Context, u string) ([]byte, string, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "GET", u, nil)
	if err != nil {
		return nil, "", err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, "", fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, maxIconBytes+1))
	if err != nil {
		return nil, "", err
	}
	if len(b) > maxIconBytes {
		return nil, "", fmt.Errorf("icon too large")
	}
	ct := resp.Header.Get("Content-Type")
	if !strings.HasPrefix(ct, "image/") || strings.Contains(ct, "svg") {
		return nil, "", fmt.Errorf("not a bitmap image (%q)", ct)
	}
	return b, ct, nil
}

// GET /launcher/titan-icon?code=X: the catalog icon for code, cached on disk
// as var/titan-icons/<code>.webp (the resize endpoint answers image/webp).
func (s *Server) handleTitanIcon(w http.ResponseWriter, r *http.Request) {
	code := r.URL.Query().Get("code")
	if !appCodeRE.MatchString(code) || s.catalog == nil {
		http.NotFound(w, r)
		return
	}
	a, ok := s.catalog.Lookup(code)
	if !ok {
		http.NotFound(w, r)
		return
	}
	file := filepath.Join(s.iconDir(), code+".webp")
	b, err := os.ReadFile(file)
	ct := http.DetectContentType(b)
	if err != nil {
		src, ok := titanIconURL(a.Icon)
		if !ok {
			http.NotFound(w, r)
			return
		}
		get := s.iconGet
		if get == nil {
			get = downloadIcon
		}
		b, ct, err = get(r.Context(), src)
		if err != nil {
			log.Printf("titan-icon %s: %v", code, err)
			http.NotFound(w, r)
			return
		}
		if os.MkdirAll(s.iconDir(), 0o700) == nil {
			_ = os.WriteFile(file, b, 0o600)
		}
	}
	h := w.Header()
	h.Set("Content-Type", ct)
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Cache-Control", "public, max-age=86400")
	_, _ = w.Write(b)
}
