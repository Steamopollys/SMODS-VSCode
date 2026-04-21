import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { findModRoots, getInstalledSmodsVersion } from './paths';
import { findManifestFile } from './modUtils';

interface ModScaffoldInput {
  id: string;
  name: string;
  prefix: string;
  author: string;
  description: string;
  includeAtlas: boolean;
  includeLovely: boolean;
  includeLocalization: boolean;
}

/** Collect inputs for a new mod via a sequence of input boxes. */
async function promptForMod(): Promise<ModScaffoldInput | undefined> {
  const id = await vscode.window.showInputBox({
    title: 'New Smods Mod (1/5)',
    prompt: 'Unique mod ID (no spaces). Must not be "Smods", "Lovely" or "Balatro".',
    placeHolder: 'my_awesome_mod',
    validateInput: v => {
      if (!v) {return 'Required.';}
      if (/\s/.test(v)) {return 'No spaces allowed.';}
      if (['smods', 'lovely', 'balatro'].includes(v.toLowerCase())) {
        return 'This ID is reserved.';
      }
      return null;
    }
  });
  if (!id) {return undefined;}

  const name = await vscode.window.showInputBox({
    title: 'New Smods Mod (2/5)',
    prompt: 'Display name',
    value: id.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
  });
  if (name === undefined) {return undefined;}

  const prefix = await vscode.window.showInputBox({
    title: 'New Smods Mod (3/5)',
    prompt: 'Key prefix prepended to every object your mod registers. Must be unique.',
    value: id.split('_').map(s => s[0] ?? '').join('').toLowerCase() || id.slice(0, 3),
    validateInput: v => (v && !/\s/.test(v)) ? null : 'Required, no spaces.'
  });
  if (!prefix) {return undefined;}

  const configuredAuthor = vscode.workspace.getConfiguration('smods')
    .get<string>('defaultAuthor', '');
  const author = await vscode.window.showInputBox({
    title: 'New Smods Mod (4/5)',
    prompt: 'Author name',
    value: configuredAuthor
  });
  if (author === undefined) {return undefined;}

  const description = await vscode.window.showInputBox({
    title: 'New Smods Mod (5/5)',
    prompt: 'Short description',
    value: `A Balatro mod: ${name || id}`
  });
  if (description === undefined) {return undefined;}

  const pickExtras = await vscode.window.showQuickPick(
    [
      { label: 'Localization file (localization/en-us.lua)', picked: true,  id: 'loc' },
      { label: 'Atlas folder (assets/1x, assets/2x)',        picked: true,  id: 'atlas' },
      { label: 'Lovely patch folder (lovely/)',              picked: false, id: 'lovely' }
    ],
    { canPickMany: true, title: 'Optional scaffolding' }
  );
  if (pickExtras === undefined) {return undefined;}
  const picked = new Set(pickExtras.map(p => p.id));

  return {
    id, name, prefix, author, description,
    includeAtlas:        picked.has('atlas'),
    includeLovely:       picked.has('lovely'),
    includeLocalization: picked.has('loc')
  };
}

