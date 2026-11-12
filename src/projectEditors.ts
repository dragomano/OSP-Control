import type { EditorInfo } from './ospanel';

export type ProjectEditor = EditorInfo & { custom?: boolean };

// Custom labels come from the executable path on the Rust side, so no caption parsing is needed.
// The executable stem is the stable identity: it lets a custom shortcut replace a detected editor
// even when their display names differ.
export function mergeProjectEditors(system: EditorInfo[], custom: EditorInfo[]): ProjectEditor[] {
  const entries = new Map<string, ProjectEditor>();
  const key = (editor: EditorInfo) => editor.exe?.trim().toLowerCase() || editor.name.trim().toLowerCase();
  const systemNames = new Map<string, string>();
  for (const editor of system) {
    entries.set(key(editor), editor);
    systemNames.set(key(editor), editor.name);
  }
  for (const editor of custom) {
    const name = editor.name.trim();
    if (!name) continue;
    const id = key(editor);
    entries.set(id, { ...editor, name: systemNames.get(id) ?? name, custom: true });
  }
  return [...entries.values()];
}
