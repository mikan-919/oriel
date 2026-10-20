use std::{
    fs::{self, DirBuilder, File, OpenOptions},
    io::{IsTerminal, Read, Write},
    os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result, anyhow, bail, ensure};
use futures_util::{SinkExt, StreamExt};
use portable_pty::{CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::{Deserialize, Serialize};
use tokio::sync::{broadcast, watch};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{
        Message,
        client::IntoClientRequest,
        http::{HeaderValue, Request, header::AUTHORIZATION},
    },
};
use tracing::{error, info, warn};
use url::Url;

mod codex;
mod integrations;
mod repository;
mod verification_monitor;
mod workflow;
mod workflow_git;

#[derive(Serialize, PartialEq, Eq)]
struct DeviceIdentity {
    device_id: String,
    host_token: String,
}

fn random_hex<const N: usize>() -> Result<String> {
    let mut random = [0; N];
    getrandom::fill(&mut random).context("failed to obtain OS entropy")?;
    let mut hex = String::with_capacity(N * 2);
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    for byte in random {
        hex.push(DIGITS[(byte >> 4) as usize] as char);
        hex.push(DIGITS[(byte & 15) as usize] as char);
    }
    Ok(hex)
}

fn identity_path() -> Result<PathBuf> {
    if let Some(path) = std::env::var_os("ORIEL_IDENTITY_FILE") {
        ensure!(!path.is_empty(), "ORIEL_IDENTITY_FILE must not be empty");
        return Ok(path.into());
    }
    let config = match std::env::var_os("XDG_CONFIG_HOME").filter(|path| !path.is_empty()) {
        Some(path) => PathBuf::from(path),
        None => PathBuf::from(std::env::var_os("HOME").context("HOME is not set")?).join(".config"),
    };
    Ok(config.join("oriel/device.json"))
}

fn is_lower_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn read_identity(path: &Path) -> Result<(DeviceIdentity, bool)> {
    fn legacy_token<'de, D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Option<String>, D::Error> {
        String::deserialize(deserializer).map(Some)
    }

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct StoredIdentity {
        device_id: String,
        host_token: String,
        #[serde(default, deserialize_with = "legacy_token")]
        client_token: Option<String>,
    }

    let metadata = fs::symlink_metadata(path).context("failed to inspect device identity")?;
    ensure!(
        metadata.is_file(),
        "device identity must be a regular file, not a symlink"
    );
    ensure!(
        metadata.permissions().mode() & 0o7777 == 0o600,
        "device identity must have mode 0600"
    );
    let stored: StoredIdentity =
        serde_json::from_reader(File::open(path).context("failed to open device identity")?)
            .map_err(|_| anyhow!("invalid device identity JSON; refusing to replace it"))?;
    ensure!(
        is_lower_hex(&stored.device_id, 32)
            && is_lower_hex(&stored.host_token, 64)
            && stored
                .client_token
                .as_ref()
                .is_none_or(|token| is_lower_hex(token, 64) && token != &stored.host_token),
        "invalid device identity credentials; refusing to replace them"
    );
    Ok((
        DeviceIdentity {
            device_id: stored.device_id,
            host_token: stored.host_token,
        },
        stored.client_token.is_some(),
    ))
}

fn persist_identity(path: &Path, identity: &DeviceIdentity, replace: bool) -> Result<()> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let temporary = parent.join(format!(".device-{}.tmp", random_hex::<16>()?));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temporary)
        .context("failed to create private identity file")?;
    let publish = (|| -> Result<()> {
        file.set_permissions(fs::Permissions::from_mode(0o600))?;
        serde_json::to_writer(&mut file, identity)?;
        file.write_all(b"\n")?;
        file.sync_all()
            .context("failed to persist device identity")?;
        if replace {
            fs::rename(&temporary, path).context("failed to migrate device identity")?;
        } else {
            match fs::hard_link(&temporary, path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error).context("failed to publish device identity"),
            }
        }
        Ok(())
    })();
    let cleanup = match fs::remove_file(&temporary) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).context("failed to remove temporary identity file"),
    };
    publish?;
    cleanup?;
    File::open(parent)?
        .sync_all()
        .context("failed to persist identity directory")?;
    Ok(())
}

fn load_identity(path: &Path) -> Result<DeviceIdentity> {
    match fs::symlink_metadata(path) {
        Ok(_) => {
            let (identity, legacy) = read_identity(path)?;
            if legacy {
                persist_identity(path, &identity, true)?;
            }
            return Ok(identity);
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error).context("failed to inspect device identity"),
    }

    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(parent)
        .context("failed to create private identity directory")?;
    let identity = DeviceIdentity {
        device_id: random_hex::<16>()?,
        host_token: random_hex::<32>()?,
    };
    persist_identity(path, &identity, false)?;
    load_identity(path)
}

#[derive(Debug)]
struct WorkflowIdentityLock(File);

impl Drop for WorkflowIdentityLock {
    fn drop(&mut self) {
        // A concurrently forked child may still hold this open file description
        // until exec. Unlock explicitly so that closing our handle releases
        // ownership immediately, even while that inherited descriptor exists.
        if let Err(error) = self.0.unlock() {
            warn!(%error, "failed to release workflow identity lock");
        }
    }
}

fn lock_workflow_identity(path: &Path) -> Result<WorkflowIdentityLock> {
    // Keep the device's existing identity file locked for this process's lifetime.
    // No lock file or credential rewrite is needed.
    let file = File::open(path).context("failed to open workflow device identity")?;
    match file.try_lock() {
        Ok(()) => Ok(WorkflowIdentityLock(file)),
        Err(fs::TryLockError::WouldBlock) => {
            bail!(
                "workflow already running for this device; stop the existing orield workflow before starting another"
            )
        }
        Err(fs::TryLockError::Error(error)) => {
            Err(error).context("failed to lock workflow device identity")
        }
    }
}

