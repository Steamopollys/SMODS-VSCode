import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { LogTailer } from './logTailer';

const LEVELS = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'] as const;
type Level = typeof LEVELS[number] | 'OTHER';

const LEVEL_RE = /^(TRACE|DEBUG|INFO|WARN|ERROR|FATAL)\b/i;

function classifyLevel(line: string): Level {
  const m = LEVEL_RE.exec(line.trimStart());
  if (!m) {return 'OTHER';}
  return m[1].toUpperCase() as Level;
}

class LogViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private buffer: { line: string; level: Level }[] = [];
  private readonly MAX = 5000;

  constructor(tailer: LogTailer) {
    tailer.onLine(line => this.push(line));
    tailer.onReset(() => {
      this.buffer = [];
      this.view?.webview.postMessage({ type: 'clear' });
    });
  }

  private push(line: string): void {
    const level = classifyLevel(line);
    this.buffer.push({ line, level });
    if (this.buffer.length > this.MAX) {
      this.buffer.splice(0, this.buffer.length - this.MAX);
    }
    this.view?.webview.postMessage({ type: 'line', line, level });
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage(async msg => {
      if (msg.type === 'openFile') {await this.openFile(msg.file, msg.line);}
      else if (msg.type === 'start') {
        await vscode.commands.executeCommand('smods.showLog');
      } else if (msg.type === 'clear') {
        this.buffer = [];
      } else if (msg.type === 'ready') {
        view.webview.postMessage({ type: 'batch', lines: this.buffer });
      }
    });
  }

  private async openFile(file: string, line: number): Promise<void> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const candidates = [file];
    for (const f of folders) {
      candidates.push(path.join(f.uri.fsPath, file));
      candidates.push(path.join(f.uri.fsPath, path.basename(file)));
    }
    const hit = candidates.find(p => { try { return fs.existsSync(p); } catch { return false; } });
    if (!hit) {
      vscode.window.showWarningMessage(`Could not resolve ${file}`);
      return;
    }
    const doc = await vscode.workspace.openTextDocument(hit);
    const editor = await vscode.window.showTextDocument(doc);
    const pos = new vscode.Position(Math.max(0, line - 1), 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos));
  }

  private html(_webview: vscode.Webview): string {
    return `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin: 0; padding: 0; font: 12px var(--vscode-editor-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
  .toolbar { position: sticky; top: 0; background: var(--vscode-sideBar-background); padding: 4px 6px; border-bottom: 1px solid var(--vscode-panel-border); display: flex; gap: 6px; flex-wrap: wrap; align-items: center; z-index: 2; }
  .chip { user-select: none; padding: 2px 6px; border-radius: 9px; cursor: pointer; border: 1px solid var(--vscode-panel-border); background: transparent; }
  .chip.on { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .chip[data-level="ERROR"].on, .chip[data-level="FATAL"].on { background: #c33; }
  .chip[data-level="WARN"].on { background: #c83; }
  .chip[data-level="INFO"].on { background: #379; }
  .chip[data-level="DEBUG"].on { background: #666; }
  input.q { flex: 1; min-width: 80px; padding: 2px 4px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); }
  button.act { padding: 2px 8px; }
  #lines { padding: 4px 6px; white-space: pre-wrap; word-break: break-word; }
  .line { padding: 1px 2px; border-left: 3px solid transparent; }
  .line.ERROR, .line.FATAL { border-color: #e55; color: #f88; }
  .line.WARN { border-color: #e93; color: #fc9; }
  .line.INFO { border-color: #39c; }
  .line.DEBUG { border-color: #777; color: var(--vscode-descriptionForeground); }
  .line a { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: underline; }
  .hidden { display: none; }
</style></head><body>
<div class="toolbar">
  ${LEVELS.map(l => `<span class="chip on" data-level="${l}">${l}</span>`).join('')}
  <span class="chip on" data-level="OTHER">OTHER</span>
  <input class="q" placeholder="filter…" id="q" />
  <button class="act" id="start">Tail</button>
  <button class="act" id="clear">Clear</button>
  <label><input type="checkbox" id="follow" checked /> follow</label>
</div>
<div id="lines"></div>
<script>
const vscode = acquireVsCodeApi();
const linesEl = document.getElementById('lines');
const followCb = document.getElementById('follow');
const q = document.getElementById('q');

// ── Restore persisted filter state ──────────────────────────────────────────
const _state = vscode.getState() || {};
const enabled = new Set(_state.enabled ?? ${JSON.stringify([...LEVELS, 'OTHER'])});
if (_state.query) { q.value = _state.query; }
if (_state.follow === false) { followCb.checked = false; }

function saveState() {
  vscode.setState({ enabled: [...enabled], query: q.value, follow: followCb.checked });
}

// ── Chip filter buttons ──────────────────────────────────────────────────────
for (const c of document.querySelectorAll('.chip')) {
  const lv = c.dataset.level;
  if (!enabled.has(lv)) { c.classList.remove('on'); }
  c.onclick = () => {
    if (enabled.has(lv)) { enabled.delete(lv); c.classList.remove('on'); }
    else { enabled.add(lv); c.classList.add('on'); }
    saveState();
    applyFilters();
  };
}
q.oninput = () => { saveState(); applyFilters(); };
followCb.onchange = saveState;
document.getElementById('start').onclick = () => vscode.postMessage({ type: 'start' });
document.getElementById('clear').onclick = () => {
  vscode.postMessage({ type: 'clear' });
  linesEl.innerHTML = '';
};

function escapeHtml(s) {
  return s.replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'})[c]);
}
function linkify(s) {
  return s.replace(/([A-Za-z]:[\\\\/][^\\s:'"]+|[/\\\\]?[\\w./\\\\-]+\\.lua):(\\d+)/g,
    (m, f, l) => '<a data-file="' + f + '" data-line="' + l + '">' + f + ':' + l + '</a>');
}
function applyFilters() {
  const query = q.value.toLowerCase();
  for (const el of linesEl.children) {
    const lv = el.dataset.level ?? 'OTHER';
    const txt = (el.dataset.raw ?? '').toLowerCase();
    const visible = enabled.has(lv) && (!query || txt.includes(query));
    el.classList.toggle('hidden', !visible);
  }
}

linesEl.addEventListener('click', e => {
  const a = e.target.closest('a[data-file]');
  if (!a) return;
  vscode.postMessage({ type: 'openFile', file: a.dataset.file, line: Number(a.dataset.line) });
});

function appendLine(line, level) {
  const d = document.createElement('div');
  d.className = 'line ' + level;
  d.dataset.level = level;
  d.dataset.raw = line;
  d.innerHTML = linkify(escapeHtml(line));
  const query = q.value.toLowerCase();
  if (!enabled.has(level) || (query && !line.toLowerCase().includes(query))) {
    d.classList.add('hidden');
  }
  linesEl.appendChild(d);
}

window.addEventListener('message', e => {
  const m = e.data;
  if (m.type === 'line') {
    appendLine(m.line, m.level);
    if (followCb.checked) linesEl.lastChild.scrollIntoView({ block: 'end' });
  } else if (m.type === 'batch') {
    for (const b of m.lines) appendLine(b.line, b.level);
    if (followCb.checked && linesEl.lastChild) linesEl.lastChild.scrollIntoView({ block: 'end' });
  } else if (m.type === 'clear') {
    linesEl.innerHTML = '';
  }
});

vscode.postMessage({ type: 'ready' });
</script></body></html>`;
  }
}

export function registerLogView(
  context: vscode.ExtensionContext,
  tailer: LogTailer
): void {
  const provider = new LogViewProvider(tailer);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('smodsLogView', provider)
  );
}
