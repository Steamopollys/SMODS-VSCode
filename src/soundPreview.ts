import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { findMatchingBrace, getModRootForDocument } from './modUtils';

interface SoundDef {
  key: string;
  path: string;
  range: vscode.Range;
}

interface PlayCall {
  key: string;
  pitch?: number;
  volume?: number;
  range: vscode.Range;
}

function findSoundBlocks(doc: vscode.TextDocument): SoundDef[] {
  const out: SoundDef[] = [];
  const text = doc.getText();
  const re = /SMODS\.Sound\s*[({]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const brace = text.indexOf('{', m.index);
    if (brace === -1) { continue; }
    const close = findMatchingBrace(text, brace);
    if (close === -1) { continue; }
    const body = text.slice(brace, close + 1);
    const key = /\bkey\s*=\s*['"]([^'"]+)['"]/.exec(body)?.[1];
    const p = /\bpath\s*=\s*['"]([^'"]+)['"]/.exec(body)?.[1];
    if (!key || !p) { continue; }
    const range = new vscode.Range(
      doc.positionAt(m.index),
      doc.positionAt(m.index + 'SMODS.Sound'.length)
    );
    out.push({ key, path: p, range });
  }
  return out;
}

function findPlayCalls(doc: vscode.TextDocument): PlayCall[] {
  const out: PlayCall[] = [];
  const text = doc.getText();
  const re = /\bplay_sound\s*\(\s*['"]([^'"]+)['"](?:\s*,\s*([\d.]+))?(?:\s*,\s*([\d.]+))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const range = new vscode.Range(
      doc.positionAt(m.index),
      doc.positionAt(m.index + 'play_sound'.length)
    );
    out.push({
      key: m[1],
      pitch: m[2] ? Number(m[2]) : undefined,
      volume: m[3] ? Number(m[3]) : undefined,
      range,
    });
  }
  return out;
}

function resolveSoundPath(modRoot: string, p: string): string | undefined {
  const candidates = [
    path.join(modRoot, 'assets', 'sounds', p),
    path.join(modRoot, 'sounds', p),
    path.join(modRoot, p),
  ];
  return candidates.find(c => fs.existsSync(c));
}

// Balatro built-in sounds. Valid via `play_sound('<basename>', ...)` without registration.
const BUILTIN_SOUNDS = new Set([
  'ambientFire1', 'ambientFire2', 'ambientFire3', 'ambientOrgan1',
  'button', 'cancel', 'card1', 'card3', 'cardFan2', 'cardSlide1', 'cardSlide2',
  'chips1', 'chips2',
  'coin1', 'coin2', 'coin3', 'coin4', 'coin5', 'coin6', 'coin7',
  'crumple1', 'crumple2', 'crumple3', 'crumple4', 'crumple5',
  'crumpleLong1', 'crumpleLong2',
  'explosion1', 'explosion_buildup1', 'explosion_release1',
  'foil1', 'foil2', 'generic1',
  'glass1', 'glass2', 'glass3', 'glass4', 'glass5', 'glass6',
  'gold_seal', 'gong',
  'highlight1', 'highlight2', 'holo1',
  'introPad1',
  'magic_crumple', 'magic_crumple2', 'magic_crumple3',
  'multhit1', 'multhit2',
  'music1', 'music2', 'music3', 'music4', 'music5',
  'negative', 'other1', 'paper1', 'polychrome1',
  'slice1', 'splash_buildup',
  'tarot1', 'tarot2', 'timpani',
  'voice1', 'voice2', 'voice3', 'voice4', 'voice5',
  'voice6', 'voice7', 'voice8', 'voice9', 'voice10', 'voice11',
  'whoosh', 'whoosh1', 'whoosh2', 'whoosh_long', 'win',
]);

function resolveBuiltinSound(key: string): string | undefined {
  if (!BUILTIN_SOUNDS.has(key)) { return undefined; }
  const baseSrc = vscode.workspace.getConfiguration('smods')
    .get<string>('balatroSourcePath', '').trim();
  if (!baseSrc) { return undefined; }
  const candidates = [
    path.join(baseSrc, 'resources', 'sounds', `${key}.ogg`),
    path.join(baseSrc, 'sounds', `${key}.ogg`),
  ];
  return candidates.find(c => fs.existsSync(c));
}

interface SoundIndex {
  at: number;
  byKey: Map<string, { absPath: string }>;
}

const SOUND_INDEX_TTL = 30_000;
const soundIndexCache = new Map<string, SoundIndex>();

function loadSoundIndex(modRoot: string): SoundIndex {
  const hit = soundIndexCache.get(modRoot);
  if (hit && Date.now() - hit.at < SOUND_INDEX_TTL) { return hit; }
  const byKey = new Map<string, { absPath: string }>();
  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) { continue; }
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!e.name.endsWith('.lua')) { continue; }
      let text: string;
      try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }
      const re = /SMODS\.Sound\s*[({]\s*\{?([\s\S]*?)\}/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        const body = m[1];
        const key = /\bkey\s*=\s*['"]([^'"]+)['"]/.exec(body)?.[1];
        const p = /\bpath\s*=\s*['"]([^'"]+)['"]/.exec(body)?.[1];
        if (!key || !p) { continue; }
        const abs = resolveSoundPath(modRoot, p);
        if (abs && !byKey.has(key)) { byKey.set(key, { absPath: abs }); }
      }
    }
  }
  walk(modRoot);
  const idx = { at: Date.now(), byKey };
  soundIndexCache.set(modRoot, idx);
  return idx;
}