fn relay_closed(
    frame: Option<tokio_tungstenite::tungstenite::protocol::CloseFrame>,
) -> anyhow::Error {
    let Some(frame) = frame else {
        return anyhow!("Relay closed the WebSocket without a status code");
    };
    // A peer's arbitrary reason may contain secrets or forged log lines.
    let reason = match frame.reason.as_str() {
        "Codex connection ended"
        | "Workflow connection ended"
        | "Codex host replaced by another connection"
        | "Workflow host replaced by another connection"
        | "Daily database read limit exceeded"
        | "Connection deadline unavailable" => frame.reason.as_str(),
        _ => "reason omitted",
    };
    anyhow!(
        "Relay closed the WebSocket (code {}: {reason})",
        u16::from(frame.code)
    )
}

fn relay_origin(value: &str) -> Result<Url> {
    ensure!(
        !value.contains('\\')
            && !value
                .bytes()
                .any(|byte| byte.is_ascii_control() || byte.is_ascii_whitespace()),
        "ORIEL_RELAY_URL must not contain whitespace, control characters or backslashes"
    );
    let authority = ["https://", "http://", "wss://", "ws://"]
        .iter()
        .find_map(|prefix| value.strip_prefix(*prefix))
        .context("ORIEL_RELAY_URL must start with https://, http://, wss:// or ws://")?;
    let authority = authority.strip_suffix('/').unwrap_or(authority);
    ensure!(
        !authority.is_empty() && !authority.contains(['/', '@', '?', '#']),
        "ORIEL_RELAY_URL must be an origin without credentials, path, query or fragment"
    );
    let mut url = Url::parse(value).context("ORIEL_RELAY_URL must be a relay base origin")?;
    ensure!(
        matches!(url.scheme(), "http" | "https" | "ws" | "wss")
            && url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && url.path() == "/"
            && url.query().is_none()
            && url.fragment().is_none(),
        "ORIEL_RELAY_URL must be an HTTP/WebSocket origin without credentials, path, query or fragment"
    );
    ensure!(
        matches!(url.scheme(), "https" | "wss")
            || matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]")),
        "plaintext relay URLs are allowed only on loopback"
    );
    let scheme = match url.scheme() {
        "wss" => "https",
        "ws" => "http",
        scheme => scheme,
    }
    .to_string();
    url.set_scheme(&scheme)
        .map_err(|_| anyhow!("invalid relay scheme"))?;
    Ok(url)
}

fn host_request(origin: &Url, identity: &DeviceIdentity) -> Result<Request<()>> {
    let mut url = origin.clone();
    url.set_scheme(if origin.scheme() == "https" {
        "wss"
    } else {
        "ws"
    })
    .map_err(|_| anyhow!("invalid relay scheme"))?;
    url.set_path(&format!("/device/{}/host", identity.device_id));
    let mut request = url.as_str().into_client_request()?;
    let mut authorization = HeaderValue::from_str(&format!("Bearer {}", identity.host_token))?;
    authorization.set_sensitive(true);
    request.headers_mut().insert(AUTHORIZATION, authorization);
    Ok(request)
}

#[derive(Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum PairStart {
    Paired,
    Pending { url: String, expires_at: u64 },
}

#[derive(Deserialize)]
struct PairAccount {
    id: String,
    display_name: String,
}

#[derive(Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum PairStatus {
    Waiting,
    Confirmation { user: PairAccount },
    Paired,
    Expired,
}

fn pairing_url(value: &str) -> Result<Url> {
    let (origin, fragment) = value
        .split_once('#')
        .context("invalid browser pairing URL")?;
    ensure!(
        origin.starts_with("https://") || origin.starts_with("http://"),
        "browser pairing requires an HTTP origin"
    );
    let mut url = relay_origin(origin)?;
    ensure!(
        fragment
            .strip_prefix("pair=")
            .is_some_and(|token| is_lower_hex(token, 64)),
        "invalid browser pairing URL"
    );
    url.set_fragment(Some(fragment));
    Ok(url)
}

fn device_name(identity: &DeviceIdentity) -> String {
    std::env::var("HOSTNAME")
        .ok()
        .or_else(|| fs::read_to_string("/etc/hostname").ok())
        .filter(|name| !name.trim().is_empty())
        .map(|name| {
            name.trim()
                .chars()
                .filter(|character| !character.is_control())
                .take(128)
                .collect()
        })
        .unwrap_or_else(|| format!("Oriel-{}", &identity.device_id[..8]))
}

fn unix_seconds() -> Result<u64> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .context("system clock is before the Unix epoch")?
        .as_secs())
}

async fn open_browser(url: &Url) -> Result<bool> {
    let browser_url = url.to_string();
    tokio::task::spawn_blocking(move || {
        let opener = if cfg!(target_os = "macos") {
            "open"
        } else {
            "xdg-open"
        };
        Command::new(opener)
            .arg(browser_url)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    })
    .await
    .context("browser opener task failed")
}

fn confirm_account(tty: &mut File, account: &PairAccount) -> Result<bool> {
    ensure!(is_lower_hex(&account.id, 32), "invalid pairing account ID");
    writeln!(tty, "\nAuthorize this device for the following account?")?;
    writeln!(tty, "Account name: {:?}", account.display_name)?;
    writeln!(tty, "Account ID:   {}", account.id)?;
    write!(
        tty,
        "Check both against your browser. Type yes to authorize; anything else cancels: "
    )?;
    tty.flush()?;
    let mut answer = Vec::with_capacity(4);
    let mut byte = [0];
    loop {
        if tty.read(&mut byte)? == 0 {
            return Ok(false);
        }
        if byte[0] == b'\n' {
            return Ok(answer == b"yes");
        }
        if answer.len() == 16 {
            return Ok(false);
        }
        answer.push(byte[0]);
    }
}

