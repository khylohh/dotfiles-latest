# Live SFX Editor

Real-time sound effect spotting editor for Command Center.

This tool intentionally starts from the CaptionAI editor foundation: dark production UI, video monitor, smooth canvas timeline, local bridge, save/load project state, and export. It uses a separate data model and does not modify CaptionAI.

Default cycle library:

```text
/Users/kyle/Desktop/2026 SFX/2026 Cycle SFX
```

Run locally:

```bash
/Applications/Codex.app/Contents/Resources/node scripts/live-sfx-bridge.mjs --port 5187
```

Or launch with a video:

```bash
/Applications/Codex.app/Contents/Resources/node scripts/launch-live-sfx.mjs --media "/path/to/source.mp4"
```
