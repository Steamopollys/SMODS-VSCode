import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { findModRoots, getModsFolder } from './paths';

function symlinkEnabled(): boolean {
  return vscode.workspace
    .getConfiguration('smods')
    .get<boolean>('symlinkModOnLaunch', false);
}

function samePath(a: string, b: string): boolean {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

function removeLink(linkPath: string): void {
  try {
    fs.rmSync(linkPath);
  } catch {
    try { fs.rmdirSync(linkPath); } catch { /* already gone */ }
  }
}

export function ensureModSymlinks(output: vscode.LogOutputChannel): void {
  if (!symlinkEnabled()) { return; }

  const modsFolder = getModsFolder();
  if (!modsFolder) {
    output.warn('Cannot symlink mods: Mods folder not found.');
    return;
  }

  if (!fs.existsSync(modsFolder)) {
    try { fs.mkdirSync(modsFolder, { recursive: true }); } catch { /* ignore */ }
  }

  for (const modRoot of findModRoots()) {
    const linkPath = path.join(modsFolder, path.basename(modRoot));

    try {
      const stat = fs.lstatSync(linkPath);
      if (stat.isSymbolicLink()) {
        const existing = fs.readlinkSync(linkPath);
        if (samePath(existing, modRoot)) {
          output.info(`Symlink OK: ${linkPath}`);
          continue;
        }
        removeLink(linkPath);
      } else {
        output.warn(`Skipping symlink for "${path.basename(modRoot)}": real directory already exists at ${linkPath}`);
        continue;
      }
    } catch { /* path doesn't exist yet */ }

    try {
      const type = process.platform === 'win32' ? 'junction' : 'dir';
      fs.symlinkSync(modRoot, linkPath, type);
      output.info(`Symlinked: ${modRoot} → ${linkPath}`);
    } catch (err) {
      output.error(`Failed to symlink "${path.basename(modRoot)}": ${err}`);
      vscode.window.showWarningMessage(
        `Smods: Could not symlink mod "${path.basename(modRoot)}" into Mods folder. ` +
        `On Windows, enable Developer Mode or run VS Code as administrator.`
      );
    }
  }
}

export function removeModSymlinks(output: vscode.LogOutputChannel): void {
  if (!symlinkEnabled()) { return; }

  const modsFolder = getModsFolder();
  if (!modsFolder) { return; }

  for (const modRoot of findModRoots()) {
    const linkPath = path.join(modsFolder, path.basename(modRoot));
    try {
      const stat = fs.lstatSync(linkPath);
      if (stat.isSymbolicLink()) {
        const existing = fs.readlinkSync(linkPath);
        if (samePath(existing, modRoot)) {
          removeLink(linkPath);
          output.info(`Removed symlink: ${linkPath}`);
        }
      }
    } catch { /* already gone */ }
  }
}