async fn pair_device(
    client: &reqwest::Client,
    origin: &Url,
    identity: &DeviceIdentity,
    url: &str,
    expires_at: u64,
) -> Result<()> {
    let url = pairing_url(url)?;
    ensure!(unix_seconds()? < expires_at, "pairing URL has expired");
    let mut tty = OpenOptions::new()
        .read(true)
        .write(true)
        .open("/dev/tty")
        .context("pairing requires a controlling terminal for local account confirmation")?;
    ensure!(
        tty.is_terminal(),
        "pairing requires an interactive controlling terminal"
    );
    writeln!(
        tty,
        "Pair device {} in your browser:\n{url}",
        identity.device_id
    )?;
    writeln!(
        tty,
        "This link expires in {} seconds. Browser approval still requires local confirmation.",
        expires_at.saturating_sub(unix_seconds()?)
    )?;
    tty.flush()?;
    let opened = open_browser(&url).await?;
    if !opened {
        writeln!(
            tty,
            "Could not open a browser automatically; open the pairing URL above."
        )?;
        tty.flush()?;
    }

    let status_url = origin.join(&format!("/api/pair/{}/status", identity.device_id))?;
    loop {
        ensure!(unix_seconds()? < expires_at, "pairing URL has expired");
        let response = client.get(status_url.clone()).send().await?;
        let status: PairStatus = pairing_response(response)
            .await?
            .json()
            .await
            .context("invalid pairing status response")?;
        match status {
            PairStatus::Waiting => tokio::time::sleep(Duration::from_secs(1)).await,
            PairStatus::Expired => bail!("pairing URL has expired"),
            PairStatus::Paired => return Ok(()),
            PairStatus::Confirmation { user } => {
                let user_id = user.id.clone();
                let approved =
                    tokio::task::spawn_blocking(move || confirm_account(&mut tty, &user))
                        .await
                        .context("local account confirmation task failed")??;
                ensure!(
                    approved,
                    "pairing cancelled; local account confirmation was not granted"
                );
                let response = client
                    .post(origin.join(&format!("/api/pair/{}/confirm", identity.device_id))?)
                    .json(&serde_json::json!({ "user_id": user_id }))
                    .send()
                    .await?;
                let confirmed: PairStatus = pairing_response(response)
                    .await?
                    .json()
                    .await
                    .context("invalid pairing confirmation response")?;
                ensure!(
                    matches!(confirmed, PairStatus::Paired),
                    "pairing was not confirmed"
                );
                return Ok(());
            }
        }
    }
}

async fn ensure_paired(origin: &Url, identity: &DeviceIdentity) -> Result<()> {
    let mut authorization =
        reqwest::header::HeaderValue::from_str(&format!("Bearer {}", identity.host_token))?;
    authorization.set_sensitive(true);
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(reqwest::header::AUTHORIZATION, authorization);
    let client = reqwest::Client::builder()
        .default_headers(headers)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(15))
        .build()
        .context("failed to initialize pairing HTTP client")?;
    let response = client
        .post(origin.join("/api/pair/start")?)
        .json(
            &serde_json::json!({ "device_id": identity.device_id, "name": device_name(identity) }),
        )
        .send()
        .await?;
    let start: PairStart = pairing_response(response)
        .await?
        .json()
        .await
        .context("invalid pairing start response")?;
    let PairStart::Pending { url, expires_at } = start else {
        return Ok(());
    };
    let result = pair_device(&client, origin, identity, &url, expires_at).await;
    if result.is_err() {
        let cancelled = client
            .post(origin.join(&format!("/api/pair/{}/cancel", identity.device_id))?)
            .json(&serde_json::json!({}))
            .send()
            .await;
        if !matches!(cancelled, Ok(response) if response.status().is_success()) {
            warn!("could not cancel pending pairing; its URL will expire");
        }
    }
    result
}

