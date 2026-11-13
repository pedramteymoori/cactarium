# What Cactarium changes on the TV

Nothing on the TV's read-only root filesystem is written. Everything here is
verified against `server/deploy.sh`, `server/cactariumctl` and the server's
code, on the 55PUS8450/12 (TPN256E_V056.010.032.001).

## Files and startup

`server/deploy.sh <tv-ip>` creates `/mtd_rwarea/apdat/opt/cactarium/` and puts in it:

| Path | What it is |
| :--- | :--- |
| `cactarium` | The server binary (mode 755), replaced atomically on each deploy. |
| `cactariumctl` | Start, stop, restart, status, boot and port. |
| `config.json` | Settings, created by the server on first run, mode 0600, never overwritten by `deploy.sh`. |
| `var/cactarium.log` | The log, rotated at 1 MB with one `.1` kept. |
| `var/boot.log` | Output of the boot hook's start. |
| `var/cactarium.pid`, `var/supervisor.pid` | Process ids. |
| `var/titan-catalog.json` | Cache of the TitanOS app catalog. |
| `var/titan-icons/` | Cached app icons (`<code>.webp`). |
| `var/home-wallpapers/` | The launcher's background pictures: `sets/<landscape\|abstract>/<time of day>.jpg` (downloaded when a set is chosen, about 820 KB, only the chosen set kept) and `own/<time of day>.jpg` (uploaded from the dashboard, up to 5 MB each, so up to 20 MB). Files are mode 0600, written through a temporary file and renamed. |
| `var/debug.secret` | Created only when `launcher.debug` is on (mode 0600). |
| `disabled` | The kill switch, only if you create it. |

`cactariumctl start` runs a supervisor in the background that restarts the server after 5 seconds and gives up after 10 crashes within 60 seconds. It only signals processes whose pid files and `/proc` command lines match.

`--uninstall` copies `config.json` to `/mtd_rwarea/apdat/cactarium-config.json.bak` (mode 600) before deleting the folder.