class SoundCodeLensProvider implements vscode.CodeLensProvider {
  private _onDid = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDid.event;
  refresh(): void { this._onDid.fire(); }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    if (doc.languageId !== 'lua') { return []; }
    const modRoot = getModRootForDocument(doc.uri);
    if (!modRoot) { return []; }
    const lenses: vscode.CodeLens[] = [];

    for (const def of findSoundBlocks(doc)) {
      const abs = resolveSoundPath(modRoot, def.path);
      lenses.push(new vscode.CodeLens(def.range, {
        title: abs
          ? `$(unmute) Preview sound "${def.key}"`
          : `$(warning) Sound file missing: "${def.path}"`,
        command: abs ? 'smods.previewSound' : '',
        arguments: abs ? [{ key: def.key, absPath: abs, modRoot }] : [],
      }));
    }

    const idx = loadSoundIndex(modRoot);
    for (const call of findPlayCalls(doc)) {
      const hit = idx.byKey.get(call.key);
      if (hit) {
        lenses.push(new vscode.CodeLens(call.range, {
          title: `$(unmute) Preview sound "${call.key}"`,
          command: 'smods.previewSound',
          arguments: [{ key: call.key, absPath: hit.absPath, modRoot, pitch: call.pitch, volume: call.volume }],
        }));
        continue;
      }
      if (BUILTIN_SOUNDS.has(call.key)) {
        const builtin = resolveBuiltinSound(call.key);
        lenses.push(new vscode.CodeLens(call.range, {
          title: builtin
            ? `$(unmute) Preview built-in sound "${call.key}"`
            : `$(info) Built-in sound "${call.key}" (set smods.balatroSourcePath to preview)`,
          command: builtin ? 'smods.previewSound' : '',
          arguments: builtin
            ? [{ key: call.key, absPath: builtin, modRoot, pitch: call.pitch, volume: call.volume }]
            : [],
        }));
        continue;
      }
      lenses.push(new vscode.CodeLens(call.range, {
        title: `$(warning) Sound "${call.key}" not registered`,
        command: '',
      }));
    }
    return lenses;
  }
}

interface PreviewArgs {
  key: string;
  absPath: string;
  modRoot: string;
  pitch?: number;
  volume?: number;
}

const openPanels = new Map<string, vscode.WebviewPanel>();

