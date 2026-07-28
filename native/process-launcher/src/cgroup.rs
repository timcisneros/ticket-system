use std::collections::BTreeSet;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::{
    FoundationError, PROCESS_CGROUP_CONTROLLER_UNAVAILABLE, PROCESS_CGROUP_DELEGATION_UNAVAILABLE,
    PROCESS_CGROUP_LIMIT_UNAVAILABLE, PROCESS_CGROUP_MEMBERSHIP_FAILED,
    PROCESS_CGROUP_TERMINATION_FAILED, Result, sha256_json,
};

const REQUIRED_CONTROLLERS: &[&str] = &["cpu", "memory", "pids"];
const CGROUP_WAIT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DelegatedCgroupIdentity {
    pub service_cgroup: String,
    pub device: u64,
    pub inode: u64,
    pub owner_uid: u32,
    pub owner_gid: u32,
    pub enabled_controllers: Vec<String>,
}

#[derive(Debug)]
pub(crate) struct DelegatedCgroup {
    root: PathBuf,
    _control: PathBuf,
    identity: DelegatedCgroupIdentity,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct CgroupLimits {
    pub cpu_quota_micros_per_100ms: u64,
    pub memory_bytes: u64,
    pub max_processes: u64,
}

#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct CgroupEvents {
    pub pids_max: u64,
    pub memory_oom: u64,
    pub memory_oom_kill: u64,
    pub cpu_throttled: u64,
}

#[derive(Debug)]
pub(crate) struct OperationCgroup {
    path: PathBuf,
    before: CgroupEvents,
}

