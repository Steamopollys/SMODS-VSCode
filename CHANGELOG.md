# Change Log

All notable changes to the Smods Tools extension are documented here.

## [0.5.0]

### Added
- Atlas preview gained an animation mode. The preview webview now exposes a `mode` dropdown (Static grid / Animate) plus an FPS slider (1–60, default 12) and a play/pause button. When a `SMODS.Atlas` block declares `frames > 1`, animate is the default mode and a `<canvas>` cycles `frames` cells starting from the selected `pos`. Clicking a cell while in animate mode resets the frame counter to that new origin so you can preview any joker's animation by clicking its first cell.

### Changed
- Atlas preview HTML restructured: the cell grid and animation canvas now share the same `.wrap` and toggle via `data-mode`. Cell selection still writes `pos = { x = …, y = … }` back to source in static mode.

## [0.4.0]

### Added
- `Smods: Pack PNGs into Atlas…` command. Pick any folder (intended to live outside `assets/`). The packer reads its PNGs, validates uniform dimensions, packs them into a `cols × rows` grid (cols = ceil(sqrt(n))), writes the result to `assets/1x/<key>.png`, and inserts a `SMODS.Atlas{}` block plus a `local POS = { … }` map of every sprite's `{x,y}` cell at cursor or as a new file under `atlases/<key>.lua`. Default key comes from the manifest `prefix`. Also available from explorer right-click on any folder.
- 2x via subfolder: if the picked folder contains a `1x/` subdir, the packer reads sprites from `<picked>/1x/` and (optionally) `<picked>/2x/`, packing both atlases under the same `<key>`. A warning is emitted when the 1x and 2x sprite sets differ in name or count, since the `POS` lookup is computed from the 1x grid.
- `smods.atlasPacker.autoRepack` setting (default `false`) — installs an `fs.watch` on each packed source folder (1x, and 2x when present) after a successful pack and re-runs the pack 300 ms after any PNG add/remove/change. Watchers cleared on extension deactivate.

### Changed
- New runtime dependency: `pngjs`.



### Added
- `smods.launchArgs` setting — string array of extra command-line arguments forwarded to Balatro on launch. Argv-spread when launching directly, appended to the Steam URL (`steam://rungameid/2379780//<args>`) otherwise.

### Fixed
- Direct launch (`smods.launchWithoutSteam=true`) now injects `--disable-console` and a bare `-` arg automatically. Without `--disable-console` the Lovely console window stays blank (falls back to the Love2D console); the `-` is required by Lovely's argv parsing. Both are deduped against any matching entry in `smods.launchArgs`.

## [0.3.2]

### Added
- `smods.love2dLibraryPath` setting — absolute path to a Love2D API/source directory (e.g. a `love-api` stubs clone). Attached to `Lua.workspace.library` when non-empty and the path exists.
- `smods.balatroSourcePath` setting — absolute path to extracted Balatro Lua source. Attached to `Lua.workspace.library` when non-empty and the path exists.

### Changed
- `autoAttachLuaTypes` now also attaches `smods-*/src` alongside `smods-*/lsp_def`. Ctrl-click on a SMODS symbol lands in real source when statically resolvable; otherwise it lands in the `---@meta` stubs.
- Attach step no longer bails when SMODS is missing — the configured Love2D and Balatro paths still get attached (SMODS-missing is logged as a warning).
- `autoAttachLuaTypes` also pins `Lua.runtime.version` to `LuaJIT` in workspace settings (Balatro runs on LuaJIT — 5.1 + JIT extensions). Prevents spurious Lua 5.4-only diagnostics and exposes `bit` / `ffi` / `jit` globals.

## [0.3.1]

### Added
- `smods.launchWithoutSteam` setting (default `false`). When enabled, every launch path (launch, solo, reload) spawns `smods.balatroExecutable` directly instead of opening `steam://rungameid/2379780`. Errors if the executable path is not set or auto-detected.

