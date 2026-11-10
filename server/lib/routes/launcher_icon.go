package routes

import (
	"fmt"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

// GET /launcher/icon?src=<path-or-file-url>: read-only image files from the
// TV filesystem for the launcher iframe (an http page cannot load file://).
//
// What PHI does with RpcSystemAllAppGet's appIconURI (pages/main/launcher.js
// convertAppIcon, line 1020): http(s) is used as is, a leading "/" is a path
// on the page's own file:// origin (so an absolute filesystem path), and
// anything else is a bundled asset name resolved through a webpack context to
// "assets/launcher/images/<name>" next to PHI's index.html. This endpoint
// reproduces those three cases, but only inside an allowlist of roots.

// defaultIconRoots are the directories icons may be served from.
var defaultIconRoots = []string{
	"/mtd_apexe/board/mframework/webui/PHI/page/",
	"/swdl/UI/page/",
	"/usr/opera/browser_dir/",
	"/usr/opera/browser_home/",
	"/mtd_apexe/board/com.tpv.opera/",
	"/mtd_rwarea/browser/",
	"/mnt/browser/",
	// RpcSystemAllAppGet gives appIconURI as /mtd_apdat/IHS/HomeMenu/current/
	// app/icon/<id>.svg|png; /mtd_apdat is a symlink to /mtd_rwarea/apdat.
	// Only the IHS tree: the rest of apdat holds our config and credentials.
	"/mtd_rwarea/apdat/IHS/",
}

// iconRelDirs are searched, in order, for an icon given as a bare file name
// or relative path. Each is relative to an allowed root's "base" below.
var iconRelBases = []string{
	"/mtd_apexe/board/mframework/webui/PHI/page/",
	"/mtd_apexe/board/mframework/webui/PHI/page/assets/launcher/images/",
	"/swdl/UI/page/",
	"/swdl/UI/page/assets/launcher/images/",
	"/mnt/browser/offlinepage/app/icons/",
	"/mtd_apexe/board/com.tpv.opera/browser_home/offlinepage/app/icons/",
	"/usr/opera/browser_home/offlinepage/app/icons/",
}

var iconTypes = map[string]string{
	".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
	".webp": "image/webp", ".svg": "image/svg+xml", ".gif": "image/gif",
}

const maxIconBytes = 4 << 20

// resolveIcon maps a client supplied src to a real file inside roots, or
// returns an error. roots and bases are injectable for tests.
func resolveIcon(src string, roots, bases []string) (string, error) {
	if src == "" || len(src) > 1024 || strings.ContainsRune(src, 0) {
		return "", fmt.Errorf("bad src")
	}
	// PHI appends "?tag=<random>" to absolute paths; drop any query.
	if i := strings.IndexByte(src, '?'); i >= 0 {
		src = src[:i]
	}
	if strings.HasPrefix(strings.ToLower(src), "file://") {
		u, err := url.Parse(src)
		if err != nil {
			return "", fmt.Errorf("bad src")
		}
		src = u.Path
	} else if strings.Contains(src, "://") {
		return "", fmt.Errorf("unsupported scheme")
	}
	src = strings.ReplaceAll(src, "\\", "/")
	for _, seg := range strings.Split(src, "/") {
		if seg == ".." {
			return "", fmt.Errorf("path traversal")
		}
	}
	if _, ok := iconTypes[strings.ToLower(filepath.Ext(src))]; !ok {
		return "", fmt.Errorf("not an image")
	}
	var cands []string
	if strings.HasPrefix(src, "/") {
		cands = []string{filepath.Clean(src)}
	} else {
		rel := filepath.Clean(src)
		for _, b := range bases {
			cands = append(cands, filepath.Join(b, rel))
		}
	}
	var realRoots []string
	for _, r := range roots {
		if rr, err := filepath.EvalSymlinks(r); err == nil {
			realRoots = append(realRoots, rr)
		}
	}
	for _, c := range cands {
		real, err := filepath.EvalSymlinks(c)
		if err != nil {
			continue
		}
		fi, err := os.Stat(real)
		if err != nil || !fi.Mode().IsRegular() || fi.Size() > maxIconBytes {
			continue
		}
		if _, ok := iconTypes[strings.ToLower(filepath.Ext(real))]; !ok {
			continue // a symlink may not smuggle in another file type
		}
		for _, rr := range realRoots {
			if real == rr || strings.HasPrefix(real, strings.TrimSuffix(rr, string(filepath.Separator))+string(filepath.Separator)) {
				return real, nil
			}
		}
	}
	return "", os.ErrNotExist
}

func (s *Server) handleLauncherIcon(w http.ResponseWriter, r *http.Request) {
	roots, bases := s.iconRoots, s.iconBases
	if roots == nil {
		roots = defaultIconRoots
	}
	if bases == nil {
		bases = iconRelBases
	}
	p, err := resolveIcon(r.URL.Query().Get("src"), roots, bases)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	f, err := os.Open(p)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		http.NotFound(w, r)
		return
	}
	ct := iconTypes[strings.ToLower(filepath.Ext(p))]
	if ct == "" {
		ct = mime.TypeByExtension(filepath.Ext(p))
	}
	h := w.Header()
	h.Set("Content-Type", ct)
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox")
	h.Set("Cache-Control", "public, max-age=86400")
	h.Set("ETag", fmt.Sprintf(`"%x-%x"`, fi.Size(), fi.ModTime().UnixNano()))
	http.ServeContent(w, r, "", fi.ModTime(), f) // handles If-None-Match / If-Modified-Since
}
