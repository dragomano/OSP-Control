import { describe, expect, it } from 'vitest';
import { highlightConfig } from '../src/highlight';
import {
  appendProjectDomain,
  patchProjectIni,
  projectDomains,
  projectFileLanguage,
  projectOpeningUrl,
} from '../src/projectWorkspace';

describe('project settings INI editing', () => {
  const source =
    '\uFEFF; Original\r\n[shop.test]\r\nphp_engine       = PHP-8.3 ; Keep this comment\r\nunknown_option = untouched\r\napp_start_command = cmd.exe /c "echo # text; more"\r\n\r\n[api.shop.test]\r\nphp_engine = PHP-8.2\r\n';
  it('changes only the selected domain while preserving comments, BOM and CRLF', () => {
    const next = patchProjectIni(source, 'shop.test', {
      php_engine: 'PHP-8.4',
      web_root: '{base_dir}\\public',
    });
    expect(next).toContain('php_engine       = PHP-8.4 ; Keep this comment');
    expect(next.startsWith('\uFEFF; Original\r\n')).toBe(true);
    expect(next).toContain('unknown_option = untouched');
    expect(next).toContain('[api.shop.test]\r\nphp_engine = PHP-8.2\r\n');
    expect(next.replace(/\r\n/g, '')).not.toContain('\n');
    expect(projectDomains(next, 'shop.test')[0].values.app_start_command).toBe(
      'cmd.exe /c "echo # text; more"',
    );
  });

  it('removes an override to inherit settings, retaining its comment', () => {
    const next = patchProjectIni(source, 'shop.test', { php_engine: null });
    expect(next).toContain('; Keep this comment');
    expect(projectDomains(next, 'shop.test')[0].values.php_engine).toBeUndefined();
    expect(projectDomains(next, 'shop.test')[1].values.php_engine).toBe('PHP-8.2');
    expect(
      projectDomains(patchProjectIni(source, 'shop.test', { server_aliases: '' }), 'shop.test')[0].values
        .server_aliases,
    ).toBe('');
    expect(
      patchProjectIni(source, 'api.shop.test', { server_aliases: 'api-alias.test' }).endsWith('\r\n'),
    ).toBe(true);
  });

  it('normalizes new domains and rejects duplicate identities and injected values', () => {
    const next = appendProjectDomain(source, 'shop.test', 'ADMIN.Shop.test');
    expect(projectDomains(next, 'shop.test').map((item) => item.domain)).toEqual([
      'shop.test',
      'api.shop.test',
      'admin.shop.test',
    ]);
    expect(() => appendProjectDomain(source, 'shop.test', 'SHOP.TEST')).toThrow(
      'err.projectWorkspaceDuplicate',
    );
    expect(() => appendProjectDomain(source, 'shop.test', 'auto')).toThrow('err.invalidDomain');
    expect(() => patchProjectIni(source, 'shop.test', { web_root: 'bad\n[other.test]' })).toThrow(
      'err.projectWorkspaceInvalid',
    );
  });
});

describe('web server syntax selection', () => {
  it('uses the selected scheme port and configured opening URL', () => {
    expect(
      projectOpeningUrl('shop.test', { tls_enabled: 'off', http_port: '8080', https_port: '8443' }, true),
    ).toBe('http://shop.test:8080');
    expect(
      projectOpeningUrl(
        'shop.test',
        { base_url: '{host_scheme}://{host}{scheme_port}/admin', https_port: '8443' },
        true,
      ),
    ).toBe('https://shop.test:8443/admin');
  });

  it('selects Nginx for project snippets and module configurations with the same extension', () => {
    const code = 'location / {\n  try_files $uri /index.php;\n}';
    expect(highlightConfig('nginx/shop.test.conf', code)).toContain('hljs-variable');
    expect(highlightConfig('shop.test.conf', code, 'Nginx')).toBe(
      highlightConfig('nginx/shop.test.conf', code),
    );
    expect(projectFileLanguage('nginx/shop.test.conf')).toBe('Nginx');
  });

  it('highlights Apache and Caddy separately, escaping source markup', () => {
    expect(
      highlightConfig('apache/shop.test.conf', '<Directory "public">\nRequire all granted\n</Directory>'),
    ).toContain('hljs-section');
    const caddy = highlightConfig(
      'caddy/shop.test.conf',
      '# Comment\nreverse_proxy @app {env.UPSTREAM}\nrespond "<script>"',
    );
    expect(caddy).toContain('hljs-comment');
    expect(caddy).toContain('hljs-variable');
    expect(caddy).toContain('&lt;script&gt;');
    expect(caddy).not.toContain('<script>');
    expect(highlightConfig('templates/settings.ini', '[main]\nport = 8080', 'Caddy')).toContain('hljs-attr');
    expect(projectFileLanguage('caddy/shop.test.conf')).toBe('Caddyfile');
  });
});
