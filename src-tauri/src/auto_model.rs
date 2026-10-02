//! Auto model: what Monochrome knows about a project and its sessions, so a
//! small model can route each task to a fitting model. Lives in the session
//! database: a scanned project profile, durable project memory, and the task
//! each auto-routed session was started for.

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::session_store::{now_millis, validate_id, SessionStore};

const RESCAN_AFTER_MS: i64 = 24 * 60 * 60 * 1000;
const MAX_FILES: usize = 20_000;
const MAX_LANGUAGES: usize = 6;
const MAX_MEMORY: usize = 40;
const MAX_MEMORY_ENTRY: usize = 400;
const MAX_FIELD: usize = 600;
const SKILL_DIR: &str = ".claude/skills/project-memory";
const CLASSIFIER_SKILL: &str = ".claude/skills/auto-model/SKILL.md";
const MAX_SKILL_BYTES: u64 = 16 << 10;

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Language {
    name: String,
    files: usize,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ProjectProfile {
    languages: Vec<Language>,
    file_count: usize,
    /// CI/CD systems configured in the repository.
    ci: Vec<String>,
    /// Files that configure MCP servers for an agent.
    mcp: Vec<String>,
    /// Ties to other projects: submodules, workspaces, sibling path deps.
    links: Vec<String>,
    /// Agent instruction files (CLAUDE.md, AGENTS.md).
    agent_docs: Vec<String>,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectStats {
    sessions: usize,
    /// Sessions restarted because the task left its original scope.
    restarts: usize,
    /// Routed sessions per task kind.
    kinds: BTreeMap<String, usize>,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMeta {
    profile: ProjectProfile,
    memory: Vec<String>,
    stats: ProjectStats,
    /// Project-owned routing instructions, when the project ships them.
    classifier_skill: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct SessionTask {
    session_id: String,
    cwd: String,
    harness: String,
    model: String,
    kind: String,
    scale: String,
    effort: String,
    summary: String,
    reason: String,
    parent_session_id: Option<String>,
}

pub(crate) fn ensure_tables(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS auto_model_projects (
           project_key TEXT PRIMARY KEY,
           profile_json TEXT NOT NULL DEFAULT '{}',
           memory_json TEXT NOT NULL DEFAULT '[]',
           scanned_at INTEGER NOT NULL DEFAULT 0,
           updated_at INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS auto_model_sessions (
           session_id TEXT PRIMARY KEY,
           project_key TEXT NOT NULL,
           task_json TEXT NOT NULL,
           kind TEXT NOT NULL DEFAULT '',
           parent_session_id TEXT,
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS auto_model_sessions_project
           ON auto_model_sessions (project_key);",
    )
}

/// Same identity the frontend uses for a project: no trailing separators.
fn project_key(cwd: &str) -> Result<String, String> {
    let trimmed = cwd.trim();
    if trimmed.is_empty() || trimmed == "~" {
        return Err("Auto model needs a project folder.".into());
    }
    let key = trimmed.trim_end_matches(['/', '\\']);
    Ok(if key.is_empty() {
        "/".into()
    } else {
        key.into()
    })
}

fn clip(text: &str, limit: usize) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= limit {
        return flat;
    }
    flat.chars().take(limit).collect()
}

fn language_for(extension: &str) -> Option<&'static str> {
    Some(match extension {
        "py" | "pyi" => "Python",
        "go" => "Go",
        "rs" => "Rust",
        "ts" | "tsx" | "mts" | "cts" => "TypeScript",
        "js" | "jsx" | "mjs" | "cjs" => "JavaScript",
        "java" => "Java",
        "kt" | "kts" => "Kotlin",
        "swift" => "Swift",
        "c" | "h" => "C",
        "cc" | "cpp" | "cxx" | "hpp" | "hh" => "C++",
        "cs" => "C#",
        "rb" => "Ruby",
        "php" => "PHP",
        "scala" => "Scala",
        "ex" | "exs" => "Elixir",
        "dart" => "Dart",
        "lua" => "Lua",
        "sh" | "bash" | "zsh" => "Shell",
        "sql" => "SQL",
        "tf" | "hcl" => "Terraform",
        "vue" => "Vue",
        "svelte" => "Svelte",
        "md" | "mdx" | "rst" => "Docs",
        _ => return None,
    })
}

/// Tracked files when the folder is a git checkout; otherwise a bounded walk.
fn project_files(root: &Path) -> Vec<String> {
    let listed = Command::new("git")
        .arg("-C")
        .arg(root)
        .args([
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
        ])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output();
    if let Ok(output) = listed {
        if output.status.success() {
            return String::from_utf8_lossy(&output.stdout)
                .split('\0')
                .filter(|path| !path.is_empty())
                .take(MAX_FILES)
                .map(str::to_owned)
                .collect();
        }
    }
    let mut files = Vec::new();
    let mut pending = vec![(root.to_path_buf(), 0usize)];
    while let Some((dir, depth)) = pending.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                let skipped = name.starts_with('.')
                    || matches!(
                        name.as_str(),
                        "node_modules" | "target" | "dist" | "build" | "vendor" | "__pycache__"
                    );
                if !skipped && depth < 6 {
                    pending.push((entry.path(), depth + 1));
                }
            } else if kind.is_file() {
                if let Ok(relative) = entry.path().strip_prefix(root) {
                    files.push(relative.to_string_lossy().replace('\\', "/"));
                }
                if files.len() >= MAX_FILES {
                    return files;
                }
            }
        }
    }
    files
}

