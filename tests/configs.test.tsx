import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Configs } from '../src/components/tables/Configs';
import { embeddedDict, I18nContext, makeTranslator } from '../src/i18n';

const mocks = vi.hoisted(() => ({
  listConfigs: vi.fn(),
  readConfigFile: vi.fn(),
}));

vi.mock('../src/ospanel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ospanel')>();
  return { ...actual, listConfigs: mocks.listConfigs, readConfigFile: mocks.readConfigFile };
});

const configs = [
  { name: 'first.conf', service: 'Apache', path: '/first.conf', sizeBytes: 10, modifiedAt: 0 },
  { name: 'second.conf', service: 'Apache', path: '/second.conf', sizeBytes: 10, modifiedAt: 0 },
];

const renderConfigs = () =>
  render(
    <I18nContext.Provider
      value={{
        lang: 'en',
        t: makeTranslator(embeddedDict('en'), embeddedDict('en')),
        plural: (key) => key,
      }}
    >
      <Configs notify={vi.fn()} />
    </I18nContext.Provider>,
  );

beforeEach(() => {
  mocks.listConfigs.mockReset().mockResolvedValue(configs);
  mocks.readConfigFile.mockReset();
});

afterEach(() => cleanup());

describe('Configs async selection', () => {
  it('keeps the newest selection when an older read resolves later', async () => {
    const pending = new Map<string, (content: string) => void>();
    mocks.readConfigFile.mockImplementation(
      (path: string) =>
        new Promise<string>((resolve) => {
          pending.set(path, resolve);
        }),
    );
    renderConfigs();

    const first = await screen.findByRole('button', { name: /first\.conf/ });
    const second = screen.getByRole('button', { name: /second\.conf/ });
    fireEvent.click(second);

    await act(async () => pending.get('/second.conf')?.('SECOND_CONTENT'));
    await act(async () => pending.get('/first.conf')?.('FIRST_CONTENT'));

    expect(screen.getByText('SECOND_CONTENT')).toBeInTheDocument();
    expect(screen.queryByText('FIRST_CONTENT')).not.toBeInTheDocument();
    expect(first).not.toHaveClass('selected');
    expect(second).toHaveClass('selected');
  });
});
