fn main() {
    use std::{fs, path::Path};
    fn collect(dir: &Path, root: &Path, assets: &mut Vec<(String, String)>) {
        let mut entries: Vec<_> = fs::read_dir(dir).unwrap().map(Result::unwrap).collect();
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let path = entry.path();
            if path.is_dir() { collect(&path, root, assets); }
            else {
                let name = path.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
                let absolute = fs::canonicalize(&path).unwrap();
                assets.push((name, absolute.to_string_lossy().into_owned()));
            }
        }
    }
    let root = Path::new("resources/starters");
    println!("cargo:rerun-if-changed={}", root.display());
    let mut assets = Vec::new();
    collect(root, root, &mut assets);
    // The directory mtime alone misses edits deep in the tree; watch every collected file.
    for (name, path) in &assets {
        let _ = name;
        println!("cargo:rerun-if-changed={path}");
    }
    let mut source = String::from("const STARTER_ASSETS: &[(&str, &str)] = &[\n");
    for (name, path) in assets { source.push_str(&format!("({name:?}, include_str!({path:?})),\n")); }
    source.push_str("];\n");
    fs::write(Path::new(&std::env::var("OUT_DIR").unwrap()).join("starter_assets.rs"), source).unwrap();
    tauri_build::build();
}
