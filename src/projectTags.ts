import type { OsPanelProject } from './ospanel';
import { displayProjectDomain } from './projectDomain';
import { settingsStorage } from './settingsStorage';

export type ProjectTags = Record<string, string[]>;
export type ProjectTagColor = `#${string}`;
export const isProjectTagColor = (value: unknown): value is ProjectTagColor =>
  typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
export function projectTagAppearance(colors: ProjectTagColors, tag: string) {
  const color = colorForTag(colors, tag);
  return {
    className: color ? 'tag-color-custom' : '',
    style: color ? ({ '--tag-custom': color } as import('react').CSSProperties) : undefined,
  };
}
export type ProjectTagColors = Record<string, ProjectTagColor>;
export const projectTagKey = (value: string) => normalizeProjectTag(value).toLowerCase();
export function colorForTag(colors: ProjectTagColors, tag: string): ProjectTagColor | undefined {
  const key = projectTagKey(tag);
  return Object.keys(colors).includes(key) ? colors[key] : undefined;
}
export function setProjectTagColor(
  colors: ProjectTagColors,
  tag: string,
  color: ProjectTagColor | null,
): ProjectTagColors {
  const next = new Map(Object.entries(colors));
  if (color) next.set(projectTagKey(tag), color);
  else next.delete(projectTagKey(tag));
  return Object.fromEntries(next);
}
export type ProjectSort = 'recent' | 'domain' | 'tags' | 'tags-desc';
export type TagMatch = 'any' | 'all';
export const MAX_PROJECT_TAG_LENGTH = 32;
export const MAX_PROJECT_TAGS = 12;

const tagKey = (value: string) => value.normalize('NFKC').toLowerCase();
const domainKey = (domain: string) => domain.toLowerCase();
export const normalizeProjectTag = (value: string) =>
  value.normalize('NFKC').trim().replace(/^#+/, '').trim().replace(/\s+/gu, ' ');
const validTag = (tag: string) =>
  tag.length > 0 && [...tag].length <= MAX_PROJECT_TAG_LENGTH && !/\p{Cc}/u.test(tag);

// UI metadata only: it never changes OSPanel's project.ini or API data.
export { PROJECT_TAGS_KEY } from './settingsStorage';

export function tagsForProject(tags: ProjectTags, domain: string): string[] {
  const value = tags[domainKey(domain)];
  return Array.isArray(value) ? value : [];
}

export function readProjectTags(key: string): ProjectTags {
  try {
    const parsed: unknown = JSON.parse(settingsStorage.getItem(key) ?? 'null');
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !('version' in parsed) ||
      parsed.version !== 1 ||
      !('projects' in parsed)
    )
      return {};
    const projects = parsed.projects;
    if (!projects || typeof projects !== 'object' || Array.isArray(projects)) return {};
    const result = new Map<string, string[]>();
    for (const [domain, values] of Object.entries(projects)) {
      if (!Array.isArray(values)) continue;
      const unique = new Map<string, string>();
      for (const value of values) {
        if (typeof value !== 'string') continue;
        const tag = normalizeProjectTag(value);
        if (validTag(tag) && !unique.has(tagKey(tag))) unique.set(tagKey(tag), tag);
      }
      if (unique.size) result.set(domainKey(domain), [...unique.values()].slice(0, MAX_PROJECT_TAGS));
    }
    return Object.fromEntries(result);
  } catch {
    return {};
  }
}

export function readProjectTagColors(key: string): ProjectTagColors {
  try {
    const parsed: unknown = JSON.parse(settingsStorage.getItem(key) ?? 'null');
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !('version' in parsed) ||
      parsed.version !== 1 ||
      !('colors' in parsed)
    )
      return {};
    const colors = parsed.colors;
    if (!colors || typeof colors !== 'object' || Array.isArray(colors)) return {};
    const result = new Map<string, ProjectTagColor>();
    for (const [name, color] of Object.entries(colors)) {
      const tag = normalizeProjectTag(name);
      if (validTag(tag) && isProjectTagColor(color)) result.set(tagKey(tag), color);
    }
    return Object.fromEntries(result);
  } catch {
    return {};
  }
}

