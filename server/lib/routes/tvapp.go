package routes

import (
	"bytes"
	"html"
	"net"
	"net/http"
	"strings"

	"cactarium/server/assets"
)

// GET /tvapp: the TV app (assets/tvapp, shown from the launcher's Cactarium
// tile). It changes settings, so its script needs the access token, and the TV's
// own browser has none to type. The page is therefore served to the TV itself
// only (loopback address and a loopback Host name), and with a token configured
// the server writes it into the page as <meta name="cactarium-token">. A page
// on another origin cannot read this response (no CORS headers are sent), and
// the Host check stops a DNS-rebinding page, which would be same-origin with the
// attacker's name, from fetching it. The token is never put in the QR code.
func (s *Server) handleTVAppPage(w http.ResponseWriter, r *http.Request) {
	if !fromTheTV(r) {
		http.Error(w, "The TV app is only for the TV itself. Open the dashboard at the TV's address instead.", http.StatusForbidden)
		return
	}
	b, err := assets.FS.ReadFile("tvapp/index.html")
	if err != nil {
		http.NotFound(w, r)
		return
	}
	marker := []byte(tvAppTokenMarker)
	meta := []byte{}
	if tok := s.store.Get().Token; tok != "" {
		meta = []byte(`<meta name="cactarium-token" content="` + html.EscapeString(tok) + `">`)
	}
	b = bytes.Replace(b, marker, meta, 1)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(b)
}

// tvAppTokenMarker is where index.html takes the token's <meta> tag.
const tvAppTokenMarker = "<!--cactarium-token-->"

// fromTheTV is true for a request from the TV itself: a loopback peer that
// asked for a loopback name, which is how phi-hook.js and the launcher reach
// the server (http://localhost:8090).
func fromTheTV(r *http.Request) bool {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if ip := net.ParseIP(host); err != nil || ip == nil || !ip.IsLoopback() {
		return false
	}
	name := r.Host
	if h, _, err := net.SplitHostPort(name); err == nil {
		name = h
	}
	name = strings.Trim(name, "[]")
	if ip := net.ParseIP(name); ip != nil {
		return ip.IsLoopback()
	}
	return name == "localhost" || strings.HasSuffix(name, ".localhost")
}

// GET /api/tvapp: where a phone reaches the dashboard, which only the server
// knows (the app itself is served from localhost). Everything else the TV app
// shows comes from the dashboard's own authed routes. Loopback clients only;
// the token is never part of it.
func (s *Server) handleTVApp(w http.ResponseWriter, r *http.Request) {
	if !loopbackOnly(w, r) {
		return
	}
	writeJSON(w, 200, map[string]any{"dashboard": s.dashboardAddress()})
}

// dashboardAddress is where a phone on the home network opens the dashboard.
// url is empty when the server is not listening on a LAN address.
func (s *Server) dashboardAddress() map[string]any {
	addr := s.listen
	if addr == "" {
		addr = s.store.Get().Listen
	}
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		host, port = "", "8090"
	}
	out := map[string]any{"url": "", "host": "", "port": port}
	ip := host
	if p := net.ParseIP(host); host == "" || (p != nil && p.IsUnspecified()) {
		ip = lanIPv4()
	} else if p != nil && p.IsLoopback() {
		return out // bound to the TV only: nothing for a phone to open
	}
	if ip == "" {
		return out
	}
	out["host"] = ip
	out["url"] = "http://" + net.JoinHostPort(ip, port) + "/"
	return out
}

// lanIPv4 is the address the TV uses to reach the home network. Dialling UDP
// sends nothing; it only makes the kernel choose the outgoing interface. The
// interface list is the fallback for a TV with no default route.
func lanIPv4() string {
	if c, err := net.Dial("udp4", "192.0.2.1:9"); err == nil {
		defer c.Close()
		if a, ok := c.LocalAddr().(*net.UDPAddr); ok && usableLAN(a.IP) {
			return a.IP.String()
		}
	}
	addrs, _ := net.InterfaceAddrs()
	for _, a := range addrs {
		if n, ok := a.(*net.IPNet); ok && usableLAN(n.IP) {
			return n.IP.String()
		}
	}
	return ""
}

func usableLAN(ip net.IP) bool {
	ip4 := ip.To4()
	return ip4 != nil && !ip4.IsLoopback() && !ip4.IsUnspecified() && !ip4.IsLinkLocalUnicast()
}