async function writeModScaffold(
  targetRoot: string,
  input: ModScaffoldInput
): Promise<string> {
  const modDir = path.join(targetRoot, input.id);
  await fs.mkdir(modDir, { recursive: true });

  // Manifest (<id>.json as per Smods docs)
  const installedSmods = getInstalledSmodsVersion() ?? '1.0.0';
  const manifest = {
    id: input.id,
    name: input.name,
    author: [input.author || 'Unknown'],
    description: input.description,
    prefix: input.prefix,
    main_file: 'main.lua',
    priority: 0,
    badge_colour: '666666',
    badge_text_colour: 'FFFFFF',
    version: '0.1.0',
    dependencies: [`Steamodded (>=${installedSmods})`],
    conflicts: []
  };
  await fs.writeFile(
    path.join(modDir, `${input.id}.json`),
    JSON.stringify(manifest, null, 2) + '\n'
  );

  // main.lua
  const mainLua = `-- ${input.name}
-- Entry point loaded by Smods.

SMODS.current_mod.config_tab = function()
    return {
        n = G.UIT.ROOT,
        config = { align = 'cm', padding = 0.05, colour = G.C.CLEAR },
        nodes = {
            {
                n = G.UIT.R,
                config = { align = 'cm' },
                nodes = {
                    { n = G.UIT.T, config = { text = '${input.name}', scale = 0.5, colour = G.C.UI.TEXT_LIGHT } }
                }
            }
        }
    }
end

-- Load your content files here.
-- SMODS.load_file('jokers/my_joker.lua')()
-- SMODS.load_file('consumables/my_tarot.lua')()

sendInfoMessage('${input.name} loaded.', '${input.prefix}')
`;
  await fs.writeFile(path.join(modDir, 'main.lua'), mainLua);

  // localization
  if (input.includeLocalization) {
    const locDir = path.join(modDir, 'localization');
    await fs.mkdir(locDir, { recursive: true });
    const escName = input.name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const escDesc = input.description.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const escPrefix = input.prefix.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    await fs.writeFile(
      path.join(locDir, 'en-us.lua'),
      `return {
    descriptions = {
        Mod = {
            ["${escPrefix}"] = {
                name = '${escName}',
                text = {
                    '${escDesc}'
                }
            }
        },
        Other = {},
        Edition = {},
        Enhanced = {},
        Joker = {},
        Consumable = {},
        Voucher = {},
        Back = {},
        Blind = {},
        Tag = {},
        Sticker = {},
    },
    misc = {
        dictionary = {},
        v_dictionary = {},
        v_text = {},
        achievement_names = {},
        achievement_descriptions = {},
        quips = {},
        labels = {},
        ranks = {},
        suits_plural = {},
        suits_singular = {},
        poker_hands = {},
        poker_hand_descriptions = {},
        challenge_names = {},
        tutorial = {},
    }
}
`
    );
  }

  if (input.includeAtlas) {
    await fs.mkdir(path.join(modDir, 'assets', '1x'), { recursive: true });
    await fs.mkdir(path.join(modDir, 'assets', '2x'), { recursive: true });
    await fs.writeFile(
      path.join(modDir, 'assets', 'README.md'),
      `Drop your atlas PNGs here. Use 1x/ for low-res and 2x/ for high-res.\n`
    );
  }

  if (input.includeLovely) {
    await fs.mkdir(path.join(modDir, 'lovely'), { recursive: true });
    await fs.writeFile(
      path.join(modDir, 'lovely', 'patches.toml'),
      `# Lovely patches for ${input.name}
# See: https://github.com/ethangreen-dev/lovely-injector

[manifest]
version = "1.0.0"
dump_lua = true
priority = 0

# Example patch -- edit or delete before shipping
[[patches]]
[patches.pattern]
target = "game.lua"
pattern = "-- some pattern"
position = "after"
payload = "print('hello from ${input.prefix}')"
match_indent = true
`
    );
  }

  // .gitignore — helpful default
  await fs.writeFile(
    path.join(modDir, '.gitignore'),
    `*.log\n.DS_Store\nThumbs.db\n`
  );

  // README
  await fs.writeFile(
    path.join(modDir, 'README.md'),
    `# ${input.name}\n\n${input.description}\n\n## Install\n\nCopy this folder into your Balatro \`Mods/\` directory.\n`
  );

  return modDir;
}

type ObjectKind =
  | 'joker' | 'consumable' | 'voucher' | 'back' | 'edition' | 'seal'
  | 'blind' | 'tag' | 'booster' | 'enhancement' | 'shader' | 'sound'
  | 'challenge';

interface ObjectSpec {
  folder: string;
  prompt: string;
  placeholder: string;
  render(prefix: string, key: string, name: string): string;
}

