use std::collections::BTreeMap;
use std::ffi::CString;
use std::fs::{self, File};
use std::io::Read;
use std::os::fd::{AsRawFd, FromRawFd, RawFd};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, mpsc};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::cgroup::{CgroupLimits, DelegatedCgroup, OperationCgroup};
use crate::launch_contract::{ExecutionResult, LaunchPlan};
use crate::materializer_client::AcquiredSnapshot;
use crate::seccomp::SeccompPolicy;
use crate::{
    FoundationError, PROCESS_CGROUP_MEMBERSHIP_FAILED, PROCESS_CGROUP_TERMINATION_FAILED,
    PROCESS_FAILED_TO_START, PROCESS_MOUNT_LAYOUT_INVALID, PROCESS_NAMESPACE_UNAVAILABLE,
    PROCESS_NETWORK_ISOLATION_UNAVAILABLE, PROCESS_OPERATION_TERMINATION_FAILED,
    PROCESS_SECCOMP_INSTALLATION_FAILED, PROCESS_SNAPSHOT_DESCRIPTOR_INVALID, Result,
    VerifiedRootfs, canonical_json_value_bytes, canonical_utc, sha256_bytes,
};

const BACKEND_FD: RawFd = 8;
const ROOTFS_FD: RawFd = 10;
const WORKSPACE_FD: RawFd = 11;
const SECCOMP_FD: RawFd = 12;
const STATUS_FD: RawFd = 14;
const CONSTRUCTION_GATE_FD: RawFd = 9;
const MONITOR_INTERVAL: Duration = Duration::from_millis(5);
const SETUP_TIMEOUT: Duration = Duration::from_secs(10);
const TRUSTED_OUTPUT_CAPTURE_MAX: usize = 64 * 1024;
pub(crate) const MOUNT_PLAN_VERSION: u32 = 1;

#[derive(Debug)]
pub(crate) struct ExecutionControl {
    pub cancel: AtomicBool,
}

impl ExecutionControl {
    pub(crate) fn new() -> Self {
        Self {
            cancel: AtomicBool::new(false),
        }
    }
}

pub(crate) struct ExecutionInputs<'a> {
    pub plan: &'a LaunchPlan,
    pub backend: &'a File,
    pub rootfs: &'a VerifiedRootfs,
    pub workspace: AcquiredSnapshot,
    pub seccomp_policy: &'a SeccompPolicy,
    pub cgroup: &'a DelegatedCgroup,
    pub control: Arc<ExecutionControl>,
    pub retain_trusted_output: bool,
    pub require_live_seccomp_observation: bool,
}

pub(crate) struct ExecutionArtifacts {
    pub result: ExecutionResult,
    pub trusted_stdout: Vec<u8>,
    pub trusted_stderr: Vec<u8>,
    pub namespaces: NamespaceEvidence,
    pub seccomp_mode: u32,
}

