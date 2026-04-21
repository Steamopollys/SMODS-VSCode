import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';

/**
 * Locate the Balatro save/mods root directory.
 *  - Windows: %AppData%/Balatro
 *  - macOS:   ~/Library/Application Support/Balatro
 *  - Linux:   ~/.local/share/love/Balatro  (LÖVE default via Proton varies)
 */
export function defaultBalatroDataDir(): string | undefined {
  const platform = process.platform;
  if (platform === 'win32') {
    const appData = process.env.APPDATA;
    return appData ? path.join(appData, 'Balatro') : undefined;
  }
  if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Balatro');
  }
  // Linux / other: Proton/Steam users often have custom locations.
  // We check a couple of likely spots.
  const candidates = [
    path.join(os.homedir(), '.local', 'share', 'love', 'Balatro'),
    path.join(os.homedir(), '.steam', 'steam', 'steamapps', 'compatdata',
      '2379780', 'pfx', 'drive_c', 'users', 'steamuser', 'AppData', 'Roaming', 'Balatro')
  ];
  return candidates.find(c => fs.existsSync(c));
}

export function getModsFolder(): string | undefined {
  const configured = vscode.workspace
    .getConfiguration('smods')
    .get<string>('modsFolder', '')
    .trim();
  if (configured) {return configured;}
  const data = defaultBalatroDataDir();
  return data ? path.join(data, 'Mods') : undefined;
}

export function getLogFile(): string | undefined {
  const configured = vscode.workspace
    .getConfiguration('smods')
    .get<string>('logFile', '')
    .trim();
  if (configured) {return configured;}
  const data = defaultBalatroDataDir();
  // Lovely writes to a log file in the Balatro data dir.
  if (!data) {return undefined;}
  const lovelyLogDir = path.join(data, 'Mods', 'lovely', 'log');
  if (fs.existsSync(lovelyLogDir)) {
    const entries = fs.readdirSync(lovelyLogDir)
      .filter(e => e.endsWith('.log'))
      .map(e => ({ name: e, mtime: fs.statSync(path.join(lovelyLogDir, e)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (entries.length > 0) {return path.join(lovelyLogDir, entries[0].name);}
  }
  const candidates = [
    path.join(data, 'lovely', 'lovely.log'),
    path.join(data, 'lovely.log'),
    path.join(data, 'log.txt')
  ];
  return candidates.find(c => fs.existsSync(c)) ?? candidates[0];
}

/**
 * Best-effort guess of the Balatro executable path.
 * Only checks common Steam install locations; users can override in settings.
 */
export function defaultBalatroExecutable(): string | undefined {
  const configured = vscode.workspace
    .getConfiguration('smods')
    .get<string>('balatroExecutable', '')
    .trim();
  if (configured) {return configured;}

  const platform = process.platform;
  if (platform === 'win32') {
    const drives = ['C:', 'D:', 'E:'];
    for (const d of drives) {
      const p = path.join(d, 'Program Files (x86)', 'Steam',
        'steamapps', 'common', 'Balatro', 'Balatro.exe');
      if (fs.existsSync(p)) {return p;}
    }
  } else if (platform === 'darwin') {
    const p = path.join(os.homedir(), 'Library', 'Application Support', 'Steam',
      'steamapps', 'common', 'Balatro', 'Balatro.app', 'Contents', 'MacOS', 'love');
    if (fs.existsSync(p)) {return p;}
  } else {
    const p = path.join(os.homedir(), '.steam', 'steam', 'steamapps',
      'common', 'Balatro', 'Balatro.exe');
    if (fs.existsSync(p)) {return p;}
  }
  return undefined;
}

/**
 * Detect the currently installed Steamodded version by inspecting the `smods-*`
 * directory in the Mods folder. Returns a string suitable for a dependency
 * constraint (e.g. `1.0.0-BETA-1620a`), or undefined if nothing is installed.
 */
export function getInstalledSmodsVersion(): string | undefined {
  const modsFolder = getModsFolder();
  if (!modsFolder || !fs.existsSync(modsFolder)) { return undefined; }
  try {
    const entry = fs.readdirSync(modsFolder).find(name => {
      const lower = name.toLowerCase();
      return lower.startsWith('smods-') || lower === 'steamodded' || lower === 'smods';
    });
    if (!entry) { return undefined; }
    const dir = path.join(modsFolder, entry);

    const versionFile = path.join(dir, 'version.lua');
    if (fs.existsSync(versionFile)) {
      const txt = fs.readFileSync(versionFile, 'utf8');
      const quoted = txt.match(/["']([^"']+)["']/);
      if (quoted) {
        const cleaned = quoted[1].replace(/-STEAMODDED$/i, '');
        if (/^\d+\.\d+\.\d+/.test(cleaned)) { return cleaned; }
      }
    }

    const manifestPath = path.join(dir, 'manifest.json');
    if (fs.existsSync(manifestPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        if (typeof data?.version_number === 'string') { return data.version_number; }
        if (typeof data?.version === 'string') { return data.version; }
      } catch { /* ignore */ }
    }

    const m = entry.match(/(\d+\.\d+\.\d+(?:[-_][\w.]+)?)/);
    return m ? m[1].replace(/_/g, '-') : undefined;
  } catch { return undefined; }
}

/** True if the given folder looks like a Smods mod (has *.json manifest + main.lua). */
export function looksLikeSmodsMod(folder: string): boolean {
  if (!fs.existsSync(folder)) {return false;}
  try {
    const entries = fs.readdirSync(folder);
    const hasJsonManifest = entries.some(e => {
      if (!e.endsWith('.json')) {return false;}
      try {
        const txt = fs.readFileSync(path.join(folder, e), 'utf8');
        const data = JSON.parse(txt);
        return typeof data === 'object' && data !== null &&
          'id' in data && 'main_file' in data;
      } catch { return false; }
    });
    const hasMain = entries.some(e => e.endsWith('.lua'));
    return hasJsonManifest && hasMain;
  } catch { return false; }
}

/**
 * Walk up/down from a workspace folder to find the nearest mod root.
 * Returns the mod folder path if any workspace folder contains a Smods mod.
 */
export function findModRoots(): string[] {
  const roots: string[] = [];
  const folders = vscode.workspace.workspaceFolders ?? [];
  for (const f of folders) {
    const root = f.uri.fsPath;
    if (looksLikeSmodsMod(root)) {
      roots.push(root);
      continue;
    }
    // Shallow scan of immediate subfolders.
    try {
      for (const child of fs.readdirSync(root)) {
        const p = path.join(root, child);
        if (fs.statSync(p).isDirectory() && looksLikeSmodsMod(p)) {
          roots.push(p);
        }
      }
    } catch { /* ignore */ }
  }
  return roots;
}
