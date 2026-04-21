import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { getModsFolder } from './paths';

const RESERVED_IDS = new Set(['smods', 'lovely', 'balatro']);
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const KNOWN_BUILTINS = new Set(['Steamodded', 'Lovely', 'Balatro']);

interface InstalledMod { id: string; version?: string; dir: string; }

let installedCache: { at: number; mods: InstalledMod[] } | undefined;

function listInstalledMods(): InstalledMod[] {
  if (installedCache && Date.now() - installedCache.at < 15_000) {
    return installedCache.mods;
  }
  const out: InstalledMod[] = [];
  const modsFolder = getModsFolder();
  if (modsFolder && fsSync.existsSync(modsFolder)) {
    try {
      for (const entry of fsSync.readdirSync(modsFolder)) {
        const dir = path.join(modsFolder, entry);
        try {
          if (!fsSync.statSync(dir).isDirectory()) {continue;}
          for (const e of fsSync.readdirSync(dir)) {
            if (!e.endsWith('.json')) {continue;}
            try {
              const j = JSON.parse(fsSync.readFileSync(path.join(dir, e), 'utf8'));
              if (j && typeof j === 'object' && typeof j.id === 'string') {
                out.push({
                  id: j.id,
                  version: typeof j.version === 'string' ? j.version
                           : typeof j.version_number === 'string' ? j.version_number
                           : undefined,
                  dir
                });
                break;
              }
            } catch { /* skip */ }
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }
  installedCache = { at: Date.now(), mods: out };
  return out;
}

function parseDepSpec(spec: string): { id: string; range?: string } {
  const m = /^([^\s(]+)\s*(?:\(([^)]+)\))?/.exec(spec.trim());
  if (!m) {return { id: spec };}
  return { id: m[1], range: m[2] };
}

function versionSatisfies(installed: string | undefined, range?: string): boolean {
  if (!range) {return true;}
  if (!installed) {return false;}
  const m = /^(>=|>|==|=|<=|<)\s*(\d+\.\d+\.\d+)/.exec(range.trim());
  if (!m) {return true;}
  const op = m[1]; const want = m[2].split('.').map(Number);
  const have = installed.replace(/^v/, '').split(/[-+]/)[0].split('.').map(Number);
  while (have.length < 3) {have.push(0);}
  const cmp = (a: number[], b: number[]) => {
    for (let i = 0; i < 3; i++) {
      if (a[i] !== b[i]) {return a[i] - b[i];}
    }
    return 0;
  };
  const c = cmp(have, want);
  switch (op) {
    case '>=': return c >= 0;
    case '>':  return c >  0;
    case '<=': return c <= 0;
    case '<':  return c <  0;
    case '=': case '==': return c === 0;
    default: return true;
  }
}

/**
 * A manifest file is any *.json sitting next to a main.lua (or whatever
 * the manifest's main_file points to). We recognize them opportunistically.
 */
async function looksLikeSmodsManifestDoc(
  doc: vscode.TextDocument
): Promise<boolean> {
  if (doc.languageId !== 'json' && doc.languageId !== 'jsonc') {return false;}
  if (!doc.fileName.endsWith('.json')) {return false;}
  let data: unknown;
  try { data = JSON.parse(doc.getText()); } catch { return false; }
  if (typeof data !== 'object' || data === null) {return false;}
  const d = data as Record<string, unknown>;
  // Cheap heuristic: must have id, main_file or prefix.
  return typeof d.id === 'string'
    && (typeof d.main_file === 'string' || typeof d.prefix === 'string');
}

function parseToJsonTree(text: string): { parsed: unknown; error?: string } {
  try { return { parsed: JSON.parse(text) }; }
  catch (e) { return { parsed: null, error: String(e) }; }
}

/**
 * Locate the character range of a top-level key in a JSON document.
 * Very small hand-rolled locator — good enough for diagnostic squigglies.
 */
function locateKey(
  doc: vscode.TextDocument, key: string
): vscode.Range | undefined {
  const text = doc.getText();
  const re = new RegExp(`"${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*:`, 'm');
  const m = re.exec(text);
  if (!m) {return undefined;}
  const start = doc.positionAt(m.index);
  const end = doc.positionAt(m.index + m[0].length);
  return new vscode.Range(start, end);
}

function wholeDocRange(doc: vscode.TextDocument): vscode.Range {
  return new vscode.Range(
    new vscode.Position(0, 0),
    doc.lineAt(doc.lineCount - 1).range.end
  );
}

async function diagnose(
  doc: vscode.TextDocument
): Promise<vscode.Diagnostic[]> {
  const diags: vscode.Diagnostic[] = [];
  const { parsed, error } = parseToJsonTree(doc.getText());
  if (error) {
    diags.push(new vscode.Diagnostic(
      wholeDocRange(doc),
      `Invalid JSON: ${error}`,
      vscode.DiagnosticSeverity.Error
    ));
    return diags;
  }
  if (typeof parsed !== 'object' || parsed === null) {return diags;}
  const m = parsed as Record<string, unknown>;

  const push = (key: string, message: string,
                severity: vscode.DiagnosticSeverity) => {
    const range = locateKey(doc, key) ?? new vscode.Range(0, 0, 0, 1);
    diags.push(new vscode.Diagnostic(range, message, severity));
  };

  // Required fields
  for (const req of ['id', 'name', 'author', 'description', 'prefix', 'main_file']) {
    if (!(req in m)) {
      diags.push(new vscode.Diagnostic(
        new vscode.Range(0, 0, 0, 1),
        `Missing required field: "${req}"`,
        vscode.DiagnosticSeverity.Error
      ));
    }
  }

  // id rules
  if (typeof m.id === 'string') {
    if (/\s/.test(m.id)) {
      push('id', 'Mod id must not contain spaces.',
        vscode.DiagnosticSeverity.Error);
    }
    if (RESERVED_IDS.has(m.id.toLowerCase())) {
      push('id', `"${m.id}" is a reserved id.`,
        vscode.DiagnosticSeverity.Error);
    }
  }

  // prefix rules
  if (typeof m.prefix === 'string' && /\s/.test(m.prefix)) {
    push('prefix', 'Prefix must not contain spaces.',
      vscode.DiagnosticSeverity.Error);
  }

  // author must be array of strings
  if ('author' in m && !Array.isArray(m.author)) {
    push('author', '"author" must be an array of strings.',
      vscode.DiagnosticSeverity.Error);
  } else if (Array.isArray(m.author)) {
    if (m.author.some(a => typeof a !== 'string')) {
      push('author', 'All entries in "author" must be strings.',
        vscode.DiagnosticSeverity.Error);
    }
    if (m.author.length === 0) {
      push('author', '"author" should list at least one name.',
        vscode.DiagnosticSeverity.Warning);
    }
  }

  // main_file must exist on disk
  if (typeof m.main_file === 'string') {
    const modDir = path.dirname(doc.uri.fsPath);
    const target = path.join(modDir, m.main_file);
    try { await fs.access(target); }
    catch {
      push('main_file',
        `main_file "${m.main_file}" does not exist in ${modDir}.`,
        vscode.DiagnosticSeverity.Error);
    }
  }

  // version should look like semver
  if (typeof m.version === 'string' && !SEMVER_RE.test(m.version)) {
    push('version',
      'Version should follow semantic versioning (e.g. "1.2.3").',
      vscode.DiagnosticSeverity.Warning);
  }

  // badge colours: 6-digit hex, no leading '#'
  for (const key of ['badge_colour', 'badge_text_colour']) {
    const val = m[key];
    if (typeof val === 'string' && !/^[0-9A-Fa-f]{6}$/.test(val)) {
      push(key, `${key} should be a 6-digit hex string without '#'.`,
        vscode.DiagnosticSeverity.Warning);
    }
  }

  // dependencies / conflicts must be string arrays
  for (const key of ['dependencies', 'conflicts', 'provides']) {
    const val = m[key];
    if (val !== undefined) {
      if (!Array.isArray(val) || val.some(x => typeof x !== 'string')) {
        push(key, `"${key}" must be an array of strings.`,
          vscode.DiagnosticSeverity.Error);
      }
    }
  }

  // Resolve each dependency against installed mods.
  if (Array.isArray(m.dependencies)) {
    const installed = listInstalledMods();
    const byId = new Map(installed.map(x => [x.id.toLowerCase(), x]));
    for (const raw of m.dependencies) {
      if (typeof raw !== 'string') {continue;}
      const { id, range } = parseDepSpec(raw);
      if (KNOWN_BUILTINS.has(id)) {continue;}
      const found = byId.get(id.toLowerCase());
      if (!found) {
        push('dependencies',
          `Dependency "${id}" is not installed in the Mods folder.`,
          vscode.DiagnosticSeverity.Warning);
      } else if (!versionSatisfies(found.version, range)) {
        push('dependencies',
          `Installed "${id}" is ${found.version ?? 'unknown'}, does not satisfy ${range}.`,
          vscode.DiagnosticSeverity.Warning);
      }
    }
  }

  // priority must be a number
  if ('priority' in m && typeof m.priority !== 'number') {
    push('priority', '"priority" must be a number (lower loads first).',
      vscode.DiagnosticSeverity.Error);
  }

  return diags;
}

export function registerManifestValidator(
  context: vscode.ExtensionContext,
  output: vscode.LogOutputChannel
): void {
  const collection = vscode.languages.createDiagnosticCollection('smods');
  context.subscriptions.push(collection);

  async function refresh(doc: vscode.TextDocument): Promise<void> {
    if (!(await looksLikeSmodsManifestDoc(doc))) {
      collection.delete(doc.uri);
      return;
    }
    try {
      const diags = await diagnose(doc);
      collection.set(doc.uri, diags);
    } catch (err) {
      output.error(`Manifest validation failed: ${err}`);
    }
  }

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(refresh),
    vscode.workspace.onDidChangeTextDocument(e => refresh(e.document)),
    vscode.workspace.onDidCloseTextDocument(doc => collection.delete(doc.uri)),
    vscode.commands.registerCommand('smods.validateManifest', async () => {
      const doc = vscode.window.activeTextEditor?.document;
      if (!doc) {return;}
      await refresh(doc);
      vscode.window.showInformationMessage('Manifest validated.');
    })
  );

  // Initial pass on already-open editors.
  for (const doc of vscode.workspace.textDocuments) {void refresh(doc);}
}
