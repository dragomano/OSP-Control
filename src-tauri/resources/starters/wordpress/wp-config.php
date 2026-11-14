<?php
// Generated for this local project by OSP Control.
define('DB_NAME', {dbName});
define('DB_USER', {dbUsername});
define('DB_PASSWORD', {dbPassword});
define('DB_HOST', {dbHostPort});
define('DB_CHARSET', 'utf8mb4');
define('DB_COLLATE', '');
define('AUTH_KEY', '{authKey}');
define('SECURE_AUTH_KEY', '{secureAuthKey}');
define('LOGGED_IN_KEY', '{loggedInKey}');
define('NONCE_KEY', '{nonceKey}');
define('AUTH_SALT', '{authSalt}');
define('SECURE_AUTH_SALT', '{secureAuthSalt}');
define('LOGGED_IN_SALT', '{loggedInSalt}');
define('NONCE_SALT', '{nonceSalt}');
$table_prefix = 'wp_';
define('WP_DEBUG', false);
if (!defined('ABSPATH')) { define('ABSPATH', __DIR__ . '/'); }
require_once ABSPATH . 'wp-settings.php';
