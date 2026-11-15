import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SearchField } from '../src/components/widgets/SearchField';
import { embeddedDict, I18nContext, makePlural, makeTranslator } from '../src/i18n';

const t = makeTranslator(embeddedDict('en'), embeddedDict('en'));
const plural = makePlural(t, 'en', embeddedDict('en'));
const initial = 'Grav CMS';

function StatefulField({
  onChange,
  startEmpty = false,
}: {
  onChange?: (value: string) => void;
  startEmpty?: boolean;
}) {
  const [value, setValue] = useState(startEmpty ? '' : initial);
  return (
    <I18nContext.Provider value={{ lang: 'en', t, plural }}>
      <SearchField
        value={value}
        onChange={(next) => {
          setValue(next);
          onChange?.(next);
        }}
        placeholder="Search projects"
      />
    </I18nContext.Provider>
  );
}

afterEach(cleanup);

describe('Search field clear button', () => {
  it('clears the query and keeps focus in the input', () => {
    const onChange = vi.fn();
    render(<StatefulField onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(onChange).toHaveBeenCalledWith('');
    expect(screen.getByPlaceholderText('Search projects')).toHaveFocus();
    expect(screen.queryByRole('button', { name: 'Clear search' })).toBeNull();
    expect(screen.getByPlaceholderText('Search projects')).toHaveValue('');
  });

  it('hides the clear button while the query is empty', () => {
    render(<StatefulField startEmpty />);
    expect(screen.queryByRole('button', { name: 'Clear search' })).toBeNull();
    fireEvent.change(screen.getByPlaceholderText('Search projects'), { target: { value: 'php' } });
    expect(screen.getByRole('button', { name: 'Clear search' })).toBeDefined();
  });
});