async fn pairing_response(mut response: reqwest::Response) -> Result<reqwest::Response> {
    if response.status() == reqwest::StatusCode::SERVICE_UNAVAILABLE {
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await? {
            if body.len() + chunk.len() > 4096 {
                break;
            }
            body.extend_from_slice(&chunk);
        }
        if serde_json::from_slice::<serde_json::Value>(&body)
            .ok()
            .is_some_and(|value| value["code"] == "durable_objects_daily_read_limit")
        {
            bail!(
                "Relay database daily read limit exceeded; the Cloudflare free limit resets at 00:00 UTC. Existing device registration is preserved; retry after the reset."
            );
        }
    }
    response.error_for_status().map_err(Into::into)
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
enum TerminalState {
    Running,
    Exited { code: u32, signal: Option<String> },
    WaitFailed,
}

async fn terminal_exit(state: &mut watch::Receiver<TerminalState>) -> TerminalState {
    loop {
        let value = state.borrow_and_update().clone();
        if !matches!(value, TerminalState::Running) {
            return value;
        }
        if state.changed().await.is_err() {
            return TerminalState::WaitFailed;
        }
    }
}

struct Terminal {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    output: broadcast::Sender<Vec<u8>>,
    state: watch::Receiver<TerminalState>,
    output_done: watch::Receiver<bool>,
}

type TerminalHandle = Arc<Terminal>;

fn main() -> Result<()> {
    let runtime = tokio::runtime::Runtime::new()?;
    let result = runtime.block_on(run());
    runtime.shutdown_timeout(Duration::from_secs(1));
    result
}

async fn run() -> Result<()> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if let [command, socket, operation] = args.as_slice()
        && command == "__workflow-credential"
    {
        return workflow_git::credential_helper(
            Path::new(socket),
            operation
                .to_str()
                .context("invalid Git credential operation")?,
        );
    }
    if args
        .first()
        .is_some_and(|arg| arg == "__verification-monitor")
    {
        return verification_monitor::run(&args[1..]);
    }
    let mode = match args.as_slice() {
        [] => "terminal",
        [arg] if arg == "--help" || arg == "-h" => {
            println!(
                "{}",
                concat!(
                    "Usage: orield [--help | integrations | codex | workflow [--once]]\n\n",
                    "Pair this device with a Passkey account, then run Codex in a PTY.\n",
                    "First start opens a browser and requires explicit local account confirmation.\n",
                    "Already paired devices reconnect automatically without a pairing prompt.\n",
                    "Keep the identity file private; it contains the persistent host secret.\n\n",
                    "Connect GitHub and Linear in Oriel Web; connections are shared by your devices.\n",
                    "integrations: show connected GitHub selection and Linear issues linked to\n",
                    "GitHub Issues in the working directory's GitHub origin repository.\n",
                    "Only normalized repository names are reported; no jobs are started or approved.\n",
                    "Provider credentials stay encrypted in relay; no local credential store is needed.\n\n",
                    "workflow: explicitly start GitHub WHAT → read-only Linear HOW planning;\n",
                    "human Todo plus immutable target .oriel.yaml autonomous worktree opt-in\n",
                    "and configured verification are required before code executes.\n",
                    "Failed checks return diagnostics to Codex for up to two repairs; all checks rerun.\n",
                    "Unresolved failures return HOW to Triage with reasons and require human review.\n",
                    "Target updates checkpoint unfinished local work before merging; conflicts retain that checkpoint.\n",
                    "Verified canonical branches are pushed with CAS; PR review fixes resume\n",
                    "the same branch. Only an observed human merge moves Linear to Done.\n",
                    "--once scans once; continuous mode scans immediately, then every 15s.\n",
                    "Only one workflow/codex process may run per device; a second start exits before connecting.\n",
                    "Interrupted/unpushed work is preserved under $XDG_STATE_HOME/oriel/workflow\n",
                    "(fallback $HOME/.local/state/oriel/workflow); transcripts remain private.\n",
                    "codex: connect Codex app-server to the Codex page in Oriel Web.\n",
                    "The Web page manages conversations, models, reviews, questions and approvals.\n",
                    "workflow also exposes its active Codex execution through that page.\n\n",
                    "Identity: $XDG_CONFIG_HOME/oriel/device.json, falling back to\n",
                    "$HOME/.config/oriel/device.json; ORIEL_IDENTITY_FILE overrides the path.\n",
                    "Created files are mode 0600 and new directories private. Invalid identities are never reset.\n",
                    "ORIEL_RELAY_URL: https/http or wss/ws base origin, default\n",
                    "https://oriel-relay.mikan-919.workers.dev.\n",
                    "Paths, credentials, queries and fragments are forbidden; plaintext is allowed\n",
                    "only for localhost, 127.0.0.1 and [::1]."
                )
            );
            return Ok(());
        }
        [arg] if arg == "integrations" => "integrations",
        [arg] if arg == "codex" => "codex",
        [arg] if arg == "workflow" => "workflow",
        [arg, once] if arg == "workflow" && once == "--once" => "once",
        _ => bail!("usage: orield [--help | integrations | codex | workflow [--once]]"),
    };
    let identity_file = identity_path()?;
    let identity = load_identity(&identity_file)?;
    let _workflow_owner = if matches!(mode, "workflow" | "once" | "codex") {
        Some(lock_workflow_identity(&identity_file)?)
    } else {
        None
    };
    let relay_value = match std::env::var("ORIEL_RELAY_URL") {
        Ok(value) => value,
        Err(std::env::VarError::NotPresent) => {
            "https://oriel-relay.mikan-919.workers.dev".to_string()
        }
        Err(_) => bail!("ORIEL_RELAY_URL must be valid UTF-8"),
    };
    let relay_url = relay_origin(&relay_value)?;

    rustls::crypto::ring::default_provider()
        .install_default()
        .expect("failed to install rustls crypto provider");

    tracing_subscriber::fmt::init();
    ensure_paired(&relay_url, &identity).await?;
    if mode == "integrations" {
        return integrations::run(&relay_url, &identity).await;
    }
    repository::report_current(&relay_url, &identity).await?;
    if matches!(mode, "codex" | "workflow" | "once") {
        let cwd = std::env::current_dir()?;
        let project = match workflow_git::text(&cwd, &["rev-parse", "--show-toplevel"]).await {
            Ok(path) => PathBuf::from(path),
            Err(error) if mode != "codex" => return Err(error),
            Err(_) => cwd,
        };
        let mut codex_control = codex::start(&relay_url, &identity, &project).await?;
        if mode == "codex" {
            println!("Codex is available from the Codex page in Oriel Web. Ctrl-C to stop.");
            tokio::select! { result = &mut codex_control.task => return result.context("Codex control task failed")?, _ = tokio::signal::ctrl_c() => {} }
            codex_control.stop().await?;
            return Ok(());
        }
        let workflow = workflow::run(&relay_url, &identity, mode == "once");
        tokio::pin!(workflow);
        let result = tokio::select! {
            result = &mut workflow => {
                if let Err(error) = codex_control.stop().await {
                    tracing::warn!("Codex consultation shutdown failed: {error:#}");
                }
                result
            }
            control = &mut codex_control.task => {
                match control {
                    Ok(Ok(())) => tracing::warn!("Codex consultation stopped; workflow continues without Web control"),
                    Ok(Err(error)) => tracing::warn!("Codex consultation unavailable; workflow continues without Web control: {error:#}"),
                    Err(error) => tracing::warn!("Codex control task failed; workflow continues without Web control: {error}"),
                }
                workflow.await
            }
        };
        return result;
    }

    let terminal = spawn_terminal("codex")?;

    info!("orield started");
    info!("device: {}", identity.device_id);
    info!("relay: {relay_url}");

    let mut state = terminal.state.clone();
    loop {
        if !matches!(*state.borrow(), TerminalState::Running) {
            return Ok(());
        }
        info!("connecting to relay");

        match tokio::select! { biased; _ = terminal_exit(&mut state) => return Ok(()), result = connect_async(host_request(&relay_url, &identity)?) => result }
        {
            Ok((socket, _)) => {
                info!("connected to relay");

                if let Err(error) = handle_relay(socket, terminal.clone()).await {
                    warn!("relay connection ended: {error}");
                }
            }

            Err(error) => {
                warn!("failed to connect to relay: {error}");
            }
        }

        tokio::select! { biased; _ = terminal_exit(&mut state) => return Ok(()), _ = tokio::time::sleep(Duration::from_secs(1)) => {} }
    }
}

