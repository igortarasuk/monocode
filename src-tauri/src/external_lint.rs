//! External linters for the file editor: runs `tflint`, `ansible-lint`,
//! `golangci-lint` and `govulncheck` when they are installed and returns their
//! findings as plain diagnostics. Monochrome never bundles the tools; a missing
//! one is reported as unavailable, not as an error.

use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const TFLINT: &str = "tflint";
const ANSIBLE_LINT: &str = "ansible-lint";
const GOLANGCI_LINT: &str = "golangci-lint";
const GOVULNCHECK: &str = "govulncheck";

const TFLINT_TIMEOUT: Duration = Duration::from_secs(30);
const ANSIBLE_LINT_TIMEOUT: Duration = Duration::from_secs(60);
const GOLANGCI_LINT_TIMEOUT: Duration = Duration::from_secs(60);
/// Per module: the first run also downloads the vulnerability database.
const GOVULNCHECK_TIMEOUT: Duration = Duration::from_secs(180);
const MAX_OUTPUT: usize = 16 << 20;
/// How deep below the project root `go.mod` files are looked for.
const MODULE_DEPTH: usize = 4;
const MAX_MODULES: usize = 20;
const SKIPPED_DIRS: [&str; 3] = ["vendor", "node_modules", "target"];
/// Linters turned on next to whatever the project (or the default set) enables.
const GOLANGCI_EXTRA_LINTERS: &str = "gosec,govet";

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LintDiagnostic {
    /// 1-based.
    pub line: u32,
    /// 1-based.
    pub column: Option<u32>,
    pub end_line: Option<u32>,
    pub end_column: Option<u32>,
    /// "error" | "warning" | "info"
    pub severity: String,
    pub message: String,
    pub rule: Option<String>,
    pub source: String,
    pub url: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LintReport {
    pub tool: String,
    pub available: bool,
    pub diagnostics: Vec<LintDiagnostic>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LintTool {
    pub tool: String,
    pub available: bool,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VulnFinding {
    pub id: String,
    pub summary: String,
    pub module: String,
    pub found_version: Option<String>,
    pub fixed_version: Option<String>,
    pub url: Option<String>,
    /// Absolute path of the project file that reaches the vulnerable symbol.
    pub path: Option<String>,
    pub line: Option<u32>,
    pub column: Option<u32>,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VulnReport {
    pub available: bool,
    pub modules: u32,
    pub findings: Vec<VulnFinding>,
    pub error: Option<String>,
}

/// What a tool printed, before it is narrowed to one file: each diagnostic
/// with the file name exactly as the tool reported it.
#[derive(Debug, Default, PartialEq)]
struct Parsed {
    issues: Vec<(String, LintDiagnostic)>,
    error: Option<String>,
}

// ---------------------------------------------------------------------------
// Locating and running the tools
// ---------------------------------------------------------------------------

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

/// Where `go install` puts binaries, plus the usual toolchain dir. A launcher
/// start has none of these on PATH unless the login shell exports them.
fn go_bin_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(gobin) = std::env::var_os("GOBIN").filter(|value| !value.is_empty()) {
        dirs.push(PathBuf::from(gobin));
    }
    if let Some(gopath) = std::env::var_os("GOPATH").filter(|value| !value.is_empty()) {
        dirs.extend(std::env::split_paths(&gopath).map(|dir| dir.join("bin")));
    }
    if let Some(home) = home_dir() {
        dirs.push(home.join("go").join("bin"));
    }
    dirs.push("/usr/local/go/bin".into());
    dirs
}

/// The GUI search path (login-shell PATH and the fixed user dirs) followed by
/// the Go bin dirs. Tools run with it too: `golangci-lint` and `govulncheck`
/// both shell out to `go`.
fn search_path() -> std::ffi::OsString {
    let gui = crate::harness::gui_search_path();
    let dirs = std::env::split_paths(std::ffi::OsStr::new(&gui))
        .chain(go_bin_dirs())
        .collect::<Vec<_>>();
    std::env::join_paths(dirs).unwrap_or_else(|_| gui.into())
}

fn is_executable(path: &Path) -> bool {
    let Ok(meta) = fs::metadata(path) else {
        return false;
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.is_file() && meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        meta.is_file()
    }
}

fn locate(tool: &str) -> Option<PathBuf> {
    crate::harness::resolve_gui_binary(tool).or_else(|| {
        go_bin_dirs().into_iter().find_map(|dir| {
            let plain = dir.join(tool);
            if is_executable(&plain) {
                return Some(plain);
            }
            let exe = dir.join(format!("{tool}.exe"));
            (cfg!(windows) && is_executable(&exe)).then_some(exe)
        })
    })
}

struct RunOutput {
    code: Option<i32>,
    stdout: String,
    stderr: String,
}

fn run_tool(
    program: &Path,
    args: &[&str],
    cwd: &Path,
    timeout: Duration,
) -> Result<RunOutput, String> {
    let name = program
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut cmd = Command::new(program);
    cmd.args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::harness::apply_gui_env(&mut cmd);
    cmd.env("PATH", search_path()).env("NO_COLOR", "1");
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut child = cmd
        .spawn()
        .map_err(|error| format!("Could not run {name}: {error}"))?;
    let stdout = capture(child.stdout.take().expect("piped stdout"));
    let stderr = capture(child.stderr.take().expect("piped stderr"));
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
            break status;
        }
        if started.elapsed() >= timeout {
            kill_group(&mut child);
            return Err(format!(
                "{name} did not finish within {} s",
                timeout.as_secs()
            ));
        }
        std::thread::sleep(Duration::from_millis(25));
    };
    Ok(RunOutput {
        code: status.code(),
        stdout: String::from_utf8_lossy(&stdout.join().unwrap_or_default()).into_owned(),
        stderr: String::from_utf8_lossy(&stderr.join().unwrap_or_default()).into_owned(),
    })
}

fn capture(mut reader: impl Read + Send + 'static) -> std::thread::JoinHandle<Vec<u8>> {
    std::thread::spawn(move || {
        let mut out = Vec::new();
        let mut buffer = [0; 8192];
        while let Ok(count) = reader.read(&mut buffer) {
            if count == 0 {
                break;
            }
            if out.len() < MAX_OUTPUT {
                out.extend_from_slice(&buffer[..count]);
            }
        }
        out
    })
}

fn kill_group(child: &mut std::process::Child) {
    #[cfg(unix)]
    unsafe {
        libc::kill(-(child.id() as i32), libc::SIGKILL);
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// One short line for the UI out of whatever a failed tool printed: the last
/// non-empty line, which is where CLIs (and Python tracebacks) put the cause.
fn failure_text(tool: &str, output: &RunOutput) -> String {
    let text = if output.stderr.trim().is_empty() {
        &output.stdout
    } else {
        &output.stderr
    };
    let line = text
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or_default();
    // golangci-lint logs as `level=error msg="..."`; show just the message.
    let line = line
        .split_once("msg=\"")
        .filter(|_| line.starts_with("level="))
        .map(|(_, message)| message.trim_end_matches('"'))
        .unwrap_or(line);
    if line.is_empty() {
        format!("{tool} failed")
    } else {
        short(line)
    }
}

fn short(text: &str) -> String {
    text.trim().chars().take(300).collect()
}

async fn blocking<T: Send + 'static>(
    task: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|error| error.to_string())?
}

// ---------------------------------------------------------------------------
// Narrowing tool output to the saved file
// ---------------------------------------------------------------------------

fn canonical(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// True when `reported` (as printed by a tool: absolute, or relative to one of
/// `bases`) names `target`, which must already be canonical.
fn names_file(reported: &str, bases: &[&Path], target: &Path) -> bool {
    let reported = Path::new(reported);
    if reported.is_absolute() {
        return canonical(reported) == target;
    }
    bases
        .iter()
        .any(|base| canonical(&base.join(reported)) == target)
}

fn only_for_file(
    issues: Vec<(String, LintDiagnostic)>,
    bases: &[&Path],
    target: &Path,
) -> Vec<LintDiagnostic> {
    let mut matches: HashMap<String, bool> = HashMap::new();
    issues
        .into_iter()
        .filter(|(file, _)| {
            *matches
                .entry(file.clone())
                .or_insert_with(|| names_file(file, bases, target))
        })
        .map(|(_, diagnostic)| diagnostic)
        .collect()
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

fn text(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)?
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

/// A 1-based position; tools print 0 for "unknown".
fn number(value: &Value, key: &str) -> Option<u32> {
    value
        .get(key)?
        .as_u64()
        .filter(|number| *number > 0)
        .and_then(|number| u32::try_from(number).ok())
}

/// `tflint --format json`: `{"issues": [...], "errors": [...]}`. Errors that
/// point at a file (HCL syntax errors) become diagnostics; the rest (bad
/// config, missing plugin) is the report's error.
fn parse_tflint(json: &str) -> Result<Parsed, String> {
    let value: Value =
        serde_json::from_str(json.trim()).map_err(|error| format!("Bad tflint output: {error}"))?;
    let mut parsed = Parsed::default();
    let ranged = |range: &Value, severity: &str, message: String, rule: &Value| {
        let file = text(range, "filename")?;
        let start = range.get("start")?;
        let end = range.get("end").unwrap_or(&Value::Null);
        Some((
            file,
            LintDiagnostic {
                line: number(start, "line")?,
                column: number(start, "column"),
                end_line: number(end, "line"),
                end_column: number(end, "column"),
                severity: severity.to_string(),
                message,
                rule: text(rule, "name"),
                source: TFLINT.to_string(),
                url: text(rule, "link"),
            },
        ))
    };
    for issue in value
        .get("issues")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let rule = issue.get("rule").unwrap_or(&Value::Null);
        let severity = match text(rule, "severity").as_deref() {
            Some("error") => "error",
            Some("notice") | Some("info") => "info",
            _ => "warning",
        };
        let message = text(issue, "message").unwrap_or_default();
        let range = issue.get("range").unwrap_or(&Value::Null);
        parsed.issues.extend(ranged(range, severity, message, rule));
    }
    for error in value
        .get("errors")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let message = match (text(error, "summary"), text(error, "message")) {
            (Some(summary), Some(message)) => format!("{summary}: {message}"),
            (summary, message) => summary.or(message).unwrap_or_default(),
        };
        let range = error.get("range").unwrap_or(&Value::Null);
        match ranged(range, "error", message.clone(), &Value::Null) {
            Some(issue) => parsed.issues.push(issue),
            None if parsed.error.is_none() && !message.is_empty() => {
                parsed.error = Some(short(&message));
            }
            None => {}
        }
    }
    Ok(parsed)
}

/// `ansible-lint -f codeclimate` (same document as `-f json`): an array of
/// issues whose location is either `positions.begin {line, column}` or
/// `lines.begin`.
fn parse_ansible_lint(json: &str) -> Result<Parsed, String> {
    let value: Value = serde_json::from_str(json.trim())
        .map_err(|error| format!("Bad ansible-lint output: {error}"))?;
    let items = value
        .as_array()
        .ok_or_else(|| "Bad ansible-lint output: expected a list".to_string())?;
    let mut parsed = Parsed::default();
    for item in items {
        let Some(location) = item.get("location") else {
            continue;
        };
        let Some(file) = text(location, "path") else {
            continue;
        };
        let begin = location.pointer("/positions/begin");
        let line = begin
            .and_then(|begin| number(begin, "line"))
            .or_else(|| {
                location
                    .get("lines")
                    .and_then(|lines| number(lines, "begin"))
            })
            .unwrap_or(1);
        // Code Climate levels. ansible-lint grades nearly every rule "major",
        // keeps "critical" and "blocker" for syntax and load failures, and
        // prints "minor" for warn-listed rules.
        let severity = match text(item, "severity").as_deref() {
            Some("blocker") | Some("critical") => "error",
            Some("minor") | Some("info") => "info",
            _ => "warning",
        };
        parsed.issues.push((
            file,
            LintDiagnostic {
                line,
                column: begin.and_then(|begin| number(begin, "column")),
                end_line: None,
                end_column: None,
                severity: severity.to_string(),
                message: text(item, "description").unwrap_or_default(),
                rule: text(item, "check_name"),
                source: ANSIBLE_LINT.to_string(),
                url: text(item, "url"),
            },
        ));
    }
    Ok(parsed)
}

/// golangci-lint's JSON report: `{"Issues": [...], "Report": {...}}` on one
/// line. A project config may also send text output to stdout, so the report
/// is picked out by line.
fn parse_golangci(stdout: &str) -> Result<Parsed, String> {
    let report = stdout
        .lines()
        .map(str::trim)
        .filter(|line| line.starts_with('{'))
        .find_map(|line| {
            serde_json::from_str::<Value>(line)
                .ok()
                .filter(|value| value.get("Issues").is_some())
        })
        .or_else(|| serde_json::from_str::<Value>(stdout.trim()).ok())
        .filter(|value| value.get("Issues").is_some())
        .ok_or_else(|| "Bad golangci-lint output".to_string())?;
    let mut parsed = Parsed::default();
    for issue in report
        .get("Issues")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let pos = issue.get("Pos").unwrap_or(&Value::Null);
        let Some(file) = text(pos, "Filename") else {
            continue;
        };
        let linter = text(issue, "FromLinter");
        // Most linters leave Severity empty; gosec grades low/medium/high and
        // a typecheck issue is a compile error.
        let severity = match text(issue, "Severity").as_deref() {
            Some("error") | Some("high") | Some("critical") => "error",
            Some("info") => "info",
            _ if linter.as_deref() == Some("typecheck") => "error",
            _ => "warning",
        };
        let message = text(issue, "Text").unwrap_or_default();
        parsed.issues.push((
            file,
            LintDiagnostic {
                // Package-level issues (typecheck) carry no line.
                line: number(pos, "Line").unwrap_or(1),
                column: number(pos, "Column"),
                end_line: None,
                end_column: None,
                severity: severity.to_string(),
                message: message.trim_start_matches([':', ' ']).to_string(),
                rule: linter,
                source: GOLANGCI_LINT.to_string(),
                url: None,
            },
        ));
    }
    Ok(parsed)
}

