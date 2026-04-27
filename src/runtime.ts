import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { getModsFolder, defaultBalatroExecutable } from './paths';
import { ensureModSymlinks, removeModSymlinks } from './symlink';
import type { DebugAgent } from './debugAgent';

const BALATRO_STEAM_ID = '2379780';
const SOLO_MARKER = '# smods-solo';

// ---------------------------------------------------------------------------
// Helpers: temporarily blacklist / restore non-essential mods via lovely
// ---------------------------------------------------------------------------

/** Returns true if the folder name is a core runtime that must never be blacklisted. */
function isCoreModDir(name: string): boolean {
  const lower = name.toLowerCase();
  // `smods-` prefix covers our own ephemeral mods (symlinks, smods-debug-bridge).
  // DebugPlus is whitelisted so debug mode + solo can coexist.
  return lower.startsWith('smods-') || lower === 'steamodded' || lower === 'smods'
    || lower === 'lovely' || lower.startsWith('debugplus');
}

/**
 * Append every real (non-symlink) non-core directory in the Mods folder to
 * `lovely/blacklist.txt` so Steamodded skips them on this launch.
 *
 * Returns the original file content before modification (`null` if the file
 * did not exist), so it can be restored by `restoreBlacklist`.
 */
function blacklistOtherMods(
  modsFolder: string,
  output: vscode.LogOutputChannel
): string | null {
  const blacklistPath = path.join(modsFolder, 'lovely', 'blacklist.txt');

  let original: string | null = null;
  try { original = fs.readFileSync(blacklistPath, 'utf8'); } catch { /* file absent */ }

  let entries: string[];
  try { entries = fs.readdirSync(modsFolder); }
  catch (err) { output.warn(`Solo: cannot read Mods folder: ${err}`); return original; }

  const toBlacklist: string[] = [];
  for (const entry of entries) {
    if (isCoreModDir(entry)) { continue; }
    const src = path.join(modsFolder, entry);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(src); } catch { continue; }
    // Keep symlinks — they point to workspace mods the user wants to test.
    if (stat.isSymbolicLink()) { continue; }
    if (!stat.isDirectory()) { continue; }
    toBlacklist.push(entry);
  }

  if (toBlacklist.length === 0) { return original; }

  const addition = `\n${SOLO_MARKER}\n${toBlacklist.join('\n')}`;
  try {
    fs.mkdirSync(path.dirname(blacklistPath), { recursive: true });
    fs.writeFileSync(blacklistPath, (original ?? '') + addition, 'utf8');
    output.info(`Solo: blacklisted ${toBlacklist.length} mod(s): ${toBlacklist.join(', ')}`);
  } catch (err) {
    output.warn(`Solo: could not write blacklist: ${err}`);
  }
  return original;
}

/**
 * Restore `lovely/blacklist.txt` to the state captured by `blacklistOtherMods`.
 * Deletes the file if it did not exist before (`original === null`).
 */
function restoreBlacklist(
  modsFolder: string,
  original: string | null,
  output: vscode.LogOutputChannel
): void {
  const blacklistPath = path.join(modsFolder, 'lovely', 'blacklist.txt');
  try {
    if (original === null) {
      fs.unlinkSync(blacklistPath);
    } else {
      fs.writeFileSync(blacklistPath, original, 'utf8');
    }
    output.info('Solo: restored blacklist.');
  } catch (err) {
    output.warn(`Solo: could not restore blacklist: ${err}`);
  }
}

export class BalatroRuntime {
  private pollTimer?: NodeJS.Timeout;
  private launching = false;
  private soloMode = false;
  private soloBlacklistOriginal: string | null = null;
  private debugMode = false;
  private debugAgent?: DebugAgent;
  private debugActiveForRun = false;
  private readonly _onDidChangeState = new vscode.EventEmitter<boolean>();
  private readonly _onDidChangeDebugMode = new vscode.EventEmitter<boolean>();
  readonly onDidChangeState = this._onDidChangeState.event;
  readonly onDidChangeDebugMode = this._onDidChangeDebugMode.event;