On this firmware the vendor boot script runs `chmod 777 -R /mtd_apdat/` at every boot, so the files above are world-writable on the TV. See [Security](SECURITY.md#the-config-file-is-readable-by-every-process-on-the-tv).

## Boot hook

Only with `--enable-boot`. The vendor boot script runs `/swdl/telnet/telnetd`, a wrapper that runs `/mtd_rwarea/apdat/root_boot.sh &`. `deploy.sh` inserts this block into `root_boot.sh`, directly before the line `[ -f "$BASE/busybox" ] || die "missing $BASE/busybox"`:

```sh
# --- cactarium: start the dashboard server. Delete this block to stop it at boot. ---
if [ -f "$OPT/cactarium/cactariumctl" ]; then
    /bin/mkdir -p "$OPT/cactarium/var" 2>/dev/null
    /bin/sh "$OPT/cactarium/cactariumctl" start </dev/null >>"$OPT/cactarium/var/boot.log" 2>&1 &
fi
# --- end cactarium ---
```

Before writing it takes a backup, `root_boot.sh.bak-before-cactarium-<timestamp>`, builds a `.new` file, checks it with `sh -n`, and moves it into place (mode 755). It fails without changes if the file or the anchor line is missing. `--disable-boot` removes the marked block the same way. It also removes a leftover `# cactarium` line from `customer_env.sh` (with a `.bak-cactarium-<timestamp>` backup), which earlier versions added; that file is never sourced on this firmware.

## Network

* **Inbound.** `cactariumctl start` adds `INPUT -p tcp --dport <port> -j ACCEPT` (at position 1, only if absent) with `iptables -w 5` and `ip6tables -w 5`, because the TV's boot firewall drops inbound traffic. The rule does not survive a reboot; the next start adds it again. `<port>` is read from `listen` in `config.json` (default 8090).
* **Outbound, always.** The server talks to the TV's own JointSpace API (`127.0.0.1:1925` and `:1926`). Nothing else leaves the TV unless a feature below is on.
* **Outbound, optional.** The MQTT broker you set. The TitanOS catalog and icons from `eu.app.titanos.tv` and titanos.tv image hosts, read once a day, only when `launcher.apps` is used and the catalog model and firmware are set. `raw.githubusercontent.com` for the launcher's wallpaper sets (four pictures from the glasshouse-wallpapers `v2` tag, once, when a set is chosen on the dashboard; each is checked against a pinned SHA-256). `api.open-meteo.com` for the weather badge, at most once per 30 minutes, only when a location is set. The server is pointed at the TV's own certificate bundle (`/etc/ssl/cacert.pem`) for these requests.
* **The TitanOS block.** With `launcher.block_titanos` on, the server adds `OUTPUT` rules, tagged with the comment `cactarium-block-titanos`, with `iptables` and `ip6tables`: five rules that reject DNS queries (UDP and TCP port 53) for the exact name `app.titanos.tv` and TLS connections (port 443) whose server name is `app.titanos.tv`. They are checked and added at every server start and on every settings change, removed when the setting is off, and gone after a reboot until the next start. Other titanos.tv hosts (sign-in, API, the catalog) are not matched. Rules from earlier versions, which also matched `eu.app.titanos.tv`, are removed.

## JointSpace pairing

Pairing registers a device named "Cactarium" (app id `app.cactarium`) with the TV. The credentials it returns are stored in `config.json`. **Forget** in the dashboard clears them from the config; it does not remove the device from the TV.

## The Home-button launcher

Only with `--install-home`. All of it lives under `/swdl/UI` (plus `/tmp` while installing):

1. The vendor boot script bind-mounts `/swdl/UI/page` over `/mtd_apexe/board/mframework/webui/PHI/page`, but only if `/swdl/UI` exists.
2. `--install-home` checks the public `/api/launcher/enabled` endpoint (so a configured API token does not block installation) and that `/swdl` has at least 400 MB free, refuses if the page is already mounted from somewhere, copies the stock page tree to `/swdl/UI.tmp/page`, relabels it with `chcon -R -t default_t` (the browser cannot read the unlabeled files `/swdl` has by default, and the policy allows it to read `default_t`), and verifies that the entry count, the contents (md5) and every label match.
3. It saves the stock `index.html` as `/swdl/UI/index.html.orig` and adds one inline loader script directly before `</body>` of the copy. The loader fetches `http://localhost:<port>/phi-hook.js` with a fresh URL each time and retries every 5 seconds for 5 minutes while Cactarium is still starting.
4. It moves the finished copy to `/swdl/UI`. On any failed check `/swdl/UI` is left absent.

A **cold boot** (unplug the TV from AC for 10 seconds) is required for the mount, and for a changed `index.html`. `--remove-home-line` restores `index.html` from `index.html.orig`; `--remove-home` deletes `/swdl/UI`. The script only ever deletes the exact path `/swdl/UI`.

At runtime the hook (inside the TV's UI) calls the TV's own functions: it opens PHI's blank page, Settings and Sources, switches inputs and launches apps. For the dashboard it also runs the allowlisted functions the server queues (picture, sound and general settings, and the TV's restart). If the TV's restart does not answer within 3 seconds or does not take effect within 20 seconds, the server runs `sync` and `reboot -f`, since a plain `reboot` does not work on this firmware.

At start the server deletes `launcher-recent.json` next to `config.json`, left by versions that had the launcher's recent row.

The server reads icon files from an allowlist of read-only directories on the TV (PHI's page tree, the browser's icon folders, and `/mtd_rwarea/apdat/IHS/`, never the rest of `apdat` where the config lives).

## Changes that stay

* The pairing entry on the TV.
* The `root_boot.sh` backups and, after `--uninstall`, `cactarium-config.json.bak`.
* Firewall rules last until the next reboot.