/// govulncheck's `-format json` output: a stream of concatenated objects
/// (`config`, `SBOM`, `progress`, `osv`, `finding`), not an array. Only
/// findings whose trace reaches a vulnerable symbol are kept; the trace runs
/// from that symbol out to the entry point, and frames of the scanned module
/// have no version and a position relative to `module_dir`.
fn parse_govulncheck(stream: &str, module_dir: &Path) -> Vec<VulnFinding> {
    let mut advisories: HashMap<String, (String, Option<String>)> = HashMap::new();
    let mut raw = Vec::new();
    // A truncated or interleaved tail ends the stream; what parsed is kept.
    for message in serde_json::Deserializer::from_str(stream)
        .into_iter::<Value>()
        .map_while(Result::ok)
    {
        if let Some(osv) = message.get("osv") {
            let Some(id) = text(osv, "id") else { continue };
            let summary = text(osv, "summary")
                .or_else(|| {
                    text(osv, "details")
                        .map(|details| short(details.lines().next().unwrap_or_default()))
                })
                .unwrap_or_default();
            let url = osv
                .get("database_specific")
                .and_then(|specific| text(specific, "url"));
            advisories.insert(id, (summary, url));
        } else if let Some(finding) = message.get("finding") {
            raw.push(finding.clone());
        }
    }
    let mut seen = HashSet::new();
    let mut findings = Vec::new();
    for finding in raw {
        let Some(id) = text(&finding, "osv") else {
            continue;
        };
        let frames = finding
            .get("trace")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default();
        let Some(symbol) = frames.first() else {
            continue;
        };
        // Module- and package-level findings (imported but never called)
        // have no function in the trace.
        if text(symbol, "function").is_none() {
            continue;
        }
        // The project frame closest to the vulnerable symbol.
        let position = frames
            .iter()
            .filter(|frame| text(frame, "version").is_none())
            .find_map(|frame| {
                let position = frame.get("position")?;
                Some((text(position, "filename")?, position.clone()))
            });
        let (path, line, column) = match position {
            Some((file, position)) => {
                let file = Path::new(&file);
                let path = if file.is_absolute() {
                    file.to_path_buf()
                } else {
                    module_dir.join(file)
                };
                (
                    Some(path.to_string_lossy().into_owned()),
                    number(&position, "line"),
                    number(&position, "column"),
                )
            }
            None => (None, None, None),
        };
        if !seen.insert((id.clone(), path.clone(), line)) {
            continue;
        }
        let (summary, url) = advisories.get(&id).cloned().unwrap_or_default();
        findings.push(VulnFinding {
            url: url.or_else(|| Some(format!("https://pkg.go.dev/vuln/{id}"))),
            id,
            summary,
            module: text(symbol, "module").unwrap_or_default(),
            found_version: text(symbol, "version"),
            fixed_version: text(&finding, "fixed_version"),
            path,
            line,
            column,
        });
    }
    findings
}