  constructor(private output: vscode.LogOutputChannel) {}

  isRunning(): boolean {
    return !!this.pollTimer || this.launching;
  }

  setDebugAgent(agent: DebugAgent): void { this.debugAgent = agent; }
  isDebugMode(): boolean { return this.debugMode; }
  setDebugMode(on: boolean): void {
    if (this.debugMode === on) { return; }
    this.debugMode = on;
    this._onDidChangeDebugMode.fire(on);
  }

  async stop(): Promise<void> {
    if (!this.isRunning()) {
      vscode.window.showInformationMessage('Balatro is not running.');
      return;
    }
    this.output.info('Stopping Balatro.');
    try {
      if (process.platform === 'win32') {
        await runCmd('taskkill.exe', ['/IM', 'Balatro.exe', '/F']);
      } else {
        await runCmd('pkill', ['-x', 'Balatro']);
      }
    } catch (err) {
      this.output.error(`Stop failed: ${err}`);
      vscode.window.showErrorMessage(`Failed to stop Balatro: ${err}`);
    }
  }

  async toggle(): Promise<void> {
    if (this.isRunning()) {
      await this.stop();
    } else {
      await this.launch();
    }
  }

  async launch(): Promise<void> {
    if (this.isRunning()) {
      vscode.window.showInformationMessage('Balatro is already running.');
      return;
    }
    await this._launch(false);
  }

  async launchSolo(): Promise<void> {
    if (this.isRunning()) {
      vscode.window.showInformationMessage('Balatro is already running.');
      return;
    }
    await this._launch(true);
  }

  private async _launch(solo: boolean): Promise<void> {
    const modsFolder = getModsFolder();
    const debugArmed = this.debugMode;
    const cfg = vscode.workspace.getConfiguration('smods');
    const direct = cfg.get<boolean>('launchWithoutSteam', false);
    const userArgs = cfg.get<string[]>('launchArgs', []) ?? [];
    // Direct launch needs `--disable-console` and a bare `-` for Lovely to
    // hook correctly.
    // Why `--disable-console`? Without it, the classic Lovely console window won't display anything
    // So we fallback to the Love2d console with this arg.
    // Why `-`? No idea why we need it, it's black magic.
    const rawArgs = direct
      ? ['--disable-console', '-', ...userArgs]
      : userArgs;
    const launchArgs = Array.from(new Set(
      rawArgs.map(a => String(a)).filter(a => a.length > 0)
    ));
    this.output.info(
      `Launching Balatro ${direct ? 'directly (no Steam)' : `via Steam (appid ${BALATRO_STEAM_ID})`}`
      + `${solo ? ' [solo]' : ''}${debugArmed ? ' [debug]' : ''}`
      + `${launchArgs.length ? ` [args: ${launchArgs.join(' ')}]` : ''}`
    );
    if (modsFolder) { this.output.info(`Mods folder: ${modsFolder}`); }

    if (solo && modsFolder) {
      this.soloBlacklistOriginal = blacklistOtherMods(modsFolder, this.output);
    }

    ensureModSymlinks(this.output);

    this.debugActiveForRun = false;
    if (debugArmed && this.debugAgent && modsFolder) {
      if (!this.debugAgent.detectDebugPlus(modsFolder)) {
        vscode.window.showWarningMessage(
          'Debug mode is armed but DebugPlus is not installed. Launching without debug bridge.'
        );
      } else {
        try {
          await this.debugAgent.installBridge(modsFolder);
          this.debugActiveForRun = true;
        } catch (err) {
          this.output.warn(`Debug: bridge install failed, continuing without debug: ${err}`);
        }
      }
    }

    this.launching = true;
    try {
      if (direct) {
        const exe = defaultBalatroExecutable();
        if (!exe || !fs.existsSync(exe)) {
          throw new Error(
            'Balatro executable not found. Set "smods.balatroExecutable" in settings.'
          );
        }
        const child = cp.spawn(exe, launchArgs, {
          cwd: path.dirname(exe),
          detached: true,
          stdio: 'ignore',
          windowsHide: false
        });
        child.unref();
      } else {
        const suffix = launchArgs.length
          ? `//${encodeURIComponent(launchArgs.join(' '))}`
          : '';
        await vscode.env.openExternal(
          vscode.Uri.parse(`steam://rungameid/${BALATRO_STEAM_ID}${suffix}`)
        );
      }
      this.soloMode = solo;
      // Open the log immediately so users see lovely output during loading,
      // even if process detection takes a while.
      await vscode.commands.executeCommand('smods.showLog');
      await vscode.commands.executeCommand('smodsLogView.focus');
      const detected = await this.startPolling();
      if (!detected) {
        if (solo && modsFolder) { restoreBlacklist(modsFolder, this.soloBlacklistOriginal, this.output); }
        if (this.debugActiveForRun && modsFolder) {
          this.debugAgent?.uninstallBridge(modsFolder);
          this.debugActiveForRun = false;
        }
        return;
      }
      const extra = this.debugActiveForRun ? ' [debug]' : '';
      vscode.window.showInformationMessage(
        solo
          ? `Launched Balatro (solo — other mods disabled)${extra}.`
          : `Launched Balatro${extra}.`
      );
      if (this.debugActiveForRun && this.debugAgent) {
        void this.debugAgent.connect().then(async ok => {
          if (ok && vscode.workspace.getConfiguration('smods').get<boolean>('debugAutoOpenPanel', true)) {
            await vscode.commands.executeCommand('smodsDebugView.focus');
          }
        });
      }
    } catch (err) {
      this.output.error(`Launch failed: ${err}`);
      if (solo && modsFolder) { restoreBlacklist(modsFolder, this.soloBlacklistOriginal, this.output); }
      if (this.debugActiveForRun && modsFolder) {
        this.debugAgent?.uninstallBridge(modsFolder);
        this.debugActiveForRun = false;
      }
      vscode.window.showErrorMessage(`Failed to launch Balatro: ${err}`);
    } finally {
      this.launching = false;
    }
  }