fn read_small(path: &Path) -> Option<String> {
    let size = fs::metadata(path).ok()?.len();
    if size > MAX_SKILL_BYTES * 16 {
        return None;
    }
    fs::read_to_string(path).ok()
}

fn scan(root: &Path) -> ProjectProfile {
    let files = project_files(root);
    let mut counts: HashMap<&'static str, usize> = HashMap::new();
    for file in &files {
        let extension = Path::new(file)
            .extension()
            .and_then(|value| value.to_str())
            .map(str::to_ascii_lowercase);
        if let Some(language) = extension.as_deref().and_then(language_for) {
            *counts.entry(language).or_default() += 1;
        }
    }
    let mut languages = counts
        .into_iter()
        .map(|(name, files)| Language {
            name: name.into(),
            files,
        })
        .collect::<Vec<_>>();
    languages.sort_by(|a, b| b.files.cmp(&a.files).then(a.name.cmp(&b.name)));
    languages.truncate(MAX_LANGUAGES);

    let has = |relative: &str| root.join(relative).exists();
    let mut ci = Vec::new();
    for (path, label) in [
        (".github/workflows", "GitHub Actions"),
        (".gitlab-ci.yml", "GitLab CI"),
        ("Jenkinsfile", "Jenkins"),
        (".circleci", "CircleCI"),
        ("azure-pipelines.yml", "Azure Pipelines"),
        ("bitbucket-pipelines.yml", "Bitbucket Pipelines"),
        (".drone.yml", "Drone"),
        (".argo", "Argo"),
    ] {
        if has(path) {
            ci.push(label.to_owned());
        }
    }

    let mut mcp = Vec::new();
    for path in [".mcp.json", ".cursor/mcp.json", ".vscode/mcp.json"] {
        if has(path) {
            mcp.push(path.to_owned());
        }
    }
    for path in ["opencode.json", "opencode.jsonc", ".codex/config.toml"] {
        if read_small(&root.join(path)).is_some_and(|text| text.contains("mcp")) {
            mcp.push(path.to_owned());
        }
    }

    let mut links = Vec::new();
    if let Some(text) = read_small(&root.join(".gitmodules")) {
        let count = text.matches("[submodule").count();
        if count > 0 {
            links.push(format!("{count} git submodule(s)"));
        }
    }
    for (path, label) in [
        ("go.work", "Go workspace"),
        ("pnpm-workspace.yaml", "pnpm workspace"),
        ("nx.json", "Nx monorepo"),
        ("turbo.json", "Turborepo"),
        ("lerna.json", "Lerna monorepo"),
    ] {
        if has(path) {
            links.push(label.to_owned());
        }
    }
    // Dependencies on a sibling checkout, e.g. `replace x => ../x`.
    for path in ["go.mod", "Cargo.toml", "package.json", "pyproject.toml"] {
        if read_small(&root.join(path)).is_some_and(|text| text.contains("../")) {
            links.push(format!("{path} refers to a sibling folder"));
        }
    }

    let agent_docs = ["CLAUDE.md", "AGENTS.md", ".claude/CLAUDE.md"]
        .into_iter()
        .filter(|path| has(path))
        .map(str::to_owned)
        .collect();

    ProjectProfile {
        languages,
        file_count: files.len(),
        ci,
        mcp,
        links,
        agent_docs,
    }
}

