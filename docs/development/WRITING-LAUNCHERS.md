# Changing the launcher

The launcher (`server/assets/launcher/`) is a plain web page that `phi-hook.js` shows in a full-screen iframe over the TV's UI. It has no build step. Its look is derived from Glasshouse Home (see the `NOTICE` file).

## Preview it in a browser

Open `http://<tv-ip>:8090/launcher` on a computer, or run `make run` and open `http://localhost:8090/launcher`. With no parent window the launcher shows its built-in lists and every bridge call fails with a message, which is enough to work on layout and keys.

## How it runs on the TV

The hook owns everything that touches the TV. The launcher only sends it requests with `window.parent.postMessage`, and the hook calls the TV's own functions and replies. Messages from the launcher all carry `src: 'cactarium-launcher'`:

| Message | Meaning |
| :--- | :--- |
| `ready`, `alive` | The page is up; heartbeat (every 2 s). |
| `close`, `stock-home` | Close the launcher; open the stock TitanOS home. |
| `list-apps`, `list-sources` | The TV's app and input lists. |
| `launch` | Open an app. |
| `source` | Switch input. |
| `local` | Open a TV page behind a catalog tile (`media`, `simple_setup`, `alexa`). |
| `open` | Open the TV's `sources` page. |
| `key` | A key the page did not use (Home, volume). |
| `diag` | A diagnostic line, forwarded to `/api/home/diag`. |

Replies come as `{src:'cactarium-hook', type:'result', id, ok, data|error}`, plus `hello`, `home`, `key`, `backdrop` (a TV page is open on top) and `shown`. The hook accepts messages only from its own iframe, from the allowed origins (`localhost` or `127.0.0.1` on Cactarium's port), and with the expected `src`.

The Cactarium tile navigates the launcher's frame to `/tvapp` (`server/assets/tvapp/`); that page sends the same `alive` and `key` messages and returns to `/launcher` on Back or on the hook's `home` and `shown` messages. Another full-screen page can be added the same way.

The page reads its data from the server: `GET /api/launcher/apps` and `/api/launcher/weather`. Keys: arrows, Enter, and Back as 8, 27, 461 or 10009. If the page stops sending its heartbeat, the hook falls back to the stock home, so a broken launcher cannot hold the screen.

## Changing it

1. Edit the files under `server/assets/launcher/`. They are embedded into the binary, so rebuild and deploy (`server/deploy.sh <tv-ip>`).
2. The hook keeps the launcher page loaded between shows, so after a deploy reload it (a cold boot does) to see the change. A changed `phi-hook.js` is read when the TV's UI page next loads.
3. Update [the launcher page](../launcher.md), including its bridge section if the bridge changed.
