# Local PHP application

1. Restart OSPanel so it discovers __DOMAIN__.
2. Enable the selected HTTP and PHP modules.
3. Open the project in the browser, then replace public/index.php with your application.
4. In the OSPanel command line, use `osp project __DOMAIN__` to activate its PHP environment.

The public directory is public/. Keep dependencies, credentials and other private files outside it.
Project settings are in .osp/project.ini. No packages were installed.
