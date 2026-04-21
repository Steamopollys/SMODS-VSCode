import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getModsFolder } from './paths';
import { ensureModSymlinks, removeModSymlinks } from './symlink';

const BALATRO_STEAM_ID = '2379780';
const SOLO_MARKER = '# smods-solo';

// ---------------------------------------------------------------------------
// Helpers: temporarily blacklist / restore non-essential mods via lovely
// ---------------------------------------------------------------------------

/** Returns true if the folder name is a core runtime that must never be blacklisted. */
function isCoreModDir(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith('smods-') || lower === 'steamodded' || lower === 'smods'
    || lower === 'lovely';
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
  private soloMode = false;
  private soloBlacklistOriginal: string | null = null;
  private readonly _onDidChangeState = new vscode.EventEmitter<boolean>();
  readonly onDidChangeState = this._onDidChangeState.event;

  constructor(private output: vscode.LogOutputChannel) {}

  isRunning(): boolean {
    return !!this.pollTimer;
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
    this.output.info(`Launching Balatro via Steam (appid ${BALATRO_STEAM_ID})${solo ? ' [solo]' : ''}`);
    if (modsFolder) { this.output.info(`Mods folder: ${modsFolder}`); }

    if (solo && modsFolder) {
      this.soloBlacklistOriginal = blacklistOtherMods(modsFolder, this.output);
    }

    ensureModSymlinks(this.output);

    try {
      await vscode.env.openExternal(
        vscode.Uri.parse(`steam://rungameid/${BALATRO_STEAM_ID}`)
      );
      // Wait briefly for the process to appear, then start polling.
      await new Promise(r => setTimeout(r, 3000));
      this.soloMode = solo;
      await this.startPolling();
      vscode.window.showInformationMessage(
        solo ? 'Launched Balatro (solo — other mods disabled).' : 'Launched Balatro.'
      );
      await vscode.commands.executeCommand('smods.showLog');
      await vscode.commands.executeCommand('smodsLogView.focus');
    } catch (err) {
      this.output.error(`Launch failed: ${err}`);
      if (solo && modsFolder) { restoreBlacklist(modsFolder, this.soloBlacklistOriginal, this.output); }
      vscode.window.showErrorMessage(`Failed to launch Balatro: ${err}`);
    }
  }

  private async startPolling(): Promise<void> {
    const alive = await isBalatroProcessRunning();
    await vscode.commands.executeCommand(
      'setContext', 'smods.balatroRunning', alive
    );
    if (!alive) {return;}
    this._onDidChangeState.fire(true);
    this.pollTimer = setInterval(async () => {
      const still = await isBalatroProcessRunning();
      if (!still) {
        clearInterval(this.pollTimer!);
        this.pollTimer = undefined;
        this.output.info('Balatro exited.');
        removeModSymlinks(this.output);
          if (this.soloMode) {
            const modsFolder = getModsFolder();
            if (modsFolder) { restoreBlacklist(modsFolder, this.soloBlacklistOriginal, this.output); }
            this.soloBlacklistOriginal = null;
            this.soloMode = false;
          }
        await vscode.commands.executeCommand(
          'setContext', 'smods.balatroRunning', false
        );
        this._onDidChangeState.fire(false);
      }
    }, 2000);
  }

  /**
   * Send a mod-reload keystroke (Alt+F5) to the running Balatro window.
   *
   * This uses platform-specific tooling:
   *   - Windows: PowerShell's SendKeys via System.Windows.Forms
   *   - macOS:   osascript tell System Events
   *   - Linux:   xdotool if available
   */
  async reload(): Promise<void> {
    const platform = process.platform;
    try {
      if (platform === 'win32') {
        const ps1 = `\$ErrorActionPreference = 'Stop'
\$proc = Get-Process -Name Balatro -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not \$proc) { Write-Error "Balatro not running"; exit 2 }
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class WinMsg {
    public delegate bool EnumWindowsProc(IntPtr h, IntPtr lp);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lp);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
    [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetClassName(IntPtr h, StringBuilder buf, int max);
    [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetWindowText(IntPtr h, StringBuilder buf, int max);
    [DllImport("user32.dll", SetLastError=true)] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr wp, IntPtr lp);
    [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint type);
    public static List<IntPtr> GameWindowsForPid(uint pid) {
        var list = new List<IntPtr>();
        EnumWindows((h, lp) => {
            uint wpid; GetWindowThreadProcessId(h, out wpid);
            if (wpid != pid || !IsWindowVisible(h) || GetWindowTextLength(h) == 0) return true;
            var cls = new StringBuilder(256); GetClassName(h, cls, 256);
            if (cls.ToString() == "ConsoleWindowClass") return true;
            list.Add(h); return true;
        }, IntPtr.Zero);
        return list;
    }
    public static string WindowLabel(IntPtr h) {
        var t = new StringBuilder(256); GetWindowText(h, t, 256);
        var c = new StringBuilder(256); GetClassName(h, c, 256);
        return t.ToString() + " [" + c.ToString() + "]";
    }
}
"@
\$windows = [WinMsg]::GameWindowsForPid(\$proc.Id)
if (\$windows.Count -eq 0) { Write-Error "Balatro window not found (pid \$(\$proc.Id))"; exit 2 }
\$hwnd = \$windows[0]
Write-Host ("Target hwnd=0x{0:X} {1}" -f \$hwnd.ToInt64(), [WinMsg]::WindowLabel(\$hwnd))

\$VK_MENU = 0x12
\$VK_F5   = 0x74
\$altScan = [WinMsg]::MapVirtualKey(\$VK_MENU, 0)
\$f5Scan  = [WinMsg]::MapVirtualKey(\$VK_F5,   0)
\$WM_KEYUP       = 0x101
\$WM_SYSKEYDOWN  = 0x104
\$WM_SYSKEYUP    = 0x105

function MakeLParam([int]\$scan, [bool]\$up, [bool]\$ctxAlt) {
    \$l = [int64]1
    \$l = \$l -bor ([int64]\$scan -shl 16)
    if (\$ctxAlt) { \$l = \$l -bor ([int64]1 -shl 29) }
    if (\$up)     { \$l = \$l -bor ([int64]1 -shl 30) -bor ([int64]1 -shl 31) }
    return [IntPtr]\$l
}

\$posts = @(
    @(\$WM_SYSKEYDOWN, \$VK_MENU, (MakeLParam \$altScan \$false \$false)),
    @(\$WM_SYSKEYDOWN, \$VK_F5,   (MakeLParam \$f5Scan  \$false \$true)),
    @(\$WM_SYSKEYUP,   \$VK_F5,   (MakeLParam \$f5Scan  \$true  \$true)),
    @(\$WM_KEYUP,      \$VK_MENU, (MakeLParam \$altScan \$true  \$false))
)
\$fails = 0
\$failDetail = @()
for (\$i = 0; \$i -lt \$posts.Count; \$i++) {
    \$p = \$posts[\$i]
    \$r = [WinMsg]::PostMessage(\$hwnd, \$p[0], [IntPtr]\$p[1], \$p[2])
    if (-not \$r) {
        \$fails++
        \$failDetail += "post\$i:err\$([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())"
    }
    if (\$i -lt 3) { Start-Sleep -Milliseconds 40 }
}
if (\$fails -eq \$posts.Count) {
    Write-Error "all PostMessage calls failed (\$(\$failDetail -join ','))"
    exit 3
}
if (\$fails -gt 0) { Write-Host "Posted Alt+F5 (\$fails of \$(\$posts.Count) posts failed: \$(\$failDetail -join ','))" }
else { Write-Host "Posted Alt+F5" }
`;
        const tmpFile = path.join(os.tmpdir(), 'smods_reload.ps1');
        fs.writeFileSync(tmpFile, ps1, 'utf8');
        const { stdout, stderr } = await runCmdCapture('powershell.exe',
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tmpFile]);
        if (stdout.trim()) {this.output.info(`reload.ps1: ${stdout.trim()}`);}
        if (stderr.trim()) {this.output.warn(`reload.ps1: ${stderr.trim()}`);}
      } else if (platform === 'darwin') {
        const script = `
tell application "System Events"
  if exists (process "Balatro") then
    tell process "Balatro" to set frontmost to true
    delay 0.12
    key code 96 using {option down}
  else
    error "Balatro not running"
  end if
end tell`;
        await runCmd('osascript', ['-e', script]);
      } else {
        // Linux: try xdotool.
        try {
          await runCmd('xdotool', [
            'search', '--name', 'Balatro', 'windowactivate',
            '--sync', 'key', 'alt+F5'
          ]);
        } catch {
          vscode.window.showWarningMessage(
            'Install xdotool to enable "Reload Mods" on Linux, or press Alt+F5 in-game.'
          );
          return;
        }
      }
      ensureModSymlinks(this.output);
      this.output.info('Sent Alt+F5 to Balatro.');
    } catch (err) {
      this.output.error(`Reload failed: ${err}`);
      vscode.window.showErrorMessage(
        `Reload failed: ${err}. Is Balatro running? You can also press Alt+F5 manually in-game.`
      );
    }
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

function runCmdCapture(
  cmd: string, args: string[], opts: cp.SpawnOptions = {}
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = cp.spawn(cmd, args, { shell: false, windowsHide: true, ...opts });
    let stdout = '', stderr = '';
    child.stdout?.on('data', d => { stdout += d.toString(); });
    child.stderr?.on('data', d => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('exit', code => {
      if (code === 0) {resolve({ stdout, stderr });}
      else {reject(new Error(stderr.trim() || stdout.trim() || `exit ${code}`));}
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
