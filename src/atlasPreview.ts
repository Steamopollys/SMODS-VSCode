import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { findMatchingBrace, getModRootForDocument } from './modUtils';

interface AtlasInfo {
  key: string;
  path: string;
  px: number;
  py: number;
  frames: number;
  imagePath?: string;
  imageScale: number;  // 1 for 1x images, 2 for 2x images
  modRoot: string;
}

interface BlockMatch {
  atlasKey: string;
  atlasRange: vscode.Range;
  posRange?: vscode.Range;
  posX?: number;
  posY?: number;
}

function findAtlasBlocks(doc: vscode.TextDocument): BlockMatch[] {
  const text = doc.getText();
  const out: BlockMatch[] = [];
  const blockRe = /SMODS\.\w+\s*[({]/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(text))) {
    const brace = text.indexOf('{', m.index);
    if (brace === -1) {continue;}
    const close = findMatchingBrace(text, brace);
    if (close === -1) {continue;}
    const body = text.slice(brace, close + 1);

    const atlasM = /\batlas\s*=\s*['"]([^'"]+)['"]/.exec(body);
    if (!atlasM) {continue;}
    const atlasAbs = brace + atlasM.index;
    const atlasRange = new vscode.Range(
      doc.positionAt(atlasAbs),
      doc.positionAt(atlasAbs + atlasM[0].length)
    );

    const block: BlockMatch = { atlasKey: atlasM[1], atlasRange };

    const posM = /\bpos\s*=\s*\{\s*x\s*=\s*(-?\d+)\s*,\s*y\s*=\s*(-?\d+)\s*\}/
      .exec(body);
    if (posM) {
      const posAbs = brace + posM.index;
      block.posRange = new vscode.Range(
        doc.positionAt(posAbs),
        doc.positionAt(posAbs + posM[0].length)
      );
      block.posX = Number(posM[1]);
      block.posY = Number(posM[2]);
    }
    out.push(block);
  }
  return out;
}

function resolveAtlasImage(modRoot: string, pngName: string): { imagePath: string; imageScale: number } | undefined {
  const candidates: { imagePath: string; imageScale: number }[] = [
    { imagePath: path.join(modRoot, 'assets', '2x', pngName), imageScale: 2 },
    { imagePath: path.join(modRoot, 'assets', '1x', pngName), imageScale: 1 },
    { imagePath: path.join(modRoot, 'assets', pngName),       imageScale: 1 },
    { imagePath: path.join(modRoot, pngName),                 imageScale: 1 },
  ];
  return candidates.find(c => fs.existsSync(c.imagePath));
}

function scanAtlasDefsInFile(
  file: string, modRoot: string, out: Map<string, AtlasInfo>
): void {
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch { return; }
  const re = /SMODS\.Atlas\s*[({]\s*\{?([\s\S]*?)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const body = m[1];
    const key = /\bkey\s*=\s*['"]([^'"]+)['"]/.exec(body)?.[1];
    const p   = /\bpath\s*=\s*['"]([^'"]+)['"]/.exec(body)?.[1];
    const px  = Number(/\bpx\s*=\s*(\d+)/.exec(body)?.[1] ?? '71');
    const py  = Number(/\bpy\s*=\s*(\d+)/.exec(body)?.[1] ?? '95');
    const frames = Number(/\bframes\s*=\s*(\d+)/.exec(body)?.[1] ?? '1');
    if (!key || !p) {continue;}
    const resolved = resolveAtlasImage(modRoot, p);
    out.set(key, { key, path: p, px, py, frames, imagePath: resolved?.imagePath, imageScale: resolved?.imageScale ?? 1, modRoot });
  }
}

const atlasCache = new Map<string, { at: number; atlases: Map<string, AtlasInfo> }>();
const ATLAS_TTL_MS = 30_000;

function collectAtlases(modRoot: string): Map<string, AtlasInfo> {
  const hit = atlasCache.get(modRoot);
  if (hit && Date.now() - hit.at < ATLAS_TTL_MS) {return hit.atlases;}
  const out = new Map<string, AtlasInfo>();
  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) {continue;}
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {walk(full);}
      else if (e.isFile() && e.name.endsWith('.lua')) {
        scanAtlasDefsInFile(full, modRoot, out);
      }
    }
  }
  walk(modRoot);
  atlasCache.set(modRoot, { at: Date.now(), atlases: out });
  return out;
}

