import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Copy,
  FileCode2,
  Folder,
  FolderOpen,
  FolderPlus,
  GripVertical,
  Info,
  ListTree,
  Plus,
  Redo2,
  RefreshCw,
  Search,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';
import {
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { errorText, useI18n } from '../../i18n';
import {
  categoryLabel,
  categoryOf,
  MENU_CONDITIONS,
  MENU_SPECIAL_CATEGORIES,
  type MenuDraft,
  menuCaption,
  menuCategories,
  menuDraft,
  menuMatches,
  moveMenuItem,
  newMenuId,
  type OsPanelMenuDocument,
  type OsPanelMenuItem,
  renameMenuCategory,
  validCategory,
} from '../../menu';
import { MenuIcon } from '../../menuIcons';
import { askConfirm, isDesktopApp, openFileExternally, readMenu, writeMenu } from '../../ospanel';
import { settingsStorage } from '../../settingsStorage';
import { MenuIconPicker } from '../dialogs/MenuIconPicker';
import { type Notify, useDismiss } from '../shared';
import { PageHeader } from '../widgets/PageHeader';
import './menuEditor.css';

type Selection = { kind: 'item'; id: string } | { kind: 'category'; path: string };
type History = { past: MenuDraft[]; present: MenuDraft; future: MenuDraft[] };
type Drag = {
  id: string;
  startX: number;
  startY: number;
  x: number;
  y: number;
  moved: boolean;
  category: string | null;
  before?: string;
};
const emptyHistory = (draft: MenuDraft): History => ({ past: [], present: draft, future: [] });
const treeStorageKey = (path: string | null) =>
  `ospanel.menuTree.${path?.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() || 'default'}`;

function readCollapsedCategories(key: string, categories: string[], fallback: string[]): string[] {
  try {
    const stored: unknown = JSON.parse(settingsStorage.getItem(key) ?? 'null');
    if (Array.isArray(stored) && stored.every((path) => typeof path === 'string'))
      return [...new Set(stored)].filter((path) => categories.includes(path));
  } catch {
    // Unavailable or invalid view preferences must not prevent editing the menu.
  }
  return fallback;
}

export function MenuEditor({
  notify,
  installationPath,
  active,
  blocked,
  onRestart,
  onOpenBackups,
  onStateChange,
  reloadVersion = 0,
}: {
  notify: Notify;
  installationPath: string | null;
  active: boolean;
  blocked: boolean;
  onRestart: () => void;
  onOpenBackups: () => void;
  onStateChange?: (state: { dirty: boolean; busy: boolean }) => void;
  reloadVersion?: number;
}) {
  const { t } = useI18n();
  const storageKey = treeStorageKey(installationPath);
  const [saved, setSaved] = useState<OsPanelMenuDocument | null>(null);
  const [history, setHistory] = useState<History>(() => emptyHistory(menuDraft([])));
  const [selection, setSelection] = useState<Selection>({ kind: 'category', path: '' });
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [iconOpen, setIconOpen] = useState(false);
  const [categoryDialog, setCategoryDialog] = useState(false);
  const [categoryName, setCategoryName] = useState('');
  const [categoryParent, setCategoryParent] = useState('');
  const [categoryEdit, setCategoryEdit] = useState('');
  const [drag, setDrag] = useState<Drag | null>(null);
  const requestRef = useRef(0);
  const loadedTreeKeyRef = useRef<string | null>(null);
  const savedCollapsedRef = useRef('');
  const editBatchRef = useRef('');
  const dragRef = useRef<Drag | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const categoryInputRef = useRef<HTMLInputElement>(null);
  const categoryDialogRef = useRef<HTMLFormElement>(null);
  useDismiss(categoryDialogRef, () => setCategoryDialog(false), categoryDialog && active);
  const draft = history.present;
  const dirty = saved !== null && JSON.stringify(draft.items) !== JSON.stringify(saved.items);
  const categories = menuCategories(draft);
  const item = selection.kind === 'item' ? draft.items.find((item) => item.id === selection.id) : undefined;
  const selectedCategory = selection.kind === 'category' ? selection.path : item ? categoryOf(item) : '';
  const isSpecial = MENU_SPECIAL_CATEGORIES.some((path) => path === selectedCategory);
  const disabled = busy || loading || blocked;

  useEffect(() => {
    onStateChange?.({ dirty, busy: busy || loading });
  }, [dirty, busy, loading, onStateChange]);

  const change = (next: MenuDraft, batch = '') => {
    const merge = batch !== '' && editBatchRef.current === batch;
    editBatchRef.current = batch;
    setHistory((previous) => {
      if (JSON.stringify(previous.present) === JSON.stringify(next)) return previous;
      return {
        past: merge ? previous.past : [...previous.past, previous.present].slice(-50),
        present: next,
        future: [],
      };
    });
  };
  const setField = (key: string, value: string, batch = '') => {
    if (!item || disabled) return;
    const fields = { ...item.fields };
    if (value === '') delete fields[key];
    else fields[key] = value;
    change(
      { ...draft, items: draft.items.map((entry) => (entry.id === item.id ? { ...item, fields } : entry)) },
      batch,
    );
  };
  const chooseCategory = (path: string) => {
    setSelection({ kind: 'category', path });
    setCategoryEdit(path);
    editBatchRef.current = '';
  };
  const load = useCallback(async () => {
    const request = ++requestRef.current;
    loadedTreeKeyRef.current = null;
    setLoading(true);
    setLoadError('');
    try {
      const document = await readMenu(installationPath);
      if (request !== requestRef.current) return;
      const nextDraft = menuDraft(document.items);
      setSaved(document);
      setHistory(emptyHistory(nextDraft));
      const first = document.items.find((item) => !categoryOf(item)) ?? document.items[0];
      setSelection(first ? { kind: 'item', id: first.id } : { kind: 'category', path: '' });
      setQuery('');
      const nextCollapsed = readCollapsedCategories(
        storageKey,
        menuCategories(nextDraft),
        MENU_SPECIAL_CATEGORIES.filter((path) => path !== (first ? categoryOf(first) : '')),
      );
      savedCollapsedRef.current = JSON.stringify(nextCollapsed);
      setCollapsed(nextCollapsed);
      loadedTreeKeyRef.current = storageKey;
      setIconOpen(false);
      setCategoryDialog(false);
    } catch (error) {
      if (request === requestRef.current) setLoadError(errorText(t, error, 'menu.loadFailed'));
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, [installationPath, storageKey, t]);
  // The locale may hot-reload while a draft is edited; it must never trigger a disk reload.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload only for installation changes or a confirmed restore
  useEffect(() => {
    setSaved(null);
    void load();
    return () => {
      requestRef.current++;
    };
  }, [installationPath, reloadVersion]);
  useEffect(() => {
    if (loading || loadedTreeKeyRef.current !== storageKey) return;
    const serialized = JSON.stringify(collapsed);
    if (serialized === savedCollapsedRef.current) return;
    try {
      settingsStorage.setItem(storageKey, serialized);
      savedCollapsedRef.current = serialized;
    } catch {
      // The current view remains usable if preference storage is unavailable.
    }
  }, [collapsed, loading, storageKey]);
  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [dirty]);
  useEffect(() => {
    if (!categoryDialog || !active) return;
    const previous = document.activeElement;
    categoryInputRef.current?.focus();
    return () => {
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, [categoryDialog, active]);

  const save = async () => {
    if (!saved || !dirty || disabled) return;
    const request = requestRef.current;
    setBusy(true);
    try {
      const result = await writeMenu(draft.items, saved.revision, installationPath);
      if (request !== requestRef.current) return;
      setSaved(result.document);
      setHistory(emptyHistory(menuDraft(result.document.items)));
      notify(
        t(isDesktopApp() ? 'menu.saved' : 'menu.demoSaved'),
        isDesktopApp()
          ? {
              label: t('projects.restartPanel'),
              run: onRestart,
            }
          : undefined,
      );
    } catch (error) {
      if (request === requestRef.current) notify(errorText(t, error, 'menu.saveFailed'));
    } finally {
      setBusy(false);
    }
  };
  const undo = (redo = false) => {
    editBatchRef.current = '';
    setHistory((previous) => {
      const source = redo ? previous.future : previous.past;
      if (!source.length) return previous;
      const next = source[source.length - 1];
      return redo
        ? { past: [...previous.past, previous.present], present: next, future: source.slice(0, -1) }
        : { past: source.slice(0, -1), present: next, future: [...previous.future, previous.present] };
    });
  };
  useEffect(() => {
    if (!active) {
      dragRef.current = null;
      setDrag(null);
      return;
    }
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIconOpen(false);
        setCategoryDialog(false);
        dragRef.current = null;
        setDrag(null);
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void save();
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });

  const move = (id: string, category: string, before?: string) => {
    change(moveMenuItem(draft, id, category, before));
    setCollapsed((previous) => previous.filter((path) => path !== category));
    setSelection({ kind: 'item', id });
    setQuery('');
  };
  const shift = (direction: -1 | 1) => {
    if (!item) return;
    const peers = draft.items.filter((entry) => categoryOf(entry) === categoryOf(item));
    const index = peers.findIndex((entry) => entry.id === item.id);
    if (index + direction < 0 || index + direction >= peers.length) return;
    move(item.id, categoryOf(item), direction < 0 ? peers[index - 1].id : peers[index + 2]?.id);
  };
  const addItem = (category = selectedCategory) => {
    const id = newMenuId(draft.items);
    const next = { id, fields: { caption: t('menu.newItem'), category, command: '', icon: 'terminal' } };
    change({ ...draft, items: [...draft.items, next] });
    setSelection({ kind: 'item', id });
    setCollapsed((previous) => previous.filter((path) => path !== category));
    setQuery('');
  };
  const startDrag = (event: ReactPointerEvent<HTMLButtonElement>, id: string) => {
    if (disabled || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragRef.current = {
      id,
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      moved: false,
      category: null,
    };
  };
  const dragMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const current = dragRef.current;
    if (!current) return;
    if (!current.moved && Math.hypot(event.clientX - current.startX, event.clientY - current.startY) < 5)
      return;
    const hit = document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>('[data-menu-drop]');
    const target = hit && rootRef.current?.contains(hit) ? hit : null;
    const category = target?.getAttribute('data-menu-drop') ?? null;
    const targetId = target?.dataset.menuItem;
    let before = targetId;
    if (
      targetId &&
      target &&
      event.clientY > target.getBoundingClientRect().top + target.getBoundingClientRect().height / 2
    ) {
      const peers = draft.items.filter((entry) => categoryOf(entry) === category);
      before = peers[peers.findIndex((entry) => entry.id === targetId) + 1]?.id;
    }
    dragRef.current = { ...current, x: event.clientX, y: event.clientY, moved: true, category, before };
    setDrag(dragRef.current);
  };
  const endDrag = (event: ReactPointerEvent<HTMLButtonElement>, cancel = false) => {
    const current = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    if (!cancel && current?.moved && current.category !== null)
      move(current.id, current.category, current.before);
  };

  const selectItem = (id: string) => {
    setSelection({ kind: 'item', id });
    editBatchRef.current = '';
  };
  const renderCategory = (path: string, nested = false): ReactNode => {
    const entries = draft.items.filter((entry) => categoryOf(entry) === path && menuMatches(entry, query, t));
    const children = categories.filter(
      (category) => category.includes('\\') && category.slice(0, category.indexOf('\\')) === path,
    );
    const matches = !query || categoryLabel(path, t).toLowerCase().includes(query.toLowerCase());
    const visibleEntries = matches ? draft.items.filter((entry) => categoryOf(entry) === path) : entries;
    const childMatches = children.some(
      (category) =>
        categoryLabel(category, t).toLowerCase().includes(query.toLowerCase()) ||
        draft.items.some((entry) => categoryOf(entry) === category && menuMatches(entry, query, t)),
    );
    if (!matches && !visibleEntries.length && !childMatches) return null;
    const closed = !query && collapsed.includes(path);
    const count = draft.items.filter((entry) => categoryOf(entry) === path).length;
    return (
      <li key={path} className={`menu-category ${nested ? 'nested' : ''}`}>
        <div
          className={`menu-category-heading ${selection.kind === 'category' && selection.path === path ? 'selected' : ''} ${drag?.category === path && !drag.before ? 'drop-target' : ''}`}
          data-menu-drop={path}
        >
          <button
            type="button"
            className="icon-button menu-collapse"
            aria-label={t(closed ? 'menu.expand' : 'menu.collapse', { name: categoryLabel(path, t) })}
            aria-expanded={!closed}
            onClick={() => {
              setQuery('');
              setCollapsed((previous) =>
                closed ? previous.filter((category) => category !== path) : [...new Set([...previous, path])],
              );
            }}
          >
            {closed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          </button>
          <button type="button" className="menu-category-label" onClick={() => chooseCategory(path)}>
            {path ? <Folder size={15} /> : <ListTree size={15} />}
            <span>{nested ? path.split('\\')[1] : categoryLabel(path, t)}</span>
            <small>{count}</small>
          </button>
          <button
            type="button"
            className="icon-button"
            title={t('menu.addItemHere')}
            aria-label={t('menu.addItemHere')}
            onClick={() => addItem(path)}
          >
            <Plus size={14} />
          </button>
        </div>
        {!closed && (
          <ul className="menu-tree-children">
            {visibleEntries.map((entry) => (
              <li
                key={entry.id}
                data-menu-item={entry.id}
                data-menu-drop={path}
                className={`menu-tree-item ${selection.kind === 'item' && selection.id === entry.id ? 'selected' : ''} ${entry.fields.enabled === 'off' ? 'muted' : ''} ${drag?.before === entry.id && drag.category === path ? 'drop-before' : ''} ${drag?.id === entry.id ? 'dragging' : ''}`}
              >
                <button
                  type="button"
                  className="menu-drag-handle"
                  aria-label={t('menu.dragItem', { name: menuCaption(entry, t) })}
                  title={t('menu.dragHint')}
                  onPointerDown={(event) => startDrag(event, entry.id)}
                  onPointerMove={dragMove}
                  onPointerUp={(event) => endDrag(event)}
                  onPointerCancel={(event) => endDrag(event, true)}
                >
                  <GripVertical size={14} />
                </button>
                <button type="button" className="menu-item-main" onClick={() => selectItem(entry.id)}>
                  <span className="menu-item-symbol">
                    <MenuIcon name={entry.fields.icon} />
                  </span>
                  <span>{menuCaption(entry, t)}</span>
                  {entry.fields.hr_before === 'on' || entry.fields.hr_after === 'on' ? (
                    <span className="menu-separator-mark" title={t('menu.separators')}>
                      —
                    </span>
                  ) : null}
                </button>
                <ChevronRight size={13} aria-hidden="true" />
              </li>
            ))}
            {!visibleEntries.length && !children.length && (
              <li className="menu-empty-group">{t('menu.emptyCategory')}</li>
            )}
            {children.map((category) => renderCategory(category, true))}
          </ul>
        )}
      </li>
    );
  };

  const field = (key: string, label: string, monospace = false) => (
    <label className="menu-field" key={key}>
      <span>{t(label)}</span>
      <input
        className={monospace ? 'menu-monospace' : undefined}
        value={item?.fields[key] ?? ''}
        onChange={(event) => setField(key, event.target.value, `${item?.id}:${key}`)}
        onBlur={() => {
          editBatchRef.current = '';
        }}
      />
    </label>
  );
  const toggle = (key: string, label: string, defaultOn = false) => (
    <label className="menu-check" key={key}>
      <input
        type="checkbox"
        checked={item?.fields[key] === 'on' || (defaultOn && item?.fields[key] !== 'off')}
        onChange={(event) => setField(key, event.target.checked ? 'on' : 'off')}
      />
      <span>{t(label)}</span>
    </label>
  );
  const peers = item ? draft.items.filter((entry) => categoryOf(entry) === categoryOf(item)) : [];
  const position = peers.findIndex((entry) => entry.id === item?.id);
  const unknown = item
    ? Object.keys(item.fields).filter(
        (key) =>
          ![
            'caption',
            'category',
            'command',
            'icon',
            'enabled',
            'hide',
            'hr_before',
            'hr_after',
            'work_directory',
            'need_category',
            ...MENU_CONDITIONS,
          ].includes(key),
      )
    : [];
  const categoryUsed = draft.items.some(
    (entry) =>
      categoryOf(entry) === selectedCategory || categoryOf(entry).startsWith(`${selectedCategory}\\`),
  );
  const renameValid =
    categoryEdit !== selectedCategory &&
    categoryEdit !== '' &&
    validCategory(categoryEdit) &&
    !categories.includes(categoryEdit) &&
    menuCategories(draft)
      .filter((path) => path.startsWith(`${selectedCategory}\\`))
      .every((path) => validCategory(`${categoryEdit}${path.slice(selectedCategory.length)}`));

  return (
    <div className="menu-editor" ref={rootRef}>
      <PageHeader
        eyebrow={t('nav.workspace')}
        heading={t('nav.menu')}
        description={t('menu.subtitle')}
        action={
          <div className="menu-header-actions">
            <button
              type="button"
              className="secondary-button"
              disabled={busy || blocked}
              onClick={onOpenBackups}
            >
              <Copy size={16} />
              {t('nav.backups')}
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={!dirty || disabled || !!loadError}
              onClick={() => void save()}
            >
              <Check size={16} />
              {t('common.save')}
            </button>
          </div>
        }
      />
      {!isDesktopApp() && (
        <div className="menu-notice">
          <Info size={15} />
          <span>{t('menu.browserNotice')}</span>
        </div>
      )}
      {loadError ? (
        <div className="backup-load-error" role="alert">
          <span>{loadError}</span>
          <button type="button" className="text-button" onClick={() => void load()}>
            {t('menu.reload')}
          </button>
        </div>
      ) : loading ? (
        <div className="empty-note" role="status">
          {t('common.loading')}
        </div>
      ) : (
        <fieldset className="menu-editor-fields" disabled={disabled}>
          <div className="menu-toolbar">
            <label className="search-field">
              <Search size={15} />
              <input
                aria-label={t('menu.search')}
                placeholder={t('menu.search')}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <div className="menu-history">
              <button
                type="button"
                className="icon-button"
                disabled={!history.past.length}
                aria-label={t('menu.undo')}
                title={t('menu.undo')}
                onClick={() => undo()}
              >
                <Undo2 size={16} />
              </button>
              <button
                type="button"
                className="icon-button"
                disabled={!history.future.length}
                aria-label={t('menu.redo')}
                title={t('menu.redo')}
                onClick={() => undo(true)}
              >
                <Redo2 size={16} />
              </button>
            </div>
            <button
              type="button"
              className="secondary-button"
              onClick={() => {
                setCategoryName('');
                setCategoryParent(
                  selectedCategory && !selectedCategory.includes('\\') ? selectedCategory : '',
                );
                setCategoryDialog(true);
              }}
            >
              <FolderPlus size={15} />
              {t('menu.addCategory')}
            </button>
            <button type="button" className="secondary-button" onClick={() => addItem()}>
              <Plus size={15} />
              {t('menu.addItem')}
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label={t('menu.reload')}
              title={t('menu.reload')}
              onClick={() =>
                void (async () => {
                  if (!dirty || (await askConfirm(t('menu.discardConfirm'), t('common.confirmTitle'))))
                    await load();
                })()
              }
            >
              <RefreshCw size={15} />
            </button>
          </div>
          <div className="menu-editor-layout">
            <section className="menu-tree-panel" aria-label={t('menu.structure')}>
              <div className="menu-panel-head">
                <div className="menu-panel-title">
                  <strong>
                    <ListTree size={16} />
                    {t('menu.structure')}
                  </strong>
                  <span>{t('menu.itemCount', { n: draft.items.length })}</span>
                </div>
                <div className="menu-tree-actions">
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => {
                      setQuery('');
                      setCollapsed(categories);
                    }}
                  >
                    <ChevronsDownUp size={14} aria-hidden="true" />
                    <span>{t('menu.collapseAll')}</span>
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => {
                      setQuery('');
                      setCollapsed([]);
                    }}
                  >
                    <ChevronsUpDown size={14} aria-hidden="true" />
                    <span>{t('menu.expandAll')}</span>
                  </button>
                </div>
              </div>
              <ul className="menu-tree">
                {categories.filter((path) => !path.includes('\\')).map((path) => renderCategory(path))}
              </ul>
              {query &&
                !draft.items.some((entry) => menuMatches(entry, query, t)) &&
                !categories.some((path) =>
                  categoryLabel(path, t).toLowerCase().includes(query.toLowerCase()),
                ) && <div className="empty-note">{t('common.empty')}</div>}
            </section>
            <aside className="menu-inspector" aria-label={t('menu.properties')}>
              {item ? (
                <>
                  <div className="menu-inspector-head">
                    <button
                      type="button"
                      className="menu-icon-choice"
                      title={t('menu.chooseIcon')}
                      aria-label={t('menu.chooseIcon')}
                      onClick={() => setIconOpen(true)}
                    >
                      {item.fields.icon ? <MenuIcon name={item.fields.icon} /> : <Plus size={20} />}
                    </button>
                    <div>
                      <span className="menu-inspector-kicker">{t('menu.properties')}</span>
                      <strong>{menuCaption(item, t)}</strong>
                    </div>
                  </div>
                  {field('caption', 'menu.name')}
                  <label className="menu-field">
                    <span>{t('menu.category')}</span>
                    <select value={categoryOf(item)} onChange={(event) => move(item.id, event.target.value)}>
                      {categories.map((path) => (
                        <option key={path} value={path}>
                          {categoryLabel(path, t)}
                        </option>
                      ))}
                    </select>
                  </label>
                  {field('command', 'menu.command', true)}
                  {!item.fields.command?.trim() && <p className="menu-warning">{t('menu.noCommand')}</p>}
                  {toggle('enabled', 'menu.visible', true)}
                  <div className="menu-item-actions">
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={position <= 0}
                      onClick={() => shift(-1)}
                    >
                      <ArrowUp size={14} />
                      {t('menu.up')}
                    </button>
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={position >= peers.length - 1}
                      onClick={() => shift(1)}
                    >
                      <ArrowDown size={14} />
                      {t('menu.down')}
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={t('menu.duplicate')}
                      title={t('menu.duplicate')}
                      onClick={() => {
                        const copy: OsPanelMenuItem = {
                          ...item,
                          id: newMenuId(draft.items),
                          fields: {
                            ...item.fields,
                            caption: t('menu.copyName', { name: menuCaption(item, t) }),
                          },
                        };
                        // OSPanel permits only one alias action in the entire template.
                        if (copy.fields.need_alias === 'on') copy.fields.need_alias = 'off';
                        const items = [...draft.items];
                        items.splice(items.findIndex((entry) => entry.id === item.id) + 1, 0, copy);
                        change({ ...draft, items });
                        selectItem(copy.id);
                      }}
                    >
                      <Copy size={15} />
                    </button>
                    <button
                      type="button"
                      className="icon-button menu-remove"
                      aria-label={t('menu.deleteItem')}
                      title={t('menu.deleteItem')}
                      onClick={() => {
                        change({ ...draft, items: draft.items.filter((entry) => entry.id !== item.id) });
                        chooseCategory(categoryOf(item));
                      }}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                  <details className="menu-advanced">
                    <summary>{t('menu.advanced')}</summary>
                    <div className="menu-advanced-body">
                      <label className="menu-field">
                        <span>{t('menu.iconName')}</span>
                        <input
                          value={item.fields.icon ?? ''}
                          onChange={(event) => setField('icon', event.target.value, `${item.id}:icon`)}
                          onBlur={() => {
                            editBatchRef.current = '';
                          }}
                        />
                      </label>
                      {field('work_directory', 'menu.workDirectory', true)}
                      {toggle('hide', 'menu.hideWindow')}
                      {toggle('hr_before', 'menu.separatorBefore')}
                      {toggle('hr_after', 'menu.separatorAfter')}
                      {MENU_CONDITIONS.map((key) => (
                        <label className="menu-field" key={key}>
                          <span>
                            {t(`menu.condition.${key}`)}
                            <code>{key}</code>
                          </span>
                          <select
                            value={item.fields[key] ?? ''}
                            onChange={(event) => setField(key, event.target.value)}
                          >
                            <option value="">{t('menu.conditionAny')}</option>
                            <option value="on">{t('menu.conditionYes')}</option>
                            <option value="off">{t('menu.conditionNo')}</option>
                          </select>
                        </label>
                      ))}
                      {field('need_category', 'menu.needCategory')}
                      {unknown.map((key) => (
                        <label className="menu-field" key={key}>
                          <span>{key}</span>
                          <input
                            value={item.fields[key]}
                            onChange={(event) => setField(key, event.target.value, `${item.id}:${key}`)}
                            onBlur={() => {
                              editBatchRef.current = '';
                            }}
                          />
                        </label>
                      ))}
                      <p className="menu-muted">{t('menu.sectionId', { id: item.id })}</p>
                    </div>
                  </details>
                </>
              ) : (
                <>
                  <div className="menu-inspector-head">
                    <span className="menu-icon-choice">
                      <Folder size={21} />
                    </span>
                    <div>
                      <span className="menu-inspector-kicker">{t('menu.categoryProperties')}</span>
                      <strong>{categoryLabel(selectedCategory, t)}</strong>
                    </div>
                  </div>
                  {!selectedCategory || isSpecial ? (
                    <p className="menu-muted">{t('menu.specialCategory')}</p>
                  ) : (
                    <>
                      <form
                        onSubmit={(event) => {
                          event.preventDefault();
                          if (!renameValid) return;
                          change(renameMenuCategory(draft, selectedCategory, categoryEdit));
                          chooseCategory(categoryEdit);
                        }}
                      >
                        <label className="menu-field">
                          <span>{t('menu.categoryPath')}</span>
                          <input
                            value={categoryEdit}
                            onChange={(event) => setCategoryEdit(event.target.value)}
                          />
                        </label>
                        <button type="submit" className="secondary-button" disabled={!renameValid}>
                          {t('menu.renameCategory')}
                        </button>
                      </form>
                      <p className="menu-muted">{t('menu.categoryHelp')}</p>
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={
                          categoryUsed || categories.some((path) => path.startsWith(`${selectedCategory}\\`))
                        }
                        onClick={() => {
                          change({
                            ...draft,
                            categories: draft.categories.filter((path) => path !== selectedCategory),
                          });
                          chooseCategory('');
                        }}
                      >
                        <Trash2 size={14} />
                        {t('menu.deleteCategory')}
                      </button>
                    </>
                  )}
                  <p className="menu-muted">
                    {t(categoryUsed ? 'menu.moveItemsFirst' : 'menu.emptyCategoryHint')}
                  </p>
                  <button type="button" className="secondary-button" onClick={() => addItem()}>
                    <Plus size={14} />
                    {t('menu.addItemHere')}
                  </button>
                </>
              )}
            </aside>
          </div>
          <div className="menu-editor-foot">
            <span>
              <GripVertical size={14} />
              {t('menu.dragHint')}
            </span>
            <span role="status">{dirty ? t('menu.unsaved') : t('menu.upToDate')}</span>
          </div>
          <p className="menu-file-note">
            <Info size={14} />
            <button type="button" className="text-button menu-backup-hint" onClick={onOpenBackups}>
              {t('menu.saveHint')}
            </button>
            <button
              type="button"
              className="text-button"
              disabled={!isDesktopApp()}
              onClick={() =>
                void openFileExternally(`${installationPath}\\system\\menu.dat`).catch((error) =>
                  notify(errorText(t, error, 'menu.loadFailed')),
                )
              }
            >
              <FileCode2 size={13} />
              system/menu.dat
            </button>
          </p>
        </fieldset>
      )}
      {iconOpen && active && item && (
        <MenuIconPicker
          value={item.fields.icon ?? ''}
          onClose={() => setIconOpen(false)}
          onSelect={(value) => {
            setField('icon', value);
            setIconOpen(false);
          }}
        />
      )}
      {categoryDialog && active && (
        <div className="modal-overlay">
          <form
            ref={categoryDialogRef}
            className="modal-window"
            role="dialog"
            aria-modal="true"
            aria-label={t('menu.newCategory')}
            onKeyDown={(event) => {
              if (event.key !== 'Tab') return;
              const controls = categoryDialogRef.current?.querySelectorAll<HTMLElement>(
                'button:not(:disabled), input, select',
              );
              if (!controls?.length) return;
              const first = controls[0];
              const last = controls[controls.length - 1];
              if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
              } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
              }
            }}
            onSubmit={(event) => {
              event.preventDefault();
              const path = categoryParent ? `${categoryParent}\\${categoryName.trim()}` : categoryName.trim();
              if (!path || !validCategory(path) || categories.includes(path)) return;
              change({ ...draft, categories: [...draft.categories, path] });
              chooseCategory(path);
              setCategoryDialog(false);
              setQuery('');
            }}
          >
            <div className="modal-head">
              <h2 className="modal-title">{t('menu.newCategory')}</h2>
              <button
                type="button"
                className="icon-button"
                aria-label={t('common.close')}
                onClick={() => setCategoryDialog(false)}
              >
                <X size={17} />
              </button>
            </div>
            <div className="modal-body">
              <label className="menu-field">
                <span>{t('menu.name')}</span>
                <input
                  ref={categoryInputRef}
                  value={categoryName}
                  maxLength={100}
                  required
                  onChange={(event) => setCategoryName(event.target.value)}
                />
              </label>
              <label className="menu-field">
                <span>{t('menu.parentCategory')}</span>
                <select value={categoryParent} onChange={(event) => setCategoryParent(event.target.value)}>
                  {categories
                    .filter((path) => !path.includes('\\'))
                    .map((path) => (
                      <option key={path} value={path}>
                        {categoryLabel(path, t)}
                      </option>
                    ))}
                </select>
              </label>
              <p className="menu-muted">{t('menu.categoryHelp')}</p>
            </div>
            <div className="modal-foot">
              <span className="menu-muted">{t('menu.emptyCategoryHint')}</span>
              <button
                type="submit"
                className="primary-button"
                disabled={
                  !categoryName.trim() ||
                  !validCategory(
                    categoryParent ? `${categoryParent}\\${categoryName.trim()}` : categoryName.trim(),
                  ) ||
                  categories.includes(
                    categoryParent ? `${categoryParent}\\${categoryName.trim()}` : categoryName.trim(),
                  )
                }
              >
                <FolderPlus size={15} />
                {t('menu.createCategory')}
              </button>
            </div>
          </form>
        </div>
      )}
      {drag?.moved && (
        <div
          className="menu-drag-preview"
          style={{ left: Math.min(drag.x + 12, window.innerWidth - 210), top: drag.y + 12 }}
          aria-hidden="true"
        >
          <FolderOpen size={15} />
          {menuCaption(draft.items.find((item) => item.id === drag.id) ?? { id: '', fields: {} }, t)}
        </div>
      )}
    </div>
  );
}
