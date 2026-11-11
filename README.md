# OSP Control

![Stack](https://skillicons.dev/icons?i=tauri,rust,react,ts,vite)

**English** · [Русский](README.ru.md)

A UI companion for OSPanel 6. Local environment management: services, projects, domains, configurations, logs, backups — in a single window, with themes and a multilingual interface.

> An unofficial tool created for research purposes, not affiliated with OSPanel / OpenServerPanel. The name "OSPanel" is a trademark of its respective owner.

## Features

### Overview

- Time-of-day greeting with the Windows user name.
- Environment metrics: active services, project count, RAM usage of module worker processes, open ports and conflicts.
- Quick overview of module states and a recent-activity feed from the panel logs.
- A sync button to refresh from the panel.

### Modules

- List of local environment modules grouped by category: web servers, languages and runtimes, databases, cache and queues, DNS, mail, tools and other.
- Start / stop / restart a single module, or restart all running modules at once.
- Group filter, service name copying, state indicators (running / stopped / needs attention).
- Data comes from the panel's HTTP API (`/getmodules`), not from localized text tables.
- Manual updates for PHP (same branch), Apache 2.4, Nginx (same branch) and Caddy 2, with optional update checks at startup.
- Release archives are verified with SHA-256 and binary version checks. Updates preserve settings, create a full module backup and support rollback and interrupted-operation recovery. Stopped web servers remain stopped.
- If a Caddy archive is mislabeled, a verified newer stable patch from the same minor branch can be installed; the actual binary version is recorded and displayed.
- Update sources are configured per module family (PHP, Apache, Nginx, Caddy): GitHub Releases or HTTPS catalogs of Windows ZIP builds with SHA-256 checksums, checked from top to bottom. Up to 32 addresses per family; an empty list disables checks for it.
- PHP package revisions (for example `8.5.12-2`) are tracked, so a rebuilt package of the same version is offered and displayed correctly.

### Projects

- Project list with search across domains, paths and tags (`#tag` matches a tag exactly) and filters by SSL/TLS, PHP version, HTTP engine and tags (any / all / untagged).
- Colored tags (up to 12 per project, 32 characters each) with a custom color per tag, bulk assignment and removal for selected projects.
- Sorting by last modification, domain or tag name; each row shows the last modified date and time grouped into Today / Yesterday / Earlier, plus the last modified file on demand.
- Creating a project (domain, HTTP engine, PHP version, Node version), renaming a domain and deleting a project. Renaming moves `home/<domain>` and the domain in `project.ini`, keeps tags and module versions, and backs up `project.ini` first.
- Project templates in the creation dialog: empty, static HTML, PHP, Laravel preparation, WordPress preparation and a dependency-free Node.js server. A preview lists directories/files and required modules; templates configure public roots, local routing and optional disabled tasks. Node.js versions are discovered in the NVM add-on; when none are installed, the dialog offers a copyable installation command and refreshes versions without resetting the form.
- New scaffold instructions and starter pages use the application language at creation (English, Russian, Ukrainian, Belarusian or Spanish). Changing the interface language later does not rewrite existing files. Application-supplied README files and other third-party documents are preserved.
- Laravel preparation creates a working public placeholder with the project root at the domain folder. **Install Laravel** in the project overview explicitly runs Composer with the selected PHP module and its active Composer profile in an isolated temporary directory, then transfers the successful application into the project root, preserving `.osp`. Extra files, placeholder edits or changes during installation prevent replacement. The original scaffold is backed up under `backups/project-starters`. Progress and Composer output are shown; failed Composer runs leave the scaffold intact. npm is not run; application key generation, package discovery and migrations run after database configuration. Instructions are in `.osp/laravel-readme.md`.
- **Install WordPress** downloads the official stable archive over HTTPS, checks its official SHA-1 checksum, validates archive paths and extracts the CMS directly into `public/`. The `.osp` directory and routing rules are preserved, with an original scaffold backup and rollback on publication failure. Download progress and actionable errors are shown. Restart OSPanel and open the site to finish the WordPress setup wizard.
- Database settings for new Laravel and WordPress projects: choose an installed MySQL/MariaDB module (also PostgreSQL for Laravel), a new database name and credentials, or configure the connection later. Laravel defaults to a named SQLite file with migrations. Server databases are created during installation through the selected module client; the module must be running and the account must have CREATE DATABASE permission. Existing databases are rejected; databases created by this installer are retained for retry. Local credentials live in `.osp/database.json`, excluded by `.osp/.gitignore`; installed applications also receive `.env` or `public/wp-config.php`.
- Enabling and disabling an SSL/TLS certificate per project.
- Opening in a browser, opening the project folder, copying the domain and path.
- Opening a project in an external editor (installed editors are detected automatically).
- Per-project module settings (HTTP/PHP/Node, auto or global values) with the settings file at hand.
- Module autostart based on projects and panel restart from the UI.

### Project settings

Open a project's name or choose **Project settings** from its row menu to access the tabbed workspace. The existing project list keeps its search, filters and tags when returning. The workspace supports domains sharing one project folder, aliases, module versions, directories, ports, TLS and backend proxy settings. Environment variables are edited in `.osp/env.ini`.

The **Menu** tab reuses the visual OSPanel menu editor: tree, categories, drag and drop, item properties, icon picker and undo/redo. The workspace's shared Save button writes `.osp/menu.ini` with an exact backup, preserving comments and unknown fields. The global menu is unaffected, and menu drafts survive project tab changes.

The **Tasks** tab edits `.osp/tasks.ini` visually for each domain: add, duplicate, delete, rename, enable/disable, schedule presets or five numeric cron fields, launch limits and commands. Weekdays follow OSPanel numbering (1 = Monday, 7 = Sunday). Drafts, including incomplete fields, survive tab and domain changes. Shared Save (or Ctrl+S on the Tasks tab) validates definitions and preserves comments, other domains, BOM and line endings, with the same backup and conflict checks as other project files. Restart OSPanel to apply changes.

The **Diagnostics** tab runs read-only checks for the selected saved domain: project configuration and active state, required modules, pending settings, project/public directories, DNS, TCP connections to HTTP/HTTPS/backend endpoints, TLS file availability, local configuration snippet readability, menu/task definitions and the last 64 KiB of the domain error log. Results distinguish passed, warning, problem and unchecked states, include repair guidance and links to the relevant project tabs, and can be filtered to issues. Unsaved edits and outdated results are marked. Checks never execute project scripts, request application pages, modify files or restart OSPanel automatically; TCP checks do not validate HTTP responses, TLS trust or full server configuration syntax.

Domain configuration files have separate Nginx, Apache and Caddyfile highlighting. Direct `project.ini` editing is also available. Existing files receive exact backups under `backups/project-settings` before replacement; external edits are detected before saving. Restart OSPanel to apply changes.

### Configurations

- Viewing module configs with syntax highlighting (highlight.js).
- Search, module filter, opening the file and its folder, copying the content.
- Automatic configuration backup before edits.

### Menu editor

- Visual editor of the OSPanel menu (`system/menu.dat`): item tree with categories (one nesting level), drag and drop, and moving items up or down.
- Item properties: caption, command, working directory, Font Awesome icon picker, visibility, hiding the launched window, separators, launch conditions (domain alias, running module, start command, Windows Terminal, shell, web UI) and a required module category. Unknown fields are preserved and editable.
- Adding, duplicating and deleting items; adding, renaming and deleting empty categories; undo / redo, search, expand / collapse all — the tree state is remembered.
- Saving validates the menu, creates an automatic backup and detects changes made to `menu.dat` outside the editor; a toast offers to restart OSPanel. Menu copies are restored from Backups.

### Logs

- Panel and domain logs with auto-refresh.
- "All / errors / warnings" tabs with counters, content search, line copying.
- Clearing the current log or all logs at once with confirmation; the files stay in place for new events.

### Backups

- Configuration copies, database dumps (MySQL, MariaDB, PostgreSQL), project zip archives (node_modules and vendor excluded) and exact copies of `system/menu.dat`.
- Creating, restoring and deleting copies; the current state is backed up automatically before a restore (a menu restore also offers a panel restart).
- Filter by backup type: configurations, databases, projects, OSPanel menu.
- Opening the backups folder.

### Settings

- OSPanel installation path with a folder picker.
- App autostart with Windows and module autostart from projects.
- Minimize to system tray on close, notifications.
- Theme (dark / light / system), six accent colors, six fonts and a UI scale from 80% to 130%.
- Language selection, hot reload of translations.
- Module update checks at startup and custom update sources per module family: one HTTPS address per line, up to 32, with format validation; an empty list disables checks.

### General

- Quick search across sections and options with the `/` shortcut, arrow keys and Enter (command palette).
- System tray icon (show window / exit).
- Single instance: launching the app again brings the existing window to the front.
- The window opens fitted to the screen working area; a manually resized size is remembered between launches.
- Feedback card in the sidebar with a link to GitHub Discussions.
- Localization: Russian, English, Ukrainian, Belarusian, Spanish — [details](#localization).

## Development

```bash
pnpm install
pnpm tauri:dev        # app with live UI reload
pnpm build            # frontend only (tsc + vite)
pnpm coverage         # tests with coverage thresholds
pnpm tauri:build      # portable build in dist-portable/ (exe + locales/)
pnpm lint             # Biome: lint + format check
pnpm format           # Biome: formatting
pnpm test             # Vitest (jsdom)
```

`pnpm tauri:build` produces the portable version only — no installers (MSI/NSIS) are created. The result is the folder `dist-portable/OSP_Control_<version>_<arch>/`: `osp-control.exe` with the editable `locales/` folder next to it. The app needs the WebView2 Runtime, as any Tauri app on Windows does; if the system has none, install the Evergreen WebView2 Runtime from Microsoft.

## Portable settings

Application preferences, the window size, project tags and their colors, module update sources and collapsed menu categories are stored in `settings.toml` beside the executable, independently of the working directory. A fresh portable distribution contains no settings file: defaults are used until the first preference change or metadata save. The application directory must be writable; there is no fallback to AppData for settings.

On the first launch after upgrading, existing WebView localStorage preferences and the old AppData `settings.json` are migrated automatically. The TOML file takes precedence when present. Migration sources are retained until writing succeeds; the native JSON is then renamed to `settings.json.migrated` and migrated localStorage keys are removed.

The file uses `toml_edit` to retain comments, unrelated formatting and unknown keys. Updates are serialized, written to a temporary sibling and replaced atomically; the previous valid file is kept as `settings.toml.bak`. Invalid TOML or unsupported schema versions are reported in the interface and never overwritten automatically. Correct the file or restore the backup, then retry. Manual edits are loaded on the next application start. Changes to a value can reformat that value.

```toml
schema_version = 1

[interface]
language = "en"
theme = "dark"
accent = "blue"
font = "dm-sans"
scale = 100
sidebar_collapsed = false

[behavior]
close_to_tray = true
notifications = true
autostart_projects = false

[updates]
application = false
modules = false

[window]
width = 1440
height = 900

[panel]
path = 'C:\OSPanel'

[update_sources]
php = ["https://example.com/php-releases.json"]
apache = []

[menu]
collapsed_categories = ["Development"]

[projects."shop.test"]
tags = ["Client", "Laravel"]

[project_tag_colors]
client = "#2f81f7"
```

Missing fields use built-in defaults. Windows autostart still uses the Windows registry, and WebView2 keeps its technical profile/cache in AppData; neither is a second settings store. Browser preview mode continues to use localStorage. A portable build does not copy development settings into the release folder.

## Application updates

To check for updates manually, use the icon button to the right of **OSP Control** in the left sidebar header, styled like the **Open OSPanel folder** button below it. The update button is also available when the sidebar is collapsed and opens the application-update dialog. **Settings → Autostart & notifications** retains only the separate **Check for application updates at startup** toggle (off by default).

When a new version is found, a compact notice opens a release-details dialog with the release notes and an **Update and restart** button. Notes are rendered from Markdown into safe elements: raw HTML is shown as plain text. Installation always requires confirmation.

Updates use the latest stable GitHub Release from `dragomano/OSP-Control`, selecting `OSP_Control_<version>_<arch>.zip`. The updater checks the exact URL, size, GitHub SHA-256 digest, ZIP paths and PE architecture. GitHub is the trust root: its digest is not an independent publisher signature.

No additional updater is shipped. During installation, `.osp-control-update` beside the executable holds a temporary copy of the same executable and the download. The application directory must be writable, with enough free space for the archive, extracted files and backup. After waiting for the app to exit, the helper **backs up and verifies the previous executable and entire `locales/` directory before replacing any installed files**, saving them in `.osp-control-backups/<identifier>/` beside the application. If creating or verifying the backup fails, installed files are not replaced.

The **executable and entire `locales/` directory are then replaced with the release versions**, without merging: custom edits and additional languages remain only in the backup. User settings are not changed. If replacement fails or the new interface does not acknowledge startup within 60 seconds, both the previous executable and previous `locales/` are restored together (including the absence of `locales/` if it did not exist). After confirmed startup or successful rollback, `.osp-control-update` is cleaned up, but `.osp-control-backups/` is retained. Each backup has its own directory; old backups are never deleted automatically. Remove them manually after verifying the app and recovering any custom translations you need.

A power loss can require manual recovery. Close all application processes and, before deleting `.osp-control-update`, restore **both components from the same completed backup** in `.osp-control-backups/<identifier>/` (a completed backup contains a `complete` file): copy `osp-control.exe` to the application directory under the original executable name and replace the entire current `locales/` with the backup's `locales/`. Do not overlay the dictionaries, which would leave extra files behind. A `no-locales` marker means there was no translation directory before the update; remove it when restoring that backup. `.osp-control-update/backup-path.txt` records this operation's backup path. `previous.exe` and `previous-locales/` inside staging are moved originals for automatic rollback, not separate programs. Keep staging until recovery is complete. Installation is disabled in development builds.

## Localization

The interface is available in five languages. The list below matches the language picker in **Settings → Appearance**, where languages are sorted by their native name.

| Language                    | Code | Plural categories             | Dictionary                                       |
| --------------------------- | ---- | ----------------------------- | ------------------------------------------------ |
| **English** — base language | `en` | `one`, `other`                | [`en.json`](src-tauri/resources/locales/en.json) |
| Español (Spanish)           | `es` | `one`, `many`, `other`        | [`es.json`](src-tauri/resources/locales/es.json) |
| Беларуская (Belarusian)     | `be` | `one`, `few`, `many`, `other` | [`be.json`](src-tauri/resources/locales/be.json) |
| Русский (Russian)           | `ru` | `one`, `few`, `many`, `other` | [`ru.json`](src-tauri/resources/locales/ru.json) |
| Українська (Ukrainian)      | `uk` | `one`, `few`, `many`, `other` | [`uk.json`](src-tauri/resources/locales/uk.json) |

English is the base language: anything missing from another dictionary silently falls back to it.

Translations live in `src-tauri/resources/locales/*.json` and are embedded into the binary. The portable build ships a copy in `locales/` next to the executable: edit the files there and the changes are picked up when the window regains focus, or via the "Reload translations" button in the settings.

A new language is a single `<code>.json` file (for example `de.json` or `pt_BR.json`) in `locales/` next to the executable; in a dev build — `src-tauri/target/debug/locales/`. The code is 2–8 characters: Latin letters, digits, `-` and `_`. The language appears in the settings on its own — no rebuild needed. File format:

- a JSON object of "key — non-empty string" entries; a plural family is a nested object (see below);
- the keys are listed in the order of `en.json` (the base language), so two dictionaries can be compared line by line;
- `lang.name` — the language name in itself ("Deutsch"); without it the language will not appear in the settings list;
- `lang.code` — the code matching the file name; no other `lang.*` keys are allowed;
- the full set of keys from `en.json`: missing keys silently render in English, extra keys are never translated;
- `{var}` placeholders — the same names as in `en.json`;
- plural forms — a nested object under the family key, for example `"settings.sourcesCount": { "one": "{count} address", "other": "{count} addresses" }`. The forms are the CLDR categories of the language itself (`Intl.PluralRules`): English and German need `one`/`other` only, Russian needs all four, Arabic would additionally need `zero`/`two`. Only the forms the language needs have to be present. The old flat style (`"settings.sourcesCount.one"`) is still read, so a file written that way keeps working. In Russian, Ukrainian and Belarusian `other` covers fractions, where the noun takes the genitive singular (“1,5 файла”).

When a file is loaded the app validates it and lists the found issues in a toast; the same rules are enforced in the repository by parity tests (`pnpm test`). To embed a language into the distribution, add the same file to `src-tauri/resources/locales/`, an import to `src/i18n.ts` and a fallback to `src-tauri/src/locales.rs` — the tests pick up the new dictionary automatically.

## Security

Every Rust command validates its input: action whitelists, path canonicalization with a check that the path belongs to the OSPanel directory, automatic backups before configuration restores. Nothing from user input is executed directly.

## Code signing

Free code signing provided by [SignPath.io](https://signpath.io), certificate by [SignPath Foundation](https://signpath.org).

Status: application to SignPath Foundation is pending; current releases are not yet signed. See the [code signing policy](CODE_SIGNING_POLICY.md) for details.

## Additional resources

- https://v2.tauri.app/
- https://react.dev/
- https://github.com/OSPanel/OpenServerPanel/wiki
- https://vite.dev
- https://biomejs.dev/

## License

[MIT](LICENSE)
