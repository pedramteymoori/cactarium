#!/bin/bash
#
# scripts/key.sh - press remote keys on the TV through Cactarium
#
#   TV=<tv-ip> scripts/key.sh Home Back Confirm CursorUp ...
#
# Keys are JointSpace key names, sent in order 1.2 s apart to POST /api/key.
# TV_PORT is Cactarium's port (8090).
#
[ $# -ge 1 ] || { sed -n '3,8p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
for k in "$@"; do
  curl -s -X POST -H 'Content-Type: application/json' -d "{\"key\":\"$k\"}" "http://${TV:?set TV=<tv-ip>}:${TV_PORT:-8090}/api/key"
  echo " $k"
  sleep 1.2
done
