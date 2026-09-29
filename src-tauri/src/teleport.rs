//! Teleport support for SSH machines: when `tsh` is installed and logged in,
//! Settings lists the cluster's nodes, and OpenSSH reaches them through
//! Teleport's own proxy command. Host setup is the normal SSH flow.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const TSH_TIMEOUT: Duration = Duration::from_secs(30);
const OPTIONS_TTL: Duration = Duration::from_secs(10 * 60);

/// Which Teleport cluster carries an SSH machine.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub struct TeleportRoute {
    /// Proxy address, `host:port`.
    pub proxy: String,
    pub cluster: String,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TeleportProfile {
    pub proxy: String,
    pub cluster: String,
    pub username: String,
    pub logins: Vec<String>,
    pub valid_until: String,
    pub active: bool,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TeleportStatus {
    pub installed: bool,
    pub profiles: Vec<TeleportProfile>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TeleportNode {
    pub hostname: String,
    pub id: String,
    pub labels: Vec<(String, String)>,
}

fn host_like(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 253
        && !value.starts_with(['-', '.'])
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b".-:_".contains(&b))
}

pub fn validate_route(route: &TeleportRoute) -> Result<(), String> {
    if host_like(&route.proxy) && host_like(&route.cluster) {
        Ok(())
    } else {
        Err("Invalid Teleport proxy or cluster".into())
    }
}

fn tsh() -> Option<PathBuf> {
    crate::harness::resolve_gui_binary("tsh")
}

fn run_tsh(args: &[&str]) -> Result<String, String> {
    let program = tsh().ok_or("Teleport (`tsh`) is not installed")?;
    let mut cmd = Command::new(program);
    cmd.args(args)
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::harness::apply_gui_env(&mut cmd);
    crate::hide_window_console(&mut cmd);
    let mut child = cmd.spawn().map_err(|error| error.to_string())?;
    let mut stdout = child.stdout.take().expect("piped stdout");
    let mut stderr = child.stderr.take().expect("piped stderr");
    let out = std::thread::spawn(move || {
        let mut text = String::new();
        let _ = stdout.read_to_string(&mut text);
        text
    });
    let err = std::thread::spawn(move || {
        let mut text = String::new();
        let _ = stderr.read_to_string(&mut text);
        text
    });
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
            break status;
        }
        if started.elapsed() > TSH_TIMEOUT {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Teleport did not answer in time".into());
        }
        std::thread::sleep(Duration::from_millis(25));
    };
    let stdout = out.join().unwrap_or_default();
    let stderr = err.join().unwrap_or_default();
    if status.success() {
        Ok(stdout)
    } else {
        let message = stderr.trim();
        Err(if message.is_empty() {
            format!("tsh {} failed", args.first().unwrap_or(&""))
        } else {
            message.chars().take(300).collect()
        })
    }
}

fn text(value: &Value) -> String {
    value.as_str().unwrap_or_default().to_string()
}

fn parse_profile(value: &Value, active: bool) -> Option<TeleportProfile> {
    let url = text(&value["profile_url"]);
    let proxy = url
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .trim_end_matches('/')
        .to_string();
    let cluster = text(&value["cluster"]);
    if !host_like(&proxy) || !host_like(&cluster) {
        return None;
    }
    Some(TeleportProfile {
        proxy,
        cluster,
        username: text(&value["username"]),
        logins: value["logins"]
            .as_array()
            .map(|items| items.iter().map(text).filter(|l| !l.is_empty()).collect())
            .unwrap_or_default(),
        valid_until: text(&value["valid_until"]),
        active,
    })
}

/// `tsh status --format=json`: the active profile first, then the others.
fn parse_status(value: &Value) -> Vec<TeleportProfile> {
    let mut profiles: Vec<TeleportProfile> = Vec::new();
    if let Some(active) = parse_profile(&value["active"], true) {
        profiles.push(active);
    }
    for item in value["profiles"].as_array().into_iter().flatten() {
        if let Some(profile) = parse_profile(item, false) {
            if !profiles.iter().any(|p| p.cluster == profile.cluster) {
                profiles.push(profile);
            }
        }
    }
    profiles
}

/// `tsh ls --format=json`: node hostnames with their static labels.
fn parse_nodes(value: &Value) -> Vec<TeleportNode> {
    let mut nodes: Vec<TeleportNode> = value
        .as_array()
        .into_iter()
        .flatten()
        .filter(|item| item["kind"] == "node")
        .filter_map(|item| {
            let hostname = text(&item["spec"]["hostname"]);
            if !host_like(&hostname) {
                return None;
            }
            let mut labels: Vec<(String, String)> = item["metadata"]["labels"]
                .as_object()
                .map(|labels| {
                    labels
                        .iter()
                        .map(|(key, value)| (key.clone(), text(value)))
                        .collect()
                })
                .unwrap_or_default();
            labels.sort();
            Some(TeleportNode {
                hostname,
                id: text(&item["metadata"]["name"]),
                labels,
            })
        })
        .collect();
    nodes.sort_by(|a, b| a.hostname.cmp(&b.hostname));
    nodes
}

