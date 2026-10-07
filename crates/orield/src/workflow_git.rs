use std::{
    fs::{self, DirBuilder, OpenOptions},
    io::{Read, Write},
    os::unix::{
        fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt},
        net::UnixStream,
        process::CommandExt,
    },
    path::{Path, PathBuf},
    process::{Output, Stdio},
    time::Duration,
};

use anyhow::{Context, Result, anyhow, ensure};
use serde::Deserialize;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::UnixListener,
    process::Command,
};

use crate::{random_hex, repository::Repository};

pub(super) fn private_directory(path: &Path) -> Result<()> {
    DirBuilder::new().recursive(true).mode(0o700).create(path)?;
    let metadata = fs::symlink_metadata(path)?;
    ensure!(
        metadata.is_dir() && !metadata.file_type().is_symlink(),
        "workflow directory must not be a symlink"
    );
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    Ok(())
}

pub(super) fn private_file(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(bytes)?;
    Ok(())
}

pub(super) fn state_root() -> Result<PathBuf> {
    let root = if let Some(state) = std::env::var_os("XDG_STATE_HOME").filter(|s| !s.is_empty()) {
        PathBuf::from(state)
    } else {
        PathBuf::from(
            std::env::var_os("HOME")
                .ok_or_else(|| anyhow!("HOME is required for workflow state"))?,
        )
        .join(".local/state")
    };
    ensure!(
        root.is_absolute(),
        "workflow state directory must be absolute"
    );
    let root = root.join("oriel/workflow");
    private_directory(&root)?;
    Ok(root)
}

