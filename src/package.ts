import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { findModRoots } from './paths';
import { findManifestFile } from './modUtils';

const DEFAULT_EXCLUDES = [
  '.git', '.gitignore', '.vscode', '.idea', 'node_modules',
  '.DS_Store', 'Thumbs.db', '*.psd', '*.aseprite', '*.xcf',
  '*.log', '*.tmp', '*.bak'
];

function matchesExclude(name: string, patterns: string[]): boolean {
  for (const p of patterns) {
    if (p.includes('*')) {
      const re = new RegExp(
        '^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'
      );
      if (re.test(name)) {return true;}
    } else if (name === p) {return true;}
  }
  return false;
}

interface Entry { rel: string; abs: string; }

async function walk(root: string, excludes: string[]): Promise<Entry[]> {
  const out: Entry[] = [];
  async function visit(dir: string, rel: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (matchesExclude(e.name, excludes)) {continue;}
      const abs = path.join(dir, e.name);
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {await visit(abs, childRel);}
      else if (e.isFile()) {out.push({ rel: childRel, abs });}
    }
  }
  await visit(root, '');
  return out;
}

function dosTime(d: Date): { time: number; date: number } {
  const time = ((d.getHours() & 0x1f) << 11)
    | ((d.getMinutes() & 0x3f) << 5)
    | ((d.getSeconds() >> 1) & 0x1f);
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9)
    | (((d.getMonth() + 1) & 0x0f) << 5)
    | (d.getDate() & 0x1f);
  return { time, date };
}

function crc32(buf: Buffer): number {
  // Node's zlib.crc32 is available from Node 22+; fall back to manual.
  const z = zlib as unknown as { crc32?: (b: Buffer) => number };
  if (typeof z.crc32 === 'function') {return z.crc32(buf) >>> 0;}
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

async function createZip(
  entries: Entry[], destPath: string
): Promise<number> {
  const out = fsSync.createWriteStream(destPath);
  const chunks: Buffer[] = [];
  let offset = 0;
  const central: Buffer[] = [];

  const writeBuf = (b: Buffer) => {
    chunks.push(b);
    offset += b.length;
  };

  const prepared = await Promise.all(entries.map(async e => {
    const [data, stat] = await Promise.all([
      fs.readFile(e.abs),
      fs.stat(e.abs)
    ]);
    return {
      rel: e.rel, data, stat,
      compressed: zlib.deflateRawSync(data),
      crc: crc32(data)
    };
  }));

  for (const e of prepared) {
    const { data, stat, compressed, crc } = e;
    const { time, date } = dosTime(stat.mtime);
    const nameBuf = Buffer.from(e.rel, 'utf8');

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);           // version needed
    lh.writeUInt16LE(0x0800, 6);       // flag: UTF-8
    lh.writeUInt16LE(8, 8);            // method: deflate
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(compressed.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    const localOffset = offset;
    writeBuf(lh);
    writeBuf(nameBuf);
    writeBuf(compressed);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(0x031e, 4);       // made by: unix + v3.0
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(compressed.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(localOffset, 42);
    central.push(cd, nameBuf);
  }

  const centralBuf = Buffer.concat(central);
  const centralStart = offset;
  writeBuf(centralBuf);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(centralStart, 16);
  eocd.writeUInt16LE(0, 20);
  writeBuf(eocd);

  for (const c of chunks) {out.write(c);}
  await new Promise<void>((resolve, reject) => {
    out.end(() => resolve());
    out.on('error', reject);
  });
  return offset;
}

async function readManifest(modRoot: string):
    Promise<{ id: string; version: string } | undefined> {
  const m = await findManifestFile(modRoot);
  if (!m) {return undefined;}
  const d = m.data as { id?: unknown; version?: unknown };
  if (typeof d.id !== 'string') {return undefined;}
  return {
    id: d.id,
    version: typeof d.version === 'string' ? d.version : '0.0.0'
  };
}

async function pickModRoot(): Promise<string | undefined> {
  const roots = findModRoots();
  if (roots.length === 0) {
    vscode.window.showErrorMessage('No Smods mod detected in workspace.');
    return undefined;
  }
  if (roots.length === 1) {return roots[0];}
  const pick = await vscode.window.showQuickPick(
    roots.map(r => ({ label: path.basename(r), description: r, path: r })),
    { title: 'Select mod to package' }
  );
  return pick?.path;
}

export function registerPackageCommand(
  context: vscode.ExtensionContext,
  output: vscode.LogOutputChannel
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('smods.packageMod', async () => {
      const modRoot = await pickModRoot();
      if (!modRoot) {return;}

      const manifest = await readManifest(modRoot);
      if (!manifest) {
        vscode.window.showErrorMessage(
          `No valid manifest in ${modRoot}.`
        );
        return;
      }

      const defaultName = `${manifest.id}-${manifest.version}.zip`;
      const save = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(
          path.join(path.dirname(modRoot), defaultName)
        ),
        filters: { 'Zip archive': ['zip'] },
        saveLabel: 'Package Mod'
      });
      if (!save) {return;}

      try {
        await vscode.window.withProgress({
          location: vscode.ProgressLocation.Notification,
          title: `Packaging ${manifest.id}…`
        }, async () => {
          const entries = await walk(modRoot, DEFAULT_EXCLUDES);
          const size = await createZip(entries, save.fsPath);
          output.info(
            `Packaged ${entries.length} files (${size} bytes) → ${save.fsPath}`
          );
        });
        const action = await vscode.window.showInformationMessage(
          `Packaged to ${save.fsPath}`,
          'Reveal'
        );
        if (action === 'Reveal') {
          await vscode.commands.executeCommand('revealFileInOS', save);
        }
      } catch (err) {
        output.error(`Packaging failed: ${err}`);
        vscode.window.showErrorMessage(`Packaging failed: ${err}`);
      }
    })
  );
}
