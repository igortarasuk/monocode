//! Project knowledge: what the owner and the agents know about a project,
//! kept across sessions and models.
//!
//! The documents are plain markdown in Monochrome's data folder, mounted into
//! the project as the `.monochrome` symlink so any agent can read and edit
//! them with its own file tools. Every sync copies them into the session
//! database (and restores a missing file from it), and parses the
//! infrastructure map and the change log into tables.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, State};

use crate::session_store::{now_millis, validate_id, SessionStore};

pub(crate) const MOUNT: &str = ".monochrome";
const USER_DOC: &str = "user.md";
const MODEL_DOC: &str = "model.md";
const INFRA_DOC: &str = "infra.md";
const CHANGES_DOC: &str = "changes.md";
const DOCS: [&str; 4] = [USER_DOC, MODEL_DOC, INFRA_DOC, CHANGES_DOC];
const MAX_DOC_BYTES: u64 = 1 << 20;
const MAX_ENTRY: usize = 600;
const NOTES_START: &str = "<!-- monochrome:session-notes -->";
const NOTES_END: &str = "<!-- /monochrome:session-notes -->";

const README: &str = r#"# .monochrome — project knowledge

Shared knowledge about this project, kept by Monochrome so every session and
every model starts from the same picture instead of rediscovering it.

This folder is a symlink into Monochrome's data folder. It is not part of the
repository (it is listed in `.git/info/exclude`), and its documents are also
stored in Monochrome's database.

| File | Kept by | What it holds |
|---|---|---|
| `user.md` | the owner | Instructions and facts from the owner. Agents read it first and never edit it. |
| `model.md` | agents | What agents learned: conventions, commands that work, pitfalls. |
| `infra.md` | agents | Infrastructure map: hosts, proxies, services, what each does, how to reach it, how to check its live state. |
| `changes.md` | agents | Log of changes to infrastructure, versions, CI and deployment, newest last. |
| `routing.md` | the owner, optional | Rules for the Auto model router; replaces the built-in ones. |

## For agents

- Read `user.md`, then whatever else is relevant, before infrastructure work.
- The map can be stale. Before relying on an entry, run its `check` command.
- When you learn or change something durable, update `model.md` or `infra.md`
  and add a line to `changes.md`.
- When the knowledge is missing, contradictory or looks outdated, ask the user
  and write the answer down.
- Never store passwords, tokens or private keys here. Say where a secret lives.

## Formats

`infra.md`: one `## name` section per host, proxy or service, with any of
these bullets:

```
## zabbix-proxy-eu
- kind: proxy
- role: collects metrics from EU hosts for the Zabbix server
- runs on: eu-mon-1
- access: tsh ssh ops@eu-mon-1
- check: systemctl status zabbix-proxy
- notes: managed by the zabbix_proxy Ansible role
```

`changes.md`: one bullet per change, `- YYYY-MM-DD what changed and why`.

## Reset

Delete the `.monochrome` link to detach this project; Monochrome mounts it
again while Auto model is on. To start from scratch, empty the files: a file
that is deleted is restored from the database.
"#;

const USER_TEMPLATE: &str = "# Project instructions (owner)\n\nWritten by the project owner. Agents read this first and do not edit it.\n\n";
const MODEL_TEMPLATE: &str = "# Project knowledge (agents)\n\nDurable facts agents learned while working here. Keep it short and current.\n\n";
const INFRA_TEMPLATE: &str =
    "# Infrastructure\n\nOne section per host, proxy or service. See README.md for the format.\n\n";
