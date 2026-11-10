package netblock

import (
	"strings"
	"testing"
)

func TestSync(t *testing.T) {
	installed := map[string]int{}
	var calls []string
	run = func(tool string, args ...string) error {
		key := tool + " " + strings.Join(args[3:], " ")
		calls = append(calls, args[2])
		switch args[2] {
		case "-C":
			if installed[key] > 0 {
				return nil
			}
			return errFake
		case "-A":
			installed[key]++
		case "-D":
			installed[key]--
		}
		return nil
	}
	for _, tool := range tools { // left by an earlier version
		installed[tool+" OUTPUT "+strings.Join(legacy[0], " ")] = 1
	}
	if err := Sync(true); err != nil {
		t.Fatal(err)
	}
	for _, tool := range tools {
		if installed[tool+" OUTPUT "+strings.Join(legacy[0], " ")] != 0 {
			t.Fatal("legacy rule not removed")
		}
		delete(installed, tool+" OUTPUT "+strings.Join(legacy[0], " "))
	}
	if err := Sync(true); err != nil { // idempotent
		t.Fatal(err)
	}
	for k, n := range installed {
		if n != 1 {
			t.Fatalf("%s installed %d times", k, n)
		}
	}
	if len(installed) != len(rules)*len(tools) {
		t.Fatalf("installed %d rules, want %d", len(installed), len(rules)*len(tools))
	}
	if err := Sync(false); err != nil {
		t.Fatal(err)
	}
	for k, n := range installed {
		if n != 0 {
			t.Fatalf("%s left %d", k, n)
		}
	}
}

type fakeErr struct{}

func (fakeErr) Error() string { return "no such rule" }

var errFake = fakeErr{}
