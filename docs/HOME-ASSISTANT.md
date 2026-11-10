# Home Assistant

Cactarium's MQTT bridge shows the TV in Home Assistant as one device, through MQTT Discovery, and accepts commands from Home Assistant or any other MQTT client.

<!-- Screenshot to come: the TV as a device in Home Assistant. -->

## Setup

1. Have an MQTT broker that Home Assistant uses (the Mosquitto add-on, for example).
2. In the dashboard, open the MQTT tab (`/?tab=mqtt`), switch **MQTT bridge** on, enter the broker host and port, and the user and password, and press **Save**. The bridge restarts at once. The status line shows whether it is connected.
3. The TV appears in Home Assistant under MQTT, named after the TV name setting.

The bridge speaks MQTT 3.1.1 over plain TCP. Keep the broker on your LAN and give the TV its own limited user: see [hardening the bridge](SECURITY.md#hardening-the-mqtt-bridge).

| Setting | Default |
| :--- | :--- |
| Port | `1883` |
| Topic prefix | `cactarium` |
| Discovery prefix | `homeassistant` |
| Publish interval | `10` seconds |

## Entities

Everything belongs to one device (manufacturer "Philips", model "TitanOS TV"), identified as `cactarium_<device_id>`.

| Entity | Type | Notes |
| :--- | :--- | :--- |
| Power | switch | On or standby. |
| Volume | number | 0 to the TV's maximum (60 until it reports one), slider. |
| Mute | switch | |
| Ambilight | switch | |
| CPU | sensor | Percent. |
| Memory | sensor | Percent used. |
| Temperature | sensor | Only when the TV reports one. |
| Uptime | sensor | Seconds. |
| Wi-Fi signal | sensor | dBm, only when the TV reports one. |
| Home, Back, Play/Pause, Source | buttons | Press the matching remote key. |

## Topics

With the default prefix and a device id `<id>`:

| Topic | Direction | Payload |
| :--- | :--- | :--- |
| `cactarium/<id>/availability` | published, retained | `online` or `offline`; `offline` is also the last will. |
| `cactarium/<id>/state` | published, retained | JSON with the power, volume, mute, Ambilight and sensor values. Published every interval and right after a command. |
| `cactarium/<id>/power/set` | command | `ON` or `OFF` |
| `cactarium/<id>/volume/set` | command | a number, clamped to the TV's range |
| `cactarium/<id>/mute/set` | command | `ON` or `OFF` |
| `cactarium/<id>/ambilight/set` | command | `ON` or `OFF` |
| `cactarium/<id>/key/set` | command | any JointSpace key name, such as `CursorUp` or `Home` |
| `cactarium/<id>/button/<Key>` | command | any payload; presses that key |

Discovery messages are retained under `<discovery prefix>/<component>/cactarium_<id>/<object>/config`. Commands need the TV to be paired; an unpaired TV ignores them.

## Troubleshooting

* **No device in Home Assistant.** Check the Settings status line, the broker address, and that Home Assistant's MQTT integration uses the same discovery prefix.
* **Entities unavailable.** The availability topic says `offline` when Cactarium is stopped or the TV has lost power.
* **Commands do nothing.** Pair the TV first; unpaired commands are refused.
