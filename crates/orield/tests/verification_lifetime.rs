#![cfg(target_os = "linux")]
#[path = "../src/executable.rs"]
mod executable;
#[path = "../src/verification_monitor.rs"]
#[allow(dead_code)]
mod verification_monitor;
mod workflow_git {
    pub fn stop_group(id: u32) -> anyhow::Result<()> {
        unsafe {
            libc::kill(-(id as i32), libc::SIGKILL);
        }
        Ok(())
    }
}
use std::{
    process::Command,
    time::{Duration, Instant},
};

#[test]
fn daemon_helper() {
    let Some(root) = std::env::var_os("ORIEL_MONITOR_TEST_ROOT") else {
        return;
    };
    let root = std::path::PathBuf::from(root);
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
        unsafe { libc::signal(libc::SIGINT, on_interrupt as *const () as libc::sighandler_t); }
        let interrupt = async {
            while !INTERRUPTED.load(std::sync::atomic::Ordering::Relaxed) {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        };
        tokio::pin!(interrupt);
        let lock = verification_monitor::lock(&root).unwrap();
        let mut command = verification_monitor::command("/bin/sh").unwrap();
        command.args(["-c", "echo verification-log; echo diagnostic >&2; echo $$ > group; (while :; do echo child >> writes; sleep 0.02; done) & (sh -c 'while :; do echo grandchild >> writes; sleep 0.02; done') & echo ready > started; if [ -f finish ]; then exit 7; fi; if [ -f success ]; then exit 0; fi; if [ -f signal ]; then kill -TERM $$; fi; wait"])
            .current_dir(&root)
            .stdout(std::fs::File::create(root.join("stdout.log")).unwrap())
            .stderr(std::fs::File::create(root.join("stderr.log")).unwrap());
        let mut child = verification_monitor::wrap(&mut command, &lock).await.unwrap();
        let control = child.stdin.take();
        std::fs::write(root.join("monitor-ready"), b"").unwrap();
        let status = if root.join("cancel").exists() {
            drop(control);
            child.wait().await.unwrap()
        } else {
            tokio::select! {
                status = child.wait() => status.unwrap(),
                _ = &mut interrupt => { std::fs::write(root.join("interrupted"), b"").unwrap(); drop(control); child.wait().await.unwrap() }
            }
        };
        if root.join("finish").exists() { assert_eq!(status.code(), Some(7)); }
        if root.join("success").exists() { assert!(status.success()); }
        if root.join("signal").exists() {
            use std::os::unix::process::ExitStatusExt;
            assert_eq!(status.signal(), Some(libc::SIGTERM));
        }

    });
}

