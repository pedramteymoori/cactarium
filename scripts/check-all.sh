#!/bin/sh
# scripts/check-all.sh - every check that needs no TV: gofmt, vet, tests, sh -n.
set -e
cd "$(dirname "$0")/.."

out=$(gofmt -l server)
if [ -n "$out" ]; then
  echo "gofmt needs to run on:" >&2
  echo "$out" >&2
  exit 1
fi
go vet ./...
go test ./...
for f in $(find server scripts -name "*.sh" -o -name cactariumctl | sort); do
  sh -n "$f"
done
echo "check-all: ok"
