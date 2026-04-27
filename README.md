# Smods Tools

VSCode support for [Steamodded](https://github.com/Steamodded/smods).

## Features

- **Snippets** for every major SMODS object — jokers, consumables, decks, vouchers, boosters, editions, seals, blinds, tags, rarities, ranks, suits, atlases, sounds, shaders, challenges, keybinds, and more. Type `smods-` in any `.lua` file to see them all.
- **IntelliSense & hover docs** via Steamodded's `lsp_def/` type definitions and its `src/` folder, both attached to `Lua.workspace.library`. Ctrl-click jumps into SMODS source when statically resolvable; stubs are the fallback. Powered by the [sumneko Lua Language Server](https://marketplace.visualstudio.com/items?itemName=sumneko.lua) (installed automatically as a dependency). You get completion on `SMODS.Joker`, calculate-function `context` fields, the `Card` class, and more. Requires Steamodded installed in your `Mods/` folder. Optionally point `smods.love2dLibraryPath` and `smods.balatroSourcePath` at Love2D API stubs and extracted Balatro Lua to get the same treatment for engine + base-game symbols.
- **Mod scaffolding** — `Smods: New Mod…` creates a mod folder with manifest, `main.lua`, localization stub, optional atlas folders, and optional Lovely patch folder. Separate commands create jokers, consumables, vouchers, decks, editions, seals, blinds, tags, boosters, enhancements, shaders, sounds, and challenges from templates. When a Lua file is already open, scaffold commands offer to **insert at cursor** instead of creating a new file.
- **Manifest validation** — JSON schema plus extra checks: reserved IDs, missing `main_file` on disk, bad badge hex, malformed or unresolvable `dependencies`, and more. Errors appear in the Problems panel.
- **Lovely `patches.toml` support** — built-in validation (no external extension needed) with diagnostics for required fields, type errors, invalid `position` values, and unknown keys. Hover any key or section header for its description. `payload` strings (both `"""` and `'''`) are syntax-highlighted as Lua and support full Lua Language Server hover and IntelliSense (completions) inside the string.
- **Launch & reload Balatro** from VSCode with status bar buttons. Reload kills Balatro (`taskkill` / `pkill`) and relaunches via Steam, or directly via `smods.balatroExecutable` when `smods.launchWithoutSteam` is on. Solo and debug flags carry over.
- **Solo launch** — `Solo` button launches with only Steamodded, Lovely, and your workspace mod. Other mods go into `lovely/blacklist.txt` and come back out on exit. DebugPlus is never blacklisted, so solo + debug work together.
- **Debug mode** — click the bug icon (or `Smods: Toggle Debug Mode`) to arm a loopback TCP bridge for next launch. Opens a `Balatro Debug` panel with: Lua REPL, pause/resume/step (shift-click Step = 10 frames), live Globals tree auto-detected from `_G` on connect (excludes Lua/LÖVE builtins; pin/hide paths to customise) with editable values, watch expressions, DebugPlus log pane, profiler + perf-overlay toggles, 5-slot save-state grid. Pause doesn't freeze the window. Requires [DebugPlus](https://github.com/WilsontheWolf/DebugPlus) ≥ 1.5.0 in `Mods/`; the extension prompts to install it.
- **Auto-reload on save** — while Balatro runs, saving a `.lua`/`.json`/`.toml` in a detected mod root triggers a debounced reload. Toggle via status bar or `smods.autoReload`.
- **Balatro Log panel** — dedicated webview with per-level filter chips (TRACE/DEBUG/INFO/WARN/ERROR/FATAL) matched against the first word of each line, text search, follow mode, and clickable `file:line` links that jump to the source. Filter state (active chips, query, follow) is persisted across panel reloads.
- **Atlas preview & sprite picker** — CodeLens above every `atlas = '...'` opens a clickable grid of the atlas image. Click a cell to write `pos = { x=, y= }` back to source. When the atlas has `frames > 1`, switch the preview to **Animate** mode (default for animated atlases) to play the sprite sheet at 1–60 FPS with a play/pause button. Click any cell while animating to reset the playback origin.
- **Atlas packer** — `Smods: Pack PNGs into Atlas…` packs a folder of equally-sized PNGs (intended to live outside `assets/`) into `assets/1x/<key>.png` and inserts a ready-to-use `SMODS.Atlas{}` block plus a `local POS = { ... }` map of every sprite's `{x,y}`. To also produce a 2x atlas, lay your source folder out as `<picked>/1x/` and `<picked>/2x/` with matching filenames; both are packed under the same `<key>`. Right-click any folder in the explorer to pack it directly. Optional `smods.atlasPacker.autoRepack` setting watches the 1x (and 2x when present) source folder and re-emits the atlas on add/remove.
- **Shader live preview** *(WIP)* — CodeLens above every `SMODS.Shader { key, path }` block (and at the top of any `*.fs` file) opens a WebGL preview that compiles the shader and renders it on a sample sprite. Auto-detected `extern` uniform sliders, per-uniform `↻` real-time tickers, global speed multiplier, FPS cap, scale, sprite picker. Reloads on file save; errors land in a dedicated pane. When the debug bridge is connected, **Apply to Selected Card** registers a temporary SMODS edition tied to your shader and applies it to the highlighted card in-game (revert via `Smods: Revert Shader Preview Overrides`).
  > **Heads up:** this feature is still in development. The webview is a minimal WebGL adapter, not a full reimplementation, so the preview may not exactly match how the shader looks in-game. Some shader types — vertex shaders, shaders relying on uniforms not yet supported, anything reading custom textures or built-ins — may not animate or may render differently. Use **Apply to Selected Card** for ground-truth in-game checking.
- **Localization linter** — flags `SMODS.<Kind>` blocks with no inline `loc_txt` and no matching entry in `localization/*.lua`. CodeLens jumps to the entry or creates a stub in `en-us.lua`.
- **Calculate-context hover + completion** — hover any `context.<flag>` in a `calculate` function for a description and example. Auto-completes all 45 documented flags.
- **SMODS API quick-search** — `Smods: Open SMODS API Reference…` fuzzy-searches every class/function in Steamodded's `lsp_def/` and jumps to the definition.
- **Version bump + package** — `Smods: Bump Mod Version…` rewrites the manifest's SemVer (patch/minor/major/prerelease). `Smods: Package Mod as Zip…` zips the mod with default excludes (`.git`, etc.).
- **Auto-symlink mod on launch** — optionally symlinks your mod folder into the Balatro `Mods/` directory before launch or reload, then removes it when Balatro exits or VS Code closes. You can keep your mod folder anywhere on disk; no manual copying. Enable via `smods.symlinkModOnLaunch`.

## Requirements

- VSCode 1.85 or newer.
- The [sumneko.lua](https://marketplace.visualstudio.com/items?itemName=sumneko.lua) extension (auto-installed as a dependency).
- A working Steamodded + Lovely installation. See [Installing Steamodded](https://github.com/Steamodded/smods/wiki/Installation).

## Settings

| Setting | Description |
|---|---|
| `smods.balatroExecutable` | Absolute path to `Balatro.exe`. Auto-detected on Steam installs. |
| `smods.launchWithoutSteam` | Launch Balatro directly via `smods.balatroExecutable` instead of Steam. Applies to launch, solo, and reload. Default false. Direct launches automatically prepend `--disable-console` and a bare `-` arg (required for Lovely to hook correctly). |
| `smods.launchArgs` | Extra command-line arguments forwarded to Balatro on launch. Argv-spread when launching directly. URL-encoded suffix on the Steam URL otherwise. Default `[]`. |
| `smods.modsFolder` | Path to the Balatro `Mods/` folder. Defaults to `%AppData%/Balatro/Mods`. |
| `smods.logFile` | Path to the Lovely log. Defaults to files under `%AppData%/Balatro/`. |
| `smods.autoAttachLuaTypes` | When true, adds Steamodded's `lsp_def/` and `src/` folders to `Lua.workspace.library` and pins `Lua.runtime.version` to `LuaJIT` (Balatro's runtime). |
| `smods.love2dLibraryPath` | Absolute path to a Love2D API/source directory to attach to `Lua.workspace.library`. Empty = skip. |
| `smods.balatroSourcePath` | Absolute path to extracted Balatro Lua source to attach to `Lua.workspace.library`. Empty = skip. |
| `smods.defaultAuthor` | Default author name pre-filled when scaffolding. |
| `smods.symlinkModOnLaunch` | Symlink detected mod roots into `Mods/` on launch/reload; remove them on exit. Do not enable if your workspace is already inside the Mods folder. On Windows, requires Developer Mode or admin. |
| `smods.autoReload` | Auto-reload Balatro when a `.lua`/`.json`/`.toml` file saves in a detected mod root. |
| `smods.autoReloadDelay` | Debounce window (ms) between last save and the auto-reload. Default 500. |
| `smods.debugPort` | Port the debug bridge listens on. Bridge scans +10 if busy. Default 43278. |
| `smods.debugAutoOpenPanel` | Auto-reveal the Debug panel on connect. Default true. |
| `smods.atlasPacker.autoRepack` | After packing, watch the source folder and repack on PNG add/remove. Default false. |

## Commands

All commands live under the "Smods:" prefix in the Command Palette.

| Command | What it does |
|---|---|
| `New Mod…` | Scaffold a complete Smods mod folder. |
| `New Joker…` / `New Consumable…` / `New Voucher…` / `New Deck (Back)…` / `New Edition…` / `New Seal…` / `New Blind…` / `New Tag…` / `New Booster Pack…` / `New Enhancement…` / `New Shader…` / `New Sound…` / `New Challenge…` | Add a new object from a template, inserting at cursor or creating a new file. |
| `Launch Balatro` | Launch Balatro via Steam (or directly when `smods.launchWithoutSteam` is enabled). |
| `Launch Balatro (Solo)` | Launch Balatro with only Steamodded, Lovely, and your workspace mod. Other mods are blacklisted via `lovely/blacklist.txt` and restored on exit. |
| `Reload Mods (Alt+F5)` | Kill Balatro and relaunch (Steam or direct, following `smods.launchWithoutSteam`). |
| `Toggle Auto-Reload on Save` | Flip `smods.autoReload`. |
| `Tail Balatro Log` | Start tailing the Lovely log (feeds the Balatro Log panel). |
| `Open Mods Folder` | Reveal the Balatro Mods folder in your file manager. |
| `Validate Mod Manifest` | Force a revalidation of the active manifest. |
| `Bump Mod Version…` | SemVer patch/minor/major/prerelease bump on the manifest. |
| `Package Mod as Zip…` | Zip the mod for distribution (`<id>-<version>.zip`). |
| `Open SMODS API Reference…` | Fuzzy search Steamodded classes/functions and jump to definition. |
| `Pack PNGs into Atlas…` | Combine a folder of equally-sized PNGs into one atlas PNG plus a `SMODS.Atlas{}` snippet and `POS` lookup table. Available from the explorer right-click on a folder. |
| `Preview Shader…` | Opened from the CodeLens above any `SMODS.Shader { key, path }` block or any `*.fs` file. WebGL preview with hot reload on save and optional live push to a running Balatro via the debug bridge. |
| `Toggle Debug Mode` | Arm/disarm the debug bridge. Applies on next launch. |
| `Pause Engine` / `Resume Engine` | Freeze or resume `love.update` (F6 / Shift+F6). |
| `Eval Lua in Balatro…` | Run Lua in the running process. |
| `Show Debug Panel` | Reveal the Debug webview. |

## Known limitations

- Reload kills Balatro — in-memory state is lost. Use the Debug panel save slots to checkpoint a run.
- Balatro executable auto-detection covers Steam install paths only. Set `smods.balatroExecutable` if yours is elsewhere.
- Atlas preview needs `key` and `path` as plain string literals. Variables/concatenation aren't resolved.
- Debug mode needs [DebugPlus](https://github.com/WilsontheWolf/DebugPlus) ≥ 1.5.0 in `Mods/`.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Snippets are the easiest place to contribute — plain JSON, no build step.

## License

MIT. See [LICENSE](./LICENSE).
