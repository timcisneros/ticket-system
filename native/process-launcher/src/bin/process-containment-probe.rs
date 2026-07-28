use std::collections::BTreeSet;
use std::env;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddrV4, SocketAddrV6, TcpStream, ToSocketAddrs};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::time::Duration;

fn main() {
    let mode = env::args().nth(1).unwrap_or_else(|| "inspect".into());
    std::thread::sleep(Duration::from_millis(100));
    match mode.as_str() {
        "inspect" => inspect(),
        "output" => output(),
        "sleep" => std::thread::sleep(Duration::from_secs(60)),
        "descendants" => descendants(),
        "pids" => pids(),
        "threads" => threads(),
        "cpu" => cpu(),
        "node-compatibility" => node_compatibility(),
        "memory" => memory(),
        "temporary-storage" => temporary_storage(),
        "file-size" => file_size(),
        "open-files" => open_files(),
        other => {
            eprintln!("unknown fixed containment probe mode: {other}");
            std::process::exit(64);
        }
    }
}

fn inspect() {
    let rootfs_read_only = OpenOptions::new()
        .write(true)
        .open("/usr/bin/process-containment-probe")
        .is_err();
    let workspace_read_only = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open("/workspace/probe-write")
        .is_err();
    let host_paths_absent = [
        "/run",
        "/home",
        "/root",
        "/var/lib/ticket-system",
        "/workspace/../run",
    ]
    .iter()
    .all(|path| !Path::new(path).exists());
    let proc_private = fs::read_dir("/proc")
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .filter(|entry| {
                    entry
                        .file_name()
                        .to_string_lossy()
                        .bytes()
                        .all(|byte| byte.is_ascii_digit())
                })
                .count()
                <= 3
        })
        .unwrap_or(false);
    let network_denied = TcpStream::connect_timeout(
        &SocketAddrV4::new(Ipv4Addr::LOCALHOST, 9).into(),
        Duration::from_millis(20),
    )
    .is_err()
        && TcpStream::connect_timeout(
            &SocketAddrV6::new(Ipv6Addr::LOCALHOST, 9, 0, 0).into(),
            Duration::from_millis(20),
        )
        .is_err()
        && raw_socket(libc::AF_INET).is_err()
        && raw_socket(libc::AF_INET6).is_err();
    let unix_denied =
        UnixStream::connect("/run/host.sock").is_err() && raw_socket(libc::AF_UNIX).is_err();
    let netlink_denied = raw_socket(libc::AF_NETLINK).is_err();
    let dns_denied = ("ticket-system-containment.invalid", 443)
        .to_socket_addrs()
        .is_err();
    let seccomp_denied = unsafe { libc::unshare(libc::CLONE_NEWNS) } != 0
        && std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM);
    let expected_environment = BTreeSet::from([
        ("LANG".to_owned(), "C.UTF-8".to_owned()),
        ("LC_ALL".to_owned(), "C.UTF-8".to_owned()),
        ("PWD".to_owned(), "/workspace".to_owned()),
        ("TMPDIR".to_owned(), "/tmp".to_owned()),
    ]);
    let actual_environment: BTreeSet<(String, String)> = env::vars().collect();
    let environment_clean = actual_environment == expected_environment;
    let mut stdin_byte = [0_u8; 1];
    let stdin_disabled =
        std::io::stdin().read(&mut stdin_byte).unwrap_or(1) == 0 && unsafe { libc::isatty(0) } == 0;
    let file_descriptors_clean = (3..64).all(|fd| unsafe {
        libc::fcntl(fd, libc::F_GETFD) == -1
            && std::io::Error::last_os_error().raw_os_error() == Some(libc::EBADF)
    });
    println!(
        "{}",
        serde_json::json!({
            "rootfsReadOnly": rootfs_read_only,
            "workspaceReadOnly": workspace_read_only,
            "hostPathsAbsent": host_paths_absent,
            "procPrivate": proc_private,
            "networkDenied": network_denied,
            "unixDenied": unix_denied,
            "netlinkDenied": netlink_denied,
            "dnsDenied": dns_denied,
            "seccompDenied": seccomp_denied,
            "environmentClean": environment_clean,
            "stdinDisabled": stdin_disabled,
            "fileDescriptorsClean": file_descriptors_clean
        })
    );
    std::thread::sleep(Duration::from_millis(100));
}