function findAtlasDefBlocks(doc: vscode.TextDocument): { info: AtlasInfo | Partial<AtlasInfo>; range: vscode.Range }[] {
  const text = doc.getText();
  const out: { info: AtlasInfo | Partial<AtlasInfo>; range: vscode.Range }[] = [];
  const re = /SMODS\.Atlas\s*[({]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const brace = text.indexOf('{', m.index);
    if (brace === -1) { continue; }
    const close = findMatchingBrace(text, brace);
    if (close === -1) { continue; }
    const body = text.slice(brace, close + 1);
    const key  = /\bkey\s*=\s*['"]([^'"]+)['"]/.exec(body)?.[1];
    const p    = /\bpath\s*=\s*['"]([^'"]+)['"]/.exec(body)?.[1];
    const px   = Number(/\bpx\s*=\s*(\d+)/.exec(body)?.[1] ?? '71');
    const py   = Number(/\bpy\s*=\s*(\d+)/.exec(body)?.[1] ?? '95');
    const frames = Number(/\bframes\s*=\s*(\d+)/.exec(body)?.[1] ?? '1');
    const range = new vscode.Range(
      doc.positionAt(m.index),
      doc.positionAt(m.index + 'SMODS.Atlas'.length)
    );
    out.push({ info: { key, path: p, px, py, frames }, range });
  }
  return out;
}


class AtlasCodeLensProvider implements vscode.CodeLensProvider {
  private _onDid = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDid.event;

  refresh(): void { this._onDid.fire(); }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    if (doc.languageId !== 'lua') {return [];}
    const modRoot = getModRootForDocument(doc.uri);
    if (!modRoot) {return [];}
    const atlases = collectAtlases(modRoot);
    const lenses: vscode.CodeLens[] = [];

    // Lenses on SMODS.Atlas definitions
    for (const { info, range } of findAtlasDefBlocks(doc)) {
      if (!info.key || !info.path) {
        lenses.push(new vscode.CodeLens(range, {
          title: '$(warning) Atlas key/path must be string literals to preview',
          command: ''
        }));
        continue;
      }
      const resolved = resolveAtlasImage(modRoot, info.path);
      const full: AtlasInfo = {
        key: info.key, path: info.path,
        px: info.px ?? 71, py: info.py ?? 95,
        frames: info.frames ?? 1,
        imagePath: resolved?.imagePath, imageScale: resolved?.imageScale ?? 1, modRoot
      };
      lenses.push(new vscode.CodeLens(range, {
        title: resolved?.imagePath
          ? `$(symbol-file) Preview atlas "${info.key}"`
          : `$(warning) Image not found: "${info.path}"`,
        command: resolved?.imagePath ? 'smods.previewAtlas' : '',
        arguments: resolved?.imagePath ? [{ docUri: doc.uri.toString(), atlasInfo: full }] : []
      }));
    }

    // Lenses on blocks that reference an atlas
    const blocks = findAtlasBlocks(doc);
    for (const b of blocks) {
      const info = atlases.get(b.atlasKey);
      const title = info?.imagePath
        ? `$(symbol-file) Preview atlas "${b.atlasKey}"`
        : `$(warning) Atlas "${b.atlasKey}" not found`;
      lenses.push(new vscode.CodeLens(b.atlasRange, {
        title,
        command: info?.imagePath ? 'smods.previewAtlas' : '',
        arguments: info?.imagePath ? [{
          docUri: doc.uri.toString(),
          atlasInfo: info,
          posRange: b.posRange ? {
            start: { line: b.posRange.start.line, char: b.posRange.start.character },
            end:   { line: b.posRange.end.line,   character: b.posRange.end.character }
          } : undefined,
          posX: b.posX, posY: b.posY
        }] : []
      }));
    }
    return lenses;
  }
}

interface PreviewArgs {
  docUri: string;
  atlasInfo: AtlasInfo;
  posRange?: { start: { line: number; char: number };
               end:   { line: number; character: number } };
  posX?: number;
  posY?: number;
}

