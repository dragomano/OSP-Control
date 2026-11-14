# Preparación de Symfony

La raíz del proyecto es este directorio y la raíz pública es public/.
public/index.php muestra inicialmente una página provisional de instalación.

1. Activa los módulos HTTP y PHP seleccionados en OSPanel.
2. En OSP Control, abre el **__OVERVIEW__** del proyecto y pulsa **__INSTALL_BUTTON__**.
3. Composer crea la aplicación en un directorio temporal aislado: primero el esqueleto,
   después `composer require webapp` para una aplicación web completa (Twig, Doctrine,
   MakerBundle). Solo se transfiere al raíz del proyecto una instalación correcta. Tus
   ajustes .osp se conservan, y el public/.htaccess inicial se mantiene para el enrutado
   de Apache. Los archivos extra del proyecto o las ediciones de la página provisional
   deben resolverse antes de la instalación.
4. La estructura original se conserva en backups/starters/ dentro de la instalación
   de OSPanel. Los fallos de Composer dejan la estructura original intacta y se puede reintentar.
5. Reinicia OSPanel y abre el sitio. Activa el entorno de consola del proyecto con
   `osp project __DOMAIN__`. No hay un directorio envolvente extra alrededor de src/.
6. Revisa .env y tu base de datos según los requisitos de la versión instalada. El
   instalador prepara la base de datos seleccionada y escribe DATABASE_URL en .env. Tras
   añadir tus propias migraciones, ejecuta `php bin/console doctrine:migrations:migrate`.
   npm no se instala ni se ejecuta desde OSP Control.

La instalación usa el módulo PHP seleccionado del proyecto (__PHP_ENGINE__) y su perfil
de Composer activo de OSPanel. Asegúrate de que sus extensiones de PHP cumplen los
requisitos de Symfony. El instalador se niega a sobrescribir una aplicación existente
o una página provisional modificada.

https://symfony.com/doc/current/setup.html

## Configuración de la base de datos

SQLite crea `var/<nombre-elegido>.sqlite`; la conexión se escribe en .env.
Para MySQL, MariaDB o PostgreSQL, inicia primero el módulo de OSPanel seleccionado;
el usuario necesita permiso CREATE DATABASE. El instalador rechaza bases de datos
existentes y conserva las que crea para un reintento. Las credenciales se guardan en
`.osp/database.json` (excluido de Git) y en el `.env` de la aplicación. Mantén ambos
archivos en privado. Con **__CONFIGURE_LATER__**, la aplicación se instala sin
DATABASE_URL hasta que la configures.
