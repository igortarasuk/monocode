//! Local planned and spent hours per issue, kept off Linear.

use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use tauri::State;
use uuid::Uuid;

use crate::session_store::SessionStore;

const MAX_ISSUES: usize = 300;
const MAX_ENTRY_HOURS: f64 = 24.0;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TimeEntry {
    pub id: String,
    pub issue_id: String,
    pub identifier: String,
    pub day: String,
    pub hours: f64,
    pub note: String,
    pub created_at: i64,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionHint {
    pub session_id: String,
    pub title: String,
    pub started_at: i64,
    pub last_active_at: i64,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IssueHours {
    pub issue_id: String,
    pub planned: Option<f64>,
    pub spent: f64,
    pub entries: Vec<TimeEntry>,
    pub sessions: Vec<SessionHint>,
}

pub(crate) fn ensure_tables(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS planning_plans (
           issue_id TEXT PRIMARY KEY,
           identifier TEXT NOT NULL,
           planned_hours REAL NOT NULL,
           updated_at INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS planning_time_entries (
           id TEXT PRIMARY KEY,
           issue_id TEXT NOT NULL,
           identifier TEXT NOT NULL,
           day TEXT NOT NULL,
           hours REAL NOT NULL,
           note TEXT NOT NULL DEFAULT '',
           created_at INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS planning_time_entries_issue_idx
           ON planning_time_entries (issue_id, day);",
    )
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() < 128
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
}

fn valid_day(day: &str) -> bool {
    let bytes = day.as_bytes();
    bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(i, b)| i == 4 || i == 7 || b.is_ascii_digit())
}

fn valid_hours(hours: f64) -> bool {
    hours.is_finite() && hours > 0.0 && hours <= MAX_ENTRY_HOURS
}

/// `identifiers` pairs with `issue_ids`; keys find session hints.
pub(crate) fn hours_for(
    conn: &Connection,
    issue_ids: &[String],
    identifiers: &[String],
) -> Result<Vec<IssueHours>, String> {
    if issue_ids.len() > MAX_ISSUES || identifiers.len() != issue_ids.len() {
        return Err("Invalid planning request".into());
    }
    let mut out = Vec::with_capacity(issue_ids.len());
    let mut plan_stmt = conn
        .prepare("SELECT planned_hours FROM planning_plans WHERE issue_id = ?1")
        .map_err(|e| e.to_string())?;
    let mut entry_stmt = conn
        .prepare(
            "SELECT id, issue_id, identifier, day, hours, note, created_at
             FROM planning_time_entries WHERE issue_id = ?1
             ORDER BY day DESC, created_at DESC",
        )
        .map_err(|e| e.to_string())?;
    // Sessions started from an issue are titled "<KEY> <title>".
    let mut session_stmt = conn
        .prepare(
            "SELECT id, title, created_at, updated_at FROM sessions
             WHERE (title = ?1 OR substr(title, 1, length(?1) + 1) = ?1 || ' ')
               AND inbox_ask IS NULL
             ORDER BY created_at DESC LIMIT 20",
        )
        .map_err(|e| e.to_string())?;
    for (issue_id, identifier) in issue_ids.iter().zip(identifiers) {
        if !valid_id(issue_id) || !valid_id(identifier) {
            return Err("Invalid planning request".into());
        }
        let planned: Option<f64> = plan_stmt
            .query_row([issue_id], |row| row.get(0))
            .optional()
            .map_err(|e| e.to_string())?;
        let entries = entry_stmt
            .query_map([issue_id], |row| {
                Ok(TimeEntry {
                    id: row.get(0)?,
                    issue_id: row.get(1)?,
                    identifier: row.get(2)?,
                    day: row.get(3)?,
                    hours: row.get(4)?,
                    note: row.get(5)?,
                    created_at: row.get(6)?,
                })
            })
            .and_then(Iterator::collect::<rusqlite::Result<Vec<_>>>)
            .map_err(|e| e.to_string())?;
        let sessions = session_stmt
            .query_map([identifier], |row| {
                Ok(SessionHint {
                    session_id: row.get(0)?,
                    title: row.get(1)?,
                    started_at: row.get(2)?,
                    last_active_at: row.get(3)?,
                })
            })
            .and_then(Iterator::collect::<rusqlite::Result<Vec<_>>>)
            .map_err(|e| e.to_string())?;
        out.push(IssueHours {
            issue_id: issue_id.clone(),
            planned,
            spent: entries.iter().map(|entry| entry.hours).sum(),
            entries,
            sessions,
        });
    }
    Ok(out)
}

pub(crate) fn set_planned(
    conn: &Connection,
    issue_id: &str,
    identifier: &str,
    hours: Option<f64>,
) -> Result<(), String> {
    if !valid_id(issue_id) || !valid_id(identifier) {
        return Err("Invalid issue".into());
    }
    match hours {
        None => conn
            .execute("DELETE FROM planning_plans WHERE issue_id = ?1", [issue_id])
            .map(|_| ()),
        Some(hours) if hours.is_finite() && (0.0..=200.0).contains(&hours) => conn
            .execute(
                "INSERT INTO planning_plans (issue_id, identifier, planned_hours, updated_at)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(issue_id) DO UPDATE SET
                   identifier = excluded.identifier,
                   planned_hours = excluded.planned_hours,
                   updated_at = excluded.updated_at",
                params![issue_id, identifier, hours, now_ms()],
            )
            .map(|_| ()),
        Some(_) => return Err("Planned hours must be between 0 and 200".into()),
    }
    .map_err(|e| e.to_string())
}

pub(crate) fn log_time(
    conn: &Connection,
    issue_id: &str,
    identifier: &str,
    day: &str,
    hours: f64,
    note: &str,
) -> Result<TimeEntry, String> {
    if !valid_id(issue_id) || !valid_id(identifier) {
        return Err("Invalid issue".into());
    }
    if !valid_day(day) {
        return Err("Day must be YYYY-MM-DD".into());
    }
    if !valid_hours(hours) {
        return Err("Hours must be above 0 and at most 24".into());
    }
    let entry = TimeEntry {
        id: Uuid::new_v4().to_string(),
        issue_id: issue_id.into(),
        identifier: identifier.into(),
        day: day.into(),
        hours,
        note: note.trim().chars().take(500).collect(),
        created_at: now_ms(),
    };
    conn.execute(
        "INSERT INTO planning_time_entries
         (id, issue_id, identifier, day, hours, note, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            entry.id,
            entry.issue_id,
            entry.identifier,
            entry.day,
            entry.hours,
            entry.note,
            entry.created_at
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(entry)
}

pub(crate) fn delete_entry(conn: &Connection, id: &str) -> Result<(), String> {
    if !valid_id(id) {
        return Err("Invalid entry".into());
    }
    conn.execute("DELETE FROM planning_time_entries WHERE id = ?1", [id])
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Spent hours per day across all issues.
pub(crate) fn spent_by_day(
    conn: &Connection,
    from: &str,
    to: &str,
) -> Result<HashMap<String, f64>, String> {
    if !valid_day(from) || !valid_day(to) {
        return Err("Day must be YYYY-MM-DD".into());
    }
    let mut stmt = conn
        .prepare(
            "SELECT day, SUM(hours) FROM planning_time_entries
             WHERE day BETWEEN ?1 AND ?2 GROUP BY day",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([from, to], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, f64>(1)?))
        })
        .and_then(Iterator::collect::<rusqlite::Result<HashMap<_, _>>>)
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

#[tauri::command(async)]
pub fn planning_hours(
    store: State<'_, SessionStore>,
    issue_ids: Vec<String>,
    identifiers: Vec<String>,
) -> Result<Vec<IssueHours>, String> {
    let conn = store.lock_conn()?;
    hours_for(&conn, &issue_ids, &identifiers)
}

#[tauri::command(async)]
pub fn planning_set_planned(
    store: State<'_, SessionStore>,
    issue_id: String,
    identifier: String,
    hours: Option<f64>,
) -> Result<(), String> {
    let conn = store.lock_conn()?;
    set_planned(&conn, &issue_id, &identifier, hours)
}

#[tauri::command(async)]
pub fn planning_log_time(
    store: State<'_, SessionStore>,
    issue_id: String,
    identifier: String,
    day: String,
    hours: f64,
    note: String,
) -> Result<TimeEntry, String> {
    let conn = store.lock_conn()?;
    log_time(&conn, &issue_id, &identifier, &day, hours, &note)
}

#[tauri::command(async)]
pub fn planning_delete_entry(store: State<'_, SessionStore>, id: String) -> Result<(), String> {
    let conn = store.lock_conn()?;
    delete_entry(&conn, &id)
}

#[tauri::command(async)]
pub fn planning_spent_by_day(
    store: State<'_, SessionStore>,
    from: String,
    to: String,
) -> Result<HashMap<String, f64>, String> {
    let conn = store.lock_conn()?;
    spent_by_day(&conn, &from, &to)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> SessionStore {
        SessionStore::open_in_memory().unwrap()
    }

    #[test]
    fn plan_and_time_round_trip() {
        let store = store();
        let conn = store.lock_conn().unwrap();
        set_planned(&conn, "i1", "ENG-1", Some(4.0)).unwrap();
        log_time(&conn, "i1", "ENG-1", "2026-09-29", 1.5, " audit ").unwrap();
        log_time(&conn, "i1", "ENG-1", "2026-09-30", 3.0, "").unwrap();
        let hours = hours_for(&conn, &["i1".into()], &["ENG-1".into()]).unwrap();
        assert_eq!(hours[0].planned, Some(4.0));
        assert_eq!(hours[0].spent, 4.5);
        assert_eq!(hours[0].entries[0].day, "2026-09-30");
        assert_eq!(hours[0].entries[1].note, "audit");

        set_planned(&conn, "i1", "ENG-1", Some(6.0)).unwrap();
        delete_entry(&conn, &hours[0].entries[0].id).unwrap();
        let hours = hours_for(&conn, &["i1".into()], &["ENG-1".into()]).unwrap();
        assert_eq!((hours[0].planned, hours[0].spent), (Some(6.0), 1.5));

        set_planned(&conn, "i1", "ENG-1", None).unwrap();
        let hours = hours_for(&conn, &["i1".into()], &["ENG-1".into()]).unwrap();
        assert_eq!(hours[0].planned, None);
    }

    #[test]
    fn rejects_bad_input() {
        let store = store();
        let conn = store.lock_conn().unwrap();
        assert!(log_time(&conn, "i1", "ENG-1", "2026-9-29", 1.0, "").is_err());
        assert!(log_time(&conn, "i1", "ENG-1", "2026-09-29", 0.0, "").is_err());
        assert!(log_time(&conn, "i1", "ENG-1", "2026-09-29", 25.0, "").is_err());
        assert!(log_time(&conn, "i1", "ENG-1", "2026-09-29", f64::NAN, "").is_err());
        assert!(log_time(&conn, "i1'; --", "ENG-1", "2026-09-29", 1.0, "").is_err());
        assert!(set_planned(&conn, "i1", "ENG-1", Some(-1.0)).is_err());
        assert!(hours_for(&conn, &["i1".into()], &[]).is_err());
    }

    #[test]
    fn spent_by_day_sums_across_issues() {
        let store = store();
        let conn = store.lock_conn().unwrap();
        log_time(&conn, "i1", "ENG-1", "2026-09-29", 2.0, "").unwrap();
        log_time(&conn, "i2", "ENG-2", "2026-09-29", 1.5, "").unwrap();
        log_time(&conn, "i2", "ENG-2", "2026-10-05", 1.0, "").unwrap();
        let days = spent_by_day(&conn, "2026-09-28", "2026-10-02").unwrap();
        assert_eq!(days.get("2026-09-29"), Some(&3.5));
        assert!(!days.contains_key("2026-10-05"));
    }

    #[test]
    fn session_hints_match_the_issue_key_prefix_only() {
        let store = store();
        let conn = store.lock_conn().unwrap();
        for (id, title) in [
            ("s1", "ENG-1 Fix login"),
            ("s2", "ENG-12 Other issue"),
            ("s3", "Notes about ENG-1"),
        ] {
            conn.execute(
                "INSERT INTO sessions (id, cwd, harness, model, runtime_mode, title, created_at, updated_at)
                 VALUES (?1, '/p', 'claude', 'm', 'auto', ?2, 1000, 4600000)",
                params![id, title],
            )
            .unwrap();
        }
        let hours = hours_for(&conn, &["i1".into()], &["ENG-1".into()]).unwrap();
        let ids: Vec<&str> = hours[0]
            .sessions
            .iter()
            .map(|s| s.session_id.as_str())
            .collect();
        assert_eq!(ids, ["s1"]);
        let hint = &hours[0].sessions[0];
        assert_eq!(hint.last_active_at - hint.started_at, 4_599_000);
    }
}
