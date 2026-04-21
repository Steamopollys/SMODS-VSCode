import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { findModRoots, getModsFolder } from './paths';

function findSmodsLspDef(): string | undefined {
  const modsFolder = getModsFolder();
  if (!modsFolder || !fs.existsSync(modsFolder)) { return undefined; }
  try {
    const entry = fs.readdirSync(modsFolder).find(name =>
      name.toLowerCase().startsWith('smods-') &&
      fs.existsSync(path.join(modsFolder, name, 'lsp_def'))
    );
    return entry ? path.join(modsFolder, entry, 'lsp_def') : undefined;
  } catch { return undefined; }
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

  const libPath = findSmodsLspDef();
  if (!libPath) {
    output.warn('Steamodded not found in Mods folder (expected smods-* directory with lsp_def/). ' +
      'Set smods.modsFolder in settings if installed elsewhere.');
    return;
  }

  const luaCfg = vscode.workspace.getConfiguration('Lua');
  const current = luaCfg.get<string[]>('workspace.library') ?? [];

  if (current.includes(libPath)) { return; }

  try {
    await luaCfg.update(
      'workspace.library',
      [...current, libPath],
      vscode.ConfigurationTarget.Workspace
    );
    output.info(`Attached SMODS type definitions from: ${libPath}`);
  } catch (err) {
    output.warn(
      `Could not update Lua.workspace.library automatically: ${err}. ` +
      `Add "${libPath}" to your workspace settings manually.`
    );
  }
}
