//! Footer status of local developer services: Teleport login, Docker daemon
//! and running Vagrant machines. A service that is not installed is omitted.

use serde::Serialize;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const PROBE_TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TeleportService {
    /// Active cluster, when logged in.
    pub cluster: Option<String>,
    pub valid_until: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DockerService {
    pub running: bool,
    pub containers: u32,
    pub version: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VagrantService {
    /// Names of machines in the `running` state.
    pub running: Vec<String>,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServicesStatus {
    pub teleport: Option<TeleportService>,
    pub docker: Option<DockerService>,
    pub vagrant: Option<VagrantService>,
}

fn run(program: &Path, args: &[&str]) -> Option<(bool, String)> {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    crate::harness::apply_gui_env(&mut cmd);
    crate::hide_window_console(&mut cmd);
    let mut child = cmd.spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut text = String::new();
        let _ = stdout.read_to_string(&mut text);
        text
    });
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() < PROBE_TIMEOUT => {
                std::thread::sleep(Duration::from_millis(25))
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    };
    Some((status.success(), reader.join().unwrap_or_default()))
}

fn teleport() -> Option<TeleportService> {
    let status = crate::teleport::teleport_status().ok()?;
    if !status.installed {
        return None;
    }
    let active = status.profiles.into_iter().find(|profile| profile.active);
    Some(TeleportService {
        cluster: active.as_ref().map(|profile| profile.cluster.clone()),
        valid_until: active.map(|profile| profile.valid_until),
    })
}

/// `docker info --format '{{.ServerVersion}} {{.ContainersRunning}}'`.
fn parse_docker(ok: bool, output: &str) -> DockerService {
    let mut parts = output.split_whitespace();
    let version = parts.next().map(str::to_string);
    let containers = parts.next().and_then(|n| n.parse().ok());
    match (ok, version, containers) {
        (true, Some(version), Some(containers)) => DockerService {
            running: true,
            containers,
            version: Some(version),
        },
        _ => DockerService {
            running: false,
            containers: 0,
            version: None,
        },
    }
}

fn docker() -> Option<DockerService> {
    let program = crate::harness::resolve_gui_binary("docker")?;
    let (ok, output) = run(
        &program,
        &[
            "info",
            "--format",
            "{{.ServerVersion}} {{.ContainersRunning}}",
        ],
    )
    .unwrap_or((false, String::new()));
    Some(parse_docker(ok, &output))
}

/// Machine rows of `vagrant global-status --prune --machine-readable`: the
/// table arrives as `ui,info` lines of `id name provider state directory`.
fn parse_vagrant(output: &str) -> Vec<String> {
    output
        .lines()
        .filter_map(|line| line.splitn(5, ',').nth(4))
        .filter_map(|row| {
            let fields: Vec<&str> = row.split_whitespace().collect();
            (fields.len() >= 5
                && fields[0].bytes().all(|b| b.is_ascii_hexdigit())
                && fields[3] == "running")
                .then(|| fields[1].to_string())
        })
        .collect()
}

fn vagrant() -> Option<VagrantService> {
    let program = crate::harness::resolve_gui_binary("vagrant")?;
    let (_, output) = run(
        &program,
        &["global-status", "--prune", "--machine-readable"],
    )
    .unwrap_or((false, String::new()));
    Some(VagrantService {
        running: parse_vagrant(&output),
    })
}

#[tauri::command(async)]
pub fn services_status() -> ServicesStatus {
    let teleport = std::thread::spawn(teleport);
    let docker = std::thread::spawn(docker);
    let vagrant = vagrant();
    ServicesStatus {
        teleport: teleport.join().ok().flatten(),
        docker: docker.join().ok().flatten(),
        vagrant,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_docker_info() {
        // Captured from `docker info --format ...` with Docker 29.7.
        assert_eq!(
            parse_docker(true, "29.7.2 2\n"),
            DockerService {
                running: true,
                containers: 2,
                version: Some("29.7.2".into()),
            }
        );
        assert!(!parse_docker(false, "").running);
        assert!(!parse_docker(true, "Cannot connect").running);
    }

    #[test]
    fn finds_running_vagrant_machines() {
        // Header and empty-state lines captured from Vagrant 2.4; the machine
        // rows follow the same `id name provider state directory` table.
        let output = "1790674088,,ui,info,id       name    provider   state    directory                           \n\
1790674088,,ui,info,--------------------------------------------------------------------\n\
1790674088,,ui,info,a1b2c3d  web     virtualbox running /home/me/lab/web                    \n\
1790674088,,ui,info,e4f5a6b  db      virtualbox poweroff /home/me/lab/db                    \n\
1790674088,,ui,info,There are no active Vagrant environments on this computer! Or%!(VAGRANT_COMMA)\\nyou haven't destroyed\n";
        assert_eq!(parse_vagrant(output), vec!["web".to_string()]);
        assert!(parse_vagrant("").is_empty());
    }
}
