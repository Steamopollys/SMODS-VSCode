import * as vscode from 'vscode';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';

const DEBUG_PLUS_RELEASES = 'https://github.com/WilsontheWolf/DebugPlus/releases';
const BRIDGE_DIR_NAME = 'smods-debug-bridge';
const CONNECT_RETRY_MS = 500;
const CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_PORT = 43278;

// TODO(phase2): add a shared-secret token negotiated via port.txt so remote
// LAN attackers cannot drive the bridge if the loopback restriction is ever
// loosened (e.g. WSL host-forwarding). See plan §Security.

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  cmd: string;
}

export interface HelloEvent {
  version: number;
  port: number;
  love: string;
  paused: boolean;
  profilerRunning?: boolean;
  perfOverlay?: boolean;
}

export interface LogEvent {
  level: string;
  name?: string;
  text: string;
}

export class DebugAgent {
  private readonly _onDidConnect = new vscode.EventEmitter<HelloEvent>();
  private readonly _onDidDisconnect = new vscode.EventEmitter<void>();
  private readonly _onPauseState = new vscode.EventEmitter<boolean>();
  private readonly _onLogLine = new vscode.EventEmitter<LogEvent>();
  readonly onDidConnect = this._onDidConnect.event;
  readonly onDidDisconnect = this._onDidDisconnect.event;
  readonly onPauseState = this._onPauseState.event;
  readonly onLogLine = this._onLogLine.event;