fn raw_socket(family: i32) -> std::io::Result<()> {
    let descriptor = unsafe { libc::socket(family, libc::SOCK_STREAM | libc::SOCK_CLOEXEC, 0) };
    if descriptor >= 0 {
        unsafe {
            libc::close(descriptor);
        }
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

fn output() {
    let stdout = std::io::stdout();
    let stderr = std::io::stderr();
    let mut stdout = stdout.lock();
    let mut stderr = stderr.lock();
    let bytes = [b'x'; 16 * 1024];
    loop {
        let _ = stdout.write_all(&bytes);
        let _ = stderr.write_all(&bytes);
    }
}

fn descendants() {
    unsafe {
        let child = libc::fork();
        if child == 0 {
            libc::setsid();
            libc::signal(libc::SIGTERM, libc::SIG_IGN);
            libc::signal(libc::SIGINT, libc::SIG_IGN);
            let grandchild = libc::fork();
            if grandchild > 0 {
                libc::_exit(0);
            }
            loop {
                libc::pause();
            }
        }
    }
    loop {
        std::thread::sleep(Duration::from_secs(60));
    }
}

fn pids() {
    loop {
        let child = unsafe { libc::fork() };
        if child == 0 {
            loop {
                unsafe { libc::pause() };
            }
        }
        if child < 0 {
            loop {
                std::thread::sleep(Duration::from_secs(60));
            }
        }
    }
}

fn threads() {
    loop {
        if std::thread::Builder::new()
            .spawn(|| {
                loop {
                    std::thread::sleep(Duration::from_secs(60));
                }
            })
            .is_err()
        {
            loop {
                std::thread::sleep(Duration::from_secs(60));
            }
        }
    }
}

fn memory() {
    let mut allocations = Vec::new();
    loop {
        let mut bytes = vec![0_u8; 1024 * 1024];
        for offset in (0..bytes.len()).step_by(4096) {
            bytes[offset] = 1;
        }
        allocations.push(bytes);
    }
}

fn cpu() {
    let mut value = 0_u64;
    loop {
        value = std::hint::black_box(value.wrapping_mul(6364136223846793005).wrapping_add(1));
    }
}

fn node_compatibility() {
    let executable = c"/usr/bin/node";
    let argument_zero = c"node";
    let check = c"--check";
    let source = c"/workspace/server.js";
    let arguments = [
        argument_zero.as_ptr(),
        check.as_ptr(),
        source.as_ptr(),
        std::ptr::null(),
    ];
    let environment = [
        c"LANG=C.UTF-8".as_ptr(),
        c"LC_ALL=C.UTF-8".as_ptr(),
        c"TMPDIR=/tmp".as_ptr(),
        std::ptr::null(),
    ];
    unsafe {
        libc::execve(
            executable.as_ptr(),
            arguments.as_ptr(),
            environment.as_ptr(),
        );
    }
    eprintln!(
        "fixed Node compatibility exec failed: {}",
        std::io::Error::last_os_error()
    );
    std::process::exit(72);
}

fn temporary_storage() {
    let mut file = File::create("/tmp/fill").expect("private /tmp exists");
    let bytes = [b't'; 1024 * 1024];
    loop {
        if file.write_all(&bytes).is_err() {
            println!("{}", serde_json::json!({"temporaryStorageLimited": true}));
            std::thread::sleep(Duration::from_secs(60));
        }
    }
}

fn file_size() {
    unsafe {
        libc::signal(libc::SIGXFSZ, libc::SIG_IGN);
    }
    let mut file = File::create("/tmp/large-file").expect("private /tmp exists");
    let bytes = [b'f'; 1024 * 1024];
    loop {
        if file.write_all(&bytes).is_err() {
            println!("{}", serde_json::json!({"fileSizeLimited": true}));
            std::process::exit(77);
        }
    }
}

fn open_files() {
    let mut files = Vec::new();
    for index in 0_u64.. {
        match File::open("/dev/null") {
            Ok(file) => files.push(file),
            Err(_) => {
                println!(
                    "{}",
                    serde_json::json!({"openFilesLimited": true, "opened": index})
                );
                std::thread::sleep(Duration::from_secs(60));
            }
        }
    }
}
