//! Local Ollama models for the Local models page: list, pull and delete
//! through the Ollama HTTP API on this machine.

use serde::Serialize;
use serde_json::Value;
use std::time::Duration;

const DEFAULT_BASE: &str = "http://127.0.0.1:11434";
const LIST_TIMEOUT: Duration = Duration::from_secs(10);
const PULL_TIMEOUT: Duration = Duration::from_secs(4 * 60 * 60);

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OllamaModel {
    pub name: String,
    pub size: u64,
    pub modified_at: String,
    pub parameter_size: String,
    pub quantization: String,
    pub context_length: Option<u64>,
    pub capabilities: Vec<String>,
}

/// `OLLAMA_HOST` may be `host:port`, `:port` or a full URL.
fn base_url(host: Option<&str>) -> String {
    let Some(host) = host.map(str::trim).filter(|host| !host.is_empty()) else {
        return DEFAULT_BASE.into();
    };
    let host = host.trim_end_matches('/');
    if host.starts_with("http://") || host.starts_with("https://") {
        return host.into();
    }
    let host = host.replace("0.0.0.0", "127.0.0.1");
    if let Some(port) = host.strip_prefix(':') {
        return format!("http://127.0.0.1:{port}");
    }
    if host.contains(':') {
        format!("http://{host}")
    } else {
        format!("http://{host}:11434")
    }
}

fn base() -> String {
    base_url(std::env::var("OLLAMA_HOST").ok().as_deref())
}

/// Model names as Ollama prints them: `name[:tag]`, optionally namespaced.
fn valid_model(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 200
        && !name.starts_with(['-', '.', '/'])
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-:/".contains(&b))
}

fn parse_tags(value: &Value) -> Vec<OllamaModel> {
    let text = |value: &Value| value.as_str().unwrap_or_default().to_string();
    value["models"]
        .as_array()
        .map(|models| {
            models
                .iter()
                .map(|model| OllamaModel {
                    name: text(&model["name"]),
                    size: model["size"].as_u64().unwrap_or(0),
                    modified_at: text(&model["modified_at"]),
                    parameter_size: text(&model["details"]["parameter_size"]),
                    quantization: text(&model["details"]["quantization_level"]),
                    context_length: model["details"]["context_length"].as_u64(),
                    capabilities: model["capabilities"]
                        .as_array()
                        .map(|items| items.iter().map(text).collect())
                        .unwrap_or_default(),
                })
                .filter(|model| !model.name.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

fn agent(timeout: Duration) -> ureq::Agent {
    ureq::AgentBuilder::new().timeout(timeout).build()
}

fn read_json(response: ureq::Response) -> Result<Value, String> {
    let body = response.into_string().map_err(|error| error.to_string())?;
    serde_json::from_str(&body).map_err(|error| error.to_string())
}

fn http_error(error: ureq::Error) -> String {
    match error {
        ureq::Error::Status(status, response) => {
            let body = response.into_string().unwrap_or_default();
            let message = serde_json::from_str::<Value>(&body)
                .ok()
                .and_then(|value| value["error"].as_str().map(str::to_string))
                .unwrap_or(body);
            format!("Ollama returned {status}: {}", message.trim())
        }
        ureq::Error::Transport(_) => "Ollama is not running on this computer".into(),
    }
}

#[tauri::command]
pub async fn ollama_list() -> Result<Vec<OllamaModel>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let response = agent(LIST_TIMEOUT)
            .get(&format!("{}/api/tags", base()))
            .call()
            .map_err(http_error)?;
        Ok(parse_tags(&read_json(response)?))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn ollama_pull(name: String) -> Result<(), String> {
    if !valid_model(&name) {
        return Err("Invalid model name".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let response = agent(PULL_TIMEOUT)
            .post(&format!("{}/api/pull", base()))
            .set("Content-Type", "application/json")
            .send_string(&serde_json::json!({ "model": name, "stream": false }).to_string())
            .map_err(http_error)?;
        let value = read_json(response)?;
        match value["error"].as_str() {
            Some(error) => Err(error.to_string()),
            None => Ok(()),
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn ollama_delete(name: String) -> Result<(), String> {
    if !valid_model(&name) {
        return Err("Invalid model name".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        agent(LIST_TIMEOUT)
            .delete(&format!("{}/api/delete", base()))
            .set("Content-Type", "application/json")
            .send_string(&serde_json::json!({ "model": name }).to_string())
            .map_err(http_error)?;
        Ok(())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    // Captured from `GET /api/tags` on Ollama 0.34 (first two models).
    const TAGS: &str = r#"{"models": [{"name": "qwen3-coder:30b-256k", "model": "qwen3-coder:30b-256k", "modified_at": "2026-09-28T20:38:23.397988849+03:00", "size": 18556700409, "digest": "63700da1ba37c689c95dc5d313166384f7d9c432bc73e8219895f44421aacacd", "details": {"parent_model": "qwen3-coder:30b", "format": "gguf", "family": "qwen3moe", "families": ["qwen3moe"], "parameter_size": "30.5B", "quantization_level": "Q4_K_M", "context_length": 262144, "embedding_length": 2048}, "capabilities": ["completion", "tools"]}, {"name": "gemma4:e4b-128k", "model": "gemma4:e4b-128k", "modified_at": "2026-04-07T11:19:03.227633996+03:00", "size": 9608350735, "digest": "8078e3830f20ad703b4477afb2df320ee7b5e679465c1c2293b698a45e8fd62a", "details": {"parent_model": "gemma4:e4b", "format": "gguf", "family": "gemma4", "families": ["gemma4"], "parameter_size": "8.0B", "quantization_level": "Q4_K_M", "context_length": 131072, "embedding_length": 2560}, "capabilities": ["completion", "vision", "audio", "tools", "thinking"]}]}"#;

    #[test]
    fn parses_captured_tags() {
        let models = parse_tags(&serde_json::from_str(TAGS).unwrap());
        assert_eq!(models.len(), 2);
        assert_eq!(
            models[0],
            OllamaModel {
                name: "qwen3-coder:30b-256k".into(),
                size: 18_556_700_409,
                modified_at: "2026-09-28T20:38:23.397988849+03:00".into(),
                parameter_size: "30.5B".into(),
                quantization: "Q4_K_M".into(),
                context_length: Some(262_144),
                capabilities: vec!["completion".into(), "tools".into()],
            }
        );
        assert_eq!(parse_tags(&serde_json::json!({})), vec![]);
    }

    #[test]
    fn resolves_ollama_host() {
        assert_eq!(base_url(None), DEFAULT_BASE);
        assert_eq!(base_url(Some("")), DEFAULT_BASE);
        assert_eq!(base_url(Some("0.0.0.0:11500")), "http://127.0.0.1:11500");
        assert_eq!(base_url(Some(":9000")), "http://127.0.0.1:9000");
        assert_eq!(base_url(Some("gpu-box")), "http://gpu-box:11434");
        assert_eq!(
            base_url(Some("https://ollama.example.com/")),
            "https://ollama.example.com"
        );
    }

    #[test]
    fn validates_model_names() {
        assert!(valid_model("gemma4:e4b-128k"));
        assert!(valid_model("library/qwen3:8b"));
        assert!(!valid_model(""));
        assert!(!valid_model("-rf"));
        assert!(!valid_model("a b"));
        assert!(!valid_model("x;rm"));
    }
}
