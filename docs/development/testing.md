# Testing

There is no CI service configured; everything runs locally.

## Every check that needs no TV

```bash
sh scripts/check-all.sh
```

It runs, in order, and stops at the first failure:

1. `gofmt -l server`: fails and lists any file that needs formatting.
2. `go vet ./...`
3. `go test ./...`
4. `sh -n` on every `*.sh` file under `server/` and `scripts/` and on `server/cactariumctl`, so a syntax error in the scripts that run on the TV is caught here.

It ends with `check-all: ok`. `make check` runs the same script.

## Make targets

| Target | What it does |
| :--- | :--- |
| `make test` | `go test ./...` |
| `make vet` | `go vet ./...` |
| `make check` | `sh scripts/check-all.sh` |
| `make build` | A host binary in `dist/cactarium`. |
| `make dist` | `dist/cactarium-linux-arm64` and `dist/cactarium-linux-armv7`, static, version from `git describe`. |
| `make run` | Dashboard on `:8090` with `./dev-config.json`, no TV. |
| `make run TV=<tv-ip>` | The same, talking to a real TV over the LAN. |
| `make clean` | Removes `dist/`. |

## Unit tests

Each package has tests beside the code: `config` (defaults, atomic save), `jointspace` (Digest, pairing, typed calls against a fake server), `mqtt` (a fake broker), `ha` (discovery and commands), `telemetry`, `titancat` (paging and cache), `netblock` (the rule set, with the command runner replaced so no real `iptables` runs), and `routes` (the API, auth, launcher endpoints, icons, weather, the PHI bridge). Tests take clocks, network access and commands as parameters and need no TV.

## The dashboard in a browser

```bash
make run                 # no TV: the TV shows as unreachable
make run TV=<tv-ip>      # against a real TV
```

Open `http://localhost:8090/`. The launcher page also renders on its own at `/launcher`, using its built-in lists, for a desktop browser check.

## Documentation

```bash
mkdocs build --strict
```

builds the site with warnings as errors (see "Previewing documentation locally" in [Contributing](../CONTRIBUTING.md)). It is not part of `check-all.sh`.

## Talking to the TV

These helpers need SSH to the TV (port 2222, key authentication). Set `TV=<tv-ip>`; `SSH_PORT` and `SSH_USER` override the login.

* `scripts/tv.sh [command ...]`: runs a command on the TV, or opens a shell.
* `scripts/key.sh Home Back Confirm ...`: presses JointSpace keys through Cactarium (`POST /api/key`), 1.2 seconds apart. `TV_PORT` sets the port (default 8090). If the server has a token, `key.sh` does not send one, so use a token-free test setup or `curl` directly.
* `scripts/phijs.sh 'return document.title'`: runs JavaScript inside the TV's PHI page through the launcher's debug channel and prints the result. Needs `launcher.debug` on. The script reads the debug secret from the TV at run time; nothing secret is in the repository. The code that runs there can call the TV's internal functions, so use it with care.
* `server/deploy.sh <tv-ip> --status | --logs | --home-status`: server, log and launcher state without a shell.

For hook work, the diagnostic reports the hook posts are at `GET /api/home/diag` (the last 200).

## Testing on a real TV

Deploy the branch, then try the change with the remote. For the launcher: install, cold boot, then check Home, double Home, Back, an app, an input, Settings and a wake from standby. State the TV and firmware in your pull request.

## Launcher preflight with an API token

On 77OLED760/12 (TPN258E, firmware 058.010.032.001), the original
`--install-home` failed because unauthenticated `/api/state` returned 401.
Using the public `/api/launcher/enabled` endpoint allowed installation with
the token retained. `TestLauncherEndpointsNeedNoToken` covers this endpoint.
The owner confirmed the launcher appeared after a cold boot.
