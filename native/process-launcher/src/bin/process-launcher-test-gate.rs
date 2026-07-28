//! Privileged integration-test helper.
//!
//! The helper stops before `execve` so the test controller can move its PID
//! from a fixture-control cgroup into the delegated service root. It is not
//! installed by the production deployment examples and never constructs a
//! sandbox or executes profile authority.

use std::ffi::CString;
use std::os::unix::ffi::OsStrExt;

fn main() {
    let arguments: Vec<_> = std::env::args_os().skip(1).collect();
    if arguments.len() != 2 {
        eprintln!("usage: process-launcher-test-gate <launcher-binary> <trusted-config>");
        std::process::exit(64);
    }
    if unsafe { libc::raise(libc::SIGSTOP) } != 0 {
        eprintln!("test gate could not stop before launcher exec");
        std::process::exit(70);
    }
    let executable = CString::new(arguments[0].as_bytes()).expect("path contains a NUL");
    let configuration = CString::new(arguments[1].as_bytes()).expect("path contains a NUL");
    let argv = [
        executable.as_ptr(),
        configuration.as_ptr(),
        std::ptr::null(),
    ];
    let environment = [
        c"LANG=C.UTF-8".as_ptr(),
        c"LC_ALL=C.UTF-8".as_ptr(),
        std::ptr::null(),
    ];
    unsafe {
        libc::execve(executable.as_ptr(), argv.as_ptr(), environment.as_ptr());
    }
    eprintln!(
        "test gate could not execute launcher: {}",
        std::io::Error::last_os_error()
    );
    std::process::exit(70);
}
