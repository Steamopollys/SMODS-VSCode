import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getModsFolder } from './paths';

interface ApiSymbol {
  name: string;
  kind: 'class' | 'function' | 'field';
  parent?: string;
  file: string;
  line: number;
  detail?: string;
}

function findLspDef(): string | undefined {
  const modsFolder = getModsFolder();
  if (!modsFolder || !fs.existsSync(modsFolder)) {return undefined;}
  try {
    const entry = fs.readdirSync(modsFolder).find(n =>
      n.toLowerCase().startsWith('smods-') &&
      fs.existsSync(path.join(modsFolder, n, 'lsp_def'))
    );
    return entry ? path.join(modsFolder, entry, 'lsp_def') : undefined;
  } catch { return undefined; }
}

function scanFile(file: string, out: ApiSymbol[]): void {
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch { return; }
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];

    const classM = /^---@class\s+([\w.]+)(?:\s*:\s*([\w.]+))?/.exec(l);
    if (classM) {
      out.push({
        name: classM[1], kind: 'class',
        parent: classM[2], file, line: i,
        detail: classM[2] ? `extends ${classM[2]}` : ''
      });
      continue;
    }

    const fnM = /^function\s+([\w.:]+)\s*\(([^)]*)\)/.exec(l);
    if (fnM) {
      out.push({
        name: fnM[1], kind: 'function',
        file, line: i, detail: `(${fnM[2]})`
      });
      continue;
    }

    const assignFnM = /^([\w.:]+)\s*=\s*function\s*\(([^)]*)\)/.exec(l);
    if (assignFnM && assignFnM[1].includes('SMODS')) {
      out.push({
        name: assignFnM[1], kind: 'function',
        file, line: i, detail: `(${assignFnM[2]})`
      });
    }
  }
}

function collectSymbols(): ApiSymbol[] {
  const lsp = findLspDef();
  if (!lsp) {return [];}
  const out: ApiSymbol[] = [];
  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {walk(full);}
      else if (e.isFile() && e.name.endsWith('.lua')) {scanFile(full, out);}
    }
  }
  walk(lsp);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

let cached: { at: number; syms: ApiSymbol[] } | undefined;
function getSymbols(): ApiSymbol[] {
  if (cached && Date.now() - cached.at < 60_000) {return cached.syms;}
  const syms = collectSymbols();
  cached = { at: Date.now(), syms };
  return syms;
}

export function registerApiSearch(
  context: vscode.ExtensionContext,
  output: vscode.LogOutputChannel
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('smods.openApiReference', async () => {
      const syms = getSymbols();
      if (syms.length === 0) {
        vscode.window.showErrorMessage(
          'No SMODS symbols found. Install Steamodded in your Mods folder.'
        );
        return;
      }
      output.info(`SMODS API: ${syms.length} symbols indexed.`);
      const items = syms.map(s => ({
        label: `$(symbol-${s.kind}) ${s.name}`,
        description: s.detail ?? '',
        detail: `${path.basename(s.file)}:${s.line + 1}`,
        sym: s
      }));
      const pick = await vscode.window.showQuickPick(items, {
        title: 'SMODS API reference',
        matchOnDescription: true,
        matchOnDetail: true,
        placeHolder: 'Search SMODS classes, functions, fields…'
      });
      if (!pick) {return;}
      const doc = await vscode.workspace.openTextDocument(pick.sym.file);
      const editor = await vscode.window.showTextDocument(doc);
      const pos = new vscode.Position(pick.sym.line, 0);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos),
        vscode.TextEditorRevealType.InCenter);
    })
  );
}