  private socket?: net.Socket;
  private rxBuf = '';
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private connecting = false;
  private connected = false;
  private _paused = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.LogOutputChannel
  ) {}

  get isConnected(): boolean { return this.connected; }
  get paused(): boolean { return this._paused; }

  // --------------------------------------------------------------------- //
  //  DebugPlus detection
  // --------------------------------------------------------------------- //

  detectDebugPlus(modsFolder: string): boolean {
    let entries: string[];
    try { entries = fs.readdirSync(modsFolder); }
    catch { return false; }

    for (const entry of entries) {
      const modRoot = path.join(modsFolder, entry);
      let stat: fs.Stats;
      try { stat = fs.statSync(modRoot); } catch { continue; }
      if (!stat.isDirectory()) { continue; }
      if (this.isDebugPlusRoot(modRoot)) { return true; }
    }
    return false;
  }

  private isDebugPlusRoot(modRoot: string): boolean {
    let files: string[];
    try { files = fs.readdirSync(modRoot); } catch { return false; }
    for (const f of files) {
      if (!f.toLowerCase().endsWith('.json')) { continue; }
      try {
        const raw = fs.readFileSync(path.join(modRoot, f), 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && parsed.id === 'DebugPlus') {
          return true;
        }
      } catch { /* ignore */ }
    }
    return false;
  }

  async promptInstallDebugPlus(): Promise<void> {
    const pick = await vscode.window.showInformationMessage(
      'Debug Mode requires the DebugPlus mod. Install it from GitHub into your Mods folder, then toggle Debug Mode again.',
      { modal: true },
      'Open DebugPlus Releases',
      'Open Mods Folder'
    );
    if (pick === 'Open DebugPlus Releases') {
      await vscode.env.openExternal(vscode.Uri.parse(DEBUG_PLUS_RELEASES));
    } else if (pick === 'Open Mods Folder') {
      await vscode.commands.executeCommand('smods.openModsFolder');
    }
  }

  // --------------------------------------------------------------------- //
  //  Bridge install / uninstall
  // --------------------------------------------------------------------- //

  async installBridge(modsFolder: string): Promise<void> {
    const src = path.join(this.context.extensionUri.fsPath, 'media', BRIDGE_DIR_NAME);
    const dst = path.join(modsFolder, BRIDGE_DIR_NAME);
    try {
      fs.rmSync(dst, { recursive: true, force: true });
      fs.cpSync(src, dst, { recursive: true, force: true });
      fs.writeFileSync(path.join(dst, 'port.txt'), String(this.configuredPort()), 'utf8');
      this.output.info(`Debug: installed bridge mod to ${dst}`);
    } catch (err) {
      this.output.error(`Debug: bridge install failed: ${err}`);
      throw err;
    }
  }

  uninstallBridge(modsFolder: string): void {
    const dst = path.join(modsFolder, BRIDGE_DIR_NAME);
    try {
      fs.rmSync(dst, { recursive: true, force: true });
      this.output.info(`Debug: removed bridge mod from ${dst}`);
    } catch (err) {
      this.output.warn(`Debug: bridge uninstall failed: ${err}`);
    }
  }

  // --------------------------------------------------------------------- //
  //  TCP lifecycle
  // --------------------------------------------------------------------- //

  private configuredPort(): number {
    return vscode.workspace
      .getConfiguration('smods')
      .get<number>('debugPort', DEFAULT_PORT);
  }

  async connect(): Promise<boolean> {
    if (this.connected || this.connecting) { return this.connected; }
    this.connecting = true;

    const port = this.configuredPort();
    const start = Date.now();
    try {
      while (Date.now() - start < CONNECT_TIMEOUT_MS) {
        if (await this.tryConnectOnce(port)) { return true; }
        await sleep(CONNECT_RETRY_MS);
      }
      this.output.warn(`Debug: could not connect to bridge on 127.0.0.1:${port} within ${CONNECT_TIMEOUT_MS}ms.`);
      vscode.window.showWarningMessage(
        `Debug bridge did not respond on port ${port}. Is DebugPlus installed and the bridge mod loaded?`
      );
      return false;
    } finally {
      this.connecting = false;
    }
  }

  private tryConnectOnce(port: number): Promise<boolean> {
    return new Promise(resolve => {
      const sock = net.createConnection({ host: '127.0.0.1', port });
      let done = false;
      const settle = (ok: boolean): void => {
        if (done) { return; }
        done = true;
        if (!ok) { try { sock.destroy(); } catch { /* ignore */ } }
        resolve(ok);
      };
      sock.once('error', () => settle(false));
      sock.once('connect', () => {
        this.attachSocket(sock);
        settle(true);
      });
    });
  }

  private attachSocket(sock: net.Socket): void {
    this.socket = sock;
    this.rxBuf = '';
    this.connected = true;
    sock.setNoDelay(true);
    sock.on('data', buf => this.onData(buf));
    sock.on('close', () => this.onClose());
    sock.on('error', err => this.output.warn(`Debug: socket error: ${err}`));
    void vscode.commands.executeCommand('setContext', 'smods.debugConnected', true);
    this.output.info('Debug: connected to bridge.');
  }

  private onClose(): void {
    this.socket = undefined;
    this.rxBuf = '';
    this.connected = false;
    for (const p of this.pending.values()) {
      p.reject(new Error('debug bridge disconnected'));
    }
    this.pending.clear();
    void vscode.commands.executeCommand('setContext', 'smods.debugConnected', false);
    this._onDidDisconnect.fire();
    this.output.info('Debug: bridge disconnected.');
  }

  disconnect(): void {
    if (!this.socket) { return; }
    try { this.socket.destroy(); } catch { /* ignore */ }
    this.socket = undefined;
  }

  // --------------------------------------------------------------------- //
  //  Framing & dispatch
  // --------------------------------------------------------------------- //

  private onData(buf: Buffer): void {
    this.rxBuf += buf.toString('utf8');
    let nl = this.rxBuf.indexOf('\n');
    while (nl >= 0) {
      const line = this.rxBuf.slice(0, nl);
      this.rxBuf = this.rxBuf.slice(nl + 1);
      if (line.length > 0) { this.onLine(line); }
      nl = this.rxBuf.indexOf('\n');
    }
  }

  private onLine(line: string): void {
    let frame: { id?: number; ok?: boolean; result?: unknown; error?: string;
      ev?: string; [k: string]: unknown };
    try { frame = JSON.parse(line); }
    catch (err) {
      this.output.warn(`Debug: malformed frame: ${line} (${err})`);
      return;
    }

    if (typeof frame.ev === 'string') {
      this.handleNotification(frame);
      return;
    }
    if (typeof frame.id === 'number') {
      const waiter = this.pending.get(frame.id);
      if (!waiter) { return; }
      this.pending.delete(frame.id);
      if (frame.ok) { waiter.resolve(frame.result); }
      else { waiter.reject(new Error(String(frame.error ?? 'unknown error'))); }
    }
  }

  private handleNotification(frame: { ev?: string; [k: string]: unknown }): void {
    switch (frame.ev) {
      case 'hello': {
        const hello: HelloEvent = {
          version: Number(frame.version ?? 0),
          port: Number(frame.port ?? 0),
          love: String(frame.love ?? ''),
          paused: Boolean(frame.paused),
        };
        this._paused = hello.paused;
        this._onDidConnect.fire(hello);
        break;
      }
      case 'pauseState':
        this._paused = Boolean(frame.paused);
        this._onPauseState.fire(this._paused);
        break;
      case 'log':
        this._onLogLine.fire({
          level: String(frame.level ?? 'INFO'),
          name: frame.name ? String(frame.name) : undefined,
          text: String(frame.text ?? ''),
        });
        break;
    }
  }

  private request<T>(cmd: string, args?: unknown, timeoutMs = 10_000): Promise<T> {
    if (!this.socket || !this.connected) {
      return Promise.reject(new Error('debug bridge not connected'));
    }
    const id = this.nextId++;
    const frame = { id, cmd, args: args ?? {} };
    const line = JSON.stringify(frame) + '\n';

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`debug ${cmd} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v: unknown) => { clearTimeout(timer); resolve(v as T); },
        reject: (e: Error) => { clearTimeout(timer); reject(e); },
        cmd,
      });
      try { this.socket!.write(line); }
      catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err as Error);
      }
    });
  }

  // --------------------------------------------------------------------- //
  //  Public commands
  // --------------------------------------------------------------------- //

  ping(): Promise<{ pong: boolean; t: number }> {
    return this.request('ping');
  }

  evaluate(code: string): Promise<{ pretty: string; raw?: unknown; type: string; n: number }> {
    return this.request('eval', { code });
  }

  pause(): Promise<{ paused: boolean }> {
    return this.request('pause');
  }

  resume(): Promise<{ paused: boolean }> {
    return this.request('resume');
  }

  step(frames = 1): Promise<{ paused: boolean; queued: number }> {
    return this.request('step', { frames });
  }

  getPath(p: string): Promise<{ type: string; pretty: string; raw?: unknown }> {
    return this.request('getPath', { path: p });
  }

  setPath(p: string, valueJson: string): Promise<{ ok: boolean }> {
    return this.request('setPath', { path: p, valueJson });
  }

  listGlobals(): Promise<{
    globals: { key: string; type: string; preview: string }[];
  }> {
    return this.request('listGlobals');
  }

  listChildren(p: string, limit = 200): Promise<{
    children: { key: string; keyType: string; type: string; preview: string }[];
    truncated: boolean;
    total?: number;
  }> {
    return this.request('listChildren', { path: p, limit });
  }

  // --------------------------------------------------------------------- //
  //  Profiler
  // --------------------------------------------------------------------- //

  profilerToggle(): Promise<{ running: boolean; report?: string }> {
    return this.request('profilerToggle');
  }

  // --------------------------------------------------------------------- //
  //  Performance overlay
  // --------------------------------------------------------------------- //

  perfOverlay(): Promise<{ enabled: boolean }> {
    return this.request('perfOverlay');
  }

  perfStats(): Promise<{
    fps: number;
    frameTimeMs: number;
    memKb: number;
    drawCalls: number;
    textureMemMb: number;
    eventQueues: Record<string, number>;
    overlayEnabled: boolean;
  }> {
    return this.request('perfStats');
  }

  // --------------------------------------------------------------------- //
  //  Save states
  // --------------------------------------------------------------------- //

  saveStateSave(slot: string): Promise<{ slot: string; ok: boolean }> {
    return this.request('saveStateSave', { slot });
  }

  saveStateLoad(slot: string): Promise<{ slot: string; ok: boolean }> {
    return this.request('saveStateLoad', { slot });
  }

  saveStateList(): Promise<{
    slots: { slot: string; exists: boolean; modtime: number | null }[];
  }> {
    return this.request('saveStateList');
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
