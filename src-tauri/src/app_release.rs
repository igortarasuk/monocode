//! Monochrome's own releases on GitHub. The fork ships unsigned packages with
//! no Tauri updater feed, so "Check for updates" compares against the newest
//! `v<version>` release and links to it. GitHub's "latest" can be a
//! `host-v*` release, so the list is filtered here instead.

use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

const RELEASES_URL: &str = "https://api.github.com/repos/igortarasuk/monochrome/releases?per_page=30";
const USER_AGENT: &str = "Monochrome";
const HTTP_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, PartialEq, Serialize)]
pub struct AppRelease {
    version: String,
    url: String,
}

fn release_from_json(body: &Value) -> Option<AppRelease> {
    let flag = |key: &str| body.get(key).and_then(Value::as_bool).unwrap_or(false);
    if flag("draft") || flag("prerelease") {
        return None;
    }
    let tag = body.get("tag_name")?.as_str()?;
    let version = tag.strip_prefix('v')?;
    if !version.starts_with(|c: char| c.is_ascii_digit()) {
        return None;
    }
    let url = body.get("html_url")?.as_str()?;
    Some(AppRelease {
        version: version.to_string(),
        url: url.to_string(),
    })
}

/// GitHub lists releases newest first; take the first app release.
fn newest_release(body: &Value) -> Option<AppRelease> {
    body.as_array()?.iter().find_map(release_from_json)
}

/// The newest published app release, or `None` when there is none yet.
#[tauri::command]
pub async fn app_latest_release() -> Result<Option<AppRelease>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let agent = ureq::AgentBuilder::new().timeout(HTTP_TIMEOUT).build();
        let text = agent
            .get(RELEASES_URL)
            .set("User-Agent", USER_AGENT)
            .set("Accept", "application/vnd.github+json")
            .call()
            .map_err(|error| format!("GitHub request failed: {error}"))?
            .into_string()
            .map_err(|error| format!("GitHub response unreadable: {error}"))?;
        let body: Value = serde_json::from_str(&text)
            .map_err(|error| format!("GitHub returned invalid JSON: {error}"))?;
        Ok(newest_release(&body))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_version_and_page_from_a_release() {
        let body = json!({
            "tag_name": "v0.6.1",
            "html_url": "https://github.com/igortarasuk/monochrome/releases/tag/v0.6.1"
        });
        assert_eq!(
            release_from_json(&body),
            Some(AppRelease {
                version: "0.6.1".into(),
                url: "https://github.com/igortarasuk/monochrome/releases/tag/v0.6.1".into(),
            })
        );
    }

    #[test]
    fn skips_host_drafts_and_prereleases() {
        let body = json!([
            { "tag_name": "host-v0.7.0", "html_url": "https://example.com/host" },
            { "tag_name": "v0.7.0", "draft": true, "html_url": "https://example.com/draft" },
            { "tag_name": "v0.7.0-rc1", "prerelease": true, "html_url": "https://example.com/rc" },
            { "tag_name": "v0.6.0", "html_url": "https://example.com/v0.6.0" }
        ]);
        assert_eq!(
            newest_release(&body),
            Some(AppRelease {
                version: "0.6.0".into(),
                url: "https://example.com/v0.6.0".into(),
            })
        );
        assert_eq!(newest_release(&json!([])), None);
    }
}
