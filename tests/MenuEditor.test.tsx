import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MenuEditor } from '../src/components/pages/MenuEditor';
import { embeddedDict, I18nContext, makePlural, makeTranslator } from '../src/i18n';
import type { OsPanelMenuDocument, OsPanelMenuItem } from '../src/menu';
import { readMenu, writeMenu } from '../src/ospanel';

vi.mock('../src/ospanel', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/ospanel')>()),
  readMenu: vi.fn(),
  writeMenu: vi.fn(),
}));
const t = makeTranslator(embeddedDict('en'), embeddedDict('en'));
const plural = makePlural(t, 'en', embeddedDict('en'));
const original: OsPanelMenuItem[] = [
  {
    id: 'editor',
    fields: {
      caption: 'My editor',
      command: 'code.exe',
      category: 'Tools',
      icon: 'code',
      future_option: 'keep',
      need_use_wt: 'off',
    },
  },
  { id: 'terminal', fields: { caption: 'Terminal', command: 'wt.exe', category: 'Tools', icon: 'terminal' } },
  { id: 'database', fields: { caption: 'Database', command: 'db.exe', category: 'Data', icon: 'database' } },
];
const notify = vi.fn();
const onRestart = vi.fn();
const onOpenBackups = vi.fn();
const mount = (path = 'C:/Panel') =>
  render(
    <I18nContext.Provider value={{ lang: 'en', t, plural }}>
      <MenuEditor
        notify={notify}
        installationPath={path}
        active
        blocked={false}
        onRestart={onRestart}
        onOpenBackups={onOpenBackups}
      />
    </I18nContext.Provider>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readMenu).mockResolvedValue({ items: structuredClone(original), revision: 'initial' });
  vi.mocked(writeMenu).mockImplementation(async (items) => ({
    document: { items, revision: 'saved' },
    backupPath: null,
  }));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('MenuEditor', () => {
  it('opens backups without discarding the draft and reloads after a confirmed restore', async () => {
    const onStateChange = vi.fn();
    const view = render(
      <I18nContext.Provider value={{ lang: 'en', t, plural }}>
        <MenuEditor
          notify={notify}
          installationPath="C:/Panel"
          active
          blocked={false}
          onRestart={onRestart}
          onOpenBackups={onOpenBackups}
          onStateChange={onStateChange}
        />
      </I18nContext.Provider>,
    );
    fireEvent.change(await screen.findByRole('textbox', { name: 'Name' }), { target: { value: 'Draft' } });
    expect(onStateChange).toHaveBeenLastCalledWith({ dirty: true, busy: false });
    fireEvent.click(screen.getByRole('button', { name: 'Backups' }));
    expect(onOpenBackups).toHaveBeenCalledOnce();
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Draft');
    const restored = structuredClone(original);
    restored[0].fields.caption = 'Restored editor';
    vi.mocked(readMenu).mockResolvedValue({ items: restored, revision: 'restored' });
    view.rerender(
      <I18nContext.Provider value={{ lang: 'en', t, plural }}>
        <MenuEditor
          notify={notify}
          installationPath="C:/Panel"
          active={false}
          blocked={false}
          onRestart={onRestart}
          onOpenBackups={onOpenBackups}
          onStateChange={onStateChange}
          reloadVersion={1}
        />
      </I18nContext.Provider>,
    );
    expect(await screen.findByRole('textbox', { name: 'Name' })).toHaveValue('Restored editor');
    expect(onStateChange).toHaveBeenLastCalledWith({ dirty: false, busy: false });
    expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled();
    expect(writeMenu).not.toHaveBeenCalled();
  });

  it('keeps edits local until save and preserves native conditions and unknown properties', async () => {
    mount();
    const name = await screen.findByRole('textbox', { name: 'Name' });
    fireEvent.change(name, { target: { value: 'Renamed editor' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Category' }), {
      target: { value: 'Data' },
    });
    expect(writeMenu).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writeMenu).toHaveBeenCalledTimes(1));
    expect(vi.mocked(writeMenu).mock.calls[0][0].find((item) => item.id === 'editor')?.fields).toEqual({
      ...original[0].fields,
      caption: 'Renamed editor',
      category: 'Data',
    });
    expect(vi.mocked(writeMenu).mock.calls[0].slice(1)).toEqual(['initial', 'C:/Panel']);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled());
  });

  it('supports keyboard-accessible ordering, deletion and undo without saving', async () => {
    mount();
    await screen.findByRole('textbox', { name: 'Name' });
    fireEvent.click(screen.getByRole('button', { name: 'Down' }));
    const structure = screen.getByRole('region', { name: 'Menu structure' });
    const rows = structure.querySelectorAll('[data-menu-item]');
    expect(Array.from(rows).map((row) => row.getAttribute('data-menu-item'))).toEqual([
      'terminal',
      'editor',
      'database',
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Delete item' }));
    expect(within(structure).queryByRole('button', { name: 'My editor' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(within(structure).getByRole('button', { name: 'My editor' })).toBeVisible();
    expect(writeMenu).not.toHaveBeenCalled();
  });

  it('creates a nested category, adds an item and chooses an actual Font Awesome brand icon', async () => {
    mount();
    await screen.findByRole('textbox', { name: 'Name' });
    fireEvent.click(screen.getByRole('button', { name: 'Category' }));
    const dialog = screen.getByRole('dialog', { name: 'New category' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Name' }), { target: { value: 'Editors' } });
    fireEvent.submit(dialog);
    fireEvent.click(
      within(screen.getByRole('complementary', { name: 'Item properties' })).getByRole('button', {
        name: 'Add item to this category',
      }),
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'Command' }), {
      target: { value: 'editor.exe' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Choose icon' }));
    const picker = screen.getByRole('dialog', { name: 'Menu icon' });
    fireEvent.change(within(picker).getByRole('textbox'), { target: { value: 'firefox' } });
    fireEvent.click(within(picker).getByRole('button', { name: 'firefox' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writeMenu).toHaveBeenCalled());
    const created = vi.mocked(writeMenu).mock.calls[0][0].find((item) => item.id === 'custom_1');
    expect(created?.fields.category).toBe('Tools\\Editors');
    expect(created?.fields.icon).toBe('firefox');
  });

  it('retains the draft on a conflicting save', async () => {
    vi.mocked(writeMenu).mockRejectedValue(new Error('err.menuConflict'));
    mount();
    const name = await screen.findByRole('textbox', { name: 'Name' });
    fireEvent.change(name, { target: { value: 'Keep this draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(notify).toHaveBeenCalledWith(t('err.menuConflict')));
    expect(name).toHaveValue('Keep this draft');
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('does not replace a newly selected installation with a stale read', async () => {
    let resolveOld: ((value: OsPanelMenuDocument) => void) | undefined;
    vi.mocked(readMenu).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    );
    const view = mount('C:/Old');
    view.rerender(
      <I18nContext.Provider value={{ lang: 'en', t, plural }}>
        <MenuEditor
          notify={notify}
          installationPath="C:/New"
          active
          blocked={false}
          onRestart={onRestart}
          onOpenBackups={onOpenBackups}
        />
      </I18nContext.Provider>,
    );
    expect(await screen.findByRole('textbox', { name: 'Name' })).toHaveValue('My editor');
    resolveOld?.({ items: [{ id: 'stale', fields: { caption: 'Wrong installation' } }], revision: 'old' });
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('My editor'));
  });

  it('duplicates a native action and saves advanced properties independently of the original', async () => {
    const items = structuredClone(original);
    items[0].fields.need_alias = 'on';
    vi.mocked(readMenu).mockResolvedValue({ items, revision: 'initial' });
    mount();
    await screen.findByRole('textbox', { name: 'Name' });
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate item' }));
    fireEvent.click(screen.getByText('Advanced properties'));
    fireEvent.change(screen.getByLabelText('Working directory'), { target: { value: '{project_root}' } });
    fireEvent.click(screen.getByLabelText('Hide the launched application window'));
    fireEvent.click(screen.getByLabelText('Separator before item'));
    fireEvent.click(screen.getByLabelText('Separator after item'));
    fireEvent.click(screen.getByLabelText('Show in menu'));
    fireEvent.change(screen.getByLabelText(/Windows Terminal enabled/), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Required module/add-on category'), {
      target: { value: 'modules\\PHP' },
    });
    fireEvent.change(screen.getByLabelText('future_option'), { target: { value: 'updated' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writeMenu).toHaveBeenCalled());
    const saved = vi.mocked(writeMenu).mock.calls[0][0];
    expect(saved.find((item) => item.id === 'editor')?.fields).toEqual(items[0].fields);
    expect(saved.find((item) => item.id === 'custom_1')?.fields).toMatchObject({
      caption: 'My editor — copy',
      need_alias: 'off',
      work_directory: '{project_root}',
      hide: 'on',
      hr_before: 'on',
      hr_after: 'on',
      enabled: 'off',
      need_category: 'modules\\PHP',
      future_option: 'updated',
    });
    expect(saved.find((item) => item.id === 'custom_1')?.fields).not.toHaveProperty('need_use_wt');
  });

  it('renames a populated category and prevents deleting its items accidentally', async () => {
    mount();
    await screen.findByRole('textbox', { name: 'Name' });
    fireEvent.click(screen.getByRole('button', { name: /^Tools\s*2$/ }));
    expect(screen.getByRole('button', { name: 'Delete empty category' })).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox', { name: 'Category path' }), { target: { value: 'Data' } });
    expect(screen.getByRole('button', { name: 'Rename category' })).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox', { name: 'Category path' }), {
      target: { value: 'Development' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Rename category' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writeMenu).toHaveBeenCalled());
    expect(vi.mocked(writeMenu).mock.calls[0][0].map((item) => item.fields.category)).toEqual([
      'Development',
      'Development',
      'Data',
    ]);
  });

  it('coalesces text edits into one undo step and repeats them without touching the file', async () => {
    mount();
    const name = await screen.findByRole('textbox', { name: 'Name' });
    fireEvent.change(name, { target: { value: 'First edit' } });
    fireEvent.change(name, { target: { value: 'Final edit' } });
    fireEvent.blur(name);
    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(name).toHaveValue('My editor');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Redo' }));
    expect(name).toHaveValue('Final edit');
    expect(writeMenu).not.toHaveBeenCalled();
  });

  it('retains a draft when reload is cancelled and reads the file after confirmation', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    mount();
    const name = await screen.findByRole('textbox', { name: 'Name' });
    fireEvent.change(name, { target: { value: 'Unsaved draft' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Reload menu' })));
    expect(name).toHaveValue('Unsaved draft');
    expect(readMenu).toHaveBeenCalledTimes(1);
    confirm.mockReturnValue(true);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Reload menu' })));
    expect(await screen.findByRole('textbox', { name: 'Name' })).toHaveValue('My editor');
    expect(readMenu).toHaveBeenCalledTimes(2);
  });

  it('recovers from a read failure through Reload without allowing an empty overwrite', async () => {
    vi.mocked(readMenu).mockRejectedValueOnce(new Error('err.menuInvalid'));
    mount();
    expect(await screen.findByRole('alert')).toHaveTextContent(t('err.menuInvalid'));
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Reload menu' }));
    expect(await screen.findByRole('textbox', { name: 'Name' })).toHaveValue('My editor');
    expect(writeMenu).not.toHaveBeenCalled();
  });

  it('moves by pointer and cancels a later drag without modifying the draft', async () => {
    const pointDescriptor = Object.getOwnPropertyDescriptor(document, 'elementFromPoint');
    vi.stubGlobal('PointerEvent', MouseEvent);
    try {
      const { container } = mount();
      await screen.findByRole('textbox', { name: 'Name' });
      const destination = container.querySelector<HTMLElement>(
        '.menu-category-heading[data-menu-drop="Data"]',
      );
      if (!destination) throw new Error('Destination category missing');
      Object.defineProperty(document, 'elementFromPoint', {
        configurable: true,
        value: vi.fn(() => destination),
      });
      const handle = screen.getByRole('button', { name: 'Drag My editor' });
      fireEvent.pointerDown(handle, { button: 0, clientX: 0, clientY: 0 });
      fireEvent.pointerMove(handle, { clientX: 30, clientY: 40 });
      fireEvent.pointerUp(handle, { clientX: 30, clientY: 40 });
      expect(screen.getByRole('combobox', { name: 'Category' })).toHaveValue('Data');
      const movedHandle = screen.getByRole('button', { name: 'Drag My editor' });
      fireEvent.pointerDown(movedHandle, { button: 0, clientX: 0, clientY: 0 });
      fireEvent.pointerMove(movedHandle, { clientX: 30, clientY: 40 });
      fireEvent.pointerCancel(movedHandle);
      expect(screen.getByRole('combobox', { name: 'Category' })).toHaveValue('Data');
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(writeMenu).toHaveBeenCalledTimes(1));
      expect(vi.mocked(writeMenu).mock.calls[0][0].find((item) => item.id === 'editor')?.fields).toEqual({
        ...original[0].fields,
        category: 'Data',
      });
    } finally {
      if (pointDescriptor) Object.defineProperty(document, 'elementFromPoint', pointDescriptor);
      else Reflect.deleteProperty(document, 'elementFromPoint');
      vi.unstubAllGlobals();
    }
  });
});
