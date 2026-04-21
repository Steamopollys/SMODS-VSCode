import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

interface FlagInfo {
  summary: string;
  description?: string;
  example?: string;
}

let CONTEXTS: Record<string, FlagInfo> = {};

class ContextHoverProvider implements vscode.HoverProvider {
  provideHover(
    doc: vscode.TextDocument, pos: vscode.Position
  ): vscode.ProviderResult<vscode.Hover> {
    const range = doc.getWordRangeAtPosition(pos, /context\.\w+/);
    if (!range) {return undefined;}
    const flag = doc.getText(range).replace(/^context\./, '');
    const info = CONTEXTS[flag];
    if (!info) {return undefined;}

    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.supportHtml = false;
    md.appendMarkdown(`**\`context.${flag}\`** — ${info.summary}\n\n`);
    if (info.description) {md.appendMarkdown(info.description + '\n\n');}
    if (info.example) {md.appendCodeblock(info.example, 'lua');}
    return new vscode.Hover(md, range);
  }
}

class ContextCompletionProvider implements vscode.CompletionItemProvider {
  provideCompletionItems(
    doc: vscode.TextDocument, pos: vscode.Position
  ): vscode.CompletionItem[] {
    const line = doc.lineAt(pos.line).text.slice(0, pos.character);
    if (!/context\.\w*$/.test(line)) {return [];}
    return Object.entries(CONTEXTS).map(([name, info]) => {
      const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Field);
      item.detail = info.summary;
      if (info.description) {
        item.documentation = new vscode.MarkdownString(info.description);
      }
      return item;
    });
  }
}

export function registerContextHover(
  context: vscode.ExtensionContext,
  output: vscode.LogOutputChannel
): void {
  const dataPath = path.join(context.extensionPath, 'data', 'contexts.json');
  try {
    CONTEXTS = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  } catch (err) {
    output.warn(`Could not load contexts.json: ${err}`);
    return;
  }
  for (const lang of ['lua', 'toml', 'lovely-patch']) {
    context.subscriptions.push(
      vscode.languages.registerHoverProvider({ language: lang },
        new ContextHoverProvider()),
      vscode.languages.registerCompletionItemProvider({ language: lang },
        new ContextCompletionProvider(), '.')
    );
  }
}
