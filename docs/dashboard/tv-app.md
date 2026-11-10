# The TV app

The launcher's first tile, **Cactarium**, opens the dashboard on the TV itself, for when there is no phone or laptop to hand. It is a port of [Glasshouse](https://github.com/rorygallagher2024/glasshouse)'s TV app (MIT): true black, sized for 1080p from the sofa, with a tab bar, a list of rows and an explainer for the selected row on the right. It reads and changes the same things as the web dashboard, through the same routes and PHI bridge calls.

## Remote

* **Left / Right** switch tab. Inside a list opened from a row, Left goes back up and Right does nothing.
* **Up / Down**, or the Magic Remote's wheel, move row by row and skip headings. **Channel Up / Down** (or Page Up / Down) jump six rows.
* **OK** acts on the selected row. A switch flips, a choice steps to the next value (the explainer says which), a row marked with a chevron opens a list, and Reboot, Power off and similar ask for a second OK within five seconds. A dot beside a row's name marks one OK can act on; the others are read-outs.
* On a **bar** (a slider), OK starts adjusting. Left and Right change the value, faster while held, Up and Down take bigger steps, and OK or Back finish. The value is sent as it changes, one request at a time.
* **Back** goes up one list, or out to the launcher. **Home** returns to the launcher.
* A short message at the bottom right confirms an action or says why it failed. A pointer click selects a row, and clicking it again acts on it.

Rows the TV app cannot change, because they need typing or a larger screen, show a QR code of the web dashboard's address under the explainer. The code never carries the [access token](../SECURITY.md#the-tv-app-and-the-token).

## Tabs

**Metrics** (read every 5 s). Temperature, CPU, per-core load, load average, memory, swap, storage, flash wear, network, address, the HDMI ports, Cactarium's own memory, and the TV's connection, pairing, power, input and identity. *Memory by process* and *CPU by process* open lists read while open (5 s and 3 s).

**Apps.** The launcher's apps, each launched with OK, and the TV's inputs, each switched to with OK.

**Game.** Game bar (switch), auto game mode and VRR (read-outs).

**Picture** (5 s). Picture style (OK steps through them), then bars for Contrast, Brightness, Colour and Sharpness, the ambient light sensor switch and the picture format read-out.

**Audio** (8 s). Volume (bar) and Mute, then sound style, Clear dialogue, Dolby Atmos and AI equalizer.

**Ambilight** (8 s). Ambilight on or off, Style (OK steps through the eight), Brightness (bar). The live preview of the LEDs is left to the web dashboard.

**Home.** The Cactarium launcher on or off, blocking the TitanOS home, the apps row (a list where OK moves an app up one place, and *Add or remove apps* lists the TV input and the catalog), the weather's state, and the Background: None, Pictures or Animated, stepped with OK, then only its own rows: the picture set (Landscape, Abstract, Your own), or the animation and its colours; Darkening steps from 100% through 75%, 50% and 25% to Off. Your own pictures and colours, and the weather's place, are set on the web dashboard. Everything here is saved as the web dashboard saves it, with `POST /api/settings`.

**System** (8 s). The switch-off timer (OK turns it off) and no-signal timer, EasyLink, auto movie mode and HDMI Ultra HD, the TV's name and system information, this dashboard's address (with a QR code), the access token and version, Home Assistant, then last in the tab Power off, Screen off, Screen on and Reboot.

PHI is frozen while a web app runs; rows that use it then say *Not available while an app is open* and come back when the app closes.

## Left out

Glasshouse's OLED Care, Screen Saver, Privacy, Service Menu and Updates tabs are LG or webOS specific and have no counterpart on a TitanOS TV, as on the [web dashboard](index.md#left-out). The Control tab's on-screen remote and playback keys are not needed with the real remote in hand, the light theme and the setup wizard are not ported, and the process lists, HDMI ports and TV identity that the web dashboard keeps in separate tabs sit in Metrics and System.

## How it is served

`GET /tvapp` is served to the TV itself only, with the access token (if one is set) written into the page so the script can authenticate. See [Security](../SECURITY.md#the-tv-app-and-the-token).
