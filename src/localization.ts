import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { findMatchingBrace, getModRootForDocument, readModPrefix } from './modUtils';

const OBJECT_KINDS = new Set([
  'Joker', 'Consumable', 'Voucher', 'Back', 'Blind', 'Tag',
  'Edition', 'Enhancement', 'Seal', 'Sticker', 'Booster'
]);

interface ObjectRef {
  kind: string;
  key: string;
  hasLocTxt: boolean;
  keyRange: vscode.Range;
  blockRange: vscode.Range;
}

function findObjects(doc: vscode.TextDocument): ObjectRef[] {
  const text = doc.getText();
  const out: ObjectRef[] = [];
  const re = /SMODS\.(\w+)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const kind = m[1];
    if (!OBJECT_KINDS.has(kind)) {continue;}
    const open = text.indexOf('{', m.index);
    const close = findMatchingBrace(text, open);
    if (close === -1) {continue;}
    const body = text.slice(open, close + 1);
    const keyM = /\bkey\s*=\s*['"]([^'"]+)['"]/.exec(body);
    if (!keyM) {continue;}
    const keyAbs = open + keyM.index;
    out.push({
      kind, key: keyM[1],
      hasLocTxt: /\bloc_txt\s*=\s*\{/.test(body),
      keyRange: new vscode.Range(
        doc.positionAt(keyAbs),
        doc.positionAt(keyAbs + keyM[0].length)
      ),
      blockRange: new vscode.Range(
        doc.positionAt(m.index),
        doc.positionAt(close + 1)
      )
    });
  }
  return out;
}

interface LocHit { file: string; line: number; }

interface LocIndex {
  at: number;
  /** key → first hit across localization/*.lua */
  entries: Map<string, LocHit>;
}

const LOC_TTL_MS = 15_000;
const locIndexCache = new Map<string, LocIndex>();

function loadLocIndex(modRoot: string): LocIndex {
  const hit = locIndexCache.get(modRoot);
  if (hit && Date.now() - hit.at < LOC_TTL_MS) {return hit;}
  const entries = new Map<string, LocHit>();
  const locDir = path.join(modRoot, 'localization');
  try {
    for (const f of fs.readdirSync(locDir)) {
      if (!f.endsWith('.lua')) {continue;}
      const full = path.join(locDir, f);
      const lines = fs.readFileSync(full, 'utf8').split(/\r?\n/);
      const re = /["']?([\w.]+)\b["']?\s*=\s*\{/;
      for (let i = 0; i < lines.length; i++) {
        const m = re.exec(lines[i]);
        if (m && !entries.has(m[1])) {entries.set(m[1], { file: full, line: i });}
      }
    }
  } catch { /* no localization dir */ }
  const idx = { at: Date.now(), entries };
  locIndexCache.set(modRoot, idx);
  return idx;
}

function searchLocFiles(modRoot: string, key: string): LocHit | undefined {
  return loadLocIndex(modRoot).entries.get(key);
}

function categoryForKind(kind: string): string {
  switch (kind) {
    case 'Joker':       return 'Joker';
    case 'Consumable':  return 'Consumable';
    case 'Voucher':     return 'Voucher';
    case 'Back':        return 'Back';
    case 'Blind':       return 'Blind';
    case 'Tag':         return 'Tag';
    case 'Edition':     return 'Edition';
    case 'Enhancement': return 'Enhanced';
    case 'Seal':        return 'Other';
    case 'Sticker':     return 'Sticker';
    case 'Booster':     return 'Other';
    default:            return 'Other';
  }
}

async function createLocStub(
  modRoot: string, kind: string, key: string
): Promise<LocHit | undefined> {
  const locDir = path.join(modRoot, 'localization');
  const file = path.join(locDir, 'en-us.lua');
  if (!fs.existsSync(file)) {
    const doCreate = await vscode.window.showWarningMessage(
      `No localization/en-us.lua in ${path.basename(modRoot)}. Create it?`,
      { modal: true }, 'Create'
    );
    if (doCreate !== 'Create') {return undefined;}
    fs.mkdirSync(locDir, { recursive: true });
    fs.writeFileSync(file, `return {
    descriptions = {
        Joker = {},
        Consumable = {},
        Voucher = {},
        Back = {},
        Blind = {},
        Tag = {},
        Edition = {},
        Enhanced = {},
        Other = {},
        Sticker = {}
    }
}
`);
  }

  const cat = categoryForKind(kind);
  const txt = fs.readFileSync(file, 'utf8');
  const lines = txt.split(/\r?\n/);

  // Find "Cat = {" line; insert entry right after it (keeping existing entries).
  const catLine = lines.findIndex(l =>
    new RegExp(`\\b${cat}\\s*=\\s*\\{`).test(l)
  );
  if (catLine === -1) {
    vscode.window.showErrorMessage(
      `Category "${cat}" not in en-us.lua. Add it manually.`
    );
    return undefined;
  }
  const indent = (lines[catLine].match(/^\s*/) ?? [''])[0] + '    ';
  const stub = [
    `${indent}${key} = {`,
    `${indent}    name = '${key}',`,
    `${indent}    text = { 'TODO: describe ${key}' }`,
    `${indent}},`
  ];
  lines.splice(catLine + 1, 0, ...stub);
  fs.writeFileSync(file, lines.join('\n'));
  return { file, line: catLine + 1 };
}

class LocCodeLensProvider implements vscode.CodeLensProvider {
  private _onDid = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDid.event;
  refresh(): void { this._onDid.fire(); }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    if (doc.languageId !== 'lua') {return [];}
    const modRoot = getModRootForDocument(doc.uri);
    if (!modRoot) {return [];}
    const prefix = readModPrefix(modRoot);
    const out: vscode.CodeLens[] = [];
    for (const obj of findObjects(doc)) {
      const fullKey = `${prefix}_${obj.key}`;
      const hit = obj.hasLocTxt ? undefined : searchLocFiles(modRoot, fullKey)
                                         ?? searchLocFiles(modRoot, obj.key);
      const title = obj.hasLocTxt
        ? `$(symbol-string) Inline loc_txt`
        : hit
          ? `$(go-to-file) Open loc entry for "${obj.key}"`
          : `$(add) Create loc entry for "${obj.key}"`;
      out.push(new vscode.CodeLens(obj.keyRange, {
        title,
        command: obj.hasLocTxt ? '' : 'smods.openLoc',
        arguments: obj.hasLocTxt ? [] : [{
          modRoot, kind: obj.kind, key: obj.key, hit
        }]
      }));
    }
    return out;
  }
}

