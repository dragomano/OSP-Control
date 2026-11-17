import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Button,
  DialogOverlay,
  DialogPanel,
  Field,
  Input,
  Panel,
  Select,
  Textarea,
  Toggle,
} from '../src/components/ui';

afterEach(cleanup);

function Editor() {
  const [value, setValue] = useState('');
  const [enabled, setEnabled] = useState(false);
  return (
    <DialogOverlay>
      <DialogPanel role="dialog" aria-label="Editor">
        <Panel>
          <Input aria-label="Value" value={value} onChange={(event) => setValue(event.target.value)} />
          <Toggle
            type="button"
            role="switch"
            checked={enabled}
            aria-label="Enabled"
            onClick={() => setEnabled(!enabled)}
          />
          <Textarea
            code
            aria-label="Source"
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
        </Panel>
      </DialogPanel>
    </DialogOverlay>
  );
}

describe('shared UI behavior', () => {
  it('preserves native form controls, refs, disabled actions and submission', () => {
    const input = createRef<HTMLInputElement>();
    const submit = vi.fn();
    const disabled = vi.fn();
    render(
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit(new FormData(event.currentTarget));
        }}
      >
        <Field htmlFor="name">Name</Field>
        <Input id="name" name="name" ref={input} required defaultValue="sample.test" />
        <Select name="engine" aria-label="Engine" defaultValue="php">
          <option value="php">PHP</option>
          <option value="node">Node.js</option>
        </Select>
        <Textarea name="config" aria-label="Configuration" defaultValue="enabled = 1" />
        <Button type="button" disabled onClick={disabled}>
          Disabled
        </Button>
        <Button variant="primary" type="submit">
          Save
        </Button>
      </form>,
    );
    expect(screen.getByLabelText('Name')).toBe(input.current);
    input.current?.focus();
    expect(input.current).toHaveFocus();
    fireEvent.change(input.current as HTMLInputElement, { target: { value: 'other.test' } });
    fireEvent.change(screen.getByLabelText('Engine'), { target: { value: 'node' } });
    fireEvent.click(screen.getByRole('button', { name: 'Disabled' }));
    expect(disabled).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const data = submit.mock.calls[0][0] as FormData;
    expect(Object.fromEntries(data)).toEqual({ name: 'other.test', engine: 'node', config: 'enabled = 1' });
  });

  it('keeps controls mounted and focused across dialog and panel updates', () => {
    render(<Editor />);
    const input = screen.getByLabelText('Value');
    input.focus();
    fireEvent.change(input, { target: { value: '[main]' } });
    expect(screen.getByLabelText('Value')).toBe(input);
    expect(input).toHaveFocus();
    const editor = screen.getByLabelText('Source');
    expect(editor).toHaveClass('ui-code-input');
    expect(editor).not.toHaveClass('textarea');
    expect(editor).toHaveValue('[main]');
    fireEvent.click(screen.getByRole('switch', { name: 'Enabled' }));
    expect(screen.getByRole('switch', { name: 'Enabled' })).toBeChecked();
  });

  it('dismisses an open choice picker before bubbling Escape to the surrounding dialog', () => {
    const dismiss = vi.fn();
    render(
      <DialogPanel role="dialog" aria-label="Choice dialog" onKeyDown={dismiss}>
        <Select aria-label="Choice">
          <option>A</option>
        </Select>
      </DialogPanel>,
    );
    const control = screen.getByRole('combobox', { name: 'Choice' });
    const open = vi.spyOn(control, 'matches').mockReturnValue(true);
    fireEvent.keyDown(control, { key: 'Escape' });
    expect(dismiss).not.toHaveBeenCalled();
    open.mockReturnValue(false);
    fireEvent.keyDown(control, { key: 'Escape' });
    expect(dismiss).toHaveBeenCalledOnce();
    open.mockRestore();
  });
});

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(file) : file.endsWith('.tsx') ? [file] : [];
  });

it('routes every application control and dialog through the shared UI layer', () => {
  const files = sourceFiles('src').filter((file) => !/[\\/](?:demo|ui)[\\/]/.test(file));
  const bypasses = files.filter((file) =>
    /<(?:button|input|select|textarea|table)\b|<div\s+className="modal-overlay/.test(
      readFileSync(file, 'utf8'),
    ),
  );
  expect(bypasses).toEqual([]);
});
