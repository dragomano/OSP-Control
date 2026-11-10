# Aplicación Node.js local

1. Si es necesario, instala la versión de Node.js seleccionada mediante el complemento NVM de OSPanel.
   Reinicia OSPanel y activa el módulo HTTP seleccionado.
2. En la consola de OSPanel, ejecuta `osp project __DOMAIN__ start`.
3. Abre el proyecto en el navegador. El módulo HTTP redirige las peticiones a 127.0.0.1:__PORT__.

El servidor de ejemplo usa módulos integrados de Node.js y no requiere instalar paquetes npm.
Su comando de inicio es `node server.mjs`. También puedes ejecutar `npm start` en el entorno del proyecto.
Si el puerto __PORT__ está ocupado, elige otro puerto de backend y actualiza la constante del puerto en server.mjs.

La plantilla incluye una tarea opcional de inicio único, desactivada inicialmente.
Actívala en la pestaña **__TASKS__** del proyecto solo si la aplicación debe iniciarse con OSPanel.
La creación de esta plantilla no inició ningún proceso automáticamente.
