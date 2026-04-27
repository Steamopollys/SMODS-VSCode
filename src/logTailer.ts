import * as vscode from 'vscode';
import * as fs from 'fs';
import { getLogFile } from './paths';

/**
 * Tails the Balatro/Lovely log file into a dedicated Output channel.
 * Handles:
 *  - file not yet existing (polls for creation)
 *  - file rotation/truncation (detects size shrink, reopens)
 */
class LogTailer implements vscode.Disposable {
  private channel: vscode.OutputChannel;
  private watcher?: fs.FSWatcher;
  private readHandle?: fs.promises.FileHandle;
  private position = 0;
  private pollTimer?: NodeJS.Timeout;
  private tailTimer?: NodeJS.Timeout;
  private currentPath?: string;
  private disposed = false;
  private readonly _onLine = new vscode.EventEmitter<string>();
  readonly onLine = this._onLine.event;
  private readonly _onReset = new vscode.EventEmitter<void>();
  readonly onReset = this._onReset.event;

  constructor() {
    this.channel = vscode.window.createOutputChannel('Balatro Log');
  }

  async start(): Promise<void> {
    const file = getLogFile();
    if (!file) {
      vscode.window.showErrorMessage(
        'Could not determine Balatro log file path. Configure "smods.logFile".'
      );
      return;
    }
    // Drop any prior session's watcher/timers/handle before re-arming, otherwise
    // each launch leaks an fs.watch + 500ms interval and they race on position.
    await this.closeHandles();
    this.currentPath = file;
    this.channel.clear();
    this.channel.appendLine(`[smods] Tailing ${file}`);
    this._onReset.fire();
    await this.open();
  }

  /** Stop watching but keep the channel/buffer alive for post-mortem viewing. */
  async stop(): Promise<void> {
    await this.closeHandles();
  }

  private async open(): Promise<void> {
    if (!this.currentPath) {return;}
    const file = this.currentPath;

    // If the file doesn't exist yet, poll for it.
    if (!fs.existsSync(file)) {
      this.channel.appendLine(`[smods] Waiting for log file to appear...`);
      this.pollTimer = setInterval(async () => {
        if (fs.existsSync(file)) {
          clearInterval(this.pollTimer!);
          this.pollTimer = undefined;
          await this.open();
        }
      }, 1000);
      return;
    }

    try {
      this.readHandle = await fs.promises.open(file, 'r');
      // Start from beginning — Lovely truncates the log each launch so
      // we always want the full session output.
      this.position = 0;

      this.watcher = fs.watch(file, { persistent: false }, (event) => {
        if (this.disposed) {return;}
        if (event === 'change') {void this.readMore();}
        if (event === 'rename') {void this.reopen();}
      });
      // fs.watch is unreliable on WSL /mnt/c paths — poll as fallback.
      this.tailTimer = setInterval(() => { void this.readMore(); }, 500);
      // Flush any content already in the file before we started watching.
      await this.readMore();
    } catch (err) {
      this.channel.appendLine(`[smods] Failed to open log: ${err}`);
    }
  }

  private async readMore(): Promise<void> {
    if (!this.readHandle || !this.currentPath) {return;}
    try {
      const stat = await this.readHandle.stat();
      if (stat.size < this.position) {
        // Truncated — start over.
        this.position = 0;
      }
      if (stat.size === this.position) {return;}
      const length = stat.size - this.position;
      const buf = Buffer.alloc(length);
      const { bytesRead } = await this.readHandle.read(
        buf, 0, length, this.position
      );
      this.position += bytesRead;
      const text = buf.subarray(0, bytesRead).toString('utf8');
      for (const line of text.split(/\r?\n/)) {
        if (line.length > 0) {
          this.channel.appendLine(line);
          this._onLine.fire(line);
        }
      }
    } catch {
      void this.reopen();
    }
  }

  private async reopen(): Promise<void> {
    await this.closeHandles();
    await this.open();
  }

  private async closeHandles(): Promise<void> {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = undefined;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    if (this.tailTimer) {
      clearInterval(this.tailTimer);
      this.tailTimer = undefined;
    }
    if (this.readHandle) {
      try { await this.readHandle.close(); } catch { /* */ }
      this.readHandle = undefined;
    }
  }

  dispose(): void {
    this.disposed = true;
    void this.closeHandles();
    this.channel.dispose();
    this._onLine.dispose();
    this._onReset.dispose();
  }
}

export type { LogTailer };

export function registerLogTailer(
  context: vscode.ExtensionContext,
  _output: vscode.LogOutputChannel
): LogTailer {
  const tailer = new LogTailer();
  context.subscriptions.push(tailer);
  context.subscriptions.push(
    vscode.commands.registerCommand('smods.showLog', async () => {
      await tailer.start();
    })
  );
  return tailer;
}
