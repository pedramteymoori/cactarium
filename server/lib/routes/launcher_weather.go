package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"sync"
	"time"
)

// Weather badge for the launcher: Open-Meteo, no API key. The TV never talks
// to the upstream more than once per 30 minutes (2 after a failure).

const (
	defaultWeatherURL = "https://api.open-meteo.com/v1/forecast"
	weatherTTL        = 30 * time.Minute
	weatherRetry      = 2 * time.Minute
)

type weatherInfo struct {
	Temp    int    `json:"temp"`
	Unit    string `json:"unit"`
	Code    int    `json:"code"`
	Label   string `json:"label"`
	Kind    string `json:"kind"`
	Updated int64  `json:"updated"`
}

type weatherCache struct {
	mu       sync.Mutex
	key      string
	info     *weatherInfo
	fetched  time.Time
	failedAt time.Time
}

// wmo maps WMO weather codes to a label and a coarse kind for the page.
func wmo(code int) (string, string) {
	switch {
	case code == 0:
		return "Clear", "clear"
	case code == 1:
		return "Mostly clear", "clear"
	case code == 2:
		return "Partly cloudy", "cloud"
	case code == 3:
		return "Overcast", "cloud"
	case code == 45 || code == 48:
		return "Fog", "fog"
	case code >= 51 && code <= 57:
		return "Drizzle", "rain"
	case code >= 61 && code <= 67:
		return "Rain", "rain"
	case code >= 71 && code <= 77:
		return "Snow", "snow"
	case code >= 80 && code <= 82:
		return "Showers", "rain"
	case code == 85 || code == 86:
		return "Snow showers", "snow"
	case code >= 95 && code <= 99:
		return "Thunderstorm", "storm"
	}
	return "Unknown", "cloud"
}

func (s *Server) fetchWeather(ctx context.Context, lat, lon float64) (*weatherInfo, error) {
	base := s.weatherURL
	if base == "" {
		base = defaultWeatherURL
	}
	q := url.Values{}
	q.Set("latitude", fmt.Sprintf("%.4f", lat))
	q.Set("longitude", fmt.Sprintf("%.4f", lon))
	q.Set("current", "temperature_2m,weather_code")
	ctx, cancel := context.WithTimeout(ctx, 6*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"?"+q.Encode(), nil)
	if err != nil {
		return nil, err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("weather upstream: %s", resp.Status)
	}
	var d struct {
		Current *struct {
			Temp *float64 `json:"temperature_2m"`
			Code *int     `json:"weather_code"`
		} `json:"current"`
		Units struct {
			Temp string `json:"temperature_2m"`
		} `json:"current_units"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&d); err != nil {
		return nil, err
	}
	if d.Current == nil || d.Current.Temp == nil || d.Current.Code == nil {
		return nil, fmt.Errorf("weather upstream: no current data")
	}
	label, kind := wmo(*d.Current.Code)
	unit := d.Units.Temp
	if unit == "" {
		unit = "°C"
	}
	return &weatherInfo{Temp: int(math.Round(*d.Current.Temp)), Unit: unit, Code: *d.Current.Code, Label: label, Kind: kind}, nil
}

func (s *Server) handleWeather(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	wc := s.store.Get().Launcher.Weather
	if !wc.Set() {
		writeJSON(w, http.StatusOK, map[string]any{"enabled": false})
		return
	}
	now := time.Now
	if s.now != nil {
		now = s.now
	}
	key := fmt.Sprintf("%.4f,%.4f", *wc.Latitude, *wc.Longitude)
	c := &s.wx
	c.mu.Lock()
	defer c.mu.Unlock()
	t := now()
	if c.key == key && c.info != nil && t.Sub(c.fetched) < weatherTTL {
		writeJSON(w, http.StatusOK, map[string]any{"enabled": true, "ok": true, "weather": c.info})
		return
	}
	if c.key == key && !c.failedAt.IsZero() && t.Sub(c.failedAt) < weatherRetry {
		s.writeWeatherStale(w, key)
		return
	}
	info, err := s.fetchWeather(r.Context(), *wc.Latitude, *wc.Longitude)
	if err != nil {
		c.failedAt = t
		if c.key != key {
			c.key, c.info = key, nil
		}
		s.writeWeatherStale(w, key)
		return
	}
	info.Updated = t.Unix()
	c.key, c.info, c.fetched, c.failedAt = key, info, t, time.Time{}
	writeJSON(w, http.StatusOK, map[string]any{"enabled": true, "ok": true, "weather": info})
}

// writeWeatherStale answers with the last good reading (if any); c.mu is held.
func (s *Server) writeWeatherStale(w http.ResponseWriter, key string) {
	c := &s.wx
	if c.key == key && c.info != nil {
		writeJSON(w, http.StatusOK, map[string]any{"enabled": true, "ok": true, "stale": true, "weather": c.info})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"enabled": true, "ok": false})
}