const CHANGES_TEMPLATE: &str =
    "# Changes\n\nInfrastructure, version, CI and deployment changes, newest last.\n\n";

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InfraNode {
    name: String,
    kind: String,
    role: String,
    runs_on: String,
    access: String,
    check: String,
    notes: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeStatus {
    /// The project has its `.monochrome` mount.
    mounted: bool,
    /// Why it could not be mounted, when it was asked for.
    problem: Option<String>,
    infra: Vec<InfraNode>,
    changes: usize,
}

pub(crate) fn ensure_tables(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS project_knowledge_docs (
           project_key TEXT NOT NULL,
           name TEXT NOT NULL,
           content TEXT NOT NULL,
           updated_at INTEGER NOT NULL,
           PRIMARY KEY (project_key, name)
         );
         CREATE TABLE IF NOT EXISTS project_infra (
           project_key TEXT NOT NULL,
           name TEXT NOT NULL,
           kind TEXT NOT NULL DEFAULT '',
           role TEXT NOT NULL DEFAULT '',
           runs_on TEXT NOT NULL DEFAULT '',
           access TEXT NOT NULL DEFAULT '',
           check_cmd TEXT NOT NULL DEFAULT '',
           notes TEXT NOT NULL DEFAULT '',
           updated_at INTEGER NOT NULL,
           PRIMARY KEY (project_key, name)
         );
         CREATE INDEX IF NOT EXISTS project_infra_name ON project_infra (name);
         CREATE TABLE IF NOT EXISTS project_changes (
           project_key TEXT NOT NULL,
           day TEXT NOT NULL,
           summary TEXT NOT NULL,
           recorded_at INTEGER NOT NULL,
           PRIMARY KEY (project_key, day, summary)
         );",
    )
}

fn template(name: &str) -> &'static str {
    match name {
        USER_DOC => USER_TEMPLATE,
        MODEL_DOC => MODEL_TEMPLATE,
        INFRA_DOC => INFRA_TEMPLATE,
        _ => CHANGES_TEMPLATE,
    }
}

/// Folder in the app's data dir that backs a project's mount.
fn store_dir(base: &Path, project_key: &str) -> PathBuf {
    let digest = Sha256::digest(project_key.as_bytes());
    let hash = digest[..6]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let name = Path::new(project_key)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        .take(40)
        .collect::<String>();
    base.join(format!(
        "{}-{hash}",
        if name.is_empty() { "project" } else { &name }
    ))
}

fn clip(text: &str) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    flat.chars().take(MAX_ENTRY).collect()
}

fn today() -> String {
    let now = time::OffsetDateTime::now_utc();
    format!(
        "{:04}-{:02}-{:02}",
        now.year(),
        u8::from(now.month()),
        now.day()
    )
}

pub(crate) fn parse_infra(text: &str) -> Vec<InfraNode> {
    let mut nodes: Vec<InfraNode> = Vec::new();
    let mut fenced = false;
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with("```") {
            fenced = !fenced;
            continue;
        }
        if fenced {
            continue;
        }
        if let Some(name) = line.strip_prefix("## ") {
            let name = clip(name.trim_matches('`'));
            if !name.is_empty() && !nodes.iter().any(|node| node.name == name) {
                nodes.push(InfraNode {
                    name,
                    ..InfraNode::default()
                });
            } else {
                // A repeated or empty heading: its bullets belong to nothing.
                nodes.push(InfraNode::default());
            }
            continue;
        }
        let Some(node) = nodes.last_mut() else {
            continue;
        };
        let Some(bullet) = line.strip_prefix("- ").or_else(|| line.strip_prefix("* ")) else {
            continue;
        };
        let Some((key, value)) = bullet.split_once(':') else {
            continue;
        };
        let value = clip(value);
        match key.trim().to_ascii_lowercase().as_str() {
            "kind" | "type" => node.kind = value,
            "role" | "purpose" => node.role = value,
            "runs on" | "host" | "location" => node.runs_on = value,
            "access" => node.access = value,
            "check" | "state" => node.check = value,
            "notes" | "note" => node.notes = value,
            _ => {}
        }
    }
    nodes.retain(|node| !node.name.is_empty());
    nodes
}

/// `- 2026-10-02 text` bullets; anything else in the file is prose.
pub(crate) fn parse_changes(text: &str) -> Vec<(String, String)> {
    text.lines()
        .filter_map(|line| {
            let bullet = line.trim().strip_prefix("- ")?;
            let (day, summary) = bullet.split_once(' ')?;
            let bytes = day.as_bytes();
            let dated = bytes.len() == 10
                && bytes[4] == b'-'
                && bytes[7] == b'-'
                && bytes
                    .iter()
                    .enumerate()
                    .all(|(i, b)| i == 4 || i == 7 || b.is_ascii_digit());
            let summary = clip(summary);
            (dated && !summary.is_empty()).then(|| (day.to_owned(), summary))
        })
        .collect()
}

