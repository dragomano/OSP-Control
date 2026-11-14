# 1C-Bitrix project scaffold

1. Restart OSPanel so it discovers __DOMAIN__.
2. Enable the selected HTTP, PHP (__PHP_ENGINE__) and MySQL/MariaDB modules.
3. Download `bitrixsetup.php` (new installation) or `restore.php` (backup archive) into `public/` and remove the starter `public/index.php` when prompted.
4. Open `http://__DOMAIN__/bitrixsetup.php` in your browser and enter your database connection settings.

PHP parameters for 1C-Bitrix are configured in `public/.user.ini`, and URL rewrite rules for Nginx, Apache and Caddy are stored under `.osp/` and `public/.htaccess`.

Where to get the scripts:

- `bitrixsetup.php` is the official installation script of 1C-Bitrix Site Manager. Download it from the vendor site: https://www.1c-bitrix.ru/download/ (Russian edition) or https://www.bitrixsoft.com/ (international edition). The trial license is chosen during the wizard.
- `restore.php` is the official script for deploying a site from a 1C-Bitrix backup archive. It is offered together with the backup created in the site admin panel, or can be downloaded from the same vendor page.
