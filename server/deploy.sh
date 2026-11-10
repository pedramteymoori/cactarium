#!/bin/sh
# Build and install Cactarium on a rooted Philips TV over SSH (POSIX sh).
# Usage: server/deploy.sh <tv-ip> [--enable-boot|--disable-boot|--uninstall|--status|--logs]
#                             [--install-home|--remove-home|--remove-home-line|--home-status]
# Env:   SSH_PORT (default 2222), SSH_USER (default root)

DIR=/mtd_rwarea/apdat/opt/cactarium
ENV_FILE=/mtd_rwarea/apdat/customer_env.sh   # old approach; only cleaned up
ROOT_BOOT=/mtd_rwarea/apdat/root_boot.sh
CONF_BAK=/mtd_rwarea/apdat/cactarium-config.json.bak

die() { echo "deploy: $*" >&2; exit 1; }

usage() {
  echo "usage: $0 <tv-ip> [--enable-boot|--disable-boot|--uninstall|--status|--logs]" >&2
  echo "       $0 <tv-ip> [--install-home|--remove-home|--remove-home-line|--home-status]" >&2
  exit 2
}

HOST=
ACTION=deploy
for a in "$@"; do
  case "$a" in
    -h|--help) usage ;;
    --enable-boot|--disable-boot|--uninstall|--status|--logs|--install-home|--remove-home|--remove-home-line|--home-status)
      [ "$ACTION" = deploy ] || { echo "deploy: only one action allowed" >&2; usage; }
      ACTION=${a#--} ;;
    -*) echo "deploy: unknown option $a" >&2; usage ;;
    *) [ -z "$HOST" ] || { echo "deploy: unexpected argument $a" >&2; usage; }
       HOST=$a ;;
  esac
done
[ -n "$HOST" ] || usage

cd "$(dirname "$0")/.." || die "cannot cd to repo root"

command -v ssh >/dev/null 2>&1 || die "ssh not found"

CTL=$(mktemp -d /tmp/cactarium-deploy.XXXXXX) || die "mktemp failed"
SSH_TARGET="${SSH_USER:-root}@$HOST"
# One multiplexed connection for the whole run.
SSH_OPTS="-p ${SSH_PORT:-2222} -o ConnectTimeout=8 -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ControlMaster=auto -o ControlPath=$CTL/cm -o ControlPersist=60"

cleanup() {
  # shellcheck disable=SC2086  # SSH_OPTS is a deliberate word list
  ssh $SSH_OPTS -O exit "$SSH_TARGET" >/dev/null 2>&1
  rm -rf "$CTL"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# r CMD...: run a command on the TV.
r() {
  # shellcheck disable=SC2086
  ssh $SSH_OPTS "$SSH_TARGET" "$@"
}

# Check connectivity once, with a readable error.
r true >/dev/null 2>&1 || die "cannot ssh to $SSH_TARGET on port ${SSH_PORT:-2222} (key auth required; see README prerequisites)"

local_sha() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  elif command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else die "need shasum or sha256sum locally"; fi
}

# upload LOCAL REMOTE_PATH MODE: stream, verify sha256 on the TV, mv atomically.
upload() {
  want=$(local_sha "$1")
  r "cat > '$2.new'" < "$1" || die "upload of $1 failed"
  got=$(r "sha256sum '$2.new'" | cut -d' ' -f1)
  if [ "$got" != "$want" ]; then
    r "rm -f '$2.new'"
    die "sha256 mismatch for $1 (local $want, TV ${got:-none})"
  fi
  r "chmod $3 '$2.new' && mv -f '$2.new' '$2'" || die "could not install $2"
}

# Remote helper: remove the old "# cactarium" line from customer_env.sh, which
# an earlier version of this script added (this firmware never sources that
# file). Backup first, sh -n before replacing. arg1 = env file.
remove_env_line() {
  r /bin/sh -s -- "$ENV_FILE" <<'REMOTE'
F=$1
[ -f "$F" ] || exit 0
grep -q 'cactarium/boot.sh.*# cactarium$' "$F" || exit 0
stamp=$(date +%Y%m%d%H%M%S)
grep -v 'cactarium/boot.sh.*# cactarium$' "$F" > "$F.new.cactarium"
sh -n "$F.new.cactarium" || { rm -f "$F.new.cactarium"; echo "sh -n failed, left $F untouched"; exit 1; }
cp -p "$F" "$F.bak-cactarium-$stamp" || { rm -f "$F.new.cactarium"; exit 1; }
cat "$F.new.cactarium" > "$F" && rm -f "$F.new.cactarium"
echo "old customer_env.sh line removed (backup: $F.bak-cactarium-$stamp)"
REMOTE
}

