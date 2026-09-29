use std::path::{Path, PathBuf};

const MAX_SLUG: usize = 48;
const INSTRUCTION_FILES: [&str; 2] = ["CLAUDE.md", "AGENTS.md"];

/// Lowercase letters, digits and hyphens, starting with a letter or digit, so
/// the slug is always a single safe directory name.
fn valid_slug(slug: &str) -> bool {
    !slug.is_empty()
        && slug.len() <= MAX_SLUG
        && slug
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !slug.starts_with('-')
}

fn instructions_file(name: &str, instructions: &str) -> String {
    let name = name.trim();
    let instructions = instructions.trim();
    if instructions.is_empty() {
        format!("# {name} (Monochrome assistant)\n")
    } else {
        format!("# {name} (Monochrome assistant)\n\n{instructions}\n")
    }
}

/// Create `<root>/<slug>` with the instructions in `CLAUDE.md` (Claude Code)
/// and `AGENTS.md` (Codex, OpenCode). Unchanged files are left alone so their
/// mtime stays stable.
fn prepare(root: &Path, slug: &str, name: &str, instructions: &str) -> Result<PathBuf, String> {
    if !valid_slug(slug) {
        return Err(format!("Invalid assistant id: {slug:?}"));
    }
    let dir = root.join(slug);
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let content = instructions_file(name, instructions);
    for file in INSTRUCTION_FILES {
        let path = dir.join(file);
        if std::fs::read_to_string(&path).ok().as_deref() == Some(content.as_str()) {
            continue;
        }
        std::fs::write(&path, &content).map_err(|e| format!("{}: {e}", path.display()))?;
    }
    Ok(dir)
}

#[tauri::command]
pub async fn assistant_workspace_prepare(
    slug: String,
    name: String,
    instructions: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let home = crate::dirs_home().ok_or("Home directory is not set")?;
        let root = Path::new(&home).join("Assistants");
        prepare(&root, &slug, &name, &instructions).map(|dir| dir.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root() -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("monochrome-assistants-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn creates_both_instruction_files() {
        let root = temp_root();
        let dir = prepare(&root, "translator", "Translator", "Translate to English.").unwrap();
        assert_eq!(dir, root.join("translator"));
        for file in INSTRUCTION_FILES {
            let text = std::fs::read_to_string(dir.join(file)).unwrap();
            assert_eq!(
                text,
                "# Translator (Monochrome assistant)\n\nTranslate to English.\n"
            );
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn keeps_unchanged_files_and_rewrites_changed_ones() {
        let root = temp_root();
        let dir = prepare(&root, "rnd", "R&D", "Research.").unwrap();
        let path = dir.join("CLAUDE.md");
        let before = std::fs::metadata(&path).unwrap().modified().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        prepare(&root, "rnd", "R&D", "Research.").unwrap();
        assert_eq!(
            std::fs::metadata(&path).unwrap().modified().unwrap(),
            before
        );

        prepare(&root, "rnd", "R&D", "Research deeper.").unwrap();
        assert!(std::fs::read_to_string(&path)
            .unwrap()
            .contains("Research deeper."));
        assert!(std::fs::read_to_string(dir.join("AGENTS.md"))
            .unwrap()
            .contains("Research deeper."));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_unsafe_slugs() {
        let root = temp_root();
        for slug in [
            "",
            "../x",
            "a/b",
            "Upper",
            "-lead",
            ".",
            "a.b",
            &"a".repeat(49),
        ] {
            assert!(prepare(&root, slug, "X", "").is_err(), "{slug:?}");
        }
        assert!(prepare(&root, "ok-1", "X", "").is_ok());
        std::fs::remove_dir_all(root).unwrap();
    }
}
