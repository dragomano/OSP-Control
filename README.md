# OSP Control

**English** · [Русский](README.ru.md)

A UI companion for OSPanel 6. Local environment management: services, projects, domains, configurations, logs, backups — in a single window, with themes and a multilingual interface.

> An unofficial tool created for research purposes, not affiliated with OSPanel / OpenServerPanel. The name "OSPanel" is a trademark of its respective owner.

## Stack

Tauri 2 (Rust) · React 19 · TypeScript · Vite · highlight.js

## Features

### Overview

- Time-of-day greeting with the Windows user name.
- Environment metrics: active services, project count, RAM usage of module worker processes, open ports and conflicts.
- Quick overview of module states and a recent-activity feed from the panel logs.
- A sync button to refresh from the panel.

### Services

- List of local environment modules grouped by category: web servers, languages and runtimes, databases, cache and queues, DNS, mail, tools and other.
- Start / stop / restart a single module, or restart all running modules at once.
- Group filter, service name copying, state indicators (running / stopped / needs attention).
- Data comes from the panel's HTTP API (`/getmodules`), not from localized text tables.
- Manual updates for PHP (same branch), Apache 2.4, Nginx (same branch) and Caddy 2, with optional update checks at startup.
- Release archives are verified with SHA-256 and binary version checks. Updates preserve settings, create a full module backup and support rollback and interrupted-operation recovery. Stopped web servers remain stopped.
- If a Caddy archive is mislabeled, a verified newer stable patch from the same minor branch can be installed; the actual binary version is recorded and displayed.

### Projects

- Project list with search and SSL / PHP version filters.
- Creating a new project (domain, HTTP engine, PHP version, Node), deleting a project.
- Opening in a browser, opening the project folder, copying the domain and path.
- Opening a project in an external editor (installed editors are detected automatically).
- Per-project module settings (HTTP/PHP/Node, auto or global values) with the settings file at hand.
- Module autostart based on projects and panel restart from the UI.

### Configurations

- Viewing module configs with syntax highlighting (highlight.js).
- Search, module filter, opening the file and its folder, copying the content.
- Automatic configuration backup before edits.

### Logs

- Panel and domain logs with auto-refresh.
- "All / errors / warnings" tabs, content search, line copying.

### Backups

- Configuration copies, database dumps (MySQL, MariaDB, PostgreSQL) and project zip archives (node_modules and vendor excluded).
- Creating, restoring and deleting copies; the current state is backed up automatically before a restore.
- Opening the backups folder.

### Settings

- OSPanel installation path with a folder picker.
- App autostart with Windows and module autostart from projects.
- Minimize to system tray on close, notifications.
- Theme (dark / light / system), accent color, font and UI scale.
- Language selection, hot reload of translations.

### General

- Quick search across sections and options (command palette).
- System tray icon (show window / exit).
- Localization: Russian, English, Ukrainian, Belarusian, Spanish.

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

Application preferences, project tags and collapsed menu categories are stored in `settings.toml` beside the executable, independently of the working directory. A fresh portable distribution contains no settings file: defaults are used until the first preference change or metadata save. The application directory must be writable; there is no fallback to AppData for settings.

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

[panel]
path = 'C:\OSPanel'

[menu]
collapsed_categories = ["Development"]

[projects."shop.test"]
tags = ["Client", "Laravel"]
```

Missing fields use built-in defaults. Windows autostart still uses the Windows registry, and WebView2 keeps its technical profile/cache in AppData; neither is a second settings store. Browser preview mode continues to use localStorage. A portable build does not copy development settings into the release folder.

## Application updates

To check for updates manually, use the icon button to the right of **OSP Control** in the left sidebar header, styled like the **Open OSPanel folder** button below it. The update button is also available when the sidebar is collapsed and opens the application-update dialog. **Settings → Autostart & notifications** retains only the separate **Check for application updates at startup** toggle (off by default).

When a new version is found, a compact notice opens a release-details dialog with an **Update and restart** button. Installation always requires confirmation.

Updates use the latest stable GitHub Release from `dragomano/OSP-Control`, selecting `OSP_Control_<version>_<arch>.zip`. The updater checks the exact URL, size, GitHub SHA-256 digest, ZIP paths and PE architecture. GitHub is the trust root: its digest is not an independent publisher signature.

No additional updater is shipped. During installation, `.osp-control-update` beside the executable holds a temporary copy of the same exe and the download. The application directory must be writable, with enough free space for the archive, extracted files and backup. After waiting for the app to exit, the helper **backs up and verifies the previous exe and entire `locales/` directory before replacing any installed files**, saving them in `.osp-control-backups/<identifier>/` beside the application. If creating or verifying the backup fails, installed files are not replaced.

The **exe and entire `locales/` directory are then replaced with the release versions**, without merging: custom edits and additional languages remain only in the backup. User settings are not changed. If replacement fails or the new interface does not acknowledge startup within 60 seconds, both the previous exe and previous `locales/` are restored together (including the absence of `locales/` if it did not exist). After confirmed startup or successful rollback, `.osp-control-update` is cleaned up, but `.osp-control-backups/` is retained. Each backup has its own directory; old backups are never deleted automatically. Remove them manually after verifying the app and recovering any custom translations you need.

A power loss can require manual recovery. Close all application processes and, before deleting `.osp-control-update`, restore **both components from the same completed backup** in `.osp-control-backups/<identifier>/` (a completed backup contains a `complete` file): copy `osp-control.exe` to the application directory under the original exe name and replace the entire current `locales/` with the backup's `locales/`. Do not overlay the dictionaries, which would leave extra files behind. A `no-locales` marker means there was no translation directory before the update; remove it when restoring that backup. `.osp-control-update/backup-path.txt` records this operation's backup path. `previous.exe` and `previous-locales/` inside staging are moved originals for automatic rollback, not separate programs. Keep staging until recovery is complete. Installation is disabled in development builds.

## Localization

Translations live in `src-tauri/resources/locales/*.json` and are embedded into the binary. The portable build ships a copy in `locales/` next to the exe: edit the files there and the changes are picked up when the window regains focus, or via the "Reload translations" button in the settings.

A new language is a single `<code>.json` file (for example `de.json` or `pt_BR.json`) in `locales/` next to the exe; in a dev build — `src-tauri/target/debug/locales/`. The code is 2–8 characters: Latin letters, digits, `-` and `_`. The language appears in the settings on its own — no rebuild needed. File format:
- a flat JSON object "key — non-empty string", no nesting;
- `lang.name` — the language name in itself ("Deutsch"); without it the language will not appear in the settings list;
- `lang.code` — the code matching the file name; no other `lang.*` keys are allowed;
- the full set of keys from `en.json` (the base language): missing keys silently render in English, extra keys are never translated (the exception is plural forms unneeded by the language, see below);
- `{var}` placeholders — the same names as in `en.json`;
- plural forms — `<key>.one/.few/.many/.other`; the required set is the CLDR categories of the language itself (`Intl.PluralRules`): English and German need `.one`/`.other` only, Russian needs all four, Arabic would additionally need `.zero`/`.two`. Forms the language does not need can be omitted; the embedded dictionaries do include them — the key sets are synchronized (a parity test checks this), and such forms are filled with a copy of `.other`.

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
