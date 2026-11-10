# Server

The **Server** tab, `/?tab=server`, covers Cactarium itself.

<!-- Screenshot to come: the Server tab. -->

## Pairing

JointSpace needs a one-time pairing before it will accept commands. The tab shows whether the TV is paired.

1. Paste the **app secret** (base64) and press **Start pairing**. The secret is saved to the config, so it is only asked for once. Cactarium does not ship it.
2. The TV shows a 4-digit PIN. Enter it and press **Finish**.
3. The credentials are saved. A pairing in progress lasts 5 minutes. **I have a PIN** skips straight to the PIN field.

**Forget** clears the saved credentials (the TV keeps its own record).

## About

The version, the device id and the TV host.

## Access

Whether the dashboard is protected. **Set access token** stores a token in this browser so it can talk to a server that has one; the token itself is set in `config.json` (see [Security](../SECURITY.md#set-a-token)).
