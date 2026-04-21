# Change Log

All notable changes to the Smods Tools extension are documented here.

## [0.2.0]

### Changed
- `Smods: Launch Balatro (Solo)` no longer moves mod folders to a stash directory. Instead, non-core mods are temporarily added to `lovely/blacklist.txt` and removed on exit. This avoids expensive filesystem moves and allows mods to be re-enabled in-game via Steamodded's UI during a solo session.

## [0.1.0] — Initial release

### Added
- Snippet pack for SMODS game objects (jokers, consumables, vouchers, boosters, editions, enhancements, seals, blinds, tags, rarities, ranks, suits, atlases, sounds, shaders, challenges, keybinds, stakes).
- Snippets for calculate-function contexts and `G.E_MANAGER:add_event` scaffolds.
- Type definitions from Steamodded's `lsp_def/` folder auto-attached to the Lua Language Server (requires Steamodded installed in `Mods/`).
- `Smods: New Mod…` command with manifest, `main.lua`, localization stub, optional atlas and Lovely folders.
- Scaffold commands for Joker, Consumable, Voucher, Deck (Back), Edition, Seal, Blind, Tag, Booster Pack, Enhancement, Shader, Sound, Challenge. When a Lua file is already open, each command offers to insert at cursor instead of creating a new file.
- JSON schema + per-field diagnostics for Smods mod manifests, including dependency resolution against installed mods (15-s TTL cache).
- Lovely `patches.toml` support — built-in TOML parser and diagnostics (no external extension required) covering `[manifest]`, `[[patches]]`, `pattern`/`regex`/`copy`/`module` types; required-field checks, type validation, and `position` enum enforcement. Hover any key or section header for its description. `payload` strings are syntax-highlighted as Lua and support full Lua Language Server hover and IntelliSense completions inside the string.
- `Smods: Launch Balatro` and `Smods: Reload Mods (Alt+F5)` with cross-platform keystroke injection.
- `Smods: Launch Balatro (Solo)` — launches Balatro with only Steamodded, Lovely, and the workspace mod active. All other mods are moved to a sibling stash folder beside `Mods/` and restored automatically on exit. Available as a `Solo` status bar button.
- Auto-reload on save (`smods.autoReload`) — debounced Alt+F5 when a `.lua`/`.json`/`.toml` in a detected mod root saves while Balatro runs. Status-bar toggle.
- `Smods: Tail Balatro Log` starts tailing the Lovely log, feeding the Balatro Log panel.
- Balatro Log panel (webview) — per-level filter chips (TRACE/DEBUG/INFO/WARN/ERROR/FATAL) matched against the first word of each line, text search, follow mode, clickable `file:line` links. Filter state (chips, query, follow) is persisted across panel reloads. Launching Balatro focuses this panel automatically.
- `Smods: Bump Mod Version…` — SemVer patch/minor/major/prerelease quick-pick; rewrites only the `version` field.
- `Smods: Package Mod as Zip…` — pure-Node ZIP of the mod folder with sensible excludes (`.git`, `node_modules`, `*.psd`, etc.), parallel file reads.
- Atlas preview webview — CodeLens on `atlas = '...'` opens a clickable sprite grid (zoom slider); clicking writes `pos = { x=, y= }` back to source. 30-s TTL cache.
- Localization linter — CodeLens + diagnostics on `SMODS.<Kind>` blocks missing both inline `loc_txt` and a matching entry in `localization/*.lua`. Offers open-or-create stub in `en-us.lua`.
- Calculate-context hover + completion — 45 `context.*` flags documented with summary, description, and example; active in `.lua` and `lovely-patch` files.
- `Smods: Open SMODS API Reference…` — fuzzy search every class/function in installed Steamodded `lsp_def/`.
- Status bar buttons for launch, solo launch, and reload.