function openPreview(args: PreviewArgs): void {
  const existing = openPanels.get(args.absPath);
  if (existing) { existing.reveal(); return; }

  // Built-in sounds live outside modRoot — webview needs both directories whitelisted.
  const audioDir = path.dirname(args.absPath);
  const localResourceRoots = [
    vscode.Uri.file(args.modRoot),
    vscode.Uri.file(audioDir),
  ];
  const panel = vscode.window.createWebviewPanel(
    'smodsSound',
    `Sound: ${args.key}`,
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots,
    }
  );
  openPanels.set(args.absPath, panel);
  panel.onDidDispose(() => {
    openPanels.delete(args.absPath);
    panel.webview.postMessage({ type: 'cleanup' });
  });

  const audioUri = panel.webview.asWebviewUri(vscode.Uri.file(args.absPath));
  panel.webview.html = renderHtml(
    args.key,
    audioUri.toString(),
    path.basename(args.absPath),
    args.pitch ?? 1,
    args.volume ?? 1
  );
}

function renderHtml(
  key: string, src: string, basename: string, pitch: number, volume: number
): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin: 0; padding: 1em; font: 13px var(--vscode-font-family); color: var(--vscode-foreground); }
  h2 { margin: 0 0 0.4em 0; font-size: 14px; }
  .info { margin-bottom: 0.6em; color: var(--vscode-descriptionForeground); }
  .row { display: flex; gap: 0.6em; align-items: center; margin: 0.4em 0; flex-wrap: wrap; }
  .row label { min-width: 64px; color: var(--vscode-descriptionForeground); }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground);
           border: 1px solid var(--vscode-button-border, transparent); padding: 4px 10px; cursor: pointer; }
  button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  code { background: var(--vscode-textBlockQuote-background); padding: 2px 6px; border-radius: 3px;
         font: 11px var(--vscode-editor-font-family); }
  .status { color: var(--vscode-descriptionForeground); font-size: 11px; min-height: 1em; }
</style></head><body>
<h2>${key}</h2>
<div class="info">${basename}</div>
<div class="row"><button id="play" disabled>▶ Play</button><button id="stop" disabled>■ Stop</button><span class="status" id="status">loading…</span></div>
<div class="row"><label>pitch</label><input id="pitch" type="range" min="0.25" max="4" step="0.05" value="${pitch}"/><span id="pitchLbl">${pitch.toFixed(2)}</span>×</div>
<div class="row"><label>volume</label><input id="vol" type="range" min="0" max="1" step="0.01" value="${volume}"/><span id="volLbl">${volume.toFixed(2)}</span></div>
<div class="row"><label>loop</label><input id="loop" type="checkbox"/></div>
<div class="row"><label>snippet</label><code id="snip"></code><button id="copy">Copy</button></div>
<script>
const playBtn = document.getElementById('play');
const stopBtn = document.getElementById('stop');
const statusEl = document.getElementById('status');
const pitchEl = document.getElementById('pitch');
const pitchLbl = document.getElementById('pitchLbl');
const volEl = document.getElementById('vol');
const volLbl = document.getElementById('volLbl');
const loopEl = document.getElementById('loop');
const snipEl = document.getElementById('snip');
const copyBtn = document.getElementById('copy');

const ctx = new (window.AudioContext || window.webkitAudioContext)();
const masterGain = ctx.createGain();
masterGain.connect(ctx.destination);
let originalBuffer = null;
let currentSource = null;
let cachedPitch = NaN;
let cachedShifted = null;

// Granular pitch shifter: reads input at \`pitch\` rate inside each grain but advances
// output at the original hop. Duration preserved, pitch shifts. Not phase-aligned;
// sustained tones may show a flange-like artifact.
const GRAIN = 2048;
const HOP = GRAIN / 4;
const HANN = (() => {
  const w = new Float32Array(GRAIN);
  for (let i = 0; i < GRAIN; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / GRAIN);
  return w;
})();
const NORM = 2 / 3; // window-sum compensation at 75% overlap

