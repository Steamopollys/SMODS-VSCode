import * as vscode from 'vscode';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { PNG } from 'pngjs';
import { findModRoots } from './paths';
import { getModRootForDocument, findManifestFile } from './modUtils';

interface PackResult {
  outputPath: string;
  width: number;
  height: number;
  cols: number;
  rows: number;
  cellPx: number;
  cellPy: number;
  files: string[];
}

async function readPng(file: string): Promise<PNG> {
  const buf = await fsp.readFile(file);
  return PNG.sync.read(buf);
}

async function listPngs(dir: string): Promise<string[]> {
  let entries: string[];
  try { entries = await fsp.readdir(dir); }
  catch { return []; }
  return entries
    .filter(e => e.toLowerCase().endsWith('.png'))
    .sort((a, b) => a.localeCompare(b))
    .map(e => path.join(dir, e));
}

async function packFolder(
  sourceDir: string,
  outputPath: string
): Promise<PackResult> {
  const files = await listPngs(sourceDir);
  if (files.length === 0) {
    throw new Error(`No PNG files found in ${sourceDir}`);
  }

  const pngs = await Promise.all(files.map(async f => ({ file: f, png: await readPng(f) })));
  const first = pngs[0].png;
  const cellPx = first.width;
  const cellPy = first.height;
  const mismatch = pngs.filter(p => p.png.width !== cellPx || p.png.height !== cellPy);
  if (mismatch.length > 0) {
    const lines = mismatch.map(p => `  ${path.basename(p.file)}: ${p.png.width}×${p.png.height}`);
    throw new Error(
      `Sprites must share dimensions. First sprite is ${cellPx}×${cellPy} ` +
      `but ${mismatch.length} differ:\n${lines.join('\n')}`
    );
  }

  const cols = Math.ceil(Math.sqrt(pngs.length));
  const rows = Math.ceil(pngs.length / cols);
  const out = new PNG({ width: cols * cellPx, height: rows * cellPy });

  pngs.forEach((p, i) => {
    const cx = i % cols;
    const cy = Math.floor(i / cols);
    PNG.bitblt(p.png, out, 0, 0, cellPx, cellPy, cx * cellPx, cy * cellPy);
  });

  await fsp.mkdir(path.dirname(outputPath), { recursive: true });
  await fsp.writeFile(outputPath, PNG.sync.write(out));

  return {
    outputPath,
    width: out.width,
    height: out.height,
    cols, rows,
    cellPx, cellPy,
    files: files.map(f => path.basename(f, '.png'))
  };
}

function buildLuaSnippet(
  result: PackResult,
  atlasKey: string,
  relativePngPath: string
): string {
  const posLines = result.files.map((name, i) => {
    const x = i % result.cols;
    const y = Math.floor(i / result.cols);
    const ident = /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
    const accessor = ident ? name : `['${name.replace(/'/g, "\\'")}']`;
    const sep = ident ? ' = ' : ' = ';
    return `    ${accessor}${sep}{ x = ${x}, y = ${y} },`;
  });
  return [
    `SMODS.Atlas {`,
    `    key = '${atlasKey}',`,
    `    path = '${relativePngPath}',`,
    `    px = ${result.cellPx},`,
    `    py = ${result.cellPy}`,
    `}`,
    ``,
    `local POS = {`,
    ...posLines,
    `}`,
    ``
  ].join('\n');
}

async function pickModRoot(hint?: vscode.Uri): Promise<string | undefined> {
  if (hint) {
    const fromDoc = getModRootForDocument(hint);
    if (fromDoc) { return fromDoc; }
  }
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active) {
    const fromActive = getModRootForDocument(active);
    if (fromActive) { return fromActive; }
  }
  const roots = findModRoots();
  if (roots.length === 1) { return roots[0]; }
  if (roots.length === 0) { return undefined; }
  const pick = await vscode.window.showQuickPick(
    roots.map(r => ({ label: path.basename(r), description: r, path: r })),
    { title: 'Select target mod' }
  );
  return pick?.path;
}

async function pickSourceFolder(initial?: vscode.Uri): Promise<string | undefined> {
  const picked = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false,
    defaultUri: initial,
    openLabel: 'Pack PNGs in this folder'
  });
  return picked?.[0]?.fsPath;
}

interface SourceLayout {
  oneXDir: string;
  twoXDir?: string;
}

