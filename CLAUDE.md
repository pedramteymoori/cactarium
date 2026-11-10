# Working conventions

## Branch, don't commit to the default branch

Work on a branch, not `main`. Commit
only when asked, and never force-push or rewrite history others may have.
Merging is the maintainer's call.

## Docs move with the change

A change updates the docs that describe it, in the same change, before it is
committed:

- CI, tests or `scripts/`: docs/development/testing.md.
- Something the dashboard shows or does: docs/dashboard/ for that tab.
- The launcher, the PHI hook, the app row or the TitanOS block: docs/launcher.md.
- The Home Assistant bridge: docs/HOME-ASSISTANT.md.
- Anything the server or `deploy.sh` changes on the TV: docs/TV-CHANGES.md.
- A config key: docs/install.md (the config tables) and docs/IMPLEMENTATION.md.
- What contributors must do differently: docs/CONTRIBUTING.md.

## Never commit firmware or device dumps

Files pulled from the TV (Philips firmware, boot scripts, browser files,
`strings` output, process lists) stay
on the computer and stay ignored by `.gitignore`. Our own notes go in
docs/development/. Quote short excerpts there when a finding needs one; do not
copy whole files in.

## Redact what identifies a TV or a person

Docs, commit messages, logs pasted into issues and test fixtures must not
carry the TV's address, device IDs, JWTs, the JointSpace app secret, pairing
credentials (`jointspace.user` / `pass`), MQTT passwords, the access token or
`var/debug.secret`. Use `<tv-ip>`, `<token>` and so on. The TitanOS home-app
address carries a JWT and a device id: quote only its host and path.

## No rooting, no exploits

Cactarium assumes SSH to the TV already exists and works. It does not root a
TV, ship or describe an exploit, bypass SELinux, or touch the read-only rootfs.
Where SELinux gets in the way, work within the policy (the page copy under
`/swdl/UI` is relabelled `default_t`, which the policy allows) and say so in
the docs. The JointSpace app secret
is supplied by the owner and never committed or hardcoded.

# Code map

The server is one Go program (module `cactarium`, Go 1.22, standard library
only) built static for the TV with `CGO_ENABLED=0`: `make dist` writes
`dist/cactarium-linux-arm64` and `dist/cactarium-linux-armv7`. The same code
runs on a Mac or Linux box for development (`make run`).

- `server/cactarium.go` - entry point: flags (`-config`, `-listen`, `-tv`,
  `-version`), the 48 MiB memory limit, wiring of the packages below, the TV's
  CA bundle for HTTPS and the `netblock` sync at start.
- `server/ha.go` - `haRunner`: starts and restarts the MQTT client and the
  Home Assistant bridge when the settings change.
- `server/lib/config` - the JSON config, defaults, and atomic save (0600).
- `server/lib/jointspace` - the TV's JointSpace client: HTTP Digest, pairing,
  typed calls for keys, power, volume, sources and Ambilight.
- `server/lib/telemetry` - the `/proc` and `/sys` sampler behind `/api/stats`.
- `server/lib/mqtt` - a small MQTT 3.1.1 client. `server/lib/ha` - the Home
  Assistant bridge on top of it (discovery, state, commands).
- `server/lib/routes` - every HTTP route, token auth, the state cache and
  poller, pairing, settings, and the launcher's endpoints
  (`launcher*.go`: enabled flag, apps, icons, weather, debug), and the PHI bridge
  (`phi_bridge.go`, `phi_allow.go`) with `POST /api/tv/reboot`.
- `server/lib/titancat` - the TitanOS public app catalog and its cache.
  `server/lib/netblock` - the iptables rules that block `app.titanos.tv`.
- `server/assets/` - everything embedded into the binary (`embed.go`): the
  dashboard (`ui.html`, with its CSS and one script per tab in `ui/`),
  `fonts/`, `phi-hook.js` (loaded by the
  TV's PHI page), `launcher/` (the launcher page) and `tvapp/` (the TV app).
- `server/cactariumctl` - start, stop, restart, status and boot on the TV
  (busybox `sh`). `server/deploy.sh` - build and install over SSH, including
  the boot hook and the Home-button install. Both are POSIX `sh`.
- `scripts/` - `check-all.sh` (every check that needs no TV), and `tv.sh`,
  `phijs.sh`, `key.sh` for working with a TV.
- `docs/` - this documentation (built with mkdocs, `mkdocs.yml`).

Before committing, run `sh scripts/check-all.sh`: `gofmt -l server`,
`go vet ./...`, `go test ./...` and `sh -n` on every shell script. Tests
follow "Tests" in docs/CONTRIBUTING.md.

# Working with a TV

`TV=<tv-ip> scripts/tv.sh [command]` opens SSH to the TV (port 2222, key
authentication; `SSH_PORT` and `SSH_USER` override). `scripts/key.sh` presses
JointSpace keys through Cactarium; `scripts/phijs.sh` runs JavaScript inside
the TV's PHI page through the launcher's debug channel.

- Cactarium lives in `/mtd_rwarea/apdat/opt/cactarium/`: `config.json`, the
  binary, `cactariumctl`, and `var/` (logs, pid files, caches). Its log is
  `var/cactarium.log`. `server/deploy.sh <tv-ip> --status` and `--logs` show
  both without a shell.
- Port 8090 by default (8080 is held by another process on this firmware).
- A change to `phi-hook.js` is picked up on the next load of PHI's page; the
  hook is fetched with no caching. A change to the copy of the PHI page under
  `/swdl/UI` needs a cold boot (unplug the TV from AC for 10 s).
- The launcher debug channel is off by default (`launcher.debug`), accepts
  posts only from the TV itself and needs the secret in `var/debug.secret`.
  Never paste that secret anywhere.
- Standby on this TV is suspend-to-RAM: the PHI page and the hook's timers
  freeze, and the hook detects a wake-up from a gap in its clock tick.

For background, open the doc for the area rather than README.md:
docs/IMPLEMENTATION.md (how each part works), docs/launcher.md (the launcher
and the PHI hook), docs/HOME-ASSISTANT.md, docs/TV-CHANGES.md (what the server
and `deploy.sh` change on the TV) and docs/SECURITY.md.

# Writing conventions

Applies to commit messages, release notes, README and docs.

## Keep it short

State what changed and why. Stop. Length should track the size of the change,
not the effort behind it. A one-line fix gets one line.

## Don't narrate the work

No process commentary: what was tried, what was ruled out. Record decisions
and their reasons, not the route taken to reach them. Keep the measured facts
that justify a decision (an observed value, a firmware version, a threshold),
and label research claims as verified on the TV, inferred, or unknown.

## Third person in commits and release notes

Commit messages and release notes are project artefacts, not messages to a
reader. Never "you", "your TV". Write "the TV", "the launcher". The README and
the docs may address the reader as "you".

## No filler structure

Don't add headings, tables or bullet lists to a short change. Tables are for
genuine matrices, not for restating three sentences. Don't list things that
did not change.

## Comments in code

Explain why, where a reader would otherwise wonder or get it wrong: a firmware
quirk, a non-obvious ordering constraint, a value that looks wrong but isn't.
Skip comments that restate the code.

## Names in code

Name a function, or anything used beyond a few lines, for what it does. Short
names are fine for locals used within a few lines.

## The TV and its software

Name the TV and firmware a statement was checked on (55PUS8450/12,
TPN256E_V056.010.032.001). The platform's names are TitanOS (the TV's OS),
PHI (its native web UI), JointSpace (its local REST API) and the TitanOS cloud
launcher (`app.titanos.tv`, internally `saphilauncher`).