function pitchShift(input, pitch) {
  if (Math.abs(pitch - 1) < 0.001) return input;
  const channels = input.numberOfChannels;
  const len = input.length;
  const out = ctx.createBuffer(channels, len, input.sampleRate);
  for (let c = 0; c < channels; c++) {
    const ib = input.getChannelData(c);
    const ob = out.getChannelData(c);
    for (let outBase = 0; outBase < len; outBase += HOP) {
      for (let i = 0; i < GRAIN; i++) {
        const outIdx = outBase + i;
        if (outIdx >= len) break;
        const inIdx = outBase + i * pitch;
        if (inIdx < 0 || inIdx >= len - 1) continue;
        const i0 = Math.floor(inIdx);
        const frac = inIdx - i0;
        const s = ib[i0] * (1 - frac) + ib[i0 + 1] * frac;
        ob[outIdx] += s * HANN[i] * NORM;
      }
    }
  }
  return out;
}

function getShiftedBuffer() {
  const p = Number(pitchEl.value);
  if (p === cachedPitch && cachedShifted) return cachedShifted;
  cachedShifted = pitchShift(originalBuffer, p);
  cachedPitch = p;
  return cachedShifted;
}

function stop() {
  if (currentSource) {
    try { currentSource.stop(); } catch (_) { /* already stopped */ }
    currentSource = null;
  }
  stopBtn.disabled = true;
  playBtn.textContent = '▶ Play';
}

function play() {
  if (!originalBuffer) return;
  stop();
  const buf = getShiftedBuffer();
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = loopEl.checked;
  src.connect(masterGain);
  src.onended = () => { if (currentSource === src) stop(); };
  src.start();
  currentSource = src;
  stopBtn.disabled = false;
  playBtn.textContent = '⏵ Replay';
}

playBtn.onclick = () => {
  if (ctx.state === 'suspended') ctx.resume();
  play();
};
stopBtn.onclick = stop;
pitchEl.oninput = () => {
  pitchLbl.textContent = Number(pitchEl.value).toFixed(2);
  // Buffer cache invalidated only when the slider lands on a new value; play() picks it up.
  cachedPitch = NaN;
  cachedShifted = null;
  updateSnippet();
};
volEl.oninput = () => {
  const v = Number(volEl.value);
  masterGain.gain.value = v;
  volLbl.textContent = v.toFixed(2);
  updateSnippet();
};
loopEl.onchange = () => {
  if (currentSource) currentSource.loop = loopEl.checked;
};
copyBtn.onclick = () => navigator.clipboard.writeText(snipEl.textContent);
window.addEventListener('message', e => {
  if (e.data && e.data.type === 'cleanup') {
    stop();
    ctx.close && ctx.close();
  }
});

function updateSnippet() {
  const p = Number(pitchEl.value).toFixed(2);
  const v = Number(volEl.value).toFixed(2);
  snipEl.textContent = "play_sound('${key}', " + p + ", " + v + ")";
}

(async () => {
  try {
    const resp = await fetch('${src}');
    const arr = await resp.arrayBuffer();
    originalBuffer = await ctx.decodeAudioData(arr);
    masterGain.gain.value = Number(volEl.value);
    statusEl.textContent = originalBuffer.duration.toFixed(2) + 's, ' +
      originalBuffer.numberOfChannels + 'ch, ' + originalBuffer.sampleRate + 'Hz';
    playBtn.disabled = false;
  } catch (err) {
    statusEl.textContent = 'load failed: ' + err.message;
  }
})();
updateSnippet();
</script></body></html>`;
}

export function registerSoundPreview(context: vscode.ExtensionContext): void {
  const provider = new SoundCodeLensProvider();
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider({ language: 'lua' }, provider),
    vscode.commands.registerCommand('smods.previewSound',
      (args: PreviewArgs) => openPreview(args)),
    vscode.workspace.onDidSaveTextDocument(d => {
      if (d.languageId === 'lua') {
        soundIndexCache.clear();
        provider.refresh();
      }
    })
  );
}
