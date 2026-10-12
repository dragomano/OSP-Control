// The only place with the product name in the frontend: the value comes from
// productName in src-tauri/tauri.conf.json — the same key Rust reads for the
// window title and the tray tooltip (see package_info().name).
//
// The product name is a proper noun and is not translated, so there is no and
// must not be any brand.* key in the locales dictionaries: dictionaries are
// for translatable strings only.
import config from '../src-tauri/tauri.conf.json';

export const APP_NAME: string = config.productName;