const OBJECT_SPECS: Record<ObjectKind, ObjectSpec> = {
  joker: {
    folder: 'jokers',
    prompt: 'Display name for the new Joker',
    placeholder: 'Lucky Cat',
    render: (prefix, key, name) => `SMODS.Joker {
    key = '${key}',
    loc_txt = {
        name = '${name}',
        text = {
            '{C:mult}+#1#{} Mult'
        }
    },
    config = { extra = { mult = 4 } },
    rarity = 1,
    atlas = '${prefix}_jokers',
    pos = { x = 0, y = 0 },
    cost = 4,
    blueprint_compat = true,
    eternal_compat  = true,
    loc_vars = function(self, info_queue, card)
        return { vars = { card.ability.extra.mult } }
    end,
    calculate = function(self, card, context)
        if context.joker_main then
            return {
                mult = card.ability.extra.mult,
                message = localize { type = 'variable', key = 'a_mult', vars = { card.ability.extra.mult } }
            }
        end
    end
}
`
  },
  consumable: {
    folder: 'consumables',
    prompt: 'Display name for the new Consumable',
    placeholder: 'Minor Arcana',
    render: (prefix, key, name) => `SMODS.Consumable {
    key = '${key}',
    set = 'Tarot',
    loc_txt = {
        name = '${name}',
        text = {
            'Creates {C:attention}#1#{} {C:tarot}Tarot{} card',
            '{C:inactive}(Must have room)'
        }
    },
    config = { extra = { amount = 1 } },
    atlas = '${prefix}_consumables',
    pos = { x = 0, y = 0 },
    cost = 3,
    loc_vars = function(self, info_queue, card)
        return { vars = { card.ability.extra.amount } }
    end,
    can_use = function(self, card)
        return #G.consumeables.cards + card.ability.extra.amount <= G.consumeables.config.card_limit
    end,
    use = function(self, card, area, copier)
        for i = 1, card.ability.extra.amount do
            G.E_MANAGER:add_event(Event({
                trigger = 'after', delay = 0.4,
                func = function()
                    SMODS.add_card { set = 'Tarot' }
                    return true
                end
            }))
        end
    end
}
`
  },
  voucher: {
    folder: 'vouchers',
    prompt: 'Display name for the new Voucher',
    placeholder: 'Clearance Sale',
    render: (prefix, key, name) => `SMODS.Voucher {
    key = '${key}',
    loc_txt = {
        name = '${name}',
        text = { 'Does a thing' }
    },
    config = { extra = { amount = 1 } },
    atlas = '${prefix}_vouchers',
    pos = { x = 0, y = 0 },
    cost = 10,
    unlocked = true,
    discovered = false,
    available = true,
    requires = {},
    loc_vars = function(self, info_queue, card)
        return { vars = { card.ability.extra.amount } }
    end,
    redeem = function(self, card)
        -- Apply voucher effect here.
    end
}
`
  },
  back: {
    folder: 'backs',
    prompt: 'Display name for the new Deck (Back)',
    placeholder: 'Ancient Deck',
    render: (prefix, key, name) => `SMODS.Back {
    key = '${key}',
    loc_txt = {
        name = '${name}',
        text = {
            'Start with {C:attention}+#1#{} hand size'
        }
    },
    config = { h_size = 1 },
    atlas = '${prefix}_decks',
    pos = { x = 0, y = 0 },
    loc_vars = function(self, info_queue, card)
        return { vars = { self.config.h_size } }
    end,
    apply = function(self, back)
        -- Apply deck effect here.
    end
}
`
  },
  edition: {
    folder: 'editions',
    prompt: 'Display name for the new Edition',
    placeholder: 'Glowing',
    render: (prefix, key, name) => `SMODS.Edition {
    key = '${key}',
    loc_txt = {
        name = '${name}',
        label = '${name}',
        text = { '{C:mult}+#1#{} Mult' }
    },
    config = { mult = 10 },
    shader = '${prefix}_${key}',
    in_shop = true,
    weight = 5,
    extra_cost = 3,
    apply_to_float = false,
    loc_vars = function(self, info_queue, card)
        return { vars = { self.config.mult } }
    end,
    calculate = function(self, card, context)
        if context.main_scoring then
            return { mult = self.config.mult }
        end
    end
}
`
  },
  seal: {
    folder: 'seals',
    prompt: 'Display name for the new Seal',
    placeholder: 'Mystery',
    render: (prefix, key, name) => `SMODS.Seal {
    key = '${key}',
    loc_txt = {
        name = '${name}',
        label = '${name} Seal',
        text = { 'Does a thing when scored' }
    },
    badge_colour = HEX('FFFFFF'),
    atlas = '${prefix}_seals',
    pos = { x = 0, y = 0 },
    calculate = function(self, card, context)
        if context.main_scoring then
            return { chips = 10 }
        end
    end
}
`
  },
  blind: {
    folder: 'blinds',
    prompt: 'Display name for the new Blind',
    placeholder: 'The Wraith',
    render: (prefix, key, name) => `SMODS.Blind {
    key = '${key}',
    loc_txt = {
        name = '${name}',
        text = { 'Does a mean thing' }
    },
    dollars = 5,
    mult = 2,
    boss = { min = 1, max = 10 },
    boss_colour = HEX('FF0000'),
    atlas = '${prefix}_blinds',
    pos = { x = 0, y = 0 },
    set_blind = function(self)
        -- Effect applied when blind is selected.
    end
}
`
  },
  tag: {
    folder: 'tags',
    prompt: 'Display name for the new Tag',
    placeholder: 'Lucky Tag',
    render: (prefix, key, name) => `SMODS.Tag {
    key = '${key}',
    loc_txt = {
        name = '${name}',
        text = { 'Does a helpful thing' }
    },
    config = { type = 'store_joker_create' },
    atlas = '${prefix}_tags',
    pos = { x = 0, y = 0 },
    apply = function(self, tag, context)
        -- Tag effect here.
    end
}
`
  },
  booster: {
    folder: 'boosters',
    prompt: 'Display name for the new Booster Pack',
    placeholder: 'Mega Pack',
    render: (prefix, key, name) => `SMODS.Booster {
    key = '${key}',
    loc_txt = {
        name = '${name}',
        text = {
            'Choose {C:attention}#1#{} of up to',
            '{C:attention}#2#{} cards'
        },
        group_name = 'Standard Pack'
    },
    config = { extra = 3, choose = 1 },
    atlas = '${prefix}_boosters',
    pos = { x = 0, y = 0 },
    cost = 4,
    weight = 1,
    draw_hand = true,
    kind = 'Standard',
    create_card = function(self, card)
        return create_card('Base', G.pack_cards, nil, nil, true, true, nil, '${key}')
    end
}
`
  },
  enhancement: {
    folder: 'enhancements',
    prompt: 'Display name for the new Enhancement',
    placeholder: 'Glass Shard',
    render: (prefix, key, name) => `SMODS.Enhancement {
    key = '${key}',
    loc_txt = {
        name = '${name}',
        text = { '{C:chips}+#1#{} chips' }
    },
    config = { bonus = 30 },
    atlas = '${prefix}_enhancements',
    pos = { x = 0, y = 0 },
    loc_vars = function(self, info_queue, card)
        return { vars = { card.ability.bonus } }
    end,
    calculate = function(self, card, context, effect)
        if context.main_scoring then
            return { chips = card.ability.bonus }
        end
    end
}
`
  },
  shader: {
    folder: 'shaders',
    prompt: 'Display name for the new Shader',
    placeholder: 'Glow',
    render: (_prefix, key, _name) => `SMODS.Shader {
    key = '${key}',
    path = 'shaders/${key}.fs'
}
`
  },
  sound: {
    folder: 'sounds',
    prompt: 'Display name for the new Sound',
    placeholder: 'Crit Hit',
    render: (_prefix, key, _name) => `SMODS.Sound {
    key = '${key}',
    path = '${key}.ogg',
    volume = 1,
    pitch = 1
}
`
  },
  challenge: {
    folder: 'challenges',
    prompt: 'Display name for the new Challenge',
    placeholder: 'Frugal Run',
    render: (_prefix, key, name) => `SMODS.Challenge {
    key = '${key}',
    loc_txt = { name = '${name}' },
    rules = {
        custom = {},
        modifiers = {
            { id = 'dollars',     value = 10 },
            { id = 'discards',    value = 3 },
            { id = 'hands',       value = 4 },
            { id = 'reroll_cost', value = 5 },
            { id = 'joker_slots', value = 5 },
            { id = 'hand_size',   value = 8 }
        }
    },
    jokers = {},
    consumeables = {},
    vouchers = {},
    deck = { type = 'Challenge Deck' },
    restrictions = { banned_cards = {}, banned_tags = {}, banned_other = {} }
}
`
  }
};

