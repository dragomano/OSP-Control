import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApplicationSetup } from '../src/components/pages/ApplicationSetup';
import { embeddedDict, I18nContext, makeTranslator } from '../src/i18n';
import { installProjectLaravel, installProjectWordPress } from '../src/ospanel';

vi.mock('../src/ospanel', () => ({ installProjectLaravel: vi.fn(), installProjectWordPress: vi.fn() }));
const t = makeTranslator(embeddedDict('en'), embeddedDict('en'));
const project = {
  domain: 'site.test',
  path: 'C:/OSPanel/home/site.test',
  php: '8.3',
  type: 'Nginx',
  ssl: false,
};
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const setup = (dirty = false, kind: 'laravel' | 'wordpress' = 'laravel') => {
  const onInstalled = vi.fn().mockResolvedValue(undefined);
  const onBusyChange = vi.fn();
  render(
    <I18nContext.Provider value={{ lang: 'en', t, plural: (key) => key }}>
      <ApplicationSetup
        project={project}
        kind={kind}
        state="pending"
        dirty={dirty}
        disabled={dirty}
        onInstalled={onInstalled}
        onBusyChange={onBusyChange}
      />
    </I18nContext.Provider>,
  );
  return { onInstalled, onBusyChange };
};
describe('Laravel setup', () => {
  it('requires saved settings before starting Composer', () => {
    setup(true);
    expect(screen.getByRole('button', { name: 'Install Laravel' })).toBeDisabled();
    expect(
      screen.getByText('Save or discard your project changes before installing Laravel.'),
    ).toBeInTheDocument();
    expect(installProjectLaravel).not.toHaveBeenCalled();
  });
  it('shows installation failures and keeps the action available for retry', async () => {
    vi.mocked(installProjectLaravel).mockRejectedValue(new Error('err.laravelConflict'));
    const { onInstalled, onBusyChange } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Install Laravel' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The scaffold contains additional files');
    expect(screen.getByRole('button', { name: 'Install Laravel' })).toBeEnabled();
    expect(onInstalled).not.toHaveBeenCalled();
    expect(onBusyChange.mock.calls).toEqual([[true], [false]]);
  });
});

describe('WordPress setup', () => {
  it('reports download progress and calls completion only after successful publication', async () => {
    let finish: (value: { backupPath: string }) => void = () => {};
    vi.mocked(installProjectWordPress).mockImplementation((_project, progress) => {
      progress({ phase: 'downloading', output: '', downloaded: 50, total: 100 });
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const { onInstalled, onBusyChange } = setup(false, 'wordpress');
    fireEvent.click(screen.getByRole('button', { name: 'Install WordPress' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Downloading WordPress');
    expect(screen.getByRole('progressbar')).toHaveAttribute('value', '50');
    expect(screen.getByRole('button', { name: 'Install WordPress' })).toBeDisabled();
    expect(onInstalled).not.toHaveBeenCalled();
    await act(async () => {
      finish({ backupPath: 'C:/OSPanel/backups/project-starters/wordpress-site.test' });
    });
    expect(onInstalled).toHaveBeenCalledOnce();
    expect(screen.getByText(/WordPress files installed/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Install WordPress' })).not.toBeInTheDocument();
    expect(onBusyChange.mock.calls).toEqual([[true], [false]]);
  });
  it('shows an actionable error and enables retry after a failed checksum', async () => {
    vi.mocked(installProjectWordPress).mockRejectedValue(new Error('err.wordpressChecksum'));
    const { onInstalled } = setup(false, 'wordpress');
    fireEvent.click(screen.getByRole('button', { name: 'Install WordPress' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('checksum does not match');
    expect(screen.getByRole('button', { name: 'Install WordPress' })).toBeEnabled();
    expect(onInstalled).not.toHaveBeenCalled();
  });
});
