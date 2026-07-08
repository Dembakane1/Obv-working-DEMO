# OBV Teams app package (RSC read scope)

This Teams app grants OBV **team-scoped** read access via Resource-Specific
Consent (`ChannelMessage.Read.Group`, application) — the least-privilege
alternative to tenant-wide `ChannelMessage.Read.All`. Installing the app in
ONE Team consents message reading for THAT Team only; a team owner
installs it, no tenant-wide grant is required for reading.

Outbound posting is NOT part of this manifest: RSC has no application
permission for operational channel-message creation. OBV sends via the
delegated `ChannelMessage.Send` service-account path (see
docs/TEAMS_REAL_TENANT_SETUP.md, step 8).

## Values the administrator must replace (all safe to display)

| Placeholder | Replace with |
|---|---|
| `REPLACE-WITH-TEAMS-APP-GUID` | A NEW GUID you generate for the Teams app id (`uuidgen`) |
| `REPLACE-WITH-ENTRA-CLIENT-ID` | The Entra app registration's Application (client) ID |
| `REPLACE-WITH-OBV-PUBLIC-HOST` | Your OBV deployment host, e.g. `obv-demo.onrender.com` (host only, no scheme, in validDomains; full https URL in the developer links) |

No secrets belong in this package. Never add the client secret, tokens,
or webhook values to the manifest.

## Icons

Teams requires `color.png` (192×192) and `outline.png` (32×32,
transparent + white). Reuse the OBV brand mark: copy
`public/icons/icon-192.png` to `color.png`, and export a 32×32
monochrome version of the same mark as `outline.png` (any image tool;
white strokes on transparent background).

## Package & install

1. Replace the placeholders above; add the two icons.
2. Zip the three files flat (no folder): `manifest.json color.png outline.png`.
3. Teams admin center → Teams apps → Manage apps → Upload new app
   (or Teams client → Apps → Manage your apps → Upload an app, if
   custom app upload is allowed by org policy).
4. In the target project Team: Apps → built for your org → OBV Project
   Sync → Add to team. This grants the RSC read scope for that Team only.
5. Continue with docs/TEAMS_REAL_TENANT_SETUP.md (subscriptions, send
   path, thread binding).