export function writeProjectTags(key: string, tags: ProjectTags, colors = readProjectTagColors(key)): void {
  try {
    settingsStorage.setItem(key, JSON.stringify({ version: 1, projects: tags, colors }));
  } catch {
    throw new Error('err.projectTagsSaveFailed');
  }
}

export function renameProjectTags(tags: ProjectTags, from: string, to: string): ProjectTags {
  const next = new Map(Object.entries(tags));
  const values = tagsForProject(tags, from);
  next.delete(domainKey(from));
  // A reused domain must not inherit metadata left behind by an older project.
  if (values.length) next.set(domainKey(to), values);
  else next.delete(domainKey(to));
  return Object.fromEntries(next);
}

export function knownProjectTags(tags: ProjectTags): string[] {
  const unique = new Map<string, string>();
  for (const tag of Object.values(tags).flat()) {
    if (!unique.has(tagKey(tag))) unique.set(tagKey(tag), tag);
  }
  return [...unique.values()].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }),
  );
}

// Compute the entire batch before persisting it: a limit failure cannot partially apply it.
export function editProjectTags(
  tags: ProjectTags,
  domains: string[],
  value: string,
  action: 'add' | 'remove',
): ProjectTags {
  const normalized = normalizeProjectTag(value);
  if (!validTag(normalized)) throw new Error('err.invalidProjectTag');
  const tag = knownProjectTags(tags).find((item) => tagKey(item) === tagKey(normalized)) ?? normalized;
  const next = new Map(Object.entries(tags));
  for (const domain of new Set(domains.map(domainKey))) {
    const current = tagsForProject(tags, domain);
    const exists = current.some((item) => tagKey(item) === tagKey(tag));
    if (action === 'add' && !exists && current.length >= MAX_PROJECT_TAGS)
      throw new Error('err.projectTagLimit');
    const values =
      action === 'add'
        ? exists
          ? current
          : [...current, tag]
        : current.filter((item) => tagKey(item) !== tagKey(tag));
    if (values.length) next.set(domain, values);
    else next.delete(domain);
  }
  return Object.fromEntries(next);
}

export function matchesProjectTags(tags: string[], selected: (string | null)[], match: TagMatch): boolean {
  const matches = (value: string | null) =>
    value === null ? tags.length === 0 : tags.some((tag) => tagKey(tag) === tagKey(value));
  return selected.length === 0 || (match === 'all' ? selected.every(matches) : selected.some(matches));
}

export function matchesProjectSearch(project: OsPanelProject, query: string, tags: string[]): boolean {
  const terms = query.trim().match(/#"[^"]+"|"[^"]+"|[^\s]+/gu) ?? [];
  const text = tagKey(
    `${project.domain} ${displayProjectDomain(project.domain)} ${project.path} ${tags.join(' ')}`,
  );
  return terms.every((term) => {
    if (term.startsWith('#')) {
      const needle = tagKey(term.slice(1).replace(/^"|"$/g, ''));
      return tags.some((tag) => tagKey(tag) === needle);
    }
    return text.includes(tagKey(term.replace(/^"|"$/g, '')));
  });
}

export function sortTaggedProjects(
  projects: OsPanelProject[],
  tags: ProjectTags,
  sort: Exclude<ProjectSort, 'recent'>,
  locale: string,
): OsPanelProject[] {
  const compare = new Intl.Collator(locale, { numeric: true, sensitivity: 'base' }).compare;
  return [...projects].sort((a, b) => {
    const domainOrder = compare(displayProjectDomain(a.domain), displayProjectDomain(b.domain));
    if (sort === 'domain') return domainOrder;
    const left = [...tagsForProject(tags, a.domain)].sort(compare);
    const right = [...tagsForProject(tags, b.domain)].sort(compare);
    if (!left.length || !right.length)
      return left.length === right.length ? domainOrder : left.length ? -1 : 1;
    return (
      (sort === 'tags-desc' ? -1 : 1) * compare(left.join('\u0001'), right.join('\u0001')) || domainOrder
    );
  });
}
