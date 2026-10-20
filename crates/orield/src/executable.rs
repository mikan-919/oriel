use std::{io, path::PathBuf};

pub(super) fn current() -> io::Result<PathBuf> {
    #[cfg(target_os = "linux")]
    {
        // Keep the running image after an upgrade unlinks its installed path.
        // Git invokes helpers through a shell, so /proc/self/exe would name
        // that shell instead of the originating daemon.
        Ok(format!("/proc/{}/exe", std::process::id()).into())
    }
    #[cfg(not(target_os = "linux"))]
    {
        std::env::current_exe()
    }
}
