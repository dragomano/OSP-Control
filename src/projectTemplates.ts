import catalog from '../src-tauri/resources/project-templates.json';

export type ProjectTemplateId = 'empty' | 'static' | 'php' | 'laravel' | 'wordpress' | 'node';
export type ProjectTemplate = {
  id: ProjectTemplateId;
  php: boolean;
  node: boolean;
  projectRoot: string;
  webRoot: string | null;
  directories: string[];
  files: { path: string; source: string }[];
  settings: Record<string, string>;
};
export const PROJECT_TEMPLATES = catalog as ProjectTemplate[];
export function projectTemplate(id: ProjectTemplateId): ProjectTemplate {
  return PROJECT_TEMPLATES.find((template) => template.id === id) ?? PROJECT_TEMPLATES[0];
}
export function preferredTemplateEngine(options: string[], global = ''): string {
  if (options.includes(global)) return global;
  const numbers = (name: string) => (name.match(/\d+/g) ?? []).map(Number);
  return (
    [...options]
      .sort((a, b) => {
        const left = numbers(a),
          right = numbers(b);
        for (let index = 0; index < Math.max(left.length, right.length); index++) {
          const difference = (left[index] ?? 0) - (right[index] ?? 0);
          if (difference) return difference;
        }
        return a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0;
      })
      .pop() ?? ''
  );
}