fn spawn_terminal(command: &str) -> Result<TerminalHandle> {
    let pty_system = native_pty_system();

    let pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .context("failed to create PTY")?;

    let cmd = CommandBuilder::new(command);

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .context("failed to spawn command")?;

    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .context("failed to clone PTY reader")?;

    let writer = pair
        .master
        .take_writer()
        .context("failed to take PTY writer")?;

    let (output_tx, _) = broadcast::channel::<Vec<u8>>(256);

    let (state_tx, state) = watch::channel(TerminalState::Running);
    let (output_done_tx, output_done) = watch::channel(false);
    let terminal = Arc::new(Terminal {
        master: Mutex::new(pair.master),
        writer: Mutex::new(writer),
        output: output_tx.clone(),
        state,
        output_done,
    });

    thread::spawn(move || {
        let mut buffer = [0_u8; 8192];

        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,

                Ok(size) => {
                    let _ = output_tx.send(buffer[..size].to_vec());
                }

                Err(error) => {
                    error!("PTY read failed: {error}");
                    break;
                }
            }
        }
        output_done_tx.send_replace(true);
    });

    thread::spawn(move || match child.wait() {
        Ok(status) => {
            info!("child exited: {status:?}");
            state_tx.send_replace(TerminalState::Exited {
                code: status.exit_code(),
                signal: status.signal().map(str::to_owned),
            });
        }

        Err(error) => {
            error!("failed waiting for child: {error}");
            state_tx.send_replace(TerminalState::WaitFailed);
        }
    });

    Ok(terminal)
}

async fn handle_relay<S>(
    socket: tokio_tungstenite::WebSocketStream<S>,
    terminal: TerminalHandle,
) -> Result<()>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let mut deadline = tokio::time::Instant::now() + Duration::from_secs(45);
    let (mut sender, mut receiver) = socket.split();

    let mut output = terminal.output.subscribe();
    let mut pending = Vec::new();
    let mut flush = tokio::time::interval(std::time::Duration::from_millis(200));
    flush.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut keepalive = tokio::time::interval(std::time::Duration::from_secs(10));

    let mut state = terminal.state.clone();
    let result = {
        let running = async {
            loop {
                tokio::select! {
                    _ = tokio::time::sleep_until(deadline) => bail!("relay keepalive response timed out"),
                    _ = keepalive.tick() => sender.send(Message::Text("oriel:ping".into())).await?,
                    _ = flush.tick(), if !pending.is_empty() => {
                        sender.send(Message::Binary(std::mem::take(&mut pending).into())).await?;
                    },
                    message = receiver.next() => {
                        match message {
                            Some(Ok(Message::Binary(data))) => {
                                let terminal = terminal.clone();
                                let result = tokio::task::spawn_blocking(move || {
                                    if !matches!(*terminal.state.borrow(), TerminalState::Running) { return Ok(()); }
                                    let mut writer = terminal
                                        .writer
                                        .lock()
                                        .expect(
                                            "PTY writer mutex poisoned"
                                        );

                                    writer
                                        .write_all(&data)
                                        .and_then(|_| writer.flush())
                                }).await?;

                                result.context(
                                    "failed writing to PTY"
                                )?;
                            }

                            Some(Ok(Message::Text(text))) => {
                                if text == "oriel:pong" {
                                    deadline = tokio::time::Instant::now() + Duration::from_secs(45);
                                    continue;
                                }
                                if text.starts_with("oriel-heartbeat:") {
                                    sender.send(Message::Text(text)).await?;
                                    continue;
                                }
                                if let Some((cols, rows)) =
                                    parse_resize(text.as_str())
                                {
                                    let terminal = terminal.clone();
                                    let result = tokio::task::spawn_blocking(move || {
                                        if !matches!(*terminal.state.borrow(), TerminalState::Running) { return Ok(()); }
                                        let master = terminal
                                            .master
                                            .lock()
                                            .expect(
                                                "PTY master mutex poisoned"
                                            );

                                        master.resize(PtySize {
                                            rows,
                                            cols,
                                            pixel_width: 0,
                                            pixel_height: 0,
                                        })
                                    }).await?;

                                    result.context(
                                        "failed resizing PTY"
                                    )?;
                                }
                            }

                            Some(Ok(Message::Ping(data))) => {
                                sender
                                    .send(Message::Pong(data))
                                    .await?;
                            }

                            Some(Ok(Message::Pong(_))) => {}

                            Some(Ok(Message::Close(_))) | None => {
                                break;
                            }

                            Some(Ok(_)) => {}

                            Some(Err(error)) => {
                                return Err(error.into());
                            }
                        }
                    }

                    data = output.recv() => {
                        match data {
                            Ok(data) => {
                                pending.extend(data);
                                if pending.len() >= 65_536 {
                                    sender.send(Message::Binary(std::mem::take(&mut pending).into())).await?;
                                }
                            }

                            Err(
                                broadcast::error::RecvError::Lagged(count)
                            ) => {
                                warn!(
                                    "relay lagged by {count} terminal messages"
                                );
                            }

                            Err(
                                broadcast::error::RecvError::Closed
                            ) => {
                                break;
                            }
                        }
                    }
                }
            }

            Ok::<(), anyhow::Error>(())
        };
        tokio::select! {
            biased;
            exit = terminal_exit(&mut state) => Some(exit),
            result = running => { result?; None }
        }
    };
    if let Some(exit) = result {
        // Bound draining and notification even when the peer stops reading.
        let _ = tokio::time::timeout(Duration::from_secs(2), async {
            if !pending.is_empty() {
                sender
                    .send(Message::Binary(std::mem::take(&mut pending).into()))
                    .await?;
            }
            let mut done = terminal.output_done.clone();
            loop {
                while let Ok(data) = output.try_recv() {
                    sender.send(Message::Binary(data.into())).await?;
                }
                if *done.borrow() {
                    break;
                }
                tokio::select! {
                    _ = done.changed() => {},
                    data = output.recv() => {
                        if let Ok(data) = data { sender.send(Message::Binary(data.into())).await?; }
                    }
                }
            }
            Ok::<(), anyhow::Error>(())
        })
        .await;
        let notice = format!("oriel-terminal-exit:{}", serde_json::to_string(&exit)?);
        let _ = tokio::time::timeout(
            Duration::from_secs(2),
            sender.send(Message::Text(notice.into())),
        )
        .await;
        let _ = tokio::time::timeout(Duration::from_secs(1), sender.close()).await;
    }

    Ok(())
}

