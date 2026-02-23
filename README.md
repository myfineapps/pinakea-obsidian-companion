# ONA.UNO Companion (Obsidian Plugin)

This is the first-party Obsidian companion plugin for the **ONA.UNO** macOS app.

## Features (MVP)

- Readiness bubble in Settings
  - Pink: ONA.UNO not installed
  - Red: Current vault not added as a source in ONA.UNO
  - Orange: Current vault exists but is inactive in ONA.UNO
  - Green: Current vault is active in ONA.UNO
- Commands (Command Palette + file context menu)
  - **Open in ONA.UNO App**: selects the note in ONA.UNO and focuses the Summary pane
  - **Chat in ONA.UNO App**: selects the note in ONA.UNO and starts a new Chat for that single item

## Notes

- macOS only (ONA.UNO is a macOS app).
- This MVP queries ONA.UNO’s local `sources.db` via `/usr/bin/sqlite3`.

## Install (Beta via BRAT)

1. Install and enable the BRAT plugin in Obsidian.
2. In BRAT, choose **Add beta plugin**.
3. Enter `myfineapps/ona-uno-obsidian-companion`.
4. Install/update through BRAT.

## Local Development Install

Copy this folder to:

`<vault>/.obsidian/plugins/onauno-obsidian-companion/`

Then enable **ONA.UNO Companion** in Obsidian Community Plugins.

## Manual smoke tests

1. **Pink bubble**: uninstall/rename ONA.UNO app → open Obsidian → Settings → ONA.UNO Companion.
2. **Red bubble**: ONA.UNO installed, current vault not added as a source in ONA.UNO.
3. **Orange bubble**: vault added as an Obsidian source in ONA.UNO, but `is_active = 0`.
4. **Green bubble**: vault added and active in ONA.UNO.
5. **Open in ONA.UNO App (indexed note)**: run command → ONA.UNO foregrounds, selects note, Summary tab active.
6. **Chat in ONA.UNO App (indexed note)**: run command → ONA.UNO foregrounds, selects note, Chat tab active, new chat started.
7. **Open/Chat on non-indexed note**: create a new note, immediately run command → ONA.UNO indexes it via deep link and selects it.
