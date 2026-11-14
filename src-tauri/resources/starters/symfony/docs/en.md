# Symfony preparation

The project root is this directory and the public root is public/.
public/index.php initially displays an installation placeholder.

1. Enable the selected HTTP and PHP modules in OSPanel.
2. In OSP Control, open the project's **__OVERVIEW__** and click **__INSTALL_BUTTON__**.
3. Composer creates the application in an isolated temporary directory: the skeleton first,
   then `composer require webapp` for a full web application (Twig, Doctrine, MakerBundle).
   Only a successful installation is transferred to the project root. Your .osp settings
   are preserved, and the starter public/.htaccess is kept for Apache routing.
   Extra project files or edits to the placeholder must be resolved before installation.
4. The original scaffold is retained under backups/starters/ in the OSPanel installation.
   Composer failures leave the original scaffold untouched and can be retried.
5. Restart OSPanel and open the site. Activate its console environment with
   `osp project __DOMAIN__`. There is no extra wrapper directory around Symfony's src/.
6. Review .env and your database according to the requirements of the installed version.
   The installer prepares the selected database and writes DATABASE_URL into .env.
   Run `php bin/console doctrine:migrations:migrate` after adding your own migrations.
   npm is not installed or run by OSP Control.

Installation uses the project's selected PHP module (__PHP_ENGINE__) and its active
OSPanel Composer profile. Ensure its PHP extensions meet Symfony's requirements.
The installer refuses to overwrite an existing application or a changed placeholder.

https://symfony.com/doc/current/setup.html

## Database configuration

SQLite creates `var/<selected-name>.sqlite`; the connection is written to .env.
For MySQL, MariaDB or PostgreSQL, start the selected OSPanel module first; the supplied
user needs CREATE DATABASE permission. The installer refuses existing databases and
keeps any database it creates for a later retry. Credentials are stored in
`.osp/database.json` (ignored by Git) and the application `.env`. Keep both private.
With **__CONFIGURE_LATER__**, the application is installed without DATABASE_URL until
configured.
