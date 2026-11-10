# Picture

The **Picture** tab, `/?tab=picture`, reads and sets the TV's picture settings through the PHI bridge (`POST /api/tv/phi`).

<!-- Screenshot to come: the Picture tab. -->

The picture style heads the tab, with a menu to change it. Below it, for that style: **Contrast**, **Brightness**, **Colour** and **Sharpness** sliders, the **Ambient light sensor**, and the **Picture format** (read only; change it with the remote's Format key).

The styles come from the TV (Personal, Crystal clear, Home cinema, Eco, Movie and Game on 55PUS8450/12). The TV keeps one set of values per style.

PHI is frozen while a web app runs, so while one is open the tab shows "Not available while an app is open" and comes back when the app closes. The slider ranges (0 to 100, sharpness 0 to 10) are assumed from the TV's own readings, not read from the TV.
