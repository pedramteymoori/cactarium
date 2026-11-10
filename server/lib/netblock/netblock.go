// Package netblock keeps the TV from loading the TitanOS cloud launcher.
//
// libnettvp preloads https://app.titanos.tv in the browser's main window at
// boot and only brings it forward on Home or power-on; no setting stops that.
// The host is on CloudFront, whose
// addresses are shared with other services, so we block the name instead of
// the address: DNS queries for it are rejected, and as a backup for cached
// addresses so are TLS connections that name it (SNI). TitanOS sign-in and
// its API live on other hosts (api.titanos.tv) and are not touched. Without
// the launcher the TV falls back to its local offline launcher.
package netblock

import (
	"fmt"
	"os/exec"
	"strings"
)

const tag = "cactarium-block-titanos"

// rules are the OUTPUT rules, without the -A/-C/-D verb. Each is added for
// both iptables and ip6tables. They match the exact name only: the catalog
// and app icons the launcher uses live on eu.app.titanos.tv, which a plain
// substring match would block too.
var rules = [][]string{
	// DNS query name in wire format (3 "app" 7 "titanos" 2 "tv" 0). It
	// follows the 12-byte header, whose last byte (ARCOUNT low) is 0, or 1
	// with EDNS; a longer name has a label character there instead.
	dnsRule("udp", "|00 03|app|07|titanos|02|tv|00|"),
	dnsRule("udp", "|01 03|app|07|titanos|02|tv|00|"),
	dnsRule("tcp", "|00 03|app|07|titanos|02|tv|00|"),
	dnsRule("tcp", "|01 03|app|07|titanos|02|tv|00|"),
	// TLS ClientHello server name: type 0, then the 2-byte length (14)
	{"-p", "tcp", "--dport", "443", "-m", "string", "--algo", "bm", "--icase",
		"--hex-string", "|00 00 0e|app.titanos.tv", "-m", "comment", "--comment", tag, "-j", "REJECT", "--reject-with", "tcp-reset"},
}

// legacy are rules from earlier versions, matched by substring (they also
// blocked eu.app.titanos.tv). Sync removes them whether on or off.
var legacy = [][]string{
	{"-p", "udp", "--dport", "53", "-m", "string", "--algo", "bm", "--icase",
		"--hex-string", "|03|app|07|titanos|02|tv|00|", "-m", "comment", "--comment", tag, "-j", "REJECT"},
	{"-p", "tcp", "--dport", "53", "-m", "string", "--algo", "bm", "--icase",
		"--hex-string", "|03|app|07|titanos|02|tv|00|", "-m", "comment", "--comment", tag, "-j", "REJECT", "--reject-with", "tcp-reset"},
	{"-p", "tcp", "--dport", "443", "-m", "string", "--algo", "bm", "--icase",
		"--string", "app.titanos.tv", "-m", "comment", "--comment", tag, "-j", "REJECT", "--reject-with", "tcp-reset"},
}

func dnsRule(proto, hex string) []string {
	r := []string{"-p", proto, "--dport", "53", "-m", "string", "--algo", "bm", "--icase",
		"--hex-string", hex, "-m", "comment", "--comment", tag, "-j", "REJECT"}
	if proto == "tcp" {
		r = append(r, "--reject-with", "tcp-reset")
	}
	return r
}

var tools = []string{"iptables", "ip6tables"}

// run is replaced in tests.
var run = func(tool string, args ...string) error {
	out, err := exec.Command(tool, args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s %s: %v: %s", tool, strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return nil
}

// Sync adds the rules when on and removes every copy of them when off. It is
// idempotent, so it runs at every start and on every settings change.
func Sync(on bool) error {
	var errs []string
	for _, tool := range tools {
		for _, r := range legacy {
			errs = remove(tool, r, errs)
		}
		for _, r := range rules {
			if !on {
				errs = remove(tool, r, errs)
				continue
			}
			if run(tool, append([]string{"-w", "5", "-C", "OUTPUT"}, r...)...) == nil {
				continue
			}
			if err := run(tool, append([]string{"-w", "5", "-A", "OUTPUT"}, r...)...); err != nil {
				errs = append(errs, err.Error())
			}
		}
	}
	if len(errs) > 0 {
		return fmt.Errorf("netblock: %s", strings.Join(errs, "; "))
	}
	return nil
}

// remove deletes every copy of r.
func remove(tool string, r []string, errs []string) []string {
	check := append([]string{"-w", "5", "-C", "OUTPUT"}, r...)
	for i := 0; i < 10 && run(tool, check...) == nil; i++ {
		if err := run(tool, append([]string{"-w", "5", "-D", "OUTPUT"}, r...)...); err != nil {
			return append(errs, err.Error())
		}
	}
	return errs
}
