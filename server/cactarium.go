// Command cactarium serves the TV dashboard and bridges the TV to Home
// Assistant. See docs/IMPLEMENTATION.md.
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"runtime/debug"
	"syscall"
	"time"

	"cactarium/server/lib/config"
	"cactarium/server/lib/jointspace"
	"cactarium/server/lib/netblock"
	"cactarium/server/lib/routes"
	"cactarium/server/lib/telemetry"
	"cactarium/server/lib/titancat"
)

// version is set with -ldflags "-X main.version=...".
var version = "dev"

const tvConfigDir = "/mtd_rwarea/apdat/opt/cactarium"

func defaultConfigPath() string {
	if st, err := os.Stat(tvConfigDir); err == nil && st.IsDir() {
		return tvConfigDir + "/config.json"
	}
	return "config.json"
}

// tvCAFile is the TV's root certificate bundle. Go's default list of bundle
// paths does not include it, so without this every HTTPS request (TitanOS
// catalog, weather) fails with "certificate signed by unknown authority".
const tvCAFile = "/etc/ssl/cacert.pem"

func main() {
	if os.Getenv("SSL_CERT_FILE") == "" {
		if _, err := os.Stat(tvCAFile); err == nil {
			os.Setenv("SSL_CERT_FILE", tvCAFile)
		}
	}
	cfgPath := flag.String("config", defaultConfigPath(), "config file path")
	listen := flag.String("listen", "", "listen address (overrides config.listen)")
	tv := flag.String("tv", "", "TV host (overrides config.jointspace.host)")
	showVersion := flag.Bool("version", false, "print version and exit")
	flag.Parse()
	if *showVersion {
		fmt.Println(version)
		return
	}

	// The TV has little RAM; make the GC work harder before we grow past this.
	debug.SetMemoryLimit(48 << 20)
	log.SetFlags(log.LstdFlags | log.Lmsgprefix)
	log.SetPrefix("cactarium: ")

	store, err := config.Open(*cfgPath)
	if err != nil {
		log.Fatalf("config %s: %v", *cfgPath, err)
	}
	cfg := store.Get()
	host := cfg.JointSpace.Host
	if *tv != "" {
		host = *tv
	}
	js := jointspace.New(host, cfg.JointSpace.User, cfg.JointSpace.Pass)
	sampler := telemetry.NewSampler(2 * time.Second)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	cat := titancat.New(filepath.Join(filepath.Dir(*cfgPath), "var", "titan-catalog.json"), nil, "")
	var ha *haRunner // set below; closures only run after it exists
	srv := routes.New(routes.Options{
		Store: store, JS: js, Sampler: sampler, Version: version, Listen: *listen,
		MQTTStatus:        func() (bool, bool, string) { return ha.status() },
		OnSettingsChanged: func() { ha.restart() },
		OnCommand:         func() { ha.publishSoon() },
		NetSync:           netblock.Sync,
		Catalog:           cat,
	})
	ha = newHARunner(ctx, store, srv)

	go sampler.Start(ctx)
	go cat.Run(ctx, func() titancat.Query {
		k := store.Get().Launcher.Catalog
		return titancat.Query{Market: k.Market, Locale: k.Locale, Model: k.Model, Firmware: k.Firmware}
	})
	// every start: add or remove the TitanOS launcher block (rules do not survive a reboot)
	if err := netblock.Sync(cfg.Launcher.BlockTitanOS); err != nil {
		log.Printf("%v", err)
	} else if cfg.Launcher.BlockTitanOS {
		log.Printf("netblock: TitanOS cloud launcher blocked")
	}
	ha.restart()

	log.Printf("version %s, config %s, tv %s", version, *cfgPath, host)
	if err := srv.Run(ctx); err != nil {
		log.Printf("server: %v", err)
		stop()
		ha.stop()
		os.Exit(1)
	}
	ha.stop() // publishes "offline" before exit
	log.Print("bye")
}
