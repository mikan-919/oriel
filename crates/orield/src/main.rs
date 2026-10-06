use std::{
    fs::{self, DirBuilder, File, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    thread,
    time::Duration,
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

#[derive(Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct DeviceIdentity {
    device_id: String,
    host_token: String,
    client_token: String,
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
        None => PathBuf::from(std::env::var_os("HOME").context("HOME is not set")?)
            .join(".config"),
    };
    Ok(config.join("oriel/device.json"))
}

fn is_lower_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn read_identity(path: &Path) -> Result<DeviceIdentity> {
    let metadata = fs::symlink_metadata(path).context("failed to inspect device identity")?;
    ensure!(metadata.is_file(), "device identity must be a regular file, not a symlink");
    ensure!(
        metadata.permissions().mode() & 0o7777 == 0o600,
        "device identity must have mode 0600"
    );
    let identity: DeviceIdentity = serde_json::from_reader(
        File::open(path).context("failed to open device identity")?,
    )
    .map_err(|_| anyhow!("invalid device identity JSON; refusing to replace it"))?;
    ensure!(
        is_lower_hex(&identity.device_id, 32)
            && is_lower_hex(&identity.host_token, 64)
            && is_lower_hex(&identity.client_token, 64)
            && identity.host_token != identity.client_token,
        "invalid device identity credentials; refusing to replace them"
    );
    Ok(identity)
}

fn load_identity(path: &Path) -> Result<DeviceIdentity> {
    match fs::symlink_metadata(path) {
        Ok(_) => return read_identity(path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error).context("failed to inspect device identity"),
    }

    let parent = path.parent().filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    DirBuilder::new().recursive(true).mode(0o700).create(parent)
        .context("failed to create private identity directory")?;
    let identity = DeviceIdentity {
        device_id: random_hex::<16>()?,
        host_token: random_hex::<32>()?,
        client_token: random_hex::<32>()?,
    };
    let temporary = parent.join(format!(".device-{}.tmp", random_hex::<16>()?));
    let mut file = OpenOptions::new().write(true).create_new(true).mode(0o600)
        .open(&temporary).context("failed to create private identity file")?;
    let publish = (|| -> Result<()> {
        file.set_permissions(fs::Permissions::from_mode(0o600))?;
        serde_json::to_writer(&mut file, &identity)?;
        file.write_all(b"\n")?;
        file.sync_all().context("failed to persist device identity")?;
        match fs::hard_link(&temporary, path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error).context("failed to publish device identity"),
        }
        Ok(())
    })();
    let cleanup = fs::remove_file(&temporary).context("failed to remove temporary identity file");
    publish?;
    cleanup?;
    File::open(parent)?.sync_all().context("failed to persist identity directory")?;
    read_identity(path)
}

fn relay_origin(value: &str) -> Result<Url> {
    ensure!(
        !value.contains('\\')
            && !value.bytes().any(|byte| byte.is_ascii_control() || byte.is_ascii_whitespace()),
        "ORIEL_RELAY_URL must not contain whitespace, control characters or backslashes"
    );
    let authority = value.strip_prefix("ws://").or_else(|| value.strip_prefix("wss://"))
        .context("ORIEL_RELAY_URL must start with ws:// or wss://")?;
    let authority = authority.strip_suffix('/').unwrap_or(authority);
    ensure!(
        !authority.is_empty() && !authority.contains(['/', '@', '?', '#']),
        "ORIEL_RELAY_URL must be an origin without credentials, path, query or fragment"
    );
    let url = Url::parse(value).context("ORIEL_RELAY_URL must be a WebSocket base origin")?;
    ensure!(
        matches!(url.scheme(), "ws" | "wss")
            && url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && url.path() == "/"
            && url.query().is_none()
            && url.fragment().is_none(),
        "ORIEL_RELAY_URL must be a ws/wss origin without credentials, path, query or fragment"
    );
    ensure!(
        url.scheme() == "wss"
            || matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]")),
        "plaintext WebSocket relay URLs are allowed only on loopback"
    );
    Ok(url)
}

fn host_request(origin: &Url, identity: &DeviceIdentity) -> Result<Request<()>> {
    let mut url = origin.clone();
    url.set_path(&format!("/device/{}/host", identity.device_id));
    let mut request = url.as_str().into_client_request()?;
    let mut authorization = HeaderValue::from_str(&format!("Bearer {}", identity.host_token))?;
    authorization.set_sensitive(true);
    request.headers_mut().insert(AUTHORIZATION, authorization);
    Ok(request)
}

fn relay_config(identity: &DeviceIdentity) -> serde_json::Value {
    serde_json::json!({
        (identity.device_id.as_str()): {
            "host_token": identity.host_token,
            "client_token": identity.client_token,
        }
    })
}

fn client_config(identity: &DeviceIdentity, origin: &Url) -> serde_json::Value {
    serde_json::json!({
        "device_id": identity.device_id,
        "client_token": identity.client_token,
        "relay_url": origin.as_str().trim_end_matches('/'),
    })
}

struct Terminal {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    output: broadcast::Sender<Vec<u8>>,
}

type TerminalHandle = Arc<Terminal>;