# On this firmware /swdl/telnet/telnetd (run by the vendor boot script) runs
# /mtd_rwarea/apdat/root_boot.sh &, so a marked block in root_boot.sh is the
# boot hook. The remote scripts below run under busybox sh/awk (arg1 = file).

# Remote helper: insert the block before the anchor line. Idempotent.
enable_boot_block() {
  r /bin/sh -s -- "$ROOT_BOOT" <<'REMOTE'
F=$1
[ -f "$F" ] || { echo "$F not found, cannot enable boot" >&2; exit 1; }
if grep -q '^# --- cactarium' "$F"; then echo "boot hook already enabled"; exit 0; fi
ANCHOR='[ -f "$BASE/busybox" ] || die "missing $BASE/busybox"'
if ! grep -qxF "$ANCHOR" "$F"; then
  echo "anchor line not found in $F, not touching it: $ANCHOR" >&2; exit 1
fi
cat > "$F.block.cactarium" <<'BLOCK'
# --- cactarium: start the dashboard server. Delete this block to stop it at boot. ---
if [ -f "$OPT/cactarium/cactariumctl" ]; then
    /bin/mkdir -p "$OPT/cactarium/var" 2>/dev/null
    /bin/sh "$OPT/cactarium/cactariumctl" start </dev/null >>"$OPT/cactarium/var/boot.log" 2>&1 &
fi
# --- end cactarium ---
BLOCK
ANCHOR="$ANCHOR" BLK="$F.block.cactarium" awk '
BEGIN { while ((getline l < ENVIRON["BLK"]) > 0) b = b l "\n" }
!done && $0 == ENVIRON["ANCHOR"] { printf "%s", b; done = 1 }
{ print }' "$F" > "$F.new.cactarium"
rm -f "$F.block.cactarium"
sh -n "$F.new.cactarium" || { rm -f "$F.new.cactarium"; echo "sh -n failed, left $F untouched" >&2; exit 1; }
stamp=$(date +%Y%m%d%H%M%S)
cp -p "$F" "$F.bak-before-cactarium-$stamp" || { rm -f "$F.new.cactarium"; exit 1; }
chmod 755 "$F.new.cactarium" && mv -f "$F.new.cactarium" "$F" || { rm -f "$F.new.cactarium"; exit 1; }
echo "boot hook enabled (backup: $F.bak-before-cactarium-$stamp)"
REMOTE
}

# Remote helper: remove the block (start marker through end marker).
disable_boot_block() {
  r /bin/sh -s -- "$ROOT_BOOT" <<'REMOTE'
F=$1
[ -f "$F" ] || { echo "no $F, nothing to remove"; exit 0; }
if ! grep -q '^# --- cactarium' "$F"; then echo "boot hook not present"; exit 0; fi
if ! grep -qx '# --- end cactarium ---' "$F"; then
  echo "start marker without '# --- end cactarium ---' in $F, left untouched" >&2; exit 1
fi
awk '
/^# --- cactarium/ { skip = 1 }
!skip { print }
/^# --- end cactarium ---$/ { skip = 0 }' "$F" > "$F.new.cactarium"
sh -n "$F.new.cactarium" || { rm -f "$F.new.cactarium"; echo "sh -n failed, left $F untouched" >&2; exit 1; }
stamp=$(date +%Y%m%d%H%M%S)
cp -p "$F" "$F.bak-before-cactarium-$stamp" || { rm -f "$F.new.cactarium"; exit 1; }
chmod 755 "$F.new.cactarium" && mv -f "$F.new.cactarium" "$F" || { rm -f "$F.new.cactarium"; exit 1; }
echo "boot hook removed (backup: $F.bak-before-cactarium-$stamp)"
REMOTE
}

