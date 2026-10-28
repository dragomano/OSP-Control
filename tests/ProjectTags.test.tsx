import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Projects } from '../src/components/pages/Projects';
import { embeddedDict, I18nContext, makePlural, makeTranslator } from '../src/i18n';
import { filterProjects, type OsPanelProject } from '../src/ospanel';
import {
  editProjectTags,
  MAX_PROJECT_TAGS,
  matchesProjectTags,
  projectTagsStorageKey,
  readProjectTags,
  sortTaggedProjects,
  tagsForProject,
  writeProjectTags,
} from '../src/projectTags';

const mocks = vi.hoisted(() => ({ getProjectActivity: vi.fn(), listEditors: vi.fn() }));
vi.mock('../src/ospanel', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/ospanel')>()),
  ...mocks,
}));

const projects: OsPanelProject[] = [
  { domain: 'shop.local', path: 'D:/OSPanel6/home/shop.local', php: '8.4', type: 'Nginx', ssl: true },
  { domain: 'api.local', path: 'D:/OSPanel6/home/api.local', php: '8.3', type: 'Nginx', ssl: true },
  { domain: 'empty.local', path: 'D:/OSPanel6/home/empty.local', php: '8.4', type: 'Apache', ssl: false },
];
const initial = { 'shop.local': ['Client', 'Laravel'], 'api.local': ['Client', 'API'] };
const key = projectTagsStorageKey('D:/OSPanel6');
const t = makeTranslator(embeddedDict('en'), embeddedDict('en'));
const plural = makePlural(t, 'en', embeddedDict('en'));
const notify = vi.fn();
function Harness({ installationPath = 'D:/OSPanel6' }: { installationPath?: string }) {
  const [query, setQuery] = useState('');
  return (
    <I18nContext.Provider value={{ lang: 'en', t, plural }}>
      <Projects
        projects={projects}
        allProjects={projects}
        installationPath={installationPath}
        query={query}
        setQuery={setQuery}
        notify={notify}
        onProjectCreated={vi.fn()}
        onProjectDeleted={vi.fn()}
        onToggleSsl={vi.fn()}
        onRestartPanel={vi.fn()}
      />
    </I18nContext.Provider>
  );
}
const row = (domain: string) => within(screen.getByText(domain).closest('.project-row') as HTMLElement);
const rowOrder = () =>
  [...document.querySelectorAll('.project-row .project-activity-title > b')].map(
    (element) => element.textContent,
  );
const search = () => screen.getByPlaceholderText('Search projects...');

