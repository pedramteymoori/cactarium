# Ambilight

The **Ambilight** tab, `/?tab=ambilight`, controls the TV's Ambilight. Philips only; Glasshouse has no counterpart.

<!-- Screenshot to come: the Ambilight tab with its live preview. -->

* **Power.** A switch. Off is style 0; on restores the last style used (Standard at first).
* **Style.** AI, Standard, Sports, Cinema, Game, Music, Fixed colour and Support your team, the list PHI's own Ambilight style menu uses.
* **Brightness.** 0 to 10.
* **Live preview.** A drawing of the LED ring built from the TV's Ambilight topology, coloured from the processed LED values. It refreshes about twice a second, **only while the tab is visible**.

Power, style and brightness go through the PHI bridge (`RpcSetupAmbilightGetConfig`, `RpcSetupAmbilightStyleSet`, `RpcAmbilightBrightnessSet`), not JointSpace: on 55PUS8450/12 (TPN256E_V056.010.032.001) every JointSpace Ambilight write answers 503, and its reads can be stale. The live preview still reads JointSpace. While a web app is open PHI is frozen and the controls show a note.
