//! Laya sandbox connector: talks to `laya-sandbox/laya` (a bash CLI that
//! starts the Docker stack on demand and speaks HTTP over a Unix socket).
//! Monochrome never embeds a model; every call is an allow-listed CLI run.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

const PRESETS: [&str; 2] = ["sql", "test-gaps"];
const STATUS_TIMEOUT: Duration = Duration::from_secs(5);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);
const TRAIN_TIMEOUT: Duration = Duration::from_secs(20 * 60);
const STOP_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_OUTPUT: usize = 16 << 20;

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LayaConfig {
    #[serde(default)]
    pub cli_path: String,
    #[serde(default = "yes")]
    pub gpu: bool,
    #[serde(default = "yes")]
    pub enabled: bool,
}

fn yes() -> bool {
    true
}

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LayaStatus {
    pub configured: bool,
    pub enabled: bool,
    pub gpu: bool,
    pub cli_path: String,
    pub running: bool,
    pub device: String,
    pub qdrant: bool,
    pub domains: Vec<String>,
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("laya-config.json"))
}

fn default_cli_path() -> Option<String> {
    let home = crate::dirs_home()?;
    let path = Path::new(&home).join("Personal/laya-sandbox/laya");
    is_executable(&path).then(|| path.to_string_lossy().into_owned())
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

fn read_config(app: &AppHandle) -> LayaConfig {
    let mut config = config_path(app)
        .ok()
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|raw| serde_json::from_str::<LayaConfig>(&raw).ok())
        .unwrap_or(LayaConfig {
            cli_path: String::new(),
            gpu: true,
            enabled: true,
        });
    config.cli_path = config.cli_path.trim().to_string();
    if config.cli_path.is_empty() {
        config.cli_path = default_cli_path().unwrap_or_default();
    }
    config
}

fn write_config(app: &AppHandle, config: &LayaConfig) -> Result<(), String> {
    let path = config_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let value = serde_json::to_string_pretty(config).map_err(|error| error.to_string())?;
    fs::write(path, value).map_err(|error| error.to_string())
}

