package jointspace

import (
	"context"
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
)

// Pending is a pairing request awaiting the PIN shown on the TV.
type Pending struct {
	DeviceID  string      `json:"device_id"`
	AuthKey   string      `json:"auth_key"`
	Timestamp json.Number `json:"timestamp"`
}

func deviceInfo(id string) map[string]any {
	return map[string]any{
		"device_name": "Cactarium", "device_os": "Linux",
		"app_name": "Cactarium", "type": "native",
		"app_id": "app.cactarium", "id": id,
	}
}

// PairRequest asks the TV to display a PIN.
func (c *Client) PairRequest(ctx context.Context) (*Pending, error) {
	id := randHex(16)
	var r struct {
		AuthKey   string      `json:"auth_key"`
		Timestamp json.Number `json:"timestamp"`
	}
	body := map[string]any{
		"scope":  []string{"read", "write", "control"},
		"device": deviceInfo(id),
	}
	if err := c.do(ctx, c.tlsBase, nil, http.MethodPost, "/6/pair/request", body, &r); err != nil {
		return nil, err
	}
	if r.AuthKey == "" || r.Timestamp == "" {
		return nil, errors.New("jointspace: pair request returned no auth_key/timestamp")
	}
	return &Pending{DeviceID: id, AuthKey: r.AuthKey, Timestamp: r.Timestamp}, nil
}

// Signature is base64(HMAC-SHA1(secret, timestamp+pin)). The timestamp is
// used verbatim as the TV sent it: re-formatting a number changes the MAC.
func Signature(secret []byte, timestamp json.Number, pin string) string {
	m := hmac.New(sha1.New, secret)
	m.Write([]byte(timestamp.String() + pin))
	return base64.StdEncoding.EncodeToString(m.Sum(nil))
}

// PairGrant completes pairing and returns the digest credentials.
func (c *Client) PairGrant(ctx context.Context, p *Pending, appSecretB64, pin string) (user, pass string, err error) {
	secret, err := base64.StdEncoding.DecodeString(strings.TrimSpace(appSecretB64))
	if err != nil {
		return "", "", fmt.Errorf("jointspace: app secret is not valid base64: %w", err)
	}
	body := map[string]any{
		"auth": map[string]any{
			"auth_appId":     "1",
			"auth_timestamp": p.Timestamp,
			"auth_signature": Signature(secret, p.Timestamp, pin),
			"pin":            pin,
		},
		"device": deviceInfo(p.DeviceID),
	}
	// The grant is digest-authenticated with the pending id/key, on its own
	// state so it never disturbs the paired session.
	var da digestAuth
	da.setCreds(p.DeviceID, p.AuthKey)
	var r struct {
		ErrorID   string `json:"error_id"`
		ErrorText string `json:"error_text"`
	}
	if err := c.do(ctx, c.tlsBase, &da, http.MethodPost, "/6/pair/grant", body, &r); err != nil {
		return "", "", err
	}
	if r.ErrorID != "SUCCESS" {
		return "", "", fmt.Errorf("jointspace: pairing failed: %s %s", r.ErrorID, r.ErrorText)
	}
	return p.DeviceID, p.AuthKey, nil
}