function isDir(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/**
 * Resolve the picked folder into a 1x source (required) and optional 2x source.
 *
 * - If picked folder contains a `1x/` subdir, use subfolder mode:
 *     `<picked>/1x/` is 1x, `<picked>/2x/` is 2x (if present).
 * - Otherwise treat the whole picked folder as 1x with no 2x companion.
 */
function resolveLayout(pickedDir: string): SourceLayout {
  const oneXSub = path.join(pickedDir, '1x');
  const twoXSub = path.join(pickedDir, '2x');
  if (isDir(oneXSub)) {
    return {
      oneXDir: oneXSub,
      twoXDir: isDir(twoXSub) ? twoXSub : undefined
    };
  }
  return { oneXDir: pickedDir };
}

async function promptAtlasKey(modRoot: string, sourceDir: string): Promise<string | undefined> {
  const manifest = await findManifestFile(modRoot);
  const prefix = typeof manifest?.data.prefix === 'string' ? manifest.data.prefix : 'mod';
  const baseName = path.basename(sourceDir).toLowerCase().replace(/[^a-z0-9_]/g, '_');
  return vscode.window.showInputBox({
    title: 'Atlas key',
    prompt: 'Atlas key registered with SMODS.Atlas. Combined with your mod prefix at runtime.',
    value: `${prefix}_${baseName}`,
    validateInput: v => (v && !/\s/.test(v)) ? null : 'Required, no spaces.'
  });
}

async function chooseInsertion(
  modRoot: string, atlasKey: string
): Promise<'cursor' | 'file' | 'clipboard' | undefined> {
  const editor = vscode.window.activeTextEditor;
  const luaActive = editor?.document.languageId === 'lua';
  const items: { label: string; description?: string; id: 'cursor' | 'file' | 'clipboard' }[] = [];
  if (luaActive) {
    items.push({ label: '$(edit) Insert at cursor', description: editor!.document.fileName, id: 'cursor' });
  }
  items.push({ label: '$(new-file) New file', description: `atlases/${atlasKey}.lua`, id: 'file' });
  items.push({ label: '$(clippy) Copy to clipboard', id: 'clipboard' });
  const pick = await vscode.window.showQuickPick(items, { title: 'Where should the SMODS.Atlas snippet go?' });
  return pick?.id;
}

async function applyInsertion(
  mode: 'cursor' | 'file' | 'clipboard',
  modRoot: string,
  atlasKey: string,
  snippet: string
): Promise<void> {
  if (mode === 'clipboard') {
    await vscode.env.clipboard.writeText(snippet);
    vscode.window.showInformationMessage('Atlas snippet copied to clipboard.');
    return;
  }
  if (mode === 'cursor') {
    const editor = vscode.window.activeTextEditor!;
    await editor.edit(b => b.insert(editor.selection.active, snippet));
    return;
  }
  const targetDir = path.join(modRoot, 'atlases');
  await fsp.mkdir(targetDir, { recursive: true });
  const filePath = path.join(targetDir, `${atlasKey}.lua`);
  try {
    await fsp.access(filePath);
    const overwrite = await vscode.window.showWarningMessage(
      `${path.basename(filePath)} already exists. Overwrite?`,
      { modal: true }, 'Overwrite'
    );
    if (overwrite !== 'Overwrite') { return; }
  } catch { /* doesn't exist */ }
  await fsp.writeFile(filePath, snippet);
  const doc = await vscode.workspace.openTextDocument(filePath);
  await vscode.window.showTextDocument(doc);
}

async function runPack(
  hint: vscode.Uri | undefined,
  output: vscode.LogOutputChannel
): Promise<{
  result: PackResult;
  layout: SourceLayout;
  pickedDir: string;
  modRoot: string;
  atlasKey: string;
} | undefined> {
  const modRoot = await pickModRoot(hint);
  if (!modRoot) {
    vscode.window.showErrorMessage(
      'No Smods mod folder detected in your workspace. Run "Smods: New Mod…" first.'
    );
    return;
  }

  const initialUri = hint ?? vscode.Uri.file(modRoot);
  const hintIsDir = !!(hint && isDir(hint.fsPath));
  const pickedDir = hintIsDir
    ? hint!.fsPath
    : await pickSourceFolder(initialUri);
  if (!pickedDir) { return; }

  const layout = resolveLayout(pickedDir);

  const atlasKey = await promptAtlasKey(modRoot, pickedDir);
  if (!atlasKey) { return; }

  const insertion = await chooseInsertion(modRoot, atlasKey);
  if (!insertion) { return; }

  const oneXOutput = path.join(modRoot, 'assets', '1x', `${atlasKey}.png`);

  let result: PackResult;
  try {
    result = await packFolder(layout.oneXDir, oneXOutput);
  } catch (err) {
    output.error(`Atlas pack failed: ${err}`);
    vscode.window.showErrorMessage(`Atlas pack failed: ${err instanceof Error ? err.message : err}`);
    return;
  }

  if (layout.twoXDir) {
    try {
      const twoXResult = await packFolder(
        layout.twoXDir,
        path.join(modRoot, 'assets', '2x', `${atlasKey}.png`)
      );
      output.info(
        `Packed 2x → ${twoXResult.outputPath} ` +
        `(${twoXResult.cols}×${twoXResult.rows} grid, ${twoXResult.cellPx}×${twoXResult.cellPy} cells)`
      );
      const oneNames = [...result.files].sort();
      const twoNames = [...twoXResult.files].sort();
      const mismatch =
        oneNames.length !== twoNames.length ||
        oneNames.some((n, i) => n !== twoNames[i]);
      if (mismatch) {
        vscode.window.showWarningMessage(
          '1x and 2x sprite sets differ. The POS lookup is based on the 1x grid; ' +
          '2x cells may not align with their 1x counterparts.'
        );
      }
    } catch (err) {
      output.warn(`2x pack skipped: ${err}`);
      vscode.window.showWarningMessage(`2x pack skipped: ${err instanceof Error ? err.message : err}`);
    }
  }

  const snippet = buildLuaSnippet(result, atlasKey, `${atlasKey}.png`);
  await applyInsertion(insertion, modRoot, atlasKey, snippet);

  const summary = layout.twoXDir
    ? `Packed ${result.files.length} sprites (1x + 2x) into ${atlasKey}.png.`
    : `Packed ${result.files.length} sprites into ${atlasKey}.png.`;
  output.info(
    `Packed ${result.files.length} sprites → ${result.outputPath} ` +
    `(${result.cols}×${result.rows} grid, ${result.cellPx}×${result.cellPy} cells)` +
    (layout.twoXDir ? ' [+2x]' : '')
  );
  vscode.window.showInformationMessage(summary);
  return { result, layout, pickedDir, modRoot, atlasKey };
}

interface WatcherEntry {
  watcher: fs.FSWatcher;
  timer?: NodeJS.Timeout;
}

const watchers = new Map<string, WatcherEntry>();

function autoRepackEnabled(): boolean {
  return vscode.workspace.getConfiguration('smods').get<boolean>('atlasPacker.autoRepack', false);
}

function clearWatchers(): void {
  for (const w of watchers.values()) {
    if (w.timer) { clearTimeout(w.timer); }
    w.watcher.close();
  }
  watchers.clear();
}

function installWatcher(
  sourceDir: string,
  outputPath: string,
  variant: '1x' | '2x',
  output: vscode.LogOutputChannel
): void {
  if (watchers.has(sourceDir)) { return; }
  let watcher: fs.FSWatcher;
  try {
    watcher = fs.watch(sourceDir, { persistent: false });
  } catch (err) {
    output.warn(`Could not watch ${sourceDir}: ${err}`);
    return;
  }
  const entry: WatcherEntry = { watcher };
  watcher.on('change', (_evt, filename) => {
    if (typeof filename !== 'string' || !filename.toLowerCase().endsWith('.png')) { return; }
    if (entry.timer) { clearTimeout(entry.timer); }
    entry.timer = setTimeout(async () => {
      try {
        const result = await packFolder(sourceDir, outputPath);
        output.info(`Auto-repacked ${variant} ${result.files.length} sprites → ${result.outputPath}`);
      } catch (err) {
        output.error(`Auto-repack ${variant} failed: ${err}`);
      }
    }, 300);
  });
  watcher.on('error', err => output.error(`Watcher error: ${err}`));
  watchers.set(sourceDir, entry);
}

export function registerAtlasPacker(
  context: vscode.ExtensionContext,
  output: vscode.LogOutputChannel
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('smods.packAtlas', async (resource?: vscode.Uri) => {
      const out = await runPack(resource, output);
      if (out && autoRepackEnabled()) {
        const oneXOut = path.join(out.modRoot, 'assets', '1x', `${out.atlasKey}.png`);
        installWatcher(out.layout.oneXDir, oneXOut, '1x', output);
        if (out.layout.twoXDir) {
          const twoXOut = path.join(out.modRoot, 'assets', '2x', `${out.atlasKey}.png`);
          installWatcher(out.layout.twoXDir, twoXOut, '2x', output);
        }
      }
    }),
    { dispose: clearWatchers }
  );
}
