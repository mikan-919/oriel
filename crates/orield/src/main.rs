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
use tokio::sync::broadcast;
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

mod integrations;
mod repository;
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

fn lock_workflow_identity(path: &Path) -> Result<File> {
    // Keep the device's existing identity file locked for this process's lifetime.
    // No lock file or credential rewrite is needed; closing the handle releases it.
    let file = File::open(path).context("failed to open workflow device identity")?;
    match file.try_lock() {
        Ok(()) => Ok(file),
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
        let status: PairStatus = client
            .get(status_url.clone())
            .send()
            .await?
            .error_for_status()?
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
                let confirmed: PairStatus = client
                    .post(origin.join(&format!("/api/pair/{}/confirm", identity.device_id))?)
                    .json(&serde_json::json!({ "user_id": user_id }))
                    .send()
                    .await?
                    .error_for_status()?
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
    let start: PairStart = client
        .post(origin.join("/api/pair/start")?)
        .json(
            &serde_json::json!({ "device_id": identity.device_id, "name": device_name(identity) }),
        )
        .send()
        .await?
        .error_for_status()?
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

struct Terminal {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    output: broadcast::Sender<Vec<u8>>,
}

type TerminalHandle = Arc<Terminal>;

#[tokio::main]
async fn main() -> Result<()> {
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
    let mode = match args.as_slice() {
        [] => "terminal",
        [arg] if arg == "--help" || arg == "-h" => {
            println!(
                "{}",
                concat!(
                    "Usage: orield [--help | integrations | workflow [--once]]\n\n",
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
                    "Verified canonical branches are pushed with CAS; PR review fixes resume\n",
                    "the same branch. Only an observed human merge moves Linear to Done.\n",
                    "--once scans once; continuous mode scans immediately, then every 15s.\n",
                    "Only one workflow process may run per device; a second start exits before connecting.\n",
                    "Interrupted/unpushed work is preserved under $XDG_STATE_HOME/oriel/workflow\n",
                    "(fallback $HOME/.local/state/oriel/workflow); transcripts remain private.\n",
                    "Codex must support exec structured output and config/rules isolation.\n\n",
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
        [arg] if arg == "workflow" => "workflow",
        [arg, once] if arg == "workflow" && once == "--once" => "once",
        _ => bail!("usage: orield [--help | integrations | workflow [--once]]"),
    };
    let identity_file = identity_path()?;
    let identity = load_identity(&identity_file)?;
    let _workflow_owner = if mode == "workflow" || mode == "once" {
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
    if mode == "workflow" || mode == "once" {
        return workflow::run(&relay_url, &identity, mode == "once").await;
    }
    repository::report_current(&relay_url, &identity).await?;

    let terminal = spawn_terminal("codex")?;

    info!("orield started");
    info!("device: {}", identity.device_id);
    info!("relay: {relay_url}");

    loop {
        info!("connecting to relay");

        match connect_async(host_request(&relay_url, &identity)?).await {
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

        tokio::time::sleep(Duration::from_secs(1)).await;
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

    let terminal = Arc::new(Terminal {
        master: Mutex::new(pair.master),
        writer: Mutex::new(writer),
        output: output_tx.clone(),
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
    });

    thread::spawn(move || match child.wait() {
        Ok(status) => {
            info!("child exited: {status:?}");
        }

        Err(error) => {
            error!("failed waiting for child: {error}");
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
    let (mut sender, mut receiver) = socket.split();

    let mut output = terminal.output.subscribe();

    loop {
        tokio::select! {
            message = receiver.next() => {
                match message {
                    Some(Ok(Message::Binary(data))) => {
                        let result = {
                            let mut writer = terminal
                                .writer
                                .lock()
                                .expect(
                                    "PTY writer mutex poisoned"
                                );

                            writer
                                .write_all(&data)
                                .and_then(|_| writer.flush())
                        };

                        result.context(
                            "failed writing to PTY"
                        )?;
                    }

                    Some(Ok(Message::Text(text))) => {
                        if text.starts_with("oriel-heartbeat:") {
                            sender.send(Message::Text(text)).await?;
                            continue;
                        }
                        if let Some((cols, rows)) =
                            parse_resize(text.as_str())
                        {
                            let result = {
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
                            };

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
                        sender
                            .send(Message::Binary(data.into()))
                            .await?;
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
        drop(owner);
        let replacement = lock_workflow_identity(&path).unwrap();
        drop(replacement);
        drop(other_owner);
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