fn parse_resize(message: &str) -> Option<(u16, u16)> {
    let rest = message.strip_prefix("resize:")?;
    let (cols, rows) = rest.split_once(':')?;

    Some((cols.parse().ok()?, rows.parse().ok()?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Clone, Default)]
    struct RecordingWriter(Arc<Mutex<Vec<u8>>>);

    impl Write for RecordingWriter {
        fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(data);
            Ok(data.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[tokio::test]
    async fn exit_is_retained_before_subscription_and_while_waiting() {
        for exit in [
            TerminalState::Exited {
                code: 0,
                signal: None,
            },
            TerminalState::Exited {
                code: 7,
                signal: Some("TERM".into()),
            },
            TerminalState::WaitFailed,
        ] {
            let (tx, mut rx) = watch::channel(TerminalState::Running);
            tx.send_replace(exit.clone());
            let observed = terminal_exit(&mut rx).await;
            assert_eq!(
                serde_json::to_value(observed).unwrap(),
                serde_json::to_value(&exit).unwrap()
            );
            let mut later = tx.subscribe();
            assert!(!matches!(
                terminal_exit(&mut later).await,
                TerminalState::Running
            ));
        }
        let (tx, mut rx) = watch::channel(TerminalState::Running);
        let waiting = tokio::spawn(async move { terminal_exit(&mut rx).await });
        tokio::task::yield_now().await;
        tx.send_replace(TerminalState::WaitFailed);
        assert!(matches!(waiting.await.unwrap(), TerminalState::WaitFailed));
    }

    #[tokio::test]
    async fn relay_reports_even_an_exit_before_subscription() {
        for exit in [
            TerminalState::Exited {
                code: 0,
                signal: None,
            },
            TerminalState::Exited {
                code: 3,
                signal: None,
            },
            TerminalState::WaitFailed,
        ] {
            let (mut terminal, _) = test_terminal();
            let (_tx, state) = watch::channel(exit.clone());
            Arc::get_mut(&mut terminal).unwrap().state = state;
            let (mut peer, task) = relay_connection(terminal).await;
            let frame = peer.next().await.unwrap().unwrap();
            assert_eq!(
                frame,
                Message::Text(
                    format!(
                        "oriel-terminal-exit:{}",
                        serde_json::to_string(&exit).unwrap()
                    )
                    .into()
                )
            );
            tokio::time::timeout(Duration::from_secs(2), task)
                .await
                .unwrap()
                .unwrap()
                .unwrap();
        }
    }

    #[tokio::test]
    async fn exit_interrupts_a_stalled_socket() {
        let (mut terminal, _) = test_terminal();
        let (tx, state) = watch::channel(TerminalState::Running);
        Arc::get_mut(&mut terminal).unwrap().state = state;
        let (_peer, task) = relay_connection(terminal.clone()).await;
        // Fill the duplex socket while the peer does not read.
        for _ in 0..64 {
            let _ = terminal.output.send(vec![0; 8192]);
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!task.is_finished());
        tx.send_replace(TerminalState::Exited {
            code: 0,
            signal: None,
        });
        tokio::time::timeout(Duration::from_secs(7), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
    }

    type TestSocket = tokio_tungstenite::WebSocketStream<tokio::io::DuplexStream>;

    fn test_terminal() -> (TerminalHandle, RecordingWriter) {
        let pair = native_pty_system().openpty(PtySize::default()).unwrap();
        let writer = RecordingWriter::default();
        let (output, _) = broadcast::channel(16);
        let (state_tx, state) = watch::channel(TerminalState::Running);
        std::mem::forget(state_tx);
        let terminal = Arc::new(Terminal {
            master: Mutex::new(pair.master),
            writer: Mutex::new(Box::new(writer.clone())),
            output,
            state,
            output_done: watch::channel(true).1,
        });
        (terminal, writer)
    }

    async fn relay_connection(
        terminal: TerminalHandle,
    ) -> (TestSocket, tokio::task::JoinHandle<Result<()>>) {
        use tokio_tungstenite::tungstenite::protocol::Role;
        let (host, peer) = tokio::io::duplex(65536);
        let host = TestSocket::from_raw_socket(host, Role::Client, None).await;
        let peer = TestSocket::from_raw_socket(peer, Role::Server, None).await;
        let task = tokio::spawn(handle_relay(host, terminal));
        (peer, task)
    }

    // The echo confirms that all preceding frames have been processed, without
    // refreshing the pong deadline. Drain outgoing traffic to keep sends writable.
    async fn relay_barrier(peer: &mut TestSocket) {
        peer.send(Message::Text("oriel-heartbeat:test".into()))
            .await
            .unwrap();
        loop {
            if peer.next().await.unwrap().unwrap() == Message::Text("oriel-heartbeat:test".into()) {
                break;
            }
        }
    }

    async fn assert_relay_timeout(task: tokio::task::JoinHandle<Result<()>>) {
        let error = task.await.unwrap().unwrap_err();
        assert!(error.to_string().contains("keepalive response timed out"));
    }

    #[tokio::test(start_paused = true)]
    async fn relay_times_out_without_pong_and_reuses_terminal_without_replay() {
        let (terminal, writer) = test_terminal();
        let (mut peer, task) = relay_connection(terminal.clone()).await;
        relay_barrier(&mut peer).await;
        for _ in 0..4 {
            tokio::time::advance(Duration::from_secs(10)).await;
            peer.send(Message::Binary(b"input".to_vec().into()))
                .await
                .unwrap();
            for text in ["resize:80:24", "oriel:pong-extra", "other"] {
                peer.send(Message::Text(text.into())).await.unwrap();
            }
            peer.send(Message::Ping(vec![1].into())).await.unwrap();
            peer.send(Message::Pong(vec![2].into())).await.unwrap();
            terminal.output.send(b"output".to_vec()).unwrap();
            relay_barrier(&mut peer).await;
            assert!(!task.is_finished());
        }
        tokio::time::advance(Duration::from_secs(4)).await;
        relay_barrier(&mut peer).await;
        assert!(!task.is_finished());
        tokio::time::advance(Duration::from_secs(1)).await;
        assert_relay_timeout(task).await;
        assert_eq!(*writer.0.lock().unwrap(), b"inputinputinputinput");

        // The production caller waits one second, then passes the same handle.
        tokio::time::sleep(Duration::from_secs(1)).await;
        let (mut peer, task) = relay_connection(terminal).await;
        relay_barrier(&mut peer).await;
        tokio::time::advance(Duration::from_secs(44)).await;
        relay_barrier(&mut peer).await;
        assert!(!task.is_finished());
        assert_eq!(*writer.0.lock().unwrap(), b"inputinputinputinput");
        tokio::time::advance(Duration::from_secs(1)).await;
        assert_relay_timeout(task).await;
    }

    #[tokio::test(start_paused = true)]
    async fn relay_pong_refreshes_deadline_from_receive_time_without_output() {
        let (terminal, _) = test_terminal();
        let (mut peer, task) = relay_connection(terminal).await;
        relay_barrier(&mut peer).await;
        for _ in 0..3 {
            tokio::time::advance(Duration::from_secs(30)).await;
            peer.send(Message::Text("oriel:pong".into())).await.unwrap();
            relay_barrier(&mut peer).await;
            assert!(!task.is_finished());
        }
        tokio::time::advance(Duration::from_secs(44)).await;
        relay_barrier(&mut peer).await;
        assert!(!task.is_finished());
        tokio::time::advance(Duration::from_secs(1)).await;
        assert_relay_timeout(task).await;
    }

    #[test]
    fn relay_close_diagnostics_keep_codes_and_known_reasons_without_peer_content() {
        use tokio_tungstenite::tungstenite::protocol::{CloseFrame, frame::coding::CloseCode};
        for reason in [
            "Codex host replaced by another connection",
            "Workflow host replaced by another connection",
        ] {
            let error = relay_closed(Some(CloseFrame {
                code: CloseCode::Policy,
                reason: reason.into(),
            }));
            assert!(error.to_string().contains("1008"));
            assert!(error.to_string().contains(reason));
        }
        let error = relay_closed(Some(CloseFrame {
            code: CloseCode::Error,
            reason: "private-token\nforged-log".into(),
        }));
        assert!(error.to_string().contains("1011"));
        assert!(!error.to_string().contains("private-token"));
        assert!(!error.to_string().contains('\n'));
        assert!(
            relay_closed(None)
                .to_string()
                .contains("without a status code")
        );
    }

    #[tokio::test]
    async fn pairing_quota_error_preserves_registration_and_omits_untrusted_body() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            for body in [
                r#"{"code":"durable_objects_daily_read_limit","error":"private-token\nforged-log"}"#,
                r#"{"error":"private-token"}"#,
            ] {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = [0; 2048];
                assert!(socket.read(&mut request).await.unwrap() > 0);
                socket.write_all(format!("HTTP/1.1 503 Service Unavailable\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
            }
        });
        let client = reqwest::Client::new();
        let error = pairing_response(client.get(&url).send().await.unwrap())
            .await
            .unwrap_err();
        assert!(error.to_string().contains("00:00 UTC"));
        assert!(error.to_string().contains("registration is preserved"));
        assert!(!error.to_string().contains("private-token"));
        let error = pairing_response(client.get(&url).send().await.unwrap())
            .await
            .unwrap_err();
        assert!(error.to_string().contains("503"));
        assert!(!error.to_string().contains("private-token"));
        server.await.unwrap();
    }
    use std::sync::Barrier;

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "orield-identity-test-{}",
                random_hex::<16>().unwrap()
            ));
            DirBuilder::new().mode(0o700).create(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[test]
    fn workflow_identity_lock_blocks_duplicate_runs_and_releases_on_exit() {
        let directory = TestDirectory::new();
        let path = directory.0.join("oriel/device.json");
        let identity = load_identity(&path).unwrap();
        let original = fs::read(&path).unwrap();
        let owner = lock_workflow_identity(&path).unwrap();
        let error = lock_workflow_identity(&path).unwrap_err();
        assert!(error.to_string().contains("workflow already running"));
        // Ordinary daemon/terminal identity reads remain possible.
        assert!(load_identity(&path).unwrap() == identity);
        let other = directory.0.join("other/device.json");
        load_identity(&other).unwrap();
        let other_owner = lock_workflow_identity(&other).unwrap();
        assert_eq!(fs::read(&path).unwrap(), original);
        // A duplicate shares the open file description, just like a descriptor
        // inherited by a concurrent fork before the child has called exec.
        let inherited = owner.0.try_clone().unwrap();
        drop(owner);
        let replacement = lock_workflow_identity(&path).unwrap();
        assert!(lock_workflow_identity(&path).is_err());
        drop(inherited);
        assert!(lock_workflow_identity(&path).is_err());
        drop(replacement);
        // Releasing one identity must not unlock a different device's workflow.
        assert!(lock_workflow_identity(&other).is_err());
        let final_owner = lock_workflow_identity(&path).unwrap();
        assert_eq!(fs::read(&path).unwrap(), original);
        drop(final_owner);
        drop(other_owner);
        assert!(lock_workflow_identity(&other).is_ok());
    }

    #[test]
    fn identities_persist_are_unique_and_private() {
        let directory = TestDirectory::new();
        let path = directory.0.join("oriel/device.json");
        let first = load_identity(&path).unwrap();
        assert!(first == load_identity(&path).unwrap());
        let second = load_identity(&directory.0.join("second/device.json")).unwrap();
        assert!(first.device_id != second.device_id);
        assert!(first.host_token != second.host_token);
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(path.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
    }

    #[test]
    fn legacy_identity_migrates_without_rotating_host_credentials() {
        let directory = TestDirectory::new();
        let path = directory.0.join("device.json");
        let device_id = "a".repeat(32);
        let host_token = "1".repeat(64);
        let legacy = serde_json::json!({
            "device_id": device_id,
            "host_token": host_token,
            "client_token": "2".repeat(64),
        });
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)
            .unwrap();
        serde_json::to_writer(&mut file, &legacy).unwrap();
        file.sync_all().unwrap();
        drop(file);
        let migrated = load_identity(&path).unwrap();
        assert_eq!(migrated.device_id, device_id);
        assert_eq!(migrated.host_token, host_token);
        let stored: serde_json::Value =
            serde_json::from_reader(File::open(&path).unwrap()).unwrap();
        assert!(stored.get("client_token").is_none());
        assert!(migrated == load_identity(&path).unwrap());
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o7777,
            0o600
        );
    }

    #[test]
    fn invalid_existing_identity_is_never_replaced_or_logged() {
        let directory = TestDirectory::new();
        let path = directory.0.join("device.json");
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)
            .unwrap();
        for invalid in [
            "{}".to_string(),
            "{\"device_id\":".to_string(),
            format!(
                "{{\"device_id\":\"{}\",\"host_token\":\"{}\",\"client_token\":\"{}\"}}",
                "A".repeat(32),
                "1".repeat(64),
                "2".repeat(64)
            ),
            format!(
                "{{\"device_id\":\"{}\",\"host_token\":\"{}\",\"client_token\":\"{}\"}}",
                "a".repeat(32),
                "1".repeat(64),
                "1".repeat(64)
            ),
            format!(
                "{{\"device_id\":\"{}\",\"host_token\":\"{}\",\"client_token\":null}}",
                "a".repeat(32),
                "1".repeat(64)
            ),
            format!(
                "{{\"device_id\":\"{}\",\"host_token\":\"{}\"}}",
                "a".repeat(32),
                "short-secret"
            ),
            format!("{{\"unexpected-secret-{}\":0}}", "a".repeat(64)),
        ] {
            file.set_len(0).unwrap();
            use std::io::{Seek, SeekFrom};
            file.seek(SeekFrom::Start(0)).unwrap();
            file.write_all(invalid.as_bytes()).unwrap();
            let error = match load_identity(&path) {
                Ok(_) => panic!("invalid identity accepted"),
                Err(error) => error,
            };
            assert!(!format!("{error:#}").contains(&"a".repeat(64)));
            assert_eq!(fs::read_to_string(&path).unwrap(), invalid);
        }
    }

    #[test]
    fn existing_public_or_symlink_identity_is_rejected() {
        let directory = TestDirectory::new();
        let path = directory.0.join("device.json");
        load_identity(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(load_identity(&path).is_err());
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        let link = directory.0.join("link.json");
        std::os::unix::fs::symlink(&path, &link).unwrap();
        assert!(load_identity(&link).is_err());
    }

    #[test]
    fn concurrent_first_starts_share_one_identity() {
        let directory = TestDirectory::new();
        let path = directory.0.join("oriel/device.json");
        let barrier = Arc::new(Barrier::new(8));
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let path = path.clone();
                let barrier = barrier.clone();
                thread::spawn(move || {
                    barrier.wait();
                    load_identity(&path).unwrap()
                })
            })
            .collect();
        let identities: Vec<_> = threads
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .collect();
        assert!(identities.iter().all(|identity| identity == &identities[0]));
        assert!(load_identity(&path).unwrap() == identities[0]);
    }

    #[test]
    fn relay_origins_enforce_transport_and_secret_boundaries() {
        for allowed in [
            "ws://localhost:8787",
            "ws://127.0.0.1:8787",
            "ws://[::1]:8787",
            "wss://relay.example.com",
            "https://relay.example.com",
            "http://localhost:8787",
            "http://127.0.0.1:8787",
            "http://[::1]:8787",
        ] {
            assert!(relay_origin(allowed).is_ok(), "{allowed}");
        }
        for forbidden in [
            "ws://relay.example.com",
            "ws://192.168.1.1",
            "ws://127.0.0.2",
            "ws://localhost.example.com",
            "ws://[::2]",
            "http://relay.example.com",
            "http://192.168.1.1",
            "http://127.0.0.2",
            "http://localhost.example.com",
            "https://user:secret@relay.example.com",
            "https://relay.example.com/api",
            "https://relay.example.com?token=secret",
            "https://relay.example.com#secret",
            "wss://user:secret@relay.example.com",
            "wss://relay.example.com/host",
            "wss://relay.example.com?token=secret",
            "wss://relay.example.com#secret",
            " wss://relay.example.com",
            "wss://relay.exa\nmple.com",
            "wss:\\\\relay.example.com",
            "wss:relay.example.com",
            "wss:///relay.example.com",
            "wss://relay.example.com/.",
            "wss://relay.example.com/foo/..",
        ] {
            assert!(relay_origin(forbidden).is_err(), "{forbidden}");
        }
    }

    #[test]
    fn host_auth_keeps_credentials_out_of_urls_and_debug_output() {
        let directory = TestDirectory::new();
        let identity = load_identity(&directory.0.join("device.json")).unwrap();
        let origin = relay_origin("wss://relay.example.com").unwrap();
        let request = host_request(&origin, &identity).unwrap();
        assert_eq!(
            request.uri().path(),
            format!("/device/{}/host", identity.device_id)
        );
        assert!(request.uri().query().is_none());
        assert_eq!(
            request.headers()[AUTHORIZATION].to_str().unwrap(),
            format!("Bearer {}", identity.host_token)
        );
        assert!(request.headers()[AUTHORIZATION].is_sensitive());
        let debug = format!("{request:?}");
        assert!(!debug.contains(&identity.host_token));
    }

    #[test]
    fn browser_pairing_urls_reject_insecure_or_ambiguous_destinations() {
        let token = "a".repeat(64);
        for origin in ["https://web.example.com/", "http://localhost:8788/"] {
            assert!(pairing_url(&format!("{origin}#pair={token}")).is_ok());
        }
        for origin in [
            "http://web.example.com/",
            "http://127.0.0.2/",
            "ws://localhost/",
            "https://user:secret@web.example.com/",
            "https://web.example.com/.",
            "https://web.example.com/claim",
            "https://web.example.com/?secret=x",
            "https:///web.example.com/",
        ] {
            assert!(
                pairing_url(&format!("{origin}#pair={token}")).is_err(),
                "{origin}"
            );
        }
        for fragment in ["pair=short", "pair=", "token=secret", "pair=../secret"] {
            assert!(pairing_url(&format!("https://web.example.com/#{fragment}")).is_err());
        }
    }
}