fn load_project(
    conn: &Connection,
    key: &str,
) -> Result<(ProjectProfile, Vec<String>, i64), String> {
    let row: Option<(String, String, i64)> = conn
        .query_row(
            "SELECT profile_json, memory_json, scanned_at FROM auto_model_projects
             WHERE project_key = ?1",
            [key],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    Ok(match row {
        Some((profile, memory, scanned_at)) => (
            serde_json::from_str(&profile).unwrap_or_default(),
            serde_json::from_str(&memory).unwrap_or_default(),
            scanned_at,
        ),
        None => (ProjectProfile::default(), Vec::new(), 0),
    })
}

fn save_profile(
    conn: &Connection,
    key: &str,
    profile: &ProjectProfile,
    now: i64,
) -> Result<(), String> {
    let json = serde_json::to_string(profile).map_err(|error| error.to_string())?;
    conn.execute(
        "INSERT INTO auto_model_projects (project_key, profile_json, scanned_at, updated_at)
         VALUES (?1, ?2, ?3, ?3)
         ON CONFLICT(project_key) DO UPDATE SET
           profile_json = excluded.profile_json,
           scanned_at = excluded.scanned_at,
           updated_at = excluded.updated_at",
        params![key, json, now],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn stats(conn: &Connection, key: &str) -> Result<ProjectStats, String> {
    let mut statement = conn
        .prepare(
            "SELECT kind, COUNT(*), SUM(parent_session_id IS NOT NULL)
             FROM auto_model_sessions WHERE project_key = ?1 GROUP BY kind",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([key], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, Option<i64>>(2)?,
            ))
        })
        .map_err(|error| error.to_string())?;
    let mut result = ProjectStats::default();
    for row in rows {
        let (kind, count, restarts) = row.map_err(|error| error.to_string())?;
        result.sessions += count as usize;
        result.restarts += restarts.unwrap_or(0) as usize;
        if !kind.is_empty() {
            result.kinds.insert(kind, count as usize);
        }
    }
    Ok(result)
}

/// Merge new facts into the stored ones: newest last, no repeats, bounded.
fn merge_memory(existing: Vec<String>, entries: &[String]) -> Vec<String> {
    let mut merged = existing;
    for entry in entries {
        let entry = clip(entry.trim_start_matches(['-', '*', ' ']), MAX_MEMORY_ENTRY);
        if entry.is_empty() {
            continue;
        }
        let key = entry.to_lowercase();
        merged.retain(|known| known.to_lowercase() != key);
        merged.push(entry);
    }
    if merged.len() > MAX_MEMORY {
        merged.drain(..merged.len() - MAX_MEMORY);
    }
    merged
}

fn remember(
    conn: &Connection,
    key: &str,
    entries: &[String],
    now: i64,
) -> Result<Vec<String>, String> {
    let (_, memory, _) = load_project(conn, key)?;
    let merged = merge_memory(memory, entries);
    let json = serde_json::to_string(&merged).map_err(|error| error.to_string())?;
    conn.execute(
        "INSERT INTO auto_model_projects (project_key, memory_json, updated_at)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(project_key) DO UPDATE SET
           memory_json = excluded.memory_json, updated_at = excluded.updated_at",
        params![key, json, now],
    )
    .map_err(|error| error.to_string())?;
    Ok(merged)
}

fn skill_text(memory: &[String]) -> String {
    let mut text = String::from(
        "---\nname: project-memory\ndescription: Facts about this project carried over from earlier agent sessions. Read before starting a task here.\n---\n\n# Project memory\n\nWritten by Monochrome when a session is restarted for a new task. Treat these\nas notes from earlier sessions: verify against the code before relying on them.\n\n",
    );
    for entry in memory {
        text.push_str("- ");
        text.push_str(entry);
        text.push('\n');
    }
    text
}

/// Mirror the stored memory into a skill agents discover on their own.
fn write_skill(root: &Path, memory: &[String]) -> Result<(), String> {
    let dir = root.join(SKILL_DIR);
    if memory.is_empty() {
        return Ok(());
    }
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    fs::write(dir.join("SKILL.md"), skill_text(memory)).map_err(|error| error.to_string())
}

