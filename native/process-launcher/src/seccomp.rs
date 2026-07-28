use std::collections::BTreeSet;
use std::fs::File;
use std::io::{Seek, SeekFrom, Write};
use std::os::fd::{AsRawFd, FromRawFd};

use serde::{Deserialize, Serialize};

use crate::{FoundationError, PROCESS_SECCOMP_POLICY_INVALID, Result, canonical_json_bytes};

pub(crate) const SECCOMP_POLICY_SCHEMA_VERSION: u32 = 1;

const REQUIRED_DENIED_SYSCALLS: &[&str] = &[
    "add_key",
    "bpf",
    "delete_module",
    "finit_module",
    "fsconfig",
    "fsmount",
    "fsopen",
    "fspick",
    "init_module",
    "io_uring_setup",
    "keyctl",
    "kexec_load",
    "mount",
    "mount_setattr",
    "move_mount",
    "open_by_handle_at",
    "perf_event_open",
    "pivot_root",
    "process_vm_readv",
    "process_vm_writev",
    "ptrace",
    "request_key",
    "setns",
    "umount2",
    "unshare",
    "userfaultfd",
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SeccompPolicy {
    pub version: u32,
    pub architecture: String,
    pub default_action: String,
    pub denied_action: String,
    pub deny_socket_creation: bool,
    pub denied_syscalls: Vec<String>,
}

impl SeccompPolicy {
    pub(crate) fn parse_canonical(bytes: &[u8]) -> Result<Self> {
        let policy: Self = serde_json::from_slice(bytes).map_err(|error| {
            FoundationError::new(
                PROCESS_SECCOMP_POLICY_INVALID,
                format!("seccomp policy is invalid: {error}"),
            )
        })?;
        policy.validate()?;
        if canonical_json_bytes(&policy)? != bytes {
            return Err(FoundationError::new(
                PROCESS_SECCOMP_POLICY_INVALID,
                "seccomp policy must use canonical JSON",
            ));
        }
        Ok(policy)
    }

    pub(crate) fn validate(&self) -> Result<()> {
        if self.version != SECCOMP_POLICY_SCHEMA_VERSION
            || self.architecture != "x86_64"
            || self.default_action != "allow"
            || self.denied_action != "errno_eperm"
            || !self.deny_socket_creation
        {
            return Err(FoundationError::new(
                PROCESS_SECCOMP_POLICY_INVALID,
                "seccomp policy must use the frozen x86_64 allow-by-default/EPERM contract",
            ));
        }
        if self
            .denied_syscalls
            .windows(2)
            .any(|pair| pair[0] >= pair[1])
        {
            return Err(FoundationError::new(
                PROCESS_SECCOMP_POLICY_INVALID,
                "seccomp deniedSyscalls must be unique and bytewise ordered",
            ));
        }
        let expected: BTreeSet<&str> = REQUIRED_DENIED_SYSCALLS.iter().copied().collect();
        let actual: BTreeSet<&str> = self.denied_syscalls.iter().map(String::as_str).collect();
        if actual != expected {
            return Err(FoundationError::new(
                PROCESS_SECCOMP_POLICY_INVALID,
                "seccomp deniedSyscalls must equal the frozen initial deny set",
            ));
        }
        Ok(())
    }

    pub(crate) fn compile_bpf(&self) -> Result<Vec<u8>> {
        self.validate()?;
        let mut instructions = Vec::new();
        // seccomp_data.arch
        push(&mut instructions, 0x20, 0, 0, 4);
        push(&mut instructions, 0x15, 1, 0, 0xc000_003e);
        push(&mut instructions, 0x06, 0, 0, 0x8000_0000);
        // seccomp_data.nr
        push(&mut instructions, 0x20, 0, 0, 0);
        for name in &self.denied_syscalls {
            let number = syscall_number(name).ok_or_else(|| {
                FoundationError::new(
                    PROCESS_SECCOMP_POLICY_INVALID,
                    format!("seccomp syscall is unsupported on x86_64: {name}"),
                )
            })?;
            push(&mut instructions, 0x15, 0, 1, number);
            push(&mut instructions, 0x06, 0, 0, 0x0005_0001);
        }
        // Deny socket(2) for every family. socketpair(2) remains available for
        // unnamed operation-local IPC.
        push(&mut instructions, 0x15, 0, 1, 41);
        push(&mut instructions, 0x06, 0, 0, 0x0005_0001);
        push(&mut instructions, 0x06, 0, 0, 0x7fff_0000);
        Ok(instructions)
    }

    pub(crate) fn compile_memfd(&self) -> Result<File> {
        let bytes = self.compile_bpf()?;
        let name = c"ticket-system-seccomp";
        let descriptor = unsafe {
            libc::memfd_create(name.as_ptr(), libc::MFD_CLOEXEC | libc::MFD_ALLOW_SEALING)
        };
        if descriptor < 0 {
            return Err(FoundationError::new(
                PROCESS_SECCOMP_POLICY_INVALID,
                format!(
                    "cannot create seccomp policy descriptor: {}",
                    std::io::Error::last_os_error()
                ),
            ));
        }
        let mut file = unsafe { File::from_raw_fd(descriptor) };
        file.write_all(&bytes).map_err(|error| {
            FoundationError::new(
                PROCESS_SECCOMP_POLICY_INVALID,
                format!("cannot populate seccomp policy descriptor: {error}"),
            )
        })?;
        file.seek(SeekFrom::Start(0)).map_err(|error| {
            FoundationError::new(
                PROCESS_SECCOMP_POLICY_INVALID,
                format!("cannot rewind seccomp policy descriptor: {error}"),
            )
        })?;
        let seals =
            libc::F_SEAL_SEAL | libc::F_SEAL_SHRINK | libc::F_SEAL_GROW | libc::F_SEAL_WRITE;
        if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_ADD_SEALS, seals) } != 0 {
            return Err(FoundationError::new(
                PROCESS_SECCOMP_POLICY_INVALID,
                format!(
                    "cannot seal seccomp policy descriptor: {}",
                    std::io::Error::last_os_error()
                ),
            ));
        }
        Ok(file)
    }
}

fn push(output: &mut Vec<u8>, code: u16, jt: u8, jf: u8, k: u32) {
    output.extend_from_slice(&code.to_ne_bytes());
    output.push(jt);
    output.push(jf);
    output.extend_from_slice(&k.to_ne_bytes());
}

fn syscall_number(name: &str) -> Option<u32> {
    Some(match name {
        "ptrace" => 101,
        "pivot_root" => 155,
        "mount" => 165,
        "umount2" => 166,
        "init_module" => 175,
        "delete_module" => 176,
        "kexec_load" => 246,
        "add_key" => 248,
        "request_key" => 249,
        "keyctl" => 250,
        "unshare" => 272,
        "perf_event_open" => 298,
        "open_by_handle_at" => 304,
        "setns" => 308,
        "process_vm_readv" => 310,
        "process_vm_writev" => 311,
        "finit_module" => 313,
        "bpf" => 321,
        "userfaultfd" => 323,
        "io_uring_setup" => 425,
        "move_mount" => 429,
        "fsopen" => 430,
        "fsconfig" => 431,
        "fsmount" => 432,
        "fspick" => 433,
        "mount_setattr" => 442,
        _ => return None,
    })
}
