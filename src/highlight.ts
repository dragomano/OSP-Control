import hljs from 'highlight.js/lib/core';
import apache from 'highlight.js/lib/languages/apache';
import ini from 'highlight.js/lib/languages/ini';
import json from 'highlight.js/lib/languages/json';
import nginx from 'highlight.js/lib/languages/nginx';
import properties from 'highlight.js/lib/languages/properties';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

hljs.registerLanguage('ini', ini);
hljs.registerLanguage('apache', apache);
hljs.registerLanguage('nginx', nginx);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('json', json);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('properties', properties);
hljs.registerLanguage('caddy', (language) => ({
  name: 'Caddyfile',
  contains: [
    language.HASH_COMMENT_MODE,
    language.QUOTE_STRING_MODE,
    { scope: 'string', begin: /`/, end: /`/ },
    { scope: 'variable', begin: /\{[\w.$:-]+\}/ },
    { scope: 'symbol', begin: /@[\w-]+/ },
    { scope: 'section', begin: /\([\w-]+\)/ },
    { scope: 'keyword', begin: /^[ \t]*[a-z_][\w-]*/ },
    language.NUMBER_MODE,
  ],
}));

const LANG_BY_EXT: Record<string, string> = {
  ini: 'ini',
  cnf: 'ini',
  cfg: 'ini',
  toml: 'ini',
  conf: 'apache',
  vhost: 'apache',
  htaccess: 'apache',
  yaml: 'yaml',
  yml: 'yaml',
  json: 'json',
  xml: 'xml',
};

const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function highlightText(content: string, language?: string): string {
  if (!language) return escapeHtml(content);

  try {
    return hljs.highlight(content, { language, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(content);
  }
}

export function highlightConfig(fileName: string, content: string, service = ''): string {
  const path = `${service}/${fileName}`.replace(/\\/g, '/').toLowerCase();
  const ext = fileName.slice(fileName.lastIndexOf('.') + 1).toLowerCase();
  const engine =
    /(?:^|\/)nginx(?:\/|$)/.test(path) || /nginx\.conf$/.test(path)
      ? 'nginx'
      : /(?:^|\/)caddy(?:\/|$)/.test(path) || /caddyfile(?:\.|$)/.test(path)
        ? 'caddy'
        : undefined;
  return highlightText(
    content,
    ext === 'conf' || /caddyfile(?:\.|$)/.test(path) ? (engine ?? LANG_BY_EXT[ext]) : LANG_BY_EXT[ext],
  );
}

export function highlightHosts(content: string): string {
  return highlightText(content, 'properties');
}
