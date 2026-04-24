# Contributing

Thanks for your interest in improving Smods Tools!

## Development setup

```bash
git clone https://github.com/YOUR_USER/smods-tools.git
cd smods-tools
npm install
```

Press **F5** in VSCode to launch the Extension Development Host with your working copy loaded. Reload with `Ctrl+R` / `Cmd+R` in that window to pick up code changes (or use the "Run Extension (watch)" launch config for automatic recompilation).

## Project layout

- `src/` — TypeScript source for commands, runtime, log tailer, validators, debug agent + view.
- `snippets/smods.code-snippets` — JSON snippet file, no code required to contribute here.
- `schemas/smods-manifest.schema.json` — manifest JSON schema.
- `media/` — icon and other assets shipped with the extension.
- `media/smods-debug-bridge/` — Lua mod (`main.lua`, `bridge.lua`) copied into `Mods/` on armed launch. Edit here for in-game RPC changes; picked up on next Balatro launch.

## Easy first contributions

- **Add a snippet.** Open `snippets/smods.code-snippets` and add an entry. No build step needed — reload the Extension Development Host and type your prefix.
- **Improve the manifest validator.** See `src/manifestValidator.ts` — each rule is a handful of lines.

## Pull requests

- Run `npm run lint` and `npm run compile` before submitting.
- If you add a user-visible feature, mention it in `CHANGELOG.md` under an "Unreleased" section.
- Screenshots or short clips help a lot for UI changes.

## Release process (maintainers)

1. Bump `version` in `package.json`.
2. Move the `Unreleased` changelog section under the new version with today's date.
3. `npm run vsix` to produce a local `.vsix`.
4. `vsce publish` (requires a Personal Access Token).