  private async startPolling(): Promise<boolean> {
    // Poll for the process to appear for up to 30 s. Steam can be slow to
    // spawn Balatro on cold start; the previous flat 3 s sleep + single check
    // would silently miss late arrivals and never arm the exit watcher.
    const APPEAR_TIMEOUT_MS = 30_000;
    const APPEAR_INTERVAL_MS = 500;
    const start = Date.now();
    let alive = false;
    while (Date.now() - start < APPEAR_TIMEOUT_MS) {
      if (await isBalatroProcessRunning()) { alive = true; break; }
      await new Promise(r => setTimeout(r, APPEAR_INTERVAL_MS));
    }
    if (!alive) {
      this.output.warn(
        `Balatro did not appear within ${APPEAR_TIMEOUT_MS / 1000}s — launch may have failed. ` +
        `Check the Balatro Log panel.`
      );
      vscode.window.showWarningMessage(
        'Balatro did not start. Check the Balatro Log panel for details.'
      );
      return false;
    }

    await vscode.commands.executeCommand('setContext', 'smods.balatroRunning', true);
    this._onDidChangeState.fire(true);
    const aliveSince = Date.now();
    this.pollTimer = setInterval(async () => {
      const still = await isBalatroProcessRunning();
      if (!still) {
        clearInterval(this.pollTimer!);
        this.pollTimer = undefined;
        const lifetimeMs = Date.now() - aliveSince;
        if (lifetimeMs < 5000) {
          this.output.warn(
            `Balatro exited after ${lifetimeMs}ms — likely a load-time crash. ` +
            `Check the Balatro Log panel for the lovely log.`
          );
          vscode.window.showWarningMessage(
            'Balatro crashed shortly after launch. Open the Balatro Log panel to diagnose.'
          );
        } else {
          this.output.info('Balatro exited.');
        }
        removeModSymlinks(this.output);
          if (this.soloMode) {
            const modsFolder = getModsFolder();
            if (modsFolder) { restoreBlacklist(modsFolder, this.soloBlacklistOriginal, this.output); }
            this.soloBlacklistOriginal = null;
            this.soloMode = false;
          }
          if (this.debugActiveForRun) {
            const modsFolder = getModsFolder();
            this.debugAgent?.disconnect();
            if (modsFolder) { this.debugAgent?.uninstallBridge(modsFolder); }
            this.debugActiveForRun = false;
          }
        await vscode.commands.executeCommand(
          'setContext', 'smods.balatroRunning', false
        );
        this._onDidChangeState.fire(false);
      }
    }, 2000);
    return true;
  }

