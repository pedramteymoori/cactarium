package jointspace

import (
	"context"
	"fmt"
	"net/http"
)

// Volume is /6/audio/volume.
type Volume struct {
	Muted   bool `json:"muted"`
	Current int  `json:"current"`
	Min     int  `json:"min"`
	Max     int  `json:"max"`
}

// System reads /6/system on the unauthenticated port; it also doubles as the
// reachability probe.
func (c *Client) System(ctx context.Context) (map[string]any, error) {
	var m map[string]any
	err := c.doPlain(ctx, http.MethodGet, "/6/system", nil, &m)
	return m, err
}

func (c *Client) getString(ctx context.Context, path, field string) (string, error) {
	var m map[string]any
	if err := c.Do(ctx, http.MethodGet, path, nil, &m); err != nil {
		return "", err
	}
	s, _ := m[field].(string)
	return s, nil
}

func (c *Client) PowerState(ctx context.Context) (string, error) {
	return c.getString(ctx, "/6/powerstate", "powerstate")
}

func (c *Client) SetPowerState(ctx context.Context, s string) error {
	return c.Do(ctx, http.MethodPost, "/6/powerstate", map[string]string{"powerstate": s}, nil)
}

func (c *Client) SendKey(ctx context.Context, key string) error {
	return c.Do(ctx, http.MethodPost, "/6/input/key", map[string]string{"key": key}, nil)
}

func (c *Client) Volume(ctx context.Context) (Volume, error) {
	var v Volume
	err := c.Do(ctx, http.MethodGet, "/6/audio/volume", nil, &v)
	return v, err
}

func (c *Client) SetVolume(ctx context.Context, v Volume) error {
	return c.Do(ctx, http.MethodPost, "/6/audio/volume",
		map[string]any{"muted": v.Muted, "current": v.Current}, nil)
}

func (c *Client) ScreenState(ctx context.Context) (string, error) {
	return c.getString(ctx, "/6/screenstate", "screenstate")
}

func (c *Client) getMap(ctx context.Context, path string) (map[string]any, error) {
	var m map[string]any
	err := c.Do(ctx, http.MethodGet, path, nil, &m)
	return m, err
}

func (c *Client) AmbilightPower(ctx context.Context) (string, error) {
	return c.getString(ctx, "/6/ambilight/power", "power")
}

func (c *Client) SetAmbilightPower(ctx context.Context, p string) error {
	if p != "On" && p != "Off" {
		return fmt.Errorf("jointspace: ambilight power must be On or Off, got %q", p)
	}
	return c.Do(ctx, http.MethodPost, "/6/ambilight/power", map[string]string{"power": p}, nil)
}

func (c *Client) AmbilightConfig(ctx context.Context) (map[string]any, error) {
	return c.getMap(ctx, "/6/ambilight/currentconfiguration")
}

func (c *Client) SetAmbilightStyle(ctx context.Context, style, algorithm string) error {
	body := map[string]any{"styleName": style, "isExpert": false}
	if algorithm != "" {
		body["menuSetting"] = algorithm
		body["algorithm"] = algorithm
	}
	return c.Do(ctx, http.MethodPost, "/6/ambilight/currentconfiguration", body, nil)
}

func (c *Client) AmbilightStyles(ctx context.Context) (map[string]any, error) {
	return c.getMap(ctx, "/6/ambilight/supportedstyles")
}

func (c *Client) AmbilightTopology(ctx context.Context) (map[string]any, error) {
	return c.getMap(ctx, "/6/ambilight/topology")
}

func (c *Client) AmbilightProcessed(ctx context.Context) (map[string]any, error) {
	return c.getMap(ctx, "/6/ambilight/processed")
}
