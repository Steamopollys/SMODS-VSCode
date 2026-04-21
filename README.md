# Smods Tools

VSCode support for [Steamodded](https://github.com/Steamodded/smods).

## Features

- **Snippets** for every major SMODS object — jokers, consumables, decks, vouchers, boosters, editions, seals, blinds, tags, rarities, ranks, suits, atlases, sounds, shaders, challenges, keybinds, and more. Type `smods-` in any `.lua` file to see them all.
- **IntelliSense & hover docs** via Steamodded's own `lsp_def/` type definitions. Powered by the [sumneko Lua Language Server](https://marketplace.visualstudio.com/items?itemName=sumneko.lua) (installed automatically as a dependency). You get completion on `SMODS.Joker`, calculate-function `context` fields, the `Card` class, and more. Requires Steamodded installed in your `Mods/` folder.
- **Mod scaffolding** — `Smods: New Mod…` creates a mod folder with manifest, `main.lua`, localization stub, optional atlas folders, and optional Lovely patch folder. Separate commands create jokers, consumables, vouchers, decks, editions, seals, blinds, tags, boosters, enhancements, shaders, sounds, and challenges from templates. When a Lua file is already open, scaffold commands offer to **insert at cursor** instead of creating a new file.
- **Manifest validation** — JSON schema plus extra checks: reserved IDs, missing `main_file` on disk, bad badge hex, malformed or unresolvable `dependencies`, and more. Errors appear in the Problems panel.
- **Lovely `patches.toml` support** — built-in validation (no external extension needed) with diagnostics for required fields, type errors, invalid `position` values, and unknown keys. Hover any key or section header for its description. `payload` strings (both `"""` and `'''`) are syntax-highlighted as Lua and support full Lua Language Server hover and IntelliSense (completions) inside the string.
- **Launch & reload Balatro** from VSCode, with status bar buttons. Reload is automated with platform-specific tooling:
  - Windows: PowerShell SendKeys
  - macOS: AppleScript via `osascript` (not tested)
  - Linux: `xdotool` (install separately) (not tested)
- **Solo launch** — `Solo` status bar button launches Balatro with only Steamodded, Lovely, and your workspace mod active. All other mods are moved to a temporary stash beside the `Mods/` folder (`Mods/../.smods-stash`) and restored automatically when Balatro exits.
- **Auto-reload on save** — when Balatro is running, save any `.lua`/`.json`/`.toml` in a detected mod root and the extension debounces an Alt+F5 for you. Toggle with the status-bar button or `smods.autoReload`.
- **Balatro Log panel** — dedicated webview with per-level filter chips (TRACE/DEBUG/INFO/WARN/ERROR/FATAL) matched against the first word of each line, text search, follow mode, and clickable `file:line` links that jump to the source. Filter state (active chips, query, follow) is persisted across panel reloads.
- **Atlas preview & sprite picker** — CodeLens above every `atlas = '...'` opens a clickable grid of the atlas image. Click a cell to write `pos = { x=, y= }` back to source.
- **Localization linter** — flags `SMODS.<Kind>` blocks without an `loc_txt` nor a matching entry in `localization/*.lua`. CodeLens jumps to the entry or creates a stub in `en-us.lua`.
- **Calculate-context hover + completion** — hover any `context.<flag>` in a `calculate` function for a description and example. Auto-completes all 45 documented flags.
- **SMODS API quick-search** — `Smods: Open SMODS API Reference…` fuzzy-searches every class/function in Steamodded's `lsp_def/` and jumps to the definition.
- **Version bump + package** — `Smods: Bump Mod Version…` rewrites the manifest's SemVer (patch/minor/major/prerelease). `Smods: Package Mod as Zip…` zips the mod with sensible excludes, ready for release.
- **Auto-symlink mod on launch** — optionally symlinks your mod folder into the Balatro `Mods/` directory before launch or reload, then removes it when Balatro exits or VS Code closes. Lets you develop anywhere on disk without manually copying files. Enable via `smods.symlinkModOnLaunch`.

## Requirements

- VSCode 1.85 or newer.
- The [sumneko.lua](https://marketplace.visualstudio.com/items?itemName=sumneko.lua) extension (auto-installed as a dependency).
- A working Steamodded + Lovely installation. See [Installing Steamodded](https://github.com/Steamodded/smods/wiki/Installation).

## Settings

| Setting | Description |
|---|---|
| `smods.balatroExecutable` | Absolute path to `Balatro.exe`. Auto-detected on Steam installs. |
| `smods.modsFolder` | Path to the Balatro `Mods/` folder. Defaults to `%AppData%/Balatro/Mods`. |
| `smods.logFile` | Path to the Lovely log. Defaults to files under `%AppData%/Balatro/`. |
| `smods.autoAttachLuaTypes` | When true, adds Steamodded's `lsp_def/` folder to `Lua.workspace.library`. |
| `smods.defaultAuthor` | Default author name pre-filled when scaffolding. |
| `smods.symlinkModOnLaunch` | Symlink detected mod roots into `Mods/` on launch/reload; remove them on exit. Do not enable if your workspace is already inside the Mods folder. On Windows, requires Developer Mode or admin. |
| `smods.autoReload` | Auto-send Alt+F5 to Balatro when a `.lua`/`.json`/`.toml` file saves in a detected mod root. |
| `smods.autoReloadDelay` | Debounce window (ms) between last save and the auto-reload keystroke. Default 500. |

## Commands

All commands live under the "Smods:" prefix in the Command Palette.

| Command | What it does |
|---|---|
| `New Mod…` | Scaffold a complete Smods mod folder. |
| `New Joker…` / `New Consumable…` / `New Voucher…` / `New Deck (Back)…` / `New Edition…` / `New Seal…` / `New Blind…` / `New Tag…` / `New Booster Pack…` / `New Enhancement…` / `New Shader…` / `New Sound…` / `New Challenge…` | Add a new object from a template, inserting at cursor or creating a new file. |
| `Launch Balatro` | Launch Balatro via Steam. |
| `Launch Balatro (Solo)` | Launch Balatro with only Steamodded, Lovely, and your workspace mod. Other mods are stashed and restored on exit. |
| `Reload Mods (Alt+F5)` | Focus Balatro and send the reload keystroke. |
| `Toggle Auto-Reload on Save` | Flip `smods.autoReload`. |
| `Tail Balatro Log` | Start tailing the Lovely log (feeds the Balatro Log panel). |
| `Open Mods Folder` | Reveal the Balatro Mods folder in your file manager. |
| `Validate Mod Manifest` | Force a revalidation of the active manifest. |
| `Bump Mod Version…` | SemVer patch/minor/major/prerelease bump on the manifest. |
| `Package Mod as Zip…` | Zip the mod for distribution (`<id>-<version>.zip`). |
| `Open SMODS API Reference…` | Fuzzy search Steamodded classes/functions and jump to definition. |

## Known limitations

- Linux reload requires `xdotool`. Wayland users may need alternatives (`ydotool`).
- Auto-detection for the Balatro executable only covers typical Steam install paths. Use the settings if yours lives elsewhere.
- Atlas preview requires `key` and `path` to be plain string literals. Dynamic values (variables, concatenation) cannot be resolved statically and will not show a CodeLens.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Snippets are the easiest place to contribute — plain JSON, no build step.

## License

MIT. See [LICENSE](./LICENSE).