// ---------------------------------------------------------------------------
// Running each linter
// ---------------------------------------------------------------------------

fn lint_tflint(
    program: &Path,
    dir: &Path,
    root: &Path,
    target: &Path,
) -> Result<Vec<LintDiagnostic>, LintFailure> {
    // Exit 2 means "issues found" and 1 "errors"; both still print the JSON.
    let output = run_tool(
        program,
        &["--format", "json", "--no-color"],
        dir,
        TFLINT_TIMEOUT,
    )?;
    let parsed = parse_tflint(&output.stdout).map_err(|error| {
        if output.code == Some(0) {
            error
        } else {
            failure_text(TFLINT, &output)
        }
    })?;
    finish(parsed, &[dir, root], target)
}

fn lint_ansible(
    program: &Path,
    path: &Path,
    root: &Path,
    target: &Path,
) -> Result<Vec<LintDiagnostic>, LintFailure> {
    let file = path.to_string_lossy();
    // --offline: no Galaxy installs or schema refreshes from the editor.
    let args = ["-f", "codeclimate", "--nocolor", "--offline", file.as_ref()];
    let output = run_tool(program, &args, root, ANSIBLE_LINT_TIMEOUT)?;
    // 0 is clean and 2 is "violations found"; anything else is a crash.
    if !matches!(output.code, Some(0) | Some(2)) {
        return Err(failure_text(ANSIBLE_LINT, &output));
    }
    let parsed = parse_ansible_lint(&output.stdout)?;
    finish(parsed, &[root], target)
}

