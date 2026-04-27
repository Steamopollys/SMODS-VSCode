import * as vscode from 'vscode';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { findMatchingBrace, getModRootForDocument } from './modUtils';
import { DebugAgent } from './debugAgent';

interface ShaderRef {
  key: string;
  path: string;
  range: vscode.Range;
}

function findShaderBlocks(doc: vscode.TextDocument): ShaderRef[] {
  const text = doc.getText();
  const out: ShaderRef[] = [];
  const re = /SMODS\.Shader\s*[({]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const brace = text.indexOf('{', m.index);
    if (brace === -1) { continue; }
    const close = findMatchingBrace(text, brace);
    if (close === -1) { continue; }
    const body = text.slice(brace, close + 1);
    const key = /\bkey\s*=\s*['"]([^'"]+)['"]/.exec(body)?.[1];
    const p   = /\bpath\s*=\s*['"]([^'"]+)['"]/.exec(body)?.[1];
    if (!key || !p) { continue; }
    const range = new vscode.Range(
      doc.positionAt(m.index),
      doc.positionAt(m.index + 'SMODS.Shader'.length)
    );
    out.push({ key, path: p, range });
  }
  return out;
}

// SMODS resolves SMODS.Shader{ path = '...' } against `<modRoot>/assets/shaders/<path>`
// (see smods/src/game_object.lua:3376-3387). Match that, falling back to a few legacy
// layouts so older or in-flight projects still light up the lens.
function resolveShaderPath(modRoot: string, relPath: string): string | undefined {
  const candidates = [
    path.join(modRoot, 'assets', 'shaders', relPath),
    path.join(modRoot, 'shaders', relPath),
    path.join(modRoot, relPath),
  ];
  return candidates.find(c => fs.existsSync(c));
}

class ShaderCodeLensProvider implements vscode.CodeLensProvider {
  private _onDid = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDid.event;
  refresh(): void { this._onDid.fire(); }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    if (doc.languageId === 'lua') {
      const modRoot = getModRootForDocument(doc.uri);
      if (!modRoot) { return []; }
      return findShaderBlocks(doc).map(s => {
        const abs = resolveShaderPath(modRoot, s.path);
        const exists = abs !== undefined;
        return new vscode.CodeLens(s.range, {
          title: exists
            ? `$(symbol-color) Preview shader "${s.key}"`
            : `$(warning) Shader file missing: "${s.path}"`,
          command: exists ? 'smods.previewShader' : '',
          arguments: exists ? [{ docUri: doc.uri.toString(), shaderKey: s.key, shaderPath: abs! }] : []
        });
      });
    }
    if (doc.fileName.toLowerCase().endsWith('.fs')) {
      const range = new vscode.Range(0, 0, 0, 0);
      return [new vscode.CodeLens(range, {
        title: '$(symbol-color) Preview shader',
        command: 'smods.previewShader',
        arguments: [{
          docUri: doc.uri.toString(),
          shaderKey: path.basename(doc.fileName, '.fs'),
          shaderPath: doc.uri.fsPath
        }]
      })];
    }
    return [];
  }
}

interface PreviewArgs {
  docUri: string;
  shaderKey: string;
  shaderPath: string;
}

const openPanels = new Map<string, vscode.WebviewPanel>();

