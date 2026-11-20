import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Layers } from 'lucide-react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from '../src/components/dialogs/ConfirmDialog';
import { ModuleProfilesDialog } from '../src/components/dialogs/ModuleProfilesDialog';
import { embeddedDict, I18nContext, makePlural, makeTranslator } from '../src/i18n';
import { profileNameExists, validProfileName } from '../src/moduleProfiles';
import * as panel from '../src/ospanel';

vi.mock('../src/ospanel', async (importOriginal) => ({
  ...(await importOriginal<typeof panel>()),
  listModuleProfiles: vi.fn(),
  readModuleProfile: vi.fn(),
  readProfileFile: vi.fn(),
  saveProfileFile: vi.fn(),
  createModuleProfile: vi.fn(),
  renameModuleProfile: vi.fn(),
  deleteModuleProfile: vi.fn(),
  openProjectFolder: vi.fn(),
  askConfirm: vi.fn(),
}));
const dict = embeddedDict('en');
const t = makeTranslator(dict, dict);
const source = '[main]\n; Preserve this comment\ncustom_option = yes\n';
const moduleName = 'Example';
const setup = () => {
  const onClose = vi.fn(),
    onActivate = vi.fn().mockResolvedValue(undefined),
    onBusyChange = vi.fn();
  render(
    <I18nContext.Provider value={{ lang: 'en', t, plural: makePlural(t, 'en', dict) }}>
      <ConfirmDialog />
      <ModuleProfilesDialog
        service={{
          name: moduleName,
          version: '1.0',
          port: ':80',
          status: 'running',
          detail: 'svc.detail.web',
          kind: 'web',
          icon: Layers,
        }}
        blocked={false}
        notify={vi.fn()}
        onClose={onClose}
        onActivate={onActivate}
        onBusyChange={onBusyChange}
      />
    </I18nContext.Provider>,
  );
  return { onClose, onActivate, onBusyChange };
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(panel.listModuleProfiles).mockResolvedValue({
    active: 'default',
    online: true,
    factoryAvailable: true,
    factoryData: false,
    profiles: [
      { name: 'default', builtin: true, hasData: false },
      { name: 'testing', builtin: false, hasData: false },
    ],
  });
  vi.mocked(panel.readModuleProfile).mockResolvedValue({
    path: 'C:/OSPanel/config/Example/default',
    files: [
      { name: 'settings.ini', sizeBytes: 64 },
      { name: 'templates/nested/example.conf', sizeBytes: 30 },
    ],
  });
  vi.mocked(panel.readProfileFile).mockResolvedValue(source);
  vi.mocked(panel.askConfirm).mockResolvedValue(true);
});
afterEach(cleanup);

