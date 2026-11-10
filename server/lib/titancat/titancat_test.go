package titancat

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

// fake serves n apps in pages of 2 (it honours page, ignores per_page).
func fake(t *testing.T, n int, hits *int) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		if q.Get("firmware") == "" || q.Get("model") != "55PUS8450/12" || q.Get("market") != "NL" {
			http.Error(w, "bad", 400)
			return
		}
		if hits != nil {
			*hits++
		}
		p, _ := strconv.Atoi(q.Get("page"))
		var col []App
		for i := (p - 1) * 2; i < p*2 && i < n; i++ {
			col = append(col, App{ID: i, Code: "app" + strconv.Itoa(i), Name: "App " + strconv.Itoa(i)})
		}
		pg := map[string]any{"current_page": p, "next_page": nil}
		if p*2 < n {
			pg["next_page"] = p + 1
		}
		json.NewEncoder(w).Encode(map[string]any{"collection": col, "pagination": pg})
	}))
}

var testQ = Query{Market: "NL", Locale: "nl", Model: "55PUS8450/12", Firmware: "FW1"}

func TestFetchPaging(t *testing.T) {
	hits := 0
	ts := fake(t, 5, &hits)
	defer ts.Close()
	apps, err := Fetch(context.Background(), ts.Client(), ts.URL, testQ)
	if err != nil || len(apps) != 5 || hits != 3 || apps[4].Code != "app4" {
		t.Fatalf("%v %d %d", err, len(apps), hits)
	}
	if _, err := Fetch(context.Background(), ts.Client(), ts.URL, Query{Market: "NL", Model: "55PUS8450/12"}); err == nil {
		t.Fatal("missing firmware should fail")
	}
}

func TestCatalogCacheRoundTrip(t *testing.T) {
	ts := fake(t, 3, nil)
	defer ts.Close()
	path := filepath.Join(t.TempDir(), "var", "titan-catalog.json")
	c := New(path, ts.Client(), ts.URL)
	if _, ok := c.Lookup("app1"); ok {
		t.Fatal("empty catalog found app")
	}
	if err := c.Refresh(context.Background(), testQ); err != nil {
		t.Fatal(err)
	}
	if a, ok := c.Lookup("app2"); !ok || a.Name != "App 2" {
		t.Fatalf("lookup: %+v %v", a, ok)
	}
	c2 := New(path, nil, "") // fresh process: loads the cache file
	if a, ok := c2.Lookup("app0"); !ok || a.Name != "App 0" || c2.Len() != 3 || time.Since(c2.Fetched()) > time.Minute {
		t.Fatalf("cache: %+v %v %d", a, ok, c2.Len())
	}
}

func TestRunRefreshesAndKicks(t *testing.T) {
	ts := fake(t, 2, nil)
	defer ts.Close()
	c := New("", ts.Client(), ts.URL)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go c.Run(ctx, func() Query { return testQ })
	for i := 0; i < 100 && c.Len() == 0; i++ {
		time.Sleep(20 * time.Millisecond)
	}
	if c.Len() != 2 {
		t.Fatalf("len %d", c.Len())
	}
}
