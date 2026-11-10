# Updating and uninstalling

```bash
server/deploy.sh <tv-ip> --status    # server state, port, last log lines, boot hook
server/deploy.sh <tv-ip> --logs      # last 100 log lines
```

On the TV, `/mtd_rwarea/apdat/opt/cactarium/cactariumctl {start|stop|restart|status}` does the same locally. Logs are in `var/cactarium.log`, rotated at 1 MB with one `.1` kept.

## Updating

Pull the latest code into the clone and deploy again:

```bash
cd cactarium
git pull
server/deploy.sh <tv-ip>
```

Only the binary and `cactariumctl` are replaced, atomically, after a sha256 check on the TV. `config.json` and the `var/` folder are kept. The server version is `git describe` of the clone (`-dirty` when there are uncommitted changes), shown in the Server tab.

A new `phi-hook.js` is part of the binary. It is fetched without caching, so it is picked up the next time the TV's UI page loads. The copy of the page under `/swdl/UI` only holds a one-line loader; it does not need updating unless the port changed (re-run `--install-home`, then cold boot).

There is no self-update and no rollback: deploy an earlier commit to go back.

## Starting at boot

```bash
server/deploy.sh <tv-ip> --enable-boot
server/deploy.sh <tv-ip> --disable-boot
```

Both are idempotent and make a timestamped backup of `root_boot.sh` first. See [what it changes on the TV](TV-CHANGES.md#boot-hook).

## Uninstalling

```bash
server/deploy.sh <tv-ip> --remove-home     # only if you installed the launcher; then cold boot
server/deploy.sh <tv-ip> --uninstall
```

`--uninstall` stops the server, removes the boot block and `/mtd_rwarea/apdat/opt/cactarium/`, and keeps your config at `/mtd_rwarea/apdat/cactarium-config.json.bak`. It refuses to delete the install directory if the boot block could not be removed. If the launcher block is on (`launcher.block_titanos`), the firewall rules disappear at the next reboot; to remove them at once, turn the setting off in config before uninstalling, or reboot.

Remove the launcher first: `--remove-home` deletes `/swdl/UI`, and the stock page tree returns after a **cold boot** (unplug the TV from AC for 10 seconds).

Nothing on the TV's read-only rootfs is ever modified. [What it changes on the TV](TV-CHANGES.md) lists everything else, including what uninstalling leaves behind.

## If something goes wrong

* **Kill switch.** `touch /mtd_rwarea/apdat/opt/cactarium/disabled` stops the supervisor and prevents starts, including at boot. Remove the file to re-enable.
* **The TV misbehaves at boot.** Log in over SSH (or telnet if you use it) and delete the block from `# --- cactarium` through `# --- end cactarium ---` in `/mtd_rwarea/apdat/root_boot.sh`, or restore a `root_boot.sh.bak-before-cactarium-*` backup.
* **Home does nothing, or shows a broken launcher.** Press Home twice quickly for the stock TitanOS home. To switch the launcher off without a reboot, choose TitanOS Home on the Home tab (`launcher.enabled`); it takes effect on the next Home press. If Cactarium is down or unreachable, the hook stays disabled and Home is stock.
* **The TitanOS menus are empty or broken.** Run `server/deploy.sh <tv-ip> --remove-home`, then cold boot.
* **No SSH.** Re-establish SSH access with the tools you used to get it, then `rm -rf /swdl/UI` and cold boot. Cactarium cannot help without SSH.
