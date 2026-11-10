# Installing

## Quick start

1. Make sure you can `ssh -p 2222 root@<tv-ip>` with a key.
2. Clone this repository on a computer on the same network as the TV.
3. Run `server/deploy.sh <tv-ip>` from the repository root.
4. Open `http://<tv-ip>:8090/` in a browser and pair with the TV in the Server tab.

That's it. The dashboard is ready to use.

## Requirements

* A Philips TitanOS TV that you can already reach over SSH: Dropbear on port 2222 with key authentication, your public key in `/mtd_rwarea/apdat/opt/root_home/.ssh/authorized_keys`, and the install prefix `/mtd_rwarea/apdat/opt` present. Cactarium does not root the TV and does not provide that access; the `philips-titanos-tools` repository describes one way to set it up.
* A computer on the same network to install from, with Go 1.22 or later, `make`, `ssh`, and `shasum` or `sha256sum`. The TV does not need internet access for the dashboard.
* The JointSpace **app secret** (base64) that the TV's pairing needs. It is not shipped with Cactarium; you supply it in the Server tab.

The MQTT bridge also needs an MQTT broker on the network. Home Assistant's Mosquitto add-on is one option.

Tried on: 55PUS8450/12, firmware TPN256E_V056.010.032.001. Nothing else is confirmed.

## Install steps

### 1. Get the files

```bash
git clone <this repository>
cd cactarium
```

### 2. Install the server

Find the TV's address under its network settings, or in the router's list of devices. Then, from the repository root:

```bash
server/deploy.sh <tv-ip>
```

The script connects over SSH, detects the TV's architecture (`aarch64` becomes arm64, `armv7*` and `armv8l` become armv7), builds the matching binary with `make`, uploads it and `cactariumctl` to `/mtd_rwarea/apdat/opt/cactarium/` while checking the sha256 on the TV, restarts the server, and waits up to 10 seconds for it to answer. An existing `config.json` is never overwritten.

> [!TIP]
> **Static IP recommendation:** reserve a fixed DHCP address for the TV in the router so the dashboard address never changes.

### 3. Pair with the TV

