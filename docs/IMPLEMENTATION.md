# Internals

How Cactarium is built and why. For what it changes on the TV see [TV-CHANGES](TV-CHANGES.md).

Platform facts below were checked on the 55PUS8450/12 (chassis TPN256E, Novatek NT72690), firmware TPN256E_V056.010.032.001.

## Architecture

One Go program (module `cactarium`, Go 1.22, standard library only), built static with `CGO_ENABLED=0` for `linux/arm64` and `linux/arm` (GOARM=7) by `make dist`. The kernel is aarch64 with a 32-bit userspace; static aarch64 binaries run. The TV has busybox `sh`, `wget`, `iptables`, `netstat` and `sha256sum`, and no Node, Python, curl or gcc. The same binary runs on macOS or Linux for development, pointed at a TV with `-tv <ip>`.

```
server/cactarium.go     flags, wiring, signal handling, 48 MiB memory limit
server/ha.go            haRunner: owns the MQTT client + HA bridge, restarts on settings change
server/lib/config       JSON config, defaults, atomic save
server/lib/jointspace   JointSpace client
server/lib/telemetry    /proc and /sys sampler
server/lib/mqtt         MQTT 3.1.1 client
server/lib/ha           Home Assistant bridge over server/lib/mqtt
server/lib/routes       HTTP routes, auth, state cache, launcher endpoints
server/lib/titancat     TitanOS public app catalog
server/lib/netblock     iptables rules blocking app.titanos.tv
server/assets/          embedded dashboard, hook and launcher
server/cactariumctl     on-TV start/stop/status (busybox sh)
server/deploy.sh        build + install over ssh
```

The `routes` package knows nothing about MQTT; `main` adapts its exported command methods to the bridge's `Commands` interface, and the runner publishes state after every command.

## The binary

`-config` (default `/mtd_rwarea/apdat/opt/cactarium/config.json` when that directory exists, else `./config.json`), `-listen`, `-tv`, `-version`. `main.version` is set with `-ldflags -X`, from `git describe` in the Makefile. At start, if `SSL_CERT_FILE` is unset and `/etc/ssl/cacert.pem` exists, it is used: Go's default bundle paths do not include the TV's, and without it every HTTPS request (catalog, weather) fails with an unknown-authority error. `debug.SetMemoryLimit(48 << 20)` makes the GC work harder on a TV with little RAM.

## Config

`config.Store` loads the JSON file, fills defaults, generates an eight-hex-digit `device_id` on first load, and saves with a temp file, `fsync` and rename at mode 0600 so a power cut never leaves a torn file. `Get` returns a copy; `Update` mutates a copy and rolls back if the save fails. The listen default is `:8090`, not 8080: Samba TV's client holds `127.0.0.1:8080` on this firmware, which blocks a wildcard bind. Keys are listed in [Installing](install.md#configuration).

## JointSpace

The TV's local REST API: `http://127.0.0.1:1925` answers `/6/system` without authentication, and everything else is `https://127.0.0.1:1926` with HTTP Digest authentication and a self-signed certificate (verification is off for this loopback connection only). Timeouts are 4 seconds with keep-alive. The Digest code caches the last challenge and increments `nc`, and refreshes and retries once on a 401.

Typed calls cover power state, keys, volume (the POST needs both fields, so the server reads the live volume first), screen state, and Ambilight power, current configuration, supported styles, topology and processed LED values.

**Pairing** uses the vendor app secret, which the owner supplies and which is never hardcoded: a request with a random device id returns an `auth_key` and a `timestamp`; the TV shows a PIN; the grant signs `timestamp + PIN` with HMAC-SHA1 under the base64-decoded secret and is sent with Digest auth as the device id. The timestamp is kept as the raw JSON number so it is formatted unchanged. Success is `error_id == "SUCCESS"`; the device id and auth key become `jointspace.user` and `pass`.

## State cache and API

A poller reads the TV's state every 5 seconds and right after any command (debounced), so requests read a cache and never wait on the TV more than one call (4-second timeout). Errors map to a status: a validation error is 400, an unpaired TV 409, anything else 502, with `{"error": "..."}`. Command routes return the fresh state.