async function pickModRoot(): Promise<string | undefined> {
  const roots = findModRoots();
  if (roots.length === 1) {return roots[0];}
  if (roots.length === 0) {
    vscode.window.showErrorMessage(
      'No Smods mod folder detected in your workspace. Run "Smods: New Mod…" first.'
    );
    return undefined;
  }
  const pick = await vscode.window.showQuickPick(
    roots.map(r => ({ label: path.basename(r), description: r, path: r })),
    { title: 'Select target mod' }
  );
  return pick?.path;
}

async function scaffoldContentFile(kind: ObjectKind): Promise<void> {
  const activeEditor = vscode.window.activeTextEditor;
  const activeIsLua = activeEditor?.document.languageId === 'lua';

  const spec = OBJECT_SPECS[kind];
  const displayName = await vscode.window.showInputBox({
    prompt: spec.prompt,
    placeHolder: spec.placeholder
  });
  if (!displayName) {return;}

  const key = await vscode.window.showInputBox({
    prompt: 'Object key (lowercase, no spaces)',
    value: displayName.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, ''),
    validateInput: v => (v && !/\s/.test(v)) ? null : 'Required, no spaces.'
  });
  if (!key) {return;}

  // Decide: insert at cursor or create new file
  let insertInPlace = false;
  if (activeIsLua) {
    const choice = await vscode.window.showQuickPick(
      [
        { label: '$(edit) Insert at cursor', description: activeEditor!.document.fileName, id: 'cursor' },
        { label: '$(new-file) Create new file', description: `${spec.folder}/${key}.lua`, id: 'file' }
      ],
      { title: `Scaffold ${kind}` }
    );
    if (!choice) {return;}
    insertInPlace = choice.id === 'cursor';
  }

  const modRoot = await pickModRoot();
  if (!modRoot) {return;}

  const manifest = await findManifestFile(modRoot);
  const prefix = typeof manifest?.data.prefix === 'string'
    ? manifest.data.prefix : 'mod';

  const content = spec.render(prefix, key, displayName);

  if (insertInPlace) {
    const editor = activeEditor!;
    await editor.edit(eb => {
      const pos = editor.selection.active;
      eb.insert(pos, content);
    });
    return;
  }

  const targetDir = path.join(modRoot, spec.folder);
  await fs.mkdir(targetDir, { recursive: true });

  const filePath = path.join(targetDir, `${key}.lua`);

  try {
    await fs.access(filePath);
    const overwrite = await vscode.window.showWarningMessage(
      `${path.basename(filePath)} already exists. Overwrite?`,
      { modal: true }, 'Overwrite'
    );
    if (overwrite !== 'Overwrite') {return;}
  } catch { /* file doesn't exist, fine */ }

  await fs.writeFile(filePath, content);

  const doc = await vscode.workspace.openTextDocument(filePath);
  await vscode.window.showTextDocument(doc);

  vscode.window.showInformationMessage(
    `Created ${kind}: ${key}. Load it from main.lua via SMODS.load_file('${spec.folder}/${key}.lua')()`
  );
}

