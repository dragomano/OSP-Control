import type { ReactNode } from 'react';

// Prose in hints and notes mentions files and folders — "Will create the home/<domain>
// folder with .osp\project.ini". The path is the part a reader scans for, so it is set in
// bold. The markup lives in the code, not in the dictionaries: a hand-edited locale file
// stays plain text and a translator never has to learn a marker syntax.
//
// A token counts as a path when it carries a Windows separator (prose never uses one),
// starts with a directory of the panel, mentions the .osp marker, or ends with a known
// file extension. Ordinary prose slashes — "I/O", "module/add-on" — stay plain.

const PANEL_DIR = /^(?:home|system|modules|bin|config|backups|locales|domains|userdata)[\\/]/i;
const OSP_MARK = /\.osp(?:[-\\/]|$)/i;
const FILE_EXT =
  /\.(?:ini|dat|json|exe|bat|cmd|log|conf|cfg|txt|xml|yaml|yml|md|php|css|sql|zip|db|sqlite|html|htm|htaccess|sh|ps1)$/i;

// Punctuation next to a path stays outside the bold run: the sentence keeps its opening
// bracket and its closing period, only the path itself is highlighted.
const LEAD = /^[([{«"'`]+/;
const TRAIL = /[)\]}»"'`.,;:!?…]+$/;

export type TextPart = { text: string; path: boolean };

export function isPathToken(token: string): boolean {
  if (!/[0-9a-zа-яё]/i.test(token)) return false;

  return token.includes('\\') || PANEL_DIR.test(token) || OSP_MARK.test(token) || FILE_EXT.test(token);
}

// The text split into path and plain runs; the runs join back into the original string
// character for character, whitespace included.
export function splitPaths(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let index = 0;

  const push = (value: string, path: boolean) => {
    if (!value) return;

    const last = parts[parts.length - 1];

    if (last && last.path === path) last.text += value;
    else parts.push({ text: value, path });
  };

  for (const match of text.matchAll(/\S+/g)) {
    const start = match.index ?? 0;
    const raw = match[0];
    const lead = LEAD.exec(raw)?.[0] ?? '';
    const trailMatch = TRAIL.exec(raw);
    const trail = trailMatch && raw.length - lead.length >= trailMatch[0].length ? trailMatch[0] : '';
    const core = raw.slice(lead.length, raw.length - trail.length);

    push(text.slice(index, start), false);

    if (isPathToken(core)) {
      push(lead, false);
      push(core, true);
      push(trail, false);
    } else {
      push(raw, false);
    }

    index = start + raw.length;
  }

  push(text.slice(index), false);

  return parts;
}

// The runs of one text are positional and never reordered, so the offset they start at is
// a stable key: the same string always produces the same keys, whatever the language.
export function PathText({ text }: { text: string }): ReactNode {
  let offset = 0;

  return splitPaths(text).map((part) => {
    const start = offset;
    offset += part.text.length;

    return part.path ? <b key={start}>{part.text}</b> : part.text;
  });
}