/// Replace the generated notes block in `model.md`, keeping the agents' text.
fn with_session_notes(doc: &str, notes: &[String]) -> String {
    let block = if notes.is_empty() {
        String::new()
    } else {
        let mut block = format!("{NOTES_START}\n## Notes from sessions\n\n");
        for note in notes {
            block.push_str("- ");
            block.push_str(note);
            block.push('\n');
        }
        block.push_str(NOTES_END);
        block.push('\n');
        block
    };
    let (head, tail) = match (doc.find(NOTES_START), doc.find(NOTES_END)) {
        (Some(start), Some(end)) if end >= start => (
            &doc[..start],
            doc[end + NOTES_END.len()..].trim_start_matches('\n'),
        ),
        _ => (doc, ""),
    };
    let mut next = head.trim_end().to_owned();
    next.push_str("\n\n");
    next.push_str(&block);
    if !tail.is_empty() {
        if !block.is_empty() {
            next.push('\n');
        }
        next.push_str(tail);
    }
    next
}

fn read_doc(path: &Path) -> Option<String> {
    let size = fs::metadata(path).ok()?.len();
    if size > MAX_DOC_BYTES {
        return None;
    }
    fs::read_to_string(path).ok()
}

fn stored_doc(conn: &Connection, key: &str, name: &str) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT content FROM project_knowledge_docs WHERE project_key = ?1 AND name = ?2",
        params![key, name],
        |row| row.get(0),
    )
    .optional()
    .map_err(|error| error.to_string())
}

fn store_doc(
    conn: &Connection,
    key: &str,
    name: &str,
    content: &str,
    now: i64,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO project_knowledge_docs (project_key, name, content, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(project_key, name) DO UPDATE SET
           content = excluded.content, updated_at = excluded.updated_at
         WHERE content <> excluded.content",
        params![key, name, content, now],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

/// Files win over the database; a missing file comes back from the database.
fn sync_docs(conn: &Connection, key: &str, dir: &Path, now: i64) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    let readme = dir.join("README.md");
    if read_doc(&readme).as_deref() != Some(README) {
        fs::write(&readme, README).map_err(|error| error.to_string())?;
    }
    for name in DOCS {
        let path = dir.join(name);
        match read_doc(&path) {
            Some(content) => store_doc(conn, key, name, &content, now)?,
            None if path.exists() => {} // too large or unreadable: leave both alone
            None => {
                let content =
                    stored_doc(conn, key, name)?.unwrap_or_else(|| template(name).to_owned());
                fs::write(&path, &content).map_err(|error| error.to_string())?;
                store_doc(conn, key, name, &content, now)?;
            }
        }
    }
    Ok(())
}

fn index(conn: &mut Connection, key: &str, now: i64) -> Result<(Vec<InfraNode>, usize), String> {
    let infra = parse_infra(&stored_doc(conn, key, INFRA_DOC)?.unwrap_or_default());
    let changes = parse_changes(&stored_doc(conn, key, CHANGES_DOC)?.unwrap_or_default());
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    tx.execute("DELETE FROM project_infra WHERE project_key = ?1", [key])
        .map_err(|error| error.to_string())?;
    for node in &infra {
        tx.execute(
            "INSERT INTO project_infra
               (project_key, name, kind, role, runs_on, access, check_cmd, notes, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                key,
                node.name,
                node.kind,
                node.role,
                node.runs_on,
                node.access,
                node.check,
                node.notes,
                now
            ],
        )
        .map_err(|error| error.to_string())?;
    }
    for (day, summary) in &changes {
        tx.execute(
            "INSERT OR IGNORE INTO project_changes (project_key, day, summary, recorded_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![key, day, summary, now],
        )
        .map_err(|error| error.to_string())?;
    }
    tx.commit().map_err(|error| error.to_string())?;
    Ok((infra, changes.len()))
}

/// Keep the mount out of commits without touching the tracked `.gitignore`.
fn exclude_from_git(root: &Path) {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["rev-parse", "--git-path", "info/exclude"])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output();
    let Ok(output) = output else {
        return;
    };
    if !output.status.success() {
        return;
    }
    let relative = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    if relative.is_empty() {
        return;
    }
    let path = root.join(relative);
    let current = fs::read_to_string(&path).unwrap_or_default();
    if current
        .lines()
        .any(|line| matches!(line.trim(), ".monochrome" | "/.monochrome" | ".monochrome/"))
    {
        return;
    }
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let separator = if current.is_empty() || current.ends_with('\n') {
        ""
    } else {
        "\n"
    };
    let _ = fs::write(
        &path,
        format!("{current}{separator}# Monochrome project knowledge (a link, see .monochrome/README.md)\n{MOUNT}\n"),
    );
}