#[derive(Debug, Clone)]
pub(crate) struct NamespaceEvidence {
    pub mount_isolated: bool,
    pub pid_isolated: bool,
    pub network_isolated: bool,
    pub ipc_isolated: bool,
    pub uts_isolated: bool,
    pub cgroup_isolated: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
struct BubblewrapStatus {
    child_pid: i32,
    cgroup_namespace: u64,
    ipc_namespace: u64,
    mnt_namespace: u64,
    net_namespace: u64,
    pid_namespace: u64,
    uts_namespace: u64,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ForcedOutcome {
    Output,
    Timeout,
    Cancelled,
    ProcessCount,
    Memory,
}

pub(crate) fn execute(inputs: ExecutionInputs<'_>) -> Result<ExecutionArtifacts> {
    let enforcement_start = Instant::now();
    let started_seconds = unix_seconds()?;
    verify_workspace(&inputs.workspace, inputs.plan)?;
    inputs.rootfs.revalidate_identity()?;
    let relative_executable = inputs.plan.executable_identity.path.trim_start_matches('/');
    crate::verify_elf_identity(
        &inputs.rootfs.root,
        relative_executable,
        inputs
            .rootfs
            .regular_files
            .get(relative_executable)
            .ok_or_else(|| {
                FoundationError::new(
                    PROCESS_FAILED_TO_START,
                    "launch executable is absent from the verified rootfs",
                )
            })?
            .0,
        &inputs.plan.executable_identity.sha256,
    )?;

    let cgroup_name = format!(
        "operation-{}",
        inputs
            .plan
            .operation_identity
            .strip_prefix("process-operation:")
            .expect("validated operation identity")
    );
    let operation = inputs.cgroup.create_operation(
        &cgroup_name,
        CgroupLimits {
            cpu_quota_micros_per_100ms: inputs.plan.limits.cpu_quota_micros_per_100ms,
            memory_bytes: inputs.plan.limits.memory_bytes,
            max_processes: inputs.plan.limits.max_processes,
        },
    )?;
    let result = execute_in_operation(&inputs, &operation, enforcement_start, started_seconds);
    match result {
        Ok(artifacts) => Ok(artifacts),
        Err(error) => match operation.kill_and_remove() {
            Ok(()) => Err(error),
            Err(cleanup) => Err(cleanup),
        },
    }
}

fn execute_in_operation(
    inputs: &ExecutionInputs<'_>,
    operation: &OperationCgroup,
    enforcement_start: Instant,
    started_seconds: i64,
) -> Result<ExecutionArtifacts> {
    let root = inputs.rootfs.root.duplicate()?;
    let workspace = inputs.workspace.tree.try_clone().map_err(start_failed)?;
    let seccomp = inputs.seccomp_policy.compile_memfd()?;
    let stdin = File::open("/dev/null").map_err(start_failed)?;
    let stdout = pipe()?;
    let stderr = pipe()?;
    let construction = pipe()?;
    let status = pipe()?;
    let arguments = bubblewrap_arguments(inputs.plan)?;
    let argv: Vec<CString> = arguments
        .iter()
        .map(|argument| {
            CString::new(argument.as_bytes())
                .map_err(|_| start_invalid("Bubblewrap argument contains a NUL"))
        })
        .collect::<Result<_>>()?;
    let environment = [CString::new("LANG=C.UTF-8").expect("static environment")];
    let argv_ptrs = cstring_pointers(&argv);
    let environment_ptrs = cstring_pointers(&environment);
    let backend_exec = duplicate_fd_above(inputs.backend.as_raw_fd(), 64)?;
    let gate_exec = duplicate_fd_above(construction.read, 64)?;
    let rootfs_exec = duplicate_fd_above(root.as_raw_fd(), 64)?;
    let workspace_exec = duplicate_fd_above(workspace.as_raw_fd(), 64)?;
    let seccomp_exec = duplicate_fd_above(seccomp.as_raw_fd(), 64)?;
    let status_exec = duplicate_fd_above(status.write, 64)?;
    let stdin_exec = duplicate_fd_above(stdin.as_raw_fd(), 64)?;
    let stdout_exec = duplicate_fd_above(stdout.write, 64)?;
    let stderr_exec = duplicate_fd_above(stderr.write, 64)?;
    let launcher_pid = unsafe { libc::getpid() };

    let child = unsafe { libc::fork() };
    if child < 0 {
        return Err(start_failed(std::io::Error::last_os_error()));
    }
    if child == 0 {
        unsafe {
            libc::close(construction.write);
            libc::close(status.read);
            libc::close(stdout.read);
            libc::close(stderr.read);
            if libc::dup2(backend_exec.as_raw_fd(), BACKEND_FD) < 0
                || libc::fcntl(BACKEND_FD, libc::F_SETFD, libc::FD_CLOEXEC) < 0
                || libc::dup2(gate_exec.as_raw_fd(), CONSTRUCTION_GATE_FD) < 0
                || libc::dup2(rootfs_exec.as_raw_fd(), ROOTFS_FD) < 0
                || libc::dup2(workspace_exec.as_raw_fd(), WORKSPACE_FD) < 0
                || libc::dup2(seccomp_exec.as_raw_fd(), SECCOMP_FD) < 0
                || libc::dup2(status_exec.as_raw_fd(), STATUS_FD) < 0
                || libc::dup2(stdin_exec.as_raw_fd(), 0) < 0
                || libc::dup2(stdout_exec.as_raw_fd(), 1) < 0
                || libc::dup2(stderr_exec.as_raw_fd(), 2) < 0
                || libc::fcntl(CONSTRUCTION_GATE_FD, libc::F_SETFD, 0) < 0
                || libc::fcntl(ROOTFS_FD, libc::F_SETFD, 0) < 0
                || libc::fcntl(WORKSPACE_FD, libc::F_SETFD, 0) < 0
                || libc::fcntl(SECCOMP_FD, libc::F_SETFD, 0) < 0
                || libc::fcntl(STATUS_FD, libc::F_SETFD, 0) < 0
            {
                libc::_exit(125);
            }
            if apply_rlimits(inputs.plan) != 0 {
                libc::_exit(125);
            }
            if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0
                || libc::getppid() != launcher_pid
                || libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0
            {
                libc::_exit(125);
            }
            libc::close_range(15, u32::MAX, 0);
            let mut release = 0_u8;
            if libc::read(CONSTRUCTION_GATE_FD, (&mut release as *mut u8).cast(), 1) != 1 {
                libc::_exit(125);
            }
            libc::close(CONSTRUCTION_GATE_FD);
            libc::fexecve(BACKEND_FD, argv_ptrs.as_ptr(), environment_ptrs.as_ptr());
            libc::_exit(126);
        }
    }
    let mut child_guard = ChildGuard::new(child);
    drop((
        backend_exec,
        gate_exec,
        rootfs_exec,
        workspace_exec,
        seccomp_exec,
        status_exec,
        stdin_exec,
        stdout_exec,
        stderr_exec,
    ));

    close_fd(construction.read);
    close_fd(status.write);
    close_fd(stdout.write);
    close_fd(stderr.write);
    operation.add_process(child)?;
    operation.verify_member(child)?;
    verify_pre_execution_gate(operation, child)?;
    write_one(construction.write)?;
    close_fd(construction.write);

    let stdout_limit = inputs.plan.limits.max_output_bytes;
    let combined = Arc::new(AtomicU64::new(0));
    let exceeded = Arc::new(AtomicBool::new(false));
    let stdout_collector = collect_output(
        stdout.read,
        stdout_limit,
        combined.clone(),
        exceeded.clone(),
        inputs.retain_trusted_output,
    );
    let stderr_collector = collect_output(
        stderr.read,
        stdout_limit,
        combined.clone(),
        exceeded.clone(),
        inputs.retain_trusted_output,
    );

    let status_file = unsafe { File::from_raw_fd(status.read) };
    let (sender, receiver) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let mut reader = status_file;
        let mut document = Vec::new();
        let result = loop {
            let mut chunk = [0_u8; 4096];
            match reader.read(&mut chunk) {
                Ok(0) => {
                    break Err(start_invalid(
                        "Bubblewrap status channel closed before a complete setup document",
                    ));
                }
                Ok(read) => {
                    document.extend_from_slice(&chunk[..read]);
                    if document.len() > 64 * 1024 {
                        break Err(start_invalid("Bubblewrap status exceeds 65536 bytes"));
                    }
                    match serde_json::from_slice::<BubblewrapStatus>(&document) {
                        Ok(status) => break Ok(status),
                        Err(error) if error.is_eof() => {}
                        Err(error) => {
                            break Err(start_invalid(format!(
                                "Bubblewrap status is invalid: {error}"
                            )));
                        }
                    }
                }
                Err(error) => break Err(start_failed(error)),
            }
        };
        let _ = sender.send(result);
    });
    let setup_remaining = Duration::from_millis(inputs.plan.limits.wall_time_ms)
        .saturating_sub(enforcement_start.elapsed())
        .min(SETUP_TIMEOUT);
    let bubblewrap_status = match receiver.recv_timeout(setup_remaining) {
        Ok(result) => result?,
        Err(_) => {
            let members = operation
                .members()
                .unwrap_or_default()
                .into_iter()
                .map(|pid| {
                    let command = fs::read(format!("/proc/{pid}/cmdline"))
                        .ok()
                        .map(|bytes| {
                            String::from_utf8_lossy(&bytes)
                                .replace('\0', " ")
                                .trim()
                                .to_owned()
                        })
                        .unwrap_or_default();
                    let wait = fs::read_to_string(format!("/proc/{pid}/wchan"))
                        .unwrap_or_default()
                        .trim()
                        .to_owned();
                    format!("{pid}:{command}:{wait}")
                })
                .collect::<Vec<_>>()
                .join(",");
            operation.kill()?;
            let mut wait_status = 0;
            unsafe {
                libc::waitpid(child, &mut wait_status, 0);
            }
            child_guard.mark_reaped();
            operation.wait_empty()?;
            let _ = stdout_collector.join();
            let stderr = stderr_collector
                .join()
                .ok()
                .and_then(|value| value.ok())
                .map(|value| String::from_utf8_lossy(&value.retained).into_owned())
                .unwrap_or_default();
            return Err(FoundationError::new(
                PROCESS_FAILED_TO_START,
                format!(
                    "Bubblewrap did not establish the sandbox before the deadline; members={members}; stderr={stderr}"
                ),
            ));
        }
    };
    operation.verify_member(child)?;
    let namespaces = verify_namespaces(&bubblewrap_status)?;
    let pidfd = pidfd_open(child)?;
    let seccomp_observation = wait_for_seccomp_installed(operation, pidfd.as_raw_fd())?;
    if inputs.require_live_seccomp_observation && seccomp_observation.is_none() {
        return Err(FoundationError::new(
            PROCESS_SECCOMP_INSTALLATION_FAILED,
            "active containment probe exited before live seccomp observation",
        ));
    }
    if let Some((_, sandbox_pid)) = seccomp_observation {
        verify_resource_boundaries(sandbox_pid, inputs.plan)?;
    }
    let seccomp_mode = seccomp_observation.map_or(0, |(mode, _)| mode);
    let mut forced = None;
    let wait_status = loop {
        let events = operation.event_delta()?;
        if exceeded.load(Ordering::Acquire) {
            forced = Some(ForcedOutcome::Output);
        } else if inputs.control.cancel.load(Ordering::Acquire) {
            forced = Some(ForcedOutcome::Cancelled);
        } else if events.pids_max > 0 {
            forced = Some(ForcedOutcome::ProcessCount);
        } else if events.memory_oom_kill > 0 || events.memory_oom > 0 {
            forced = Some(ForcedOutcome::Memory);
        } else if enforcement_start.elapsed()
            >= Duration::from_millis(inputs.plan.limits.wall_time_ms)
        {
            forced = Some(ForcedOutcome::Timeout);
        }
        if forced.is_some() {
            operation.kill()?;
            let mut status = 0;
            if unsafe { libc::waitpid(child, &mut status, 0) } != child {
                return Err(FoundationError::new(
                    PROCESS_OPERATION_TERMINATION_FAILED,
                    "cannot reap a terminalized Bubblewrap operation",
                ));
            }
            child_guard.mark_reaped();
            break status;
        }
        if pidfd_ready(pidfd.as_raw_fd())? {
            let mut status = 0;
            if unsafe { libc::waitpid(child, &mut status, 0) } != child {
                return Err(FoundationError::new(
                    PROCESS_OPERATION_TERMINATION_FAILED,
                    "cannot reap the Bubblewrap operation process",
                ));
            }
            child_guard.mark_reaped();
            break status;
        }
        thread::sleep(MONITOR_INTERVAL);
    };
    if operation_is_populated(operation)? {
        operation.kill()?;
    }
    operation.wait_empty()?;
    let cgroup_events = operation.event_delta()?;
    operation.remove()?;
    let stdout = stdout_collector.join().map_err(|_| {
        FoundationError::new(
            PROCESS_OPERATION_TERMINATION_FAILED,
            "stdout collector panicked",
        )
    })??;
    let stderr = stderr_collector.join().map_err(|_| {
        FoundationError::new(
            PROCESS_OPERATION_TERMINATION_FAILED,
            "stderr collector panicked",
        )
    })??;
    if forced.is_none() && exceeded.load(Ordering::Acquire) {
        forced = Some(ForcedOutcome::Output);
    }

