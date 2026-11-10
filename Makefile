VERSION ?= $(shell git describe --always --dirty 2>/dev/null || echo dev)
LDFLAGS := -s -w -X main.version=$(VERSION)
GOFLAGS_BUILD := -trimpath -ldflags "$(LDFLAGS)"
SRC := $(shell find server -type f 2>/dev/null) go.mod

.PHONY: build dist test vet check run clean

# Host build (for development; runs on macOS/Linux).
build: dist/cactarium

dist/cactarium: $(SRC)
	@mkdir -p dist
	CGO_ENABLED=0 go build $(GOFLAGS_BUILD) -o $@ ./server

dist/cactarium-linux-arm64: $(SRC)
	@mkdir -p dist
	CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build $(GOFLAGS_BUILD) -o $@ ./server

dist/cactarium-linux-armv7: $(SRC)
	@mkdir -p dist
	CGO_ENABLED=0 GOOS=linux GOARCH=arm GOARM=7 go build $(GOFLAGS_BUILD) -o $@ ./server

dist: dist/cactarium-linux-arm64 dist/cactarium-linux-armv7

test:
	go test ./...

vet:
	go vet ./...

check:
	sh scripts/check-all.sh

# make run            -> dashboard on :8090, no TV
# make run TV=1.2.3.4 -> talk to a TV over the LAN
run:
	go run ./server -config ./dev-config.json -listen :8090 $(if $(TV),-tv $(TV))

clean:
	rm -rf dist
