import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HostsEditor } from '../src/components/dialogs/HostsEditor';
import { embeddedDict, I18nContext, makePlural, makeTranslator } from '../src/i18n';
import { flushHostsDns, readHosts, writeHosts } from '../src/ospanel';

vi.mock('../src/ospanel', async (original) => ({
  ...(await original<typeof import('../src/ospanel')>()),
  readHosts: vi.fn(),
  writeHosts: vi.fn(),
  flushHostsDns: vi.fn(),
}));
const content =
  '# Header\n# OPEN SERVER PANEL: START OF THE LIST\n127.0.1.32 panel.local\n# OPEN SERVER PANEL: END OF THE LIST\n\n127.0.0.1 api.local # API\n';
const document = {
  content,
  revision: 'initial',
  path: 'C:\\Windows\\System32\\drivers\\etc\\hosts',
  encoding: 'UTF-8',
};
const t = makeTranslator(embeddedDict('en'), embeddedDict('en'));
const onClose = vi.fn();
const mount = (strict = false) => {
  const editor = (
    <I18nContext.Provider value={{ t, lang: 'en', plural: makePlural(t, 'en', embeddedDict('en')) }}>
      <HostsEditor onClose={onClose} notify={vi.fn()} />
    </I18nContext.Provider>
  );
  return render(strict ? <StrictMode>{editor}</StrictMode> : editor);
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readHosts).mockResolvedValue({ ...document });
  vi.mocked(writeHosts).mockImplementation(async (next) => ({
    document: { ...document, content: next, revision: 'saved' },
    backupPath: 'hosts_backup',
    dnsFlushed: true,
  }));
  vi.mocked(flushHostsDns).mockResolvedValue();
});

afterEach(cleanup);