#[cfg(unix)]
fn link(target: &Path, at: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, at)
}

#[cfg(windows)]
fn link(target: &Path, at: &Path) -> std::io::Result<()> {
    std::os::windows::fs::symlink_dir(target, at)
}

/// Point `<project>/.monochrome` at the store. An existing link that leads
/// elsewhere, or a real file or folder of that name, is left untouched.
fn mount(root: &Path, dir: &Path) -> Result<(), String> {
    let at = root.join(MOUNT);
    match fs::symlink_metadata(&at) {
        Ok(meta) if meta.file_type().is_symlink() => {
            let target = fs::read_link(&at).map_err(|error| error.to_string())?;
            if target == dir {
                Ok(())
            } else if !at.exists() {
                // A dangling link from a moved data folder: repoint it.
                fs::remove_file(&at).map_err(|error| error.to_string())?;
                link(dir, &at).map_err(|error| error.to_string())
            } else {
                Err(format!("{MOUNT} links somewhere else; remove it to let Monochrome mount the project knowledge."))
            }
        }
        Ok(_) => Err(format!(
            "{MOUNT} already exists in this project and is not Monochrome's link."
        )),
        Err(_) => link(dir, &at).map_err(|error| error.to_string()),
    }
}

fn is_mounted(root: &Path, dir: &Path) -> bool {
    fs::read_link(root.join(MOUNT)).is_ok_and(|target| target == dir)
}

fn sync(
    conn: &mut Connection,
    base: &Path,
    cwd: &str,
    create: bool,
    now: i64,
) -> Result<KnowledgeStatus, String> {
    let key = crate::auto_model::project_key(cwd)?;
    let root = PathBuf::from(&key);
    let dir = store_dir(base, &key);
    if !root.is_dir() {
        return Ok(KnowledgeStatus::default());
    }
    let mut problem = None;
    if !is_mounted(&root, &dir) {
        if !create {
            return Ok(KnowledgeStatus::default());
        }
        fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
        if let Err(error) = mount(&root, &dir) {
            problem = Some(error);
        }
    }
    if problem.is_none() {
        exclude_from_git(&root);
    }
    sync_docs(conn, &key, &dir, now)?;
    let (infra, changes) = index(conn, &key, now)?;
    Ok(KnowledgeStatus {
        mounted: problem.is_none(),
        problem,
        infra,
        changes,
    })
}

fn record(
    conn: &mut Connection,
    base: &Path,
    cwd: &str,
    notes: &[String],
    changes: &[String],
    now: i64,
) -> Result<KnowledgeStatus, String> {
    let key = crate::auto_model::project_key(cwd)?;
    let dir = store_dir(base, &key);
    // Pick up edits made since the last sync before writing over the files.
    let status = sync(conn, base, cwd, true, now)?;
    if !PathBuf::from(&key).is_dir() {
        return Ok(status);
    }
    let memory = crate::auto_model::remember(conn, &key, notes, now)?;
    let model_path = dir.join(MODEL_DOC);
    let model = read_doc(&model_path).unwrap_or_else(|| MODEL_TEMPLATE.to_owned());
    fs::write(&model_path, with_session_notes(&model, &memory))
        .map_err(|error| error.to_string())?;
    let changes = changes
        .iter()
        .map(|change| clip(change.trim_start_matches(['-', '*', ' '])))
        .filter(|change| !change.is_empty())
        .collect::<Vec<_>>();
    if !changes.is_empty() {
        let path = dir.join(CHANGES_DOC);
        let mut text = read_doc(&path).unwrap_or_else(|| CHANGES_TEMPLATE.to_owned());
        if !text.ends_with('\n') {
            text.push('\n');
        }
        let day = today();
        for change in changes {
            text.push_str(&format!("- {day} {change}\n"));
        }
        fs::write(&path, text).map_err(|error| error.to_string())?;
    }
    sync(conn, base, cwd, true, now)
}

fn base_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("project-knowledge"))
}

/// Copy the documents into the database and index them. With `create`, mount
/// the knowledge folder into a project that does not have it yet.
#[tauri::command(async)]
pub fn project_knowledge_sync(
    app: AppHandle,
    store: State<'_, SessionStore>,
    cwd: String,
    create: bool,
) -> Result<KnowledgeStatus, String> {
    let base = base_dir(&app)?;
    let mut conn = store.lock_conn()?;
    sync(&mut conn, &base, &cwd, create, now_millis())
}

