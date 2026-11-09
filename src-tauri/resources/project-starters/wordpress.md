# WordPress project preparation

The project root is `{base_dir}`; only `public/` is served by OSPanel.

1. Save project settings, then choose **Install WordPress** in the project overview.
2. The installer downloads the official stable ZIP, verifies its checksum and extracts
   the WordPress files directly into `public/`. It preserves `.osp` and `.htaccess`.
3. If a database was selected when creating the project, start that MySQL/MariaDB
   module before installation. The supplied account needs CREATE DATABASE permission.
   Existing databases with the selected name are never overwritten. Connection
   settings are written into `public/wp-config.php`; otherwise use the browser wizard.
4. Restart OSPanel and open the site. Complete the WordPress wizard to set the site
   title, administrator account and language. No administrator password is generated.

The original preparation is backed up under `backups/project-starters`.
A failed download or extraction leaves the project intact. Extra files or edits to
this public placeholder prevent replacement; use a fresh preparation or install
manually in that case. A database already created by this installer remains for retry.

Database credentials are stored locally in `.osp/database.json` (ignored by Git).
Keep this file and the generated `wp-config.php` private when sharing your project.
Do not expose the project root as the public directory.