#[tokio::main]
async fn main() -> Result<()> {
    let mut args = std::env::args_os().skip(1);
    let mode = args.next();
    if args.next().is_some()
        || mode.as_ref().is_some_and(|arg|
            arg != "--print-relay-config" && arg != "--print-client-config"
                && arg != "--help" && arg != "-h")
    {
        bail!("usage: orield [--print-relay-config | --print-client-config | --help]");
    }
    if mode.as_ref().is_some_and(|arg| arg == "--help" || arg == "-h") {
        println!("{}", concat!(
            "Usage: orield [--print-relay-config | --print-client-config | --help]\n\n",
            "Without a flag, run Codex in a PTY and reconnect to the authenticated relay.\n",
            "--print-relay-config  Print SECRET JSON for the Relay's ORIEL_DEVICE_CREDENTIALS.\n",
            "--print-client-config Print SECRET {device_id,client_token,relay_url} JSON for Browser setup.\n",
            "Both config flags initialize/load the identity and exit without launching Codex.\n",
            "Manually provision the Relay's Cloudflare secret; there is no automatic enrollment.\n",
            "Do not commit, log or share config output or the identity file.\n\n",
            "Identity: $XDG_CONFIG_HOME/oriel/device.json, falling back to\n",
            "$HOME/.config/oriel/device.json; ORIEL_IDENTITY_FILE overrides the path.\n",
            "Created files are mode 0600 and new directories private. Invalid identities are never reset.\n",
            "ORIEL_RELAY_URL: ws/wss base origin, default ws://127.0.0.1:8787.\n",
            "Paths, credentials, queries and fragments are forbidden; plaintext ws is allowed\n",
            "only for localhost, 127.0.0.1 and [::1]. The daemon appends /device/<device_id>/host."
        ));
        return Ok(());
    }
    let identity = load_identity(&identity_path()?)?;
    let relay_value = match std::env::var("ORIEL_RELAY_URL") {
        Ok(value) => value,
        Err(std::env::VarError::NotPresent) => "ws://127.0.0.1:8787".to_string(),
        Err(_) => bail!("ORIEL_RELAY_URL must be valid UTF-8"),
    };
    let relay_url = relay_origin(&relay_value)?;
    if let Some(mode) = mode {
        let config = if mode == "--print-relay-config" {
            relay_config(&identity)
        } else {
            client_config(&identity, &relay_url)
        };
        println!("{}", serde_json::to_string(&config)?);
        return Ok(());
    }

    rustls::crypto::ring::default_provider()
        .install_default()
        .expect("failed to install rustls crypto provider");

    tracing_subscriber::fmt::init();

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
            let path = std::env::temp_dir()
                .join(format!("orield-identity-test-{}", random_hex::<16>().unwrap()));
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
    fn identities_persist_are_unique_and_private() {
        let directory = TestDirectory::new();
        let path = directory.0.join("oriel/device.json");
        let first = load_identity(&path).unwrap();
        assert!(first == load_identity(&path).unwrap());
        let second = load_identity(&directory.0.join("second/device.json")).unwrap();
        assert!(first.device_id != second.device_id);
        assert!(first.host_token != second.host_token);
        assert!(first.client_token != second.client_token);
        assert!(first.host_token != first.client_token);
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(
            fs::metadata(path.parent().unwrap()).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }

    #[test]
    fn invalid_existing_identity_is_never_replaced_or_logged() {
        let directory = TestDirectory::new();
        let path = directory.0.join("device.json");
        let mut file = OpenOptions::new().write(true).create_new(true).mode(0o600)
            .open(&path).unwrap();
        for invalid in [
            "{}".to_string(),
            "{\"device_id\":".to_string(),
            format!(
                "{{\"device_id\":\"{}\",\"host_token\":\"{}\",\"client_token\":\"{}\"}}",
                "A".repeat(32), "1".repeat(64), "2".repeat(64)
            ),
            format!(
                "{{\"device_id\":\"{}\",\"host_token\":\"{}\",\"client_token\":\"{}\"}}",
                "a".repeat(32), "1".repeat(64), "1".repeat(64)
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
        let threads: Vec<_> = (0..8).map(|_| {
            let path = path.clone();
            let barrier = barrier.clone();
            thread::spawn(move || {
                barrier.wait();
                load_identity(&path).unwrap()
            })
        }).collect();
        let identities: Vec<_> = threads.into_iter().map(|thread| thread.join().unwrap()).collect();
        assert!(identities.iter().all(|identity| identity == &identities[0]));
        assert!(load_identity(&path).unwrap() == identities[0]);
    }

    #[test]
    fn relay_origins_enforce_transport_and_secret_boundaries() {
        for allowed in [
            "ws://localhost:8787", "ws://127.0.0.1:8787", "ws://[::1]:8787",
            "wss://relay.example.com",
        ] {
            assert!(relay_origin(allowed).is_ok(), "{allowed}");
        }
        for forbidden in [
            "ws://relay.example.com", "ws://192.168.1.1", "ws://127.0.0.2",
            "ws://localhost.example.com", "ws://[::2]", "https://relay.example.com",
            "wss://user:secret@relay.example.com", "wss://relay.example.com/host",
            "wss://relay.example.com?token=secret", "wss://relay.example.com#secret",
            " wss://relay.example.com", "wss://relay.exa\nmple.com",
            "wss:\\\\relay.example.com",
            "wss:relay.example.com", "wss:///relay.example.com",
            "wss://relay.example.com/.", "wss://relay.example.com/foo/..",
        ] {
            assert!(relay_origin(forbidden).is_err(), "{forbidden}");
        }
    }

    #[test]
    fn host_auth_and_client_config_keep_role_tokens_separate() {
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
        assert!(!debug.contains(&identity.client_token));
        let config = client_config(&identity, &origin);
        assert!(!config.to_string().contains(&identity.host_token));
        assert!(config.get("host_token").is_none());
    }
}