Open **`http://<tv-ip>:8090/`**, go to the Server tab, paste the app secret, press **Start pairing**, enter the PIN the TV shows, and press **Finish**. The credentials are saved to `config.json`. See [Server](dashboard/server.md#pairing).

### 4. Start at boot (optional)

By default the server runs until the TV next restarts. To start it at every boot:

```bash
server/deploy.sh <tv-ip> --enable-boot
```

This adds a marked block to the TV's `root_boot.sh`. See [what it changes on the TV](TV-CHANGES.md#boot-hook).

### 5. The launcher (optional)

The Home-button launcher is a separate, opt-in step with a cold boot. See [The launcher](launcher.md#installing).

## deploy.sh

```text
server/deploy.sh <tv-ip> [--enable-boot|--disable-boot|--uninstall|--status|--logs]
server/deploy.sh <tv-ip> [--install-home|--remove-home|--remove-home-line|--home-status]
```

With no action it builds and installs. Only one action is allowed per run.

| Flag | What it does |
| :--- | :--- |
| *(none)* | Build, upload, verify the sha256, restart, wait for the server to answer. |
| `--status` | Shows the supervisor and server state, the port, the last log lines, and whether the boot hook is enabled. |
| `--logs` | Prints the last 100 lines of `var/cactarium.log`. |
| `--enable-boot` | Inserts the boot block into `root_boot.sh`. Needs Cactarium installed first. |
| `--disable-boot` | Removes that block (and an old `customer_env.sh` line from earlier versions). |
| `--uninstall` | Stops the server, removes the boot block and the install directory, keeps the config. |
| `--install-home` | Installs the Home-button launcher hook. See [The launcher](launcher.md#installing). |
| `--home-status` | Reports the page copy, SELinux labels, mount and hook line. |
| `--remove-home-line` | Restores the page copy's `index.html` from `index.html.orig`. |
| `--remove-home` | Removes `/swdl/UI`. |

Environment: `SSH_PORT` (default `2222`) and `SSH_USER` (default `root`). Authentication is by key only; the script never prompts for a password.

```bash
SSH_PORT=22 SSH_USER=root server/deploy.sh <tv-ip>
```

On the TV, `/mtd_rwarea/apdat/opt/cactarium/cactariumctl {start|stop|restart|status|boot|port}` controls the server.

## Configuration

Settings live in `/mtd_rwarea/apdat/opt/cactarium/config.json`, written by the server (mode 0600, atomic). Most can be changed in the [dashboard](dashboard/index.md). Edit the file with the server stopped or restart it afterwards.

| Property | Default | Description |
| :--- | :--- | :--- |
| `name` | `"Philips TV"` | Display name, used by the dashboard and Home Assistant. |
| `listen` | `":8090"` | Listen address and port. 8080 is avoided because another process on this firmware holds it. `cactariumctl` reads the port from here for the firewall rule. |
| `token` | `""` | Optional access token for the API. See [Security](SECURITY.md#set-a-token). |
| `device_id` | random | Eight hex characters made on first run; part of the MQTT topics. |
| `jointspace.host` | `"127.0.0.1"` | The TV's JointSpace host (the `-tv` flag overrides it for development). |
| `jointspace.user` / `pass` | unset | Pairing credentials, written by pairing. |
| `jointspace.app_secret` | unset | The base64 app secret you supplied. |
| `mqtt.enabled` | `false` | Enables the [Home Assistant bridge](HOME-ASSISTANT.md). |
| `mqtt.host` / `port` | `""` / `1883` | Broker address. |
| `mqtt.user` / `pass` | unset | Broker credentials. |
| `mqtt.prefix` | `"cactarium"` | Root of the state and command topics. |
| `mqtt.discovery_prefix` | `"homeassistant"` | Home Assistant discovery prefix. |
| `mqtt.interval` | `10` | Seconds between state publishes. |
| `launcher.enabled` | `true` | Whether Home shows Cactarium's launcher (once the hook is installed). |
| `launcher.layer` | `"page"` | How the hook brings the launcher in front: `"page"` or `"state"`. See [the launcher](launcher.md). |
| `launcher.weather.latitude` / `longitude` | unset | Location for the weather badge. Both or neither. |
| `launcher.apps` | `[]` | Codes from the TitanOS catalog for the Apps row, in order (`"tv"` is skipped; the TV input is in the Inputs row). Empty uses the TV's own app list. |
| `launcher.background.kind` | `"none"` | `"none"` (black), `"pictures"` or `"animated"`. See [Background](dashboard/home.md#background). |
| `launcher.background.pictures` | `"landscape"` | `"landscape"` or `"abstract"` (downloaded sets), or `"own"` (uploaded pictures). |
| `launcher.background.animation` | `"waves"` | `"waves"`, `"particles"`, `"aquarium"`, `"aurora"`, `"glow"`, `"constellations"` or `"ripples"`. |
| `launcher.background.colours` | `"time"` | `"time"`, `"night_blue"`, `"sunset"`, `"emerald"`, `"ember"`, `"silver"` or `"own"`. |
| `launcher.background.own_colours` | `{"background":"#0a1f5c","light":"#4f8dff"}` | The two `#rrggbb` colours behind `colours` `"own"`. |
| `launcher.background.darkening` | `100` | 0 to 100, how dark the background is behind the clock and rows (the dashboard steps by 5). |
| `launcher.catalog.market` / `locale` | `"NL"` / `"nl"` | Which catalog to read. |
| `launcher.catalog.model` / `firmware` | unset | Required before the catalog is fetched. |
| `launcher.block_titanos` | `false` | Blocks `app.titanos.tv`. See [the launcher](launcher.md#blocking-the-titanos-cloud-launcher). |
| `launcher.debug` | `false` | Turns on the hook's [debug channel](development/testing.md#talking-to-the-tv). |

### Server flags

```text
cactarium [-config path] [-listen addr] [-tv host] [-version]
```

`-config` defaults to the TV's config path when that directory exists, otherwise `./config.json`.

## Troubleshooting

* **"cannot ssh to ... (key auth required)".** `deploy.sh` uses `BatchMode`, so it cannot type a password. Check the port (`SSH_PORT`), the user, and that your key is in `authorized_keys` on the TV.
* **"unsupported TV architecture".** The script handles `aarch64` and `armv7*`/`armv8l` only.
* **"server did not answer within 10 s".** The script prints the last log lines. `server/deploy.sh <tv-ip> --status` and `--logs` show more.
* **Nothing on port 8090 from another device.** `cactariumctl start` opens the port in `iptables` and `ip6tables`; check `--status` for "port 8090: listening". The TV's boot firewall drops other inbound traffic.
* **The dashboard says the TV is not paired.** Pair in the Server tab. If pairing fails, check the app secret.
* **A launcher problem after a firmware update.** Use the kill switch and recovery steps in [Updating and uninstalling](managing.md#if-something-goes-wrong).
