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

export function highlightConfig(fileName: string, content: string): string {
  const ext = fileName.slice(fileName.lastIndexOf('.') + 1).toLowerCase();
  return highlightText(content, LANG_BY_EXT[ext]);
}

export function highlightHosts(content: string): string {
  return highlightText(content, 'properties');
}
