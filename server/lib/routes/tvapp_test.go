package routes

import (
	"net/http/httptest"
	"strings"
	"testing"
)

// serveFrom runs one request through the handler as a given peer and Host.
func serveFrom(srv *Server, path, remote, host string) *httptest.ResponseRecorder {
	req := httptest.NewRequest("GET", path, nil)
	req.RemoteAddr = remote
	req.Host = host
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	return rec
}

func TestTVAppPageCarriesTokenForTheTVOnly(t *testing.T) {
	srv, _, _ := setup(t, "s3cret<\"x", true)
	// the TV itself, as the launcher reaches it: the page, with the token in a meta tag
	for _, host := range []string{"localhost:8090", "127.0.0.1:8090", "[::1]:8090"} {
		rec := serveFrom(srv, "/tvapp", "127.0.0.1:41000", host)
		body := rec.Body.String()
		if rec.Code != 200 || !strings.Contains(body, "<title>Cactarium</title>") {
			t.Fatalf("%s: %d", host, rec.Code)
		}
		if !strings.Contains(body, `<meta name="cactarium-token" content="s3cret&lt;&#34;x">`) {
			t.Fatalf("%s: token meta missing or not escaped", host)
		}
		if strings.Contains(body, tvAppTokenMarker) {
			t.Fatalf("%s: marker left in the page", host)
		}
		if rec.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("%s: the page must not be cached", host)
		}
	}
	// a client on the home network gets nothing, token or not
	for _, hdr := range []string{"", "s3cret"} {
		req := httptest.NewRequest("GET", "/tvapp", nil)
		req.RemoteAddr = "198.51.100.20:5555"
		req.Host = "192.0.2.7:8090"
		if hdr != "" {
			req.Header.Set("X-Cactarium-Token", hdr)
		}
		rec := httptest.NewRecorder()
		srv.Handler().ServeHTTP(rec, req)
		if rec.Code != 403 || strings.Contains(rec.Body.String(), "s3cret") {
			t.Fatalf("lan client: %d %q", rec.Code, rec.Body.String())
		}
	}
	// a loopback peer asking by another name is a DNS-rebinding page, not the TV
	if rec := serveFrom(srv, "/tvapp", "127.0.0.1:41000", "attacker.example:8090"); rec.Code != 403 {
		t.Fatalf("rebinding host: %d", rec.Code)
	}
	// the static scripts carry no token
	if rec := serveFrom(srv, "/tvapp/tvapp.js", "198.51.100.20:5555", "192.0.2.7:8090"); strings.Contains(rec.Body.String(), "s3cret") {
		t.Fatal("token in a static file")
	}
}

func TestTVAppPageWithoutTokenInjectsNothing(t *testing.T) {
	srv, _, _ := setup(t, "", true)
	rec := serveFrom(srv, "/tvapp", "127.0.0.1:41000", "localhost:8090")
	body := rec.Body.String()
	if rec.Code != 200 || strings.Contains(body, "cactarium-token") || strings.Contains(body, "<meta name=\"cactarium") {
		t.Fatalf("no token configured, nothing to inject: %d", rec.Code)
	}
}

func TestTVAppDashboardAddressLoopbackOnly(t *testing.T) {
	srv, api, _ := setup(t, "s3cret", true)
	// the TV's own browser has no token: a loopback client gets the address without one
	r, body := get(t, api.URL+"/api/tvapp")
	if r.StatusCode != 200 || !strings.Contains(body, `"dashboard"`) {
		t.Fatalf("loopback: %d %s", r.StatusCode, body)
	}
	if strings.Contains(body, "s3cret") {
		t.Fatalf("the token must not be returned: %s", body)
	}
	for _, hdr := range []string{"", "s3cret"} {
		req := httptest.NewRequest("GET", "/api/tvapp", nil)
		req.RemoteAddr = "198.51.100.20:5555"
		if hdr != "" {
			req.Header.Set("X-Cactarium-Token", hdr)
		}
		rec := httptest.NewRecorder()
		srv.Handler().ServeHTTP(rec, req)
		if rec.Code != 403 {
			t.Fatalf("lan client: %d", rec.Code)
		}
	}
}

func TestDashboardAddress(t *testing.T) {
	srv, _, _ := setup(t, "", true)
	srv.listen = "127.0.0.1:8090"
	if u := srv.dashboardAddress()["url"]; u != "" {
		t.Fatalf("loopback-only listener has no phone address: %v", u)
	}
	srv.listen = "192.0.2.7:9000"
	if u := srv.dashboardAddress()["url"]; u != "http://192.0.2.7:9000/" {
		t.Fatalf("explicit host: %v", u)
	}
	srv.listen = ":9000"
	if u, _ := srv.dashboardAddress()["url"].(string); u != "" && !strings.HasSuffix(u, ":9000/") {
		t.Fatalf("wildcard host: %v", u)
	}
}
