import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Activity } from 'lucide-react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Services } from '../src/components/pages/Services';
import { type Service, serviceGroupSummary, statusLabel, stopStartAction } from '../src/components/shared';
import { StatusDot } from '../src/components/widgets/StatusDot';
import { embeddedDict, I18nContext, makeTranslator } from '../src/i18n';

const t = makeTranslator(embeddedDict('en'), embeddedDict('en'));
const unknownService: Service = {
  name: 'Mystery',
  version: '—',
  port: '—',
  status: 'unknown',
  detail: 'svc.detail.module',
  kind: 'module',
  icon: Activity,
};

const renderWithI18n = (element: React.ReactNode) =>
  render(
    <I18nContext.Provider value={{ lang: 'en', t, plural: (key) => key }}>{element}</I18nContext.Provider>,
  );

afterEach(() => cleanup());

describe('unknown service status', () => {
  it('uses a dedicated label and disables service actions', () => {
    const action = stopStartAction(unknownService, t);

    expect(statusLabel('unknown', t)).toBe('Unknown');
    expect(action.label).toBe('Unknown');
    expect(action.action).toBeNull();
    expect(action.disabled).toBe(true);
  });

  it('makes group summaries indeterminate when a service is unknown', () => {
    expect(serviceGroupSummary([{ service: unknownService }], t)).toEqual({
      text: 'status unavailable',
      tone: 'warning',
    });
  });

  it('renders an unknown dot with the same accessible label', () => {
    renderWithI18n(<StatusDot status="unknown" />);
    expect(screen.getByRole('img', { name: 'Unknown' })).toHaveClass('status-dot', 'unknown');
  });

  it('renders an unknown service without an actionable toggle', () => {
    const onToggle = vi.fn();
    renderWithI18n(
      <Services
        services={[unknownService]}
        onToggle={onToggle}
        onAction={vi.fn()}
        notify={vi.fn()}
        onSync={vi.fn().mockResolvedValue(true)}
        onRestartAll={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(screen.getAllByText('Unknown')).toHaveLength(2);
    const toggle = screen.getByRole('button', { name: 'Unknown' });
    expect(toggle).toBeDisabled();
    fireEvent.click(toggle);
    expect(onToggle).not.toHaveBeenCalled();
  });
});
