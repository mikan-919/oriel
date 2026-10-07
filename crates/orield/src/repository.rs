use std::{
    process::{Command, Stdio},
    time::Duration,
};

use anyhow::{Result, anyhow, ensure};
use reqwest::header;
use serde::{Deserialize, Serialize};
use url::Url;

use crate::DeviceIdentity;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub(super) struct Repository {
    pub owner: String,
    pub name: String,
}

#[derive(Serialize)]
struct RepositoryReport<'a> {
    repository: Option<&'a Repository>,
}

fn parse_remote(remote: &str) -> Option<Repository> {
    // Never retain or report the original remote: it may contain credentials.
    if remote.contains(['\\', '%', '?', '#']) || remote.chars().any(char::is_whitespace) {
        return None;
    }
    let path = if let Some((authority, path)) = remote.split_once(':')
        && authority.eq_ignore_ascii_case("git@github.com")
    {
        path
    } else {
        let url = Url::parse(remote).ok()?;
        if !matches!(url.scheme(), "https" | "ssh")
            || !url.host_str()?.eq_ignore_ascii_case("github.com")
            || url
                .port()
                .is_some_and(|port| url.scheme() != "ssh" || port != 22)
            || (url.scheme() == "ssh" && (url.username() != "git" || url.password().is_some()))
        {
            return None;
        }
        // Validate the raw path, not URL-normalized dot segments.
        remote.split_once("://")?.1.split_once('/')?.1
    };
    let (owner, name) = path.split_once('/')?;
    let name = name.strip_suffix(".git").unwrap_or(name);
    if owner.is_empty()
        || owner.len() > 39
        || !owner
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        || !owner.as_bytes()[0].is_ascii_alphanumeric()
        || !owner.as_bytes()[owner.len() - 1].is_ascii_alphanumeric()
        || name.is_empty()
        || name.len() > 100
        || matches!(name, "." | "..")
        || !name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
    {
        return None;
    }
    Some(Repository {
        owner: owner.to_ascii_lowercase(),
        name: name.to_ascii_lowercase(),
    })
}

fn detect() -> Result<Option<Repository>> {
    // get-url applies Git's insteadOf rules; stderr and unsuccessful contexts are private.
    let output = Command::new("git")
        .args(["remote", "get-url", "origin"])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .map_err(|_| anyhow!("Detect working repository: git could not be executed"))?;
    if !output.status.success() {
        return Ok(None);
    }
    Ok(std::str::from_utf8(&output.stdout)
        .ok()
        .and_then(|remote| parse_remote(remote.trim_end_matches(['\r', '\n']))))
}

pub(super) async fn report_current(
    origin: &Url,
    identity: &DeviceIdentity,
) -> Result<Option<Repository>> {
    let repository = detect()?;
    let mut authorization =
        header::HeaderValue::from_str(&format!("Bearer {}", identity.host_token))
            .map_err(|_| anyhow!("invalid device authorization credential"))?;
    authorization.set_sensitive(true);
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|_| anyhow!("failed to initialize repository HTTP client"))?;
    let response = client
        .post(origin.join(&format!(
            "/api/integrations/{}/repository",
            identity.device_id
        ))?)
        .header(header::AUTHORIZATION, authorization)
        .json(&RepositoryReport {
            repository: repository.as_ref(),
        })
        .send()
        .await
        .map_err(|_| anyhow!("Report working repository: network request failed"))?;
    ensure!(
        response.status().is_success(),
        "Report working repository: HTTP {} (response details withheld)",
        response.status().as_u16()
    );
    Ok(repository)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn github_clone_remotes_have_one_sanitized_identity() {
        let expected = Repository {
            owner: "mikan-919".into(),
            name: "oriel".into(),
        };
        for remote in [
            "https://github.com/mikan-919/oriel.git",
            "https://github.com/MIKAN-919/Oriel",
            "https://username:secret@github.com/mikan-919/oriel.git",
            "ssh://git@github.com/mikan-919/oriel.git",
            "ssh://git@github.com:22/mikan-919/oriel.git",
            "git@github.com:mikan-919/oriel.git",
        ] {
            assert_eq!(parse_remote(remote).as_ref(), Some(&expected));
        }
        assert_eq!(
            parse_remote("https://github.com/a/repo.git.git")
                .unwrap()
                .name,
            "repo.git"
        );
    }

    #[test]
    fn non_repository_and_ambiguous_remotes_are_not_reported() {
        for remote in [
            "",
            "/home/user/repo",
            "../repo",
            "file:///repo",
            "https://gitlab.com/a/b.git",
            "http://github.com/a/b.git",
            "git://github.com/a/b.git",
            "git@evil.com:a/b.git",
            "https://github.com.evil.com/a/b.git",
            "https://github.com@evil.com/a/b.git",
            "https://github.com:444/a/b.git",
            "ssh://root@github.com/a/b.git",
            "https://github.com/a/b.git?secret=token",
            "https://github.com/a/b.git#fragment",
            "https://github.com/a/b/",
            "https://github.com/a/b/issues/1",
            "https://github.com/a/../b/c",
            "https://github.com/a/%62",
            "https://github.com/a/..",
            "https://github.com/a/.git",
            "https://github.com/-a/b",
            "https://github.com/a-/b",
            "https://github.com/a/b\\c",
            "https://github.com/a/b\n",
            "git@github.com:/a/b.git",
        ] {
            assert_eq!(parse_remote(remote), None, "unexpected repository identity");
        }
        assert!(parse_remote(&format!("https://github.com/{}/b", "a".repeat(40))).is_none());
        assert!(parse_remote(&format!("https://github.com/a/{}", "b".repeat(101))).is_none());
    }
}
