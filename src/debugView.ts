import * as vscode from 'vscode';
import type { DebugAgent, LogEvent } from './debugAgent';

const PINNED_KEY = 'smods.debugTreePinned';
const HIDDEN_KEY = 'smods.debugTreeHidden';
const MAX_LOG_LINES = 2000;

type UiMsg =
  | { type: 'ready' }
  | { type: 'eval'; code: string }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'step'; frames?: number }
  | { type: 'listChildren'; path: string; nodeId: string; limit?: number }
  | { type: 'getPath'; path: string; watchId: string }
  | { type: 'setPath'; path: string; valueJson: string }
  | { type: 'pin'; path: string }
  | { type: 'unpin'; path: string }
  | { type: 'rescan' }
  | { type: 'profilerToggle' }
  | { type: 'perfToggle' }
  | { type: 'perfStats' }
  | { type: 'saveStateSave'; slot: string }
  | { type: 'saveStateLoad'; slot: string }
  | { type: 'saveStateList' };

class DebugViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private logBuffer: LogEvent[] = [];
  private autoRoots: string[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly agent: DebugAgent
  ) {
    agent.onDidConnect(hello => {
      this.post({ type: 'connected', hello,
        profilerRunning: hello.profilerRunning ?? false,
        perfOverlay: hello.perfOverlay ?? false,
      });
      void this.refreshAutoRoots();
    });
    agent.onDidDisconnect(() => {
      this.autoRoots = [];
      this.post({ type: 'disconnected' });
    });
    agent.onPauseState(paused => this.post({ type: 'pauseState', paused }));
    agent.onLogLine(line => {
      this.logBuffer.push(line);
      if (this.logBuffer.length > MAX_LOG_LINES) {
        this.logBuffer.splice(0, this.logBuffer.length - MAX_LOG_LINES);
      }
      this.post({ type: 'log', line });
    });
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html();
    view.webview.onDidReceiveMessage((msg: UiMsg) => this.handle(msg));
  }

  private post(msg: unknown): void {
    this.view?.webview.postMessage(msg);
  }

  private pinned(): string[] {
    return this.context.workspaceState.get<string[]>(PINNED_KEY) ?? [];
  }

  private hidden(): string[] {
    return this.context.workspaceState.get<string[]>(HIDDEN_KEY) ?? [];
  }

  private async setPinned(list: string[]): Promise<void> {
    await this.context.workspaceState.update(PINNED_KEY, list);
  }

  private async setHidden(list: string[]): Promise<void> {
    await this.context.workspaceState.update(HIDDEN_KEY, list);
  }

  private roots(): string[] {
    const hidden = new Set(this.hidden());
    const seen = new Set<string>();
    const out: string[] = [];
    for (const p of this.autoRoots) {
      if (hidden.has(p) || seen.has(p)) { continue; }
      seen.add(p); out.push(p);
    }
    for (const p of this.pinned()) {
      if (seen.has(p)) { continue; }
      seen.add(p); out.push(p);
    }
    return out;
  }

  private async refreshAutoRoots(): Promise<void> {
    if (!this.agent.isConnected) { return; }
    try {
      const res = await this.agent.listGlobals();
      this.autoRoots = res.globals.map(g => g.key);
    } catch {
      this.autoRoots = [];
    }
    this.post({ type: 'roots', roots: this.roots() });
  }

  private async pin(path: string): Promise<void> {
    const hidden = this.hidden();
    if (hidden.includes(path)) {
      await this.setHidden(hidden.filter(p => p !== path));
    } else if (!this.autoRoots.includes(path) && !this.pinned().includes(path)) {
      await this.setPinned([...this.pinned(), path]);
    }
    this.post({ type: 'roots', roots: this.roots() });
  }

  private async unpin(path: string): Promise<void> {
    if (this.autoRoots.includes(path)) {
      const hidden = this.hidden();
      if (!hidden.includes(path)) { await this.setHidden([...hidden, path]); }
    }
    const pinned = this.pinned();
    if (pinned.includes(path)) {
      await this.setPinned(pinned.filter(p => p !== path));
    }
    this.post({ type: 'roots', roots: this.roots() });
  }

  private async handle(msg: UiMsg): Promise<void> {
    switch (msg.type) {
      case 'ready':
        this.post({
          type: 'init',
          connected: this.agent.isConnected,
          paused: this.agent.paused,
          roots: this.roots(),
          logs: this.logBuffer,
        });
        break;
      case 'eval':
        try {
          const res = await this.agent.evaluate(msg.code);
          this.post({ type: 'evalResult', ok: true, code: msg.code, result: res });
        } catch (err) {
          this.post({ type: 'evalResult', ok: false, code: msg.code, error: String(err) });
        }
        break;
      case 'pause':
        try { await this.agent.pause(); } catch (err) { this.postError(err); }
        break;
      case 'resume':
        try { await this.agent.resume(); } catch (err) { this.postError(err); }
        break;
      case 'step':
        try { await this.agent.step(msg.frames ?? 1); } catch (err) { this.postError(err); }
        break;
      case 'listChildren':
        try {
          const res = await this.agent.listChildren(msg.path, msg.limit);
          this.post({ type: 'children', nodeId: msg.nodeId, path: msg.path, limit: msg.limit, ...res });
        } catch (err) {
          this.post({ type: 'children', nodeId: msg.nodeId, path: msg.path, children: [], truncated: false, error: String(err) });
        }
        break;
      case 'getPath':
        try {
          const res = await this.agent.getPath(msg.path);
          this.post({ type: 'watchValue', watchId: msg.watchId, path: msg.path, value: res });
        } catch (err) {
          this.post({ type: 'watchValue', watchId: msg.watchId, path: msg.path, error: String(err) });
        }
        break;
      case 'setPath':
        try { await this.agent.setPath(msg.path, msg.valueJson); }
        catch (err) { this.postError(err); }
        break;
      case 'pin':
        await this.pin(msg.path);
        break;
      case 'unpin':
        await this.unpin(msg.path);
        break;
      case 'rescan':
        await this.refreshAutoRoots();
        break;
      case 'profilerToggle':
        try {
          const pt = await this.agent.profilerToggle();
          this.post({ type: 'profilerState', running: pt.running, report: pt.report });
        } catch (err) { this.postError(err); }
        break;
      case 'perfToggle':
        try {
          const pe = await this.agent.perfOverlay();
          this.post({ type: 'perfOverlayState', enabled: pe.enabled });
        } catch (err) { this.postError(err); }
        break;
      case 'perfStats':
        try {
          const ps = await this.agent.perfStats();
          this.post({ type: 'perfStats', stats: ps });
        } catch (err) {
          this.post({ type: 'perfStats', error: String(err) });
        }
        break;
      case 'saveStateSave':
        try {
          await this.agent.saveStateSave(msg.slot);
          const sl = await this.agent.saveStateList();
          this.post({ type: 'saveSlots', slots: sl.slots });
        } catch (err) { this.postError(err); }
        break;
      case 'saveStateLoad':
        try { await this.agent.saveStateLoad(msg.slot); }
        catch (err) { this.postError(err); }
        break;
      case 'saveStateList':
        try {
          const sl = await this.agent.saveStateList();
          this.post({ type: 'saveSlots', slots: sl.slots });
        } catch (err) { this.postError(err); }
        break;
    }
  }

  private postError(err: unknown): void {
    this.post({ type: 'toast', text: String(err) });
  }

  private html(): string {
    return `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin: 0; padding: 0; font: 12px var(--vscode-editor-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
  .bar { position: sticky; top: 0; z-index: 2; display: flex; gap: 6px; padding: 4px 6px; background: var(--vscode-sideBar-background); border-bottom: 1px solid var(--vscode-panel-border); align-items: center; flex-wrap: wrap; }
  .status { font-size: 11px; padding: 2px 6px; border-radius: 9px; }
  .status.on { background: var(--vscode-statusBarItem-remoteBackground, #2d5); color: #000; }
  .status.off { background: var(--vscode-statusBarItem-errorBackground, #c33); color: #fff; }
  button { padding: 2px 8px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 0; cursor: pointer; }
  button:disabled { opacity: 0.4; cursor: default; }
  button.secondary { background: transparent; color: var(--vscode-foreground); border: 1px solid var(--vscode-panel-border); }
  section { border-bottom: 1px solid var(--vscode-panel-border); }
  section > header { padding: 4px 6px; font-weight: 600; cursor: pointer; user-select: none; background: var(--vscode-sideBarSectionHeader-background); }
  section.collapsed > .body { display: none; }
  .body { padding: 6px; }
  .repl-in { display: flex; gap: 6px; }
  .repl-in textarea { flex: 1; min-height: 38px; font: 12px var(--vscode-editor-font-family); background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); padding: 4px; resize: vertical; }
  .repl-out { margin-top: 6px; max-height: 200px; overflow-y: auto; font-family: var(--vscode-editor-font-family); white-space: pre-wrap; word-break: break-word; }
  .repl-entry { padding: 3px 4px; border-left: 3px solid transparent; }
  .repl-entry.in { border-color: #479; color: var(--vscode-descriptionForeground); }
  .repl-entry.ok { border-color: #3a5; }
  .repl-entry.err { border-color: #c44; color: #f88; }
  .tree { font-family: var(--vscode-editor-font-family); }
  .tree-toolbar { display: flex; flex-direction: column; gap: 4px; margin-bottom: 6px; }
  .tree-toolbar-row { display: flex; gap: 4px; }
  .tree-toolbar input { flex: 1; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); padding: 2px 4px; }
  .tree-root-wrapper { border-left: 2px solid transparent; }
  .tree-root-wrapper:hover { border-left-color: var(--vscode-focusBorder, #007fd4); }
  .tree-root-wrapper > .tree-row .tree-key { font-weight: 600; }
  .tree-stub { padding: 2px 4px; color: var(--vscode-descriptionForeground); font-style: italic; }
  .tree-stub.err { color: #f88; font-style: normal; }
  .tree-row { padding: 1px 2px; display: flex; align-items: baseline; gap: 2px; }
  .tree-row:hover { background: var(--vscode-list-hoverBackground); }
  .tree-row:hover .tree-actions { opacity: 1; pointer-events: auto; }
  .tree-caret { min-width: 14px; }
  .tree-key { color: var(--vscode-symbolIcon-variableForeground, #9cdcfe); }
  .tree-badge { font-size: 10px; padding: 0 3px; border-radius: 3px; opacity: 0.8; }
  .tree-badge.string  { color: #4ec9b0; }
  .tree-badge.number  { color: #b5cea8; }
  .tree-badge.boolean { color: #569cd6; }
  .tree-badge.function { color: #dcdcaa; }
  .tree-badge.table   { color: #ce9178; }
  .tree-badge.nil, .tree-badge.userdata, .tree-badge.thread { color: #888; }
  .tree-preview { color: var(--vscode-charts-orange, #d7a); flex: 1; word-break: break-all; cursor: default; }
  .tree-preview.editable { cursor: pointer; }
  .tree-preview.editable:hover { text-decoration: underline dotted; }
  .tree-edit-input { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-focusBorder, #007fd4); padding: 0 3px; font: inherit; width: 120px; }
  .tree-actions { opacity: 0; pointer-events: none; display: flex; gap: 2px; flex-shrink: 0; }
  .tree-actions button { background: none; border: none; color: var(--vscode-descriptionForeground); cursor: pointer; padding: 0 3px; font-size: 11px; line-height: 1; border-radius: 2px; }
  .tree-actions button:hover { background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.1)); color: var(--vscode-foreground); }
  .tree-actions button.unpin:hover { color: #f88; }
  .tree-children { margin-left: 14px; }
  .tree-load-more { padding: 2px 4px; color: var(--vscode-textLink-foreground, #4af); cursor: pointer; font-size: 11px; }
  .tree-load-more:hover { text-decoration: underline; }
  .log-pane { max-height: 220px; overflow-y: auto; padding: 2px 4px; white-space: pre-wrap; word-break: break-word; font-family: var(--vscode-editor-font-family); }
  .log-line { padding: 1px 2px; border-left: 3px solid transparent; }
  .log-line.ERROR, .log-line.FATAL { border-color: #e55; color: #f88; }
  .log-line.WARN { border-color: #e93; color: #fc9; }
  .log-line.INFO { border-color: #39c; }
  .log-line.DEBUG { border-color: #777; color: var(--vscode-descriptionForeground); }
  .prof-status { font-size: 11px; margin-left: 8px; color: var(--vscode-descriptionForeground); }
  .prof-report { margin-top: 6px; max-height: 300px; overflow-y: auto; font-family: var(--vscode-editor-font-family); font-size: 11px; }
  .prof-row { display: flex; align-items: center; gap: 5px; padding: 2px 0; }
  .prof-row.l2 { margin-left: 18px; color: var(--vscode-descriptionForeground); }
  .prof-pct { min-width: 36px; text-align: right; font-weight: 600; }
  .prof-bar-wrap { width: 80px; height: 8px; background: var(--vscode-panel-border); border-radius: 3px; flex-shrink: 0; }
  .prof-bar { height: 100%; border-radius: 3px; }
  .prof-bar.hot  { background: #e55; }
  .prof-bar.warm { background: #e93; }
  .prof-bar.mild { background: #db4; }
  .prof-bar.cool { background: #4a9; }
  .prof-loc { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .prof-vm { font-size: 10px; padding: 0 3px; border-radius: 3px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); flex-shrink: 0; }
  .perf-stats { margin-top: 8px; display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; font-family: var(--vscode-editor-font-family); font-size: 11px; }
  .perf-stats .k { color: var(--vscode-descriptionForeground); }
  .perf-stats .v { font-variant-numeric: tabular-nums; }
  .perf-stats .v.fps-hot  { color: #4a9; }
  .perf-stats .v.fps-warm { color: #db4; }
  .perf-stats .v.fps-cool { color: #e55; }
  .perf-queues { margin-top: 6px; padding-top: 4px; border-top: 1px dashed var(--vscode-panel-border); }
  .perf-queues-title { font-size: 10px; color: var(--vscode-descriptionForeground); margin-bottom: 2px; }
  .perf-queue-row { display: flex; justify-content: space-between; font-size: 11px; font-variant-numeric: tabular-nums; }
  .perf-err { color: #f88; font-size: 11px; margin-top: 4px; }
  .save-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 4px; }
  .save-slot { display: flex; flex-direction: column; gap: 2px; }
  .save-slot-label { font-size: 10px; text-align: center; color: var(--vscode-descriptionForeground); }
  .save-slot-label.exists { color: var(--vscode-foreground); }
  .toast { position: fixed; bottom: 10px; left: 10px; right: 10px; background: var(--vscode-inputValidation-errorBackground, #c33); color: #fff; padding: 6px 10px; border-radius: 3px; }
</style></head><body>
<div class="bar">
  <span class="status off" id="status">disconnected</span>
  <button id="btn-pause">Pause</button>
  <button id="btn-resume" disabled>Resume</button>
  <button id="btn-step" disabled title="Advance one frame">Step</button>
</div>

<section id="sec-repl">
  <header>REPL</header>
  <div class="body">
    <div class="repl-in">
      <textarea id="repl-code" placeholder="Lua — e.g. return G.GAME.dollars"></textarea>
      <button id="btn-run">Run</button>
    </div>
    <div class="repl-out" id="repl-out"></div>
  </div>
</section>

<section id="sec-tree">
  <header>Globals</header>
  <div class="body">
    <div class="tree-toolbar">
      <div class="tree-toolbar-row">
        <input id="tree-filter" placeholder="filter visible keys" />
        <button class="secondary" id="btn-tree-refresh" title="Re-detect globals from _G">⟳</button>
      </div>
      <div class="tree-toolbar-row">
        <input id="tree-path" placeholder="pin path as root, e.g. G.GAME.dollars" />
        <button class="secondary" id="btn-tree-pin" title="Pin as root">+</button>
      </div>
    </div>
    <div class="tree" id="tree-root"></div>
  </div>
</section>

<section id="sec-log" class="collapsed">
  <header>DebugPlus log</header>
  <div class="body">
    <div class="log-pane" id="log-pane"></div>
  </div>
</section>

<section id="sec-profiler" class="collapsed">
  <header>Profiler</header>
  <div class="body">
    <button id="btn-prof-toggle">Start</button>
    <span class="prof-status" id="prof-status">idle</span>
    <div class="prof-report" id="prof-report"></div>
  </div>
</section>

<section id="sec-perf" class="collapsed">
  <header>Performance Overlay</header>
  <div class="body">
    <button id="btn-perf-toggle">Enable</button>
    <span class="prof-status" id="perf-status"></span>
    <div class="perf-stats" id="perf-stats"></div>
    <div class="perf-queues" id="perf-queues" style="display:none"></div>
    <div class="perf-err" id="perf-err" style="display:none"></div>
  </div>
</section>

<section id="sec-saves" class="collapsed">
  <header>Save States</header>
  <div class="body">
    <div class="save-grid" id="save-grid"></div>
    <button class="secondary" id="btn-saves-refresh" style="margin-top:6px">Refresh</button>
  </div>
</section>
<script>
const vscode = acquireVsCodeApi();
const el = {
  status: document.getElementById('status'),
  pauseBtn: document.getElementById('btn-pause'),
  resumeBtn: document.getElementById('btn-resume'),
  stepBtn: document.getElementById('btn-step'),
  replCode: document.getElementById('repl-code'),
  runBtn: document.getElementById('btn-run'),
  replOut: document.getElementById('repl-out'),
  treeRoot: document.getElementById('tree-root'),
  treeFilter: document.getElementById('tree-filter'),
  treeRefreshBtn: document.getElementById('btn-tree-refresh'),
  treePath: document.getElementById('tree-path'),
  treePinBtn: document.getElementById('btn-tree-pin'),
  logPane: document.getElementById('log-pane'),
  profToggleBtn: document.getElementById('btn-prof-toggle'),
  profStatus: document.getElementById('prof-status'),
  profReport: document.getElementById('prof-report'),
  perfToggleBtn: document.getElementById('btn-perf-toggle'),
  perfStatus: document.getElementById('perf-status'),
  perfStats: document.getElementById('perf-stats'),
  perfQueues: document.getElementById('perf-queues'),
  perfErr: document.getElementById('perf-err'),
  saveGrid: document.getElementById('save-grid'),
  savesRefreshBtn: document.getElementById('btn-saves-refresh'),
};

const ui = vscode.getState() || { history: [], historyIdx: -1, expanded: [] };
if (!Array.isArray(ui.expanded)) ui.expanded = [];
const expanded = new Set(ui.expanded);
function saveUi() { ui.expanded = [...expanded]; vscode.setState(ui); }

let connected = false;

function setConnected(on) {
  connected = on;
  el.status.textContent = on ? 'connected' : 'disconnected';
  el.status.classList.toggle('on', on);
  el.status.classList.toggle('off', !on);
  el.pauseBtn.disabled = !on;
  el.runBtn.disabled = !on;
}

function setPaused(paused) {
  el.pauseBtn.disabled = !connected || paused;
  el.resumeBtn.disabled = !connected || !paused;
  el.stepBtn.disabled = !connected || !paused;
  el.status.textContent = !connected ? 'disconnected' : (paused ? 'paused' : 'connected');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'})[c]);
}

// --- collapsible sections ---
for (const sec of document.querySelectorAll('section')) {
  sec.querySelector('header').onclick = () => sec.classList.toggle('collapsed');
}

// --- pause / resume / step ---
el.pauseBtn.onclick = () => vscode.postMessage({ type: 'pause' });
el.resumeBtn.onclick = () => vscode.postMessage({ type: 'resume' });
el.stepBtn.onclick = (e) => vscode.postMessage({ type: 'step', frames: e.shiftKey ? 10 : 1 });

// --- REPL ---
function runRepl() {
  const code = el.replCode.value.trim();
  if (!code) return;
  ui.history.unshift(code);
  ui.history = ui.history.slice(0, 50);
  ui.historyIdx = -1;
  saveUi();
  appendReplEntry('in', '> ' + code);
  vscode.postMessage({ type: 'eval', code });
  el.replCode.value = '';
}
el.runBtn.onclick = runRepl;
el.replCode.addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); runRepl(); return; }
  if (e.key === 'ArrowUp' && !el.replCode.value.includes('\\n') && ui.history.length > 0) {
    e.preventDefault();
    ui.historyIdx = Math.min(ui.history.length - 1, ui.historyIdx + 1);
    el.replCode.value = ui.history[ui.historyIdx] || '';
    saveUi();
  } else if (e.key === 'ArrowDown' && ui.historyIdx >= 0) {
    e.preventDefault();
    ui.historyIdx--;
    el.replCode.value = ui.historyIdx < 0 ? '' : ui.history[ui.historyIdx];
    saveUi();
  }
});

function appendReplEntry(cls, text) {
  const d = document.createElement('div');
  d.className = 'repl-entry ' + cls;
  d.textContent = text;
  el.replOut.appendChild(d);
  el.replOut.scrollTop = el.replOut.scrollHeight;
}

// --- tree ---
const treeState = new Map();
const EDITABLE_TYPES = new Set(['string', 'number', 'boolean']);
const ROOT_DEFAULT_LIMIT = 200;
let roots = [];

function setExpandedFlag(path, on) {
  if (on) expanded.add(path); else expanded.delete(path);
  saveUi();
}

function renderRoots() {
  treeState.clear();
  el.treeRoot.innerHTML = '';
  for (const p of roots) addRootRow(p);
}

function addRootRow(path) {
  const stub = document.createElement('div');
  stub.className = 'tree-stub';
  stub.textContent = path + ' — loading…';
  stub.dataset.rootPath = path;
  el.treeRoot.appendChild(stub);
  const id = 'root:' + path;
  treeState.set(id, { _root: true, path, stub });
  vscode.postMessage({ type: 'getPath', path, watchId: id });
}

function unpinRoot(path) {
  vscode.postMessage({ type: 'unpin', path });
}

function pinRoot(path) {
  if (!path) return;
  if (roots.includes(path)) {
    const wrap = el.treeRoot.querySelector('[data-path="' + CSS.escape(path) + '"]');
    if (wrap && wrap._expand) wrap._expand();
    if (wrap) wrap.scrollIntoView({ block: 'nearest' });
    return;
  }
  vscode.postMessage({ type: 'pin', path });
}

function makeAction(icon, title, onClick, extraClass) {
  const b = document.createElement('button');
  b.textContent = icon;
  b.title = title;
  if (extraClass) b.className = extraClass;
  b.onclick = e => { e.stopPropagation(); onClick(e); };
  return b;
}

function treeRow(key, typ, preview, path, isRoot) {
  const wrapper = document.createElement('div');
  wrapper.dataset.filterKey = key.toLowerCase();
  wrapper.dataset.path = path;
  if (isRoot) wrapper.classList.add('tree-root-wrapper');

  const row = document.createElement('div');
  row.className = 'tree-row';

  const caret = document.createElement('span');
  caret.className = 'tree-caret';
  caret.textContent = typ === 'table' ? '▸ ' : '\u00a0\u00a0';
  row.appendChild(caret);

  const keySpan = document.createElement('span');
  keySpan.className = 'tree-key';
  keySpan.textContent = (isRoot ? path : key) + ' ';
  row.appendChild(keySpan);

  const badge = document.createElement('span');
  badge.className = 'tree-badge ' + typ;
  badge.textContent = typ;
  row.appendChild(badge);

  let currentPreview = preview;
  const previewSpan = document.createElement('span');
  previewSpan.className = 'tree-preview' + (connected && EDITABLE_TYPES.has(typ) ? ' editable' : '');
  previewSpan.textContent = currentPreview ? ' = ' + currentPreview : '';

  if (connected && EDITABLE_TYPES.has(typ)) {
    previewSpan.title = 'Click to edit';
    previewSpan.onclick = e => {
      e.stopPropagation();
      const input = document.createElement('input');
      input.className = 'tree-edit-input';
      input.value = currentPreview || '';
      const commit = rawVal => {
        if (rawVal === null) { previewSpan.textContent = currentPreview ? ' = ' + currentPreview : ''; row.replaceChild(previewSpan, input); return; }
        let parsed = rawVal;
        if (rawVal === 'true') parsed = true;
        else if (rawVal === 'false') parsed = false;
        else if (rawVal !== '' && !isNaN(Number(rawVal))) parsed = Number(rawVal);
        currentPreview = String(rawVal);
        previewSpan.textContent = ' = ' + currentPreview;
        row.replaceChild(previewSpan, input);
        vscode.postMessage({ type: 'setPath', path, valueJson: JSON.stringify(parsed) });
      };
      input.onkeydown = ev => {
        if (ev.key === 'Enter') commit(input.value);
        if (ev.key === 'Escape') commit(null);
      };
      input.onblur = () => commit(null);
      row.replaceChild(input, previewSpan);
      input.focus(); input.select();
    };
  }
  row.appendChild(previewSpan);

  const children = document.createElement('div');
  children.className = 'tree-children';
  children.style.display = 'none';

  let loaded = false;
  let isOpen = false;
  let currentLimit = ROOT_DEFAULT_LIMIT;

  function fetchChildren(limit) {
    currentLimit = limit;
    const nodeId = 'n' + Math.random().toString(36).slice(2);
    treeState.set(nodeId, { container: children, path, wrapper });
    children.textContent = 'loading…';
    vscode.postMessage({ type: 'listChildren', path, nodeId, limit });
  }
  function expandRow() {
    if (typ !== 'table' || isOpen) return;
    isOpen = true;
    caret.textContent = '▾ ';
    children.style.display = 'block';
    if (typ === 'table') previewSpan.style.display = 'none';
    setExpandedFlag(path, true);
    if (!loaded) { loaded = true; fetchChildren(ROOT_DEFAULT_LIMIT); }
  }
  function collapseRow() {
    if (!isOpen) return;
    isOpen = false;
    caret.textContent = '▸ ';
    children.style.display = 'none';
    previewSpan.style.display = '';
    setExpandedFlag(path, false);
  }
  function refreshSubtree() {
    if (typ !== 'table') return;
    loaded = true;
    isOpen = true;
    caret.textContent = '▾ ';
    children.style.display = 'block';
    previewSpan.style.display = 'none';
    fetchChildren(currentLimit);
  }
  wrapper._expand = expandRow;
  wrapper._collapse = collapseRow;
  wrapper._refresh = refreshSubtree;

  const actions = document.createElement('div');
  actions.className = 'tree-actions';
  actions.appendChild(makeAction('⧉', 'Copy path', () => navigator.clipboard.writeText(path)));
  actions.appendChild(makeAction('▶', 'Eval in REPL', () => {
    el.replCode.value = 'return ' + path;
    runRepl();
  }));
  if (typ === 'table') {
    actions.appendChild(makeAction('⟳', 'Refresh subtree', () => refreshSubtree()));
  }
  if (isRoot) {
    actions.appendChild(makeAction('×', 'Unpin root', () => unpinRoot(path), 'unpin'));
  }
  row.appendChild(actions);

  wrapper.appendChild(row);
  wrapper.appendChild(children);

  if (typ === 'table') {
    row.style.cursor = 'pointer';
    row.onclick = e => {
      if (e.target.closest('.tree-actions')) return;
      if (isOpen) collapseRow(); else expandRow();
    };
  }

  return wrapper;
}

function handleChildren(msg) {
  const entry = treeState.get(msg.nodeId);
  treeState.delete(msg.nodeId);
  if (!entry) return;
  const container = entry.container;
  const parentPath = entry.path;
  container.innerHTML = '';
  if (msg.error) { container.textContent = 'error: ' + msg.error; return; }
  for (const c of msg.children) {
    const childPath = parentPath + (c.keyType === 'string' ? ('.' + c.key) : ('[' + c.key + ']'));
    const w = treeRow(c.key, c.type, c.preview, childPath, false);
    container.appendChild(w);
    if (expanded.has(childPath) && c.type === 'table') w._expand();
  }
  if (msg.truncated) {
    const more = document.createElement('div');
    more.className = 'tree-load-more';
    const shown = msg.children.length;
    const total = msg.total;
    more.textContent = '↓ load more (' + shown + (total ? ' of ' + total : '') + ')';
    more.onclick = () => {
      const limit = (msg.limit || ROOT_DEFAULT_LIMIT) + ROOT_DEFAULT_LIMIT;
      const nodeId = 'n' + Math.random().toString(36).slice(2);
      treeState.set(nodeId, { container, path: parentPath, wrapper: entry.wrapper });
      container.innerHTML = '';
      container.textContent = 'loading…';
      vscode.postMessage({ type: 'listChildren', path: parentPath, nodeId, limit });
    };
    container.appendChild(more);
  }
  applyFilter(container, el.treeFilter.value.toLowerCase());
}

function applyFilter(container, q) {
  for (const wrapper of container.children) {
    if (!wrapper.dataset || wrapper.dataset.filterKey === undefined) continue;
    const match = !q || wrapper.dataset.filterKey.includes(q);
    wrapper.style.display = match ? '' : 'none';
    const sub = wrapper.querySelector(':scope > .tree-children');
    if (sub && sub.style.display !== 'none') applyFilter(sub, q);
  }
}

el.treeFilter.addEventListener('input', () => {
  applyFilter(el.treeRoot, el.treeFilter.value.toLowerCase());
});

el.treePinBtn.onclick = () => {
  const v = el.treePath.value.trim();
  if (!v) return;
  pinRoot(v);
  el.treePath.value = '';
};
el.treePath.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); el.treePinBtn.click(); }
});

el.treeRefreshBtn.onclick = () => {
  if (connected) vscode.postMessage({ type: 'rescan' });
  else renderRoots();
};

// --- log pane ---
function appendLog(line) {
  const d = document.createElement('div');
  d.className = 'log-line ' + (line.level || 'INFO');
  const name = line.name ? '[' + line.name + '] ' : '';
  d.textContent = '[' + (line.level || 'INFO') + '] ' + name + line.text;
  el.logPane.appendChild(d);
  while (el.logPane.childElementCount > ${MAX_LOG_LINES}) el.logPane.removeChild(el.logPane.firstChild);
  el.logPane.scrollTop = el.logPane.scrollHeight;
}

// --- profiler ---
el.profToggleBtn.onclick = () => vscode.postMessage({ type: 'profilerToggle' });

function setProfState(running) {
  el.profToggleBtn.textContent = running ? 'Stop' : 'Start';
  el.profStatus.textContent = running ? 'running' : 'idle';
}

function renderProfReport(report) {
  el.profReport.innerHTML = '';
  if (!report) {
    const empty = document.createElement('div');
    empty.style.cssText = 'color:var(--vscode-descriptionForeground);padding:4px;';
    empty.textContent = '(no profiler output — too few samples or profiler stopped immediately)';
    el.profReport.appendChild(empty);
    return;
  }
  // L1: "  5% path/to/file:123 (Lua/GC)"
  // L2: "     42 path/to/file:456 (Lua)"
  const lines = report.split('\\n');
  let matched = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    const l1 = line.match(/^\\s*(\\d+)%\\s+(.+?)\\s+\\(([^)]+)\\)\\s*$/);
    const l2 = line.match(/^\\s+(\\d+)\\s+(.+?)\\s+\\(([^)]+)\\)\\s*$/);
    if (l1 || l2) matched++;
    if (l1) {
      const pct = parseInt(l1[1], 10);
      const loc = l1[2];
      const vm  = l1[3];
      const row = document.createElement('div');
      row.className = 'prof-row';
      const pctEl = document.createElement('span');
      pctEl.className = 'prof-pct';
      pctEl.textContent = pct + '%';
      const barWrap = document.createElement('div');
      barWrap.className = 'prof-bar-wrap';
      const bar = document.createElement('div');
      bar.className = 'prof-bar ' + (pct >= 20 ? 'hot' : pct >= 10 ? 'warm' : pct >= 5 ? 'mild' : 'cool');
      bar.style.width = Math.min(pct, 100) + '%';
      barWrap.appendChild(bar);
      const locEl = document.createElement('span');
      locEl.className = 'prof-loc';
      locEl.title = loc;
      locEl.textContent = loc;
      const vmEl = document.createElement('span');
      vmEl.className = 'prof-vm';
      vmEl.textContent = vm;
      row.appendChild(pctEl);
      row.appendChild(barWrap);
      row.appendChild(locEl);
      row.appendChild(vmEl);
      el.profReport.appendChild(row);
    } else if (l2) {
      const count = l2[1];
      const loc   = l2[2];
      const vm    = l2[3];
      const row = document.createElement('div');
      row.className = 'prof-row l2';
      const cntEl = document.createElement('span');
      cntEl.className = 'prof-pct';
      cntEl.textContent = count;
      const locEl = document.createElement('span');
      locEl.className = 'prof-loc';
      locEl.title = loc;
      locEl.textContent = loc;
      const vmEl = document.createElement('span');
      vmEl.className = 'prof-vm';
      vmEl.textContent = vm;
      row.appendChild(cntEl);
      row.appendChild(locEl);
      row.appendChild(vmEl);
      el.profReport.appendChild(row);
    }
  }
  if (matched === 0) {
    // Vanilla profiler returns a different format — show raw.
    const pre = document.createElement('pre');
    pre.style.cssText = 'margin:0;white-space:pre;overflow-x:auto;font-family:var(--vscode-editor-font-family);font-size:11px;';
    pre.textContent = report;
    el.profReport.appendChild(pre);
  }
}

// --- perf overlay ---
el.perfToggleBtn.onclick = () => vscode.postMessage({ type: 'perfToggle' });

function setPerfState(enabled) {
  el.perfToggleBtn.textContent = enabled ? 'Disable' : 'Enable';
  el.perfStatus.textContent = enabled ? 'on' : 'off';
}

function perfSectionOpen() {
  return !document.getElementById('sec-perf').classList.contains('collapsed');
}

function fpsClass(fps) {
  if (fps >= 55) return 'fps-hot';
  if (fps >= 30) return 'fps-warm';
  return 'fps-cool';
}

function renderPerfStats(stats) {
  el.perfErr.style.display = 'none';
  const rows = [
    ['FPS', stats.fps.toFixed(0), fpsClass(stats.fps)],
    ['Frame', stats.frameTimeMs.toFixed(2) + ' ms', ''],
    ['Lua mem', (stats.memKb / 1024).toFixed(2) + ' MB', ''],
    ['Draw calls', String(stats.drawCalls), ''],
    ['Texture mem', stats.textureMemMb.toFixed(2) + ' MB', ''],
  ];
  el.perfStats.innerHTML = '';
  for (const [k, v, cls] of rows) {
    const keyEl = document.createElement('div');
    keyEl.className = 'k';
    keyEl.textContent = k;
    const valEl = document.createElement('div');
    valEl.className = 'v' + (cls ? ' ' + cls : '');
    valEl.textContent = v;
    el.perfStats.appendChild(keyEl);
    el.perfStats.appendChild(valEl);
  }

  const queues = stats.eventQueues || {};
  const queueNames = Object.keys(queues).sort();
  if (queueNames.length === 0) {
    el.perfQueues.style.display = 'none';
  } else {
    el.perfQueues.style.display = '';
    el.perfQueues.innerHTML = '';
    const title = document.createElement('div');
    title.className = 'perf-queues-title';
    title.textContent = 'Event queues';
    el.perfQueues.appendChild(title);
    for (const name of queueNames) {
      const row = document.createElement('div');
      row.className = 'perf-queue-row';
      const k = document.createElement('span');
      k.textContent = name;
      const v = document.createElement('span');
      v.textContent = String(queues[name]);
      row.appendChild(k);
      row.appendChild(v);
      el.perfQueues.appendChild(row);
    }
  }
}

function renderPerfErr(err) {
  el.perfErr.style.display = '';
  el.perfErr.textContent = String(err);
}

setInterval(() => {
  if (!connected) return;
  if (!perfSectionOpen()) return;
  vscode.postMessage({ type: 'perfStats' });
}, 500);

// --- save states ---
function renderSaveSlots(slots) {
  el.saveGrid.innerHTML = '';
  for (const s of slots) {
    const cell = document.createElement('div');
    cell.className = 'save-slot';
    const label = document.createElement('div');
    label.className = 'save-slot-label' + (s.exists ? ' exists' : '');
    label.textContent = 'Slot ' + s.slot + (s.exists ? '' : ' (empty)');
    const saveBtn = document.createElement('button');
    saveBtn.textContent = 'Save';
    saveBtn.disabled = !connected;
    saveBtn.onclick = () => vscode.postMessage({ type: 'saveStateSave', slot: s.slot });
    const loadBtn = document.createElement('button');
    loadBtn.className = 'secondary';
    loadBtn.textContent = 'Load';
    loadBtn.disabled = !connected || !s.exists;
    loadBtn.onclick = () => vscode.postMessage({ type: 'saveStateLoad', slot: s.slot });
    cell.appendChild(label);
    cell.appendChild(saveBtn);
    cell.appendChild(loadBtn);
    el.saveGrid.appendChild(cell);
  }
}

el.savesRefreshBtn.onclick = () => vscode.postMessage({ type: 'saveStateList' });

document.getElementById('sec-saves').querySelector('header').addEventListener('click', () => {
  vscode.postMessage({ type: 'saveStateList' });
}, { once: false });

// --- messages ---
window.addEventListener('message', e => {
  const m = e.data;
  switch (m.type) {
    case 'init':
      setConnected(m.connected);
      setPaused(m.paused);
      roots = m.roots || [];
      for (const line of (m.logs || [])) appendLog(line);
      renderRoots();
      if (m.profilerRunning !== undefined) setProfState(m.profilerRunning);
      if (m.perfOverlay !== undefined) setPerfState(m.perfOverlay);
      break;
    case 'connected':
      setConnected(true);
      setPaused(false);
      renderRoots();
      if (m.profilerRunning !== undefined) setProfState(m.profilerRunning);
      if (m.perfOverlay !== undefined) setPerfState(m.perfOverlay);
      break;
    case 'roots':
      roots = m.roots || [];
      renderRoots();
      break;
    case 'disconnected':
      setConnected(false);
      break;
    case 'pauseState':
      setPaused(m.paused);
      break;
    case 'evalResult':
      if (m.ok) {
        const pretty = (m.result && m.result.pretty) || '';
        appendReplEntry('ok', pretty || '(no value)');
      } else {
        appendReplEntry('err', String(m.error));
      }
      break;
    case 'children':
      handleChildren(m);
      break;
    case 'watchValue': {
      const pending = treeState.get(m.watchId);
      if (pending && pending._root) {
        treeState.delete(m.watchId);
        if (m.error) {
          pending.stub.classList.add('err');
          pending.stub.textContent = pending.path + ' — error: ' + m.error;
        } else {
          const wrap = treeRow(pending.path, m.value.type, m.value.pretty, pending.path, true);
          pending.stub.replaceWith(wrap);
          if (expanded.has(pending.path) && m.value.type === 'table') wrap._expand();
        }
      }
      break;
    }
    case 'log':
      appendLog(m.line);
      break;
    case 'profilerState':
      setProfState(m.running);
      if (m.report) renderProfReport(m.report);
      break;
    case 'perfOverlayState':
      setPerfState(m.enabled);
      break;
    case 'perfStats':
      if (m.error) renderPerfErr(m.error);
      else if (m.stats) renderPerfStats(m.stats);
      break;
    case 'saveSlots':
      renderSaveSlots(m.slots);
      break;
    case 'toast': {
      const t = document.createElement('div');
      t.className = 'toast';
      t.textContent = m.text;
      document.body.appendChild(t);
      setTimeout(() => t.remove(), 4000);
      break;
    }
  }
});

vscode.postMessage({ type: 'ready' });
</script></body></html>`;
  }
}

export function registerDebugView(
  context: vscode.ExtensionContext,
  agent: DebugAgent
): void {
  const provider = new DebugViewProvider(context, agent);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('smodsDebugView', provider)
  );
}
