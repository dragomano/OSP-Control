# Aplicación PHP local

1. Reinicia OSPanel para que detecte __DOMAIN__.
2. Activa los módulos HTTP y PHP seleccionados.
3. Abre el proyecto en el navegador y sustituye public/index.php por tu aplicación.
4. En la consola de OSPanel, ejecuta `osp project __DOMAIN__` para activar el entorno PHP del proyecto.

El directorio público es public/. Guarda las dependencias, credenciales y otros archivos privados fuera de él.
La configuración del proyecto está en .osp/project.ini. No se instaló ningún paquete.