### Changed
- Debug panel Globals tree auto-detects roots from `_G` on connect (filters Lua/LÖVE builtins, returns table-type keys) instead of using a hardcoded `G` / `G.GAME` / `G.jokers` / … list. Added `listGlobals` bridge RPC. User pin/hide overrides layer on top via `smods.debugTreePinned` and `smods.debugTreeHidden` workspaceState keys; unpinning an auto-root hides it, pinning a path adds it. Refresh button re-runs detection when connected.

## [0.3.0]

### Added
- Debug mode — loopback TCP bridge to a running Balatro. Toggle from the status bar. On next launch the `smods-debug-bridge` mod is copied into `Mods/` and the Debug panel opens.
- Debug panel: Lua REPL, pause/resume/step (shift-click Step = 10 frames), live `G` tree with editable values, watch expressions, DebugPlus log pane, profiler + perf-overlay toggles, 5 save-state slots.
- Commands: `Toggle Debug Mode`, `Pause Engine` (F6), `Resume Engine` (Shift+F6), `Eval Lua in Balatro…`, `Show Debug Panel`.
- Settings: `smods.debugPort` (default 43278, +10 fallback), `smods.debugAutoOpenPanel` (default true).
- Context key `smods.debugConnected` gates pause/resume/eval.
- DebugPlus (any `debugplus*` folder) skipped by the solo blacklist, so solo + debug combine.

### Changed
- Reload now kills Balatro (`taskkill /IM Balatro.exe /F` on Windows, `pkill -x Balatro` elsewhere) and relaunches via Steam. No more Alt+F5 keystroke injection. Drops the PowerShell / `osascript` / `xdotool` dependency.

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
- Lovely `patches.toml` support — built-in TOML parser and diagnostics (no external extension required) for `[manifest]`, `[[patches]]`, and the `pattern`/`regex`/`copy`/`module` payload types. Checks required fields, validates types, enforces the `position` enum. Hover any key or section header for its description. `payload` strings are syntax-highlighted as Lua and support full Lua Language Server hover and IntelliSense completions inside the string.
- `Smods: Launch Balatro` and `Smods: Reload Mods (Alt+F5)` with cross-platform keystroke injection.
- `Smods: Launch Balatro (Solo)` — launches Balatro with only Steamodded, Lovely, and the workspace mod active. All other mods are moved to a sibling stash folder beside `Mods/` and restored automatically on exit. Available as a `Solo` status bar button.
- Auto-reload on save (`smods.autoReload`) — debounced Alt+F5 when a `.lua`/`.json`/`.toml` in a detected mod root saves while Balatro runs. Status-bar toggle.
- `Smods: Tail Balatro Log` tails the Lovely log; output goes to the Balatro Log panel.
- Balatro Log panel (webview) — per-level filter chips (TRACE/DEBUG/INFO/WARN/ERROR/FATAL) matched against the first word of each line, text search, follow mode, clickable `file:line` links. Filter state (chips, query, follow) is persisted across panel reloads. Launching Balatro focuses this panel automatically.
- `Smods: Bump Mod Version…` — SemVer patch/minor/major/prerelease quick-pick; rewrites only the `version` field.
- `Smods: Package Mod as Zip…` — ZIP of the mod folder, default excludes (`.git`, `.vscode`, `*.psd`, `*.aseprite`, `*.bak`, etc.).
- Atlas preview webview — CodeLens on `atlas = '...'` opens a clickable sprite grid (zoom slider); clicking writes `pos = { x=, y= }` back to source. 30-s TTL cache.
- Localization linter — CodeLens + diagnostics on `SMODS.<Kind>` blocks missing both inline `loc_txt` and a matching entry in `localization/*.lua`. Offers open-or-create stub in `en-us.lua`.
- Calculate-context hover + completion — 45 `context.*` flags documented with summary, description, and example; active in `.lua` and `lovely-patch` files.
- `Smods: Open SMODS API Reference…` — fuzzy search every class/function in installed Steamodded `lsp_def/`.
- Status bar buttons for launch, solo launch, and reload.