    let status = wait_status;
    let (terminal_outcome, resource_cause, enforcement_cause) =
        classify(status, forced, cgroup_events);
    let ended_seconds = unix_seconds()?;
    let result = ExecutionResult {
        operation_identity: inputs.plan.operation_identity.clone(),
        terminal_outcome,
        started_at: canonical_utc(started_seconds)?,
        ended_at: canonical_utc(ended_seconds)?,
        duration_ms: u64::try_from(enforcement_start.elapsed().as_millis()).unwrap_or(u64::MAX),
        exit_code: if libc::WIFEXITED(status) {
            Some(libc::WEXITSTATUS(status))
        } else {
            None
        },
        signal: if libc::WIFSIGNALED(status) {
            Some(libc::WTERMSIG(status))
        } else {
            None
        },
        stdout_bytes: stdout.bytes,
        stderr_bytes: stderr.bytes,
        combined_output_bytes: stdout.bytes.saturating_add(stderr.bytes),
        stdout_sha256: stdout.sha256,
        stderr_sha256: stderr.sha256,
        resource_cause,
        enforcement_cause,
        cpu_throttled_events: cgroup_events.cpu_throttled,
        launcher_environment: launcher_environment(),
    };
    Ok(ExecutionArtifacts {
        result,
        trusted_stdout: stdout.retained,
        trusted_stderr: stderr.retained,
        namespaces,
        seccomp_mode,
    })
}

