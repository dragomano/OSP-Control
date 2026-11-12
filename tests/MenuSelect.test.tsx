import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ArrowDownWideNarrow } from 'lucide-react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MenuSelect } from '../src/components/widgets/MenuSelect';

afterEach(() => cleanup());

const renderSelect = (onChange: (value: string) => void, value = 'b') =>
  render(
    <MenuSelect
      icon={ArrowDownWideNarrow}
      value={value}
      options={[
        { value: 'a', label: 'Alpha' },
        { value: 'b', label: 'Beta' },
      ]}
      onChange={onChange}
    />,
  );

describe('MenuSelect', () => {
  it('shows the selected option on the trigger and marks it with a check in the menu', () => {
    renderSelect(vi.fn());

    const trigger = screen.getByRole('button', { name: 'Beta' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    fireEvent.click(trigger);
    const menu = screen.getByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: 'Beta' }).querySelector('svg')).not.toBeNull();
    expect(within(menu).getByRole('menuitem', { name: 'Alpha' }).querySelector('svg')).toBeNull();
  });

  it('reports the chosen value and closes the menu after picking another option', () => {
    const onChange = vi.fn();
    renderSelect(onChange);

    fireEvent.click(screen.getByRole('button', { name: 'Beta' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Alpha' }));

    expect(onChange).toHaveBeenCalledWith('a');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('uses the explicit label on the trigger while the accessible name stays the control name', () => {
    render(
      <MenuSelect
        icon={ArrowDownWideNarrow}
        label="Recent changes first"
        ariaLabel="Sort projects"
        value="a"
        options={[{ value: 'a', label: 'Recent changes first' }]}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Sort projects' })).toHaveTextContent('Recent changes first');
  });

  it('opens the menu from a trigger without an icon', () => {
    render(
      <MenuSelect
        ariaLabel="Match"
        value="any"
        options={[
          { value: 'any', label: 'Any tag' },
          { value: 'all', label: 'All tags' },
        ]}
        onChange={vi.fn()}
      />,
    );

    const trigger = screen.getByRole('button', { name: 'Match' });
    // Only the trailing chevron is rendered, with no leading icon.
    const svgs = trigger.querySelectorAll('svg');
    expect(svgs).toHaveLength(1);
    expect(svgs[0]).toHaveClass('lucide-chevron-right');
    fireEvent.click(trigger);
    expect(screen.getByRole('menuitem', { name: 'All tags' })).toBeInTheDocument();
  });
});