/// OpenSSH `-o` options from `tsh config`: the proxy command, key,
/// certificate and known hosts Teleport uses for this cluster's nodes.
fn parse_config(config: &str) -> Vec<(String, String)> {
    const KEYS: [&str; 5] = [
        "UserKnownHostsFile",
        "IdentityFile",
        "CertificateFile",
        "Port",
        "ProxyCommand",
    ];
    let mut options: Vec<(String, String)> = Vec::new();
    for line in config.lines() {
        let line = line.trim();
        let Some((key, value)) = line.split_once(char::is_whitespace) else {
            continue;
        };
        if KEYS.contains(&key) && !options.iter().any(|(k, _)| k == key) {
            options.push((key.to_string(), value.trim().to_string()));
        }
    }
    options
}

type SshOptions = Vec<(String, String)>;

/// `tsh config` output per route, refreshed every few minutes.
static OPTIONS: Mutex<Option<HashMap<TeleportRoute, (Instant, SshOptions)>>> = Mutex::new(None);

/// `-o Key=Value` arguments for OpenSSH; falls back to a bare proxy command
/// when `tsh config` is unavailable.
pub fn ssh_args(route: &TeleportRoute) -> Vec<String> {
    if validate_route(route).is_err() {
        return Vec::new();
    }
    let cached = OPTIONS
        .lock()
        .ok()
        .and_then(|cache| cache.as_ref()?.get(route).cloned())
        .filter(|(at, _)| at.elapsed() < OPTIONS_TTL)
        .map(|(_, options)| options);
    let options = cached.unwrap_or_else(|| {
        let options = run_tsh(&["config", &format!("--proxy={}", route.proxy)])
            .map(|config| parse_config(&config))
            .unwrap_or_default();
        let options = if options.iter().any(|(key, _)| key == "ProxyCommand") {
            options
        } else {
            fallback_options(route)
        };
        if let Ok(mut cache) = OPTIONS.lock() {
            cache
                .get_or_insert_with(HashMap::new)
                .insert(route.clone(), (Instant::now(), options.clone()));
        }
        options
    });
    options
        .into_iter()
        .flat_map(|(key, value)| ["-o".to_string(), format!("{key}={value}")])
        .collect()
}

fn fallback_options(route: &TeleportRoute) -> Vec<(String, String)> {
    let program = tsh()
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_else(|| "tsh".into());
    vec![(
        "ProxyCommand".into(),
        format!(
            "\"{program}\" proxy ssh --cluster={} --proxy={} %r@%h:%p",
            route.cluster, route.proxy
        ),
    )]
}

#[tauri::command(async)]
pub fn teleport_status() -> Result<TeleportStatus, String> {
    if tsh().is_none() {
        return Ok(TeleportStatus::default());
    }
    let profiles = run_tsh(&["status", "--format=json"])
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .map(|value| parse_status(&value))
        .unwrap_or_default();
    Ok(TeleportStatus {
        installed: true,
        profiles,
    })
}

#[tauri::command(async)]
pub fn teleport_nodes(proxy: String, cluster: String) -> Result<Vec<TeleportNode>, String> {
    let route = TeleportRoute { proxy, cluster };
    validate_route(&route)?;
    let raw = run_tsh(&[
        "ls",
        "--format=json",
        &format!("--proxy={}", route.proxy),
        &format!("--cluster={}", route.cluster),
    ])?;
    let value: Value = serde_json::from_str(&raw)
        .map_err(|_| "Teleport returned an unexpected node list".to_string())?;
    Ok(parse_nodes(&value))
}

#[cfg(test)]
mod tests {
    use super::*;

    // `tsh status --format=json` from tsh 18.11, trimmed and renamed.
    const STATUS: &str = r#"{"active": {"profile_url": "https://tp.example.com:443", "username": "alice", "cluster": "tp.example.com", "logins": ["ops"], "valid_until": "2026-09-29T18:27:12+03:00"}, "profiles": [{"profile_url": "https://bs.example.com:443", "username": "alice", "cluster": "bs.example.com", "logins": ["ops"], "valid_until": "2026-06-20T03:17:26+03:00"}, {"profile_url": "https://tp.example.com:443", "username": "alice", "cluster": "tp.example.com", "logins": ["ops"], "valid_until": "2026-09-29T18:27:12+03:00"}]}"#;