async function openPreview(
  context: vscode.ExtensionContext, args: PreviewArgs
): Promise<void> {
  const { atlasInfo } = args;
  if (!atlasInfo.imagePath) {
    vscode.window.showErrorMessage(`Atlas image missing: ${atlasInfo.path}`);
    return;
  }
  const panel = vscode.window.createWebviewPanel(
    'smodsAtlas',
    `Atlas: ${atlasInfo.key}`,
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.file(atlasInfo.modRoot)] }
  );
  const imgUri = panel.webview.asWebviewUri(vscode.Uri.file(atlasInfo.imagePath));
  panel.webview.html = renderHtml(
    imgUri.toString(), atlasInfo, args.posX ?? 0, args.posY ?? 0
  );

  panel.webview.onDidReceiveMessage(async msg => {
    if (msg.type !== 'pick') {return;}
    const { x, y } = msg;
    if (!args.posRange) {
      await vscode.env.clipboard.writeText(`pos = { x = ${x}, y = ${y} }`);
      vscode.window.showInformationMessage(
        `No pos = {...} in source — copied "pos = { x = ${x}, y = ${y} }" to clipboard.`
      );
      return;
    }
    const doc = vscode.workspace.textDocuments
      .find(d => d.uri.toString() === args.docUri)
      ?? await vscode.workspace.openTextDocument(vscode.Uri.parse(args.docUri));
    const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
    const range = new vscode.Range(
      args.posRange.start.line, args.posRange.start.char,
      args.posRange.end.line, args.posRange.end.character
    );
    await editor.edit(b => b.replace(range, `pos = { x = ${x}, y = ${y} }`));
  });

  context.subscriptions.push(panel);
}

function renderHtml(
  imgSrc: string, info: AtlasInfo, startX: number, startY: number
): string {
  const scale = info.imageScale ?? 1;
  return `<!doctype html><html><head><meta charset="utf-8">
<style>
  body { margin: 0; padding: 1em; font: 13px var(--vscode-font-family); color: var(--vscode-foreground); }
  .info { margin-bottom: 0.6em; opacity: 0.8; }
  .wrap { position: relative; display: inline-block; }
  img { display: block; image-rendering: pixelated; max-width: none; }
  .cell { position: absolute; border: 1px solid rgba(255,255,255,0.15); box-sizing: border-box; cursor: pointer; }
  .cell:hover { border-color: #3af; background: rgba(51,170,255,0.15); }
  .cell.sel { border-color: #ff0; background: rgba(255,255,0,0.2); }
  .cell .lbl { position: absolute; bottom: 0; right: 2px; font-size: 10px; color: #fff;
               text-shadow: 0 0 2px #000; }
  .zoom { margin-left: 1em; }
</style></head><body>
<div class="info">
  <b>${info.key}</b> — ${info.path} — ${info.px}×${info.py} px, ${info.frames} frame(s)
  <span class="zoom">zoom: <input id="z" type="range" min="1" max="8" value="2"/></span>
</div>
<div class="wrap" id="wrap">
  <img id="img" src="${imgSrc}" />
</div>
<script>
const vscode = acquireVsCodeApi();
const img = document.getElementById('img');
const wrap = document.getElementById('wrap');
const z = document.getElementById('z');
const PX = ${info.px} * ${scale}, PY = ${info.py} * ${scale};
let sel = { x: ${startX}, y: ${startY} };

function layout() {
  const zoom = Number(z.value);
  img.style.width  = (img.naturalWidth  * zoom) + 'px';
  img.style.height = (img.naturalHeight * zoom) + 'px';
  for (const c of wrap.querySelectorAll('.cell')) c.remove();
  const cols = Math.floor(img.naturalWidth / PX);
  const rows = Math.floor(img.naturalHeight / PY);
  const renderedW = img.offsetWidth;
  const renderedH = img.offsetHeight;
  const cellW = renderedW / cols;
  const cellH = renderedH / rows;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const d = document.createElement('div');
      d.className = 'cell' + (x===sel.x && y===sel.y ? ' sel' : '');
      d.style.left   = (x * cellW) + 'px';
      d.style.top    = (y * cellH) + 'px';
      d.style.width  = cellW + 'px';
      d.style.height = cellH + 'px';
      const lbl = document.createElement('span');
      lbl.className = 'lbl'; lbl.textContent = x + ',' + y;
      d.appendChild(lbl);
      d.onclick = () => {
        sel = { x, y };
        vscode.postMessage({ type: 'pick', x, y });
        layout();
      };
      wrap.appendChild(d);
    }
  }
}
img.onload = layout;
z.oninput = layout;
if (img.complete) layout();
new ResizeObserver(layout).observe(img);
</script></body></html>`;
}

export function registerAtlasPreview(
  context: vscode.ExtensionContext
): void {
  const provider = new AtlasCodeLensProvider();
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider({ language: 'lua' }, provider),
    vscode.commands.registerCommand('smods.previewAtlas',
      (args: PreviewArgs) => openPreview(context, args)),
    vscode.workspace.onDidSaveTextDocument(d => {
      if (d.languageId === 'lua') {
        atlasCache.clear();
        provider.refresh();
      }
    })
  );
}
