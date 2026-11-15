# Preparación del proyecto SMF

La raíz del proyecto es `{base_dir}`; OSPanel solo sirve `public/`.

1. Guarda la configuración del proyecto y luego elige **__INSTALL_BUTTON__** en la pestaña **__OVERVIEW__** del proyecto.
2. El instalador descargará la última compilación de SMF 2.1 desde la fuente
   nocturna de la comunidad, verificará el archivo y extraerá los archivos de SMF
   directamente en `public/`. Se conservan `.osp` y el `.gitignore` de la plantilla.
3. Si se seleccionó una base de datos al crear el proyecto, el módulo de
   MySQL/MariaDB/PostgreSQL debe estar en marcha antes de instalar, y la cuenta debe
   tener permiso CREATE DATABASE. Las bases de datos existentes con el nombre elegido
   nunca se sobrescriben. La conexión se configura en el asistente de SMF.
4. Reinicia OSPanel y abre el sitio. El asistente de SMF pedirá el idioma del foro,
   la conexión a la base de datos y la cuenta de administrador. El asistente solo
   ofrece idiomas cuyos paquetes ya estén descomprimidos en el directorio de
   instalación; este paquete incluye inglés, así que realiza la instalación en
   inglés. Los demás idiomas se descargan más tarde desde el panel de administración
   del foro (Languages), donde también puedes cambiar el idioma predeterminado.
   Los paquetes de idiomas están disponibles en
   https://download.simplemachines.org/index.php?languages. No se genera ninguna
   contraseña de administrador.

La plantilla original se guarda en `backups/starters`.
Una descarga o extracción fallida deja el proyecto intacto. Los archivos adicionales
o las ediciones de esta página provisional en public/ impiden reemplazarla; en ese
caso, usa una preparación nueva o instala manualmente. Una base de datos ya creada
por este instalador se conserva para reintentar.

Las credenciales de la base de datos se guardan localmente en `.osp/database.json`
(ignorado por Git) y el foro escribe su propia configuración en `public/Settings.php`.
Mantén privado este archivo al compartir el proyecto. No expongas la raíz del
proyecto como directorio público.
