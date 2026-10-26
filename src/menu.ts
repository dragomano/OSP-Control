import type { Translator } from './i18n';

export type OsPanelMenuItem = { id: string; fields: Record<string, string> };
export type OsPanelMenuDocument = { items: OsPanelMenuItem[]; revision: string };
export type OsPanelMenuSaveResult = { document: OsPanelMenuDocument; backupPath: string | null };
export type MenuDraft = { items: OsPanelMenuItem[]; categories: string[] };

export const MENU_SPECIAL_CATEGORIES = ['projects', 'modules', 'addons'] as const;
export const MENU_CONDITIONS = [
  'need_alias',
  'need_state',
  'need_start_cmd',
  'need_use_wt',
  'need_shell',
  'need_module_shell',
  'need_web_ui',
] as const;

export const categoryOf = (item: OsPanelMenuItem) => item.fields.category ?? '';

// Menu ordering is global in menu.dat. Moving one item must not reorder unrelated categories.
export function moveMenuItem(draft: MenuDraft, id: string, category: string, beforeId?: string): MenuDraft {
  const original = draft.items.find((item) => item.id === id);
  if (!original || beforeId === id) return draft;
  if (categoryOf(original) === category) {
    const peers = draft.items.filter((item) => categoryOf(item) === category);
    const index = peers.findIndex((item) => item.id === id);
    if (peers[index + 1]?.id === beforeId) return draft;
  }
  const item = { ...original, fields: { ...original.fields, category } };
  const items = draft.items.filter((item) => item.id !== id);
  let index = beforeId
    ? items.findIndex((item) => item.id === beforeId && categoryOf(item) === category)
    : -1;
  if (index < 0) {
    let last = -1;
    items.forEach((item, index) => {
      if (categoryOf(item) === category) last = index;
    });
    index = last < 0 ? items.length : last + 1;
  }
  items.splice(index, 0, item);
  return { ...draft, items };
}

export function menuCategories(draft: MenuDraft): string[] {
  const categories = new Set<string>(['', ...MENU_SPECIAL_CATEGORIES]);
  for (const path of [...draft.categories, ...draft.items.map(categoryOf)]) {
    categories.add(path);
    const index = path.indexOf('\\');
    if (index > 0) categories.add(path.slice(0, index));
  }
  return [...categories];
}

export function categoryLabel(path: string, t: Translator): string {
  if (!path) return t('menu.root');
  return path
    .split('\\')
    .map((part, index) =>
      index === 0 && MENU_SPECIAL_CATEGORIES.some((category) => category === part)
        ? t(`menu.category.${part}`)
        : part,
    )
    .join(' / ');
}

export function validCategory(path: string): boolean {
  if (!path) return true;
  const parts = path.split('\\');
  return (
    path.length <= 200 &&
    parts.length <= 2 &&
    parts.every(
      (part) =>
        part.trim().length > 0 &&
        part === part.trim() &&
        Array.from(part).every(
          (char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127 && char !== '[' && char !== ']',
        ),
    )
  );
}

export function renameMenuCategory(draft: MenuDraft, from: string, to: string): MenuDraft {
  if (!from || from === to || !validCategory(to)) return draft;
  const rename = (path: string) =>
    path === from ? to : path.startsWith(`${from}\\`) ? `${to}${path.slice(from.length)}` : path;
  const categories = menuCategories(draft).filter((path) => path === from || path.startsWith(`${from}\\`));
  if (categories.some((path) => !validCategory(rename(path)))) return draft;
  return {
    items: draft.items.map((item) => {
      const category = categoryOf(item);
      return rename(category) === category
        ? item
        : { ...item, fields: { ...item.fields, category: rename(category) } };
    }),
    categories: [...new Set(draft.categories.map(rename).concat(to))],
  };
}

const CAPTION_KEYS: Record<string, string> = {
  lang_open_in_browser: 'browser',
  lang_open_in_console: 'console',
  lang_open_in_explorer: 'explorer',
  lang_launch_app: 'launch',
  lang_launch_shell: 'shell',
  lang_initialize: 'initialize',
  lang_switch_on: 'on',
  lang_restart: 'restart',
  lang_switch_off: 'off',
  lang_cli: 'cli',
  lang_root_dir: 'root',
  lang_logs_viewer: 'logs',
  lang_idn_menu_caption: 'idn',
  lang_options: 'settings',
};

export function menuCaption(item: OsPanelMenuItem, t: Translator): string {
  const caption = item.fields.caption;
  if (!caption) return t(item.fields.need_alias === 'on' ? 'menu.aliasCaption' : 'menu.unnamed');
  return caption.replace(/\{(lang_\w+)\}/g, (match, name: string) => {
    const key = CAPTION_KEYS[name];
    return key ? t(`menu.caption.${key}`) : match;
  });
}

export function newMenuId(items: OsPanelMenuItem[]): string {
  const used = new Set(items.map((item) => item.id.toLowerCase()));
  let index = 1;
  while (used.has(`custom_${index}`)) index++;
  return `custom_${index}`;
}

export function menuMatches(item: OsPanelMenuItem, query: string, t: Translator): boolean {
  const text = `${item.id} ${menuCaption(item, t)} ${Object.values(item.fields).join(' ')}`;
  return text.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
}

export function menuDraft(items: OsPanelMenuItem[]): MenuDraft {
  return { items, categories: [...new Set(items.map(categoryOf))] };
}
