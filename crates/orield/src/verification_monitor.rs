//! Linux verification lifetime supervision. No account state is loaded here.
use anyhow::{Context, Result, ensure};
use std::{
    fs::File,
    io::{Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::{
            net::UnixStream,
            process::{CommandExt, ExitStatusExt},
        },
    },
    path::Path,
    process::{Command, Stdio},
    time::Duration,
};

const LOCK: i32 = 198;
const READY: i32 = 199;

pub fn lock(root: &Path) -> Result<File> {
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(root.join("verification.lock"))?;
    ensure!(
        unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0,
        "previous verification cleanup is still active; work preserved, retry later"
    );
    Ok(file)
}

pub async fn wrap(
    command: &mut tokio::process::Command,
    lock: &File,
) -> Result<tokio::process::Child> {
    let (parent, child) = UnixStream::pair()?;
    parent.set_nonblocking(true)?;
    let mut ready = tokio::net::UnixStream::from_std(parent)?;
    // Reserve sources above the protocol descriptors, even in a daemon with
    // many open connections. dup2 must never overwrite its other source.
    fn reserve(fd: i32) -> Result<File> {
        let duplicate = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 200) };
        ensure!(duplicate >= 0, "cannot reserve monitor descriptor");
        Ok(unsafe { File::from_raw_fd(duplicate) })
    }
    let lock_source = reserve(lock.as_raw_fd())?;
    let ready_source = reserve(child.as_raw_fd())?;
    let lock_fd = lock_source.as_raw_fd();
    let ready_fd = ready_source.as_raw_fd();
    command.stdin(Stdio::piped()).kill_on_drop(false);
    command.as_std_mut().process_group(0);
    unsafe {
        command.pre_exec(move || {
            if libc::dup2(lock_fd, LOCK) < 0 || libc::dup2(ready_fd, READY) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut process = command.spawn()?;
    drop(child);
    use tokio::io::AsyncReadExt;
    let mut byte = [0];
    if tokio::time::timeout(Duration::from_secs(5), ready.read_exact(&mut byte))
        .await
        .is_err()
        || byte != *b"R"
    {
        drop(process.stdin.take());
        let _ = process.wait().await;
        anyhow::bail!("verification monitor initialization failed");
    }
    use tokio::io::AsyncWriteExt;
    process
        .stdin
        .as_mut()
        .context("missing monitor control pipe")?
        .write_all(b"S")
        .await?;
    Ok(process)
}

pub fn run(args: &[std::ffi::OsString]) -> Result<()> {
    ensure!(
        cfg!(target_os = "linux"),
        "verification monitoring requires Linux"
    );
    for fd in [LOCK, READY] {
        ensure!(
            unsafe { libc::fcntl(fd, libc::F_GETFD) } >= 0,
            "missing monitor descriptor"
        );
    }
    let _lock = unsafe { File::from_raw_fd(LOCK) };
    let mut ready = unsafe { File::from_raw_fd(READY) };
    #[cfg(target_os = "linux")]
    ensure!(
        unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) } == 0,
        "cannot initialize verification subreaper"
    );
    for fd in [LOCK, READY] {
        ensure!(
            unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) } == 0,
            "cannot isolate monitor descriptors"
        );
    }
    ready.write_all(b"R")?;
    drop(ready);
    // The daemon must acknowledge readiness before any verification can start.
    let mut start = [0];
    if std::io::stdin().read_exact(&mut start).is_err() {
        return Ok(());
    }
    ensure!(start == *b"S", "invalid monitor start acknowledgement");
    let mut poll = libc::pollfd {
        fd: 0,
        events: libc::POLLIN | libc::POLLHUP,
        revents: 0,
    };
    if unsafe { libc::poll(&mut poll, 1, 0) } > 0 {
        return Ok(());
    }
    let mut child = Command::new(args.first().context("missing verification command")?)
        .args(&args[1..])
        .stdin(Stdio::null())
        .process_group(0)
        .spawn()?;
    let id = child.id();
    let status = loop {
        if let Some(status) = child
            .try_wait()
            .unwrap_or_else(|_| hold_failed_cleanup("cannot inspect verification child"))
        {
            break Some(status);
        }
        if unsafe { libc::poll(&mut poll, 1, 20) } > 0 {
            break None;
        }
    };
    if let Err(error) = crate::workflow_git::stop_group(id) {
        hold_failed_cleanup(&error.to_string());
    }
    let status = match status {
        Some(status) => status,
        None => child
            .wait()
            .unwrap_or_else(|_| hold_failed_cleanup("cannot reap verification child")),
    };
    // Subreaping makes group descendants waitable, including orphaned grandchildren.
    loop {
        let result = unsafe { libc::waitpid(-1, std::ptr::null_mut(), 0) };
        if result < 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::EINTR) {
                continue;
            }
            if error.raw_os_error() != Some(libc::ECHILD) {
                hold_failed_cleanup("cannot confirm verification cleanup");
            }
            break;
        }
    }
    if let Some(signal) = status.signal() {
        // Preserve signal termination as well as ordinary numeric exit codes.
        unsafe {
            libc::signal(signal, libc::SIG_DFL);
            libc::kill(libc::getpid(), signal);
        }
    }
    std::process::exit(
        status
            .code()
            .unwrap_or_else(|| 128 + status.signal().unwrap_or(9)),
    );
}

fn monitor_executable() -> Result<std::path::PathBuf> {
    #[cfg(test)]
    if let Some(path) = option_env!("CARGO_BIN_EXE_orield") {
        return Ok(path.into());
    }
    Ok(std::env::current_exe()?)
}

pub fn command(program: impl AsRef<std::ffi::OsStr>) -> Result<tokio::process::Command> {
    let mut command = tokio::process::Command::new(monitor_executable()?);
    command.arg("__verification-monitor").arg(program);
    Ok(command)
}

fn hold_failed_cleanup(message: &str) -> ! {
    eprintln!("{message}; verification lock retained for operator investigation");
    loop {
        std::thread::park();
    }
}
