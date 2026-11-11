import type { ReactNode } from 'react';

// Prose in hints and notes mentions files and folders — "Will create the home\<domain>
// folder with .osp\project.ini". The path is the part a reader scans for, so it is set in
// bold. The markup lives in the code, not in the dictionaries: a hand-edited locale file
// stays plain text and a translator never has to learn a marker syntax.
//
// A token counts as a path when it carries a Windows separator (prose never uses one),
// starts with a directory of the panel, mentions the .osp marker, ends with a known
// file extension, or is one of the few directory names prose references bare. Ordinary
// prose slashes — "I/O", "module/add-on" — stay plain.

const PANEL_DIR = /^(?:home|system|modules|bin|config|backups|locales|domains|userdata|public)[\\/]/i;
const OSP_MARK = /\.osp(?:[-\\/]|$)/i;
const FILE_EXT =
  /\.(?:ini|dat|json|exe|bat|cmd|log|conf|cfg|txt|xml|yaml|yml|md|php|css|sql|zip|db|sqlite|html|htm|htaccess|sh|ps1)$/i;

// Directory names that prose references bare — without a separator or extension
// ("A copy of the config folder", "node_modules and vendor are excluded"). The list is
// narrow on purpose: "modules", "public" and "domains" are also ordinary words, so
// without a separator they stay plain.
const BARE_DIR = /^(?:config|node_modules|vendor)$/i;

// Punctuation next to a path stays outside the bold run: the sentence keeps its opening
// bracket and its closing period, only the path itself is highlighted.
const LEAD = /^[([{«"'`]+/;
const TRAIL = /[)\]}»"'`.,;:!?…]+$/;

export type TextPart = { text: string; path: boolean };

export function isPathToken(token: string): boolean {
  if (!/[0-9a-zа-яё]/i.test(token)) return false;

  return (
    token.includes('\\') ||
    PANEL_DIR.test(token) ||
    OSP_MARK.test(token) ||
    FILE_EXT.test(token) ||
    BARE_DIR.test(token)
  );
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
//
// The runs are grouped under a single <span>: in a container that gaps its children
// (an inline-flex text-button, for example) each bare run would become a separate flex
// item and the gap would tear the sentence apart around every highlighted path.
export function PathText({ text }: { text: string }): ReactNode {
  let offset = 0;

  return (
    <span>
      {splitPaths(text).map((part) => {
        const start = offset;
        offset += part.text.length;

        return part.path ? <b key={start}>{part.text}</b> : part.text;
      })}
    </span>
  );
}
