import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';
import { readMenu, restoreMenuBackup } from '../src/ospanel';

vi.mock('../src/ospanel', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/ospanel')>()),
  readMenu: vi.fn(),
  restoreMenuBackup: vi.fn(),
  listBackups: vi.fn(async () => [
    {
      id: 'menu-1700000000000000000',
      createdAt: 1_700_000_000,
      sizeBytes: 42,
      files: 1,
      kind: 'menu',
      subject: null,
    },
  ]),
}));

const menu = (caption: string) => ({
  items: [{ id: 'terminal', fields: { caption, command: 'cmd.exe' } }],
  revision: caption,
});

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('ospanel.lang', 'en');
  vi.mocked(readMenu).mockReset().mockResolvedValue(menu('Current menu'));
  vi.mocked(restoreMenuBackup)
    .mockReset()
    .mockImplementation(async () => {
      vi.mocked(readMenu).mockResolvedValue(menu('Restored menu'));
    });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function openBackupsWithDraft() {
  render(<App />);
  await screen.findByText('6.0.0');
  fireEvent.click(screen.getByRole('button', { name: 'Menu editor' }));
  fireEvent.change(await screen.findByRole('textbox', { name: 'Name' }), {
    target: { value: 'Unsaved draft' },
  });
  const actions = document.querySelector<HTMLElement>('.menu-header-actions');
  if (!actions) throw new Error('Menu actions missing');
  fireEvent.click(within(actions).getByRole('button', { name: 'Backups' }));
  expect(await screen.findByRole('combobox', { name: 'Backup type' })).toHaveValue('menu');
  await screen.findByRole('button', { name: 'Restore' });
}

describe('menu backup navigation and editor synchronization', () => {
  it('blocks editing and another restore even after navigating away and back during restoration', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    let finishRestore: (() => void) | undefined;
    vi.mocked(restoreMenuBackup).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishRestore = () => {
            vi.mocked(readMenu).mockResolvedValue(menu('Restored menu'));
            resolve();
          };
        }),
    );
    await openBackupsWithDraft();
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(restoreMenuBackup).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: 'Menu editor' }));
    expect(await screen.findByRole('textbox', { name: 'Name' })).toBeDisabled();
    const sidebar = document.querySelector<HTMLElement>('.sidebar');
    if (!sidebar) throw new Error('Sidebar missing');
    fireEvent.click(within(sidebar).getByRole('button', { name: 'Backups' }));
    expect(await screen.findByRole('button', { name: 'Restore' })).toBeDisabled();
    await act(async () => finishRestore?.());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Restore' })).toBeEnabled());
    expect(restoreMenuBackup).toHaveBeenCalledOnce();
  });

  it('reloads the retained editor after a confirmed restore and resets the sidebar filter', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await openBackupsWithDraft();
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(restoreMenuBackup).toHaveBeenCalledOnce());
    expect(confirm).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: 'Menu editor' }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Restored menu'));
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    const sidebar = document.querySelector<HTMLElement>('.sidebar');
    if (!sidebar) throw new Error('Sidebar missing');
    fireEvent.click(within(sidebar).getByRole('button', { name: 'Backups' }));
    expect(await screen.findByRole('combobox', { name: 'Backup type' })).toHaveValue('all');
  });

  it('preserves the editor draft if discarding it is declined', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(true).mockReturnValueOnce(false);
    await openBackupsWithDraft();
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: 'Menu editor' }));
    expect(await screen.findByRole('textbox', { name: 'Name' })).toHaveValue('Unsaved draft');
    expect(restoreMenuBackup).not.toHaveBeenCalled();
  });
});