fn wait_for(mut predicate: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !predicate() {
        assert!(Instant::now() < deadline, "timed out");
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn reexec_after_executable_replacement() {
    use std::{io::Write, os::unix::fs::PermissionsExt};
    let root = std::env::temp_dir().join(format!("oriel-reexec-{}", std::process::id()));
    std::fs::create_dir(&root).unwrap();
    let installed = root.join("orield");
    std::fs::copy(std::env::current_exe().unwrap(), &installed).unwrap();
    let daemon = Command::new(&installed)
        .args(["--exact", "reexec_helper", "--nocapture"])
        .env("ORIEL_REEXEC_TEST_ROOT", &root)
        .stdin(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let mut cleanup = Cleanup {
        daemon,
        root: root.clone(),
    };
    wait_for(|| root.join("ready").exists() || cleanup.daemon.try_wait().unwrap().is_some());
    assert!(
        root.join("ready").exists(),
        "subprocess exited before replacement"
    );
    let replacement = root.join("replacement");
    std::fs::write(&replacement, "#!/bin/sh\nexit 99\n").unwrap();
    std::fs::set_permissions(&replacement, std::fs::Permissions::from_mode(0o700)).unwrap();
    std::fs::rename(replacement, &installed).unwrap();
    cleanup
        .daemon
        .stdin
        .take()
        .unwrap()
        .write_all(b"S")
        .unwrap();
    wait_for(|| cleanup.daemon.try_wait().unwrap().is_some());
    assert!(cleanup.daemon.wait().unwrap().success());
    for mode in ["direct", "shell"] {
        assert_eq!(
            std::fs::read_to_string(root.join(mode)).unwrap(),
            "original executable"
        );
    }
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn reexec_helper() {
    use std::io::Read;
    let Ok(root) = std::env::var("ORIEL_REEXEC_TEST_ROOT") else {
        return;
    };
    let root = std::path::PathBuf::from(root);
    if let Ok(mode) = std::env::var("ORIEL_REEXEC_TEST_MODE") {
        std::fs::write(root.join(mode), "original executable").unwrap();
        return;
    }
    std::fs::write(root.join("ready"), "").unwrap();
    let mut start = [0];
    std::io::stdin().read_exact(&mut start).unwrap();
    // Rebuilding/reinstalling unlinks the original image while it still runs.
    assert!(!std::env::current_exe().unwrap().exists());
    let executable = executable::current().unwrap();
    for mode in ["direct", "shell"] {
        let mut command = if mode == "direct" {
            let mut command = Command::new(&executable);
            command.args(["--exact", "reexec_helper", "--nocapture"]);
            command
        } else {
            let mut command = Command::new("/bin/sh");
            command.args([
                "-c",
                &format!(
                    "'{}' --exact reexec_helper --nocapture",
                    executable.display()
                ),
            ]);
            command
        };
        let output = command
            .env("ORIEL_REEXEC_TEST_MODE", mode)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{mode}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

#[test]
fn lifetime_and_restart_gate() {
    for mode in [
        "kill",
        "interrupt",
        "finish",
        "success",
        "signal",
        "cancel",
        "startup",
    ] {
        let root = std::env::temp_dir().join(format!(
            "oriel-monitor-{}-{}-{mode}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("unsent"), b"preserved work").unwrap();
        if mode == "finish" || mode == "success" || mode == "signal" || mode == "cancel" {
            std::fs::write(root.join(mode), b"").unwrap();
        }
        let daemon = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "daemon_helper", "--nocapture"])
            .env("ORIEL_MONITOR_TEST_ROOT", &root)
            .spawn()
            .unwrap();
        let mut cleanup = Cleanup {
            daemon,
            root: root.clone(),
        };
        if mode == "kill" || mode == "interrupt" {
            wait_for(|| root.join("started").exists() && root.join("monitor-ready").exists());
            assert!(verification_monitor::lock(&root).is_err());
            if mode == "interrupt" {
                unsafe {
                    assert_eq!(libc::kill(cleanup.daemon.id() as i32, libc::SIGINT), 0);
                }
            } else {
                cleanup.daemon.kill().unwrap();
            }
        } else if mode == "startup" {
            cleanup.daemon.kill().unwrap();
        }
        wait_for(|| cleanup.daemon.try_wait().unwrap().is_some());
        wait_for(|| verification_monitor::lock(&root).is_ok());
        let lock = verification_monitor::lock(&root).unwrap();
        let size = || std::fs::read(root.join("writes")).unwrap_or_default().len();
        let before = size();
        std::thread::sleep(Duration::from_secs(1));
        assert_eq!(
            before,
            size(),
            "old descendants wrote after restart: {mode}"
        );
        if mode == "finish" || mode == "success" {
            assert!(
                std::fs::read_to_string(root.join("stdout.log"))
                    .unwrap()
                    .contains("verification-log")
            );
            assert!(
                std::fs::read_to_string(root.join("stderr.log"))
                    .unwrap()
                    .contains("diagnostic")
            );
        }
        assert_eq!(
            std::fs::read(root.join("unsent")).unwrap(),
            b"preserved work"
        );
        drop(lock);
        std::fs::remove_dir_all(root).unwrap();
    }
}

struct Cleanup {
    daemon: std::process::Child,
    root: std::path::PathBuf,
}
impl Drop for Cleanup {
    fn drop(&mut self) {
        let _ = self.daemon.kill();
        let _ = self.daemon.wait();
        if let Ok(text) = std::fs::read_to_string(self.root.join("group"))
            && let Ok(id) = text.trim().parse::<i32>()
        {
            unsafe {
                libc::kill(-id, libc::SIGKILL);
            }
        }
    }
}

#[test]
fn initialization_failure_does_not_execute_command() {
    let output = Command::new(env!("CARGO_BIN_EXE_orield"))
        .args([
            "__verification-monitor",
            "/bin/sh",
            "-c",
            "echo must-not-run",
        ])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
}

static INTERRUPTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
extern "C" fn on_interrupt(_: libc::c_int) {
    INTERRUPTED.store(true, std::sync::atomic::Ordering::Relaxed);
}

#[test]
fn startup_eof_prevents_execution() {
    use std::{
        io::Read,
        os::{
            fd::AsRawFd,
            unix::{net::UnixStream, process::CommandExt},
        },
    };
    let root = std::env::temp_dir().join(format!(
        "oriel-monitor-startup-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir(&root).unwrap();
    let lock = verification_monitor::lock(&root).unwrap();
    let (mut ready, monitor_ready) = UnixStream::pair().unwrap();
    ready.set_nonblocking(true).unwrap();
    let lock_fd = lock.as_raw_fd();
    let ready_fd = monitor_ready.as_raw_fd();
    let mut command = Command::new(env!("CARGO_BIN_EXE_orield"));
    command
        .args([
            "__verification-monitor",
            "/bin/sh",
            "-c",
            "echo forbidden > writes",
        ])
        .current_dir(&root)
        .stdin(std::process::Stdio::piped());
    unsafe {
        command.pre_exec(move || {
            if libc::dup2(lock_fd, 198) < 0 || libc::dup2(ready_fd, 199) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut cleanup = Cleanup {
        daemon: command.spawn().unwrap(),
        root: root.clone(),
    };
    drop(monitor_ready);
    let mut byte = [0];
    wait_for(|| match ready.read(&mut byte) {
        Ok(1) => true,
        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => false,
        result => panic!("monitor readiness failed: {result:?}"),
    });
    assert_eq!(&byte, b"R");
    // Simulate daemon death between monitor readiness and start acknowledgement.
    drop(cleanup.daemon.stdin.take());
    wait_for(|| cleanup.daemon.try_wait().unwrap().is_some());
    assert!(!root.join("writes").exists());
    drop(lock);
    assert!(verification_monitor::lock(&root).is_ok());
    std::fs::remove_dir_all(root).unwrap();
}