# disable_boot: remove the root_boot.sh block and any old customer_env.sh line.
disable_boot() {
  disable_boot_block || return 1
  remove_env_line
}

# ---- Home-button launcher (see README "Home button launcher") ----
# Remote scripts run under busybox sh/awk on the TV (root, SELinux enforcing).
# They only ever touch /swdl/UI, /swdl/UI.tmp and /tmp/cactarium-idx.new.
# home_lib is the shared function library, prepended to each remote script.
home_lib() {
  cat <<'LIB'
SRC=/mtd_apexe/board/mframework/webui/PHI/page
B=/swdl/UI
T=/swdl/UI.tmp
D=$B/page
O=$B/index.html.orig
NEW=/tmp/cactarium-idx.new

fatal() { echo "FAILED: $*" >&2; exit 1; }
fmd5() { md5sum "$1" | cut -d' ' -f1; }
# An inline loader, not <script src>: the browser reused a cached phi-hook.js
# across a cold boot, so every load gets a fresh URL. It also retries while
# Cactarium is still starting at boot (every 5 s, for 5 minutes).
hook_line() {
  printf '%s' "<script>(function(){var n=0;function l(){var s=document.createElement('script');s.async=true;s.src='http://localhost:$1/phi-hook.js?t='+Date.now();s.onerror=function(){s.parentNode.removeChild(s);if(++n<60)setTimeout(l,5000)};document.body.appendChild(s)}l()})();</script>"
}
coldboot_note() {
  echo "COLD BOOT NEEDED: unplug the TV from AC power for 10 s, then plug it in again."
  echo "(Standby or a soft restart does not remount the page tree.)"
}
# Only ever deletes /swdl/UI, and only when the variable is exactly that.
rm_home() { [ -n "$B" ] && [ "$B" = /swdl/UI ] || fatal "refusing to rm: B='$B'"; rm -rf "$B"; }

# hook_insert FILE PORT: print FILE with the hook line directly before the single
# </body> (same result as sed "s#</body>#<hook>\n</body>#"). Fails if FILE does
# not contain exactly one </body> or already mentions phi-hook.js.
hook_insert() {
  hl=$(hook_line "$2")
  n=$(awk '{ t = $0; n += gsub(/<\/body>/, "", t) } END { print n + 0 }' "$1")
  [ "$n" = 1 ] || { echo "expected exactly one </body> in $1, found $n" >&2; return 1; }
  if grep -q 'phi-hook\.js' "$1"; then echo "$1 already mentions phi-hook.js" >&2; return 1; fi
  HOOK="$hl" awk '
    !done && (i = index($0, "</body>")) {
      print substr($0, 1, i - 1) ENVIRON["HOOK"]; print substr($0, i); done = 1; next }
    { print }' "$1"
}

# label_counts: stdin = "ls -dZ" lines; prints "<type> <count>" per SELinux type.
label_counts() {
  awk '{ t = "?"
         for (i = 1; i <= NF; i++) if ($i ~ /object_r/) {
           n = split($i, a, ":"); for (j = 1; j <= n; j++) if (a[j] ~ /_t$/) t = a[j]; break }
         c[t]++ }
       END { for (t in c) print t, c[t] }'
}
label_summary() { find "$1" -exec ls -dZ {} \; 2>/dev/null </dev/null | label_counts; }
# verify_labels PATH: 0 if every entry under PATH (itself included) is default_t.
verify_labels() {
  want=$(find "$1" | wc -l)
  sum=$(label_summary "$1")
  tot=$(echo "$sum" | awk '{ n += $2 } END { print n + 0 }')
  bad=$(echo "$sum" | awk '$1 != "default_t" { n += $2 } END { print n + 0 }')
  [ "$want" -gt 0 ] && [ "$tot" -eq "$want" ] && [ "$bad" -eq 0 ]
}
tree_md5() { (cd "$1" && find . -type f | sort | xargs md5sum | md5sum | cut -d' ' -f1); }

mounted_any() { awk '$2 ~ /PHI\/page$/ { f = 1 } END { exit !f }' /proc/mounts; }
# True when PHI/page is our copy: same inode through both paths.
mounted_ours() {
  mounted_any && [ -f "$D/index.html" ] && [ -f "$SRC/index.html" ] && [ "$SRC/index.html" -ef "$D/index.html" ]
}
LIB
}