| Method | Path | Notes |
| :--- | :--- | :--- |
| GET | `/api/state` | Cached TV state, stats, MQTT status, version. |
| GET | `/api/stats` | The telemetry snapshot alone: time, uptime, load, CPU (total and per core), memory, swap, temperatures, per-interface network counters and rates, Wi-Fi, storage, eMMC wear, host name and addresses, process count, Cactarium's own memory. |
| GET | `/api/processes`, `/api/cpu` | The Metrics tab's lists, read only while open: the largest processes by resident memory, and the busiest over a one-second sample. |
| POST | `/api/key` | `{"key": "CursorUp"}` |
| POST | `/api/volume` | `{"current": 12}`, `{"muted": true}` or `{"step": 1}` |
| POST | `/api/power` | `{"state": "On"\|"Standby"}` |
| GET / POST | `/api/ambilight`, `/api/ambilight/live` | Power, style and algorithm; live LED values. |
| POST | `/api/pair/start`, `/api/pair/finish`, `/api/pair/forget` | Pairing. |
| GET / POST | `/api/settings` | Name, MQTT (the password is never returned, only `has_pass`), launcher, token-set flag. `launcher.background` (`kind`, `pictures`, `animation`, `colours`, `own_colours`, `darkening`) is merged field by field and validated; an unknown value or a darkening outside 0 to 100 is a 400 and nothing is saved. A save that leaves no set chosen removes the downloaded sets. |
| GET | `/api/home/diag` | The hook's diagnostic reports (last 200). |
| GET | `/tvapp`, `/api/tvapp` | The TV app page, and where a phone reaches the dashboard: `{dashboard:{url,host,port}}`. Both take the TV itself only (a loopback peer asking for a loopback name) and need no token. With a token set, the page carries it in `<meta name="cactarium-token">`, written into the served HTML; `tvapp.js` sends it as `X-Cactarium-Token` on the authed routes it uses. The page's scripts (`/tvapp/*`) are static. |
| POST | `/api/tv/phi` | `{"method":"RpcX","params":{}}`: runs an allowlisted PHI function through the hook. 200 `{"result":...}`, 400 not allowed, 502 rejected, 504 no answer in 5 s. `launch` starts an app. |
| POST | `/api/tv/reboot` | `RpcRestartTV` through the hook; `sync; reboot -f` if the hook is silent for 3 s. |
| GET | `/api/titan/catalog` | The cached TitanOS catalog as `[{code,name,icon,app_type}]`, sorted by name. |
| GET | `/api/launcher/wallpapers` | The launcher background's pictures: `choice`, `slots` (the chosen set's four times of day), `own` (uploads), `sets` (which downloaded sets are complete), `busy` and `revision`. |
| POST | `/api/launcher/wallpapers/upload?slot=` | A JPEG body, at most 5 MB and 1920 × 1080, checked with a full decode, written atomically (mode 0600) to `var/home-wallpapers/own/<slot>.jpg`. Chooses `pictures: own`. 400 invalid, 409 busy, 413 too large. |
| POST | `/api/launcher/wallpapers/remove` | `{"slot":"morning"}` or `{"all":true}`: removes uploads. |
| POST | `/api/launcher/wallpapers/set` | `{"set":"landscape"\|"abstract"}`: downloads the set's missing pictures from the glasshouse-wallpapers `v2` tag, each checked against a pinned SHA-256 and a JPEG decode, then chooses it and removes the other set (502 if one fails). One upload, removal or download runs at a time. |
| GET | `/api/launcher/background`, `/launcher/wallpaper?slot=` | No token, for the launcher and the dashboard's previews: the `launcher.background` settings with the chosen set's `slots` and `revision`, and one picture as `image/jpeg` (404 when there is none). |

