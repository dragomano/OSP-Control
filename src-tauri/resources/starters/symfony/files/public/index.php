<?php
declare(strict_types=1);
header('Content-Type: text/html; charset=utf-8');
?>
<!doctype html>
<html lang="__LANGUAGE__">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>__SYMFONY_TITLE__</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; }
    main { max-width: 42rem; padding: 3rem; line-height: 1.7; }
    code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
  </style>
</head>
<body>
  <main>
    <h1>__SYMFONY_HEADING__</h1>
    <p>__SYMFONY_INSTRUCTIONS__</p>
    <p><code>composer create-project symfony/skeleton tmp &amp;&amp; robocopy tmp . /E /MOVE</code></p>
    <p>__SYMFONY_DETAILS__</p>
  </main>
</body>
</html>