fn golangci_args(v2: bool, extra: bool) -> Vec<&'static str> {
    let mut args = vec!["run"];
    if v2 {
        // Absolute paths: v2 otherwise reports them relative to the config.
        args.extend(["--output.json.path", "stdout", "--path-mode", "abs"]);
        args.push("--show-stats=false");
    } else {
        args.extend(["--out-format", "json"]);
    }
    if extra {
        args.extend(["--enable", GOLANGCI_EXTRA_LINTERS]);
    }
    args.push(".");
    args
}

fn lint_golangci(
    program: &Path,
    dir: &Path,
    root: &Path,
    target: &Path,
) -> Result<Vec<LintDiagnostic>, LintFailure> {
    let (mut v2, mut extra) = (true, true);
    loop {
        let output = run_tool(
            program,
            &golangci_args(v2, extra),
            dir,
            GOLANGCI_LINT_TIMEOUT,
        )?;
        // 0 is clean and 1 is "issues found"; a failed run can still print an
        // empty report, so the exit code decides.
        let parsed = parse_golangci(&output.stdout)
            .ok()
            .filter(|parsed| matches!(output.code, Some(0) | Some(1)) || !parsed.issues.is_empty());
        if let Some(parsed) = parsed {
            return finish(parsed, &[dir, root], target);
        }
        if v2 && output.stderr.contains("unknown flag") {
            // golangci-lint v1 spells the output flag differently.
            v2 = false;
        } else if extra {
            // A project config that disables these linters rejects --enable.
            extra = false;
        } else {
            return Err(failure_text(GOLANGCI_LINT, &output));
        }
    }
}

type LintFailure = String;

fn finish(
    parsed: Parsed,
    bases: &[&Path],
    target: &Path,
) -> Result<Vec<LintDiagnostic>, LintFailure> {
    let diagnostics = only_for_file(parsed.issues, bases, target);
    match parsed.error {
        Some(error) if diagnostics.is_empty() => Err(error),
        _ => Ok(diagnostics),
    }
}

fn is_remote(path: &str) -> bool {
    path.starts_with("remote://")
}