describe('profile identity', () => {
  it('accepts OSPanel names and rejects paths, shell input and Windows devices', () => {
    for (const name of ['default', 'dev+debug', 'local_2.0']) expect(validProfileName(name)).toBe(true);
    for (const name of [
      '',
      '..',
      '../default',
      'a\\b',
      'a&echo',
      'name.',
      '.hidden',
      'NUL',
      'CON.ini',
      'COM1',
      'a b',
    ])
      expect(validProfileName(name)).toBe(false);
    expect(profileNameExists([{ name: 'Testing', builtin: false, hasData: false }], 'testing')).toBe(true);
  });
});
describe('module profiles window', () => {
  it('edits built-in settings without dropping unknown keys and keeps a conflicting draft', async () => {
    const { onBusyChange } = setup();
    const editor = await screen.findByRole('textbox', {
      name: t('profiles.fileContent', { file: 'settings.ini' }),
    });
    const draft = source.replace('yes', 'no');
    fireEvent.change(editor, { target: { value: draft } });
    vi.mocked(panel.saveProfileFile).mockRejectedValue(new Error('err.profileConflict'));
    fireEvent.click(screen.getByRole('button', { name: t('common.save') }));
    expect(await screen.findByRole('alert')).toHaveTextContent(t('err.profileConflict'));
    expect(editor).toHaveValue(draft);
    expect(panel.saveProfileFile).toHaveBeenCalledWith(moduleName, 'default', 'settings.ini', source, draft);
    expect(onBusyChange.mock.calls).toEqual([[true], [false]]);
  });

  it('guards closing and switching files with unsaved changes', async () => {
    const { onClose } = setup();
    const editor = await screen.findByRole('textbox', {
      name: t('profiles.fileContent', { file: 'settings.ini' }),
    });
    fireEvent.change(editor, { target: { value: `${source}extra = yes\n` } });
    vi.mocked(panel.askConfirm).mockResolvedValue(false);
    fireEvent.click(screen.getByRole('button', { name: t('common.close') }));
    await waitFor(() => expect(panel.askConfirm).toHaveBeenCalled());
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'templates/nested/example.conf' }));
    await waitFor(() => expect(panel.askConfirm).toHaveBeenCalledTimes(2));
    expect(panel.readProfileFile).toHaveBeenCalledTimes(1);
    expect(editor).toHaveValue(`${source}extra = yes\n`);
  });

  it('creates an inactive profile and prevents case-insensitive duplicate names', async () => {
    setup();
    await screen.findByRole('textbox', { name: t('profiles.fileContent', { file: 'settings.ini' }) });
    fireEvent.click(screen.getByRole('button', { name: t('profiles.create') }));
    const form = (await screen.findByRole('heading', { name: t('profiles.new') })).closest('form');
    if (!form) throw new Error('Creation form is missing');
    const name = within(form).getByRole('textbox');
    const submit = within(form).getByRole('button', { name: t('profiles.create') });
    fireEvent.change(name, { target: { value: 'TESTING' } });
    expect(submit).toBeDisabled();
    fireEvent.change(name, { target: { value: 'new+profile' } });
    fireEvent.click(submit);
    await waitFor(() =>
      expect(panel.createModuleProfile).toHaveBeenCalledWith(
        moduleName,
        'new+profile',
        'default',
        false,
        false,
      ),
    );
    expect(await screen.findByRole('status')).toHaveTextContent(t('profiles.created'));
  });

  it('keeps the creation form open while dismissing or accepting the copy-data confirmation', async () => {
    vi.mocked(panel.listModuleProfiles).mockResolvedValue({
      active: 'default',
      online: true,
      factoryAvailable: true,
      factoryData: true,
      profiles: [{ name: 'default', builtin: true, hasData: true }],
    });
    vi.mocked(panel.askConfirm).mockImplementation(panel.requestAppConfirm);
    const { onClose } = setup();
    await screen.findByRole('textbox', { name: t('profiles.fileContent', { file: 'settings.ini' }) });
    const profiles = screen.getByRole('dialog', { name: t('profiles.title', { name: moduleName }) });
    fireEvent.click(within(profiles).getByRole('button', { name: t('profiles.create') }));
    await within(profiles).findByRole('heading', { name: t('profiles.new') });
    const name = within(profiles).getByRole('textbox');
    fireEvent.change(name, { target: { value: 'data-copy' } });
    fireEvent.change(within(profiles).getByRole('combobox', { name: new RegExp(t('profiles.data')) }), {
      target: { value: 'true' },
    });
    const submit = within(profiles).getAllByRole('button', { name: t('profiles.create') })[1];
    const confirmation = () => screen.findByRole('dialog', { name: t('common.confirmTitle') });

    submit.focus();
    fireEvent.click(submit);
    const focusedOk = within(await confirmation()).getByRole('button', { name: t('common.ok') });
    fireEvent.keyDown(focusedOk, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: t('common.confirmTitle') })).toBeNull();
      expect(onClose).not.toHaveBeenCalled();
      expect(submit).toHaveFocus();
    });
    expect(panel.createModuleProfile).not.toHaveBeenCalled();
    expect(name).toHaveValue('data-copy');

    fireEvent.click(submit);
    const ok = within(await confirmation()).getByRole('button', { name: t('common.ok') });
    fireEvent.mouseDown(ok);
    fireEvent.click(ok);
    expect(await screen.findByRole('status')).toHaveTextContent(t('profiles.created'));
    expect(panel.createModuleProfile).toHaveBeenCalledExactlyOnceWith(
      moduleName,
      'data-copy',
      'default',
      false,
      true,
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it('does not announce activation when restarting or verification fails', async () => {
    const { onActivate } = setup();
    await screen.findByRole('textbox', { name: t('profiles.fileContent', { file: 'settings.ini' }) });
    fireEvent.click(screen.getByRole('button', { name: /^testing/ }));
    await waitFor(() => expect(panel.readModuleProfile).toHaveBeenCalledWith(moduleName, 'testing'));
    const activate = await screen.findByRole('button', { name: t('profiles.activate') });
    await waitFor(() => expect(activate).not.toBeDisabled());
    onActivate.mockRejectedValue(new Error('err.profileActivation'));
    fireEvent.click(activate);
    expect(await screen.findByRole('alert')).toHaveTextContent(t('err.profileActivation'));
    expect(onActivate).toHaveBeenCalledWith('testing');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('uses a popover for profile actions and deletes a custom inactive profile', async () => {
    const { onClose } = setup();
    await screen.findByRole('textbox', { name: t('profiles.fileContent', { file: 'settings.ini' }) });
    const actions = screen.getByRole('button', { name: t('common.actions') });
    const menu = () => screen.getByRole('menu', { hidden: true });
    const remove = () => within(menu()).getByText(t('profiles.delete'));
    fireEvent.click(actions);
    expect(remove()).toBeDisabled();
    fireEvent.keyDown(actions, { key: 'Escape' });
    expect(screen.queryByRole('menu', { hidden: true })).not.toBeInTheDocument();
    expect(actions).toHaveFocus();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /^testing/ }));
    await waitFor(() => expect(panel.readModuleProfile).toHaveBeenCalledWith(moduleName, 'testing'));
    await screen.findByRole('textbox', { name: t('profiles.fileContent', { file: 'settings.ini' }) });
    fireEvent.click(actions);
    expect(menu()).toHaveAttribute('popover', 'manual');
    fireEvent.click(remove());
    expect(await screen.findByRole('status')).toHaveTextContent(t('profiles.deleted'));
    expect(panel.askConfirm).toHaveBeenCalledWith(
      t('profiles.deleteConfirm', { profile: 'testing' }),
      t('common.confirmTitle'),
    );
    expect(panel.deleteModuleProfile).toHaveBeenCalledExactlyOnceWith(moduleName, 'testing');
    expect(onClose).not.toHaveBeenCalled();
  });
});
