// Package titancat fetches TitanOS's public app catalog and keeps a copy in
// memory and in a cache file, so the launcher can show the user's favourite
// apps with TitanOS's own names, icons and launch URLs.
package titancat

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"
)

// DefaultBase is the public catalog host.
const DefaultBase = "https://eu.app.titanos.tv"

const (
	perPage      = 50 // the API's maximum
	maxPages     = 40 // guard against a server that never ends the list
	reqTimeout   = 15 * time.Second
	refreshEvery = 24 * time.Hour
	retryAfter   = 10 * time.Minute
)

// App is one catalog entry (only the fields the launcher uses).
type App struct {
	ID      int    `json:"id"`
	Code    string `json:"code"`
	Name    string `json:"name"`
	Icon    string `json:"icon"`
	URL     string `json:"url"`
	AppType string `json:"app_type"`
	// Resolution is the browser window size the app is built for ("720p",
	// "1080p"); a web app opened in the wrong one shows a blank screen.
	Resolution string `json:"resolution"`
}

// Query selects the catalog slice; the API answers 400 without a firmware.
type Query struct {
	Market, Locale, Model, Firmware string
}

// Ready reports whether the query has what the API insists on.
func (q Query) Ready() bool { return q.Model != "" && q.Firmware != "" }

// Fetch downloads every page of the catalog. A nil client uses a default one.
func Fetch(ctx context.Context, hc *http.Client, base string, q Query) ([]App, error) {
	if hc == nil {
		hc = &http.Client{}
	}
	if base == "" {
		base = DefaultBase
	}
	var out []App
	for page := 1; page > 0 && page <= maxPages; {
		v := url.Values{}
		v.Set("market", q.Market)
		v.Set("locale", q.Locale)
		v.Set("device", "tv")
		v.Set("firmware", q.Firmware)
		v.Set("model", q.Model)
		v.Set("per_page", strconv.Itoa(perPage))
		v.Set("page", strconv.Itoa(page))
		var body struct {
			Collection []App `json:"collection"`
			Pagination struct {
				NextPage *int `json:"next_page"`
			} `json:"pagination"`
		}
		if err := getJSON(ctx, hc, base+"/v1/apps?"+v.Encode(), &body); err != nil {
			return nil, fmt.Errorf("page %d: %w", page, err)
		}
		out = append(out, body.Collection...)
		page = 0
		if n := body.Pagination.NextPage; n != nil {
			page = *n
		}
	}
	return out, nil
}

func getJSON(ctx context.Context, hc *http.Client, u string, v any) error {
	ctx, cancel := context.WithTimeout(ctx, reqTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "GET", u, nil)
	if err != nil {
		return err
	}
	resp, err := hc.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return json.NewDecoder(io.LimitReader(resp.Body, 8<<20)).Decode(v)
}

// Catalog holds the app list in memory, backed by a cache file.
type Catalog struct {
	path string
	hc   *http.Client
	base string

	mu      sync.RWMutex
	apps    []App
	byCode  map[string]App
	fetched time.Time

	kick chan struct{}
}

// New returns a catalog cached at path (may be empty for no cache). A nil
// client or empty base use the defaults. The cache file is read at once.
func New(path string, hc *http.Client, base string) *Catalog {
	if hc == nil {
		hc = &http.Client{}
	}
	if base == "" {
		base = DefaultBase
	}
	c := &Catalog{path: path, hc: hc, base: base, kick: make(chan struct{}, 1)}
	c.load()
	return c
}

// cacheVersion changes when App gains a field, so an older cache is fetched again.
const cacheVersion = 2

type cacheFile struct {
	Version int       `json:"version"`
	Fetched time.Time `json:"fetched"`
	Apps    []App     `json:"apps"`
}

func (c *Catalog) load() {
	if c.path == "" {
		return
	}
	b, err := os.ReadFile(c.path)
	if err != nil {
		return
	}
	var f cacheFile
	if json.Unmarshal(b, &f) != nil || f.Version != cacheVersion {
		return
	}
	c.set(f.Apps, f.Fetched)
}

func (c *Catalog) set(apps []App, at time.Time) {
	m := make(map[string]App, len(apps))
	for _, a := range apps {
		if a.Code != "" {
			m[a.Code] = a
		}
	}
	c.mu.Lock()
	c.apps, c.byCode, c.fetched = apps, m, at
	c.mu.Unlock()
}

// save writes tmp + rename, like the config store.
func (c *Catalog) save(apps []App, at time.Time) error {
	if c.path == "" {
		return nil
	}
	b, err := json.Marshal(cacheFile{Version: cacheVersion, Fetched: at, Apps: apps})
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(c.path), 0o700); err != nil {
		return err
	}
	tmp := c.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, c.path)
}

// Lookup returns the app with the given catalog code.
func (c *Catalog) Lookup(code string) (App, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	a, ok := c.byCode[code]
	return a, ok
}

// Len is the number of apps held.
func (c *Catalog) Len() int {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return len(c.apps)
}

// Fetched is when the held list was downloaded (zero if never).
func (c *Catalog) Fetched() time.Time {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.fetched
}

// Refresh downloads the catalog now and replaces the held list.
func (c *Catalog) Refresh(ctx context.Context, q Query) error {
	apps, err := Fetch(ctx, c.hc, c.base, q)
	if err != nil {
		return err
	}
	if len(apps) == 0 {
		return fmt.Errorf("empty catalog")
	}
	now := time.Now()
	c.set(apps, now)
	if err := c.save(apps, now); err != nil {
		log.Printf("titancat: cache not saved: %v", err)
	}
	return nil
}

// Kick asks Run to refresh now (after a settings change).
func (c *Catalog) Kick() {
	select {
	case c.kick <- struct{}{}:
	default:
	}
}

// Run keeps the catalog fresh until ctx ends: a refresh at start when the
// cache is missing or older than 24h, then every 24h; a failure retries after
// 10 minutes. query is read on every attempt so config changes apply.
func (c *Catalog) Run(ctx context.Context, query func() Query) {
	wait := time.Duration(0)
	if t := c.Fetched(); !t.IsZero() {
		wait = max(0, refreshEvery-time.Since(t))
	}
	for {
		timer := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-c.kick:
			timer.Stop()
		case <-timer.C:
		}
		q := query()
		if !q.Ready() {
			log.Printf("titancat: refresh skipped, launcher.catalog model/firmware not set")
			wait = retryAfter
			continue
		}
		if err := c.Refresh(ctx, q); err != nil {
			log.Printf("titancat: refresh failed: %v (retry in %s)", err, retryAfter)
			wait = retryAfter
			continue
		}
		log.Printf("titancat: refreshed, %d apps", c.Len())
		wait = refreshEvery
	}
}

// All returns a copy of the cached apps in catalog order; empty before the
// first fetch.
func (c *Catalog) All() []App {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return append([]App(nil), c.apps...)
}