`/api/state` carries `tv.model`, `tv.power`, `tv.volume`, and, while the PHI hook answers, `tv.source` (`{type_id,label}`, what is on screen) and `tv.inputs` (the tuner and the four HDMI ports with name, `connected` and `current`). Standby on this TV is suspend-to-RAM, and TitanOS answers `/6/powerstate` with 404, so `tv.power` is `On` whenever the TV answers; a real value from `powerstate` wins, and the 404 is not an error. `tv.screen` is JointSpace's `screenstate`, which reads `Off` while the picture is on, so the dashboard does not use it. `tv.model` starts as `launcher.catalog.model` and is replaced by `RpcModelInfoGet` through the PHI bridge once it answers. A second loop asks the bridge's `sources` method every 10 seconds (3-second wait, so a frozen PHI page costs the poller nothing); `tv.source` and `tv.inputs` are dropped when the last answer is older than 45 seconds.

All `/api/*` routes above need the token when one is set. The hook's own routes (`GET /api/tv/phi/next`, `POST /api/tv/phi/result`) `GET /tvapp` and `GET /api/tvapp` take the TV itself only. The launcher's routes (`/phi-hook.js`, `/launcher`, `/api/launcher/*`, `/launcher/*`, `POST /api/home/diag`) do not, because the TV's own UI cannot send one; see [Security](SECURITY.md#the-launchers-endpoints-have-no-token). Static assets are served with `Cache-Control: no-store`.

## Telemetry

`Sampler` runs every 2 seconds and is best-effort: a missing file leaves a field out. It reads CPU from `/proc/stat` (all cores and each), load and uptime, memory from `/proc/meminfo`, temperatures from `/sys/class/thermal/thermal_zone*`, network rates from `/proc/net/dev` (skipping `lo`), Wi-Fi from `/proc/net/wireless`, storage by `statfs` of `/mtd_rwarea` and `/tmp` (and `/` off Linux), the process count from `/proc`, and its own memory and goroutines. It compiles and returns mostly-empty data on macOS.

## MQTT and Home Assistant

`mqtt` is a minimal MQTT 3.1.1 client over plain TCP: clean session, QoS 0 publishes, subscriptions remembered and re-sent on every connect (with `+` and `#` matching on dispatch), PUBACK for incoming QoS 1, `PINGREQ` on the keep-alive, and a connect loop with back-off from 1 to 30 seconds. `ha` publishes discovery, retained state and availability (with a last will), and handles the command topics; see [Home Assistant](HOME-ASSISTANT.md).

## The launcher stack

* `phi-hook.js` runs inside the TV's PHI page, intercepts Home, shows the launcher in a full-screen iframe and bridges requests from it to PHI's own functions over `postMessage`.
* `launcher/` is the launcher page (an iframe); `routes/launcher*.go` serve its data.
* `titancat` fetches the catalog pages (50 per page, at most 40 pages) and caches them in `var/titan-catalog.json`.
* `netblock` keeps the rules in step with `launcher.block_titanos`.

How it behaves is in [the launcher](launcher.md).

## On-TV scripts

`cactariumctl` is busybox `sh` with no bashisms. `start` refuses if `disabled` exists, opens the port in `iptables` and `ip6tables` (idempotent, `-w 5`), and starts a supervisor subshell that restarts the binary after 5 seconds and gives up after 10 crashes in 60 seconds. `stop` kills the supervisor first, then the server. `status` exits non-zero when the server is not running. `boot` waits for `/tmp/ntkdriver_completed` (up to 60 s) plus 8 seconds, then starts. Logs rotate by copy-and-truncate at 1 MB.

`deploy.sh` streams files with `ssh ... 'cat > file'` (no scp), verifies the sha256 on the TV and renames atomically. See [Installing](install.md#deploysh).

## Platform notes

* The vendor boot script runs `chmod 777 -R /mtd_apdat/` every boot.
* `customer_env.sh` is never sourced on this firmware; `root_boot.sh` (run by the `telnetd` wrapper) is the boot hook point.
* The boot firewall drops inbound traffic by default.
* A plain `reboot` does not work (BusyBox init never leaves sysinit); `reboot -f` after `sync` does.
* Standby is suspend-to-RAM: the TV's UI page and its timers freeze while the wall clock keeps going, which is how the hook notices a wake.