struct ChildGuard {
    pid: libc::pid_t,
    reaped: bool,
}

impl ChildGuard {
    fn new(pid: libc::pid_t) -> Self {
        Self { pid, reaped: false }
    }

    fn mark_reaped(&mut self) {
        self.reaped = true;
    }
}

impl Drop for ChildGuard {
    fn drop(&mut self) {
        if self.reaped {
            return;
        }
        unsafe {
            libc::kill(self.pid, libc::SIGKILL);
            let mut status = 0;
            while libc::waitpid(self.pid, &mut status, 0) < 0 {
                if std::io::Error::last_os_error().raw_os_error() != Some(libc::EINTR) {
                    break;
                }
            }
        }
    }
}

fn duplicate_fd_above(descriptor: RawFd, minimum: RawFd) -> Result<File> {
    let duplicate = unsafe { libc::fcntl(descriptor, libc::F_DUPFD_CLOEXEC, minimum) };
    if duplicate < 0 {
        return Err(start_failed(std::io::Error::last_os_error()));
    }
    Ok(unsafe { File::from_raw_fd(duplicate) })
}

fn bubblewrap_arguments(plan: &LaunchPlan) -> Result<Vec<String>> {
    let working_directory = if plan.working_directory == "." {
        "/workspace".to_owned()
    } else {
        format!("/workspace/{}", plan.working_directory)
    };
    if working_directory.contains("/../") || working_directory.ends_with("/..") {
        return Err(FoundationError::new(
            PROCESS_MOUNT_LAYOUT_INVALID,
            "working directory escapes the immutable workspace mount",
        ));
    }
    let mut arguments = vec![
        "bwrap".into(),
        "--unshare-user".into(),
        "--unshare-ipc".into(),
        "--unshare-pid".into(),
        "--unshare-net".into(),
        "--unshare-uts".into(),
        "--unshare-cgroup".into(),
        "--disable-userns".into(),
        "--assert-userns-disabled".into(),
        "--die-with-parent".into(),
        "--new-session".into(),
        "--clearenv".into(),
        "--cap-drop".into(),
        "ALL".into(),
        "--ro-bind-fd".into(),
        ROOTFS_FD.to_string(),
        "/".into(),
        "--ro-bind-fd".into(),
        WORKSPACE_FD.to_string(),
        "/workspace".into(),
        "--proc".into(),
        "/proc".into(),
        "--dev".into(),
        "/dev".into(),
        "--size".into(),
        plan.limits.max_temp_bytes.to_string(),
        "--tmpfs".into(),
        "/tmp".into(),
        "--chdir".into(),
        working_directory,
        "--seccomp".into(),
        SECCOMP_FD.to_string(),
        "--json-status-fd".into(),
        STATUS_FD.to_string(),
    ];
    for (name, value) in launcher_environment()
        .into_iter()
        .chain(plan.environment.clone())
    {
        arguments.push("--setenv".into());
        arguments.push(name);
        arguments.push(value);
    }
    arguments.push("--".into());
    arguments.push(plan.executable_identity.path.clone());
    arguments.extend(plan.arguments.clone());
    Ok(arguments)
}

