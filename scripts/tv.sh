#!/bin/sh
#
# scripts/tv.sh - run a command on the rooted TV over SSH
#
#   TV=<tv-ip> scripts/tv.sh <command> [args ...]
#   TV=<tv-ip> scripts/tv.sh                         open a shell
#
# SSH_PORT (default 2222) and SSH_USER (default root) override the login.
# Key auth is required.
#
exec ssh -p "${SSH_PORT:-2222}" "${SSH_USER:-root}@${TV:?set TV=<tv-ip>}" "$@"