impl DelegatedCgroup {
    pub(crate) fn discover_and_activate() -> Result<Self> {
        let relative = discover_self_cgroup()?;
        let root = Path::new("/sys/fs/cgroup").join(relative.trim_start_matches('/'));
        verify_cgroup2(&root)?;
        let metadata = fs::metadata(&root).map_err(delegation)?;
        let available = read_words(root.join("cgroup.controllers"))?;
        for required in REQUIRED_CONTROLLERS {
            if !available.contains(*required) {
                return Err(FoundationError::new(
                    PROCESS_CGROUP_CONTROLLER_UNAVAILABLE,
                    format!("delegated service cgroup lacks controller: {required}"),
                ));
            }
        }

        let control = root.join("launcher-control");
        match fs::create_dir(&control) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(delegation(error)),
        }
        write_value(
            control.join("cgroup.procs"),
            &unsafe { libc::getpid() }.to_string(),
            PROCESS_CGROUP_MEMBERSHIP_FAILED,
        )?;
        let mut controls = String::new();
        for controller in REQUIRED_CONTROLLERS {
            controls.push('+');
            controls.push_str(controller);
            controls.push(' ');
        }
        write_value(
            root.join("cgroup.subtree_control"),
            controls.trim_end(),
            PROCESS_CGROUP_CONTROLLER_UNAVAILABLE,
        )?;
        let enabled = read_words(root.join("cgroup.subtree_control"))?;
        for required in REQUIRED_CONTROLLERS {
            if !enabled.contains(*required) {
                return Err(FoundationError::new(
                    PROCESS_CGROUP_CONTROLLER_UNAVAILABLE,
                    format!("cannot enable delegated cgroup controller: {required}"),
                ));
            }
        }
        let mut enabled_controllers: Vec<String> = enabled.into_iter().collect();
        enabled_controllers.sort_by(|left, right| left.as_bytes().cmp(right.as_bytes()));
        let identity = DelegatedCgroupIdentity {
            service_cgroup: format!("/{}", relative.trim_start_matches('/')),
            device: metadata.dev(),
            inode: metadata.ino(),
            owner_uid: metadata.uid(),
            owner_gid: metadata.gid(),
            enabled_controllers,
        };
        let delegated = Self {
            root,
            _control: control,
            identity,
        };
        delegated.cleanup_stale_operations()?;
        delegated.active_delegation_probe()?;
        Ok(delegated)
    }

    pub(crate) fn identity(&self) -> &DelegatedCgroupIdentity {
        &self.identity
    }

    pub(crate) fn identity_hash(&self) -> Result<String> {
        sha256_json(&self.identity)
    }

    pub(crate) fn create_operation(
        &self,
        name: &str,
        limits: CgroupLimits,
    ) -> Result<OperationCgroup> {
        if !name.starts_with("operation-") && !name.starts_with("probe-") {
            return Err(FoundationError::new(
                PROCESS_CGROUP_DELEGATION_UNAVAILABLE,
                "operation cgroup name is not launcher-derived",
            ));
        }
        let path = self.root.join(name);
        fs::create_dir(&path).map_err(delegation)?;
        let operation = OperationCgroup {
            before: read_events(&path)?,
            path,
        };
        if let Err(error) = operation.apply_limits(limits) {
            let _ = operation.kill_and_remove();
            return Err(error);
        }
        Ok(operation)
    }

    fn active_delegation_probe(&self) -> Result<()> {
        let name = format!("probe-delegation-{}", unsafe { libc::getpid() });
        let operation = self.create_operation(
            &name,
            CgroupLimits {
                cpu_quota_micros_per_100ms: 50_000,
                memory_bytes: 64 * 1024 * 1024,
                max_processes: 8,
            },
        )?;
        let mut gate = [0; 2];
        if unsafe { libc::pipe2(gate.as_mut_ptr(), libc::O_CLOEXEC) } != 0 {
            let _ = operation.kill_and_remove();
            return Err(FoundationError::new(
                PROCESS_CGROUP_MEMBERSHIP_FAILED,
                format!(
                    "cannot create cgroup probe gate: {}",
                    std::io::Error::last_os_error()
                ),
            ));
        }
        let child = unsafe { libc::fork() };
        if child < 0 {
            unsafe {
                libc::close(gate[0]);
                libc::close(gate[1]);
            }
            let _ = operation.kill_and_remove();
            return Err(FoundationError::new(
                PROCESS_CGROUP_MEMBERSHIP_FAILED,
                format!(
                    "cannot fork trusted cgroup probe: {}",
                    std::io::Error::last_os_error()
                ),
            ));
        }
        if child == 0 {
            unsafe {
                libc::close(gate[1]);
                let mut byte = 0_u8;
                libc::read(gate[0], (&mut byte as *mut u8).cast(), 1);
                libc::_exit(0);
            }
        }
        unsafe {
            libc::close(gate[0]);
        }
        let result = (|| {
            operation.add_process(child)?;
            operation.verify_member(child)?;
            operation.kill()?;
            wait_pid(child)?;
            operation.wait_empty()
        })();
        unsafe {
            libc::close(gate[1]);
        }
        let cleanup = operation.remove();
        result.and(cleanup)
    }

    fn cleanup_stale_operations(&self) -> Result<()> {
        for entry in fs::read_dir(&self.root).map_err(delegation)? {
            let entry = entry.map_err(delegation)?;
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            if !(name.starts_with("operation-") || name.starts_with("probe-")) {
                continue;
            }
            let operation = OperationCgroup {
                path: entry.path(),
                before: CgroupEvents::default(),
            };
            operation.kill_and_remove()?;
        }
        Ok(())
    }
}

impl OperationCgroup {
    fn apply_limits(&self, limits: CgroupLimits) -> Result<()> {
        let cpu = format!("{} 100000", limits.cpu_quota_micros_per_100ms);
        write_readback(self.path.join("cpu.max"), &cpu)?;
        write_readback(
            self.path.join("memory.max"),
            &limits.memory_bytes.to_string(),
        )?;
        write_readback(self.path.join("memory.swap.max"), "0")?;
        write_readback(
            self.path.join("pids.max"),
            &limits.max_processes.to_string(),
        )?;
        Ok(())
    }

    pub(crate) fn add_process(&self, pid: libc::pid_t) -> Result<()> {
        write_value(
            self.path.join("cgroup.procs"),
            &pid.to_string(),
            PROCESS_CGROUP_MEMBERSHIP_FAILED,
        )
    }

    pub(crate) fn verify_member(&self, pid: libc::pid_t) -> Result<()> {
        let members = fs::read_to_string(self.path.join("cgroup.procs")).map_err(|error| {
            FoundationError::new(
                PROCESS_CGROUP_MEMBERSHIP_FAILED,
                format!("cannot read operation cgroup membership: {error}"),
            )
        })?;
        if !members.lines().any(|line| line.trim() == pid.to_string()) {
            return Err(FoundationError::new(
                PROCESS_CGROUP_MEMBERSHIP_FAILED,
                "blocked child is not present in the operation cgroup",
            ));
        }
        Ok(())
    }

