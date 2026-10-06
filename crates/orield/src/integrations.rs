use std::time::Duration;

use anyhow::{Result, anyhow, ensure};
use reqwest::{Client, header};
use serde::Deserialize;
use url::Url;

use crate::DeviceIdentity;

#[derive(Deserialize)]
struct Repository {
    installation_id: u64,
    repository_id: u64,
    owner: String,
    name: String,
}

#[derive(Deserialize)]
struct Team {
    team_id: String,
    team_name: String,
    workspace_id: String,
}

#[derive(Deserialize)]
struct GithubIssue {
    number: u64,
    title: String,
}

#[derive(Deserialize)]
struct LinearIssue {
    identifier: String,
    title: String,
}

#[derive(Deserialize)]
struct GithubIssues {
    repository: Repository,
    issues: Vec<GithubIssue>,
}

#[derive(Deserialize)]
struct LinearIssues {
    team: Team,
    issues: Vec<LinearIssue>,
}

#[derive(Deserialize)]
struct Issues {
    github: Option<GithubIssues>,
    linear: Option<LinearIssues>,
}

pub(super) async fn run(origin: &Url, identity: &DeviceIdentity) -> Result<()> {
    let client = Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(30))
        .user_agent(concat!("orield/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|_| anyhow!("failed to initialize relay HTTP client"))?;
    let mut authorization = header::HeaderValue::from_str(&format!("Bearer {}", identity.host_token))
        .map_err(|_| anyhow!("invalid device authorization credential"))?;
    authorization.set_sensitive(true);
    let response = client
        .get(origin.join(&format!("/api/integrations/{}/issues", identity.device_id))?)
        .header(header::AUTHORIZATION, authorization)
        .send()
        .await
        .map_err(|_| anyhow!("Fetch integration issues: network request failed"))?;
    ensure!(
        response.status().is_success(),
        "Fetch integration issues: HTTP {} (response details withheld); manage connections in Oriel Web",
        response.status().as_u16()
    );
    let issues: Issues = response.json().await
        .map_err(|_| anyhow!("Fetch integration issues: invalid relay response"))?;
    if let Some(github) = issues.github {
        let repo = github.repository;
        println!("GitHub: {:?}/{:?} (repository {}, installation {})", repo.owner, repo.name, repo.repository_id, repo.installation_id);
        println!("  Recent 20 issues (pull requests excluded):");
        if github.issues.is_empty() { println!("  No issues found."); }
        for issue in github.issues { println!("  #{} {:?}", issue.number, issue.title); }
    } else {
        println!("GitHub: not connected; connect in Oriel Web");
    }
    if let Some(linear) = issues.linear {
        let team = linear.team;
        println!("Linear: {:?} (team {:?}, workspace {:?})", team.team_name, team.team_id, team.workspace_id);
        println!("  Recent 20 issues:");
        if linear.issues.is_empty() { println!("  No issues found."); }
        for issue in linear.issues { println!("  {:?} {:?}", issue.identifier, issue.title); }
    } else {
        println!("Linear: not connected; connect in Oriel Web");
    }
    Ok(())
}