    // `tsh ls --format=json` from tsh 18.11 (cmd_labels dropped, labels renamed).
    const NODES: &str = r#"[{"kind": "node", "version": "v2", "metadata": {"name": "15cb588c-1e62-46b7-8a09-d135a295c05a", "labels": {"team": "web", "visible_name": "b1"}, "expires": "2026-09-29T08:15:42Z"}, "spec": {"addr": "", "hostname": "b1.example.com", "use_tunnel": true, "version": "18.9.0"}}, {"kind": "node", "version": "v2", "metadata": {"name": "dcf4116e-d0ca-41be-a66b-8743befb5137", "labels": {"visible_name": "a14"}}, "spec": {"addr": "", "hostname": "a14.example.com", "use_tunnel": true}}, {"kind": "app", "metadata": {"name": "x"}, "spec": {"hostname": "app.example.com"}}]"#;

    // `tsh config` from tsh 18.11 with paths and names replaced.
    const CONFIG: &str = r#"# Begin generated Teleport configuration for tp.example.com by tsh

# Common flags for all tp.example.com hosts
Host *.tp.example.com tp.example.com
    UserKnownHostsFile "/home/alice/.tsh/known_hosts"
    IdentityFile "/home/alice/.tsh/keys/tp.example.com/alice"
    CertificateFile "/home/alice/.tsh/keys/tp.example.com/alice-ssh/tp.example.com-cert.pub"

# Flags for all tp.example.com hosts except the proxy
Host *.tp.example.com !tp.example.com
    Port 3022
    ProxyCommand "/usr/local/bin/tsh" proxy ssh --cluster=tp.example.com --proxy=tp.example.com:443 %r@%h:%p

# End generated Teleport configuration
"#;

    #[test]
    fn parses_profiles_active_first_without_duplicates() {
        let profiles = parse_status(&serde_json::from_str(STATUS).unwrap());
        assert_eq!(profiles.len(), 2);
        assert_eq!(
            profiles[0],
            TeleportProfile {
                proxy: "tp.example.com:443".into(),
                cluster: "tp.example.com".into(),
                username: "alice".into(),
                logins: vec!["ops".into()],
                valid_until: "2026-09-29T18:27:12+03:00".into(),
                active: true,
            }
        );
        assert_eq!(profiles[1].cluster, "bs.example.com");
        assert!(!profiles[1].active);
    }

    #[test]
    fn parses_nodes_sorted_by_hostname() {
        let nodes = parse_nodes(&serde_json::from_str(NODES).unwrap());
        assert_eq!(
            nodes
                .iter()
                .map(|n| n.hostname.as_str())
                .collect::<Vec<_>>(),
            ["a14.example.com", "b1.example.com"]
        );
        assert_eq!(
            nodes[1].labels,
            vec![
                ("team".to_string(), "web".to_string()),
                ("visible_name".to_string(), "b1".to_string())
            ]
        );
    }

    #[test]
    fn turns_tsh_config_into_ssh_options() {
        let options = parse_config(CONFIG);
        assert_eq!(
            options,
            vec![
                (
                    "UserKnownHostsFile".to_string(),
                    "\"/home/alice/.tsh/known_hosts\"".to_string()
                ),
                (
                    "IdentityFile".to_string(),
                    "\"/home/alice/.tsh/keys/tp.example.com/alice\"".to_string()
                ),
                (
                    "CertificateFile".to_string(),
                    "\"/home/alice/.tsh/keys/tp.example.com/alice-ssh/tp.example.com-cert.pub\""
                        .to_string()
                ),
                ("Port".to_string(), "3022".to_string()),
                (
                    "ProxyCommand".to_string(),
                    "\"/usr/local/bin/tsh\" proxy ssh --cluster=tp.example.com --proxy=tp.example.com:443 %r@%h:%p"
                        .to_string()
                ),
            ]
        );
    }

    #[test]
    fn rejects_routes_that_could_inject_options() {
        let ok = TeleportRoute {
            proxy: "tp.example.com:443".into(),
            cluster: "tp.example.com".into(),
        };
        assert!(validate_route(&ok).is_ok());
        for (proxy, cluster) in [
            ("-oProxyCommand=x", "c"),
            ("p", "c d"),
            ("p;rm", "c"),
            ("", "c"),
        ] {
            let route = TeleportRoute {
                proxy: proxy.into(),
                cluster: cluster.into(),
            };
            assert!(validate_route(&route).is_err(), "{proxy} {cluster}");
            assert!(ssh_args(&route).is_empty());
        }
    }
}