fn launcher_environment() -> BTreeMap<String, String> {
    BTreeMap::from([
        ("LANG".into(), "C.UTF-8".into()),
        ("LC_ALL".into(), "C.UTF-8".into()),
        ("TMPDIR".into(), "/tmp".into()),
    ])
}

fn apply_rlimits(plan: &LaunchPlan) -> i32 {
    unsafe fn set(resource: libc::__rlimit_resource_t, value: u64) -> bool {
        let limit = libc::rlimit {
            rlim_cur: value,
            rlim_max: value,
        };
        unsafe { libc::setrlimit(resource, &limit) == 0 }
    }
    let ok = unsafe {
        set(libc::RLIMIT_NOFILE, plan.limits.max_open_files)
            && set(libc::RLIMIT_FSIZE, plan.limits.max_file_bytes)
            && set(libc::RLIMIT_CORE, 0)
    };
    if ok { 0 } else { -1 }
}

fn verify_workspace(snapshot: &AcquiredSnapshot, plan: &LaunchPlan) -> Result<()> {
    let mut manifest = snapshot.manifest.try_clone().map_err(start_failed)?;
    let mut bytes = Vec::new();
    manifest.read_to_end(&mut bytes).map_err(start_failed)?;
    if sha256_bytes(&bytes) != plan.workspace_snapshot.manifest_sha256 {
        return Err(FoundationError::new(
            PROCESS_SNAPSHOT_DESCRIPTOR_INVALID,
            "workspace manifest descriptor hash changed after handoff",
        ));
    }
    let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|error| {
        FoundationError::new(
            PROCESS_SNAPSHOT_DESCRIPTOR_INVALID,
            format!("workspace manifest is invalid: {error}"),
        )
    })?;
    if canonical_json_value_bytes(&value) != bytes {
        return Err(FoundationError::new(
            PROCESS_SNAPSHOT_DESCRIPTOR_INVALID,
            "workspace manifest is not canonical JSON",
        ));
    }
    let entries = value
        .get("entries")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| {
            FoundationError::new(
                PROCESS_SNAPSHOT_DESCRIPTOR_INVALID,
                "workspace manifest entries are missing",
            )
        })?;
    if entries.len() as u64 != plan.workspace_snapshot.file_count {
        return Err(FoundationError::new(
            PROCESS_SNAPSHOT_DESCRIPTOR_INVALID,
            "workspace manifest entry count does not match launch authority",
        ));
    }
    let root = PathBuf::from(format!("/proc/self/fd/{}", snapshot.tree.as_raw_fd()));
    let mut total = 0_u64;
    let mut observed = BTreeMap::new();
    scan_workspace(&root, &root, &mut observed, &mut total)?;
    if observed.len() != entries.len() || total != plan.workspace_snapshot.total_bytes {
        return Err(FoundationError::new(
            PROCESS_SNAPSHOT_DESCRIPTOR_INVALID,
            "workspace tree count or bytes do not match launch authority",
        ));
    }
    for entry in entries {
        let path = entry
            .get("path")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| {
                FoundationError::new(
                    PROCESS_SNAPSHOT_DESCRIPTOR_INVALID,
                    "workspace entry path is invalid",
                )
            })?;
        let canonical = serde_json::to_string(entry).map_err(|error| {
            FoundationError::new(PROCESS_SNAPSHOT_DESCRIPTOR_INVALID, error.to_string())
        })?;
        if observed.get(path) != Some(&canonical) {
            return Err(FoundationError::new(
                PROCESS_SNAPSHOT_DESCRIPTOR_INVALID,
                format!("workspace descriptor entry does not match sealed bytes: {path}"),
            ));
        }
    }
    Ok(())
}