async function openPreview(
  context: vscode.ExtensionContext,
  agent: DebugAgent,
  args: PreviewArgs,
  output: vscode.LogOutputChannel
): Promise<void> {
  const existing = openPanels.get(args.shaderPath);
  if (existing) {
    existing.reveal();
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    'smodsShader',
    `Shader: ${args.shaderKey}`,
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode.Uri.file(path.dirname(args.shaderPath)),
        vscode.Uri.file(context.extensionPath)
      ]
    }
  );
  openPanels.set(args.shaderPath, panel);
  panel.onDidDispose(() => openPanels.delete(args.shaderPath));

  const cardImageUri = panel.webview.asWebviewUri(
    vscode.Uri.file(path.join(context.extensionPath, 'media', 'sample-card.png'))
  ).toString();

  const sendSource = async (): Promise<void> => {
    let source = '';
    try { source = await fsp.readFile(args.shaderPath, 'utf8'); }
    catch (err) { output.warn(`Could not read shader: ${err}`); }
    panel.webview.postMessage({
      type: 'source',
      source,
      connected: agent.isConnected,
      cardImageUri
    });
  };

  panel.webview.html = renderHtml();
  // Send initial source after webview is ready
  panel.webview.onDidReceiveMessage(async msg => {
    if (msg.type === 'ready') { await sendSource(); return; }
    if (msg.type === 'sendToBalatro') {
      if (!agent.isConnected) {
        vscode.window.showWarningMessage('Debug bridge not connected. Launch Balatro with Debug Mode armed first.');
        return;
      }
      // Slot key in G.SHADERS must match the user's `extern vec2 <key>;` because
      // Sprite:draw_shader sends the per-frame animation pair under the shader name.
      const userKey = (args.shaderKey || 'tmp').replace(/[^A-Za-z0-9_]/g, '_');
      // Real-world shaders deviate from the convention (e.g. `extern vec2 ionized` in
      // a shader keyed `false_glow`). Hand the bridge every parsed vec2 extern so it
      // pcalls a send to each at draw time, covering whichever name is actually live.
      const STANDARD_VEC2 = new Set(['texture_pixel_size', 'image_details', 'mouse_screen_pos']);
      const externRe = /extern\s+(?:[A-Za-z_][A-Za-z0-9_]*\s+)?vec2\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/g;
      const vec2Names = new Set<string>();
      for (let m: RegExpExecArray | null; (m = externRe.exec(msg.source as string)); ) {
        if (!STANDARD_VEC2.has(m[1])) { vec2Names.add(m[1]); }
      }
      try {
        const res = await agent.applyPreviewShader({
          source: msg.source as string,
          userKey,
          vec2Names: Array.from(vec2Names),
        });
        vscode.window.showInformationMessage(`Shader applied to ${res.label}`);
      } catch (err) {
        vscode.window.showErrorMessage(`Shader apply failed: ${err}`);
      }
    }
  });

  // Reload when shader file saves
  const fileWatcher = vscode.workspace.onDidSaveTextDocument(doc => {
    if (doc.uri.fsPath === args.shaderPath) { void sendSource(); }
  });
  panel.onDidDispose(() => fileWatcher.dispose());

  // Reflect debug-bridge connect/disconnect into the panel
  const onConnect = agent.onDidConnect(() =>
    panel.webview.postMessage({ type: 'bridge', connected: true }));
  const onDisconnect = agent.onDidDisconnect(() =>
    panel.webview.postMessage({ type: 'bridge', connected: false }));
  panel.onDidDispose(() => { onConnect.dispose(); onDisconnect.dispose(); });
}

function renderHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<style>
  body { margin: 0; padding: 1em; font: 13px var(--vscode-font-family); color: var(--vscode-foreground);
         display: grid; grid-template-rows: auto auto 1fr auto; gap: 0.6em; height: 100vh; box-sizing: border-box; }
  .controls { display: flex; flex-wrap: wrap; gap: 0.8em; align-items: center; }
  .controls > * { white-space: nowrap; }
  .uniforms { display: flex; flex-wrap: wrap; gap: 0.4em 1.2em; align-items: center;
              border-top: 1px solid var(--vscode-panel-border); padding-top: 0.4em; min-height: 0; }
  .uniforms:empty { display: none; }
  .uniforms .row { display: flex; gap: 0.3em; align-items: center; }
  .uniforms label { color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family); font-size: 11px; }
  .uniforms input[type="range"] { width: 90px; }
  .uniforms input[type="number"] { width: 60px; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground);
           border: 1px solid var(--vscode-button-border, transparent); padding: 4px 10px; cursor: pointer; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
  .stage { display: flex; gap: 1em; align-items: flex-start; min-height: 0; }
  canvas { background:
    repeating-conic-gradient(#222 0% 25%, #333 0% 50%) 0 0/16px 16px;
    image-rendering: pixelated; border: 1px solid var(--vscode-panel-border); }
  .errors { background: var(--vscode-textBlockQuote-background); color: var(--vscode-errorForeground);
            font: 11px/1.4 var(--vscode-editor-font-family); white-space: pre-wrap;
            padding: 0.6em; min-height: 1.2em; border-radius: 3px; overflow: auto; max-height: 30vh; }
  .errors:empty::before { content: 'No errors.'; color: var(--vscode-descriptionForeground); font-style: italic; }
  .badge { font-size: 11px; padding: 2px 6px; border-radius: 3px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .badge.live { background: #2a7; color: #fff; }
</style></head><body>
<div class="controls">
  <span>fps: <input id="fps" type="range" min="10" max="60" value="60"/> <span id="fpsLabel">60</span></span>
  <span title="Multiplier on the rate realTime advances. 1× matches Balatro's G.TIMERS.REAL. Affects every ↻-ticked uniform.">speed: <input id="speed" type="range" min="0" max="4" step="0.05" value="1"/> <span id="speedLabel">1.00×</span></span>
  <span>sprite: <select id="sprite">
    <option value="card">Card</option>
    <option value="grid">Test grid (128×128)</option>
  </select></span>
  <span>scale: <input id="scale" type="range" min="1" max="6" value="3"/></span>
  <span class="badge" id="bridge">bridge: ?</span>
  <button id="push" disabled title="Compile this shader and apply it to the card currently focused in-game (mouse hover or controller focus). Only that one card is affected.">Apply to Selected Card</button>
</div>
<div class="uniforms" id="uniforms"></div>
<div class="stage">
  <canvas id="cv" width="71" height="95"></canvas>
</div>
<pre class="errors" id="errors"></pre>
<script>
const vscode = acquireVsCodeApi();
const cv = document.getElementById('cv');
const gl = cv.getContext('webgl', { premultipliedAlpha: false, antialias: false });
const errors = document.getElementById('errors');
const fpsEl = document.getElementById('fps');
const speedEl = document.getElementById('speed');
const speedLabel = document.getElementById('speedLabel');
// Balatro's fallback card-ID seed when a card has no ID. Hardcoded — no UI exposure.
const CARD_ID_SEED = 12.5123152;
const fpsLabel = document.getElementById('fpsLabel');
const spriteEl = document.getElementById('sprite');
const scaleEl = document.getElementById('scale');
const bridgeEl = document.getElementById('bridge');
const pushBtn = document.getElementById('push');
const uniformsEl = document.getElementById('uniforms');

// These uniforms are driven by the preview itself (see draw()) — never expose sliders.
// \`time\` gets a special readout row (Balatro formula \`123.33412 * (ID/1.14212) % 3000\`,
// driven by the global card-ID input — per-card constant, not a real-time accumulator).
const RESERVED_UNIFORMS = new Set(['texture_pixel_size', 'image_details', 'texture_details']);
// Default starting values for known SMODS uniforms.
//   - dissolve / hovering / vortex_amount default to 0 because they are *masks* applied
//     on top of the base look; > 0 starts erasing or distorting the sprite, which is
//     surprising when you just want to see the shader.
//   - holo / polychrome / negative / foil default to 1 because they are *enable* knobs
//     for the corresponding edition's effect; at 0 the shader is a passthrough.
const KNOWN_DEFAULTS = {
  dissolve: 0,
  hovering: 0,
  vortex_amount: 0,
  holo: 1.0,
  polychrome: 1.0,
  negative: 1.0,
  foil: 1.0
};
const dynamicUniforms = [];

function parseExterns(src) {
  // Optional single-identifier prefix (precision qualifier or user-defined precision macro
  // like MY_HIGHP_OR_MEDIUMP / PRECISION). Backtracking handles \`extern number x;\` where
  // there is no prefix at all.
  const re = /extern\\s+(?:[A-Za-z_][A-Za-z0-9_]*\\s+)?(number|float|int|bool|vec2|vec3|vec4|Image|sampler2D)\\s+([A-Za-z_][A-Za-z0-9_]*)\\s*;/g;
  const out = [];
  let m;
  while ((m = re.exec(src))) {
    const type = m[1] === 'number' ? 'float' : m[1];
    const name = m[2];
    if (type === 'Image' || type === 'sampler2D') continue;
    if (RESERVED_UNIFORMS.has(name)) continue;
    if (out.find(u => u.name === name)) continue;
    out.push({ type, name });
  }
  return out;
}

function buildUniformUI() {
  uniformsEl.innerHTML = '';
  dynamicUniforms.length = 0;
  const decls = parseExterns(currentSource);
  for (const d of decls) {
    const row = document.createElement('div');
    row.className = 'row';
    const label = document.createElement('label');
    label.textContent = d.name + ' (' + d.type + ')';
    row.appendChild(label);
    const inputs = [];
    let tick = null;

    // \`time\` is driven by the Balatro formula \`123.33412 * (ID/1.14212) % 3000\` — a
    // per-card constant, not a real-time accumulator. Show the computed value as
    // readonly; user changes it via the global "card ID" input in the controls bar.
    if (d.name === 'time' && d.type === 'float') {
      const readout = document.createElement('span');
      readout.style.fontFamily = 'var(--vscode-editor-font-family)';
      readout.style.color = 'var(--vscode-descriptionForeground)';
      readout.textContent = '(from card ID)';
      row.appendChild(readout);
      uniformsEl.appendChild(row);
      dynamicUniforms.push({ name: d.name, type: d.type, inputs: [], tick: null, isTime: true, readout });
      continue;
    }

    if (d.type === 'bool') {
      const inp = document.createElement('input');
      inp.type = 'checkbox';
      inp.checked = !!KNOWN_DEFAULTS[d.name];
      row.appendChild(inp);
      inputs.push(inp);
    } else {
      const components = d.type === 'vec2' ? 2 : d.type === 'vec3' ? 3 : d.type === 'vec4' ? 4 : 1;
      const start = KNOWN_DEFAULTS[d.name] ?? 0;
      for (let i = 0; i < components; i++) {
        const inp = document.createElement('input');
        inp.type = 'range';
        inp.min = '-2';
        inp.max = '2';
        inp.step = '0.01';
        inp.value = String(start);
        inp.title = d.name + (components > 1 ? '[' + 'xyzw'[i] + ']' : '');
        row.appendChild(inp);
        inputs.push(inp);
      }
      // Per-uniform auto-tick — advances the first component each frame from the shared
      // realTime accumulator. Default-on for vec2/vec3/vec4 since SMODS shaders typically
      // animate them (e.g. \`ionized\`); float/int default-off — user picks.
      const tickWrap = document.createElement('label');
      tickWrap.title = 'Tick this uniform from shared realTime (advances first component each frame).';
      tickWrap.style.fontSize = '11px';
      tickWrap.style.color = 'var(--vscode-descriptionForeground)';
      tick = document.createElement('input');
      tick.type = 'checkbox';
      tick.checked = (d.type === 'vec2' || d.type === 'vec3' || d.type === 'vec4');
      tickWrap.appendChild(tick);
      tickWrap.append(' ↻');
      row.appendChild(tickWrap);
    }
    uniformsEl.appendChild(row);
    dynamicUniforms.push({ name: d.name, type: d.type, inputs, tick });
  }
}

// (advanceTickedUniforms intentionally absent — ticked uniforms now layer realTime onto
//  the slider value at bind time. See bindDynamicUniforms. The slider stays at the user's
//  baseline; the uniform itself sees baseline + realTime, matching Balatro's
//  G.TIMERS.REAL accumulator semantics for uniforms like \`ionized.y\` and \`vortex_amt\`.)

function bindDynamicUniforms() {
  // Balatro: G.SHADERS[...]:send("time", 123.33412 * (ID/1.14212 or 12.5123152) % 3000)
  // Per-card constant. We hardcode ID = the Balatro-fallback seed.
  let timeVal = 123.33412 * (CARD_ID_SEED / 1.14212);
  timeVal = ((timeVal % 3000) + 3000) % 3000;
  for (const u of dynamicUniforms) {
    const loc = gl.getUniformLocation(program, u.name);
    if (!loc) continue;
    if (u.isTime) {
      gl.uniform1f(loc, timeVal);
      if (u.readout) u.readout.textContent = timeVal.toFixed(3);
      continue;
    }
    if (u.type === 'bool') {
      gl.uniform1i(loc, u.inputs[0].checked ? 1 : 0);
      continue;
    }
    const v = u.inputs.map(i => Number(i.value));
    // ↻ checked → layer the shared realTime accumulator onto the first component, no
    // wrap. Matches Balatro's pattern of binding \`G.TIMERS.REAL\` (or a derivative)
    // straight to the uniform — values grow continuously in seconds.
    if (u.tick && u.tick.checked) v[0] += realTime;
    if (u.type === 'float') gl.uniform1f(loc, v[0]);
    else if (u.type === 'int') gl.uniform1i(loc, v[0] | 0);
    else if (u.type === 'vec2') gl.uniform2f(loc, v[0], v[1]);
    else if (u.type === 'vec3') gl.uniform3f(loc, v[0], v[1], v[2]);
    else if (u.type === 'vec4') gl.uniform4f(loc, v[0], v[1], v[2], v[3]);
  }
}

let program = null;
let texture = null;
let currentSource = '';
let bridgeConnected = false;
let raf = null;
let lastFrame = performance.now();
// Shared real-time accumulator. Mirrors Balatro's G.TIMERS.REAL — every ticked uniform
// reads from this single source so multiple \`↻\` tickers stay in lockstep.
let realTime = 0;

// Vertex stage mirrors LÖVE's wrapping: passes VaryingTexCoord (vec4, .xy is the UV)
// and VaryingColor (vec4) to the fragment stage. The user's effect() reads these.
const VERTEX_SRC = \`attribute vec2 a_pos;
attribute vec2 a_uv;
varying vec4 VaryingTexCoord;
varying vec4 VaryingColor;
void main() {
  VaryingTexCoord = vec4(a_uv, 0.0, 1.0);
  VaryingColor = vec4(1.0, 1.0, 1.0, 1.0);
  gl_Position = vec4(a_pos, 0.0, 1.0);
}\`;

// Prelude mirrors LÖVE's fragment wrapper. Provides:
//  - LÖVE type aliases (number, Image*, Texel, extern)
//  - PIXEL preprocessor define (LOVE/PIXEL gate fragment-only sections in user code;
//    VERTEX stays undefined so #ifdef VERTEX blocks are excluded by the GLSL preprocessor)
//  - LÖVE built-in uniforms/varyings (MainTex, VaryingTexCoord, VaryingColor,
//    love_ScreenSize, love_PixelCoord)
// SMODS-specific uniforms (time, dissolve, texture_details, image_details, …) are NOT
// predeclared. The user shader declares them via \`extern\` and our macro rewrites to
// \`uniform\` — predeclaring would cause GLSL ES \`'name' : redefinition\` link errors.
const FRAGMENT_PRELUDE = \`precision highp float;
#define LOVE 11.0
#define PIXEL 1
#define number float
#define Image sampler2D
#define ArrayImage sampler2DArray
#define VolumeImage sampler3D
#define CubeImage samplerCube
#define Texel texture2D
#define extern uniform

varying vec4 VaryingTexCoord;
varying vec4 VaryingColor;
uniform sampler2D MainTex;
uniform vec4 love_ScreenSize;
#define love_PixelCoord (gl_FragCoord.xy)
\`;

const FRAGMENT_EPILOGUE = \`void main() {
  gl_FragColor = effect(VaryingColor, MainTex, VaryingTexCoord.xy, love_PixelCoord);
}\`;

// Fallback passthrough: shown when user shader is missing or fails to link, so the
// sample sprite remains visible while the error pane tells you what broke.
const FALLBACK_USER_SRC = \`vec4 effect(vec4 colour, Image texture, vec2 texture_coords, vec2 screen_coords) {
  return Texel(texture, texture_coords) * colour;
}\`;

function compileShader(type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh) || '(no info log)';
    gl.deleteShader(sh);
    throw new Error(log);
  }
  return sh;
}

function buildProgram(userSrc) {
  if (!gl) { throw new Error('WebGL not available in this webview.'); }
  const vs = compileShader(gl.VERTEX_SHADER, VERTEX_SRC);
  const fragSrc = FRAGMENT_PRELUDE + '\\n' + userSrc + '\\n' + FRAGMENT_EPILOGUE;
  let fs;
  try { fs = compileShader(gl.FRAGMENT_SHADER, fragSrc); }
  catch (err) { gl.deleteShader(vs); throw err; }
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog) || '(no info log)';
    gl.deleteProgram(prog);
    throw new Error(log);
  }
  return prog;
}

function setupQuad(prog) {
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  // pos (clip), uv
  const data = new Float32Array([
    -1, -1, 0, 1,
     1, -1, 1, 1,
    -1,  1, 0, 0,
     1,  1, 1, 0,
  ]);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(prog, 'a_pos');
  const aUv = gl.getAttribLocation(prog, 'a_uv');
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0);
  if (aUv !== -1) {
    gl.enableVertexAttribArray(aUv);
    gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 16, 8);
  }
}

// Bundled card sprite (media/sample-card.png) — loaded from extension via webview URI.
const cardImg = new Image();
let cardLoaded = false;
cardImg.onload = () => {
  cardLoaded = true;
  if (spriteEl.value === 'card') uploadTexture(makeSpriteCanvas('card'));
};

function makeSpriteCanvas(kind) {
  const c = document.createElement('canvas');
  if (kind === 'card' && cardLoaded) {
    c.width = cardImg.naturalWidth;
    c.height = cardImg.naturalHeight;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(cardImg, 0, 0);
    return c;
  }
  // Fallback: 128x128 checker grid. Used for the explicit "grid" option, and
  // transiently while the card PNG is still loading.
  const w = 128, h = 128;
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  for (let y = 0; y < h; y += 8) for (let x = 0; x < w; x += 8) {
    ctx.fillStyle = ((x ^ y) & 8) ? '#fff' : '#888';
    ctx.fillRect(x, y, 8, 8);
  }
  return c;
}

function uploadTexture(canvas) {
  if (texture) { gl.deleteTexture(texture); }
  texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  cv.width = canvas.width;
  cv.height = canvas.height;
  applyScale();
}

function applyScale() {
  const s = Number(scaleEl.value);
  cv.style.width = (cv.width * s) + 'px';
  cv.style.height = (cv.height * s) + 'px';
}

// Cached uniform locations for the currently-bound program. Repopulated each rebuild
// so the per-frame draw() doesn't pay 5+ getUniformLocation calls.
let uLocs = { tps: null, id: null, td: null, tex: null, lss: null };

function cacheBuiltinUniforms() {
  uLocs = {
    tps: gl.getUniformLocation(program, 'texture_pixel_size'),
    id:  gl.getUniformLocation(program, 'image_details'),
    td:  gl.getUniformLocation(program, 'texture_details'),
    tex: gl.getUniformLocation(program, 'MainTex'),
    lss: gl.getUniformLocation(program, 'love_ScreenSize'),
  };
}

function rebuild() {
  if (!gl) {
    errors.textContent = 'WebGL is not available in this webview.';
    return;
  }
  if (program) { gl.deleteProgram(program); program = null; }
  let userErr = null;
  if (currentSource.trim()) {
    try {
      program = buildProgram(currentSource);
      setupQuad(program);
      errors.textContent = '';
    } catch (err) {
      userErr = err;
    }
  } else {
    userErr = new Error('Shader file is empty.');
  }
  if (!program) {
    try {
      program = buildProgram(FALLBACK_USER_SRC);
      setupQuad(program);
    } catch (err) {
      errors.textContent = 'Internal: passthrough shader failed: ' + (err.message || err);
      program = null;
      pushBtn.disabled = true;
      return;
    }
    errors.textContent = (userErr ? String(userErr.message || userErr) : '') +
      '\\n[showing passthrough sprite while shader is unusable]';
  }
  cacheBuiltinUniforms();
  buildUniformUI();
  pushBtn.disabled = !bridgeConnected || !!userErr;
}

function draw() {
  if (!gl || !program || !texture) return;
  gl.viewport(0, 0, cv.width, cv.height);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.useProgram(program);
  if (uLocs.tps) gl.uniform2f(uLocs.tps, 1.0 / cv.width, 1.0 / cv.height);
  if (uLocs.id) gl.uniform2f(uLocs.id, cv.width, cv.height);
  // texture_details = (sprite_pos_x, sprite_pos_y, sprite_width, sprite_height). Preview
  // renders a single sprite at cell origin, so xy = 0 and ba = canvas dims.
  if (uLocs.td) gl.uniform4f(uLocs.td, 0, 0, cv.width, cv.height);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  if (uLocs.tex) gl.uniform1i(uLocs.tex, 0);
  if (uLocs.lss) gl.uniform4f(uLocs.lss, cv.width, cv.height, 1.0 / cv.width, 1.0 / cv.height);
  bindDynamicUniforms();
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

function loop() {
  raf = requestAnimationFrame(loop);
  const now = performance.now();
  const targetFps = Math.max(1, Number(fpsEl.value));
  const interval = 1000 / targetFps;
  if (now - lastFrame < interval) return;
  const dt = (now - lastFrame) / 1000;
  lastFrame = now;
  // Global speed scaler. 1× == Balatro's G.TIMERS.REAL rate. Propagates into every
  // ↻-ticked uniform via the shared realTime accumulator.
  const speed = Number(speedEl.value);
  realTime += dt * speed;
  draw();
}

fpsEl.oninput = () => { fpsLabel.textContent = fpsEl.value; };
speedEl.oninput = () => { speedLabel.textContent = Number(speedEl.value).toFixed(2) + '×'; };
scaleEl.oninput = applyScale;
spriteEl.onchange = () => uploadTexture(makeSpriteCanvas(spriteEl.value));
pushBtn.onclick = () => {
  vscode.postMessage({ type: 'sendToBalatro', source: currentSource });
};

window.addEventListener('message', evt => {
  const msg = evt.data;
  if (msg.type === 'source') {
    currentSource = msg.source || '';
    if (msg.cardImageUri && cardImg.src !== msg.cardImageUri) {
      cardImg.src = msg.cardImageUri;
    }
    if (typeof msg.connected === 'boolean') {
      bridgeConnected = msg.connected;
      bridgeEl.textContent = 'bridge: ' + (bridgeConnected ? 'live' : 'off');
      bridgeEl.classList.toggle('live', bridgeConnected);
    }
    rebuild();
  } else if (msg.type === 'bridge') {
    bridgeConnected = !!msg.connected;
    bridgeEl.textContent = 'bridge: ' + (bridgeConnected ? 'live' : 'off');
    bridgeEl.classList.toggle('live', bridgeConnected);
    pushBtn.disabled = !bridgeConnected || !program;
  }
});

uploadTexture(makeSpriteCanvas('card'));
loop();
vscode.postMessage({ type: 'ready' });
</script></body></html>`;
}

async function revertAllPreviewOverrides(agent: DebugAgent): Promise<void> {
  if (!agent.isConnected) {
    vscode.window.showWarningMessage('Debug bridge not connected.');
    return;
  }
  try {
    const res = await agent.revertPreviewShaders();
    vscode.window.showInformationMessage(`Shader revert: ${res.reverted} card(s)`);
  } catch (err) {
    vscode.window.showErrorMessage(`Revert failed: ${err}`);
  }
}

export function registerShaderPreview(
  context: vscode.ExtensionContext,
  agent: DebugAgent,
  output: vscode.LogOutputChannel
): void {
  const provider = new ShaderCodeLensProvider();
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider({ language: 'lua' }, provider),
    vscode.languages.registerCodeLensProvider({ pattern: '**/*.fs' }, provider),
    vscode.commands.registerCommand('smods.previewShader',
      (args: PreviewArgs) => openPreview(context, agent, args, output)),
    vscode.commands.registerCommand('smods.shaderPreviewRevert',
      () => revertAllPreviewOverrides(agent)),
    vscode.workspace.onDidSaveTextDocument(d => {
      if (d.languageId === 'lua') { provider.refresh(); }
    })
  );
}
