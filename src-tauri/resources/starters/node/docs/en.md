# Local Node.js application

1. Install the selected Node.js version through OSPanel's NVM add-on if needed.
   Restart OSPanel and enable the selected HTTP module.
2. In the OSPanel command line, run `osp project __DOMAIN__ start`.
3. Open the project in the browser. The HTTP module proxies traffic to 127.0.0.1:__PORT__.

The sample server uses Node.js built-ins and needs no npm installation.
Its start command is `node server.mjs`. You can also use `npm start` in the project environment.
If port __PORT__ is already occupied, choose another backend port and update the port constant in server.mjs.

An optional one-time startup task is included but disabled. Enable it in the project's **__TASKS__** tab
only if this application should start automatically with OSPanel.
No processes were started automatically by this scaffold.