fn scan_workspace(
    root: &Path,
    directory: &Path,
    observed: &mut BTreeMap<String, String>,
    total: &mut u64,
) -> Result<()> {
    let mut entries: Vec<_> = fs::read_dir(directory)
        .map_err(start_failed)?
        .collect::<std::result::Result<_, _>>()
        .map_err(start_failed)?;
    entries.sort_by(|left, right| {
        left.file_name()
            .as_encoded_bytes()
            .cmp(right.file_name().as_encoded_bytes())
    });
    for entry in entries {
        let metadata = fs::symlink_metadata(entry.path()).map_err(start_failed)?;
        let entry_path = entry.path();
        let relative = entry_path.strip_prefix(root).map_err(|_| {
            FoundationError::new(
                PROCESS_SNAPSHOT_DESCRIPTOR_INVALID,
                "workspace path escaped descriptor root",
            )
        })?;
        let relative = relative
            .to_str()
            .ok_or_else(|| {
                FoundationError::new(
                    PROCESS_SNAPSHOT_DESCRIPTOR_INVALID,
                    "workspace path is not UTF-8",
                )
            })?
            .replace('\\', "/");
        if metadata.file_type().is_symlink() || (!metadata.is_dir() && !metadata.is_file()) {
            return Err(FoundationError::new(
                PROCESS_SNAPSHOT_DESCRIPTOR_INVALID,
                "workspace descriptor contains a symbolic link or special file",
            ));
        }
        if metadata.is_dir() {
            if metadata.mode() & 0o7777 != 0o550 {
                return Err(FoundationError::new(
                    PROCESS_SNAPSHOT_DESCRIPTOR_INVALID,
                    "workspace directory mode is not normalized",
                ));
            }
            observed.insert(
                relative.clone(),
                format!(
                    "{{\"mode\":\"0550\",\"path\":{},\"type\":\"directory\"}}",
                    serde_json::to_string(&relative).expect("path string")
                ),
            );
            scan_workspace(root, &entry.path(), observed, total)?;
        } else {
            if metadata.mode() & 0o7777 != 0o440 {
                return Err(FoundationError::new(
                    PROCESS_SNAPSHOT_DESCRIPTOR_INVALID,
                    "workspace file mode is not normalized",
                ));
            }
            let mut file = File::open(entry.path()).map_err(start_failed)?;
            let mut hash = Sha256::new();
            let bytes =
                std::io::copy(&mut file, &mut HashWriter(&mut hash)).map_err(start_failed)?;
            *total = total.saturating_add(bytes);
            let digest = format!("{:x}", hash.finalize());
            observed.insert(
                relative.clone(),
                format!(
                    "{{\"mode\":\"0440\",\"path\":{},\"sha256\":\"{}\",\"size\":{},\"type\":\"regular_file\"}}",
                    serde_json::to_string(&relative).expect("path string"),
                    digest,
                    bytes
                ),
            );
        }
    }
    Ok(())
}

struct HashWriter<'a>(&'a mut Sha256);
impl std::io::Write for HashWriter<'_> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.update(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

struct Pipe {
    read: RawFd,
    write: RawFd,
}

fn pipe() -> Result<Pipe> {
    let mut values = [0; 2];
    if unsafe { libc::pipe2(values.as_mut_ptr(), libc::O_CLOEXEC) } != 0 {
        return Err(start_failed(std::io::Error::last_os_error()));
    }
    Ok(Pipe {
        read: values[0],
        write: values[1],
    })
}

fn close_fd(descriptor: RawFd) {
    unsafe {
        libc::close(descriptor);
    }
}

fn write_one(descriptor: RawFd) -> Result<()> {
    let byte = [1_u8];
    if unsafe { libc::write(descriptor, byte.as_ptr().cast(), 1) } != 1 {
        return Err(start_failed(std::io::Error::last_os_error()));
    }
    Ok(())
}

struct CollectedOutput {
    bytes: u64,
    sha256: String,
    retained: Vec<u8>,
}

fn collect_output(
    descriptor: RawFd,
    limit: u64,
    combined: Arc<AtomicU64>,
    exceeded: Arc<AtomicBool>,
    retain: bool,
) -> thread::JoinHandle<Result<CollectedOutput>> {
    thread::spawn(move || {
        let mut file = unsafe { File::from_raw_fd(descriptor) };
        let mut hash = Sha256::new();
        let mut bytes = 0_u64;
        let mut buffer = [0_u8; 16 * 1024];
        let mut retained = Vec::new();
        loop {
            let read = file.read(&mut buffer).map_err(start_failed)?;
            if read == 0 {
                break;
            }
            let chunk = &buffer[..read];
            bytes = bytes.saturating_add(read as u64);
            hash.update(chunk);
            let previous = combined.fetch_add(read as u64, Ordering::AcqRel);
            if previous.saturating_add(read as u64) > limit {
                exceeded.store(true, Ordering::Release);
            }
            if retain && retained.len() < TRUSTED_OUTPUT_CAPTURE_MAX {
                let remaining = TRUSTED_OUTPUT_CAPTURE_MAX - retained.len();
                retained.extend_from_slice(&chunk[..chunk.len().min(remaining)]);
            }
        }
        Ok(CollectedOutput {
            bytes,
            sha256: format!("{:x}", hash.finalize()),
            retained,
        })
    })
}

