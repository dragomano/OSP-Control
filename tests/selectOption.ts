import { fireEvent, within } from '@testing-library/react';

export function selectOption(control: HTMLElement, label: string) {
  const option = within(control).getByRole('option', { name: label }) as HTMLOptionElement;
  fireEvent.change(control, { target: { value: option.value } });
}
