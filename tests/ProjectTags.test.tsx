import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Projects } from '../src/components/pages/Projects';
import { embeddedDict, I18nContext, makePlural, makeTranslator } from '../src/i18n';
import { filterProjects, type OsPanelProject } from '../src/ospanel';
import {
  colorForTag,
  editProjectTags,
  MAX_PROJECT_TAGS,
  matchesProjectTags,
  PROJECT_TAGS_KEY,
  readProjectTagColors,
  readProjectTags,
  setProjectTagColor,
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
  { domain: 'shop.test', path: 'X:/TestPanel/home/shop.test', php: '8.4', type: 'Nginx', ssl: true },
  { domain: 'api.test', path: 'X:/TestPanel/home/api.test', php: '8.3', type: 'Nginx', ssl: true },
  { domain: 'empty.test', path: 'X:/TestPanel/home/empty.test', php: '8.4', type: 'Apache', ssl: false },
];
const initial = { 'shop.test': ['Client', 'Laravel'], 'api.test': ['Client', 'API'] };
const key = PROJECT_TAGS_KEY;
const t = makeTranslator(embeddedDict('en'), embeddedDict('en'));
const plural = makePlural(t, 'en', embeddedDict('en'));
const notify = vi.fn();
function Harness() {
  const [query, setQuery] = useState('');
  return (
    <I18nContext.Provider value={{ lang: 'en', t, plural }}>
      <Projects
        projects={projects}
        allProjects={projects}
        query={query}
        setQuery={setQuery}
        notify={notify}
        onProjectCreated={vi.fn()}
        onProjectRenamed={vi.fn()}
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
  it('retains HEX colors across tag edits without changing their names', () => {
    writeProjectTags(key, initial);
    expect(readProjectTagColors(key)).toEqual({});
    const colors = setProjectTagColor({}, ' Client ', '#12a4ce');
    writeProjectTags(key, initial, colors);
    writeProjectTags(key, editProjectTags(initial, ['empty.test'], 'CLIENT', 'add'));
    expect(colorForTag(readProjectTagColors(key), 'client')).toBe('#12a4ce');
    expect(tagsForProject(readProjectTags(key), 'empty.test')).toEqual(['Client']);
    expect(setProjectTagColor(colors, 'CLIENT', null)).toEqual({});
  });

  it('removes colors only when their last tag reference is removed and does not restore them', () => {
    writeProjectTags(key, initial, { client: '#12a4ce', unused: '#cc4488' });
    expect(readProjectTagColors(key)).toEqual({ client: '#12a4ce' });
    const remaining = editProjectTags(initial, ['shop.test'], 'CLIENT', 'remove');
    writeProjectTags(key, remaining);
    expect(readProjectTagColors(key)).toEqual({ client: '#12a4ce' });
    const removed = editProjectTags(remaining, ['api.test'], 'client', 'remove');
    expect(writeProjectTags(key, removed)).toEqual({});
    expect(readProjectTagColors(key)).toEqual({});
    writeProjectTags(key, editProjectTags(removed, ['shop.test'], 'Client', 'add'));
    expect(readProjectTagColors(key)).toEqual({});
  });

  it('matches normalized tag identities when retaining colors', () => {
    writeProjectTags(
      key,
      { 'shop.test': ['Ｃｌｉｅｎｔ', ' #Two   Words '] },
      {
        client: '#12a4ce',
        'two words': '#cc4488',
      },
    );
    expect(readProjectTagColors(key)).toEqual({ client: '#12a4ce', 'two words': '#cc4488' });
  });

  it('ignores invalid stored colors and unsupported metadata versions', () => {
    localStorage.setItem(
      key,
      JSON.stringify({
        version: 1,
        projects: initial,
        colors: {
          Client: 'blue',
          Custom: '#Ab19EF',
          Short: '#abc',
          Invalid: '#zzzzzz',
          Bad: 'url(javascript:bad)',
          '': 'pink',
          __proto__: 'gray',
        },
      }),
    );
    expect(readProjectTagColors(key)).toEqual({ custom: '#Ab19EF' });
  });

  it('normalizes Windows domain casing on write and read', () => {
    const next = editProjectTags({}, ['SHOP.test'], ' #Client ', 'add');
    writeProjectTags(key, next);
    expect(tagsForProject(readProjectTags(key), 'shop.test')).toEqual(['Client']);
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
          'SHOP.test': [' Client ', 'client', 42, '', 'x'.repeat(33), 'API'],
          bad: 'Client',
        },
      }),
    );
    expect(readProjectTags(key)).toEqual({ 'shop.test': ['Client', 'API'] });
    const next = editProjectTags({}, ['__proto__', 'constructor'], 'Safe', 'add');
    expect(tagsForProject(next, '__proto__')).toEqual(['Safe']);
    expect(tagsForProject({}, 'constructor')).toEqual([]);
  });

  it('applies bulk edits atomically, deduplicates names and enforces tag limits', () => {
    expect(editProjectTags(initial, ['shop.test', 'shop.test', 'empty.test'], 'client', 'add')).toEqual({
      ...initial,
      'empty.test': ['Client'],
    });
    const full = {
      ...initial,
      'empty.test': Array.from({ length: MAX_PROJECT_TAGS }, (_, index) => `Tag ${index}`),
    };
    expect(() => editProjectTags(full, ['api.test', 'empty.test'], 'Review', 'add')).toThrow(
      'err.projectTagLimit',
    );
    expect(full['api.test']).toEqual(['Client', 'API']);
    for (const invalid of ['', '###', 'x'.repeat(33), 'bad\u0000tag']) {
      expect(() => editProjectTags(initial, ['shop.test'], invalid, 'add')).toThrow('err.invalidProjectTag');
    }
    expect(editProjectTags({ 'shop.test': ['Client'] }, ['SHOP.test'], 'CLIENT', 'remove')).toEqual({});
  });

  it('searches tags, paths and domains together, including exact quoted tags', () => {
    const tags = { ...initial, 'empty.test': ['Client work'] };
    expect(filterProjects(projects, '#client', tags).map((project) => project.domain)).toEqual([
      'shop.test',
      'api.test',
    ]);
    expect(filterProjects(projects, '#"client work"', tags).map((project) => project.domain)).toEqual([
      'empty.test',
    ]);
    expect(filterProjects(projects, 'home #client shop', tags).map((project) => project.domain)).toEqual([
      'shop.test',
    ]);
    expect(filterProjects(projects, 'larav', tags).map((project) => project.domain)).toEqual(['shop.test']);
    expect(matchesProjectTags(['Client'], ['Client', 'Laravel'], 'any')).toBe(true);
    expect(matchesProjectTags(['Client'], ['Client', 'Laravel'], 'all')).toBe(false);
    expect(matchesProjectTags([], [null], 'all')).toBe(true);
    expect(matchesProjectTags(['Client'], [null], 'any')).toBe(false);
  });

  it('sorts by labels without moving untagged projects ahead or mutating the source', () => {
    expect(sortTaggedProjects(projects, initial, 'tags', 'en').map((project) => project.domain)).toEqual([
      'api.test',
      'shop.test',
      'empty.test',
    ]);
    expect(sortTaggedProjects(projects, initial, 'tags-desc', 'en').map((project) => project.domain)).toEqual(
      ['shop.test', 'api.test', 'empty.test'],
    );
    expect(projects.map((project) => project.domain)).toEqual(['shop.test', 'api.test', 'empty.test']);
  });

  it('searches both IDN forms and sorts by readable domain names while retaining tag keys', () => {
    const idn = { ...projects[0], domain: 'xn--caf-dma.test', path: 'X:/TestPanel/home/xn--caf-dma.test' };
    const items = [idn, { ...projects[0], domain: 'mango.test' }];
    const tags = { [idn.domain]: ['Client'] };
    for (const query of ['café', 'xn--caf-dma', 'café #client']) {
      expect(filterProjects(items, query, tags)).toEqual([idn]);
    }
    for (const sort of ['domain', 'tags'] as const) {
      expect(sortTaggedProjects(items, {}, sort, 'en').map(({ domain }) => domain)).toEqual([
        'xn--caf-dma.test',
        'mango.test',
      ]);
    }
    expect(tagsForProject(tags, idn.domain)).toEqual(['Client']);
  });
});

