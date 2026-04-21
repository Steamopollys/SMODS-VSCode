import * as vscode from 'vscode';
import { registerScaffoldCommands } from './scaffold';
import { registerRuntimeCommands, BalatroRuntime } from './runtime';
import { registerLogTailer } from './logTailer';
import { registerManifestValidator } from './manifestValidator';
import { registerLuaTypesProvider } from './luaTypes';
import { removeModSymlinks } from './symlink';
import { registerAutoReload } from './autoReload';
import { registerVersionBump } from './versionBump';
import { registerPackageCommand } from './package';
import { registerAtlasPreview } from './atlasPreview';
import { registerLocalization } from './localization';
import { registerContextHover } from './contextHover';
import { registerLovelyHover } from './lovelyHover';
import { registerLovelyValidator } from './lovelyValidator';
import { registerEmbeddedLuaHover } from './lovelyEmbeddedLua';
import { registerLogView } from './logView';
import { registerApiSearch } from './apiSearch';

let _output: vscode.LogOutputChannel | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('Smods', { log: true });
  _output = output;
  context.subscriptions.push(output);
  output.info('Smods Tools activated.');

  const runtime = new BalatroRuntime(output);

  registerScaffoldCommands(context, output);
  registerRuntimeCommands(context, runtime, output);
  const tailer = registerLogTailer(context, output);
  registerManifestValidator(context, output);
  await registerLuaTypesProvider(context, output);
  registerAutoReload(context, runtime, output);
  registerVersionBump(context, output);
  registerPackageCommand(context, output);
  registerAtlasPreview(context);
  registerLocalization(context);
  registerContextHover(context, output);
  registerLovelyHover(context);
  registerLovelyValidator(context, output);
  registerEmbeddedLuaHover(context);
  registerLogView(context, tailer);
  registerApiSearch(context, output);

  // Status bar: quick access to launch/stop + reload
  const launchItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );
  const renderLaunchItem = (running: boolean): void => {
    if (running) {
      launchItem.text = '$(debug-stop) Balatro';
      launchItem.tooltip = 'Stop Balatro';
    } else {
      launchItem.text = '$(play) Balatro';
      launchItem.tooltip = 'Launch Balatro with Smods';
    }
  };
  renderLaunchItem(runtime.isRunning());
  launchItem.command = 'smods.toggleBalatro';
  launchItem.show();
  context.subscriptions.push(
    launchItem,
    runtime.onDidChangeState(renderLaunchItem)
  );

  const soloItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    99
  );
  const renderSoloItem = (running: boolean): void => {
    soloItem.text = '$(beaker) Solo';
    soloItem.tooltip = running
      ? 'Balatro is already running'
      : 'Launch Balatro with only this mod (others disabled)';
    soloItem.command = running ? undefined : 'smods.launchSolo';
  };
  renderSoloItem(runtime.isRunning());
  soloItem.show();
  context.subscriptions.push(
    soloItem,
    runtime.onDidChangeState(renderSoloItem)
  );

  const reloadItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    98
  );
  reloadItem.text = '$(refresh) Reload';
  reloadItem.tooltip = 'Reload Balatro mods (Alt+F5)';
  reloadItem.command = 'smods.reloadBalatro';
  reloadItem.show();
  context.subscriptions.push(reloadItem);
}

export function deactivate(): void {
  if (_output) { removeModSymlinks(_output); }
}
