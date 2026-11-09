# Laravel preparation

The project root is this directory and the public root is public/.
public/index.php initially displays an installation placeholder.

1. Enable the selected HTTP and PHP modules in OSPanel.
2. In OSP Control, open the project's Overview and click Install Laravel.
3. Composer creates the application in an isolated temporary directory. Only a successful
   installation is transferred to the project root. Your .osp settings are preserved.
   Extra project files or edits to the placeholder must be resolved before installation.
4. The original scaffold is retained under backups/project-starters/ in the OSPanel installation.
   Composer failures leave the original scaffold untouched and can be retried.
5. Restart OSPanel and open the site. Activate its console environment with
   `osp project __DOMAIN__`. There is no extra wrapper directory around Laravel's app/.
6. Configure .env and your database according to the requirements of the installed version.
   Composer runs Laravel setup steps; npm is not installed or run by OSP Control.
7. If needed, enable Laravel scheduler in the project's Tasks tab after installation.

Installation uses the project's selected PHP module (__PHP_ENGINE__) and its active
OSPanel Composer profile. Ensure its PHP extensions meet Laravel's requirements.
The installer refuses to overwrite an existing application or a changed placeholder.

https://laravel.com/docs/installation

## Database configuration

SQLite creates `database/<selected-name>.sqlite` and runs migrations without a
separate database server. For MySQL, MariaDB or PostgreSQL, start the selected OSPanel
module first; the supplied user needs CREATE DATABASE permission. The installer
refuses existing databases and keeps any database it creates for a later retry.
Credentials are stored in `.osp/database.json` (ignored by Git) and the application
`.env`. Keep both files private. With **Configure later**, migrations are skipped
and sessions, cache and queues use file/synchronous drivers until configured.