async function openOrCreateLoc(args: {
  modRoot: string; kind: string; key: string; hit?: LocHit;
}): Promise<void> {
  const hit = args.hit ?? await createLocStub(args.modRoot, args.kind, args.key);
  if (!hit) {return;}
  const doc = await vscode.workspace.openTextDocument(hit.file);
  const editor = await vscode.window.showTextDocument(doc);
  const pos = new vscode.Position(hit.line, 0);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(new vscode.Range(pos, pos));
}

async function diagnoseDoc(
  doc: vscode.TextDocument, collection: vscode.DiagnosticCollection
): Promise<void> {
  if (doc.languageId !== 'lua') {return;}
  const modRoot = getModRootForDocument(doc.uri);
  if (!modRoot) {collection.delete(doc.uri); return;}
  const prefix = readModPrefix(modRoot);
  const diags: vscode.Diagnostic[] = [];
  for (const obj of findObjects(doc)) {
    if (obj.hasLocTxt) {continue;}
    const fullKey = `${prefix}_${obj.key}`;
    if (searchLocFiles(modRoot, fullKey) || searchLocFiles(modRoot, obj.key)) {continue;}
    const d = new vscode.Diagnostic(
      obj.keyRange,
      `No loc_txt inline and no localization entry for "${obj.key}" (expected "${fullKey}").`,
      vscode.DiagnosticSeverity.Warning
    );
    d.source = 'smods';
    d.code = 'missing-loc';
    diags.push(d);
  }
  collection.set(doc.uri, diags);
}

export function registerLocalization(
  context: vscode.ExtensionContext
): void {
  const provider = new LocCodeLensProvider();
  const collection = vscode.languages.createDiagnosticCollection('smods-loc');
  context.subscriptions.push(
    collection,
    vscode.languages.registerCodeLensProvider({ language: 'lua' }, provider),
    vscode.commands.registerCommand('smods.openLoc', openOrCreateLoc),
    vscode.workspace.onDidOpenTextDocument(d => diagnoseDoc(d, collection)),
    vscode.workspace.onDidSaveTextDocument(d => {
      locIndexCache.clear();
      diagnoseDoc(d, collection);
      provider.refresh();
    }),
    vscode.workspace.onDidCloseTextDocument(d => collection.delete(d.uri))
  );
  for (const d of vscode.workspace.textDocuments) {void diagnoseDoc(d, collection);}
}