fn lint(tool: &str, path: &str, root: &str) -> Result<LintReport, String> {
    if ![TFLINT, ANSIBLE_LINT, GOLANGCI_LINT].contains(&tool) {
        return Err(format!("Unsupported lint tool: {tool}"));
    }
    if is_remote(path) || is_remote(root) {
        return Err("External linters only run on local projects".into());
    }
    let path = Path::new(path);
    let Some(dir) = path.parent().filter(|_| path.is_absolute()) else {
        return Err("Lint path must be absolute".into());
    };
    let root = if root.trim().is_empty() {
        dir
    } else {
        Path::new(root)
    };
    let mut report = LintReport {
        tool: tool.to_string(),
        ..LintReport::default()
    };
    let Some(program) = locate(tool) else {
        return Ok(report);
    };
    report.available = true;
    if !path.is_file() || !root.is_dir() {
        report.error = Some("File not found".into());
        return Ok(report);
    }
    let target = canonical(path);
    let result = match tool {
        TFLINT => lint_tflint(&program, dir, root, &target),
        ANSIBLE_LINT => lint_ansible(&program, path, root, &target),
        _ => lint_golangci(&program, dir, root, &target),
    };
    match result {
        Ok(diagnostics) => report.diagnostics = diagnostics,
        Err(error) => report.error = Some(short(&error)),
    }
    Ok(report)
}

/// Directories under `root` that hold a `go.mod`, nearest first.
fn go_modules(root: &Path) -> Vec<PathBuf> {
    let mut modules = Vec::new();
    let mut level = vec![root.to_path_buf()];
    for _ in 0..=MODULE_DEPTH {
        let mut next = Vec::new();
        level.sort();
        for dir in level {
            if modules.len() >= MAX_MODULES {
                return modules;
            }
            if dir.join("go.mod").is_file() {
                modules.push(dir.clone());
            }
            let Ok(entries) = fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                // file_type() does not follow symlinks, so loops are not walked.
                let is_dir = entry.file_type().is_ok_and(|kind| kind.is_dir());
                if is_dir && !name.starts_with('.') && !SKIPPED_DIRS.contains(&name.as_ref()) {
                    next.push(entry.path());
                }
            }
        }
        level = next;
    }
    modules
}