# home_run ARGS...: run stdin (a script body) on the TV after home_lib.
home_run() {
  { home_lib; cat; } | r /bin/sh -s -- "$@"
}

# The port Cactarium listens on (config.json "listen"), default 8090.
tv_port() {
  p=$(r "/bin/sh '$DIR/cactariumctl' port 2>/dev/null" | tr -dc '0-9')
  [ -n "$p" ] || p=8090
  echo "$p"
}

home_install() {
  r "[ -f '$DIR/cactariumctl' ]" || die "Cactarium is not installed on the TV: run server/deploy.sh $HOST first"
  home_run "$(tv_port)" "$DIR" <<'REMOTE'
PORT=$1; CTLDIR=$2
trap 'rm -rf /swdl/UI.tmp /tmp/cactarium-idx.new' EXIT
trap 'exit 1' INT HUP TERM
echo "== preflight"
wget -q -O - "http://127.0.0.1:$PORT/api/state" >/dev/null 2>&1 </dev/null \
  || fatal "Cactarium does not answer on 127.0.0.1:$PORT/api/state"
echo "cactarium answers on :$PORT"
wget -q -O - "http://127.0.0.1:$PORT/phi-hook.js" 2>/dev/null </dev/null | grep -q . \
  || echo "WARNING: /phi-hook.js is not served by this Cactarium build; run server/deploy.sh <ip> first"
command -v chcon >/dev/null 2>&1 || fatal "chcon not found"
echo "SELinux: $( (getenforce 2>/dev/null) || (cat /sys/fs/selinux/enforce 2>/dev/null) || echo unknown) (getenforce, or enforce: 1=enforcing)"
[ -d /swdl ] || fatal "/swdl missing"
free=$(df -Pk /swdl | awk 'END { print $4 }')
echo "free on /swdl: $((free / 1024)) MB"

changed=0
if [ ! -e "$B" ]; then
  # ---- fresh install: copy, relabel, verify, then move into place ----
  case "$free" in ''|*[!0-9]*) fatal "cannot read free space on /swdl" ;; esac
  [ "$free" -ge 409600 ] || fatal "need at least 400 MB free on /swdl"
  if mounted_any; then
    fatal "PHI/page is mounted but $B does not exist (removed without a cold boot?). Cold boot first (unplug 10 s), then retry. The source path shows our copy while mounted, so copying now would be wrong."
  fi
  [ -f "$SRC/index.html" ] || fatal "$SRC/index.html not found"
  if grep -q 'phi-hook\.js' "$SRC/index.html"; then fatal "stock $SRC/index.html already mentions phi-hook.js"; fi
  echo "== copying $SRC -> $T/page"
  rm -rf "$T"
  mkdir -p "$T" || fatal "cannot create $T"
  cp -rp "$SRC" "$T/page" || fatal "copy failed"
  sync
  echo "== relabel to default_t (the browser cannot read unlabeled_t files)"
  chcon -R -t default_t "$T/page" || fatal "chcon failed"
  echo "== verify"
  a=$(find "$SRC" | wc -l); b=$(find "$T/page" | wc -l)
  [ "$a" = "$b" ] && [ "$a" -gt 0 ] || fatal "entry count differs (source $a, copy $b)"
  ma=$(tree_md5 "$SRC"); mb=$(tree_md5 "$T/page")
  [ -n "$ma" ] && [ "$ma" = "$mb" ] || fatal "content md5 differs (source $ma, copy $mb)"
  verify_labels "$T/page" || { label_summary "$T/page" >&2; fatal "not every entry is default_t"; }
  echo "$b entries, md5 $ma, all default_t"
  cp -p "$T/page/index.html" "$T/index.html.orig" || fatal "cannot back up index.html"
  [ "$(fmd5 "$T/index.html.orig")" = "$(fmd5 "$SRC/index.html")" ] || fatal "index.html.orig differs from source"
  hook_insert "$T/index.html.orig" "$PORT" > "$NEW" || fatal "cannot build hooked index.html"
  [ "$(wc -l < "$NEW")" -eq $(( $(wc -l < "$T/index.html.orig") + 1 )) ] || fatal "hooked file is not exactly one line longer"
  [ "$(grep -c 'phi-hook\.js' "$NEW")" = 1 ] || fatal "hooked file does not contain the hook exactly once"
  cat "$NEW" > "$T/page/index.html" || fatal "cannot write hooked index.html"
  [ "$(fmd5 "$T/page/index.html")" = "$(fmd5 "$NEW")" ] || fatal "written index.html differs"
  verify_labels "$T/page/index.html" || fatal "index.html lost its default_t label"
  sync
  mv "$T" "$B" || fatal "cannot move $T to $B"
  if ! verify_labels "$D"; then rm_home; fatal "labels wrong after move; $B removed again"; fi
  changed=1
  echo "installed $B"
