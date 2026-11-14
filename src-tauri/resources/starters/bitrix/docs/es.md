# Estructura de proyecto 1C-Bitrix

1. Reinicia OSPanel para que detecte __DOMAIN__.
2. Activa los módulos HTTP, PHP (__PHP_ENGINE__) y MySQL/MariaDB seleccionados.
3. Descarga `bitrixsetup.php` (instalación nueva) o `restore.php` (copia de seguridad) en `public/` y elimina el archivo inicial `public/index.php` cuando se solicite.
4. Abre `http://__DOMAIN__/bitrixsetup.php` en el navegador e introduce los datos de conexión a la base de datos.

Los parámetros de PHP para 1C-Bitrix están configurados en `public/.user.ini`, y las reglas de URL para Nginx, Apache y Caddy están guardadas en `.osp/` y `public/.htaccess`.

Dónde obtener los scripts:

- `bitrixsetup.php` es el script de instalación oficial de 1C-Bitrix Site Manager. Descárgalo del sitio del proveedor: https://www.1c-bitrix.ru/download/ (edición rusa) o https://www.bitrixsoft.com/ (internacional). La licencia de prueba se elige en el asistente.
- `restore.php` es el script oficial para desplegar un sitio desde una copia de seguridad de 1C-Bitrix. Se ofrece junto con la copia creada en el panel de administración del sitio, o se puede descargar de la misma página del proveedor.
