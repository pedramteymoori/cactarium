# Security

This server has **no authentication by default**, and listens on all
interfaces (`:8090`), so it is reachable from anywhere on your network. Anyone
who can reach the port can press the TV's buttons, change its volume and power,
read its readings and change Cactarium's settings. On a home LAN that is
usually the point; understand it before exposing it more widely. **Never
port-forward 8090 to the internet.**

## Set a token

Put `"token": "something-long"` in `config.json` (the Server tab shows
whether one is set but does not set it) and restart the server. Every `/api/`
request must then carry an `X-Cactarium-Token` header or a `?token=` query
parameter. Open the dashboard once with `?token=something-long`; the page
stores it in the browser and removes it from the address bar. Tokens are
compared in constant time.

The token gates the dashboard's API only. It does **not** cover:

* **MQTT and Home Assistant**, which use a separate channel. See
  [hardening the bridge](#hardening-the-mqtt-bridge).
* **The launcher's endpoints**, below.
* **The static files**, including the dashboard page and the launcher page
  themselves.

## The launcher's endpoints have no token

The launcher runs inside the TV's own UI, which has no token to send, so these
routes ignore `token`:

| Route | Who can use it |
| :--- | :--- |
| `GET /phi-hook.js`, `GET /launcher`, `/launcher/*` | Anyone on the network (static files). |
| `GET /api/launcher/enabled`, `/api/launcher/apps`, `/api/launcher/weather` | Anyone on the network. They show which apps are in the row and the weather. |
| `GET /api/launcher/background`, `GET /launcher/wallpaper?slot=` | Anyone on the network. They show the background setting and the chosen pictures (which may be your own images). The routes that change them, under `/api/launcher/wallpapers`, need the token. |
| `GET /launcher/icon`, `/launcher/titan-icon` | Anyone. Icons come from an allowlist of read-only directories, or from titanos.tv. |
| `GET /tvapp/*` (its scripts) | Anyone on the network (static files; they carry no token). |
| `GET /tvapp` | **Only a client on the TV itself**: the TV app page, see [below](#the-tv-app-and-the-token). |
| `GET /api/tvapp` | **Only a client on the TV itself** (loopback): the dashboard's address for the QR code. Never returns the token. |
| `GET /api/tv/phi/next`, `POST /api/tv/phi/result` | **Only a client on the TV itself** (loopback): the hook's side of the PHI bridge. |
| `POST /api/launcher/debug` | Only on the TV itself, only when `launcher.debug` is on, and only with the secret in `var/debug.secret`. |
| `GET /api/launcher/debug`, `POST /api/home/diag` | Anyone; the debug queue is empty unless debug is on. |

None of these can press keys or change power. The bridge routes refuse
anything not from the loopback address. The debug channel can run JavaScript
inside the TV's UI, which can call any of its internal functions, so it is
**off by default**; switch it on only while working on the hook.

## The TV app and the token

The TV app (the launcher's Cactarium tile) changes settings, so it needs the same access token as the dashboard, and the TV's browser has none to type. `GET /tvapp` is therefore served to the TV itself only: the peer must be a loopback address and the `Host` header a loopback name (`localhost`, `127.0.0.1`, `[::1]`). Anyone else gets 403. When a token is configured the server writes it into the served HTML as `<meta name="cactarium-token">` (escaped, `Cache-Control: no-store`), and `tvapp.js` sends it as `X-Cactarium-Token`; with no token configured nothing is injected. A page on another origin cannot read that response (no CORS headers are sent), and the `Host` check stops a DNS-rebinding page from fetching it. The token is never part of the QR code the TV app shows, which carries only the dashboard's address, so a phone still asks for it. Any process on the TV can already read it from `config.json` (see below), so serving it to the TV's own browser widens nothing.

## The PHI bridge

`POST /api/tv/phi` and `POST /api/tv/reboot` need the token. The first runs a
PHI function inside the TV's UI page through the hook, so it is limited to an
allowlist in `server/lib/routes/phi_allow.go` (picture, sound and general
settings, the TV's restart, and launching an app); the hook checks the name
shape again. Nothing that returns or sets a secret (factory menus, Wi-Fi
passwords, ESN, calibration) is on the list. Without a token set, anyone on the
network can use it, like the rest of the dashboard API. The hook's polling
routes accept loopback clients only; a web page in the TV's own browser is also
loopback, so it could read a queued job or answer one, which exposes at most an
allowlisted call and its result.

## The config file is readable by every process on the TV

The vendor boot script runs `chmod 777 -R /mtd_apdat/` at every boot (verified
on this firmware), so `config.json`, with the pairing credentials, MQTT
password, app secret and token, is readable and writable by any process on the
TV even though the server writes it as 0600. Treat the TV as a trusted-LAN
device. `var/debug.secret` is also under that tree.

## Reaching the internet

Cactarium makes no outbound connections of its own beyond the TV's JointSpace
API and the MQTT broker you set. The optional launcher features reach out:
`eu.app.titanos.tv` (catalog, once a day, with your catalog market, locale,
model and firmware), titanos.tv image hosts (icons), and `api.open-meteo.com`
(weather, with the latitude and longitude you set). Leave them unset to keep
the TV off these hosts. See [what it changes on the TV](TV-CHANGES.md#network).

## The app secret

The JointSpace app secret is supplied by you, stored in `config.json`, and
never committed or shipped. Anyone who can read the config can pair further
devices with the TV.

## No rooting or exploits

Cactarium assumes SSH already exists. It does not root the TV, carries no
exploit, and does not weaken SELinux: the launcher's page copy is relabelled to
a type the policy allows the browser to read. SSH itself is worth hardening
(key authentication only, which `deploy.sh` requires anyway); a root shell
open on the local network is a bigger risk than anything here.

## Hardening the MQTT bridge

The bridge connects to your broker over plain TCP (MQTT 3.1.1, no TLS) with the
user and password you set.

* Use a dedicated broker user for the TV, not your Home Assistant user.
* Restrict it to the TV's topics with an ACL, for example for the default
  prefix and a device id `a1b2c3d4`:

```text
# /etc/mosquitto/aclfile
user tv
topic readwrite cactarium/a1b2c3d4/#
topic readwrite homeassistant/+/cactarium_a1b2c3d4/#
```

* Anything that can publish to `<prefix>/<device_id>/…/set` can control the TV
  (power, volume, mute, Ambilight, and any remote key), so keep the broker
  closed to the network.
