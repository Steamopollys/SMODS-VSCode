import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { findModRoots } from './paths';

export function findMatchingBrace(text: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < text.length; i++) {
    const c = text[i];
    if (c === '{') {depth++;}
    else if (c === '}') {depth--; if (depth === 0) {return i;}}
    else if (c === '-' && text[i + 1] === '-') {
      if (text[i + 2] === '[' && text[i + 3] === '[') {
        const end = text.indexOf(']]', i + 4);
        i = end === -1 ? text.length : end + 1;
      } else {
        const nl = text.indexOf('\n', i);
        i = nl === -1 ? text.length : nl;
      }
    } else if (c === "'" || c === '"') {
      const end = text.indexOf(c, i + 1);
      i = end === -1 ? text.length : end;
    }
  }
  return -1;
}

export function getModRootForDocument(uri: vscode.Uri): string | undefined {
  const p = uri.fsPath;
  for (const r of findModRoots()) {
    if (p === r || p.startsWith(r + path.sep)) {return r;}
  }
  return undefined;
}

export interface ManifestRef {
  path: string;
  data: Record<string, unknown>;
}

export async function findManifestFile(modRoot: string): Promise<ManifestRef | undefined> {
  let entries: string[];
  try { entries = await fs.readdir(modRoot); } catch { return undefined; }
  for (const e of entries) {
    if (!e.endsWith('.json')) {continue;}
    const full = path.join(modRoot, e);
    try {
      const data = JSON.parse(await fs.readFile(full, 'utf8'));
      if (data && typeof data === 'object' && typeof data.id === 'string' &&
          (typeof data.main_file === 'string' || typeof data.prefix === 'string')) {
        return { path: full, data };
      }
    } catch { /* not a manifest */ }
  }
  return undefined;
}

export function readModPrefix(modRoot: string): string {
  try {
    for (const e of fsSync.readdirSync(modRoot)) {
      if (!e.endsWith('.json')) {continue;}
      const j = JSON.parse(fsSync.readFileSync(path.join(modRoot, e), 'utf8'));
      if (j && typeof j === 'object' && typeof j.prefix === 'string') {
        return j.prefix;
      }
    }
  } catch { /* fall through */ }
  return 'mod';
}
