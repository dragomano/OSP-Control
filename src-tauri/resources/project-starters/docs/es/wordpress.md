# Plantilla inicial de un proyecto WordPress

La raíz del proyecto es `{base_dir}`; OSPanel solo publica `public/`.

1. Guarda la configuración del proyecto y pulsa **__INSTALL_WORDPRESS__** en la pestaña **__OVERVIEW__** del proyecto.
2. El instalador descarga el ZIP estable oficial, verifica su suma de comprobación y extrae
   los archivos de WordPress directamente en `public/`. Conserva `.osp` y `.htaccess`.
3. Si elegiste una base de datos al crear el proyecto, inicia antes el módulo MySQL/MariaDB
   correspondiente. El usuario indicado necesita el permiso CREATE DATABASE.
   Las bases existentes con el nombre seleccionado nunca se sobrescriben. La conexión se configura
   en `public/wp-config.php`; si no elegiste una base, configúrala en el asistente del navegador.
4. Reinicia OSPanel y abre el sitio. Completa el asistente de WordPress para definir el título,
   la cuenta del administrador y el idioma. No se genera una contraseña de administrador automáticamente.

La plantilla original se conserva en `backups/project-starters`.
Si falla la descarga o la extracción, el proyecto permanece intacto. Los archivos adicionales
o los cambios en la página provisional impiden reemplazarla; en ese caso, crea otra plantilla
o instala la aplicación manualmente. La base creada por el instalador se conserva para volver a intentarlo.

Las credenciales se guardan localmente en `.osp/database.json` (excluido de Git).
Mantén privados este archivo y el `wp-config.php` generado cuando compartas el proyecto.
No uses la raíz del proyecto como directorio público.