fn save_session(conn: &Connection, task: &SessionTask, now: i64) -> Result<(), String> {
    validate_id(&task.session_id, "session")?;
    if let Some(parent) = &task.parent_session_id {
        validate_id(parent, "session")?;
    }
    let key = project_key(&task.cwd)?;
    let stored = SessionTask {
        kind: clip(&task.kind, 40),
        scale: clip(&task.scale, 40),
        effort: clip(&task.effort, 40),
        summary: clip(&task.summary, MAX_FIELD),
        reason: clip(&task.reason, MAX_FIELD),
        harness: clip(&task.harness, 60),
        model: clip(&task.model, 200),
        ..task.clone()
    };
    let json = serde_json::to_string(&stored).map_err(|error| error.to_string())?;
    conn.execute(
        "INSERT INTO auto_model_sessions
           (session_id, project_key, task_json, kind, parent_session_id, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
         ON CONFLICT(session_id) DO UPDATE SET
           project_key = excluded.project_key,
           task_json = excluded.task_json,
           kind = excluded.kind,
           parent_session_id = COALESCE(excluded.parent_session_id, parent_session_id),
           updated_at = excluded.updated_at",
        params![
            stored.session_id,
            key,
            json,
            stored.kind,
            stored.parent_session_id,
            now
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn load_session(conn: &Connection, session_id: &str) -> Result<Option<SessionTask>, String> {
    validate_id(session_id, "session")?;
    let json: Option<String> = conn
        .query_row(
            "SELECT task_json FROM auto_model_sessions WHERE session_id = ?1",
            [session_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    Ok(json.and_then(|json| serde_json::from_str(&json).ok()))
}

/// Profile, memory and task statistics for a project; rescans a stale profile.
#[tauri::command(async)]
pub fn auto_model_project(
    store: State<'_, SessionStore>,
    cwd: String,
    rescan: Option<bool>,
) -> Result<ProjectMeta, String> {
    let key = project_key(&cwd)?;
    let root = PathBuf::from(&key);
    let now = now_millis();
    let (mut profile, memory, scanned_at) = {
        let conn = store.lock_conn()?;
        load_project(&conn, &key)?
    };
    if (rescan.unwrap_or(false) || now - scanned_at > RESCAN_AFTER_MS) && root.is_dir() {
        // Scan without holding the database lock.
        profile = scan(&root);
        let conn = store.lock_conn()?;
        save_profile(&conn, &key, &profile, now)?;
    }
    let conn = store.lock_conn()?;
    let stats = stats(&conn, &key)?;
    drop(conn);
    let skill = root.join(CLASSIFIER_SKILL);
    let classifier_skill = fs::metadata(&skill)
        .ok()
        .filter(|meta| meta.len() <= MAX_SKILL_BYTES)
        .and_then(|_| fs::read_to_string(&skill).ok());
    Ok(ProjectMeta {
        profile,
        memory,
        stats,
        classifier_skill,
    })
}

/// Add durable facts to the project memory and refresh its skill file.
#[tauri::command(async)]
pub fn auto_model_remember(
    store: State<'_, SessionStore>,
    cwd: String,
    entries: Vec<String>,
) -> Result<Vec<String>, String> {
    let key = project_key(&cwd)?;
    let memory = {
        let conn = store.lock_conn()?;
        remember(&conn, &key, &entries, now_millis())?
    };
    let root = PathBuf::from(&key);
    if root.is_dir() {
        write_skill(&root, &memory)?;
    }
    Ok(memory)
}

/// Replace the project memory (Settings edits) and refresh its skill file.
#[tauri::command(async)]
pub fn auto_model_set_memory(
    store: State<'_, SessionStore>,
    cwd: String,
    entries: Vec<String>,
) -> Result<Vec<String>, String> {
    let key = project_key(&cwd)?;
    let memory = merge_memory(Vec::new(), &entries);
    let json = serde_json::to_string(&memory).map_err(|error| error.to_string())?;
    {
        let conn = store.lock_conn()?;
        conn.execute(
            "INSERT INTO auto_model_projects (project_key, memory_json, updated_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(project_key) DO UPDATE SET
               memory_json = excluded.memory_json, updated_at = excluded.updated_at",
            params![key, json, now_millis()],
        )
        .map_err(|error| error.to_string())?;
    }
    let root = PathBuf::from(&key);
    let skill = root.join(SKILL_DIR).join("SKILL.md");
    if memory.is_empty() {
        let _ = fs::remove_file(skill);
    } else if root.is_dir() {
        write_skill(&root, &memory)?;
    }
    Ok(memory)
}

#[tauri::command(async)]
pub fn auto_model_session_set(
    store: State<'_, SessionStore>,
    task: SessionTask,
) -> Result<(), String> {
    let conn = store.lock_conn()?;
    save_session(&conn, &task, now_millis())
}

#[tauri::command(async)]
pub fn auto_model_session_get(
    store: State<'_, SessionStore>,
    session_id: String,
) -> Result<Option<SessionTask>, String> {
    let conn = store.lock_conn()?;
    load_session(&conn, &session_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        ensure_tables(&conn).unwrap();
        conn
    }

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("auto-model-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn task(id: &str, kind: &str, parent: Option<&str>) -> SessionTask {
        SessionTask {
            session_id: id.into(),
            cwd: "/work/acme/".into(),
            harness: "claude".into(),
            model: "claude:example".into(),
            kind: kind.into(),
            scale: "small".into(),
            effort: "medium".into(),
            summary: "Fix the  login\nredirect".into(),
            reason: "scoped bug fix".into(),
            parent_session_id: parent.map(str::to_owned),
        }
    }

    #[test]
    fn scans_languages_ci_mcp_and_links() {
        let dir = scratch();
        let root = dir.as_path();
        fs::create_dir_all(root.join(".github/workflows")).unwrap();
        fs::create_dir_all(root.join("cmd")).unwrap();
        fs::write(root.join(".github/workflows/ci.yml"), "on: push").unwrap();
        fs::write(root.join("cmd/main.go"), "package main").unwrap();
        fs::write(root.join("cmd/util.go"), "package main").unwrap();
        fs::write(root.join("tool.py"), "print(1)").unwrap();
        fs::write(root.join(".mcp.json"), "{}").unwrap();
        fs::write(root.join("go.mod"), "replace acme => ../acme").unwrap();
        fs::write(root.join("AGENTS.md"), "# Agents").unwrap();

        let profile = scan(root);

        assert_eq!(
            profile.languages[0],
            Language {
                name: "Go".into(),
                files: 2
            }
        );
        assert!(profile
            .languages
            .iter()
            .any(|language| language.name == "Python"));
        assert_eq!(profile.mcp, vec![".mcp.json".to_owned()]);
        assert_eq!(
            profile.links,
            vec!["go.mod refers to a sibling folder".to_owned()]
        );
        assert_eq!(profile.agent_docs, vec!["AGENTS.md".to_owned()]);
        // Hidden folders are skipped by the plain walk, so CI is found by path.
        assert_eq!(profile.ci, vec!["GitHub Actions".to_owned()]);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn memory_keeps_the_newest_copy_and_stays_bounded() {
        let conn = conn();
        remember(
            &conn,
            "/work/acme",
            &["- Tests run with make test".into()],
            1,
        )
        .unwrap();
        let memory = remember(
            &conn,
            "/work/acme",
            &[
                "Deploys go through staging".into(),
                "tests run with MAKE test".into(),
                " ".into(),
            ],
            2,
        )
        .unwrap();
        assert_eq!(
            memory,
            vec!["Deploys go through staging", "tests run with MAKE test"]
        );

        let many = (0..MAX_MEMORY + 5)
            .map(|i| format!("fact {i}"))
            .collect::<Vec<_>>();
        let memory = remember(&conn, "/work/acme", &many, 3).unwrap();
        assert_eq!(memory.len(), MAX_MEMORY);
        assert_eq!(memory.last().unwrap(), &format!("fact {}", MAX_MEMORY + 4));
    }

    #[test]
    fn sessions_feed_project_statistics() {
        let conn = conn();
        save_session(&conn, &task("a", "code", None), 1).unwrap();
        save_session(&conn, &task("b", "troubleshoot", Some("a")), 2).unwrap();
        save_session(&conn, &task("c", "code", None), 3).unwrap();
        // A later update without a parent keeps the recorded one.
        save_session(&conn, &task("b", "troubleshoot", None), 4).unwrap();

        let stats = stats(&conn, "/work/acme").unwrap();
        assert_eq!(stats.sessions, 3);
        assert_eq!(stats.restarts, 1);
        assert_eq!(stats.kinds.get("code"), Some(&2));

        let stored = load_session(&conn, "a").unwrap().unwrap();
        assert_eq!(stored.summary, "Fix the login redirect");
        assert!(load_session(&conn, "missing").unwrap().is_none());
        assert!(save_session(&conn, &task("../x", "code", None), 5).is_err());
    }

    #[test]
    fn writes_memory_as_a_skill() {
        let dir = scratch();
        write_skill(&dir, &["Use pnpm".into()]).unwrap();
        let text = fs::read_to_string(dir.join(SKILL_DIR).join("SKILL.md")).unwrap();
        assert!(text.starts_with("---\nname: project-memory\n"));
        assert!(text.ends_with("- Use pnpm\n"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn rejects_folders_that_are_not_projects() {
        assert!(project_key("~").is_err());
        assert!(project_key("  ").is_err());
        assert_eq!(project_key("/work/acme/").unwrap(), "/work/acme");
    }
}