fn cstring_pointers(values: &[CString]) -> Vec<*const libc::c_char> {
    let mut pointers: Vec<_> = values.iter().map(|value| value.as_ptr()).collect();
    pointers.push(std::ptr::null());
    pointers
}

fn pidfd_open(pid: libc::pid_t) -> Result<File> {
    let descriptor = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) as RawFd };
    if descriptor < 0 {
        return Err(FoundationError::new(
            PROCESS_FAILED_TO_START,
            format!(
                "pidfd_open is unavailable: {}",
                std::io::Error::last_os_error()
            ),
        ));
    }
    Ok(unsafe { File::from_raw_fd(descriptor) })
}

fn pidfd_ready(descriptor: RawFd) -> Result<bool> {
    let mut pollfd = libc::pollfd {
        fd: descriptor,
        events: libc::POLLIN,
        revents: 0,
    };
    let result = unsafe { libc::poll(&mut pollfd, 1, 0) };
    if result < 0 {
        return Err(FoundationError::new(
            PROCESS_OPERATION_TERMINATION_FAILED,
            format!("pidfd poll failed: {}", std::io::Error::last_os_error()),
        ));
    }
    Ok(result > 0)
}

fn verify_pre_execution_gate(operation: &OperationCgroup, pid: i32) -> Result<()> {
    if operation.members()? != [pid] {
        return Err(FoundationError::new(
            PROCESS_CGROUP_MEMBERSHIP_FAILED,
            "the pre-execution cgroup contains an unexpected descendant",
        ));
    }
    let child = fs::metadata(format!("/proc/{pid}/exe")).map_err(start_failed)?;
    let launcher = fs::metadata("/proc/self/exe").map_err(start_failed)?;
    if (child.dev(), child.ino()) != (launcher.dev(), launcher.ino()) {
        return Err(FoundationError::new(
            PROCESS_CGROUP_MEMBERSHIP_FAILED,
            "the blocked pre-execution child is not the trusted launcher image",
        ));
    }
    Ok(())
}

fn verify_namespaces(status: &BubblewrapStatus) -> Result<NamespaceEvidence> {
    let host = NamespaceInodes::read("/proc/self/ns")?;
    let child = NamespaceInodes::read(format!("/proc/{}/ns", status.child_pid))?;
    let evidence = NamespaceEvidence {
        mount_isolated: host.mount != child.mount && child.mount == status.mnt_namespace,
        pid_isolated: host.pid != child.pid && child.pid == status.pid_namespace,
        network_isolated: host.network != child.network && child.network == status.net_namespace,
        ipc_isolated: host.ipc != child.ipc && child.ipc == status.ipc_namespace,
        uts_isolated: host.uts != child.uts && child.uts == status.uts_namespace,
        cgroup_isolated: host.cgroup != child.cgroup && child.cgroup == status.cgroup_namespace,
    };
    if !evidence.mount_isolated
        || !evidence.pid_isolated
        || !evidence.ipc_isolated
        || !evidence.uts_isolated
        || !evidence.cgroup_isolated
    {
        return Err(FoundationError::new(
            PROCESS_NAMESPACE_UNAVAILABLE,
            "Bubblewrap did not establish every required namespace",
        ));
    }
    if !evidence.network_isolated {
        return Err(FoundationError::new(
            PROCESS_NETWORK_ISOLATION_UNAVAILABLE,
            "Bubblewrap did not establish a fresh network namespace",
        ));
    }
    Ok(evidence)
}

fn verify_resource_boundaries(pid: i32, plan: &LaunchPlan) -> Result<()> {
    let limits = fs::read_to_string(format!("/proc/{pid}/limits")).map_err(start_failed)?;
    for (label, expected) in [
        ("Max open files", plan.limits.max_open_files),
        ("Max file size", plan.limits.max_file_bytes),
    ] {
        let actual = limits
            .lines()
            .find_map(|line| {
                line.strip_prefix(label)
                    .and_then(|rest| rest.split_whitespace().next())
                    .and_then(|value| value.parse::<u64>().ok())
            })
            .ok_or_else(|| start_invalid(format!("cannot inspect {label} on sandbox child")))?;
        if actual != expected {
            return Err(FoundationError::new(
                PROCESS_FAILED_TO_START,
                format!("{label} is {actual}, expected {expected} before profile execution"),
            ));
        }
    }
    let temporary = CString::new(format!("/proc/{pid}/root/tmp"))
        .map_err(|_| start_invalid("temporary mount inspection path contains a NUL"))?;
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(temporary.as_ptr(), &mut stat) } != 0 {
        return Err(start_failed(std::io::Error::last_os_error()));
    }
    let capacity = (stat.f_blocks as u128).saturating_mul(stat.f_frsize as u128);
    let expected = plan.limits.max_temp_bytes as u128;
    let page = stat.f_frsize.max(4096) as u128;
    if capacity < expected || capacity > expected.saturating_add(page) {
        return Err(FoundationError::new(
            PROCESS_FAILED_TO_START,
            format!(
                "private /tmp capacity is {capacity}, outside the bounded {expected}-byte policy"
            ),
        ));
    }
    Ok(())
}