fn valid_domain(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 32
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn valid_exclude(value: &str) -> bool {
    value.split(',').all(|part| {
        !part.is_empty()
            && part.len() <= 32
            && part.bytes().all(|b| b.is_ascii_lowercase() || b == b'-')
    })
}

/// The only argument vectors Monochrome passes to the CLI.
fn check_args(args: &[&str]) -> Result<Duration, String> {
    let ok = match args {
        ["status"] => return Ok(STATUS_TIMEOUT),
        ["stop"] => return Ok(STOP_TIMEOUT),
        ["domains"] | ["custom"] => true,
        [preset] => PRESETS.contains(preset),
        ["classify" | "learn" | "domain" | "stats", domain] => valid_domain(domain),
        ["train", domain] => {
            return valid_domain(domain)
                .then_some(TRAIN_TIMEOUT)
                .ok_or_else(bad)
        }
        ["train", domain, exclude] => {
            return (valid_domain(domain) && valid_exclude(exclude))
                .then_some(TRAIN_TIMEOUT)
                .ok_or_else(bad)
        }
        _ => false,
    };
    if ok {
        Ok(REQUEST_TIMEOUT)
    } else {
        Err(bad())
    }
}

fn bad() -> String {
    "Unsupported Laya command".into()
}

struct RunOutput {
    success: bool,
    stdout: String,
    stderr: String,
}

fn run_cli(
    config: &LayaConfig,
    args: &[&str],
    stdin: Option<&[u8]>,
    timeout: Duration,
) -> Result<RunOutput, String> {
    if config.cli_path.is_empty() {
        return Err("Laya is not configured. Set the CLI path in Settings.".into());
    }
    let program = Path::new(&config.cli_path);
    if !is_executable(program) {
        return Err(format!("Laya CLI not found at {}", config.cli_path));
    }
    let mut cmd = Command::new(program);
    cmd.args(args)
        .env("LAYA_GPU", if config.gpu { "1" } else { "0" })
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::harness::apply_gui_env(&mut cmd);
    crate::hide_window_console(&mut cmd);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut child = cmd
        .spawn()
        .map_err(|error| format!("Could not run Laya: {error}"))?;
    if let Some(input) = stdin {
        let mut pipe = child.stdin.take().expect("piped stdin");
        let input = input.to_vec();
        std::thread::spawn(move || {
            let _ = pipe.write_all(&input);
        });
    }
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
                "Laya did not answer within {} s",
                timeout.as_secs()
            ));
        }
        std::thread::sleep(Duration::from_millis(25));
    };
    Ok(RunOutput {
        success: status.success(),
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

/// Run a CLI command that prints one JSON document.
fn run_json(config: &LayaConfig, args: &[&str], stdin: Option<&[u8]>) -> Result<Value, String> {
    let timeout = check_args(args)?;
    let output = run_cli(config, args, stdin, timeout)?;
    if !output.success {
        return Err(error_text(&output));
    }
    parse_json(&output.stdout)
}

fn error_text(output: &RunOutput) -> String {
    let text = if output.stderr.trim().is_empty() {
        output.stdout.trim()
    } else {
        output.stderr.trim()
    };
    // The server replies {"error": "..."}; show just the message.
    let message = serde_json::from_str::<Value>(text)
        .ok()
        .and_then(|value| value.get("error")?.as_str().map(str::to_string))
        .unwrap_or_else(|| text.to_string());
    if message.is_empty() {
        "Laya failed".into()
    } else {
        message.chars().take(300).collect()
    }
}

fn parse_json(stdout: &str) -> Result<Value, String> {
    serde_json::from_str(stdout.trim()).map_err(|_| {
        let head: String = stdout.trim().chars().take(200).collect();
        format!("Laya returned invalid JSON: {head}")
    })
}

/// `laya status`: JSON health when running; `stopped` with exit 1 when down.
fn parse_status(output: &RunOutput) -> Result<Option<Value>, String> {
    if output.success {
        return parse_json(&output.stdout).map(Some);
    }
    if output.stdout.trim() == "stopped" {
        return Ok(None);
    }
    Err(error_text(output))
}

fn status_for(config: &LayaConfig) -> Result<LayaStatus, String> {
    let mut status = LayaStatus {
        configured: !config.cli_path.is_empty() && is_executable(Path::new(&config.cli_path)),
        enabled: config.enabled,
        gpu: config.gpu,
        cli_path: config.cli_path.clone(),
        ..LayaStatus::default()
    };
    if !status.configured {
        return Ok(status);
    }
    let output = run_cli(config, &["status"], None, check_args(&["status"])?)?;
    let Some(health) = parse_status(&output)? else {
        return Ok(status);
    };
    status.running = true;
    status.device = health["device"].as_str().unwrap_or_default().to_string();
    status.qdrant = health["qdrant"].as_bool().unwrap_or(false);
    status.domains = domains_for(config).unwrap_or_default();
    Ok(status)
}

fn domains_for(config: &LayaConfig) -> Result<Vec<String>, String> {
    let value = run_json(config, &["domains"], None)?;
    Ok(value["domains"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default())
}

async fn blocking<T: Send + 'static>(
    task: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn laya_status(app: AppHandle) -> Result<LayaStatus, String> {
    let config = read_config(&app);
    blocking(move || status_for(&config)).await
}

#[tauri::command]
pub async fn laya_set_config(
    app: AppHandle,
    cli_path: String,
    gpu: bool,
    enabled: bool,
) -> Result<LayaStatus, String> {
    let config = LayaConfig {
        cli_path: cli_path.trim().to_string(),
        gpu,
        enabled,
    };
    write_config(&app, &config)?;
    let config = read_config(&app);
    blocking(move || status_for(&config)).await
}

#[tauri::command]
pub async fn laya_start(app: AppHandle) -> Result<LayaStatus, String> {
    let config = read_config(&app);
    blocking(move || {
        domains_for(&config)?;
        status_for(&config)
    })
    .await
}

#[tauri::command]
pub async fn laya_stop(app: AppHandle) -> Result<(), String> {
    let config = read_config(&app);
    blocking(move || {
        let output = run_cli(&config, &["stop"], None, check_args(&["stop"])?)?;
        if output.success {
            Ok(())
        } else {
            Err(error_text(&output))
        }
    })
    .await
}

#[tauri::command]
pub async fn laya_domains(app: AppHandle) -> Result<Vec<String>, String> {
    let config = read_config(&app);
    blocking(move || domains_for(&config)).await
}

#[tauri::command]
pub async fn laya_classify(app: AppHandle, domain: String, text: String) -> Result<Value, String> {
    let config = read_config(&app);
    blocking(move || run_json(&config, &["classify", &domain], Some(text.as_bytes()))).await
}

#[tauri::command]
pub async fn laya_predict(
    app: AppHandle,
    preset: Option<String>,
    questions: Option<Value>,
    text: String,
) -> Result<Value, String> {
    let config = read_config(&app);
    blocking(move || match (preset, questions) {
        (Some(preset), None) => run_json(&config, &[&preset], Some(text.as_bytes())),
        (None, Some(questions)) => {
            let payload = serde_json::json!({ "state": text, "questions": questions });
            run_json(&config, &["custom"], Some(payload.to_string().as_bytes()))
        }
        _ => Err("Pass either a preset or questions".into()),
    })
    .await
}

#[tauri::command]
pub async fn laya_learn(app: AppHandle, domain: String, payload: Value) -> Result<Value, String> {
    let config = read_config(&app);
    blocking(move || {
        run_json(
            &config,
            &["learn", &domain],
            Some(payload.to_string().as_bytes()),
        )
    })
    .await
}

#[tauri::command]
pub async fn laya_train(
    app: AppHandle,
    domain: String,
    exclude: Vec<String>,
) -> Result<Value, String> {
    let config = read_config(&app);
    blocking(move || {
        let exclude = exclude.join(",");
        if exclude.is_empty() {
            run_json(&config, &["train", &domain], None)
        } else {
            run_json(&config, &["train", &domain, &exclude], None)
        }
    })
    .await
}

/// Rules of a domain (`laya domain <name>`), for the management page.
#[tauri::command]
pub async fn laya_domain(app: AppHandle, domain: String) -> Result<Value, String> {
    let config = read_config(&app);
    blocking(move || run_json(&config, &["domain", &domain], None)).await
}

/// Example counts per source (`laya stats <name>`).
#[tauri::command]
pub async fn laya_stats(app: AppHandle, domain: String) -> Result<Value, String> {
    let config = read_config(&app);
    blocking(move || run_json(&config, &["stats", &domain], None)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_only_known_argument_vectors() {
        assert_eq!(check_args(&["status"]), Ok(STATUS_TIMEOUT));
        assert_eq!(check_args(&["stop"]), Ok(STOP_TIMEOUT));
        assert_eq!(check_args(&["domains"]), Ok(REQUEST_TIMEOUT));
        assert_eq!(check_args(&["sql"]), Ok(REQUEST_TIMEOUT));
        assert_eq!(check_args(&["test-gaps"]), Ok(REQUEST_TIMEOUT));
        assert_eq!(check_args(&["custom"]), Ok(REQUEST_TIMEOUT));
        assert_eq!(check_args(&["classify", "ansible"]), Ok(REQUEST_TIMEOUT));
        assert_eq!(check_args(&["train", "ansible"]), Ok(TRAIN_TIMEOUT));
        assert_eq!(
            check_args(&["train", "ansible", "synthetic,seed"]),
            Ok(TRAIN_TIMEOUT)
        );
        for args in [
            &["rm"][..],
            &["classify"],
            &["classify", "../etc"],
            &["classify", "Ansible"],
            &["classify", "a b"],
            &["train", "ansible", "x;y"],
            &["status", "extra"],
            &["-h"],
            &[],
        ] {
            assert!(check_args(args).is_err(), "{args:?}");
        }
    }

    #[test]
    fn validates_domain_names() {
        assert!(valid_domain("ansible"));
        assert!(valid_domain("helm-3"));
        assert!(!valid_domain(""));
        assert!(!valid_domain(&"a".repeat(33)));
        assert!(!valid_domain("a/b"));
        assert!(!valid_domain("a_b"));
    }

    fn output(success: bool, stdout: &str, stderr: &str) -> RunOutput {
        RunOutput {
            success,
            stdout: stdout.into(),
            stderr: stderr.into(),
        }
    }

    #[test]
    fn parses_status_and_detects_stopped() {
        let running = output(
            true,
            "{\"status\": \"ok\", \"device\": \"cuda:0\", \"qdrant\": true}\n",
            "",
        );
        let health = parse_status(&running).unwrap().unwrap();
        assert_eq!(health["device"], "cuda:0");
        assert_eq!(parse_status(&output(false, "stopped\n", "")).unwrap(), None);
        assert!(parse_status(&output(false, "", "docker: not found")).is_err());
    }

    #[test]
    fn reports_server_errors_without_json_noise() {
        let failed = output(false, "{\"error\": \"unknown domain 'x'\"}\n", "");
        assert_eq!(error_text(&failed), "unknown domain 'x'");
        let crashed = output(false, "", "curl: (7) Couldn't connect");
        assert_eq!(error_text(&crashed), "curl: (7) Couldn't connect");
    }

    #[cfg(unix)]
    #[test]
    fn kills_a_cli_that_hangs() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("laya-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let cli = dir.join("laya");
        fs::write(&cli, "#!/bin/sh\nsleep 30\n").unwrap();
        fs::set_permissions(&cli, fs::Permissions::from_mode(0o755)).unwrap();
        let config = LayaConfig {
            cli_path: cli.to_string_lossy().into_owned(),
            gpu: false,
            enabled: true,
        };
        let started = Instant::now();
        let result = run_cli(&config, &["status"], None, Duration::from_millis(300));
        assert!(result.is_err());
        assert!(started.elapsed() < Duration::from_secs(5));
        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn passes_stdin_and_gpu_flag() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("laya-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let cli = dir.join("laya");
        fs::write(
            &cli,
            "#!/bin/sh\nprintf '{\"arg\":\"%s\",\"gpu\":\"%s\",\"in\":\"%s\"}\\n' \"$1\" \"$LAYA_GPU\" \"$(cat)\"\n",
        )
        .unwrap();
        fs::set_permissions(&cli, fs::Permissions::from_mode(0o755)).unwrap();
        let config = LayaConfig {
            cli_path: cli.to_string_lossy().into_owned(),
            gpu: false,
            enabled: true,
        };
        let value = run_json(&config, &["sql"], Some(b"select 1")).unwrap();
        assert_eq!(value["arg"], "sql");
        assert_eq!(value["gpu"], "0");
        assert_eq!(value["in"], "select 1");
        fs::remove_dir_all(dir).unwrap();
    }
}