else
  # ---- existing copy: (re)apply the line from index.html.orig, in place ----
  echo "== $B exists: re-applying the hook line from index.html.orig"
  [ -f "$D/index.html" ] && [ -f "$O" ] || fatal "$B is incomplete (need page/index.html and index.html.orig); remove with --remove-home and cold boot, then install again"
  hook_insert "$O" "$PORT" > "$NEW" || fatal "cannot build hooked index.html"
  [ "$(grep -c 'phi-hook\.js' "$NEW")" = 1 ] || fatal "hooked file does not contain the hook exactly once"
  if [ "$(fmd5 "$NEW")" = "$(fmd5 "$D/index.html")" ]; then
    echo "hook line already present and current"
  else
    cat "$NEW" > "$D/index.html" || fatal "cannot write $D/index.html"
    [ "$(fmd5 "$D/index.html")" = "$(fmd5 "$NEW")" ] || fatal "written index.html differs"
    verify_labels "$D/index.html" || fatal "index.html is not default_t; the browser may not read it"
    sync
    changed=1
    echo "hook line written (label still default_t)"
  fi
fi

echo "== result"
if mounted_ours; then
  echo "PHI/page is mounted from $D."
  if [ "$changed" = 1 ]; then echo "The page was already loaded, so the new line only applies after a cold boot."; coldboot_note
  else echo "Up to date; nothing to do."; fi
else
  echo "PHI/page is NOT mounted from $D yet."
  coldboot_note
fi
REMOTE
}

home_remove() {
  home_run <<'REMOTE'
[ -e "$B" ] || { echo "$B does not exist; nothing to remove"; exit 0; }
was=0; mounted_any && was=1
rm_home
[ ! -e "$B" ] || fatal "$B still exists"
echo "removed $B"
if [ "$was" = 1 ]; then
  echo "WARNING: PHI/page is still mounted from the deleted copy; the TV menus may be empty/broken until you power cycle now."
fi
echo "Stock page tree returns after a cold boot."
coldboot_note
REMOTE
}

home_remove_line() {
  home_run <<'REMOTE'
[ -f "$O" ] && [ -f "$D/index.html" ] || fatal "no $O or $D/index.html; nothing to restore"
if ! grep -q 'phi-hook\.js' "$D/index.html"; then echo "hook line not present; nothing to do"; exit 0; fi
cat "$O" > "$D/index.html" || fatal "cannot write $D/index.html"
[ "$(fmd5 "$D/index.html")" = "$(fmd5 "$O")" ] || fatal "restored index.html differs from index.html.orig"
verify_labels "$D/index.html" || fatal "index.html is not default_t after restore"
sync
echo "index.html restored from index.html.orig (copy kept, label default_t)"
if mounted_ours; then echo "The running UI still has the old page loaded."; fi
coldboot_note
REMOTE
}