struct NamespaceInodes {
    mount: u64,
    pid: u64,
    network: u64,
    ipc: u64,
    uts: u64,
    cgroup: u64,
}

impl NamespaceInodes {
    fn read(root: impl AsRef<Path>) -> Result<Self> {
        let root = root.as_ref();
        Ok(Self {
            mount: ns_inode(root.join("mnt"))?,
            pid: ns_inode(root.join("pid"))?,
            network: ns_inode(root.join("net"))?,
            ipc: ns_inode(root.join("ipc"))?,
            uts: ns_inode(root.join("uts"))?,
            cgroup: ns_inode(root.join("cgroup"))?,
        })
    }
}

fn ns_inode(path: PathBuf) -> Result<u64> {
    Ok(fs::metadata(path).map_err(start_failed)?.ino())
}

fn wait_for_seccomp_installed(
    operation: &OperationCgroup,
    top_level_pidfd: RawFd,
) -> Result<Option<(u32, i32)>> {
    let deadline = Instant::now() + Duration::from_secs(2);
    let mut observed = 0;
    while Instant::now() < deadline {
        for pid in operation.members()? {
            if let Ok(status) = fs::read_to_string(format!("/proc/{pid}/status")) {
                observed = status
                    .lines()
                    .find_map(|line| line.strip_prefix("Seccomp:").map(str::trim))
                    .and_then(|value| value.parse::<u32>().ok())
                    .unwrap_or(0);
                if observed == 2 {
                    return Ok(Some((observed, pid)));
                }
            }
        }
        if pidfd_ready(top_level_pidfd)? {
            return Ok(None);
        }
        thread::sleep(Duration::from_millis(1));
    }
    Err(FoundationError::new(
        PROCESS_SECCOMP_INSTALLATION_FAILED,
        format!(
            "sandbox child did not enter seccomp filter mode before execution monitoring (observed {observed})"
        ),
    ))
}

fn operation_is_populated(operation: &OperationCgroup) -> Result<bool> {
    let contents = fs::read_to_string(operation.path().join("cgroup.events")).map_err(|error| {
        FoundationError::new(
            PROCESS_CGROUP_TERMINATION_FAILED,
            format!("cannot read operation cgroup events: {error}"),
        )
    })?;
    Ok(contents
        .lines()
        .find_map(|line| line.strip_prefix("populated "))
        .is_none_or(|value| value.trim() != "0"))
}

fn classify(
    status: i32,
    forced: Option<ForcedOutcome>,
    events: crate::cgroup::CgroupEvents,
) -> (String, Option<String>, Option<String>) {
    match forced {
        Some(ForcedOutcome::Output) => (
            "output_limit_exceeded".into(),
            None,
            Some("combined_output_bytes".into()),
        ),
        Some(ForcedOutcome::Timeout) => ("timed_out".into(), None, Some("wall_time".into())),
        Some(ForcedOutcome::Cancelled) => (
            "cancelled".into(),
            None,
            Some("runtime_cancellation".into()),
        ),
        Some(ForcedOutcome::ProcessCount) => (
            "resource_limit_exceeded".into(),
            Some("process_count".into()),
            Some("pids.events:max".into()),
        ),
        Some(ForcedOutcome::Memory) => (
            "resource_limit_exceeded".into(),
            Some("memory".into()),
            Some("memory.events.local:oom".into()),
        ),
        None if events.memory_oom_kill > 0 => (
            "resource_limit_exceeded".into(),
            Some("memory".into()),
            Some("memory.events.local:oom_kill".into()),
        ),
        None if events.pids_max > 0 => (
            "resource_limit_exceeded".into(),
            Some("process_count".into()),
            Some("pids.events:max".into()),
        ),
        None if libc::WIFSIGNALED(status) && libc::WTERMSIG(status) == libc::SIGXFSZ => (
            "resource_limit_exceeded".into(),
            Some("file_size".into()),
            Some("SIGXFSZ".into()),
        ),
        None if libc::WIFEXITED(status) && libc::WEXITSTATUS(status) == 0 => {
            ("completed".into(), None, None)
        }
        None if libc::WIFEXITED(status) => ("exited_nonzero".into(), None, None),
        None => ("signaled".into(), None, None),
    }
}

fn unix_seconds() -> Result<i64> {
    i64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| start_invalid("system time precedes Unix epoch"))?
            .as_secs(),
    )
    .map_err(|_| start_invalid("system time exceeds supported range"))
}

fn start_failed(error: std::io::Error) -> FoundationError {
    FoundationError::new(
        PROCESS_FAILED_TO_START,
        format!("sandbox process failed to start: {error}"),
    )
}

fn start_invalid(message: impl Into<String>) -> FoundationError {
    FoundationError::new(PROCESS_FAILED_TO_START, message)
}
