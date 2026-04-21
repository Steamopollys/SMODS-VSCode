import * as vscode from 'vscode';
import * as path from 'path';
import { BalatroRuntime } from './runtime';
import { findModRoots } from './paths';

const WATCHED_EXTS = ['lua', 'json', 'toml'];

class AutoReloadWatcher implements vscode.Disposable {
  private watchers: vscode.FileSystemWatcher[] = [];
  private timer?: NodeJS.Timeout;
  private statusItem: vscode.StatusBarItem;
  private active = false;

  constructor(
    private runtime: BalatroRuntime,
    private output: vscode.LogOutputChannel
  ) {
    this.statusItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left, 98
    );
    this.statusItem.command = 'smods.toggleAutoReload';
    this.updateStatus();
  }

  private cfg(): { enabled: boolean; delay: number } {
    const c = vscode.workspace.getConfiguration('smods');
    return {
      enabled: c.get<boolean>('autoReload', false),
      delay:   c.get<number>('autoReloadDelay', 500)
    };
  }

  private updateStatus(): void {
    const { enabled } = this.cfg();
    this.statusItem.text = enabled
      ? '$(sync~spin) Auto-Reload'
      : '$(sync-ignored) Auto-Reload';
    this.statusItem.tooltip = enabled
      ? 'Auto-reload on save: ON. Click to disable.'
      : 'Auto-reload on save: OFF. Click to enable.';
    this.statusItem.show();
  }

  refresh(): void {
    this.dispose();
    this.active = false;

    const { enabled } = this.cfg();
    this.updateStatus();
    if (!enabled) {return;}

    const roots = findModRoots();
    if (roots.length === 0) {
      this.output.info('Auto-reload enabled but no mod roots detected.');
      return;
    }

    for (const root of roots) {
      const pattern = new vscode.RelativePattern(
        root, `**/*.{${WATCHED_EXTS.join(',')}}`
      );
      const w = vscode.workspace.createFileSystemWatcher(pattern);
      const trigger = (uri: vscode.Uri) => this.onChange(uri);
      w.onDidChange(trigger);
      w.onDidCreate(trigger);
      this.watchers.push(w);
    }
    this.active = true;
    this.output.info(
      `Auto-reload watching ${roots.length} mod root(s) (delay ${this.cfg().delay}ms).`
    );
  }

  private onChange(uri: vscode.Uri): void {
    if (!this.runtime.isRunning()) {return;}
    if (path.basename(uri.fsPath).startsWith('.')) {return;}
    const { delay } = this.cfg();
    if (this.timer) {clearTimeout(this.timer);}
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.output.info(`Auto-reload fired (trigger: ${path.basename(uri.fsPath)})`);
      void this.runtime.reload();
    }, Math.max(100, delay));
  }

  async toggle(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('smods');
    const next = !cfg.get<boolean>('autoReload', false);
    await cfg.update('autoReload', next, vscode.ConfigurationTarget.Workspace);
    vscode.window.showInformationMessage(
      `Smods auto-reload ${next ? 'enabled' : 'disabled'}.`
    );
  }

  isActive(): boolean { return this.active; }

  dispose(): void {
    for (const w of this.watchers) {w.dispose();}
    this.watchers = [];
    if (this.timer) {clearTimeout(this.timer); this.timer = undefined;}
  }
}

export function registerAutoReload(
  context: vscode.ExtensionContext,
  runtime: BalatroRuntime,
  output: vscode.LogOutputChannel
): void {
  const watcher = new AutoReloadWatcher(runtime, output);
  context.subscriptions.push(watcher);
  watcher.refresh();

  context.subscriptions.push(
    vscode.commands.registerCommand('smods.toggleAutoReload',
      () => watcher.toggle()),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('smods.autoReload') ||
          e.affectsConfiguration('smods.autoReloadDelay')) {
        watcher.refresh();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => watcher.refresh())
  );
}