export function registerScaffoldCommands(
  context: vscode.ExtensionContext,
  output: vscode.LogOutputChannel
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('smods.newMod', async (
      resource?: vscode.Uri
    ) => {
      const input = await promptForMod();
      if (!input) {return;}

      // Target root: right-clicked folder, first workspace folder, or ask.
      let target: string | undefined;
      if (resource && resource.fsPath) {
        target = resource.fsPath;
      } else if (vscode.workspace.workspaceFolders?.length) {
        target = vscode.workspace.workspaceFolders[0].uri.fsPath;
      } else {
        const picked = await vscode.window.showOpenDialog({
          canSelectFolders: true,
          canSelectFiles: false,
          canSelectMany: false,
          openLabel: 'Create mod here'
        });
        target = picked?.[0]?.fsPath;
      }
      if (!target) {return;}

      try {
        const modDir = await writeModScaffold(target, input);
        output.info(`Scaffolded mod at ${modDir}`);
        const open = await vscode.window.showInformationMessage(
          `Created "${input.name}" at ${modDir}`,
          'Open main.lua', 'Open Folder'
        );
        if (open === 'Open main.lua') {
          const doc = await vscode.workspace.openTextDocument(
            path.join(modDir, 'main.lua')
          );
          await vscode.window.showTextDocument(doc);
        } else if (open === 'Open Folder') {
          await vscode.commands.executeCommand(
            'vscode.openFolder', vscode.Uri.file(modDir), { forceNewWindow: true }
          );
        }
      } catch (err) {
        output.error(`Scaffold failed: ${err}`);
        vscode.window.showErrorMessage(`Scaffold failed: ${err}`);
      }
    }),
    vscode.commands.registerCommand('smods.newJoker',
      () => scaffoldContentFile('joker')),
    vscode.commands.registerCommand('smods.newConsumable',
      () => scaffoldContentFile('consumable')),
    vscode.commands.registerCommand('smods.newVoucher',
      () => scaffoldContentFile('voucher')),
    vscode.commands.registerCommand('smods.newBack',
      () => scaffoldContentFile('back')),
    vscode.commands.registerCommand('smods.newEdition',
      () => scaffoldContentFile('edition')),
    vscode.commands.registerCommand('smods.newSeal',
      () => scaffoldContentFile('seal')),
    vscode.commands.registerCommand('smods.newBlind',
      () => scaffoldContentFile('blind')),
    vscode.commands.registerCommand('smods.newTag',
      () => scaffoldContentFile('tag')),
    vscode.commands.registerCommand('smods.newBooster',
      () => scaffoldContentFile('booster')),
    vscode.commands.registerCommand('smods.newEnhancement',
      () => scaffoldContentFile('enhancement')),
    vscode.commands.registerCommand('smods.newShader',
      () => scaffoldContentFile('shader')),
    vscode.commands.registerCommand('smods.newSound',
      () => scaffoldContentFile('sound')),
    vscode.commands.registerCommand('smods.newChallenge',
      () => scaffoldContentFile('challenge'))
  );
}
