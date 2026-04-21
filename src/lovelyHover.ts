import * as vscode from 'vscode';

// ---------------------------------------------------------------------------
// Key metadata extracted from schemas/lovely-patches.schema.json
// ---------------------------------------------------------------------------

interface KeyInfo {
  description: string;
  type?: string;
  enumValues?: string[];
  defaultValue?: string;
}

const MANIFEST_KEYS: Record<string, KeyInfo> = {
  version:  { description: 'Patch format version. Typically `"1.0.0"`.', type: 'string' },
  dump_lua: { description: 'Write patched Lua output to disk for debugging.', type: 'boolean', defaultValue: 'false' },
  priority: { description: 'Load priority (lower runs first). Ties break alphabetically.', type: 'integer' },
};

const PATCH_KEYS: Record<string, KeyInfo> = {
  target:       { description: 'File path inside the game\'s Lua tree (e.g. `"game.lua"`, `"functions/common_events.lua"`).', type: 'string' },
  pattern:      { description: 'Literal text to find. Supports `*` wildcards. For `[patches.regex]`, this is a PCRE-style regex.', type: 'string' },
  position:     { description: 'Where to splice the payload relative to the matched text.', type: 'string', enumValues: ['before', 'after', 'at', 'prepend', 'append', 'overwrite'] },
  payload:      { description: 'Lua source to inject at the match site.', type: 'string' },
  match_indent: { description: 'Indent the payload to match the matched line\'s leading whitespace.', type: 'boolean', defaultValue: 'false' },
  times:        { description: 'Maximum number of matches to patch. Omit to patch all occurrences.', type: 'integer' },
  overwrite:    { description: 'Replace (overwrite) the matched text. Only valid when `position = "at"`.', type: 'boolean', defaultValue: 'false' },
  line_prepend: { description: 'String to prepend to every matched line (regex patches only).', type: 'string' },
  sources:      { description: 'Source files relative to this patch bundle (copy patches only).', type: 'array of strings' },
  source:       { description: 'Lua file relative to this `patches.toml` (module patches only).', type: 'string' },
  name:         { description: 'Module name usable by `require()` (module patches only).', type: 'string' },
  display_name: { description: 'Human-readable display name for the module.', type: 'string' },
};

const TOP_LEVEL_KEYS: Record<string, KeyInfo> = {
  manifest:  { description: 'Top-level metadata for this patch bundle.', type: 'table' },
  patches:   { description: 'Array of individual patch definitions.', type: 'array of tables' },
  variables: { description: 'String variables substitutable inside payloads via `{{variable}}`.', type: 'table' },
};

const SECTION_HEADERS: Record<string, KeyInfo> = {
  'manifest':        { description: 'Top-level metadata for this patch bundle (version, dump_lua, priority).', type: 'table' },
  'variables':       { description: 'String variables substitutable inside payloads via `{{variable}}`.', type: 'table' },
  'patches':         { description: 'Each `[[patches]]` entry defines one patch. Follow it with a `[patches.pattern]`, `[patches.regex]`, `[patches.copy]`, or `[patches.module]` block.', type: 'array of tables' },
  'patches.pattern': { description: 'Text-substitution patch using a literal string. Requires `target`, `pattern`, `position`, and `payload`.', type: 'table' },
  'patches.regex':   { description: 'Regex-based substitution patch (PCRE). Capture groups referenceable in `payload` via `$1`, `$2`, etc.', type: 'table' },
  'patches.copy':    { description: 'Copy one or more Lua files into the patched game tree at `target`.', type: 'table' },
  'patches.module':  { description: 'Register a file from this bundle as a `require()`-able Lua module.', type: 'table' },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Return the TOML section header active at `lineIdx`, e.g. "manifest", "patches.pattern". */
function sectionAt(doc: vscode.TextDocument, lineIdx: number): string {
  for (let i = lineIdx; i >= 0; i--) {
    const text = doc.lineAt(i).text.trim();
    // [[patches]] or [patches.pattern] etc.
    const m = text.match(/^\[+([^\]]+)]+/);
    if (m) { return m[1].trim(); }
  }
  return '';
}

function buildHover(key: string, info: KeyInfo): vscode.Hover {
  const md = new vscode.MarkdownString();
  md.isTrusted = true;
  md.appendMarkdown(`**\`${key}\`**`);
  if (info.type) { md.appendMarkdown(` *(${info.type})*`); }
  md.appendMarkdown(`\n\n${info.description}`);
  if (info.enumValues) {
    md.appendMarkdown(`\n\nAllowed values: ${info.enumValues.map(v => `\`"${v}"\``).join(', ')}`);
  }
  if (info.defaultValue !== undefined) {
    md.appendMarkdown(`\n\nDefault: \`${info.defaultValue}\``);
  }
  return new vscode.Hover(md);
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

class LovelyTomlHoverProvider implements vscode.HoverProvider {
  provideHover(
    doc: vscode.TextDocument,
    pos: vscode.Position
  ): vscode.ProviderResult<vscode.Hover> {
    const lineText = doc.lineAt(pos.line).text;

    // Skip comment lines
    if (/^\s*#/.test(lineText)) { return undefined; }

    // Section header lines: [manifest], [[patches]], [patches.pattern], etc.
    const headerMatch = lineText.match(/^\s*\[+([^\]]+)]+/);
    if (headerMatch) {
      const section = headerMatch[1].trim();
      const info = SECTION_HEADERS[section];
      if (info) { return buildHover(section, info); }
      return undefined;
    }

    // Extract the key token under or before the cursor
    const keyMatch = lineText.match(/^\s*(\w+)\s*=/);
    if (!keyMatch) { return undefined; }
    const key = keyMatch[1];

    // Check the cursor is actually on the key token
    const keyStart = lineText.indexOf(key);
    const keyEnd = keyStart + key.length;
    if (pos.character < keyStart || pos.character > keyEnd) { return undefined; }

    const section = sectionAt(doc, pos.line);

    // Route to the right key table based on section
    if (section === 'manifest') {
      const info = MANIFEST_KEYS[key];
      if (info) { return buildHover(key, info); }
    } else if (section.startsWith('patches')) {
      const info = PATCH_KEYS[key];
      if (info) { return buildHover(key, info); }
    } else if (section === '') {
      // Top-level (no section yet)
      const info = TOP_LEVEL_KEYS[key];
      if (info) { return buildHover(key, info); }
    }

    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerLovelyHover(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.languages.registerHoverProvider(
      [{ language: 'toml' }, { language: 'lovely-patch' }, { scheme: 'file', pattern: '**/*.toml' }],
      new LovelyTomlHoverProvider()
    )
  );
}
