import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from '../src/components/dialogs/ConfirmDialog';
import { embeddedDict, I18nContext, makePlural, makeTranslator } from '../src/i18n';
import { askConfirm } from '../src/ospanel';

const t = makeTranslator(embeddedDict('en'), embeddedDict('en'));
const plural = makePlural(t, 'en', embeddedDict('en'));

// askConfirm only routes to the in-app dialog in desktop mode; tests set the Tauri
// flag the same way ospanel tests do.
const tauriFlag = () => window as { __TAURI_INTERNALS__?: unknown };

function Harness() {
  return (
    <I18nContext.Provider value={{ lang: 'en', t, plural }}>
      <ConfirmDialog />
    </I18nContext.Provider>
  );
}

// Sends a question and waits for the dialog; returns a getter for the settled answer.
const ask = async (message: string) => {
  let answer: boolean | undefined;
  await act(async () => {
    void askConfirm(message, 'Confirmation').then((value) => {
      answer = value;
    });
  });
  await screen.findByRole('dialog');
  return () => answer;
};

beforeEach(() => {
  tauriFlag().__TAURI_INTERNALS__ = {};
});

afterEach(() => {
  delete tauriFlag().__TAURI_INTERNALS__;
  cleanup();
});

describe('ConfirmDialog', () => {
  it('shows the title and the question of the request', async () => {
    render(<Harness />);
    await ask('Delete the copy dated 2023?');

    expect(screen.getByRole('dialog')).toHaveAttribute('aria-label', 'Confirmation');
    expect(screen.getByText('Delete the copy dated 2023?')).toBeDefined();
  });

  it('resolves with true when OK is pressed and closes the dialog', async () => {
    render(<Harness />);
    const answer = await ask('Delete the copy dated 2023?');
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));

    await vi.waitFor(() => expect(answer()).toBe(true));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('resolves with false when Cancel is pressed', async () => {
    render(<Harness />);
    const answer = await ask('Delete the copy dated 2023?');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await vi.waitFor(() => expect(answer()).toBe(false));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('declines on Escape and on an outside click, like the replaced native box', async () => {
    render(<Harness />);
    const escapeAnswer = await ask('First question?');
    fireEvent.keyDown(document, { key: 'Escape' });
    await vi.waitFor(() => expect(escapeAnswer()).toBe(false));

    const outsideAnswer = await ask('Second question?');
    fireEvent.mouseDown(document.body);
    await vi.waitFor(() => expect(outsideAnswer()).toBe(false));
  });

  it('queues overlapping questions and answers them in order', async () => {
    render(<Harness />);
    const first = await ask('First question?');
    const second = await ask('Second question?');

    // Only the first request is on screen; answering it reveals the second one.
    expect(screen.queryByText('Second question?')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    await screen.findByText('Second question?');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await vi.waitFor(() => expect(first()).toBe(true));
    await vi.waitFor(() => expect(second()).toBe(false));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
