import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { findModRoots, getModsFolder } from './paths';

function findSmodsLibPaths(): string[] {
  const modsFolder = getModsFolder();
  if (!modsFolder || !fs.existsSync(modsFolder)) { return []; }
  try {
    const entry = fs.readdirSync(modsFolder).find(name =>
      name.toLowerCase().startsWith('smods-') &&
      fs.statSync(path.join(modsFolder, name)).isDirectory()
    );
    if (!entry) { return []; }
    const root = path.join(modsFolder, entry);
    return ['lsp_def', 'src']
      .map(sub => path.join(root, sub))
      .filter(p => fs.existsSync(p));
  } catch { return []; }
}

export async function registerLuaTypesProvider(
  context: vscode.ExtensionContext,
  output: vscode.LogOutputChannel
): Promise<void> {
  const auto = vscode.workspace.getConfiguration('smods')
    .get<boolean>('autoAttachLuaTypes', true);
  if (!auto) { return; }

  if (!vscode.workspace.workspaceFolders?.length) { return; }
  if (findModRoots().length === 0) { return; }

  const smodsCfg = vscode.workspace.getConfiguration('smods');
  const libPaths = findSmodsLibPaths();
  if (libPaths.length === 0) {
    output.warn('Steamodded not found in Mods folder (expected smods-* directory with lsp_def/ or src/). ' +
      'Set smods.modsFolder in settings if installed elsewhere.');
  }

  const extraPaths: { key: string; label: string }[] = [
    { key: 'love2dLibraryPath', label: 'Love2D' },
    { key: 'balatroSourcePath', label: 'Balatro source' },
  ];
  for (const { key, label } of extraPaths) {
    const p = smodsCfg.get<string>(key, '').trim();
    if (!p) { continue; }
    if (!fs.existsSync(p)) {
      output.warn(`${label} path from smods.${key} does not exist: ${p}`);
      continue;
    }
    libPaths.push(p);
  }

  if (libPaths.length === 0) { return; }

  const luaCfg = vscode.workspace.getConfiguration('Lua');
  const current = luaCfg.get<string[]>('workspace.library') ?? [];
  const missing = libPaths.filter(p => !current.includes(p));

  const runtime = luaCfg.get<string>('runtime.version');
  if (runtime !== 'LuaJIT') {
    try {
      await luaCfg.update('runtime.version', 'LuaJIT', vscode.ConfigurationTarget.Workspace);
      output.info('Set Lua.runtime.version = LuaJIT (Balatro uses LuaJIT).');
    } catch (err) {
      output.warn(`Could not set Lua.runtime.version to LuaJIT: ${err}.`);
    }
  }

  if (missing.length === 0) { return; }

  try {
    await luaCfg.update(
      'workspace.library',
      [...current, ...missing],
      vscode.ConfigurationTarget.Workspace
    );
    output.info(`Attached Lua library paths: ${missing.join(', ')}`);
  } catch (err) {
    output.warn(
      `Could not update Lua.workspace.library automatically: ${err}. ` +
      `Add ${missing.map(p => `"${p}"`).join(', ')} to your workspace settings manually.`
    );
  }
}