describe('HostsEditor', () => {
  it('loads in StrictMode, leaves OSPanel rows locked in the table and does not save on open', async () => {
    mount(true);
    expect(await screen.findByRole('switch', { name: 'Enable panel.local' })).toBeDisabled();
    expect(screen.getByRole('switch', { name: 'Enable api.local' })).toBeEnabled();
    expect(writeHosts).not.toHaveBeenCalled();
  });

  it('adds a pasted block once, then synchronizes table and text without losing comments', async () => {
    mount();
    await screen.findByText('panel.local');
    fireEvent.click(screen.getByRole('button', { name: 'Add multiple' }));
    const dialog = screen.getByRole('dialog', { name: 'Add multiple entries' });
    fireEvent.change(within(dialog).getByRole('textbox'), {
      target: { value: '# Group\n127.0.0.1 shop.local\n# 127.0.0.1 archive.local' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add entries' }));
    expect(screen.getByRole('switch', { name: 'Enable archive.local' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    fireEvent.click(screen.getByRole('button', { name: 'File text' }));
    const text = screen.getByRole('textbox', { name: 'Full hosts file' });
    expect(text).toHaveValue(`${content}# Group\n127.0.0.1 shop.local\n# 127.0.0.1 archive.local\n`);
    fireEvent.click(screen.getByRole('button', { name: 'Table' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save and apply' }));
    await waitFor(() => expect(writeHosts).toHaveBeenCalledTimes(1));
    expect(vi.mocked(writeHosts).mock.calls[0][1]).toBe('initial');
    expect(await screen.findByText('Hosts saved and Windows DNS cache cleared.')).toBeVisible();
  });

  it('keeps invalid text and the dirty draft when switching views or requesting close', async () => {
    mount();
    await screen.findByText('panel.local');
    fireEvent.click(screen.getByRole('button', { name: 'File text' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Full hosts file' }), {
      target: { value: `${content}999.0.0.1 broken.local` },
    });
    expect(screen.getByRole('button', { name: 'Save and apply' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Table' }));
    fireEvent.click(screen.getByRole('button', { name: 'File text' }));
    expect(screen.getByRole('textbox', { name: 'Full hosts file' })).toHaveValue(
      `${content}999.0.0.1 broken.local`,
    );
    fireEvent.click(screen.getAllByRole('button', { name: 'Close' })[0]);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.getByRole('textbox', { name: 'Full hosts file' })).toHaveValue(
      `${content}999.0.0.1 broken.local`,
    );
  });

  it('highlights properties safely while keeping editable text and scrolling synchronized', async () => {
    const { container } = mount();
    await screen.findByText('panel.local');
    fireEvent.click(screen.getByRole('button', { name: 'File text' }));
    const text = screen.getByRole('textbox', { name: 'Full hosts file' });
    const highlight = container.querySelector('.hosts-file-highlight') as HTMLPreElement;
    expect(highlight).toHaveAttribute('aria-hidden', 'true');
    expect(highlight.querySelector('.hljs-comment')).toHaveTextContent('# Header');
    expect(highlight.querySelector('.hljs-attr')).toHaveTextContent('127.0.1.32');
    expect(highlight.querySelector('.hljs-string')).toHaveTextContent('panel.local');

    const next = '# <img src=x onerror=alert(1)>\n127.0.0.1\tshop.local\n::1 localhost\n\n';
    fireEvent.change(text, { target: { value: next } });
    expect(text).toHaveValue(next);
    expect(highlight.textContent).toBe(`${next}\n`);
    expect(highlight.querySelector('img')).toBeNull();
    expect(highlight.querySelector('.hljs-string')).toHaveTextContent('shop.local');

    fireEvent.scroll(text, { target: { scrollTop: 100, scrollLeft: 80 } });
    expect(highlight.scrollTop).toBe(100);
    expect(highlight.scrollLeft).toBe(80);
    expect(writeHosts).not.toHaveBeenCalled();
  });

  it('preserves the draft and revision after another program changes hosts', async () => {
    vi.mocked(writeHosts).mockRejectedValue(new Error('err.hostsConflict'));
    mount();
    await screen.findByText('panel.local');
    fireEvent.click(screen.getByRole('switch', { name: 'Enable api.local' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save and apply' }));
    expect(await screen.findByText(t('err.hostsConflict'))).toBeVisible();
    expect(screen.getByRole('switch', { name: 'Enable api.local' })).toHaveAttribute('aria-checked', 'false');
    expect(readHosts).toHaveBeenCalledTimes(1);
  });

  it.each(['err.hostsElevationCancelled', 'err.hostsHelperTimeout'])(
    'keeps the draft and original revision after %s and permits retry',
    async (code) => {
      vi.mocked(writeHosts).mockRejectedValueOnce(new Error(code));
      mount();
      await screen.findByText('panel.local');
      fireEvent.click(screen.getByRole('switch', { name: 'Enable api.local' }));
      fireEvent.click(screen.getByRole('button', { name: 'Save and apply' }));
      expect(await screen.findByText(t(code))).toBeVisible();
      expect(screen.getByRole('switch', { name: 'Enable api.local' })).toHaveAttribute(
        'aria-checked',
        'false',
      );
      expect(onClose).not.toHaveBeenCalled();
      expect(readHosts).toHaveBeenCalledTimes(1);
      fireEvent.click(screen.getByRole('button', { name: 'Save and apply' }));
      expect(await screen.findByText('Hosts saved and Windows DNS cache cleared.')).toBeVisible();
      expect(vi.mocked(writeHosts).mock.calls.map((call) => call[1])).toEqual(['initial', 'initial']);
    },
  );

  it('reports partial DNS failure and retries it without writing a second time', async () => {
    vi.mocked(writeHosts).mockImplementation(async (next) => ({
      document: { ...document, content: next, revision: 'saved' },
      backupPath: 'hosts_backup',
      dnsFlushed: false,
    }));
    mount();
    await screen.findByText('panel.local');
    fireEvent.click(screen.getByRole('switch', { name: 'Enable api.local' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save and apply' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Retry DNS cache clearing' }));
    expect(await screen.findByText('Hosts saved and Windows DNS cache cleared.')).toBeVisible();
    expect(writeHosts).toHaveBeenCalledTimes(1);
    expect(flushHostsDns).toHaveBeenCalledTimes(1);
  });
});
