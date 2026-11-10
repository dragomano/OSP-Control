import { invoke } from '@tauri-apps/api/core';
import { afterEach, expect, it, vi } from 'vitest';
import { diagnoseProject, type OsPanelProject } from '../src/ospanel';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
afterEach(() => {
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  vi.clearAllMocks();
});

it('passes both owning and selected domains to native diagnostics and validates saved task data', async () => {
  (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === 'diagnose_project'
      ? { domain: 'api.shop.test', checkedAt: 10, checks: [] }
      : '[api.shop.test]\nInvalid = 99 * * * * * 1 echo {host}\n',
  );
  const project: OsPanelProject = {
    domain: 'shop.test',
    path: 'C:\\OSPanel\\home\\shared',
    php: '8.3',
    type: 'Nginx',
    ssl: true,
  };
  const result = await diagnoseProject(project, 'api.shop.test');
  expect(invoke).toHaveBeenCalledWith(
    'diagnose_project',
    expect.objectContaining({ domain: 'shop.test', selectedDomain: 'api.shop.test', baseDir: project.path }),
  );
  expect(invoke).toHaveBeenCalledWith(
    'read_project_file',
    expect.objectContaining({ domain: 'shop.test', file: 'tasks.ini', baseDir: project.path }),
  );
  expect(result.checks[0]).toMatchObject({ id: 'tasks', status: 'error' });
});
