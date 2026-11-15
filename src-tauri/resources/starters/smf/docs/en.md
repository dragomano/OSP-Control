# SMF project preparation

The project root is `{base_dir}`; only `public/` is served by OSPanel.

1. Save project settings, then choose **__INSTALL_BUTTON__** in the project's **__OVERVIEW__** tab.
2. The installer downloads the latest SMF 2.1 build from the community nightly
   source, verifies the archive and extracts the SMF files directly into `public/`.
   It preserves `.osp` and the scaffold `.gitignore`.
3. If a database was selected when creating the project, that MySQL/MariaDB/
   PostgreSQL module must be running before installation, and the supplied account
   needs CREATE DATABASE permission. Existing databases with the selected name are
   never overwritten. The connection itself is configured in the SMF setup wizard.
4. Restart OSPanel and open the site. The SMF setup wizard asks for the forum
   language, the database connection and the administrator account. The wizard
   only offers languages whose packs are already unpacked into the install
   directory; this package includes English, so run the setup in English. Other
   languages are downloaded later from the forum's admin panel (Languages), where
   you can also set the default language. Language packs are available at
   https://download.simplemachines.org/index.php?languages. No administrator
   password is generated.

The original preparation is backed up under `backups/starters`.
A failed download or extraction leaves the project intact. Extra files or edits to
this public placeholder prevent replacement; use a fresh preparation or install
manually in that case. A database already created by this installer remains for retry.

Database credentials are stored locally in `.osp/database.json` (ignored by Git)
and the forum writes its own settings into `public/Settings.php`. Keep this file
private when sharing your project. Do not expose the project root as the public directory.
