import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { findModRoots } from './paths';
import { findManifestFile } from './modUtils';

type BumpKind = 'patch' | 'minor' | 'major' | 'prerelease';

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

interface Parsed { major: number; minor: number; patch: number; pre?: string; }

function parse(v: string): Parsed | undefined {
  const m = SEMVER_RE.exec(v);
  if (!m) {return undefined;}
  return {
    major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]),
    pre: m[4]
  };
}

function render(p: Parsed): string {
  const base = `${p.major}.${p.minor}.${p.patch}`;
  return p.pre ? `${base}-${p.pre}` : base;
}

export function bump(v: string, kind: BumpKind): string {
  const p = parse(v);
  if (!p) {return v;}
  switch (kind) {
    case 'major': return render({ major: p.major + 1, minor: 0, patch: 0 });
    case 'minor': return render({ major: p.major, minor: p.minor + 1, patch: 0 });
    case 'patch': return render({ major: p.major, minor: p.minor, patch: p.patch + 1 });
    case 'prerelease': {
      const pre = p.pre ?? '';
      const m = /^(.*?)(\d+)$/.exec(pre);
      const next = m ? `${m[1]}${Number(m[2]) + 1}` : (pre ? `${pre}.1` : 'rc.1');
      return render({ major: p.major, minor: p.minor, patch: p.patch, pre: next });
    }
  }
}

async function pickManifest(): Promise<string | undefined> {
  const roots = findModRoots();
  const manifests = (await Promise.all(roots.map(findManifestFile)))
    .filter((m): m is NonNullable<typeof m> => !!m)
    .map(m => m.path);
  if (manifests.length === 0) {
    vscode.window.showErrorMessage('No Smods manifest found in workspace.');
    return undefined;
  }
  if (manifests.length === 1) {return manifests[0];}
  const pick = await vscode.window.showQuickPick(
    manifests.map(m => ({ label: path.basename(m), description: m, path: m })),
    { title: 'Select manifest to bump' }
  );
  return pick?.path;
}

/** Rewrite only the version string, preserving surrounding formatting. */
function replaceVersion(text: string, newVersion: string): string | undefined {
  const re = /("version"\s*:\s*")([^"]*)(")/;
  if (!re.test(text)) {return undefined;}
  return text.replace(re, `$1${newVersion}$3`);
}

export function registerVersionBump(
  context: vscode.ExtensionContext,
  output: vscode.LogOutputChannel
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('smods.bumpVersion', async () => {
      const manifestPath = await pickManifest();
      if (!manifestPath) {return;}

      const raw = await fs.readFile(manifestPath, 'utf8');
      let current: string;
      try {
        const j = JSON.parse(raw);
        current = typeof j.version === 'string' ? j.version : '0.0.0';
      } catch {
        vscode.window.showErrorMessage(`Could not parse ${manifestPath}`);
        return;
      }

      if (!parse(current)) {
        vscode.window.showErrorMessage(
          `Current version "${current}" is not SemVer. Edit manually first.`
        );
        return;
      }

      const kinds: BumpKind[] = ['patch', 'minor', 'major', 'prerelease'];
      const pick = await vscode.window.showQuickPick(
        kinds.map(k => ({
          label: `${k} → ${bump(current, k)}`,
          description: `from ${current}`,
          bumpKind: k
        })),
        { title: `Bump version (${path.basename(manifestPath)})` }
      );
      if (!pick) {return;}

      const next = bump(current, pick.bumpKind);
      const updated = replaceVersion(raw, next);
      if (!updated) {
        vscode.window.showErrorMessage(
          `Manifest has no "version" field. Add it first.`
        );
        return;
      }
      await fs.writeFile(manifestPath, updated);
      output.info(`Bumped ${path.basename(manifestPath)}: ${current} → ${next}`);
      vscode.window.showInformationMessage(`Version: ${current} → ${next}`);
    })
  );
}
