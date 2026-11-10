// Package assets embeds the dashboard so the binary is self-contained on the TV.
package assets

import "embed"

//go:embed ui.html ui phi-hook.js fonts launcher tvapp
var FS embed.FS