home_status() {
  port=8090
  r "[ -f '$DIR/cactariumctl' ]" && port=$(tv_port)
  home_run "$port" <<'REMOTE'
PORT=$1
if [ -d "$D" ]; then echo "$D: exists"; else echo "$D: absent"; fi
if [ -d "$D" ]; then
  echo "labels under $D (type count):"
  label_summary "$D" | sort | sed 's/^/  /'
fi
if mounted_ours; then echo "PHI/page mount: yes, from $D"
elif mounted_any; then echo "PHI/page mount: mounted, but NOT from $D"
else echo "PHI/page mount: not mounted (stock)"; fi
if [ -f "$D/index.html" ]; then
  n=$(grep -c 'phi-hook\.js' "$D/index.html")
  if [ "$n" -gt 0 ]; then echo "index.html hook line: present ($n)"; else echo "index.html hook line: absent"; fi
  echo "index.html md5: $(fmd5 "$D/index.html")"
  if [ -f "$O" ]; then
    echo "index.html.orig md5: $(fmd5 "$O")"
    [ "$(fmd5 "$D/index.html")" = "$(fmd5 "$O")" ] && echo "index.html == orig (launcher line not applied)" || echo "index.html differs from orig"
  else echo "index.html.orig: missing"; fi
fi
printf 'GET /api/launcher/enabled: '
wget -q -O - "http://127.0.0.1:$PORT/api/launcher/enabled" 2>/dev/null </dev/null || echo "(no answer on :$PORT)"
echo
REMOTE
}

case "$ACTION" in
  install-home) home_install; exit $? ;;
  remove-home) home_remove; exit $? ;;
  remove-home-line) home_remove_line; exit $? ;;
  home-status) home_status; exit $? ;;

  status)
    r "/bin/sh $DIR/cactariumctl status"
    rc=$?
    if r "grep -q '^# --- cactarium' '$ROOT_BOOT' 2>/dev/null"; then
      echo "boot hook: enabled"
    else
      echo "boot hook: not enabled"
    fi
    exit $rc ;;

  logs)
    r "tail -n 100 '$DIR/var/cactarium.log'"
    exit $? ;;

  disable-boot)
    disable_boot
    exit $? ;;

  enable-boot)
    r "[ -f '$DIR/cactariumctl' ]" || die "not installed on the TV yet: run server/deploy.sh $HOST first"
    enable_boot_block
    exit $? ;;

  uninstall)
    r "[ -f '$DIR/cactariumctl' ] && /bin/sh '$DIR/cactariumctl' stop; true"
    disable_boot || die "could not remove boot hook; not deleting $DIR"
    r "[ -f '$DIR/config.json' ] && cp -f '$DIR/config.json' '$CONF_BAK' && chmod 600 '$CONF_BAK'; true"
    r "rm -rf '$DIR'" || die "could not remove $DIR"
    echo "uninstalled. config kept at $CONF_BAK"
    exit 0 ;;
esac

# ---- deploy ----
command -v make >/dev/null 2>&1 || die "make not found"
arch_raw=$(r uname -m) || die "uname -m failed"
case "$arch_raw" in
  aarch64) ARCH=arm64 ;;
  armv7*|armv8l) ARCH=armv7 ;;
  *) die "unsupported TV architecture: '$arch_raw' (expected aarch64 or armv7*/armv8l)" ;;
esac
echo "TV arch: $arch_raw -> $ARCH"

BINFILE=dist/cactarium-linux-$ARCH
make "$BINFILE" || die "build failed"
[ -f "$BINFILE" ] || die "missing $BINFILE after build"

r "mkdir -p '$DIR/var'" || die "cannot create $DIR"
echo "uploading binary..."
upload "$BINFILE" "$DIR/cactarium" 755
upload server/cactariumctl "$DIR/cactariumctl" 755
# config.json is never overwritten; the server creates defaults on first run.

echo "restarting..."
r "/bin/sh '$DIR/cactariumctl' restart" || die "restart failed (see: $0 $HOST --logs)"

PORT=$(r "/bin/sh '$DIR/cactariumctl' port" | tr -dc '0-9')
[ -n "$PORT" ] || PORT=8090

if r "i=0; while [ \$i -lt 10 ]; do wget -q -O - http://127.0.0.1:$PORT/api/state >/dev/null 2>&1 && exit 0; wget -q -O - http://127.0.0.1:$PORT/ >/dev/null 2>&1 && exit 0; sleep 1; i=\$((i+1)); done; exit 1"; then
  echo "Cactarium is up: http://$HOST:$PORT/"
else
  echo "deploy: server did not answer within 10 s; recent log:" >&2
  r "tail -n 20 '$DIR/var/cactarium.log' 2>/dev/null" >&2
  exit 1
fi
