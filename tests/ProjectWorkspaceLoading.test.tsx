import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ProjectWorkspace } from '../src/components/pages/ProjectWorkspace';
import { embeddedDict, I18nContext, makeTranslator } from '../src/i18n';
import type { OsPanelProject } from '../src/ospanel';

const mocks = vi.hoisted(() => ({
  readProjectWorkspace: vi.fn(),
  readProjectFile: vi.fn(),
  saveProjectFile: vi.fn(),
  getProjectModuleOptions: vi.fn(),
  getGlobalProjectEngines: vi.fn(),
  askConfirm: vi.fn(),
  listProjectStarters: vi.fn(),
}));
vi.mock('../src/ospanel', async (original) => ({
  ...(await original<typeof import('../src/ospanel')>()),
  ...mocks,
}));
const project: OsPanelProject = {
  domain: 'shop.test',
  path: 'C:\\OSPanel\\home\\shared',
  php: '8.3',
  type: 'Nginx',
  ssl: true,
};
const t = makeTranslator(embeddedDict('en'), embeddedDict('en'));
beforeEach(() => {
  vi.resetAllMocks();
  mocks.readProjectWorkspace.mockResolvedValue({
    baseDir: project.path,
    content: '[shop.test]\r\n',
    files: ['.user.ini'],
  });
  mocks.getProjectModuleOptions.mockResolvedValue({ httpEngines: [], phpEngines: [], nodeEngines: [] });
  mocks.getGlobalProjectEngines.mockResolvedValue({ httpEngine: 'Nginx', phpEngine: '', nodeEngine: '' });
});
afterEach(cleanup);

it('keeps a background config read out of the reported workspace busy state', async () => {
  let finish!: (value: string | null) => void;
  mocks.readProjectFile.mockImplementation((_project, file) => {
    if (file === '.user.ini')
      return new Promise<string | null>((resolve) => {
        finish = resolve;
      });
    return Promise.resolve(null);
  });
  const states: { dirty: boolean; busy: boolean }[] = [];
  render(
    <I18nContext.Provider value={{ lang: 'en', t, plural: (key) => key }}>
      <ProjectWorkspace
        project={project}
        notify={vi.fn()}
        onClose={vi.fn()}
        onRestartPanel={vi.fn()}
        onStateChange={(state) => states.push(state)}
      />
    </I18nContext.Provider>,
  );
  fireEvent.click(await screen.findByRole('tab', { name: 'Configurations' }));
  // The workspace itself is loaded at this point; only reading a file remains.
  await screen.findByRole('textbox', { name: 'Contents of nginx/shop.test.conf' });
  fireEvent.click(screen.getByRole('button', { name: 'PHP' }));
  await screen.findByText(t('common.loading'), { selector: '.workspace-editor-placeholder' });
  const reported = states.length;
  expect(states.filter((state) => state.busy)).toHaveLength(1);
  finish('memory_limit=256M\n');
  expect(await screen.findByRole('textbox', { name: 'Contents of .user.ini' })).toHaveValue(
    'memory_limit=256M\n',
  );
  expect(states.slice(reported).some((state) => state.busy)).toBe(false);
  expect(states[states.length - 1]).toEqual({ dirty: false, busy: false });
});