describe('project tags UI', () => {
  it('adds and removes tags and keeps them across remounts', async () => {
    const view = render(<Harness />);
    fireEvent.click(row('shop.test').getByRole('button', { name: 'Tags for shop.test' }));
    const editor = screen.getByRole('region', { name: 'Tags for shop.test' });
    fireEvent.change(within(editor).getByLabelText('Tag name'), { target: { value: 'Client' } });
    fireEvent.submit(within(editor).getByLabelText('Tag name').closest('form') as HTMLFormElement);
    expect(row('shop.test').getByRole('button', { name: 'Filter by tag Client' })).toBeInTheDocument();
    fireEvent.click(within(editor).getByRole('button', { name: 'Done' }));
    view.unmount();
    render(<Harness />);
    expect(row('shop.test').getByRole('button', { name: 'Filter by tag Client' })).toBeInTheDocument();
    fireEvent.click(row('shop.test').getByRole('button', { name: 'Tags for shop.test' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove tag Client' }));
    expect(readProjectTags(key)).toEqual({});
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Tags for shop.test' })).not.toBeInTheDocument(),
    );
  });

  it('assigns a shared color, persists it and restores the default without losing tags', () => {
    writeProjectTags(key, initial);
    const view = render(<Harness />);
    fireEvent.click(row('shop.test').getByRole('button', { name: 'Tags for shop.test' }));
    fireEvent.click(screen.getByRole('button', { name: 'Color for Client' }));
    const palette = screen.getByRole('group', { name: 'Color for Client' });
    expect(palette.textContent).toBe('');
    expect(within(palette).getAllByRole('button')).toHaveLength(2);
    const picker = palette.querySelector('input[type="color"]') as HTMLInputElement;
    // A display:none input has no screen anchor and opens the native picker at the window origin.
    expect(picker).not.toHaveAttribute('hidden');
    expect(picker).toHaveClass('project-tag-native-picker');
    expect(picker.tabIndex).toBe(-1);
    expect(picker.parentElement).toHaveClass('project-tag-picker-anchor');
    expect(picker.parentElement).toContainElement(
      within(palette).getByRole('button', { name: 'Color for Client' }),
    );
    fireEvent.change(picker, { target: { value: '#12a4ce' } });
    expect(readProjectTagColors(key)).toEqual({ client: '#12a4ce' });
    for (const domain of ['shop.test', 'api.test']) {
      const chip = row(domain).getByRole('button', { name: 'Filter by tag Client' });
      expect(chip).toHaveClass('tag-color-custom');
      expect(chip.style.getPropertyValue('--tag-custom')).toBe('#12a4ce');
    }
    fireEvent.click(screen.getByRole('button', { name: 'Tags' }));
    const filterChip = within(screen.getByRole('group', { name: 'Tags' })).getByText('Client');
    expect(filterChip.style.getPropertyValue('--tag-custom')).toBe('#12a4ce');
    view.unmount();
    render(<Harness />);
    expect(
      row('api.test')
        .getByRole('button', { name: 'Filter by tag Client' })
        .style.getPropertyValue('--tag-custom'),
    ).toBe('#12a4ce');
    fireEvent.click(row('api.test').getByRole('button', { name: 'Tags for api.test' }));
    fireEvent.click(screen.getByRole('button', { name: 'Color for Client' }));
    fireEvent.click(
      within(screen.getByRole('group', { name: 'Color for Client' })).getByRole('button', {
        name: 'Default color',
      }),
    );
    expect(readProjectTagColors(key)).toEqual({});
    expect(tagsForProject(readProjectTags(key), 'shop.test')).toContain('Client');
  });

  it('does not change the color if persistence fails', () => {
    writeProjectTags(key, initial);
    render(<Harness />);
    fireEvent.click(row('shop.test').getByRole('button', { name: 'Tags for shop.test' }));
    fireEvent.click(screen.getByRole('button', { name: 'Color for Client' }));
    vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
      throw new Error('quota');
    });
    fireEvent.change(
      screen
        .getByRole('group', { name: 'Color for Client' })
        .querySelector('input[type="color"]') as HTMLInputElement,
      { target: { value: '#12a4ce' } },
    );
    expect(notify).toHaveBeenCalledWith('Failed to save project tags');
    expect(readProjectTagColors(key)).toEqual({});
    expect(row('shop.test').getByRole('button', { name: 'Filter by tag Client' })).not.toHaveClass(
      'tag-color-custom',
    );
  });

  it('combines tag conditions with search and existing filters, and sorts without date groups taking precedence', async () => {
    writeProjectTags(key, initial);
    render(<Harness />);
    await screen.findByRole('button', { name: 'Show the last modified file in shop.test' });
    fireEvent.click(screen.getByRole('button', { name: 'Sort projects' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Domain A–Z' }));
    expect(rowOrder()).toEqual(['api.test', 'empty.test', 'shop.test']);
    fireEvent.click(screen.getByRole('button', { name: 'Sort projects' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Tags Z–A' }));
    expect(rowOrder()).toEqual(['shop.test', 'api.test', 'empty.test']);
    expect(document.querySelector('.project-activity-group-heading')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Tags' }));
    const filter = screen.getByRole('group', { name: 'Tags' });
    fireEvent.click(within(filter).getByRole('checkbox', { name: 'Client' }));
    fireEvent.click(within(filter).getByRole('checkbox', { name: 'Laravel' }));
    expect(rowOrder()).toEqual(['shop.test', 'api.test']);
    fireEvent.click(within(filter).getByRole('button', { name: 'Match' }));
    fireEvent.click(within(filter).getByRole('menuitem', { name: 'All tags' }));
    expect(rowOrder()).toEqual(['shop.test']);
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    fireEvent.change(search(), { target: { value: '#API' } });
    expect(rowOrder()).toEqual(['api.test']);
    expect(mocks.getProjectActivity).toHaveBeenCalledTimes(1);
  });

  it('bulk-assigns and removes tags only from selected visible projects and updates tag search immediately', () => {
    writeProjectTags(key, initial);
    render(<Harness />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select shop.test' }));
    expect(screen.getByRole('checkbox', { name: 'Select all visible projects' })).toHaveProperty(
      'indeterminate',
      true,
    );
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select api.test' }));
    fireEvent.change(screen.getByLabelText('Tag for selected projects'), { target: { value: 'Review' } });
    fireEvent.click(screen.getByRole('button', { name: 'Assign' }));
    expect(tagsForProject(readProjectTags(key), 'shop.test')).toContain('Review');
    expect(tagsForProject(readProjectTags(key), 'api.test')).toContain('Review');
    expect(tagsForProject(readProjectTags(key), 'empty.test')).toEqual([]);
    fireEvent.change(search(), { target: { value: '#Review shop' } });
    expect(screen.getByText('Selected: 1')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(rowOrder()).toEqual([]);
    expect(tagsForProject(readProjectTags(key), 'shop.test')).not.toContain('Review');
    expect(tagsForProject(readProjectTags(key), 'api.test')).toContain('Review');
    fireEvent.change(search(), { target: { value: '' } });
    expect(screen.getByRole('checkbox', { name: 'Select api.test' })).not.toBeChecked();
  });

  it('suggests catalog tags in the bulk bar and fills the input from a picked suggestion', () => {
    writeProjectTags(key, initial);
    render(<Harness />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select shop.test' }));
    const input = screen.getByLabelText('Tag for selected projects');
    // Focusing opens the whole catalog as an app-styled menu.
    fireEvent.focus(input);
    const menu = screen.getByRole('menu');
    expect([...menu.children].map((item) => item.textContent)).toEqual(['API', 'Client', 'Laravel']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Client' }));
    expect(input).toHaveValue('Client');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('reports failed persistence and keeps the original labels', () => {
    writeProjectTags(key, initial);
    render(<Harness />);
    fireEvent.click(row('shop.test').getByRole('button', { name: 'Tags for shop.test' }));
    fireEvent.change(screen.getByLabelText('Tag name'), { target: { value: 'Review' } });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
      throw new Error('quota');
    });
    fireEvent.submit(screen.getByLabelText('Tag name').closest('form') as HTMLFormElement);
    expect(notify).toHaveBeenCalledWith('Failed to save project tags');
    expect(row('shop.test').queryByRole('button', { name: 'Filter by tag Review' })).not.toBeInTheDocument();
    expect(readProjectTags(key)).toEqual(initial);
  });

  it('suggests catalog tags that are not on the project while typing', () => {
    writeProjectTags(key, initial);
    render(<Harness />);
    fireEvent.click(row('shop.test').getByRole('button', { name: 'Tags for shop.test' }));
    // Focusing on mount opens the list with the remaining catalog tags.
    const input = within(screen.getByRole('region', { name: 'Tags for shop.test' })).getByLabelText(
      'Tag name',
    );
    const menu = screen.getByRole('menu');
    expect([...menu.children].map((item) => item.textContent)).toEqual(['API']);
    fireEvent.change(input, { target: { value: 'cl' } });
    // "Client" is already on the project, so nothing matches and the list hides.
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('fills the name from a picked suggestion and adds the tag', () => {
    writeProjectTags(key, initial);
    render(<Harness />);
    fireEvent.click(row('api.test').getByRole('button', { name: 'Tags for api.test' }));
    const input = within(screen.getByRole('region', { name: 'Tags for api.test' })).getByLabelText(
      'Tag name',
    );
    fireEvent.change(input, { target: { value: 'larav' } });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Laravel' }));
    expect(input).toHaveValue('Laravel');
    fireEvent.submit(input.closest('form') as HTMLFormElement);
    expect(row('api.test').getByRole('button', { name: 'Filter by tag Laravel' })).toBeInTheDocument();
  });

  it('closes the suggestions with Escape first and the editor only afterwards', async () => {
    writeProjectTags(key, initial);
    render(<Harness />);
    fireEvent.click(row('empty.test').getByRole('button', { name: 'Tags for empty.test' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.keyDown(screen.getByLabelText('Tag name'), { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Tags for empty.test' })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Tags for empty.test' })).not.toBeInTheDocument(),
    );
  });
});