/// Add what a finished session learned and changed to the project knowledge.
#[tauri::command(async)]
pub fn project_knowledge_record(
    app: AppHandle,
    store: State<'_, SessionStore>,
    cwd: String,
    session_id: String,
    notes: Vec<String>,
    changes: Vec<String>,
) -> Result<KnowledgeStatus, String> {
    validate_id(&session_id, "session")?;
    let base = base_dir(&app)?;
    let mut conn = store.lock_conn()?;
    record(&mut conn, &base, &cwd, &notes, &changes, now_millis())
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoggedChange {
    day: String,
    summary: String,
}

/// A host or service that another project's map names too.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedNode {
    name: String,
    projects: Vec<String>,
}

/// Everything the project page shows.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgePage {
    status: KnowledgeStatus,
    user: String,
    model: String,
    infra: String,
    changes: String,
    change_log: Vec<LoggedChange>,
    shared: Vec<SharedNode>,
}

fn change_log(conn: &Connection, key: &str) -> Result<Vec<LoggedChange>, String> {
    let mut statement = conn
        .prepare(
            "SELECT day, summary FROM project_changes WHERE project_key = ?1
             ORDER BY day DESC, recorded_at DESC, rowid DESC LIMIT 200",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([key], |row| {
            Ok(LoggedChange {
                day: row.get(0)?,
                summary: row.get(1)?,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<_, _>>()
        .map_err(|error| error.to_string())
}

fn shared_nodes(conn: &Connection, key: &str) -> Result<Vec<SharedNode>, String> {
    let mut statement = conn
        .prepare(
            "SELECT mine.name, other.project_key FROM project_infra mine
             JOIN project_infra other
               ON other.name = mine.name AND other.project_key <> mine.project_key
             WHERE mine.project_key = ?1
             ORDER BY mine.name, other.project_key",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([key], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| error.to_string())?;
    let mut shared: Vec<SharedNode> = Vec::new();
    for row in rows {
        let (name, project) = row.map_err(|error| error.to_string())?;
        match shared.last_mut() {
            Some(node) if node.name == name => node.projects.push(project),
            _ => shared.push(SharedNode {
                name,
                projects: vec![project],
            }),
        }
    }
    Ok(shared)
}

fn page(
    conn: &mut Connection,
    base: &Path,
    cwd: &str,
    create: bool,
    now: i64,
) -> Result<KnowledgePage, String> {
    let status = sync(conn, base, cwd, create, now)?;
    if !status.mounted {
        return Ok(KnowledgePage {
            status,
            ..KnowledgePage::default()
        });
    }
    let key = crate::auto_model::project_key(cwd)?;
    let doc = |name: &str| Ok::<_, String>(stored_doc(conn, &key, name)?.unwrap_or_default());
    Ok(KnowledgePage {
        user: doc(USER_DOC)?,
        model: doc(MODEL_DOC)?,
        infra: doc(INFRA_DOC)?,
        changes: doc(CHANGES_DOC)?,
        change_log: change_log(conn, &key)?,
        shared: shared_nodes(conn, &key)?,
        status,
    })
}

fn write(
    conn: &mut Connection,
    base: &Path,
    cwd: &str,
    name: &str,
    content: &str,
    now: i64,
) -> Result<KnowledgePage, String> {
    if !DOCS.contains(&name) {
        return Err("Unknown project knowledge document.".into());
    }
    if content.len() as u64 > MAX_DOC_BYTES {
        return Err("This document is larger than 1 MB.".into());
    }
    let key = crate::auto_model::project_key(cwd)?;
    let status = sync(conn, base, cwd, true, now)?;
    if !status.mounted {
        return Err(status
            .problem
            .unwrap_or_else(|| "This project has no knowledge folder.".into()));
    }
    fs::write(store_dir(base, &key).join(name), content).map_err(|error| error.to_string())?;
    page(conn, base, cwd, false, now)
}

/// Documents, infrastructure map and change log for the project page.
#[tauri::command(async)]
pub fn project_knowledge_page(
    app: AppHandle,
    store: State<'_, SessionStore>,
    cwd: String,
    create: bool,
) -> Result<KnowledgePage, String> {
    let base = base_dir(&app)?;
    let mut conn = store.lock_conn()?;
    page(&mut conn, &base, &cwd, create, now_millis())
}

/// Save one document edited on the project page.
#[tauri::command(async)]
pub fn project_knowledge_write(
    app: AppHandle,
    store: State<'_, SessionStore>,
    cwd: String,
    name: String,
    content: String,
) -> Result<KnowledgePage, String> {
    let base = base_dir(&app)?;
    let mut conn = store.lock_conn()?;
    write(&mut conn, &base, &cwd, &name, &content, now_millis())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::auto_model::ensure_tables(&conn).unwrap();
        ensure_tables(&conn).unwrap();
        conn
    }

    fn scratch() -> (PathBuf, PathBuf, String) {
        let top = std::env::temp_dir().join(format!("knowledge-test-{}", uuid::Uuid::new_v4()));
        let project = top.join("acme");
        fs::create_dir_all(&project).unwrap();
        let cwd = project.to_string_lossy().into_owned();
        (top.join("data"), project, cwd)
    }

    #[test]
    fn parses_the_infrastructure_map() {
        let nodes = parse_infra(
            "# Infrastructure\n\n```\n## example-in-a-fence\n- kind: host\n```\n\n## zabbix-proxy-eu\n- kind: proxy\n- role: collects EU metrics\n- runs on: eu-mon-1\n- access: tsh ssh ops@eu-mon-1\n- check: systemctl status zabbix-proxy\n- owner: nobody\n\n## eu-mon-1\n* Kind: host\n\n## zabbix-proxy-eu\n- kind: duplicate\n",
        );
        assert_eq!(nodes.len(), 2);
        assert_eq!(
            nodes[0],
            InfraNode {
                name: "zabbix-proxy-eu".into(),
                kind: "proxy".into(),
                role: "collects EU metrics".into(),
                runs_on: "eu-mon-1".into(),
                access: "tsh ssh ops@eu-mon-1".into(),
                check: "systemctl status zabbix-proxy".into(),
                notes: String::new(),
            }
        );
        assert_eq!(nodes[1].kind, "host");
    }

    #[test]
    fn parses_dated_changes_only() {
        assert_eq!(
            parse_changes("# Changes\n\n- 2026-10-02 Teleport upgraded to 18.2\n- undated line\n- 2026-1-2 bad date\nprose"),
            vec![("2026-10-02".to_owned(), "Teleport upgraded to 18.2".to_owned())]
        );
    }

    #[test]
    fn mounts_once_and_keeps_out_of_git() {
        let (base, project, cwd) = scratch();
        Command::new("git")
            .arg("-C")
            .arg(&project)
            .args(["init", "-q"])
            .status()
            .unwrap();
        let mut conn = conn();

        // Nothing happens until the project asks for a mount.
        assert!(!sync(&mut conn, &base, &cwd, false, 1).unwrap().mounted);
        assert!(!project.join(MOUNT).exists());

        let status = sync(&mut conn, &base, &cwd, true, 2).unwrap();
        assert!(status.mounted);
        assert!(fs::symlink_metadata(project.join(MOUNT))
            .unwrap()
            .file_type()
            .is_symlink());
        assert!(project.join(MOUNT).join("README.md").is_file());
        assert_eq!(
            fs::read_to_string(project.join(MOUNT).join(USER_DOC)).unwrap(),
            USER_TEMPLATE
        );
        sync(&mut conn, &base, &cwd, false, 3).unwrap();
        let exclude = fs::read_to_string(project.join(".git/info/exclude")).unwrap();
        assert_eq!(exclude.matches(".monochrome\n").count(), 1);
        let _ = fs::remove_dir_all(project.parent().unwrap());
    }

    #[test]
    fn files_feed_the_database_and_come_back_from_it() {
        let (base, project, cwd) = scratch();
        let mut conn = conn();
        sync(&mut conn, &base, &cwd, true, 1).unwrap();
        let key = crate::auto_model::project_key(&cwd).unwrap();
        let infra = project.join(MOUNT).join(INFRA_DOC);
        fs::write(&infra, "## db-1\n- kind: host\n- role: primary database\n").unwrap();

        let status = sync(&mut conn, &base, &cwd, false, 2).unwrap();
        assert_eq!(status.infra.len(), 1);
        let role: String = conn
            .query_row(
                "SELECT role FROM project_infra WHERE project_key = ?1 AND name = 'db-1'",
                [&key],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(role, "primary database");

        // A deleted file is restored; a removed section leaves the table.
        fs::remove_file(&infra).unwrap();
        sync(&mut conn, &base, &cwd, false, 3).unwrap();
        assert!(fs::read_to_string(&infra).unwrap().contains("## db-1"));
        fs::write(&infra, "# Infrastructure\n").unwrap();
        assert!(sync(&mut conn, &base, &cwd, false, 4)
            .unwrap()
            .infra
            .is_empty());
        let _ = fs::remove_dir_all(project.parent().unwrap());
    }

    #[test]
    fn records_session_notes_and_changes() {
        let (base, project, cwd) = scratch();
        let mut conn = conn();
        sync(&mut conn, &base, &cwd, true, 1).unwrap();
        let model = project.join(MOUNT).join(MODEL_DOC);
        fs::write(
            &model,
            "# Project knowledge (agents)\n\nDeploys go through staging.\n",
        )
        .unwrap();

        record(
            &mut conn,
            &base,
            &cwd,
            &["Tests run with make test".into()],
            &["- Teleport upgraded to 18.2".into()],
            2,
        )
        .unwrap();
        let status = record(&mut conn, &base, &cwd, &["Use pnpm".into()], &[], 3).unwrap();

        let text = fs::read_to_string(&model).unwrap();
        assert!(text.contains("Deploys go through staging."));
        assert_eq!(text.matches(NOTES_START).count(), 1);
        assert!(text.contains("- Tests run with make test\n- Use pnpm\n"));
        assert_eq!(status.changes, 1);
        let changes = fs::read_to_string(project.join(MOUNT).join(CHANGES_DOC)).unwrap();
        assert!(changes.ends_with(&format!("- {} Teleport upgraded to 18.2\n", today())));
        let _ = fs::remove_dir_all(project.parent().unwrap());
    }

    #[test]
    fn leaves_a_foreign_folder_alone() {
        let (base, project, cwd) = scratch();
        fs::create_dir_all(project.join(MOUNT)).unwrap();
        let mut conn = conn();
        let status = sync(&mut conn, &base, &cwd, true, 1).unwrap();
        assert!(!status.mounted);
        assert!(status.problem.unwrap().contains("already exists"));
        assert!(!project.join(MOUNT).join("README.md").exists());
        let _ = fs::remove_dir_all(project.parent().unwrap());
    }

    #[test]
    fn page_shows_documents_log_and_hosts_shared_with_other_projects() {
        let (base, project, cwd) = scratch();
        let other = project.parent().unwrap().join("billing");
        fs::create_dir_all(&other).unwrap();
        let other_cwd = other.to_string_lossy().into_owned();
        let mut conn = conn();

        assert!(
            !page(&mut conn, &base, &cwd, false, 1)
                .unwrap()
                .status
                .mounted
        );
        assert!(write(&mut conn, &base, &cwd, "README.md", "x", 1).is_err());

        write(
            &mut conn,
            &base,
            &other_cwd,
            INFRA_DOC,
            "## eu-mon-1\n- kind: host\n",
            2,
        )
        .unwrap();
        write(
            &mut conn,
            &base,
            &cwd,
            USER_DOC,
            "Ask before touching prod.\n",
            3,
        )
        .unwrap();
        write(
            &mut conn,
            &base,
            &cwd,
            CHANGES_DOC,
            "- 2026-09-30 Added eu-mon-1\n- 2026-10-02 Teleport upgraded to 18.2\n",
            4,
        )
        .unwrap();
        let page = write(
            &mut conn,
            &base,
            &cwd,
            INFRA_DOC,
            "## eu-mon-1\n- kind: host\n\n## db-1\n- kind: host\n",
            5,
        )
        .unwrap();

        assert_eq!(page.user, "Ask before touching prod.\n");
        assert_eq!(page.status.infra.len(), 2);
        assert_eq!(page.change_log[0].day, "2026-10-02");
        assert_eq!(page.change_log.len(), 2);
        assert_eq!(
            page.shared,
            vec![SharedNode {
                name: "eu-mon-1".into(),
                projects: vec![crate::auto_model::project_key(&other_cwd).unwrap()],
            }]
        );
        assert_eq!(
            fs::read_to_string(project.join(MOUNT).join(USER_DOC)).unwrap(),
            "Ask before touching prod.\n"
        );
        let _ = fs::remove_dir_all(project.parent().unwrap());
    }
}