beforeEach(() => {
  localStorage.clear();
  notify.mockReset();
  mocks.listEditors.mockReset().mockResolvedValue([]);
  mocks.getProjectActivity.mockReset().mockResolvedValue(
    projects.map((project, index) => ({
      domain: project.domain,
      modifiedAt: 1_790_000_000 - index * 60,
      lastFile: `${project.domain}/index.php`,
      status: 'ready',
    })),
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('project tag metadata', () => {
  it('isolates installations and normalizes Windows path and domain casing', () => {
    expect(projectTagsStorageKey('D:\\OSPANEL6\\')).toBe(key);
    const next = editProjectTags({}, ['SHOP.local'], ' #Client ', 'add');
    writeProjectTags(key, next);
    expect(tagsForProject(readProjectTags(key), 'shop.LOCAL')).toEqual(['Client']);
    expect(readProjectTags(projectTagsStorageKey('E:/OSPanel6'))).toEqual({});
  });

  it('ignores corrupt and future data, sanitizes stored tags, and handles prototype-like domains', () => {
    for (const value of ['not json', 'null', '[]', '{"version":2,"projects":{}}']) {
      localStorage.setItem(key, value);
      expect(readProjectTags(key)).toEqual({});
    }
    localStorage.setItem(
      key,
      JSON.stringify({
        version: 1,
        projects: {
          'SHOP.local': [' Client ', 'client', 42, '', 'x'.repeat(33), 'API'],
          bad: 'Client',
        },
      }),
    );
    expect(readProjectTags(key)).toEqual({ 'shop.local': ['Client', 'API'] });
    const next = editProjectTags({}, ['__proto__', 'constructor'], 'Safe', 'add');
    expect(tagsForProject(next, '__proto__')).toEqual(['Safe']);
    expect(tagsForProject({}, 'constructor')).toEqual([]);
  });

  it('applies bulk edits atomically, deduplicates names and enforces tag limits', () => {
    expect(editProjectTags(initial, ['shop.local', 'shop.local', 'empty.local'], 'client', 'add')).toEqual({
      ...initial,
      'empty.local': ['Client'],
    });
    const full = {
      ...initial,
      'empty.local': Array.from({ length: MAX_PROJECT_TAGS }, (_, index) => `Tag ${index}`),
    };
    expect(() => editProjectTags(full, ['api.local', 'empty.local'], 'Review', 'add')).toThrow(
      'err.projectTagLimit',
    );
    expect(full['api.local']).toEqual(['Client', 'API']);
    for (const invalid of ['', '###', 'x'.repeat(33), 'bad\u0000tag']) {
      expect(() => editProjectTags(initial, ['shop.local'], invalid, 'add')).toThrow('err.invalidProjectTag');
    }
    expect(editProjectTags({ 'shop.local': ['Client'] }, ['SHOP.local'], 'CLIENT', 'remove')).toEqual({});
  });

  it('searches tags, paths and domains together, including exact quoted tags', () => {
    const tags = { ...initial, 'empty.local': ['Client work'] };
    expect(filterProjects(projects, '#client', tags).map((project) => project.domain)).toEqual([
      'shop.local',
      'api.local',
    ]);
    expect(filterProjects(projects, '#"client work"', tags).map((project) => project.domain)).toEqual([
      'empty.local',
    ]);
    expect(filterProjects(projects, 'home #client shop', tags).map((project) => project.domain)).toEqual([
      'shop.local',
    ]);
    expect(filterProjects(projects, 'larav', tags).map((project) => project.domain)).toEqual(['shop.local']);
    expect(matchesProjectTags(['Client'], ['Client', 'Laravel'], 'any')).toBe(true);
    expect(matchesProjectTags(['Client'], ['Client', 'Laravel'], 'all')).toBe(false);
    expect(matchesProjectTags([], [null], 'all')).toBe(true);
    expect(matchesProjectTags(['Client'], [null], 'any')).toBe(false);
  });

  it('sorts by labels without moving untagged projects ahead or mutating the source', () => {
    expect(sortTaggedProjects(projects, initial, 'tags', 'en').map((project) => project.domain)).toEqual([
      'api.local',
      'shop.local',
      'empty.local',
    ]);
    expect(sortTaggedProjects(projects, initial, 'tags-desc', 'en').map((project) => project.domain)).toEqual(
      ['shop.local', 'api.local', 'empty.local'],
    );
    expect(projects.map((project) => project.domain)).toEqual(['shop.local', 'api.local', 'empty.local']);
  });
});

describe('project tags UI', () => {
  it('adds and removes tags, persists remounts and switches installations without leaking metadata', async () => {
    const view = render(<Harness />);
    fireEvent.click(row('shop.local').getByRole('button', { name: 'Tags for shop.local' }));
    const editor = screen.getByRole('region', { name: 'Tags for shop.local' });
    fireEvent.change(within(editor).getByLabelText('Tag name'), { target: { value: 'Client' } });
    fireEvent.submit(within(editor).getByLabelText('Tag name').closest('form') as HTMLFormElement);
    expect(row('shop.local').getByRole('button', { name: 'Filter by tag Client' })).toBeInTheDocument();
    fireEvent.click(within(editor).getByRole('button', { name: 'Done' }));
    view.unmount();
    const next = render(<Harness />);
    expect(row('shop.local').getByRole('button', { name: 'Filter by tag Client' })).toBeInTheDocument();
    next.rerender(<Harness installationPath="E:/OSPanel6" />);
    expect(row('shop.local').queryByRole('button', { name: 'Filter by tag Client' })).not.toBeInTheDocument();
    next.rerender(<Harness />);
    fireEvent.click(row('shop.local').getByRole('button', { name: 'Tags for shop.local' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove tag Client' }));
    expect(readProjectTags(key)).toEqual({});
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Tags for shop.local' })).not.toBeInTheDocument(),
    );
  });

  it('combines tag conditions with search and existing filters, and sorts without date groups taking precedence', async () => {
    writeProjectTags(key, initial);
    render(<Harness />);
    await screen.findByRole('button', { name: 'Show the last modified file in shop.local' });
    fireEvent.change(screen.getByLabelText('Sort projects'), { target: { value: 'domain' } });
    expect(rowOrder()).toEqual(['api.local', 'empty.local', 'shop.local']);
    fireEvent.change(screen.getByLabelText('Sort projects'), { target: { value: 'tags-desc' } });
    expect(rowOrder()).toEqual(['shop.local', 'api.local', 'empty.local']);
    expect(document.querySelector('.project-activity-group-heading')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Tags' }));
    const filter = screen.getByRole('group', { name: 'Tags' });
    fireEvent.click(within(filter).getByRole('checkbox', { name: 'Client' }));
    fireEvent.click(within(filter).getByRole('checkbox', { name: 'Laravel' }));
    expect(rowOrder()).toEqual(['shop.local', 'api.local']);
    fireEvent.change(within(filter).getByLabelText('Match'), { target: { value: 'all' } });
    expect(rowOrder()).toEqual(['shop.local']);
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    fireEvent.change(search(), { target: { value: '#API' } });
    expect(rowOrder()).toEqual(['api.local']);
    expect(mocks.getProjectActivity).toHaveBeenCalledTimes(1);
  });

  it('bulk-assigns and removes tags only from selected visible projects and updates tag search immediately', () => {
    writeProjectTags(key, initial);
    render(<Harness />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select shop.local' }));
    expect(screen.getByRole('checkbox', { name: 'Select all visible projects' })).toHaveProperty(
      'indeterminate',
      true,
    );
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select api.local' }));
    fireEvent.change(screen.getByLabelText('Tag for selected projects'), { target: { value: 'Review' } });
    fireEvent.click(screen.getByRole('button', { name: 'Assign' }));
    expect(tagsForProject(readProjectTags(key), 'shop.local')).toContain('Review');
    expect(tagsForProject(readProjectTags(key), 'api.local')).toContain('Review');
    expect(tagsForProject(readProjectTags(key), 'empty.local')).toEqual([]);
    fireEvent.change(search(), { target: { value: '#Review shop' } });
    expect(screen.getByText('Selected: 1')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(rowOrder()).toEqual([]);
    expect(tagsForProject(readProjectTags(key), 'shop.local')).not.toContain('Review');
    expect(tagsForProject(readProjectTags(key), 'api.local')).toContain('Review');
    fireEvent.change(search(), { target: { value: '' } });
    expect(screen.getByRole('checkbox', { name: 'Select api.local' })).not.toBeChecked();
  });

  it('reports failed persistence and keeps the original labels', () => {
    writeProjectTags(key, initial);
    render(<Harness />);
    fireEvent.click(row('shop.local').getByRole('button', { name: 'Tags for shop.local' }));
    fireEvent.change(screen.getByLabelText('Tag name'), { target: { value: 'Review' } });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
      throw new Error('quota');
    });
    fireEvent.submit(screen.getByLabelText('Tag name').closest('form') as HTMLFormElement);
    expect(notify).toHaveBeenCalledWith('Failed to save project tags');
    expect(row('shop.local').queryByRole('button', { name: 'Filter by tag Review' })).not.toBeInTheDocument();
    expect(readProjectTags(key)).toEqual(initial);
  });
});
