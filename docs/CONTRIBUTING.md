# Contributing to Cactarium

Contributions are welcome. This guide outlines how to propose changes and what to check before you do.

## Core principles

* **You own the glass:** the project gives owners control over their TV without cloud dependencies or tracking. No telemetry or analytics are collected.
* **Keep the TV lightweight:** the TV's CPU and RAM are shared with video decoding. The server sets a 48 MiB memory limit and must stay lean and free of unnecessary background work.
* **Standard library only:** the server is one static Go binary with no third-party modules and no runtime dependencies on the TV.
* **No rooting, no exploits:** Cactarium assumes SSH already exists. Changes that root a TV, ship an exploit, or bypass SELinux will not be accepted.

## Working conventions

### Branch, don't commit to the default branch

1. Create a branch.
2. Make changes, keeping commits focused.
3. Open a pull request. If it needs follow-up, push to the same branch.

### Commit messages

State what changed and why, concisely, in the third person ("the launcher", "the TV"). If you are using AI coding assistants, make sure they follow `CLAUDE.md` (symlinked as `AGENTS.md`).

### Never commit firmware or device dumps

Raw files pulled from a TV (firmware, boot scripts, browser files, `strings` output) never go into this repository; `research/` is ignored for them. Quote only short excerpts where a comment or doc needs one.

### Redact

Remove the TV's address, device ids, JWTs, pairing credentials, MQTT passwords, the app secret, the access token and `var/debug.secret` from anything you commit or paste in an issue.

## Rules for a pull request

Keep a pull request in draft while any of these that applies is unmet.

* **Tried on a real TV**, with the TV model, the firmware version, what was done and what was seen, and what was not tested, in the description. A docs-only change needs no TV testing.
* **Checks pass:** `sh scripts/check-all.sh`.
* **Tests** for new logic (below).
* **Docs updated** in the same change: see "Docs move with the change" in `CLAUDE.md`.
* **No new dependencies.**

## Guidelines

### Code

* Format with `gofmt`; keep `go vet` clean.
* Name things for what they do. Comments explain why, not what.
* Anything that touches the TV's boot script, its filesystem or its firewall must be idempotent, back up what it edits, check its result, and have an undo in `deploy.sh`.
* Keep the launcher and hook defensive: `phi-hook.js` must never break the TV's UI. Everything in it is wrapped, every capability is probed at the moment of use, and an unreachable Cactarium means stock Home.
* The dashboard works in a modern browser with no build step and no CDN (the TV's network may be offline). The launcher and hook run in the TV's own browser, so keep them plain, older-style JavaScript.

### Tests

* Table-driven tests with the standard `testing` package, next to the code.
* Take clocks, commands and network access as parameters so tests do not wait on real time or touch real iptables.
* Keep a new test fast (well under a second).

## Environment

* Go 1.22 or later, `make`, `ssh`, and `shasum` or `sha256sum`.
* To preview the dashboard with no TV: `make run`; against a TV on the network: `make run TV=<tv-ip>`. This uses `./dev-config.json`, which is git-ignored.
* To build the TV binaries: `make dist`.

## Running tests and verification

```bash
sh scripts/check-all.sh   # gofmt, go vet, go test ./..., sh -n on every shell script
make test vet             # go test and go vet only
```

See [Testing](development/testing.md).

### Previewing documentation locally

```bash
pip install mkdocs-material mkdocs-github-callouts
mkdocs serve
```

`mkdocs build --strict` must pass.

## Testing on a real TV

A change that touches the TV needs a real test: deploy the branch with `server/deploy.sh <tv-ip>` and try it. Say in the pull request which TV and firmware, and attach `server/deploy.sh <tv-ip> --logs` output with the TV's address and any ids removed.

### If you can't test on the right TV

Say so in the pull request. The only confirmed TV is the 55PUS8450/12 on firmware TPN256E_V056.010.032.001, so a report from any other TitanOS TV, even "it did not work, and here is the log", is useful.
