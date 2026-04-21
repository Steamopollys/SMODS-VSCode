import * as vscode from 'vscode';

// ---------------------------------------------------------------------------
// Minimal TOML parser for Lovely patch files
// Handles the subset actually used: manifest, variables, [[patches]] arrays.
// ---------------------------------------------------------------------------

interface ParsedPatch {
  type?: 'pattern' | 'regex' | 'copy' | 'module';
  keys: Record<string, { value: unknown; line: number }>;
}

interface ParsedToml {
  manifest: Record<string, { value: unknown; line: number }>;
  variables: Record<string, { value: unknown; line: number }>;
  patches: ParsedPatch[];
}

interface ParseError {
  line: number;
  message: string;
}

function parseToml(text: string): { doc: ParsedToml; errors: ParseError[] } {
  const lines = text.split('\n');
  const errors: ParseError[] = [];
  const doc: ParsedToml = { manifest: {}, variables: {}, patches: [] };

  type Section = 'manifest' | 'variables' | 'patch' | 'unknown';
  let section: Section = 'unknown';
  let currentPatch: ParsedPatch | null = null;

  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    const trimmed = raw.trim();

    // blank / comment
    if (trimmed === '' || trimmed.startsWith('#')) { i++; continue; }

    // [[patches]]
    const arrayHeader = trimmed.match(/^\[\[(\w+)\]\]\s*(?:#.*)?$/);
    if (arrayHeader) {
      if (arrayHeader[1] !== 'patches') {
        errors.push({ line: i, message: `Unknown array table [[${arrayHeader[1]}]].` });
      }
      currentPatch = { keys: {} };
      doc.patches.push(currentPatch);
      section = 'patch';
      i++; continue;
    }

    // [section] or [patches.type]
    const tableHeader = trimmed.match(/^\[([^\]]+)\]\s*(?:#.*)?$/);
    if (tableHeader) {
      const name = tableHeader[1].trim();
      if (name === 'manifest') {
        section = 'manifest'; currentPatch = null;
      } else if (name === 'variables') {
        section = 'variables'; currentPatch = null;
      } else if (name.startsWith('patches.')) {
        const patchType = name.slice('patches.'.length);
        if (!['pattern', 'regex', 'copy', 'module'].includes(patchType)) {
          errors.push({ line: i, message: `Unknown patch type "[${name}]". Expected pattern, regex, copy, or module.` });
        }
        if (!currentPatch) {
          errors.push({ line: i, message: `"[${name}]" has no preceding [[patches]] header.` });
          currentPatch = { keys: {} };
          doc.patches.push(currentPatch);
        }
        currentPatch.type = patchType as ParsedPatch['type'];
        section = 'patch';
      } else {
        errors.push({ line: i, message: `Unknown section "[${name}]".` });
        section = 'unknown';
      }
      i++; continue;
    }

    // key = value
    const kvMatch = raw.match(/^(\s*)(\w+)\s*=/);
    if (kvMatch) {
      const key = kvMatch[2];
      const afterEq = raw.slice(raw.indexOf('=') + 1).trim();

      const { value, consumed, error } = parseValue(afterEq, lines, i);
      if (error) { errors.push({ line: i, message: error }); }

      const entry = { value, line: i };
      if (section === 'manifest') {
        doc.manifest[key] = entry;
      } else if (section === 'variables') {
        doc.variables[key] = entry;
      } else if (section === 'patch' && currentPatch) {
        currentPatch.keys[key] = entry;
      }
      i += consumed; continue;
    }

    errors.push({ line: i, message: `Cannot parse line: ${trimmed}` });
    i++;
  }

  return { doc, errors };
}

/** Parse a TOML value starting at `rest` (text after `=`).
 *  Returns the value, how many extra lines were consumed (0 for single-line),
 *  and an optional error string. */
function parseValue(
  rest: string, lines: string[], startLine: number
): { value: unknown; consumed: number; error?: string } {
  // Triple-quoted strings  """..."""
  if (rest.startsWith('"""')) {
    const inner = rest.slice(3);
    const closeOnSame = inner.indexOf('"""');
    if (closeOnSame >= 0) {
      return { value: inner.slice(0, closeOnSame), consumed: 1 };
    }
    const parts: string[] = [inner];
    let j = startLine + 1;
    while (j < lines.length) {
      const l = lines[j];
      const ci = l.indexOf('"""');
      if (ci >= 0) { parts.push(l.slice(0, ci)); return { value: parts.join('\n'), consumed: j - startLine + 1 }; }
      parts.push(l); j++;
    }
    return { value: parts.join('\n'), consumed: j - startLine, error: 'Unclosed triple-quoted string.' };
  }

  // Triple single-quoted literal strings  '''...'''
  if (rest.startsWith("'''")) {
    const inner = rest.slice(3);
    const closeOnSame = inner.indexOf("'''");
    if (closeOnSame >= 0) {
      return { value: inner.slice(0, closeOnSame), consumed: 1 };
    }
    const parts: string[] = [inner];
    let j = startLine + 1;
    while (j < lines.length) {
      const l = lines[j];
      const ci = l.indexOf("'''");
      if (ci >= 0) { parts.push(l.slice(0, ci)); return { value: parts.join('\n'), consumed: j - startLine + 1 }; }
      parts.push(l); j++;
    }
    return { value: parts.join('\n'), consumed: j - startLine, error: "Unclosed triple literal string." };
  }

  // Single-quoted literal strings  '...'
  if (rest.startsWith("'")) {
    const inner = rest.slice(1);
    const ci = inner.indexOf("'");
    if (ci < 0) { return { value: inner, consumed: 1, error: 'Unclosed literal string.' }; }
    return { value: inner.slice(0, ci), consumed: 1 };
  }

  // Double-quoted strings  "..."
  if (rest.startsWith('"')) {
    const inner = rest.slice(1);
    // find closing " not preceded by backslash
    const ci = inner.search(/(?<!\\)"/);
    if (ci < 0) { return { value: inner, consumed: 1, error: 'Unclosed string.' }; }
    const raw = inner.slice(0, ci);
    const unescaped = raw.replace(/\\n/g, '\n').replace(/\\t/g, '\t')
                         .replace(/\\r/g, '\r').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    return { value: unescaped, consumed: 1 };
  }

  // Inline arrays  ["a", "b"]
  if (rest.startsWith('[')) {
    const closeIdx = rest.indexOf(']');
    if (closeIdx < 0) { return { value: [], consumed: 1, error: 'Unclosed array.' }; }
    const contents = rest.slice(1, closeIdx);
    const items = contents.split(',').map(s => {
      const t = s.trim();
      if (t.startsWith('"') && t.endsWith('"')) { return t.slice(1, -1); }
      if (t.startsWith("'") && t.endsWith("'")) { return t.slice(1, -1); }
      return t;
    }).filter(s => s !== '');
    return { value: items, consumed: 1 };
  }

  // Strip trailing comment
  const stripped = rest.replace(/\s*#.*$/, '').trim();

  if (stripped === 'true')  { return { value: true,  consumed: 1 }; }
  if (stripped === 'false') { return { value: false, consumed: 1 }; }
  if (/^-?\d+$/.test(stripped))     { return { value: parseInt(stripped, 10),    consumed: 1 }; }
  if (/^-?\d+\.\d+$/.test(stripped)){ return { value: parseFloat(stripped),      consumed: 1 }; }

  return { value: stripped, consumed: 1, error: `Unrecognised value: ${rest}` };
}

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

const MANIFEST_VALID_KEYS  = new Set(['version', 'dump_lua', 'priority']);
const PATTERN_REQUIRED     = ['target', 'pattern', 'position', 'payload'];
const REGEX_REQUIRED       = ['target', 'pattern', 'position', 'payload'];
const COPY_REQUIRED        = ['target', 'sources'];
const MODULE_REQUIRED      = ['source', 'name'];
const PATTERN_VALID_KEYS   = new Set(['target', 'pattern', 'position', 'payload', 'match_indent', 'times', 'overwrite']);
const REGEX_VALID_KEYS     = new Set(['target', 'pattern', 'position', 'payload', 'match_indent', 'times', 'line_prepend']);
const COPY_VALID_KEYS      = new Set(['target', 'sources', 'position']);
const MODULE_VALID_KEYS    = new Set(['source', 'name', 'display_name', 'priority']);
const PATTERN_POS_VALUES   = new Set(['before', 'after', 'at']);
const COPY_POS_VALUES      = new Set(['prepend', 'append', 'overwrite']);

function lineRange(doc: vscode.TextDocument, line: number): vscode.Range {
  const l = doc.lineAt(Math.min(line, doc.lineCount - 1));
  return l.range;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function keyRange(doc: vscode.TextDocument, key: string, fromLine: number): vscode.Range {
  for (let i = fromLine; i < Math.min(fromLine + 30, doc.lineCount); i++) {
    const text = doc.lineAt(i).text;
    const idx = text.search(new RegExp(`\\b${key}\\b`));
    if (idx >= 0) {
      return new vscode.Range(i, idx, i, idx + key.length);
    }
  }
  return lineRange(doc, fromLine);
}

function validate(doc: vscode.TextDocument, parsed: ParsedToml): vscode.Diagnostic[] {
  const diags: vscode.Diagnostic[] = [];

  const err  = (range: vscode.Range, msg: string) =>
    diags.push(new vscode.Diagnostic(range, msg, vscode.DiagnosticSeverity.Error));
  const warn = (range: vscode.Range, msg: string) =>
    diags.push(new vscode.Diagnostic(range, msg, vscode.DiagnosticSeverity.Warning));

  // --- [manifest] ---
  for (const [key, entry] of Object.entries(parsed.manifest)) {
    if (!MANIFEST_VALID_KEYS.has(key)) {
      warn(lineRange(doc, entry.line), `Unknown key "${key}" in [manifest].`);
    }
  }
  const mv = (k: string) => parsed.manifest[k]?.value;
  if (mv('version')  !== undefined && typeof mv('version')  !== 'string') {
    err(lineRange(doc, parsed.manifest['version'].line), '"version" must be a string.');
  }
  if (mv('dump_lua') !== undefined && typeof mv('dump_lua') !== 'boolean') {
    err(lineRange(doc, parsed.manifest['dump_lua'].line), '"dump_lua" must be a boolean (true or false).');
  }
  if (mv('priority') !== undefined && typeof mv('priority') !== 'number') {
    err(lineRange(doc, parsed.manifest['priority'].line), '"priority" must be an integer.');
  }

  // --- [[patches]] ---
  for (let idx = 0; idx < parsed.patches.length; idx++) {
    const patch = parsed.patches[idx];
    const patchHeaderLine = findPatchHeaderLine(doc, idx);

    if (!patch.type) {
      err(
        lineRange(doc, patchHeaderLine),
        `Patch #${idx + 1} has no type. Add [patches.pattern], [patches.regex], [patches.copy], or [patches.module].`
      );
      continue;
    }

    let required: string[];
    let validKeys: Set<string>;
    let posValues: Set<string> | null;

    switch (patch.type) {
      case 'pattern': required = PATTERN_REQUIRED; validKeys = PATTERN_VALID_KEYS; posValues = PATTERN_POS_VALUES; break;
      case 'regex':   required = REGEX_REQUIRED;   validKeys = REGEX_VALID_KEYS;   posValues = PATTERN_POS_VALUES; break;
      case 'copy':    required = COPY_REQUIRED;    validKeys = COPY_VALID_KEYS;    posValues = COPY_POS_VALUES;    break;
      case 'module':  required = MODULE_REQUIRED;  validKeys = MODULE_VALID_KEYS;  posValues = null;               break;
    }

    for (const req of required) {
      if (!(req in patch.keys)) {
        err(lineRange(doc, patchHeaderLine), `Patch #${idx + 1} [patches.${patch.type}] is missing required key "${req}".`);
      }
    }

    for (const [key, entry] of Object.entries(patch.keys)) {
      if (!validKeys.has(key)) {
        warn(lineRange(doc, entry.line), `Unknown key "${key}" in [patches.${patch.type}].`);
      }
    }

    if (posValues && 'position' in patch.keys) {
      const pos = patch.keys['position'].value;
      if (typeof pos === 'string' && !posValues.has(pos)) {
        const allowed = [...posValues].map(v => `"${v}"`).join(', ');
        err(lineRange(doc, patch.keys['position'].line), `Invalid position "${pos}". Allowed: ${allowed}.`);
      }
    }

    if ('times' in patch.keys) {
      const t = patch.keys['times'].value;
      if (typeof t !== 'number' || t < 1 || !Number.isInteger(t)) {
        err(lineRange(doc, patch.keys['times'].line), '"times" must be a positive integer.');
      }
    }

    if ('match_indent' in patch.keys && typeof patch.keys['match_indent'].value !== 'boolean') {
      err(lineRange(doc, patch.keys['match_indent'].line), '"match_indent" must be a boolean.');
    }

    if ('overwrite' in patch.keys && typeof patch.keys['overwrite'].value !== 'boolean') {
      err(lineRange(doc, patch.keys['overwrite'].line), '"overwrite" must be a boolean.');
    }

    if ('overwrite' in patch.keys && patch.keys['overwrite'].value === true) {
      const pos = patch.keys['position']?.value;
      if (pos !== 'at') {
        warn(lineRange(doc, patch.keys['overwrite'].line), '"overwrite" is only meaningful when position = "at".');
      }
    }

    if (patch.type === 'copy' && 'sources' in patch.keys) {
      if (!Array.isArray(patch.keys['sources'].value)) {
        err(lineRange(doc, patch.keys['sources'].line), '"sources" must be an array of strings.');
      }
    }
  }

  return diags;
}

/** Scan the document to find the line of the Nth [[patches]] header. */
function findPatchHeaderLine(doc: vscode.TextDocument, idx: number): number {
  let count = -1;
  for (let i = 0; i < doc.lineCount; i++) {
    if (/^\s*\[\[patches\]\]/.test(doc.lineAt(i).text)) {
      count++;
      if (count === idx) { return i; }
    }
  }
  return 0;
}

function isLovelyPatchDoc(doc: vscode.TextDocument): boolean {
  return (
    doc.languageId === 'lovely-patch' ||
    doc.languageId === 'toml' &&
    (/[/\\]lovely[/\\][^/\\]+\.toml$/.test(doc.fileName) ||
     doc.fileName.endsWith('.lovely.toml'))
  );
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerLovelyValidator(
  context: vscode.ExtensionContext,
  output: vscode.LogOutputChannel
): void {
  const collection = vscode.languages.createDiagnosticCollection('lovely-patch');
  context.subscriptions.push(collection);

  function refresh(doc: vscode.TextDocument): void {
    if (!isLovelyPatchDoc(doc)) { collection.delete(doc.uri); return; }
    try {
      const { doc: parsed, errors } = parseToml(doc.getText());
      const diags: vscode.Diagnostic[] = [];

      for (const e of errors) {
        diags.push(new vscode.Diagnostic(
          lineRange(doc, e.line),
          e.message,
          vscode.DiagnosticSeverity.Error
        ));
      }

      diags.push(...validate(doc, parsed));
      collection.set(doc.uri, diags);
    } catch (err) {
      output.error(`Lovely patch validation failed: ${err}`);
    }
  }

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(refresh),
    vscode.workspace.onDidChangeTextDocument(e => refresh(e.document)),
    vscode.workspace.onDidCloseTextDocument(doc => collection.delete(doc.uri))
  );

  for (const doc of vscode.workspace.textDocuments) { refresh(doc); }
}
