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
import { registerAtlasPacker } from './atlasPacker';
import { registerShaderPreview } from './shaderPreview';
import { registerSoundPreview } from './soundPreview';
import { registerLocalization } from './localization';
import { registerContextHover } from './contextHover';
import { registerLovelyHover } from './lovelyHover';
import { registerLovelyValidator } from './lovelyValidator';
import { registerEmbeddedLuaHover } from './lovelyEmbeddedLua';
import { registerLogView } from './logView';
import { registerApiSearch } from './apiSearch';
import { DebugAgent } from './debugAgent';
import { registerDebugView } from './debugView';
import { getModsFolder } from './paths';

let _output: vscode.LogOutputChannel | undefined;
let _debugAgent: DebugAgent | undefined;

const DEBUG_MODE_KEY = 'smods.debugMode';

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
  registerAtlasPacker(context, output);
  registerLocalization(context);
  registerContextHover(context, output);
  registerLovelyHover(context);
  registerLovelyValidator(context, output);
  registerEmbeddedLuaHover(context);
  registerLogView(context, tailer);
  registerApiSearch(context, output);

  // Stop tailing when the game exits so leftover watchers don't fire on the
  // next launch's freshly-truncated log file.
  context.subscriptions.push(
    runtime.onDidChangeState(running => { if (!running) { void tailer.stop(); } })
  );

  const debugAgent = new DebugAgent(context, output);
  _debugAgent = debugAgent;
  runtime.setDebugAgent(debugAgent);
  runtime.setDebugMode(context.workspaceState.get<boolean>(DEBUG_MODE_KEY, false));
  registerDebugView(context, debugAgent);
  registerDebugCommands(context, runtime, debugAgent);
  registerShaderPreview(context, debugAgent, output);
  registerSoundPreview(context);

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

  const debugItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    98
  );
  const renderDebugItem = (): void => {
    const armed = runtime.isDebugMode();
    const connected = debugAgent.isConnected;
    if (armed) {
      debugItem.text = connected ? '$(bug) Debug·live' : '$(bug) Debug';
      debugItem.tooltip = connected
        ? 'Debug bridge connected. Click to disarm (applies next launch).'
        : 'Debug mode armed. Bridge will load on next launch. Click to disarm.';
      debugItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
      debugItem.text = '$(debug-alt) Debug';
      debugItem.tooltip = 'Debug mode off. Click to arm for next launch (requires DebugPlus).';
      debugItem.backgroundColor = undefined;
    }
  };
  renderDebugItem();
  debugItem.command = 'smods.toggleDebugMode';
  debugItem.show();
  context.subscriptions.push(
    debugItem,
    runtime.onDidChangeDebugMode(renderDebugItem),
    debugAgent.onDidConnect(renderDebugItem),
    debugAgent.onDidDisconnect(renderDebugItem)
  );

  const reloadItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    97
  );
  reloadItem.text = '$(refresh) Reload';
  reloadItem.tooltip = 'Reload Balatro mods (Alt+F5)';
  reloadItem.command = 'smods.reloadBalatro';
  reloadItem.show();
  context.subscriptions.push(reloadItem);
}

function registerDebugCommands(
  context: vscode.ExtensionContext,
  runtime: BalatroRuntime,
  agent: DebugAgent
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('smods.toggleDebugMode', async () => {
      const turningOn = !runtime.isDebugMode();
      if (turningOn) {
        const modsFolder = getModsFolder();
        if (!modsFolder) {
          vscode.window.showErrorMessage(
            'Mods folder not found. Configure "smods.modsFolder" in settings.'
          );
          return;
        }
        if (!agent.detectDebugPlus(modsFolder)) {
          await agent.promptInstallDebugPlus();
          return;
        }
      }
      runtime.setDebugMode(turningOn);
      await context.workspaceState.update(DEBUG_MODE_KEY, turningOn);
      if (runtime.isRunning()) {
        vscode.window.showInformationMessage(
          `Debug mode ${turningOn ? 'armed' : 'disarmed'}. Applies on next launch.`
        );
      }
    }),
    vscode.commands.registerCommand('smods.debugPause',
      async () => { try { await agent.pause(); } catch (err) { vscode.window.showWarningMessage(String(err)); } }),
    vscode.commands.registerCommand('smods.debugResume',
      async () => { try { await agent.resume(); } catch (err) { vscode.window.showWarningMessage(String(err)); } }),
    vscode.commands.registerCommand('smods.debugEval', async () => {
      const code = await vscode.window.showInputBox({
        prompt: 'Lua to evaluate in the running Balatro process',
        placeHolder: 'e.g. return G.GAME.dollars',
      });
      if (!code) { return; }
      try {
        const res = await agent.evaluate(code);
        await vscode.window.showInformationMessage(`= ${res.pretty || '(no value)'}`);
      } catch (err) { vscode.window.showErrorMessage(String(err)); }
    }),
    vscode.commands.registerCommand('smods.showDebugPanel',
      () => vscode.commands.executeCommand('smodsDebugView.focus'))
  );
}

export function deactivate(): void {
  if (_output) { removeModSymlinks(_output); }
  _debugAgent?.disconnect();
  const modsFolder = getModsFolder();
  if (modsFolder) { _debugAgent?.uninstallBridge(modsFolder); }
}
