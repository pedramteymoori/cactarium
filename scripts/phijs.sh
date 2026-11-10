#!/bin/bash
#
# scripts/phijs.sh - run JavaScript inside the TV's PHI page and print the result
#
#   TV=<tv-ip> scripts/phijs.sh 'return document.title'
#
# Goes through Cactarium's debug channel (/api/launcher/debug on the TV). The
# debug secret is read from the TV at run time; nothing secret lives in the repo.
# SSH_PORT (default 2222) and SSH_USER (default root) override the login.
#
JS="$1"
[ -n "$JS" ] || { sed -n '3,9p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
ssh -p "${SSH_PORT:-2222}" "${SSH_USER:-root}@${TV:?set TV=<tv-ip>}" "S=\$(cat /mtd_rwarea/apdat/opt/cactarium/var/debug.secret); cat > /tmp/dbg.js; ID=\$(wget -q -O - --header=\"X-Debug-Secret: \$S\" --post-file=/tmp/dbg.js http://127.0.0.1:8090/api/launcher/debug | sed 's/.*\"id\":\([0-9]*\).*/\1/'); rm -f /tmp/dbg.js; for i in 1 2 3 4 5 6 7 8; do sleep 1; L=\$(grep 'debug-result' /mtd_rwarea/apdat/opt/cactarium/var/cactarium.log | grep \"\\\"id\\\":\$ID[,}]\" | tail -1); [ -n \"\$L\" ] && { echo \"\$L\" | sed 's/.*\"data\"://'; exit 0; }; done; echo timeout id=\$ID" <<< "$JS"
