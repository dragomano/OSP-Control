import { cleanup, render, screen, within } from '@testing-library/react';
import { ArrowDownWideNarrow } from 'lucide-react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MenuSelect } from '../src/components/widgets/MenuSelect';
import { selectOption } from './selectOption';

afterEach(cleanup);

const options = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Beta' },
];

describe('MenuSelect', () => {
  it('exposes the selected option through the native choice control', () => {
    render(<MenuSelect icon={ArrowDownWideNarrow} value="b" options={options} onChange={vi.fn()} />);
    const control = screen.getByRole('combobox', { name: 'Beta' });
    expect(control).toHaveValue('b');
    expect(within(control).getByRole('option', { name: 'Beta', selected: true })).toBeInTheDocument();
    expect(within(control).getByRole('option', { name: 'Alpha', selected: false })).toBeInTheDocument();
  });

  it('reports the chosen value', () => {
    const onChange = vi.fn();
    render(<MenuSelect value="b" options={options} onChange={onChange} />);
    selectOption(screen.getByRole('combobox', { name: 'Beta' }), 'Alpha');
    expect(onChange).toHaveBeenCalledWith('a');
  });

  it('forwards stable form attributes to the native control', () => {
    render(
      <MenuSelect
        ariaLabel="Font"
        name="interface-font"
        id="font-choice"
        value="a"
        options={options}
        onChange={vi.fn()}
      />,
    );
    const control = screen.getByRole('combobox', { name: 'Font' });

    expect(control).toHaveAttribute('name', 'interface-font');
    expect(control).toHaveAttribute('id', 'font-choice');
  });

  it('previews choices in their own style and mirrors it on the closed control', () => {
    render(
      <MenuSelect
        value="b"
        options={[
          { value: 'a', label: 'Alpha', style: { fontFamily: 'Verdana' } },
          { value: 'b', label: 'Beta', style: { fontFamily: 'Arial' } },
        ]}
        onChange={vi.fn()}
      />,
    );
    const control = screen.getByRole('combobox', { name: 'Beta' });

    expect(within(control).getByRole('option', { name: 'Alpha' })).toHaveStyle({ fontFamily: 'Verdana' });
    expect(control.parentElement?.querySelector('.ui-select-label')).toHaveStyle({ fontFamily: 'Arial' });
  });

  it('keeps a filter label separate from its selected option and accessible name', () => {
    render(
      <MenuSelect label="Filter" ariaLabel="Sort projects" value="a" options={options} onChange={vi.fn()} />,
    );
    const control = screen.getByRole('combobox', { name: 'Sort projects' });
    expect(control).toHaveValue('a');
    expect(control.parentElement?.querySelector('.ui-select-label')).toHaveTextContent('Filter');
  });

  it('supports controls without a leading icon and keeps disabled behavior', () => {
    render(<MenuSelect ariaLabel="Match" value="a" options={options} onChange={vi.fn()} disabled />);
    const control = screen.getByRole('combobox', { name: 'Match' });
    expect(control).toBeDisabled();
    expect(control.parentElement?.querySelector('.ui-select-leading')).toBeNull();
  });
});
