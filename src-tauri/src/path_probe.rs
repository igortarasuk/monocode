//! Existence checks for file references shown in agent replies, so only
//! files that are really there render as links.

use std::path::PathBuf;

fn expand(path: &str) -> Option<PathBuf> {
    let path = path.trim();
    if path.is_empty() || path.len() > 4096 {
        return None;
    }
    if let Some(rest) = path.strip_prefix("~/") {
        return crate::dirs_home().map(|home| PathBuf::from(home).join(rest));
    }
    let path = PathBuf::from(path);
    path.is_absolute().then_some(path)
}

/// True when `path` (absolute or `~/…`) names an existing file.
#[tauri::command(async)]
pub fn path_is_file(path: String) -> bool {
    expand(&path).is_some_and(|path| path.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checks_absolute_files_only() {
        let dir = std::env::temp_dir().join(format!("probe-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a.txt");
        std::fs::write(&file, "x").unwrap();
        assert!(path_is_file(file.to_string_lossy().into_owned()));
        assert!(!path_is_file(dir.to_string_lossy().into_owned()));
        assert!(!path_is_file(
            dir.join("missing.xml").to_string_lossy().into_owned()
        ));
        assert!(!path_is_file("relative.txt".into()));
        assert!(!path_is_file(String::new()));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
