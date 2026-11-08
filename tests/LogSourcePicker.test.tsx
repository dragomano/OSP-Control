import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LogSourcePicker } from '../src/components/widgets/LogSourcePicker';
import { embeddedDict, I18nContext, makePlural, makeTranslator } from '../src/i18n';
import type { LogSource } from '../src/ospanel';

const t = makeTranslator(embeddedDict('en'), embeddedDict('en'));
const plural = makePlural(t, 'en', embeddedDict('en'));
const sources: LogSource[] = [
  { name: 'PHP-8.4.log', label: 'PHP-8.4.log', domain: false },
  { name: 'domains/shop.test_error.log', label: 'shop.test error', domain: true },
  { name: 'general.log', label: 'general.log', domain: false },
  { name: 'domains/blog.test_access.log', label: 'blog.test access', domain: true },
  { name: 'domains/shop-api.test_access.log', label: 'shop-api.test access', domain: true },
];
const picker = (onChange = vi.fn(), disabled = false, items = sources) => (
  <I18nContext.Provider value={{ lang: 'en', t, plural }}>
    <LogSourcePicker sources={items} value="general.log" disabled={disabled} onChange={onChange} />
  </I18nContext.Provider>
);
const openPicker = () => {
  fireEvent.click(screen.getByRole('button', { name: 'general.log' }));
  return screen.getByRole('combobox', { name: 'Find a domain or module...' });
};

afterEach(cleanup);

describe('Log source picker', () => {
  it('highlights the selected log on opening and keeps it selected when Enter is pressed', () => {
    const onChange = vi.fn();
    render(picker(onChange));
    const input = openPicker();
    const selected = screen.getByRole('option', { name: 'general.log', selected: true });
    expect(selected).not.toBe(screen.getAllByRole('option')[0]);
    expect(selected).toHaveClass('active');
    expect(screen.getAllByRole('option')[0]).not.toHaveClass('active');
    expect(input).toHaveAttribute('aria-activedescendant', selected.id);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledExactlyOnceWith('general.log');
  });

  it('restores the selected log after clearing the search and reopening the list', () => {
    render(picker());
    const input = openPicker();
    fireEvent.change(input, { target: { value: 'shop' } });
    expect(screen.getAllByRole('option')[0]).toHaveClass('active');
    fireEvent.change(input, { target: { value: '' } });
    expect(screen.getByRole('option', { name: 'general.log' })).toHaveClass('active');
    fireEvent.change(input, { target: { value: 'PHP' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    const reopened = openPicker();
    expect(reopened).toHaveValue('');
    expect(reopened).toHaveAttribute(
      'aria-activedescendant',
      screen.getByRole('option', { name: 'general.log' }).id,
    );
    expect(screen.getByRole('option', { name: 'general.log' })).toHaveClass('active');
  });

  it('groups raw names with domains first and alphabetizes each group without changing the source list', () => {
    render(picker());
    expect(openPicker()).toHaveFocus();
    const domains = screen.getByRole('group', { name: 'Domains' });
    const system = screen.getByRole('group', { name: 'Modules and panel' });
    expect(
      within(domains)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['blog.test access', 'shop-api.test access', 'shop.test error']);
    expect(
      within(system)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['general.log', 'PHP-8.4.log']);
    expect(screen.getAllByRole('group')).toEqual([domains, system]);
    expect(screen.getByRole('option', { name: 'general.log', selected: true })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Logs: 5');
    expect(sources[0].name).toBe('PHP-8.4.log');
  });

  it('searches prefixes from the first character, ignores case, and hides empty groups', () => {
    render(picker());
    const input = openPicker();
    fireEvent.change(input, { target: { value: 'S' } });
    expect(screen.getAllByRole('option')).toHaveLength(2);
    expect(screen.queryByRole('group', { name: 'Modules and panel' })).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: ' ShO ' } });
    expect(screen.getAllByRole('option')).toHaveLength(2);
    expect(screen.getAllByText('sho', { exact: false, selector: 'mark' })).toHaveLength(2);
    fireEvent.change(input, { target: { value: 'PHP' } });
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(screen.queryByRole('group', { name: 'Domains' })).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: 'test' } });
    expect(screen.queryByRole('option')).not.toBeInTheDocument();
    expect(screen.getByText('No logs found')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Logs: 0');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('selects a domain by its original file identifier and resets the search on reopening', () => {
    const onChange = vi.fn();
    render(picker(onChange));
    fireEvent.change(openPicker(), { target: { value: 'shop.' } });
    fireEvent.click(screen.getByRole('option', { name: 'shop.test error' }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith('domains/shop.test_error.log');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'general.log' })).toHaveFocus();
    expect(openPicker()).toHaveValue('');
    expect(screen.getAllByRole('option')).toHaveLength(5);
  });

  it('keeps focus in the search while navigating with arrows and selects with Enter', () => {
    const onChange = vi.fn();
    render(picker(onChange));
    const input = openPicker();
    fireEvent.change(input, { target: { value: 'shop' } });
    const options = screen.getAllByRole('option');
    expect(input).toHaveAttribute('aria-activedescendant', options[0].id);
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(input).toHaveAttribute('aria-activedescendant', options[1].id);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input).toHaveAttribute('aria-activedescendant', options[0].id);
    expect(input).toHaveFocus();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledExactlyOnceWith('domains/shop-api.test_access.log');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes with Escape, Tab and an outside click, and blocks changes while disabled', () => {
    const onChange = vi.fn();
    const { rerender } = render(picker(onChange));
    fireEvent.keyDown(openPicker(), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const trigger = screen.getByRole('button', { name: 'general.log' });
    expect(trigger).toHaveFocus();
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Tab' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    openPicker();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    openPicker();
    rerender(picker(onChange, true));
    expect(trigger).toBeDisabled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(trigger);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('removes a vanished keyboard target when sources refresh during a search', () => {
    const onChange = vi.fn();
    const { rerender } = render(picker(onChange));
    const input = openPicker();
    fireEvent.change(input, { target: { value: 'shop' } });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    rerender(picker(onChange, false, []));
    expect(input).not.toHaveAttribute('aria-activedescendant');
    expect(screen.getByText('No logs found')).toBeInTheDocument();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).not.toHaveBeenCalled();
  });
});