pub(super) fn command(cwd: &Path) -> Command {
    let mut command = Command::new("git");
    command
        .current_dir(cwd)
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .env("HOME", cwd)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", "/bin/false")
        .args([
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "credential.helper=",
            "-c",
            "protocol.allow=never",
            "-c",
            "protocol.https.allow=always",
            "-c",
            "http.followRedirects=false",
            "-c",
            "http.extraHeader=",
            "-c",
            "http.proxy=",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "user.name=Oriel",
            "-c",
            "user.email=oriel@oriel.invalid",
            "-c",
            "commit.gpgSign=false",
            "-c",
            "merge.gpgSign=false",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    command.as_std_mut().process_group(0);
    command
}

pub(super) async fn local(cwd: &Path, args: &[&str]) -> Result<Output> {
    command(cwd)
        .args(args)
        .output()
        .await
        .map_err(|_| anyhow!("local Git command could not execute"))
}

pub(super) async fn text(cwd: &Path, args: &[&str]) -> Result<String> {
    let output = local(cwd, args).await?;
    ensure!(
        output.status.success(),
        "local Git operation failed; work is preserved at {}",
        cwd.display()
    );
    String::from_utf8(output.stdout)
        .map(|s| s.trim_end_matches(['\r', '\n']).to_owned())
        .map_err(|_| anyhow!("Git returned invalid text"))
}

pub(super) fn oid(value: &str) -> bool {
    value.len() == 40 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

pub(super) fn remote(repository: &Repository) -> String {
    format!(
        "https://github.com/{}/{}.git",
        repository.owner, repository.name
    )
}

#[derive(Deserialize)]
pub(super) struct GitToken {
    token: String,
    expires_at: String,
    repository: Repository,
}

async fn safe_transport_configuration(cwd: &Path) -> Result<()> {
    let output = local(
        cwd,
        &[
            "config",
            "--local",
            "--name-only",
            "--list",
            "--no-includes",
        ],
    )
    .await?;
    ensure!(
        output.status.success(),
        "cannot inspect private Git transport configuration"
    );
    let keys =
        std::str::from_utf8(&output.stdout).map_err(|_| anyhow!("invalid Git configuration"))?;
    ensure!(
        keys.lines().all(|key| matches!(
            key,
            "core.repositoryformatversion"
                | "core.filemode"
                | "core.bare"
                | "core.logallrefupdates"
                | "extensions.objectformat"
        )),
        "private repository has unsafe Git transport configuration; no credential was requested from its helpers"
    );
    Ok(())
}

pub(super) struct CredentialTransport {
    pub command: Command,
    server: tokio::task::JoinHandle<()>,
    directory: PathBuf,
}

impl Drop for CredentialTransport {
    fn drop(&mut self) {
        self.server.abort();
        let _ = fs::remove_file(self.directory.join("credential.sock"));
        let _ = fs::remove_dir(&self.directory);
    }
}

fn credential_request(request: &str, repository: &Repository) -> bool {
    let mut protocol = None;
    let mut host = None;
    let mut path = None;
    for line in request.lines().filter(|line| !line.is_empty()) {
        let Some((key, value)) = line.split_once('=') else {
            return false;
        };
        match key {
            "protocol" if protocol.is_none() => protocol = Some(value),
            "host" if host.is_none() => host = Some(value),
            "path" if path.is_none() => path = Some(value),
            "username" => {}
            _ => return false,
        }
    }
    protocol == Some("https")
        && host == Some("github.com")
        && path == Some(format!("{}/{}.git", repository.owner, repository.name).as_str())
}

pub(super) async fn transport(
    cwd: &Path,
    token: GitToken,
    repository: &Repository,
) -> Result<CredentialTransport> {
    safe_transport_configuration(cwd).await?;
    ensure!(
        token
            .repository
            .owner
            .eq_ignore_ascii_case(&repository.owner)
            && token.repository.name.eq_ignore_ascii_case(&repository.name)
            && !token.expires_at.is_empty(),
        "Git credential target does not match workflow repository"
    );
    ensure!(
        !token.token.is_empty() && !token.token.contains(['\r', '\n']),
        "invalid Git credential response"
    );
    // The coding child is stopped before transport. The token exists only in this
    // trusted process and a single private socket response, never Git's environment.
    let directory = std::env::temp_dir().join(format!("oriel-git-{}", random_hex::<12>()?));
    private_directory(&directory)?;
    let socket = directory.join("credential.sock");
    let listener = UnixListener::bind(&socket)?;
    fs::set_permissions(&socket, fs::Permissions::from_mode(0o600))?;
    let expected = Repository {
        owner: repository.owner.clone(),
        name: repository.name.clone(),
    };
    let server = tokio::spawn(async move {
        let response = async {
            let (mut connection, _) = listener.accept().await?;
            let mut bytes = Vec::new();
            (&mut connection).take(4097).read_to_end(&mut bytes).await?;
            if bytes.len() <= 4096
                && std::str::from_utf8(&bytes).is_ok_and(|s| credential_request(s, &expected))
            {
                connection
                    .write_all(
                        format!("username=x-access-token\npassword={}\n\n", token.token).as_bytes(),
                    )
                    .await?;
            }
            Ok::<(), std::io::Error>(())
        };
        let _ = tokio::time::timeout(Duration::from_secs(30), response).await;
    });
    let executable = std::env::current_exe()?;
    let quoted = |path: &Path| format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"));
    let helper = format!(
        "!{} __workflow-credential {}",
        quoted(&executable),
        quoted(&socket)
    );
    let mut command = command(cwd);
    command.args([
        "-c",
        "credential.useHttpPath=true",
        "-c",
        &format!("credential.helper={helper}"),
    ]);
    Ok(CredentialTransport {
        command,
        server,
        directory,
    })
}

pub(super) fn credential_helper(socket: &Path, operation: &str) -> Result<()> {
    if operation != "get" {
        return Ok(());
    }
    let mut request = Vec::new();
    std::io::stdin().take(4097).read_to_end(&mut request)?;
    ensure!(request.len() <= 4096, "invalid Git credential request");
    let mut connection = UnixStream::connect(socket)?;
    connection.set_read_timeout(Some(Duration::from_secs(5)))?;
    connection.set_write_timeout(Some(Duration::from_secs(5)))?;
    connection.write_all(&request)?;
    connection.shutdown(std::net::Shutdown::Write)?;
    let mut response = Vec::new();
    connection.take(16385).read_to_end(&mut response)?;
    ensure!(response.len() <= 16384, "invalid Git credential response");
    std::io::stdout().write_all(&response)?;
    Ok(())
}

pub(super) fn stop_group(id: u32) -> Result<()> {
    let id = i32::try_from(id).context("invalid workflow process group")?;
    ensure!(id > 0, "invalid workflow process group");
    // NixOS need not provide /bin/kill. Signal the owned Unix group directly.
    if unsafe { libc::kill(-id, libc::SIGKILL) } != 0 {
        let error = std::io::Error::last_os_error();
        ensure!(
            error.raw_os_error() == Some(libc::ESRCH),
            "cannot stop workflow process group: {error}"
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credentials_only_answer_exact_https_repository_requests() {
        let repository = Repository {
            owner: "octocat".into(),
            name: "connected".into(),
        };
        assert!(credential_request(
            "protocol=https\nhost=github.com\npath=octocat/connected.git\n\n",
            &repository
        ));
        for request in [
            "protocol=http\nhost=github.com\npath=octocat/connected.git\n",
            "protocol=https\nhost=github.com.evil\npath=octocat/connected.git\n",
            "protocol=https\nhost=github.com\npath=octocat/other.git\n",
            "protocol=https\nhost=github.com\npath=octocat/connected.git\nhost=evil\n",
            "protocol=https\nhost=github.com\n",
        ] {
            assert!(!credential_request(request, &repository));
        }
    }

    #[tokio::test]
    async fn interrupted_process_group_is_reaped_before_transport() {
        use std::os::unix::process::ExitStatusExt;
        let mut command = Command::new("/bin/sh");
        command
            .args(["-c", "sleep 30 & wait"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        command.as_std_mut().process_group(0);
        let mut child = command.spawn().unwrap();
        stop_group(child.id().unwrap()).unwrap();
        let status = tokio::time::timeout(Duration::from_secs(5), child.wait())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(status.signal(), Some(9));
    }
}