    pub(crate) fn members(&self) -> Result<Vec<libc::pid_t>> {
        fs::read_to_string(self.path.join("cgroup.procs"))
            .map_err(|error| {
                FoundationError::new(
                    PROCESS_CGROUP_MEMBERSHIP_FAILED,
                    format!("cannot read operation cgroup membership: {error}"),
                )
            })?
            .lines()
            .map(|line| {
                line.trim().parse::<libc::pid_t>().map_err(|_| {
                    FoundationError::new(
                        PROCESS_CGROUP_MEMBERSHIP_FAILED,
                        "operation cgroup contains an invalid PID",
                    )
                })
            })
            .collect()
    }

    pub(crate) fn kill(&self) -> Result<()> {
        write_value(
            self.path.join("cgroup.kill"),
            "1",
            PROCESS_CGROUP_TERMINATION_FAILED,
        )
    }

    pub(crate) fn wait_empty(&self) -> Result<()> {
        let deadline = Instant::now() + CGROUP_WAIT;
        while Instant::now() < deadline {
            if !cgroup_populated(&self.path)? {
                return Ok(());
            }
            thread::sleep(Duration::from_millis(10));
        }
        Err(FoundationError::new(
            PROCESS_CGROUP_TERMINATION_FAILED,
            "operation cgroup did not reach populated 0",
        ))
    }

    pub(crate) fn events(&self) -> Result<CgroupEvents> {
        read_events(&self.path)
    }

    pub(crate) fn event_delta(&self) -> Result<CgroupEvents> {
        let after = self.events()?;
        Ok(CgroupEvents {
            pids_max: after.pids_max.saturating_sub(self.before.pids_max),
            memory_oom: after.memory_oom.saturating_sub(self.before.memory_oom),
            memory_oom_kill: after
                .memory_oom_kill
                .saturating_sub(self.before.memory_oom_kill),
            cpu_throttled: after
                .cpu_throttled
                .saturating_sub(self.before.cpu_throttled),
        })
    }

    pub(crate) fn remove(&self) -> Result<()> {
        fs::remove_dir(&self.path).map_err(|error| {
            FoundationError::new(
                PROCESS_CGROUP_TERMINATION_FAILED,
                format!("cannot remove empty operation cgroup: {error}"),
            )
        })
    }

    pub(crate) fn kill_and_remove(&self) -> Result<()> {
        if cgroup_populated(&self.path)? {
            self.kill()?;
            self.wait_empty()?;
        }
        self.remove()
    }

    pub(crate) fn path(&self) -> &Path {
        &self.path
    }
}

fn discover_self_cgroup() -> Result<String> {
    let contents = fs::read_to_string("/proc/self/cgroup").map_err(delegation)?;
    let entries: Vec<&str> = contents.lines().collect();
    if entries.len() != 1 {
        return Err(FoundationError::new(
            PROCESS_CGROUP_DELEGATION_UNAVAILABLE,
            "process is not in one cgroup-v2 unified hierarchy",
        ));
    }
    let mut fields = entries[0].splitn(3, ':');
    if fields.next() != Some("0") || fields.next() != Some("") {
        return Err(FoundationError::new(
            PROCESS_CGROUP_DELEGATION_UNAVAILABLE,
            "process cgroup record is not cgroup-v2 unified format",
        ));
    }
    let path = fields.next().unwrap_or_default();
    if !path.starts_with('/') || path.contains("..") {
        return Err(FoundationError::new(
            PROCESS_CGROUP_DELEGATION_UNAVAILABLE,
            "process cgroup path is invalid",
        ));
    }
    Ok(path.to_owned())
}

fn verify_cgroup2(path: &Path) -> Result<()> {
    let file = File::open(path).map_err(delegation)?;
    let mut stat: libc::statfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstatfs(file.as_raw_fd(), &mut stat) } != 0 || stat.f_type != 0x6367_7270 {
        return Err(FoundationError::new(
            PROCESS_CGROUP_DELEGATION_UNAVAILABLE,
            "service cgroup is not on cgroup v2",
        ));
    }
    Ok(())
}