fn vulnerabilities(root: &str) -> Result<VulnReport, String> {
    if is_remote(root) {
        return Err("Vulnerability checks only run on local projects".into());
    }
    let root = Path::new(root);
    if !root.is_absolute() {
        return Err("Project root must be absolute".into());
    }
    let program = locate(GOVULNCHECK);
    let mut report = VulnReport {
        available: program.is_some(),
        ..VulnReport::default()
    };
    let Some(program) = program else {
        return Ok(report);
    };
    let mut seen = HashSet::new();
    for module in go_modules(root) {
        report.modules += 1;
        let args = ["-format", "json", "./..."];
        let failure = match run_tool(&program, &args, &module, GOVULNCHECK_TIMEOUT) {
            Ok(output) => {
                // Exit 0 even with findings in JSON mode; a build or network
                // failure exits non-zero with the reason on stderr.
                let findings = parse_govulncheck(&output.stdout, &canonical(&module));
                let failed = output.code != Some(0);
                for finding in findings {
                    if seen.insert((finding.id.clone(), finding.path.clone(), finding.line)) {
                        report.findings.push(finding);
                    }
                }
                failed.then(|| failure_text(GOVULNCHECK, &output))
            }
            Err(error) => Some(error),
        };
        if let (None, Some(failure)) = (&report.error, failure) {
            let name = module
                .strip_prefix(root)
                .ok()
                .filter(|relative| !relative.as_os_str().is_empty())
                .map(|relative| format!("{}: ", relative.display()))
                .unwrap_or_default();
            report.error = Some(short(&format!("{name}{failure}")));
        }
    }
    Ok(report)
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Lint the directory or package of `path` and return what belongs to it.
#[tauri::command]
pub async fn external_lint(tool: String, path: String, root: String) -> Result<LintReport, String> {
    blocking(move || lint(&tool, &path, &root)).await
}

/// Which of the supported tools are installed, for Settings.
#[tauri::command]
pub async fn external_lint_tools() -> Vec<LintTool> {
    let probe = || {
        Ok([TFLINT, ANSIBLE_LINT, GOLANGCI_LINT, GOVULNCHECK]
            .into_iter()
            .map(|tool| LintTool {
                tool: tool.to_string(),
                available: locate(tool).is_some(),
            })
            .collect::<Vec<_>>())
    };
    blocking(probe).await.unwrap_or_default()
}

/// Run `govulncheck` over every Go module in the project.
#[tauri::command]
pub async fn vuln_check(root: String) -> Result<VulnReport, String> {
    blocking(move || vulnerabilities(&root)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "monochrome-external-lint-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        canonical(&dir)
    }

    // Captured from tflint 0.63.1.
    const TFLINT_ISSUES: &str = r#"{"issues":[{"rule":{"name":"terraform_unused_declarations","severity":"warning","link":"https://github.com/terraform-linters/tflint-ruleset-terraform/blob/v0.15.0/docs/rules/terraform_unused_declarations.md"},"message":"variable \"unused\" is declared but not used","range":{"filename":"main.tf","start":{"line":5,"column":1},"end":{"line":5,"column":18}},"callers":[],"fixable":true,"fixed":false},{"rule":{"name":"terraform_typed_variables","severity":"warning","link":"https://github.com/terraform-linters/tflint-ruleset-terraform/blob/v0.15.0/docs/rules/terraform_typed_variables.md"},"message":"`other` variable has no type","range":{"filename":"other.tf","start":{"line":1,"column":1},"end":{"line":1,"column":17}},"callers":[],"fixable":false,"fixed":false}],"errors":[]}"#;
    const TFLINT_ERRORS: &str = r#"{"issues":[],"errors":[{"summary":"Unclosed configuration block","message":"There is no closing brace for this block before the end of the file. This may be caused by incorrect brace nesting elsewhere in this file.","severity":"error","range":{"filename":"bad.tf","start":{"line":1,"column":18},"end":{"line":1,"column":19}}}]}"#;

    #[test]
    fn tflint_issues_keep_rule_range_and_link() {
        let parsed = parse_tflint(TFLINT_ISSUES).unwrap();
        assert_eq!(parsed.error, None);
        assert_eq!(parsed.issues.len(), 2);
        let (file, first) = &parsed.issues[0];
        assert_eq!(file, "main.tf");
        assert_eq!(
            first,
            &LintDiagnostic {
                line: 5,
                column: Some(1),
                end_line: Some(5),
                end_column: Some(18),
                severity: "warning".into(),
                message: "variable \"unused\" is declared but not used".into(),
                rule: Some("terraform_unused_declarations".into()),
                source: "tflint".into(),
                url: Some("https://github.com/terraform-linters/tflint-ruleset-terraform/blob/v0.15.0/docs/rules/terraform_unused_declarations.md".into()),
            }
        );
        assert_eq!(parsed.issues[1].0, "other.tf");
    }

    #[test]
    fn tflint_syntax_errors_become_error_diagnostics() {
        let parsed = parse_tflint(TFLINT_ERRORS).unwrap();
        assert_eq!(parsed.error, None);
        let (file, diagnostic) = &parsed.issues[0];
        assert_eq!(file, "bad.tf");
        assert_eq!(diagnostic.severity, "error");
        assert_eq!(diagnostic.line, 1);
        assert_eq!(diagnostic.rule, None);
        assert!(diagnostic
            .message
            .starts_with("Unclosed configuration block: There is no closing brace"));
    }

    #[test]
    fn tflint_errors_without_a_file_are_the_report_error() {
        let parsed = parse_tflint(
            r#"{"issues":[],"errors":[{"summary":"Failed to initialize plugins","message":"Plugin \"aws\" not found","severity":"error"}]}"#,
        )
        .unwrap();
        assert!(parsed.issues.is_empty());
        assert_eq!(
            parsed.error.as_deref(),
            Some("Failed to initialize plugins: Plugin \"aws\" not found")
        );
        assert!(parse_tflint("Failed to load configurations").is_err());
    }

    // Captured from ansible-lint 26.8.0 (`-f codeclimate`).
    const ANSIBLE_LINT_OUTPUT: &str = r#"[{"type": "issue", "check_name": "name[play]", "categories": ["idiom"], "url": "https://docs.ansible.com/projects/lint/rules/name/", "severity": "major", "description": "All plays should be named.", "fingerprint": "93836a3669144d18c97172665c7dc61167d69db7df5eb8edcdf4bf80cafe4715", "location": {"path": "play.yml", "positions": {"begin": {"line": 1, "column": 3}}}}, {"type": "issue", "check_name": "command-instead-of-shell", "categories": ["command-shell", "idiom"], "url": "https://docs.ansible.com/projects/lint/rules/command-instead-of-shell/", "severity": "minor", "description": "Use shell only when shell functionality is required.", "fingerprint": "d5b44caa02eab78fea8fcac4582d3a1145268799214b511294b50bcd4068c560", "location": {"path": "play.yml", "lines": {"begin": 3}}, "content": {"body": "Task/Handler: shell echo hello"}}]"#;

    #[test]
    fn ansible_lint_reads_both_location_shapes() {
        let parsed = parse_ansible_lint(ANSIBLE_LINT_OUTPUT).unwrap();
        assert_eq!(parsed.issues.len(), 2);
        let (file, play) = &parsed.issues[0];
        assert_eq!(file, "play.yml");
        assert_eq!((play.line, play.column), (1, Some(3)));
        assert_eq!(play.severity, "warning");
        assert_eq!(play.rule.as_deref(), Some("name[play]"));
        assert_eq!(play.message, "All plays should be named.");
        assert_eq!(
            play.url.as_deref(),
            Some("https://docs.ansible.com/projects/lint/rules/name/")
        );
        let (_, shell) = &parsed.issues[1];
        assert_eq!((shell.line, shell.column), (3, None));
        assert_eq!(shell.severity, "info");
        assert_eq!(shell.source, "ansible-lint");
    }

    #[test]
    fn ansible_lint_rejects_output_that_is_not_a_list() {
        assert_eq!(parse_ansible_lint("[]").unwrap(), Parsed::default());
        assert!(parse_ansible_lint("{}").is_err());
        assert!(parse_ansible_lint("Traceback (most recent call last):").is_err());
    }

    // Captured from golangci-lint 2.13.2 (linter list in Report shortened).
    const GOLANGCI_OUTPUT: &str = r#"{"Issues":[{"FromLinter":"errcheck","Text":"Error return value of `os.Open` is not checked","Severity":"","SourceLines":["\tos.Open(name)"],"Pos":{"Filename":"a.go","Offset":124,"Line":12,"Column":9},"ExpectNoLint":false,"ExpectedNoLintLinter":""},{"FromLinter":"gosec","Text":"G401: Use of weak cryptographic primitive","Severity":"medium","SourceLines":["\th := md5.New()"],"Pos":{"Filename":"a.go","Offset":0,"Line":10,"Column":7},"ExpectNoLint":false,"ExpectedNoLintLinter":""},{"FromLinter":"typecheck","Text":": # example.com/fix/pkg\n./c.go:2:12: undefined: undefined","Severity":"","SourceLines":["package pkg"],"Pos":{"Filename":"b.go","Offset":0,"Line":1,"Column":0},"ExpectNoLint":false,"ExpectedNoLintLinter":""}],"Report":{"Linters":[{"Name":"errcheck","Enabled":true},{"Name":"gosec","Enabled":true}]}}"#;

    #[test]
    fn golangci_puts_the_linter_in_rule() {
        let parsed = parse_golangci(GOLANGCI_OUTPUT).unwrap();
        assert_eq!(parsed.issues.len(), 3);
        let (file, errcheck) = &parsed.issues[0];
        assert_eq!(file, "a.go");
        assert_eq!((errcheck.line, errcheck.column), (12, Some(9)));
        assert_eq!(errcheck.rule.as_deref(), Some("errcheck"));
        assert_eq!(errcheck.severity, "warning");
        assert_eq!(errcheck.source, "golangci-lint");
        assert_eq!(parsed.issues[1].1.severity, "warning");
        let (_, typecheck) = &parsed.issues[2];
        assert_eq!(typecheck.severity, "error");
        assert_eq!(typecheck.column, None);
        assert!(typecheck.message.starts_with("# example.com/fix/pkg"));
    }

    #[test]
    fn golangci_report_is_found_among_text_output() {
        let stdout = format!("a.go:12:9: Error return value (errcheck)\n{GOLANGCI_OUTPUT}\n");
        assert_eq!(parse_golangci(&stdout).unwrap().issues.len(), 3);
        assert!(parse_golangci("Error: can't load config").is_err());
        assert!(parse_golangci("{\"other\":1}").is_err());
    }

    #[test]
    fn golangci_args_follow_the_major_version() {
        assert_eq!(
            golangci_args(true, true),
            [
                "run",
                "--output.json.path",
                "stdout",
                "--path-mode",
                "abs",
                "--show-stats=false",
                "--enable",
                "gosec,govet",
                "."
            ]
        );
        assert_eq!(
            golangci_args(false, false),
            ["run", "--out-format", "json", "."]
        );
    }

    #[test]
    fn diagnostics_are_narrowed_to_the_saved_file() {
        let root = temp_dir("filter");
        let dir = root.join("infra");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("main.tf"), "").unwrap();
        fs::write(dir.join("other.tf"), "").unwrap();
        let target = canonical(&dir.join("main.tf"));
        let parsed = parse_tflint(TFLINT_ISSUES).unwrap();

        // Relative to the directory the tool ran in.
        let kept = only_for_file(parsed.issues, &[&dir, &root], &target);
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].line, 5);

        // Relative to the project root, absolute, and with `..` segments.
        assert!(names_file("infra/main.tf", &[&dir, &root], &target));
        assert!(names_file(&target.to_string_lossy(), &[], &target));
        assert!(names_file("../infra/./main.tf", &[&dir], &target));
        assert!(!names_file("infra/other.tf", &[&dir, &root], &target));
        assert!(!names_file("main.tf", &[&root], &target));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_tool_error_only_fails_the_report_without_diagnostics() {
        let root = temp_dir("finish");
        fs::write(root.join("main.tf"), "").unwrap();
        let target = canonical(&root.join("main.tf"));
        let mut parsed = parse_tflint(TFLINT_ISSUES).unwrap();
        parsed.error = Some("Failed to initialize plugins".into());
        assert_eq!(finish(parsed, &[&root], &target).unwrap().len(), 1);
        let failed = Parsed {
            issues: Vec::new(),
            error: Some("Failed to initialize plugins".into()),
        };
        assert_eq!(
            finish(failed, &[&root], &target),
            Err("Failed to initialize plugins".into())
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn bad_arguments_are_errors() {
        assert_eq!(
            lint("eslint", "/tmp/a.js", "/tmp"),
            Err("Unsupported lint tool: eslint".into())
        );
        assert!(lint("tflint", "remote://host/main.tf", "remote://host").is_err());
        assert!(lint("tflint", "main.tf", "/tmp").is_err());
        assert!(vulnerabilities("remote://host/project").is_err());
    }

    // Captured from govulncheck v1.8.0 (`-format json ./...`), with the osv
    // entries cut down to the fields that are read.
    const GOVULNCHECK_STREAM: &str = r#"{
  "config": {
    "protocol_version": "v1.0.0",
    "scanner_name": "govulncheck",
    "scanner_version": "v1.8.0",
    "db": "https://vuln.go.dev",
    "go_version": "go1.25.5",
    "scan_level": "symbol",
    "scan_mode": "source"
  }
}
{
  "SBOM": {
    "go_version": "go1.25.5",
    "modules": [{"path": "example.com/vuln"}, {"path": "golang.org/x/text", "version": "v0.3.5"}],
    "roots": ["example.com/vuln/cmd/app"]
  }
}
{
  "progress": {
    "message": "Fetching vulnerabilities from the database..."
  }
}
{
  "osv": {
    "schema_version": "1.3.1",
    "id": "GO-2021-0113",
    "aliases": ["CVE-2021-38561"],
    "summary": "Out-of-bounds read in golang.org/x/text/language",
    "details": "Due to improper index calculation, an incorrectly formatted language tag can cause Parse to panic.",
    "database_specific": {
      "url": "https://pkg.go.dev/vuln/GO-2021-0113",
      "review_status": "REVIEWED"
    }
  }
}
{
  "osv": {
    "id": "GO-2026-4337",
    "details": "A stdlib advisory without a summary.\nSecond line."
  }
}
{
  "finding": {
    "osv": "GO-2026-4337",
    "fixed_version": "v1.25.7",
    "trace": [{"module": "stdlib", "version": "v1.25.5"}]
  }
}
{
  "finding": {
    "osv": "GO-2021-0113",
    "fixed_version": "v0.3.7",
    "trace": [{"module": "golang.org/x/text", "version": "v0.3.5"}]
  }
}
{
  "finding": {
    "osv": "GO-2021-0113",
    "fixed_version": "v0.3.7",
    "trace": [{"module": "golang.org/x/text", "version": "v0.3.5", "package": "golang.org/x/text/language"}]
  }
}
{
  "finding": {
    "osv": "GO-2021-0113",
    "fixed_version": "v0.3.7",
    "trace": [
      {
        "module": "golang.org/x/text",
        "version": "v0.3.5",
        "package": "golang.org/x/text/language",
        "function": "Parse",
        "position": {"filename": "language/parse.go", "offset": 1121, "line": 33, "column": 6}
      },
      {
        "module": "example.com/vuln",
        "package": "example.com/vuln/cmd/app",
        "function": "main",
        "position": {"filename": "cmd/app/main.go", "offset": 147, "line": 12, "column": 29}
      }
    ]
  }
}
"#;

    #[test]
    fn govulncheck_stream_keeps_only_called_symbols() {
        let findings = parse_govulncheck(GOVULNCHECK_STREAM, Path::new("/work/vuln"));
        assert_eq!(
            findings,
            vec![VulnFinding {
                id: "GO-2021-0113".into(),
                summary: "Out-of-bounds read in golang.org/x/text/language".into(),
                module: "golang.org/x/text".into(),
                found_version: Some("v0.3.5".into()),
                fixed_version: Some("v0.3.7".into()),
                url: Some("https://pkg.go.dev/vuln/GO-2021-0113".into()),
                path: Some("/work/vuln/cmd/app/main.go".into()),
                line: Some(12),
                column: Some(29),
            }]
        );
    }

    #[test]
    fn govulncheck_findings_are_deduplicated_and_survive_a_cut_stream() {
        let called = r#"{"finding":{"osv":"GO-1","trace":[{"module":"stdlib","version":"v1.25.5","package":"net/http","function":"Get"},{"module":"example.com/app","function":"main","position":{"filename":"main.go","line":7,"column":2}}]}}"#;
        let elsewhere = called.replace("\"line\":7", "\"line\":9");
        let stream = format!(
            "{{\"osv\":{{\"id\":\"GO-1\",\"details\":\"First line.\\nMore.\"}}}}\n{called}{called}\n{elsewhere}{{\"finding\":{{\"osv\":\"GO-2\",\"tra"
        );
        let findings = parse_govulncheck(&stream, Path::new("/app"));
        assert_eq!(findings.len(), 2);
        assert_eq!(findings[0].summary, "First line.");
        assert_eq!(findings[0].module, "stdlib");
        assert_eq!(findings[0].fixed_version, None);
        assert_eq!(
            findings[0].url.as_deref(),
            Some("https://pkg.go.dev/vuln/GO-1")
        );
        assert_eq!(findings[0].path.as_deref(), Some("/app/main.go"));
        assert_eq!((findings[0].line, findings[1].line), (Some(7), Some(9)));
        assert!(parse_govulncheck("not json", Path::new("/app")).is_empty());
    }

    #[test]
    fn go_modules_skips_vendored_and_hidden_dirs() {
        let root = temp_dir("modules");
        for dir in [
            "",
            "services/api",
            "vendor/dep",
            "node_modules/pkg",
            ".cache/mod",
            "target/gen",
            "a/b/c/d/e",
        ] {
            fs::create_dir_all(root.join(dir)).unwrap();
            fs::write(root.join(dir).join("go.mod"), "module x\n").unwrap();
        }
        assert_eq!(
            go_modules(&root),
            vec![root.clone(), root.join("services/api")]
        );
        assert!(go_modules(&root.join("vendor/dep/none")).is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn failure_text_is_the_last_line_of_stderr() {
        let output = RunOutput {
            code: Some(3),
            stdout: String::new(),
            stderr: "Error: can't load config\nThe command is terminated due to an error: can't load config\n\n".into(),
        };
        assert_eq!(
            failure_text("golangci-lint", &output),
            "The command is terminated due to an error: can't load config"
        );
        let logged = RunOutput {
            code: Some(7),
            stdout: String::new(),
            stderr: "level=error msg=\"Running error: no go files to analyze\"\n".into(),
        };
        assert_eq!(
            failure_text("golangci-lint", &logged),
            "Running error: no go files to analyze"
        );
        let silent = RunOutput {
            code: Some(1),
            stdout: String::new(),
            stderr: String::new(),
        };
        assert_eq!(failure_text("tflint", &silent), "tflint failed");
    }
}
