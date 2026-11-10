# Plantilla inicial de Laravel

La raíz del proyecto es este directorio y el directorio público es public/.
El archivo public/index.php muestra inicialmente una página provisional de instalación.

1. Activa los módulos HTTP y PHP seleccionados en OSPanel.
2. En OSP Control, abre **__OVERVIEW__** del proyecto y pulsa **__INSTALL_LARAVEL__**.
3. Composer crea la aplicación en un directorio temporal aislado. Solo una instalación correcta
   se transfiere a la raíz del proyecto. Se conserva tu configuración de .osp.
   Resuelve los archivos adicionales del proyecto o los cambios en la página provisional antes de instalar.
4. La plantilla original se conserva en backups/project-starters/ dentro de la instalación de OSPanel.
   Si Composer falla, la plantilla permanece intacta y puedes volver a intentarlo.
5. Reinicia OSPanel y abre el sitio. Activa su entorno de consola con
   `osp project __DOMAIN__`. No hay una carpeta adicional alrededor del directorio app/ de Laravel.
6. Revisa .env y la base de datos según los requisitos de la versión instalada.
   El instalador prepara la base de datos seleccionada, descubre los paquetes,
   genera la clave de la aplicación y ejecuta las migraciones. OSP Control no instala ni ejecuta npm.
7. Si es necesario, activa el planificador de Laravel en la pestaña **__TASKS__** del proyecto tras la instalación.

La instalación usa el módulo PHP seleccionado para el proyecto (__PHP_ENGINE__) y su perfil
activo de Composer en OSPanel. Comprueba que sus extensiones PHP cumplan los requisitos de Laravel.
El instalador rechaza sobrescribir una aplicación existente o una página provisional modificada.

https://laravel.com/docs/installation

## Configuración de la base de datos

SQLite crea `database/<selected-name>.sqlite` y ejecuta las migraciones sin un servidor
adicional. Para MySQL, MariaDB o PostgreSQL, inicia primero el módulo de OSPanel seleccionado;
el usuario indicado necesita el permiso CREATE DATABASE. El instalador rechaza usar bases
existentes y conserva la base que crea para volver a intentarlo.
Las credenciales se guardan en `.osp/database.json` (excluido de Git) y en el archivo `.env`
de la aplicación. Mantén ambos archivos privados. Con **__CONFIGURE_LATER__** se omiten
las migraciones; las sesiones y la caché usan archivos, y las colas usan el controlador síncrono hasta configurarlas.