  /**
   * Reload Balatro by killing the running process and relaunching via Steam.
   * Preserves the current solo/debug mode that was used for the original launch.
   */
  async reload(): Promise<void> {
    if (!this.isRunning()) {
      vscode.window.showInformationMessage('Balatro is not running.');
      return;
    }
    const solo = this.soloMode;
    this.output.info(`Reloading Balatro (kill + relaunch)${solo ? ' [solo]' : ''}.`);
    try {
      if (process.platform === 'win32') {
        await runCmd('taskkill.exe', ['/IM', 'Balatro.exe', '/F']);
      } else {
        await runCmd('pkill', ['-x', 'Balatro']);
      }
    } catch (err) {
      this.output.error(`Reload: kill failed: ${err}`);
      vscode.window.showErrorMessage(`Reload failed (could not kill Balatro): ${err}`);
      return;
    }
    // Wait for the process to fully exit before relaunching.
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 500));
      if (!(await isBalatroProcessRunning())) { break; }
    }

    // Stop the poll timer ourselves so it doesn't race with _launch and
    // remove symlinks after _launch has already re-established them.
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    removeModSymlinks(this.output);
    await vscode.commands.executeCommand('setContext', 'smods.balatroRunning', false);
    this._onDidChangeState.fire(false);

    await this._launch(solo);
  }
}

async function isBalatroProcessRunning(): Promise<boolean> {
  try {
    if (process.platform === 'win32') {
      await runCmd('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        'if (!(Get-Process -Name Balatro -ErrorAction SilentlyContinue)) { exit 1 }'
      ]);
    } else {
      // Linux (including WSL) and macOS
      await runCmd('pgrep', ['-x', 'Balatro']);
    }
    return true;
  } catch {
    return false;
  }
}

function runCmd(cmd: string, args: string[], opts: cp.SpawnOptions = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = cp.spawn(cmd, args, { shell: false, windowsHide: true, ...opts });
    let stderr = '';
    child.stderr?.on('data', d => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('exit', code => {
      if (code === 0) {resolve();}
      else {reject(new Error(stderr || `exit ${code}`));}
    });
  });
}

export function registerRuntimeCommands(
  context: vscode.ExtensionContext,
  runtime: BalatroRuntime,
  output: vscode.LogOutputChannel
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('smods.launchBalatro',
      () => runtime.launch()),
    vscode.commands.registerCommand('smods.launchSolo',
      () => runtime.launchSolo()),
    vscode.commands.registerCommand('smods.stopBalatro',
      () => runtime.stop()),
    vscode.commands.registerCommand('smods.toggleBalatro',
      () => runtime.toggle()),
    vscode.commands.registerCommand('smods.reloadBalatro',
      () => runtime.reload()),
    vscode.commands.registerCommand('smods.openModsFolder', async () => {
      const folder = getModsFolder();
      if (!folder || !fs.existsSync(folder)) {
        vscode.window.showErrorMessage(
          `Mods folder not found. Configure "smods.modsFolder" in settings.`
        );
        return;
      }
      output.info(`Revealing ${folder}`);
      await vscode.env.openExternal(vscode.Uri.file(folder));
    })
  );
}
