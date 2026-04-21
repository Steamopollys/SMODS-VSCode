import * as vscode from 'vscode';

const SCHEME = 'lovely-embedded-lua';

// ---------------------------------------------------------------------------
// Virtual document provider
// Stores the current Lua content for each open lovely-patch document.
// ---------------------------------------------------------------------------

class EmbeddedLuaProvider implements vscode.TextDocumentContentProvider {
  private readonly _contents = new Map<string, string>();
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  set(key: string, lua: string): vscode.Uri {
    const uri = vscode.Uri.from({ scheme: SCHEME, path: key + '.lua' });
    this._contents.set(key, lua);
    this._onDidChange.fire(uri);
    return uri;
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const key = uri.path.replace(/\.lua$/, '');
    return this._contents.get(key) ?? '';
  }
}

// ---------------------------------------------------------------------------
// Find the Lua payload at the cursor position.
// Returns the extracted Lua string and the mapped cursor position within it.
// ---------------------------------------------------------------------------

function findTripleQuoteOpen(
  doc: vscode.TextDocument,
  pos: vscode.Position
): { openLine: number; delimiter: string } | null {
  for (let i = pos.line; i >= Math.max(0, pos.line - 500); i--) {
    const lt = doc.lineAt(i).text;
    for (const delim of ['"""', "'''"]) {
      const re = new RegExp('^\\s*payload\\s*=\\s*' + delim.replace(/'/g, "\\'").replace(/"/g, '\\"'));
      if (re.test(lt)) {
        const after = lt.slice(lt.indexOf(delim) + 3);
        if (!after.includes(delim)) { return { openLine: i, delimiter: delim }; }
        return null; // single-line triple-quoted — handled elsewhere
      }
    }
    if (i < pos.line) {
      // Stop at any TOML section header — never cross into another patch block.
      // Do NOT break on \w+\s*= because Lua payload content contains assignments.
      if (/^\s*\[/.test(lt)) { break; }
    }
  }
  return null;
}

function extractPayloadAtCursor(
  doc: vscode.TextDocument,
  pos: vscode.Position
): { lua: string; luaPos: vscode.Position } | null {

  const lineText = doc.lineAt(pos.line).text;

  // ── Inline single-line:  payload = "print('hello')"
  const inlineMatch = lineText.match(/^(\s*payload\s*=\s*")((?:[^"\\]|\\.)*)"/ );
  if (inlineMatch) {
    const contentStart = inlineMatch[1].length;
    const contentEnd   = contentStart + inlineMatch[2].length;
    if (pos.character >= contentStart && pos.character < contentEnd) {
      const lua = unescape(inlineMatch[2]);
      return { lua, luaPos: new vscode.Position(0, pos.character - contentStart) };
    }
    return null; // on this line but not inside the string
  }

  // ── Inline single-line literal:  payload = 'print("hello")'
  const inlineLiteralMatch = lineText.match(/^(\s*payload\s*=\s*')((?:[^'])*)'/ );
  if (inlineLiteralMatch) {
    const contentStart = inlineLiteralMatch[1].length;
    const contentEnd   = contentStart + inlineLiteralMatch[2].length;
    if (pos.character >= contentStart && pos.character < contentEnd) {
      return { lua: inlineLiteralMatch[2], luaPos: new vscode.Position(0, pos.character - contentStart) };
    }
    return null;
  }

  // ── Multi-line:  payload = """  ...  """  or  payload = '''  ...  '''
  // Scan backward from cursor to find the opening payload = """ / '''
  const tripleQuote = findTripleQuoteOpen(doc, pos);
  if (!tripleQuote) { return null; }
  const { openLine, delimiter } = tripleQuote;

  // Find closing delimiter
  let closeLine = -1;
  for (let i = openLine + 1; i < Math.min(doc.lineCount, openLine + 500); i++) {
    if (doc.lineAt(i).text.includes(delimiter)) { closeLine = i; break; }
  }
  if (closeLine < 0 || pos.line <= openLine || pos.line >= closeLine) { return null; }

  // Collect the Lua lines (between opening and closing """)
  const luaLines: string[] = [];
  for (let i = openLine + 1; i < closeLine; i++) {
    luaLines.push(doc.lineAt(i).text);
  }
  const lua = luaLines.join('\n');
  const luaLine = pos.line - (openLine + 1);

  return { lua, luaPos: new vscode.Position(luaLine, pos.character) };
}

function unescape(s: string): string {
  return s.replace(/\\n/g, '\n').replace(/\\t/g, '\t')
          .replace(/\\r/g, '\r').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

// ---------------------------------------------------------------------------
// Hover provider — delegates to the Lua language server via virtual document
// ---------------------------------------------------------------------------

class EmbeddedLuaHoverProvider implements vscode.HoverProvider {
  constructor(private readonly provider: EmbeddedLuaProvider) {}

  async provideHover(
    doc: vscode.TextDocument,
    pos: vscode.Position
  ): Promise<vscode.Hover | undefined> {
    const extracted = extractPayloadAtCursor(doc, pos);
    if (!extracted) { return undefined; }

    const key = doc.uri.toString();
    const virtualUri = this.provider.set(key, extracted.lua);

    // Ensure VS Code has opened the virtual document before querying it
    await vscode.workspace.openTextDocument(virtualUri);

    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      virtualUri,
      extracted.luaPos
    );

    if (!hovers || hovers.length === 0) { return undefined; }

    // Merge all hover contents into one response
    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    for (const h of hovers) {
      for (const part of h.contents) {
        if (typeof part === 'string') {
          md.appendMarkdown(part);
        } else {
          md.appendMarkdown(part.value);
        }
      }
    }

    return new vscode.Hover(md);
  }
}

// ---------------------------------------------------------------------------
// Completion provider — delegates to the Lua language server via virtual doc
// ---------------------------------------------------------------------------

class EmbeddedLuaCompletionProvider implements vscode.CompletionItemProvider {
  constructor(private readonly provider: EmbeddedLuaProvider) {}

  async provideCompletionItems(
    doc: vscode.TextDocument,
    pos: vscode.Position,
    _token: vscode.CancellationToken,
    context: vscode.CompletionContext
  ): Promise<vscode.CompletionList | undefined> {
    const extracted = extractPayloadAtCursor(doc, pos);
    if (!extracted) { return undefined; }

    const key = doc.uri.toString();
    const virtualUri = this.provider.set(key, extracted.lua);
    await vscode.workspace.openTextDocument(virtualUri);

    const list = await vscode.commands.executeCommand<vscode.CompletionList>(
      'vscode.executeCompletionItemProvider',
      virtualUri,
      extracted.luaPos,
      context.triggerCharacter
    );

    return list;
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerEmbeddedLuaHover(context: vscode.ExtensionContext): void {
  const provider = new EmbeddedLuaProvider();
  const docSelector: vscode.DocumentSelector = [
    { language: 'lovely-patch' },
    { language: 'toml' },
    { scheme: 'file', pattern: '**/*.toml' }
  ];

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, provider),
    vscode.languages.registerHoverProvider(
      docSelector,
      new EmbeddedLuaHoverProvider(provider)
    ),
    vscode.languages.registerCompletionItemProvider(
      docSelector,
      new EmbeddedLuaCompletionProvider(provider),
      '.', ':', '(', '"', "'"  // trigger characters common in Lua
    )
  );
}
