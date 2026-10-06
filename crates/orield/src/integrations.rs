use std::time::Duration;

use anyhow::{Result, anyhow, ensure};
use reqwest::{Client, header};
use serde::Deserialize;
use url::Url;

use crate::{DeviceIdentity, repository};

#[derive(Deserialize)]
struct GithubRepository {
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
    url: String,
}

#[derive(Deserialize)]
struct State {
    name: String,
    #[serde(rename = "type")]
    kind: String,
}

#[derive(Deserialize)]
struct LinearIssue {
    identifier: String,
    title: String,
    url: String,
    state: State,
    github_issues: Vec<GithubIssue>,
}

#[derive(Deserialize)]
struct LinearIssues {
    team: Team,
    issues: Vec<LinearIssue>,
}

#[derive(Deserialize)]
struct Overview {
    github: Option<GithubRepository>,
    linear: Option<Team>,
}

#[derive(Deserialize)]
struct LinkedIssues {
    repository: Option<repository::Repository>,
    linear: Option<LinearIssues>,
}

fn print_team(team: &Team) {
    println!(
        "Linear: {:?} (team {:?}, workspace {:?})",
        team.team_name, team.team_id, team.workspace_id
    );
}

pub(super) async fn run(origin: &Url, identity: &DeviceIdentity) -> Result<()> {
    let repository = repository::report_current(origin, identity).await?;
    match &repository {
        Some(repo) => println!("Working repository: {}/{}", repo.owner, repo.name),
        None => println!("Working repository: none (no GitHub origin in this directory)."),
    }
    let mut authorization =
        header::HeaderValue::from_str(&format!("Bearer {}", identity.host_token))
            .map_err(|_| anyhow!("invalid device authorization credential"))?;
    authorization.set_sensitive(true);
    let mut headers = header::HeaderMap::new();
    headers.insert(header::AUTHORIZATION, authorization);
    let client = Client::builder()
        .default_headers(headers)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(30))
        .user_agent(concat!("orield/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|_| anyhow!("failed to initialize relay HTTP client"))?;
    let response = client
        .get(origin.join(&format!("/api/integrations/{}", identity.device_id))?)
        .send()
        .await
        .map_err(|_| anyhow!("Fetch integration overview: network request failed"))?;
    ensure!(
        response.status().is_success(),
        "Fetch integration overview: HTTP {} (response details withheld); manage connections in Oriel Web",
        response.status().as_u16()
    );
    let overview: Overview = response
        .json()
        .await
        .map_err(|_| anyhow!("Fetch integration overview: invalid relay response"))?;
    if let Some(repo) = overview.github {
        println!(
            "GitHub: {:?}/{:?} (repository {}, installation {})",
            repo.owner, repo.name, repo.repository_id, repo.installation_id
        );
    } else {
        println!("GitHub: not connected; connect in Oriel Web");
    }
    let Some(team) = overview.linear else {
        println!("Linear: no team connected; connect in Oriel Web");
        return Ok(());
    };
    if repository.is_none() {
        print_team(&team);
        println!("  No working GitHub repository; linked Linear issues cannot be discovered.");
        return Ok(());
    }
    let response = client
        .get(origin.join(&format!(
            "/api/integrations/{}/linear/issues",
            identity.device_id
        ))?)
        .send()
        .await
        .map_err(|_| anyhow!("Fetch linked Linear issues: network request failed"))?;
    ensure!(
        response.status().is_success(),
        "Fetch linked Linear issues: HTTP {} (response details withheld); manage connections in Oriel Web",
        response.status().as_u16()
    );
    let linked: LinkedIssues = response
        .json()
        .await
        .map_err(|_| anyhow!("Fetch linked Linear issues: invalid relay response"))?;
    ensure!(
        linked.repository == repository,
        "Working repository changed; run integrations again"
    );
    if let Some(linear) = linked.linear {
        print_team(&linear.team);
        println!("  Linear issues formally linked to this repository's GitHub Issues:");
        if linear.issues.is_empty() {
            println!("  No linked Linear issues found.");
        }
        for issue in linear.issues {
            println!(
                "  {:?} {:?} — {:?} ({:?})",
                issue.identifier, issue.title, issue.state.name, issue.state.kind
            );
            println!("    Linear: {:?}", issue.url);
            for github in issue.github_issues {
                println!("    GitHub #{}: {:?}", github.number, github.url);
            }
        }
    } else {
        println!("Linear: no team connected; connect in Oriel Web");
    }
    Ok(())
}