fn read_words(path: PathBuf) -> Result<BTreeSet<String>> {
    Ok(fs::read_to_string(path)
        .map_err(delegation)?
        .split_whitespace()
        .map(str::to_owned)
        .collect())
}

fn write_readback(path: PathBuf, expected: &str) -> Result<()> {
    write_value(path.clone(), expected, PROCESS_CGROUP_LIMIT_UNAVAILABLE)?;
    let actual = fs::read_to_string(&path).map_err(limit)?.trim().to_owned();
    if actual != expected {
        return Err(FoundationError::new(
            PROCESS_CGROUP_LIMIT_UNAVAILABLE,
            format!(
                "cgroup limit readback mismatch for {}: expected {expected}, got {actual}",
                path.display()
            ),
        ));
    }
    Ok(())
}

fn write_value(path: PathBuf, value: &str, code: &'static str) -> Result<()> {
    let mut file = OpenOptions::new()
        .write(true)
        .open(&path)
        .map_err(|error| {
            FoundationError::new(code, format!("cannot open {}: {error}", path.display()))
        })?;
    file.write_all(value.as_bytes()).map_err(|error| {
        FoundationError::new(code, format!("cannot write {}: {error}", path.display()))
    })
}

fn cgroup_populated(path: &Path) -> Result<bool> {
    let values = parse_flat_file(
        path.join("cgroup.events"),
        PROCESS_CGROUP_TERMINATION_FAILED,
    )?;
    Ok(values.get("populated").copied().unwrap_or(1) != 0)
}

fn read_events(path: &Path) -> Result<CgroupEvents> {
    let pids = parse_flat_file(path.join("pids.events"), PROCESS_CGROUP_LIMIT_UNAVAILABLE)?;
    let memory = parse_flat_file(
        path.join("memory.events.local"),
        PROCESS_CGROUP_LIMIT_UNAVAILABLE,
    )
    .or_else(|_| parse_flat_file(path.join("memory.events"), PROCESS_CGROUP_LIMIT_UNAVAILABLE))?;
    let cpu = parse_flat_file(path.join("cpu.stat"), PROCESS_CGROUP_LIMIT_UNAVAILABLE)?;
    Ok(CgroupEvents {
        pids_max: pids.get("max").copied().unwrap_or(0),
        memory_oom: memory.get("oom").copied().unwrap_or(0),
        memory_oom_kill: memory.get("oom_kill").copied().unwrap_or(0),
        cpu_throttled: cpu.get("nr_throttled").copied().unwrap_or(0),
    })
}

fn parse_flat_file(
    path: PathBuf,
    code: &'static str,
) -> Result<std::collections::BTreeMap<String, u64>> {
    let mut contents = String::new();
    File::open(&path)
        .and_then(|mut file| file.read_to_string(&mut contents))
        .map_err(|error| {
            FoundationError::new(code, format!("cannot read {}: {error}", path.display()))
        })?;
    let mut result = std::collections::BTreeMap::new();
    for line in contents.lines() {
        let mut fields = line.split_whitespace();
        let Some(key) = fields.next() else { continue };
        let Some(value) = fields.next() else { continue };
        if fields.next().is_some() {
            continue;
        }
        if let Ok(value) = value.parse::<u64>() {
            result.insert(key.to_owned(), value);
        }
    }
    Ok(result)
}

fn wait_pid(pid: libc::pid_t) -> Result<()> {
    let mut status = 0;
    if unsafe { libc::waitpid(pid, &mut status, 0) } != pid {
        return Err(FoundationError::new(
            PROCESS_CGROUP_TERMINATION_FAILED,
            "cannot reap trusted cgroup probe",
        ));
    }
    Ok(())
}

fn delegation(error: std::io::Error) -> FoundationError {
    FoundationError::new(
        PROCESS_CGROUP_DELEGATION_UNAVAILABLE,
        format!("cgroup delegation is unavailable: {error}"),
    )
}

fn limit(error: std::io::Error) -> FoundationError {
    FoundationError::new(
        PROCESS_CGROUP_LIMIT_UNAVAILABLE,
        format!("cgroup resource limit is unavailable: {error}"),
    )
}
