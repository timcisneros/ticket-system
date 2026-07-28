use std::collections::{BTreeMap, BTreeSet};
use std::ffi::{CStr, CString};
use std::fs::{self, File};
use std::io::{Read, Seek, Write};
use std::os::fd::{AsRawFd, FromRawFd, RawFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

mod cgroup;
mod executor;
mod launch_contract;
mod materializer_client;
mod operation_registry;
mod seccomp;

use cgroup::DelegatedCgroup;
use executor::{ExecutionControl, ExecutionInputs};
pub use launch_contract::ContainmentCapability as ProcessContainmentCapability;
use launch_contract::{
    ContainmentCapability, LaunchBody, LaunchPlan, OperationBody, OperationStatus,
};
use materializer_client::{AcquireSnapshotRequest, MaterializerClient};
use operation_registry::{OperationRegistry, OutputChunk};
use seccomp::{SECCOMP_POLICY_SCHEMA_VERSION, SeccompPolicy};

pub const PROTOCOL_VERSION: u32 = 1;
pub const ROOTFS_MANIFEST_SCHEMA_VERSION: u32 = 1;
pub const MAX_MESSAGE_BYTES: usize = 2_097_152;
pub const MAX_CONFIG_BYTES: usize = 2_097_152;
pub const MAX_CONFIG_PATH_BYTES: usize = 4096;
pub const MAX_IDENTIFIER_BYTES: usize = 128;
pub const MAX_ROOTFS_ENTRIES: usize = 100_000;
pub const MAX_ROOTFS_REGISTRY_ENTRIES: usize = 32;
pub const MAX_ROOTFS_MANIFEST_BYTES: usize = 16_777_216;
pub const MAX_ROOTFS_REGULAR_BYTES: u64 = 17_179_869_184;
pub const MAX_LAUNCHER_BINARY_BYTES: u64 = 67_108_864;
pub const MAX_SECCOMP_POLICY_BYTES: u64 = 2_097_152;
pub const MAX_PATH_BYTES: usize = 4096;
pub const MAX_COMPONENT_BYTES: usize = 255;
pub const MAX_DIRECTORY_DEPTH: usize = 64;
pub const MAX_HEALTH_VALIDITY_MS: u64 = 300_000;
pub const MIN_HEALTH_VALIDITY_MS: u64 = 1_000;

pub type FailureCode = &'static str;
pub const PROCESS_LAUNCHER_FOUNDATION_UNAVAILABLE: FailureCode =
    "PROCESS_LAUNCHER_FOUNDATION_UNAVAILABLE";
pub const PROCESS_LAUNCHER_CLIENT_UNAUTHORIZED: FailureCode =
    "PROCESS_LAUNCHER_CLIENT_UNAUTHORIZED";
pub const PROCESS_LAUNCHER_PROTOCOL_INVALID: FailureCode = "PROCESS_LAUNCHER_PROTOCOL_INVALID";
pub const PROCESS_LAUNCHER_ALREADY_RUNNING: FailureCode = "PROCESS_LAUNCHER_ALREADY_RUNNING";
pub const PROCESS_ROOTFS_REGISTRY_INVALID: FailureCode = "PROCESS_ROOTFS_REGISTRY_INVALID";
pub const PROCESS_ROOTFS_UNKNOWN: FailureCode = "PROCESS_ROOTFS_UNKNOWN";
pub const PROCESS_ROOTFS_UNAVAILABLE: FailureCode = "PROCESS_ROOTFS_UNAVAILABLE";
pub const PROCESS_ROOTFS_MANIFEST_INVALID: FailureCode = "PROCESS_ROOTFS_MANIFEST_INVALID";
pub const PROCESS_ROOTFS_MANIFEST_MISMATCH: FailureCode = "PROCESS_ROOTFS_MANIFEST_MISMATCH";
pub const PROCESS_ROOTFS_ENTRY_INVALID: FailureCode = "PROCESS_ROOTFS_ENTRY_INVALID";
pub const PROCESS_ROOTFS_IDENTITY_CHANGED: FailureCode = "PROCESS_ROOTFS_IDENTITY_CHANGED";
pub const PROCESS_EXECUTABLE_IDENTITY_MISMATCH: FailureCode =
    "PROCESS_EXECUTABLE_IDENTITY_MISMATCH";
pub const PROCESS_EXECUTABLE_FORMAT_UNSUPPORTED: FailureCode =
    "PROCESS_EXECUTABLE_FORMAT_UNSUPPORTED";
pub const PROCESS_SANDBOX_BACKEND_INVALID: FailureCode = "PROCESS_SANDBOX_BACKEND_INVALID";
pub const PROCESS_SECCOMP_POLICY_INVALID: FailureCode = "PROCESS_SECCOMP_POLICY_INVALID";
pub const PROCESS_SANDBOX_PREREQUISITES_UNAVAILABLE: FailureCode =
    "PROCESS_SANDBOX_PREREQUISITES_UNAVAILABLE";
pub const PROCESS_SANDBOX_PREREQUISITES_EXPIRED: FailureCode =
    "PROCESS_SANDBOX_PREREQUISITES_EXPIRED";
pub const PROCESS_CONTAINMENT_UNAVAILABLE: FailureCode = "PROCESS_CONTAINMENT_UNAVAILABLE";
pub const PROCESS_CONTAINMENT_GENERATION_MISMATCH: FailureCode =
    "PROCESS_CONTAINMENT_GENERATION_MISMATCH";
pub const PROCESS_CONTAINMENT_EXPIRED: FailureCode = "PROCESS_CONTAINMENT_EXPIRED";
pub const PROCESS_LAUNCH_PLAN_INVALID: FailureCode = "PROCESS_LAUNCH_PLAN_INVALID";
pub const PROCESS_SNAPSHOT_DESCRIPTOR_UNAVAILABLE: FailureCode =
    "PROCESS_SNAPSHOT_DESCRIPTOR_UNAVAILABLE";
pub const PROCESS_SNAPSHOT_DESCRIPTOR_INVALID: FailureCode = "PROCESS_SNAPSHOT_DESCRIPTOR_INVALID";
pub const PROCESS_SNAPSHOT_PRINCIPAL_UNAUTHORIZED: FailureCode =
    "PROCESS_SNAPSHOT_PRINCIPAL_UNAUTHORIZED";
pub const PROCESS_CGROUP_DELEGATION_UNAVAILABLE: FailureCode =
    "PROCESS_CGROUP_DELEGATION_UNAVAILABLE";
pub const PROCESS_CGROUP_CONTROLLER_UNAVAILABLE: FailureCode =
    "PROCESS_CGROUP_CONTROLLER_UNAVAILABLE";
pub const PROCESS_CGROUP_LIMIT_UNAVAILABLE: FailureCode = "PROCESS_CGROUP_LIMIT_UNAVAILABLE";
pub const PROCESS_CGROUP_MEMBERSHIP_FAILED: FailureCode = "PROCESS_CGROUP_MEMBERSHIP_FAILED";
pub const PROCESS_CGROUP_TERMINATION_FAILED: FailureCode = "PROCESS_CGROUP_TERMINATION_FAILED";
pub const PROCESS_NAMESPACE_UNAVAILABLE: FailureCode = "PROCESS_NAMESPACE_UNAVAILABLE";
pub const PROCESS_MOUNT_LAYOUT_INVALID: FailureCode = "PROCESS_MOUNT_LAYOUT_INVALID";
pub const PROCESS_NETWORK_ISOLATION_UNAVAILABLE: FailureCode =
    "PROCESS_NETWORK_ISOLATION_UNAVAILABLE";
pub const PROCESS_SECCOMP_INSTALLATION_FAILED: FailureCode = "PROCESS_SECCOMP_INSTALLATION_FAILED";
pub const PROCESS_ENVIRONMENT_INVALID: FailureCode = "PROCESS_ENVIRONMENT_INVALID";
pub const PROCESS_FAILED_TO_START: FailureCode = "PROCESS_FAILED_TO_START";
pub const PROCESS_OUTPUT_LIMIT_EXCEEDED: FailureCode = "PROCESS_OUTPUT_LIMIT_EXCEEDED";
pub const PROCESS_WALL_TIME_EXCEEDED: FailureCode = "PROCESS_WALL_TIME_EXCEEDED";
pub const PROCESS_RESOURCE_LIMIT_EXCEEDED: FailureCode = "PROCESS_RESOURCE_LIMIT_EXCEEDED";
pub const PROCESS_OPERATION_NOT_FOUND: FailureCode = "PROCESS_OPERATION_NOT_FOUND";
pub const PROCESS_OPERATION_ALREADY_ACTIVE: FailureCode = "PROCESS_OPERATION_ALREADY_ACTIVE";
pub const PROCESS_OPERATION_TERMINATION_FAILED: FailureCode =
    "PROCESS_OPERATION_TERMINATION_FAILED";
pub const PROCESS_EXECUTION_INTENT_CONFLICT: FailureCode = "PROCESS_EXECUTION_INTENT_CONFLICT";
pub const PROCESS_LAUNCHER_REGISTRY_INVALID: FailureCode = "PROCESS_LAUNCHER_REGISTRY_INVALID";
pub const PROCESS_LAUNCHER_REGISTRY_FULL: FailureCode = "PROCESS_LAUNCHER_REGISTRY_FULL";
pub const PROCESS_OUTPUT_UNAVAILABLE: FailureCode = "PROCESS_OUTPUT_UNAVAILABLE";
pub const PROCESS_OUTPUT_CHUNK_INVALID: FailureCode = "PROCESS_OUTPUT_CHUNK_INVALID";
pub const PROCESS_OUTPUT_ACKNOWLEDGEMENT_FAILED: FailureCode =
    "PROCESS_OUTPUT_ACKNOWLEDGEMENT_FAILED";

const RESOLVE_NO_MAGICLINKS: u64 = 0x02;
const RESOLVE_NO_SYMLINKS: u64 = 0x04;
const RESOLVE_BENEATH: u64 = 0x08;
const SOCKET_MODE: u32 = 0o660;
const INSTANCE_LOCK_MODE: u32 = 0o600;
const INSTANCE_LOCK_NAME: &str = "launcher-foundation-instance.lock";
const PROTOCOL_IO_TIMEOUT: Duration = Duration::from_secs(30);
const CGROUP2_SUPER_MAGIC: libc::c_long = 0x6367_7270;

#[derive(Debug, Clone)]
pub struct FoundationError {
    pub code: FailureCode,
    pub message: String,
}

impl FoundationError {
    pub fn new(code: FailureCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for FoundationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for FoundationError {}
pub type Result<T> = std::result::Result<T, FoundationError>;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ServiceConfig {
    pub version: u32,
    pub socket_path: String,
    pub state_root: String,
    pub allowed_client_uid: u32,
    pub launcher_service_uid: u32,
    pub materializer_service_uid: u32,
    pub runtime_client_gid: u32,
    pub handoff_gid: u32,
    pub trusted_rootfs_owner_uid: u32,
    pub materializer_socket_path: String,
    pub health_validity_ms: u64,
    pub rootfs_registry: Vec<RootfsConfiguration>,
    pub sandbox_backend: SandboxBackendConfiguration,
    pub seccomp_policy_path: String,
    pub seccomp_policy_sha256: String,
    pub containment_probe: ContainmentProbeConfiguration,
    pub protected_host_paths: ProtectedHostPaths,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContainmentProbeConfiguration {
    pub rootfs_id: String,
    pub executable_path: String,
    pub executable_sha256: String,
    pub format: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RootfsConfiguration {
    pub id: String,
    pub root_path: String,
    pub manifest_path: String,
    pub manifest_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SandboxBackendConfiguration {
    pub kind: String,
    pub binary_path: String,
    pub binary_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProtectedHostPaths {
    pub runtime_data: Vec<String>,
    pub materializer_state: Vec<String>,
    pub workspaces: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RootfsManifest {
    pub version: u32,
    pub entries: Vec<RootfsManifestEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum RootfsManifestEntry {
    Directory {
        path: String,
        mode: String,
    },
    RegularFile {
        path: String,
        size: u64,
        sha256: String,
        mode: String,
    },
    SymbolicLink {
        path: String,
        target: String,
    },
}

impl RootfsManifestEntry {
    fn path(&self) -> &str {
        match self {
            Self::Directory { path, .. }
            | Self::RegularFile { path, .. }
            | Self::SymbolicLink { path, .. } => path,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RequestEnvelope {
    version: u32,
    request_id: String,
    operation: ProtocolOperation,
    body: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
enum ProtocolOperation {
    Health,
    GetRootfs,
    VerifyExecutable,
    Launch,
    GetOperation,
    CancelOperation,
    ReadOutput,
    AcknowledgeOutput,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct EmptyBody {}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GetRootfsBody {
    rootfs_id: String,
    rootfs_manifest_sha256: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VerifyExecutableBody {
    rootfs_id: String,
    rootfs_manifest_sha256: String,
    executable_path: String,
    executable_sha256: String,
    format: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReadOutputBody {
    operation_identity: String,
    stream: String,
    offset: u64,
    maximum_bytes: u64,
    expected_total_bytes: u64,
    expected_sha256: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AcknowledgeOutputBody {
    operation_identity: String,
    terminal_result_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RootfsAuthority {
    pub id: String,
    pub manifest_sha256: String,
    pub physical_identity_hash: String,
    pub entry_count: u64,
    pub total_regular_bytes: u64,
    pub rootfs_registry_generation: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecutableAuthority {
    pub rootfs_id: String,
    pub rootfs_manifest_sha256: String,
    pub executable_path: String,
    pub executable_sha256: String,
    pub format: String,
    pub rootfs_registry_generation: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostPrerequisiteInspection {
    pub platform: String,
    pub kernel_release: String,
    pub cgroup_v2: String,
    pub cgroup_controllers: Vec<String>,
    pub delegated_cgroup_root: String,
    pub user_namespaces: String,
    pub mount_namespaces: String,
    pub pid_namespaces: String,
    pub network_namespaces: String,
    pub seccomp_filter: String,
    pub no_new_privs: String,
    pub active_containment_proof: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FoundationHealth {
    pub version: u32,
    pub status: String,
    pub launcher_protocol_version: u32,
    pub launcher_identity_hash: String,
    pub sandbox_backend_identity_hash: String,
    pub seccomp_policy_hash: String,
    pub rootfs_registry_generation: String,
    pub host_prerequisite_identity_hash: String,
    pub verified_at: String,
    pub expires_at: String,
    pub ready_for_execution: bool,
    pub host_prerequisites: HostPrerequisiteInspection,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SuccessResponse<T: Serialize> {
    version: u32,
    request_id: String,
    ok: bool,
    result: T,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorResponse {
    version: u32,
    request_id: Option<String>,
    ok: bool,
    error: ErrorDocument,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorDocument {
    code: String,
    message: String,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct PhysicalIdentity {
    device: u64,
    inode: u64,
    owner_uid: u32,
    owner_gid: u32,
    mode: u32,
}

#[derive(Debug)]
struct PinnedDirectory {
    descriptor: File,
    identity: PhysicalIdentity,
}

#[derive(Debug)]
struct PinnedFile {
    descriptor: File,
    identity: PhysicalIdentity,
    sha256: String,
    maximum_bytes: u64,
}

#[derive(Debug)]
struct VerifiedRootfs {
    config: RootfsConfiguration,
    root: PinnedDirectory,
    manifest_file: PinnedFile,
    manifest: RootfsManifest,
    authority: RootfsAuthority,
    regular_files: BTreeMap<String, (u64, String, u32)>,
}

#[derive(Debug)]
pub struct FoundationService {
    config: ServiceConfig,
    _state_root: PinnedDirectory,
    _instance_lock: File,
    socket_directory: PinnedDirectory,
    socket_name: String,
    backend: PinnedFile,
    seccomp_policy: PinnedFile,
    seccomp_contract: SeccompPolicy,
    delegated_cgroup: DelegatedCgroup,
    materializer: MaterializerClient,
    rootfs: BTreeMap<String, VerifiedRootfs>,
    health: ContainmentCapability,
    operation_controls: Mutex<BTreeMap<String, Arc<ExecutionControl>>>,
    operation_registry: Mutex<OperationRegistry>,
}

impl ServiceConfig {
    pub fn load(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref();
        validate_host_path(path, "configuration path")?;
        let metadata = fs::metadata(path).map_err(|error| {
            FoundationError::new(
                PROCESS_LAUNCHER_FOUNDATION_UNAVAILABLE,
                format!("cannot inspect trusted launcher configuration: {error}"),
            )
        })?;
        if metadata.len() > MAX_CONFIG_BYTES as u64 {
            return Err(FoundationError::new(
                PROCESS_LAUNCHER_PROTOCOL_INVALID,
                "trusted launcher configuration exceeds the hard byte ceiling",
            ));
        }
        let bytes = fs::read(path).map_err(unavailable)?;
        let mut value: Self = serde_json::from_slice(&bytes).map_err(|error| {
            FoundationError::new(
                PROCESS_LAUNCHER_PROTOCOL_INVALID,
                format!("trusted launcher configuration is invalid: {error}"),
            )
        })?;
        value.canonicalize()?;
        Ok(value)
    }

    fn canonicalize(&mut self) -> Result<()> {
        self.validate()?;
        self.rootfs_registry
            .sort_by(|left, right| left.id.as_bytes().cmp(right.id.as_bytes()));
        for paths in [
            &mut self.protected_host_paths.runtime_data,
            &mut self.protected_host_paths.materializer_state,
            &mut self.protected_host_paths.workspaces,
        ] {
            paths.sort_by(|left, right| left.as_bytes().cmp(right.as_bytes()));
            if paths.windows(2).any(|items| items[0] == items[1]) {
                return Err(FoundationError::new(
                    PROCESS_ROOTFS_REGISTRY_INVALID,
                    "protectedHostPaths entries must be unique",
                ));
            }
        }
        Ok(())
    }

    pub fn validate(&self) -> Result<()> {
        if self.version != 1 {
            return Err(protocol("launcher configuration version must be 1"));
        }
        for (label, value) in [
            ("socketPath", self.socket_path.as_str()),
            ("stateRoot", self.state_root.as_str()),
            (
                "materializerSocketPath",
                self.materializer_socket_path.as_str(),
            ),
            (
                "sandboxBackend.binaryPath",
                self.sandbox_backend.binary_path.as_str(),
            ),
            ("seccompPolicyPath", self.seccomp_policy_path.as_str()),
        ] {
            validate_host_path(Path::new(value), label)?;
        }
        if self.launcher_service_uid != unsafe { libc::geteuid() } {
            return Err(FoundationError::new(
                PROCESS_LAUNCHER_FOUNDATION_UNAVAILABLE,
                "launcherServiceUid must equal the effective launcher service UID",
            ));
        }
        if self.runtime_client_gid == self.handoff_gid {
            return Err(protocol(
                "runtime client and sealed-descriptor handoff groups must be distinct",
            ));
        }
        let distinct = [
            self.allowed_client_uid,
            self.launcher_service_uid,
            self.materializer_service_uid,
            self.trusted_rootfs_owner_uid,
        ];
        if distinct.into_iter().collect::<BTreeSet<_>>().len() != distinct.len() {
            return Err(FoundationError::new(
                PROCESS_ROOTFS_REGISTRY_INVALID,
                "runtime, launcher, materializer, and trusted rootfs owner UIDs must be distinct",
            ));
        }
        if !(MIN_HEALTH_VALIDITY_MS..=MAX_HEALTH_VALIDITY_MS).contains(&self.health_validity_ms)
            || !self.health_validity_ms.is_multiple_of(1000)
        {
            return Err(FoundationError::new(
                PROCESS_SANDBOX_PREREQUISITES_UNAVAILABLE,
                format!(
                    "healthValidityMs must be whole seconds in \
                     {MIN_HEALTH_VALIDITY_MS}..={MAX_HEALTH_VALIDITY_MS}"
                ),
            ));
        }
        if self.rootfs_registry.is_empty()
            || self.rootfs_registry.len() > MAX_ROOTFS_REGISTRY_ENTRIES
        {
            return Err(FoundationError::new(
                PROCESS_ROOTFS_REGISTRY_INVALID,
                format!("rootfsRegistry must contain 1..={MAX_ROOTFS_REGISTRY_ENTRIES} entries"),
            ));
        }
        let mut ids = BTreeSet::new();
        for entry in &self.rootfs_registry {
            validate_identifier(&entry.id, "rootfs id")?;
            validate_host_path(Path::new(&entry.root_path), "rootfs rootPath")?;
            validate_host_path(Path::new(&entry.manifest_path), "rootfs manifestPath")?;
            validate_sha256(&entry.manifest_sha256, "rootfs manifestSha256")?;
            if is_forbidden_live_root(Path::new(&entry.root_path)) {
                return Err(FoundationError::new(
                    PROCESS_ROOTFS_REGISTRY_INVALID,
                    "a live host system directory cannot be a runtime rootfs",
                ));
            }
            let root_path = Path::new(&entry.root_path);
            for (label, candidate) in [
                ("manifestPath", Path::new(&entry.manifest_path)),
                ("socketPath", Path::new(&self.socket_path)),
                ("stateRoot", Path::new(&self.state_root)),
                (
                    "sandboxBackend.binaryPath",
                    Path::new(&self.sandbox_backend.binary_path),
                ),
                ("seccompPolicyPath", Path::new(&self.seccomp_policy_path)),
            ] {
                if candidate.starts_with(root_path) {
                    return Err(FoundationError::new(
                        PROCESS_ROOTFS_REGISTRY_INVALID,
                        format!("rootfs rootPath must not contain {label}"),
                    ));
                }
            }
            if !ids.insert(entry.id.as_str()) {
                return Err(FoundationError::new(
                    PROCESS_ROOTFS_REGISTRY_INVALID,
                    format!("duplicate rootfs id: {}", entry.id),
                ));
            }
        }
        if !ids.contains(self.containment_probe.rootfs_id.as_str()) {
            return Err(FoundationError::new(
                PROCESS_ROOTFS_UNKNOWN,
                "containmentProbe references an unknown rootfs",
            ));
        }
        if self.sandbox_backend.kind != "bubblewrap" {
            return Err(FoundationError::new(
                PROCESS_SANDBOX_BACKEND_INVALID,
                "sandboxBackend.kind must be bubblewrap",
            ));
        }
        validate_sha256(
            &self.sandbox_backend.binary_sha256,
            "sandboxBackend.binarySha256",
        )?;
        validate_sha256(&self.seccomp_policy_sha256, "seccompPolicySha256")?;
        validate_identifier(
            &self.containment_probe.rootfs_id,
            "containmentProbe.rootfsId",
        )?;
        validate_executable_path(&self.containment_probe.executable_path)?;
        validate_sha256(
            &self.containment_probe.executable_sha256,
            "containmentProbe.executableSha256",
        )?;
        if self.containment_probe.format != "elf" {
            return Err(FoundationError::new(
                PROCESS_EXECUTABLE_FORMAT_UNSUPPORTED,
                "containmentProbe.format must be elf",
            ));
        }
        for paths in [
            &self.protected_host_paths.runtime_data,
            &self.protected_host_paths.materializer_state,
            &self.protected_host_paths.workspaces,
        ] {
            if paths.len() > MAX_ROOTFS_REGISTRY_ENTRIES {
                return Err(FoundationError::new(
                    PROCESS_ROOTFS_REGISTRY_INVALID,
                    "one protectedHostPaths list exceeds the hard cardinality ceiling",
                ));
            }
            for path in paths {
                validate_host_path(Path::new(path), "protected host path")?;
            }
        }
        Ok(())
    }
}

impl FoundationService {
    pub fn new(mut config: ServiceConfig) -> Result<Self> {
        config.canonicalize()?;
        if unsafe { libc::getegid() } != config.handoff_gid {
            return Err(FoundationError::new(
                PROCESS_LAUNCHER_FOUNDATION_UNAVAILABLE,
                "launcher effective group must equal the configured sealed-descriptor handoff group",
            ));
        }
        let state_root = PinnedDirectory::open_absolute(
            Path::new(&config.state_root),
            PROCESS_LAUNCHER_FOUNDATION_UNAVAILABLE,
        )?;
        validate_service_directory(
            &state_root,
            "launcher state root",
            0o750,
            config.handoff_gid,
        )?;
        let (socket_directory, socket_name) = pin_socket_directory(&config)?;
        let instance_lock = acquire_instance_lock(&state_root)?;

        let backend = PinnedFile::open_absolute(
            Path::new(&config.sandbox_backend.binary_path),
            PROCESS_SANDBOX_BACKEND_INVALID,
            MAX_LAUNCHER_BINARY_BYTES,
        )?;
        validate_trusted_file(
            &backend,
            config.trusted_rootfs_owner_uid,
            true,
            PROCESS_SANDBOX_BACKEND_INVALID,
            "Bubblewrap binary",
        )?;
        if backend.sha256 != config.sandbox_backend.binary_sha256 {
            return Err(FoundationError::new(
                PROCESS_SANDBOX_BACKEND_INVALID,
                "Bubblewrap binary hash does not match trusted configuration",
            ));
        }
        let seccomp_policy = PinnedFile::open_absolute(
            Path::new(&config.seccomp_policy_path),
            PROCESS_SECCOMP_POLICY_INVALID,
            MAX_SECCOMP_POLICY_BYTES,
        )?;
        validate_trusted_file(
            &seccomp_policy,
            config.trusted_rootfs_owner_uid,
            false,
            PROCESS_SECCOMP_POLICY_INVALID,
            "seccomp policy",
        )?;
        if seccomp_policy.sha256 != config.seccomp_policy_sha256 {
            return Err(FoundationError::new(
                PROCESS_SECCOMP_POLICY_INVALID,
                "seccomp policy hash does not match trusted configuration",
            ));
        }
        let seccomp_contract = SeccompPolicy::parse_canonical(&seccomp_policy.read_all()?)?;

        let rootfs = verify_rootfs_registry(&config, &state_root, &socket_directory)?;
        validate_containment_rootfs_mountpoints(
            rootfs
                .get(&config.containment_probe.rootfs_id)
                .expect("containment probe rootfs reference validated"),
        )?;
        let launcher_identity_hash = hash_current_binary()?;
        let rootfs_registry_generation = derive_rootfs_registry_generation(
            &config,
            &rootfs,
            &launcher_identity_hash,
            &backend,
            &seccomp_policy,
        )?;
        let mut rootfs = rootfs;
        for verified in rootfs.values_mut() {
            verified.authority.rootfs_registry_generation = rootfs_registry_generation.clone();
        }
        inspect_host_prerequisites()?;
        let delegated_cgroup = DelegatedCgroup::discover_and_activate()?;
        // DelegatedCgroup activation has already killed and removed stale
        // operation cgroups. Only after whole-tree cleanup may accepted or
        // active durable records be classified as launcher interruptions.
        // Durable execution authority is rooted beneath the already pinned
        // service-state descriptor. The configured pathname is never reopened
        // after startup and cannot redirect this service generation.
        let mut operation_registry = OperationRegistry::open(&state_root.proc_path())?;
        operation_registry.interrupt_incomplete()?;
        let materializer = MaterializerClient::new(
            config.materializer_socket_path.clone(),
            config.materializer_service_uid,
        );
        let materializer_health = materializer.health()?;
        let verified_seconds = unix_time()?;
        let placeholder_health = ContainmentCapability {
            version: 1,
            status: "containment_verifying".into(),
            generation_id: "sandbox-containment-v1-placeholder".into(),
            launcher_protocol_version: PROTOCOL_VERSION,
            launcher_identity_hash: launcher_identity_hash.clone(),
            sandbox_backend_identity_hash: backend.sha256.clone(),
            seccomp_policy_hash: seccomp_policy.sha256.clone(),
            rootfs_registry_generation: rootfs_registry_generation.clone(),
            materializer_generation: materializer_health.materializer_generation.clone(),
            delegated_cgroup_identity_hash: delegated_cgroup.identity_hash()?,
            containment_probe_hash: "0".repeat(64),
            verified_at: canonical_utc(verified_seconds)?,
            expires_at: canonical_utc(
                verified_seconds
                    .checked_add((config.health_validity_ms / 1000) as i64)
                    .ok_or_else(|| {
                        FoundationError::new(
                            PROCESS_CONTAINMENT_UNAVAILABLE,
                            "containment expiry overflows the system clock",
                        )
                    })?,
            )?,
            ready_for_execution: false,
        };
        let mut service = Self {
            config,
            _state_root: state_root,
            _instance_lock: instance_lock,
            socket_directory,
            socket_name,
            backend,
            seccomp_policy,
            seccomp_contract,
            delegated_cgroup,
            materializer,
            rootfs,
            health: placeholder_health,
            operation_controls: Mutex::new(BTreeMap::new()),
            operation_registry: Mutex::new(operation_registry),
        };
        let containment_probe_hash = service.run_active_containment_probe()?;
        let generation_material = serde_json::json!({
            "launcherProtocolVersion": PROTOCOL_VERSION,
            "launcherIdentityHash": launcher_identity_hash,
            "sandboxBackendIdentityHash": service.backend.sha256.clone(),
            "seccompPolicyHash": service.seccomp_policy.sha256.clone(),
            "rootfsRegistryGeneration": rootfs_registry_generation,
            "materializerGeneration": materializer_health.materializer_generation.clone(),
            "delegatedCgroupIdentityHash": service.delegated_cgroup.identity_hash()?,
            "containmentProbeHash": containment_probe_hash.clone(),
            "mountPlanVersion": executor::MOUNT_PLAN_VERSION,
            "seccompPolicySchemaVersion": SECCOMP_POLICY_SCHEMA_VERSION
        });
        service.health.status = "containment_verified".into();
        service.health.generation_id = format!(
            "sandbox-containment-v1-{}",
            sha256_json(&generation_material)?
        );
        service.health.containment_probe_hash = containment_probe_hash;
        service.health.ready_for_execution = true;
        Ok(service)
    }

    pub fn health(&self) -> Result<ContainmentCapability> {
        if canonical_utc(unix_time()?)? >= self.health.expires_at {
            return Err(FoundationError::new(
                PROCESS_CONTAINMENT_EXPIRED,
                "Active containment verification has expired",
            ));
        }
        self.validate_pinned_authority()?;
        Ok(self.health.clone())
    }

    pub fn serve(self) -> Result<()> {
        self.socket_directory.set_as_current_directory()?;
        let socket_path = prepare_socket_path(&self.socket_directory, &self.socket_name)?;
        let listener = UnixListener::bind(&socket_path).map_err(|error| {
            FoundationError::new(
                PROCESS_LAUNCHER_FOUNDATION_UNAVAILABLE,
                format!("cannot bind launcher foundation Unix socket: {error}"),
            )
        })?;
        fs::set_permissions(&socket_path, fs::Permissions::from_mode(SOCKET_MODE))
            .map_err(unavailable)?;
        chown_group(&socket_path, self.config.runtime_client_gid)?;
        let service = Arc::new(self);
        for connection in listener.incoming() {
            match connection {
                Ok(stream) => {
                    let service = service.clone();
                    std::thread::spawn(move || {
                        if let Err(error) = handle_connection(&service, stream) {
                            eprintln!(
                                "launcher foundation request failed: {}: {}",
                                error.code, error.message
                            );
                        }
                    });
                }
                Err(error) => {
                    return Err(FoundationError::new(
                        PROCESS_LAUNCHER_FOUNDATION_UNAVAILABLE,
                        format!("launcher foundation socket accept failed: {error}"),
                    ));
                }
            }
        }
        Ok(())
    }

    fn validate_pinned_authority(&self) -> Result<()> {
        self.backend
            .revalidate(PROCESS_SANDBOX_BACKEND_INVALID, "Bubblewrap binary")?;
        self.seccomp_policy
            .revalidate(PROCESS_SECCOMP_POLICY_INVALID, "seccomp policy")?;
        for rootfs in self.rootfs.values() {
            rootfs.revalidate_identity()?;
        }
        let materializer = self.materializer.health()?;
        if materializer.materializer_generation != self.health.materializer_generation {
            return Err(FoundationError::new(
                PROCESS_CONTAINMENT_GENERATION_MISMATCH,
                "materializer generation changed after containment verification",
            ));
        }
        Ok(())
    }

    fn get_rootfs(&self, body: &GetRootfsBody) -> Result<RootfsAuthority> {
        validate_identifier(&body.rootfs_id, "rootfsId")?;
        validate_sha256(&body.rootfs_manifest_sha256, "rootfsManifestSha256")?;
        let rootfs = self.rootfs.get(&body.rootfs_id).ok_or_else(|| {
            FoundationError::new(
                PROCESS_ROOTFS_UNKNOWN,
                "Rootfs is not present in the registry",
            )
        })?;
        if body.rootfs_manifest_sha256 != rootfs.config.manifest_sha256 {
            return Err(FoundationError::new(
                PROCESS_ROOTFS_MANIFEST_MISMATCH,
                "Requested rootfs manifest hash does not match the registry",
            ));
        }
        rootfs.revalidate_identity()?;
        Ok(rootfs.authority.clone())
    }

    fn verify_executable(&self, body: &VerifyExecutableBody) -> Result<ExecutableAuthority> {
        validate_identifier(&body.rootfs_id, "rootfsId")?;
        validate_sha256(&body.rootfs_manifest_sha256, "rootfsManifestSha256")?;
        validate_sha256(&body.executable_sha256, "executableSha256")?;
        if body.format != "elf" {
            return Err(FoundationError::new(
                PROCESS_EXECUTABLE_FORMAT_UNSUPPORTED,
                "Initial executable authority supports only ELF",
            ));
        }
        let relative = validate_executable_path(&body.executable_path)?;
        let rootfs = self.rootfs.get(&body.rootfs_id).ok_or_else(|| {
            FoundationError::new(
                PROCESS_ROOTFS_UNKNOWN,
                "Rootfs is not present in the registry",
            )
        })?;
        if body.rootfs_manifest_sha256 != rootfs.config.manifest_sha256 {
            return Err(FoundationError::new(
                PROCESS_ROOTFS_MANIFEST_MISMATCH,
                "Requested rootfs manifest hash does not match the registry",
            ));
        }
        rootfs.revalidate_identity()?;
        let (size, manifest_hash, mode) = rootfs.regular_files.get(relative).ok_or_else(|| {
            FoundationError::new(
                PROCESS_EXECUTABLE_IDENTITY_MISMATCH,
                "Executable is not a regular file in the verified rootfs manifest",
            )
        })?;
        if manifest_hash != &body.executable_sha256 {
            return Err(FoundationError::new(
                PROCESS_EXECUTABLE_IDENTITY_MISMATCH,
                "Executable hash does not match the verified rootfs manifest",
            ));
        }
        validate_executable_mode(*mode)?;
        verify_elf_identity(&rootfs.root, relative, *size, &body.executable_sha256)?;
        Ok(ExecutableAuthority {
            rootfs_id: body.rootfs_id.clone(),
            rootfs_manifest_sha256: body.rootfs_manifest_sha256.clone(),
            executable_path: body.executable_path.clone(),
            executable_sha256: body.executable_sha256.clone(),
            format: "elf".into(),
            rootfs_registry_generation: self.health.rootfs_registry_generation.clone(),
        })
    }

    fn launch(self: &Arc<Self>, body: LaunchBody) -> Result<OperationStatus> {
        let capability = self.health()?;
        if body.containment_generation_id != capability.generation_id {
            return Err(FoundationError::new(
                PROCESS_CONTAINMENT_GENERATION_MISMATCH,
                "launch request does not name the current containment generation",
            ));
        }
        body.launch_plan.validate(&capability)?;
        let plan = body.launch_plan;
        let executable = VerifyExecutableBody {
            rootfs_id: plan.runtime_rootfs.id.clone(),
            rootfs_manifest_sha256: plan.runtime_rootfs.manifest_sha256.clone(),
            executable_path: plan.executable_identity.path.clone(),
            executable_sha256: plan.executable_identity.sha256.clone(),
            format: plan.executable_identity.format.clone(),
        };
        self.verify_executable(&executable)?;
        self.rootfs.get(&plan.runtime_rootfs.id).ok_or_else(|| {
            FoundationError::new(PROCESS_ROOTFS_UNKNOWN, "launch rootfs is unavailable")
        })?;
        let control = Arc::new(ExecutionControl::new());
        {
            let mut registry = self.operation_registry.lock().map_err(operation_lock)?;
            let (_, inserted) = registry.accept(&plan, &body.containment_generation_id)?;
            if !inserted {
                return registry.status(&plan.operation_identity);
            }
        }
        {
            let mut controls = self.operation_controls.lock().map_err(operation_lock)?;
            controls.insert(plan.operation_identity.clone(), control.clone());
        }
        let operation_identity = plan.operation_identity.clone();
        let service = Arc::clone(self);
        let started = std::thread::Builder::new()
            .name(format!(
                "process-operation-{}",
                &operation_identity["process-operation:".len()..][..12]
            ))
            .spawn(move || {
                if let Err(error) = service.execute_accepted_operation(plan, control) {
                    eprintln!(
                        "accepted launcher operation finalization failed: {}: {}",
                        error.code, error.message
                    );
                }
            });
        if let Err(error) = started {
            self.operation_controls
                .lock()
                .map_err(operation_lock)?
                .remove(&operation_identity);
            let mut registry = self.operation_registry.lock().map_err(operation_lock)?;
            registry.mark_infrastructure_terminal(
                &operation_identity,
                "failed_to_start",
                "launcher_thread_capacity",
            )?;
            eprintln!("cannot start launcher operation monitor: {error}");
            return registry.status(&operation_identity);
        }
        self.operation_registry
            .lock()
            .map_err(operation_lock)?
            .status(&operation_identity)
    }

    fn execute_accepted_operation(
        &self,
        plan: LaunchPlan,
        control: Arc<ExecutionControl>,
    ) -> Result<()> {
        let rootfs = self.rootfs.get(&plan.runtime_rootfs.id).ok_or_else(|| {
            FoundationError::new(PROCESS_ROOTFS_UNKNOWN, "launch rootfs is unavailable")
        })?;
        let filesystem_policy_hash = plan.filesystem_policy_hash()?;
        let acquisition = AcquireSnapshotRequest {
            snapshot_id: &plan.workspace_snapshot.id,
            expected_run_id: plan.run_id,
            expected_ticket_id: plan.ticket_id,
            expected_operation_id: &plan.operation_id,
            expected_operation_identity: &plan.operation_identity,
            expected_policy_snapshot_hash: &plan.policy_snapshot_hash,
            expected_materializer_generation: &plan.workspace_snapshot.materializer_generation,
            expected_filesystem_policy_hash: &filesystem_policy_hash,
            expected_manifest_sha256: &plan.workspace_snapshot.manifest_sha256,
            expected_file_count: plan.workspace_snapshot.file_count,
            expected_total_bytes: plan.workspace_snapshot.total_bytes,
        };
        let operation_identity = plan.operation_identity.clone();
        let before_release = || {
            self.operation_registry
                .lock()
                .map_err(operation_lock)?
                .mark_active(&operation_identity)
        };
        let execution = (|| {
            let workspace = self.materializer.acquire(&acquisition)?;
            executor::execute(ExecutionInputs {
                plan: &plan,
                backend: &self.backend.descriptor,
                rootfs,
                workspace,
                seccomp_policy: &self.seccomp_contract,
                cgroup: &self.delegated_cgroup,
                control: control.clone(),
                retain_trusted_output: true,
                require_live_seccomp_observation: false,
                before_release: Some(&before_release),
            })
            .map(|artifacts| {
                (
                    artifacts.result,
                    artifacts.trusted_stdout,
                    artifacts.trusted_stderr,
                )
            })
        })();
        self.operation_controls
            .lock()
            .map_err(operation_lock)?
            .remove(&plan.operation_identity);
        let mut registry = self.operation_registry.lock().map_err(operation_lock)?;
        match execution {
            Ok((result, stdout, stderr)) => {
                registry.mark_terminal(&plan.operation_identity, result, &stdout, &stderr)?;
            }
            Err(error) => {
                let current = registry
                    .get(&plan.operation_identity)
                    .cloned()
                    .ok_or_else(|| {
                        FoundationError::new(
                            PROCESS_LAUNCHER_REGISTRY_INVALID,
                            "accepted launcher operation disappeared",
                        )
                    })?;
                let ended_at = canonical_utc(unix_time()?)?;
                let result = launch_contract::ExecutionResult {
                    operation_identity: plan.operation_identity.clone(),
                    terminal_outcome: if current.started_at.is_some() {
                        "runtime_interrupted".into()
                    } else {
                        "failed_to_start".into()
                    },
                    started_at: current
                        .started_at
                        .clone()
                        .unwrap_or_else(|| current.accepted_at.clone()),
                    ended_at,
                    duration_ms: 0,
                    exit_code: None,
                    signal: None,
                    stdout_bytes: 0,
                    stderr_bytes: 0,
                    combined_output_bytes: 0,
                    stdout_sha256: sha256_bytes(&[]),
                    stderr_sha256: sha256_bytes(&[]),
                    output_complete: false,
                    resource_cause: None,
                    enforcement_cause: Some(error.code.into()),
                    cpu_throttled_events: 0,
                    launcher_environment: BTreeMap::from([
                        ("LANG".into(), "C.UTF-8".into()),
                        ("LC_ALL".into(), "C.UTF-8".into()),
                        ("TMPDIR".into(), "/tmp".into()),
                    ]),
                };
                registry.mark_terminal(&plan.operation_identity, result, &[], &[])?;
            }
        }
        Ok(())
    }

    fn get_operation(&self, body: OperationBody) -> Result<OperationStatus> {
        validate_operation_identity_text(&body.operation_identity)?;
        self.operation_registry
            .lock()
            .map_err(operation_lock)?
            .status(&body.operation_identity)
    }

    fn cancel_operation(&self, body: OperationBody) -> Result<OperationStatus> {
        validate_operation_identity_text(&body.operation_identity)?;
        if let Some(control) = self
            .operation_controls
            .lock()
            .map_err(operation_lock)?
            .get(&body.operation_identity)
        {
            control
                .cancel
                .store(true, std::sync::atomic::Ordering::Release);
        }
        self.get_operation(body)
    }

    fn read_output(&self, body: ReadOutputBody) -> Result<OutputChunk> {
        validate_operation_identity_text(&body.operation_identity)?;
        validate_sha256(&body.expected_sha256, "expectedSha256")?;
        self.operation_registry
            .lock()
            .map_err(operation_lock)?
            .read_output(
                &body.operation_identity,
                &body.stream,
                body.offset,
                body.maximum_bytes,
                body.expected_total_bytes,
                &body.expected_sha256,
            )
    }

    fn acknowledge_output(&self, body: AcknowledgeOutputBody) -> Result<OperationStatus> {
        validate_operation_identity_text(&body.operation_identity)?;
        validate_sha256(&body.terminal_result_hash, "terminalResultHash")?;
        self.operation_registry
            .lock()
            .map_err(operation_lock)?
            .acknowledge(&body.operation_identity, &body.terminal_result_hash)
    }

    fn run_active_containment_probe(&self) -> Result<String> {
        let probe = &self.config.containment_probe;
        let rootfs = self.rootfs.get(&probe.rootfs_id).ok_or_else(|| {
            FoundationError::new(
                PROCESS_ROOTFS_UNKNOWN,
                "containment probe rootfs is unavailable",
            )
        })?;
        self.verify_executable(&VerifyExecutableBody {
            rootfs_id: probe.rootfs_id.clone(),
            rootfs_manifest_sha256: rootfs.config.manifest_sha256.clone(),
            executable_path: probe.executable_path.clone(),
            executable_sha256: probe.executable_sha256.clone(),
            format: probe.format.clone(),
        })?;
        let probe_root = self._state_root.proc_path().join("containment-probe-input");
        if probe_root.exists() {
            make_launcher_tree_writable(&probe_root)?;
            fs::remove_dir_all(&probe_root).map_err(unavailable)?;
        }
        fs::create_dir(&probe_root).map_err(unavailable)?;
        fs::set_permissions(&probe_root, fs::Permissions::from_mode(0o700)).map_err(unavailable)?;
        let tree_path = probe_root.join("tree");
        fs::create_dir(&tree_path).map_err(unavailable)?;
        fs::set_permissions(&tree_path, fs::Permissions::from_mode(0o550)).map_err(unavailable)?;
        let source_bytes = b"const containmentProbe = true;\n";
        fs::write(tree_path.join("server.js"), source_bytes).map_err(unavailable)?;
        fs::set_permissions(
            tree_path.join("server.js"),
            fs::Permissions::from_mode(0o440),
        )
        .map_err(unavailable)?;
        let source_hash = sha256_bytes(source_bytes);
        let manifest_bytes = format!(
            "{{\"entries\":[{{\"mode\":\"0440\",\"path\":\"server.js\",\
             \"sha256\":\"{source_hash}\",\"size\":{},\"type\":\"regular_file\"}}],\
             \"version\":1}}",
            source_bytes.len()
        );
        let manifest_path = probe_root.join("manifest.json");
        fs::write(&manifest_path, &manifest_bytes).map_err(unavailable)?;
        fs::set_permissions(&manifest_path, fs::Permissions::from_mode(0o440))
            .map_err(unavailable)?;
        let manifest_hash = sha256_bytes(manifest_bytes.as_bytes());
        let mut observations = Vec::new();
        for (index, mode, expected, wall_time, output, processes, memory) in [
            (
                1_u64,
                "inspect",
                "completed",
                10_000,
                65_536,
                16,
                134_217_728,
            ),
            (
                2,
                "output",
                "output_limit_exceeded",
                10_000,
                4_096,
                16,
                134_217_728,
            ),
            (3, "sleep", "timed_out", 3_000, 65_536, 16, 134_217_728),
            (
                4,
                "descendants",
                "timed_out",
                3_000,
                65_536,
                16,
                134_217_728,
            ),
            (
                5,
                "pids",
                "resource_limit_exceeded",
                10_000,
                65_536,
                8,
                134_217_728,
            ),
            (
                6,
                "memory",
                "resource_limit_exceeded",
                10_000,
                65_536,
                16,
                33_554_432,
            ),
            (
                7,
                "threads",
                "resource_limit_exceeded",
                10_000,
                65_536,
                8,
                134_217_728,
            ),
            (
                8,
                "file-size",
                "exited_nonzero",
                10_000,
                65_536,
                16,
                134_217_728,
            ),
            (
                9,
                "temporary-storage",
                "timed_out",
                3_000,
                65_536,
                16,
                134_217_728,
            ),
            (
                10,
                "open-files",
                "timed_out",
                3_000,
                65_536,
                16,
                134_217_728,
            ),
            (11, "cpu", "timed_out", 3_000, 65_536, 16, 134_217_728),
            (
                12,
                "node-compatibility",
                "completed",
                10_000,
                65_536,
                16,
                268_435_456,
            ),
        ] {
            let plan = self.probe_launch_plan(
                index,
                mode,
                &manifest_hash,
                wall_time,
                output,
                processes,
                memory,
                source_bytes.len() as u64,
            )?;
            let workspace = materializer_client::AcquiredSnapshot {
                tree: File::open(&tree_path).map_err(unavailable)?,
                manifest: File::open(&manifest_path).map_err(unavailable)?,
            };
            let artifacts = executor::execute(ExecutionInputs {
                plan: &plan,
                backend: &self.backend.descriptor,
                rootfs,
                workspace,
                seccomp_policy: &self.seccomp_contract,
                cgroup: &self.delegated_cgroup,
                control: Arc::new(ExecutionControl::new()),
                retain_trusted_output: true,
                require_live_seccomp_observation: true,
                before_release: None,
            })?;
            if artifacts.result.terminal_outcome != expected {
                return Err(FoundationError::new(
                    PROCESS_CONTAINMENT_UNAVAILABLE,
                    format!(
                        "active containment probe {mode} expected {expected}, got {} \
                         (exit={:?}, signal={:?})",
                        artifacts.result.terminal_outcome,
                        artifacts.result.exit_code,
                        artifacts.result.signal,
                    ) + &format!(
                        "; stderr={}",
                        String::from_utf8_lossy(&artifacts.trusted_stderr)
                    ),
                ));
            }
            if mode == "inspect" {
                validate_inspection_probe(&artifacts)?;
            }
            if mode == "cpu"
                && (artifacts.result.cpu_throttled_events == 0
                    || artifacts.result.resource_cause.is_some())
            {
                return Err(FoundationError::new(
                    PROCESS_CONTAINMENT_UNAVAILABLE,
                    "CPU quota probe did not throttle or produced false terminal attribution",
                ));
            }
            if mode == "file-size"
                && (artifacts.result.resource_cause.is_some()
                    || !String::from_utf8_lossy(&artifacts.trusted_stdout)
                        .contains("\"fileSizeLimited\":true"))
            {
                return Err(FoundationError::new(
                    PROCESS_CONTAINMENT_UNAVAILABLE,
                    "RLIMIT_FSIZE probe was not enforced or was falsely attributed",
                ));
            }
            if mode == "temporary-storage"
                && !String::from_utf8_lossy(&artifacts.trusted_stdout)
                    .contains("\"temporaryStorageLimited\":true")
            {
                return Err(FoundationError::new(
                    PROCESS_CONTAINMENT_UNAVAILABLE,
                    "private tmpfs capacity probe did not reach the enforced boundary",
                ));
            }
            if mode == "open-files"
                && !String::from_utf8_lossy(&artifacts.trusted_stdout)
                    .contains("\"openFilesLimited\":true")
            {
                return Err(FoundationError::new(
                    PROCESS_CONTAINMENT_UNAVAILABLE,
                    "RLIMIT_NOFILE probe did not reach the enforced boundary",
                ));
            }
            if matches!(mode, "pids" | "threads")
                && artifacts.result.resource_cause.as_deref() != Some("process_count")
            {
                return Err(FoundationError::new(
                    PROCESS_CONTAINMENT_UNAVAILABLE,
                    "pids.max probe did not produce direct process-count attribution",
                ));
            }
            if mode == "memory" && artifacts.result.resource_cause.as_deref() != Some("memory") {
                return Err(FoundationError::new(
                    PROCESS_CONTAINMENT_UNAVAILABLE,
                    "memory.max probe did not produce direct OOM attribution",
                ));
            }
            observations.push(serde_json::json!({
                "mode": mode,
                "terminalOutcome": artifacts.result.terminal_outcome,
                "resourceCause": artifacts.result.resource_cause,
                "enforcementCause": artifacts.result.enforcement_cause,
                "namespaceEvidence": {
                    "mount": artifacts.namespaces.mount_isolated,
                    "pid": artifacts.namespaces.pid_isolated,
                    "network": artifacts.namespaces.network_isolated,
                    "ipc": artifacts.namespaces.ipc_isolated,
                    "uts": artifacts.namespaces.uts_isolated,
                    "cgroup": artifacts.namespaces.cgroup_isolated
                },
                "seccompMode": artifacts.seccomp_mode
            }));
        }
        fs::set_permissions(&probe_root, fs::Permissions::from_mode(0o700)).map_err(unavailable)?;
        sha256_json(&serde_json::json!({
            "probe": self.config.containment_probe,
            "mountPlanVersion": executor::MOUNT_PLAN_VERSION,
            "seccompPolicy": self.seccomp_contract,
            "delegatedCgroupIdentity": self.delegated_cgroup.identity(),
            "observations": observations
        }))
    }

    #[allow(clippy::too_many_arguments)]
    fn probe_launch_plan(
        &self,
        index: u64,
        mode: &str,
        manifest_hash: &str,
        wall_time_ms: u64,
        max_output_bytes: u64,
        max_processes: u64,
        memory_bytes: u64,
        workspace_bytes: u64,
    ) -> Result<LaunchPlan> {
        let operation_id = format!("containment-probe-{index}");
        let operation_identity = launch_contract::build_operation_identity(index, &operation_id)?;
        let rootfs = self
            .rootfs
            .get(&self.config.containment_probe.rootfs_id)
            .expect("probe rootfs validated");
        Ok(LaunchPlan {
            version: 1,
            operation_id,
            operation_identity,
            run_id: index,
            ticket_id: index,
            target_id: "launcher-probe".into(),
            profile_id: mode.into(),
            policy_snapshot_hash: "1".repeat(64),
            runtime_phase: "verification".into(),
            sandbox_capability: launch_contract::SandboxCapabilityProjection {
                generation_id: self.health.generation_id.clone(),
                launcher_protocol_version: PROTOCOL_VERSION,
                launcher_identity_hash: self.health.launcher_identity_hash.clone(),
                sandbox_backend_identity_hash: self.backend.sha256.clone(),
                seccomp_policy_hash: self.seccomp_policy.sha256.clone(),
                rootfs_registry_generation: rootfs.authority.rootfs_registry_generation.clone(),
                materializer_generation: self.health.materializer_generation.clone(),
                delegated_cgroup_identity_hash: self.delegated_cgroup.identity_hash()?,
                containment_probe_hash: self.health.containment_probe_hash.clone(),
            },
            runtime_rootfs: launch_contract::RuntimeRootfs {
                id: self.config.containment_probe.rootfs_id.clone(),
                manifest_sha256: rootfs.config.manifest_sha256.clone(),
            },
            executable_identity: launch_contract::ExecutableIdentity {
                path: self.config.containment_probe.executable_path.clone(),
                sha256: self.config.containment_probe.executable_sha256.clone(),
                format: "elf".into(),
            },
            arguments: vec![mode.into()],
            working_directory: ".".into(),
            environment: BTreeMap::new(),
            workspace_snapshot: launch_contract::WorkspaceSnapshot {
                id: "containment-probe-input".into(),
                run_id: index,
                policy_snapshot_hash: "1".repeat(64),
                materializer_generation: self.health.materializer_generation.clone(),
                manifest_sha256: manifest_hash.into(),
                file_count: 1,
                total_bytes: workspace_bytes,
            },
            filesystem_policy: launch_contract::FilesystemPolicy {
                input_mode: "materialized_read_only".into(),
                writable_roots: vec![],
                allow_symlinks: false,
                allow_special_files: false,
                max_input_files: 1,
                max_input_bytes: workspace_bytes,
            },
            limits: launch_contract::ProcessLimits {
                wall_time_ms,
                max_output_bytes,
                max_processes,
                memory_bytes,
                cpu_quota_micros_per_100ms: 50_000,
                max_open_files: 64,
                max_file_bytes: if mode == "file-size" {
                    1_048_576
                } else {
                    16_777_216
                },
                max_temp_bytes: 8_388_608,
            },
            execution_policy: launch_contract::ExecutionPolicy {
                shell: false,
                stdin: "disabled".into(),
                detached: false,
                network_access: "none".into(),
                environment_mode: "replace".into(),
            },
            launch_plan_hash: "0".repeat(64),
        })
    }
}

impl VerifiedRootfs {
    fn revalidate_identity(&self) -> Result<()> {
        if self.root.current_identity()? != self.root.identity {
            return Err(FoundationError::new(
                PROCESS_ROOTFS_IDENTITY_CHANGED,
                "Pinned rootfs directory identity or authority changed",
            ));
        }
        self.manifest_file
            .revalidate(PROCESS_ROOTFS_IDENTITY_CHANGED, "pinned rootfs manifest")?;
        if scan_rootfs(&self.root, self.root.identity.owner_uid)? != self.manifest {
            return Err(FoundationError::new(
                PROCESS_ROOTFS_IDENTITY_CHANGED,
                "Complete rootfs contents changed after startup verification",
            ));
        }
        Ok(())
    }
}

impl PinnedDirectory {
    fn open_absolute(path: &Path, code: FailureCode) -> Result<Self> {
        let descriptor = open_absolute(path, true, code)?;
        let identity = physical_identity(descriptor.as_raw_fd())?;
        Ok(Self {
            descriptor,
            identity,
        })
    }

    fn duplicate(&self) -> Result<File> {
        let name = CString::new(".").expect("static component contains no NUL");
        let descriptor = unsafe {
            libc::openat(
                self.descriptor.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            )
        };
        if descriptor < 0 {
            return Err(rootfs_unavailable(std::io::Error::last_os_error()));
        }
        Ok(unsafe { File::from_raw_fd(descriptor) })
    }

    fn current_identity(&self) -> Result<PhysicalIdentity> {
        physical_identity(self.descriptor.as_raw_fd())
    }

    fn set_as_current_directory(&self) -> Result<()> {
        if unsafe { libc::fchdir(self.descriptor.as_raw_fd()) } != 0 {
            return Err(unavailable(std::io::Error::last_os_error()));
        }
        Ok(())
    }

    fn proc_path(&self) -> PathBuf {
        PathBuf::from(format!("/proc/self/fd/{}", self.descriptor.as_raw_fd()))
    }
}

impl PinnedFile {
    fn open_absolute(path: &Path, code: FailureCode, maximum_bytes: u64) -> Result<Self> {
        let mut descriptor = open_absolute(path, false, code)?;
        let identity = physical_identity(descriptor.as_raw_fd())?;
        let (_, sha256) =
            hash_reader_with_code(&mut descriptor, maximum_bytes, code, "trusted file")?;
        descriptor
            .rewind()
            .map_err(|error| FoundationError::new(code, error.to_string()))?;
        Ok(Self {
            descriptor,
            identity,
            sha256,
            maximum_bytes,
        })
    }

    fn revalidate(&self, code: FailureCode, label: &str) -> Result<()> {
        if physical_identity(self.descriptor.as_raw_fd())? != self.identity {
            return Err(FoundationError::new(
                code,
                format!("{label} pinned identity or authority changed"),
            ));
        }
        let mut duplicate = self.descriptor.try_clone().map_err(|error| {
            FoundationError::new(code, format!("cannot duplicate {label}: {error}"))
        })?;
        duplicate.rewind().map_err(|error| {
            FoundationError::new(code, format!("cannot rewind {label}: {error}"))
        })?;
        if hash_reader_with_code(&mut duplicate, self.maximum_bytes, code, label)?.1 != self.sha256
        {
            return Err(FoundationError::new(
                code,
                format!("{label} bytes changed after verification"),
            ));
        }
        Ok(())
    }

    fn read_all(&self) -> Result<Vec<u8>> {
        let mut file = self.descriptor.try_clone().map_err(unavailable)?;
        file.rewind().map_err(unavailable)?;
        let mut bytes = Vec::new();
        file.take(self.maximum_bytes + 1)
            .read_to_end(&mut bytes)
            .map_err(unavailable)?;
        if bytes.len() as u64 > self.maximum_bytes {
            return Err(FoundationError::new(
                PROCESS_SECCOMP_POLICY_INVALID,
                "trusted file exceeds its pinned byte ceiling",
            ));
        }
        Ok(bytes)
    }
}

fn handle_connection(service: &Arc<FoundationService>, mut stream: UnixStream) -> Result<()> {
    stream
        .set_read_timeout(Some(PROTOCOL_IO_TIMEOUT))
        .map_err(protocol_io)?;
    stream
        .set_write_timeout(Some(PROTOCOL_IO_TIMEOUT))
        .map_err(protocol_io)?;
    if peer_uid(&stream)? != service.config.allowed_client_uid {
        let response = ErrorResponse {
            version: PROTOCOL_VERSION,
            request_id: None,
            ok: false,
            error: ErrorDocument {
                code: PROCESS_LAUNCHER_CLIENT_UNAUTHORIZED.into(),
                message: "Launcher foundation client is not authorized".into(),
            },
        };
        let _ = write_response(&mut stream, &response);
        drain_rejected_frame(&mut stream);
        return Err(FoundationError::new(
            PROCESS_LAUNCHER_CLIENT_UNAUTHORIZED,
            "Launcher foundation client is not authorized",
        ));
    }
    let bytes = read_frame(&mut stream)?;
    let request: RequestEnvelope = serde_json::from_slice(&bytes).map_err(|error| {
        FoundationError::new(
            PROCESS_LAUNCHER_PROTOCOL_INVALID,
            format!("launcher request envelope is invalid: {error}"),
        )
    })?;
    validate_identifier(&request.request_id, "requestId")?;
    let result = if request.version != PROTOCOL_VERSION {
        Err(protocol("launcher request protocol version must be 1"))
    } else {
        dispatch(service, &request)
    };
    match result {
        Ok(value) => write_response(
            &mut stream,
            &SuccessResponse {
                version: PROTOCOL_VERSION,
                request_id: request.request_id,
                ok: true,
                result: value,
            },
        ),
        Err(error) => write_response(
            &mut stream,
            &ErrorResponse {
                version: PROTOCOL_VERSION,
                request_id: Some(request.request_id),
                ok: false,
                error: ErrorDocument {
                    code: error.code.into(),
                    message: error.message,
                },
            },
        ),
    }
}

fn drain_rejected_frame(stream: &mut UnixStream) {
    let _ = stream.set_read_timeout(Some(Duration::from_millis(250)));
    let mut header = [0_u8; 4];
    if stream.read_exact(&mut header).is_err() {
        return;
    }
    let length = u32::from_be_bytes(header) as usize;
    if length == 0 || length > MAX_MESSAGE_BYTES {
        return;
    }
    let mut remaining = length;
    let mut buffer = [0_u8; 8192];
    while remaining > 0 {
        let requested = remaining.min(buffer.len());
        match stream.read(&mut buffer[..requested]) {
            Ok(0) | Err(_) => return,
            Ok(read) => remaining -= read,
        }
    }
}

fn dispatch(service: &Arc<FoundationService>, request: &RequestEnvelope) -> Result<Value> {
    match request.operation {
        ProtocolOperation::Health => {
            parse_body::<EmptyBody>(&request.body)?;
            serde_json::to_value(service.health()?).map_err(protocol_json)
        }
        ProtocolOperation::GetRootfs => {
            let body = parse_body::<GetRootfsBody>(&request.body)?;
            serde_json::to_value(service.get_rootfs(&body)?).map_err(protocol_json)
        }
        ProtocolOperation::VerifyExecutable => {
            let body = parse_body::<VerifyExecutableBody>(&request.body)?;
            serde_json::to_value(service.verify_executable(&body)?).map_err(protocol_json)
        }
        ProtocolOperation::Launch => {
            let body = parse_body::<LaunchBody>(&request.body)?;
            serde_json::to_value(service.launch(body)?).map_err(protocol_json)
        }
        ProtocolOperation::GetOperation => {
            let body = parse_body::<OperationBody>(&request.body)?;
            serde_json::to_value(service.get_operation(body)?).map_err(protocol_json)
        }
        ProtocolOperation::CancelOperation => {
            let body = parse_body::<OperationBody>(&request.body)?;
            serde_json::to_value(service.cancel_operation(body)?).map_err(protocol_json)
        }
        ProtocolOperation::ReadOutput => {
            let body = parse_body::<ReadOutputBody>(&request.body)?;
            serde_json::to_value(service.read_output(body)?).map_err(protocol_json)
        }
        ProtocolOperation::AcknowledgeOutput => {
            let body = parse_body::<AcknowledgeOutputBody>(&request.body)?;
            serde_json::to_value(service.acknowledge_output(body)?).map_err(protocol_json)
        }
    }
}

fn parse_body<T: for<'de> Deserialize<'de>>(value: &Value) -> Result<T> {
    serde_json::from_value(value.clone()).map_err(|error| {
        FoundationError::new(
            PROCESS_LAUNCHER_PROTOCOL_INVALID,
            format!("launcher request body is invalid: {error}"),
        )
    })
}

fn validate_containment_rootfs_mountpoints(rootfs: &VerifiedRootfs) -> Result<()> {
    for required in ["dev", "proc", "tmp", "workspace"] {
        if !rootfs.manifest.entries.iter().any(|entry| {
            matches!(
                entry,
                RootfsManifestEntry::Directory { path, mode }
                    if path == required && mode == "0555"
            )
        }) {
            return Err(FoundationError::new(
                PROCESS_MOUNT_LAYOUT_INVALID,
                format!("containment rootfs is missing the immutable /{required} mountpoint"),
            ));
        }
    }
    Ok(())
}

fn verify_rootfs_registry(
    config: &ServiceConfig,
    state_root: &PinnedDirectory,
    socket_directory: &PinnedDirectory,
) -> Result<BTreeMap<String, VerifiedRootfs>> {
    let protected = pin_existing_protected_paths(config)?;
    let mut roots: Vec<PinnedDirectory> = Vec::new();
    let mut output = BTreeMap::new();
    for entry in &config.rootfs_registry {
        let root = PinnedDirectory::open_absolute(
            Path::new(&entry.root_path),
            PROCESS_ROOTFS_UNAVAILABLE,
        )?;
        validate_rootfs_directory(&root, config.trusted_rootfs_owner_uid)?;
        for existing in &roots {
            if directories_overlap(existing, &root)? {
                return Err(FoundationError::new(
                    PROCESS_ROOTFS_REGISTRY_INVALID,
                    "rootfs registry contains duplicate or physically overlapping directories",
                ));
            }
        }
        for boundary in protected.iter().chain([state_root, socket_directory]) {
            if directories_overlap(&root, boundary)? {
                return Err(FoundationError::new(
                    PROCESS_ROOTFS_REGISTRY_INVALID,
                    "rootfs physically overlaps runtime, workspace, materializer, state, or socket storage",
                ));
            }
        }
        let manifest_file = PinnedFile::open_absolute(
            Path::new(&entry.manifest_path),
            PROCESS_ROOTFS_MANIFEST_INVALID,
            MAX_ROOTFS_MANIFEST_BYTES as u64,
        )?;
        validate_trusted_file(
            &manifest_file,
            config.trusted_rootfs_owner_uid,
            false,
            PROCESS_ROOTFS_MANIFEST_INVALID,
            "rootfs manifest",
        )?;
        if manifest_file.sha256 != entry.manifest_sha256 {
            return Err(FoundationError::new(
                PROCESS_ROOTFS_MANIFEST_MISMATCH,
                format!("rootfs manifest hash mismatch for {}", entry.id),
            ));
        }
        let manifest_bytes = read_bounded_file(
            &manifest_file.descriptor,
            MAX_ROOTFS_MANIFEST_BYTES,
            PROCESS_ROOTFS_MANIFEST_INVALID,
        )?;
        let manifest: RootfsManifest =
            serde_json::from_slice(&manifest_bytes).map_err(|error| {
                FoundationError::new(
                    PROCESS_ROOTFS_MANIFEST_INVALID,
                    format!("rootfs manifest is invalid: {error}"),
                )
            })?;
        validate_rootfs_manifest(&manifest)?;
        if canonical_json(&manifest)? != manifest_bytes {
            return Err(FoundationError::new(
                PROCESS_ROOTFS_MANIFEST_INVALID,
                "rootfs manifest must use exact canonical JSON",
            ));
        }
        let actual = scan_rootfs(&root, config.trusted_rootfs_owner_uid)?;
        if actual != manifest {
            return Err(FoundationError::new(
                PROCESS_ROOTFS_MANIFEST_MISMATCH,
                format!(
                    "complete rootfs tree does not match manifest for {}",
                    entry.id
                ),
            ));
        }
        let mut regular_files = BTreeMap::new();
        let mut total_regular_bytes = 0_u64;
        for item in &manifest.entries {
            if let RootfsManifestEntry::RegularFile {
                path,
                size,
                sha256,
                mode,
            } = item
            {
                total_regular_bytes = total_regular_bytes.checked_add(*size).ok_or_else(|| {
                    FoundationError::new(
                        PROCESS_ROOTFS_MANIFEST_INVALID,
                        "rootfs regular-file byte total overflows",
                    )
                })?;
                let parsed_mode = u32::from_str_radix(mode, 8).map_err(|_| {
                    FoundationError::new(
                        PROCESS_ROOTFS_MANIFEST_INVALID,
                        "rootfs regular-file mode is invalid",
                    )
                })?;
                regular_files.insert(path.clone(), (*size, sha256.clone(), parsed_mode));
            }
        }
        let physical_identity_hash = sha256_json(&(root.identity, manifest_file.identity))?;
        let authority = RootfsAuthority {
            id: entry.id.clone(),
            manifest_sha256: entry.manifest_sha256.clone(),
            physical_identity_hash,
            entry_count: manifest.entries.len() as u64,
            total_regular_bytes,
            rootfs_registry_generation: String::new(),
        };
        roots.push(PinnedDirectory {
            descriptor: root.duplicate()?,
            identity: root.identity,
        });
        output.insert(
            entry.id.clone(),
            VerifiedRootfs {
                config: entry.clone(),
                root,
                manifest_file,
                manifest,
                authority,
                regular_files,
            },
        );
    }
    Ok(output)
}

fn validate_rootfs_manifest(manifest: &RootfsManifest) -> Result<()> {
    if manifest.version != ROOTFS_MANIFEST_SCHEMA_VERSION {
        return Err(FoundationError::new(
            PROCESS_ROOTFS_MANIFEST_INVALID,
            "rootfs manifest version must be 1",
        ));
    }
    if manifest.entries.is_empty() || manifest.entries.len() > MAX_ROOTFS_ENTRIES {
        return Err(FoundationError::new(
            PROCESS_ROOTFS_MANIFEST_INVALID,
            format!("rootfs manifest must contain 1..={MAX_ROOTFS_ENTRIES} entries"),
        ));
    }
    let mut previous: Option<&str> = None;
    let mut directories = BTreeSet::new();
    let mut total = 0_u64;
    for entry in &manifest.entries {
        let path = entry.path();
        validate_relative_path(path, "rootfs manifest path")?;
        if let Some(last) = previous
            && last.as_bytes() >= path.as_bytes()
        {
            return Err(FoundationError::new(
                PROCESS_ROOTFS_MANIFEST_INVALID,
                "rootfs manifest entries must be unique and bytewise ordered",
            ));
        }
        if let Some(parent) = Path::new(path).parent()
            && !parent.as_os_str().is_empty()
            && !directories.contains(parent.to_str().unwrap_or_default())
        {
            return Err(FoundationError::new(
                PROCESS_ROOTFS_MANIFEST_INVALID,
                "rootfs manifest must contain explicit parent directories before children",
            ));
        }
        match entry {
            RootfsManifestEntry::Directory { mode, .. } => {
                validate_manifest_mode(mode, true)?;
                directories.insert(path);
            }
            RootfsManifestEntry::RegularFile {
                size, sha256, mode, ..
            } => {
                validate_manifest_mode(mode, false)?;
                validate_sha256(sha256, "rootfs regular-file sha256")?;
                total = total.checked_add(*size).ok_or_else(|| {
                    FoundationError::new(
                        PROCESS_ROOTFS_MANIFEST_INVALID,
                        "rootfs byte total overflows",
                    )
                })?;
                if total > MAX_ROOTFS_REGULAR_BYTES {
                    return Err(FoundationError::new(
                        PROCESS_ROOTFS_MANIFEST_INVALID,
                        "rootfs regular bytes exceed the hard ceiling",
                    ));
                }
            }
            RootfsManifestEntry::SymbolicLink { target, .. } => {
                validate_symlink_target(path, target)?;
            }
        }
        previous = Some(path);
    }
    Ok(())
}

fn scan_rootfs(root: &PinnedDirectory, trusted_owner_uid: u32) -> Result<RootfsManifest> {
    let before = root.current_identity()?;
    let root_file = root.duplicate()?;
    let mut entries = Vec::new();
    let mut total = 0_u64;
    scan_rootfs_directory(
        root_file.as_raw_fd(),
        "",
        0,
        trusted_owner_uid,
        &mut entries,
        &mut total,
    )?;
    entries.sort_by(|left, right| left.path().as_bytes().cmp(right.path().as_bytes()));
    let manifest = RootfsManifest {
        version: ROOTFS_MANIFEST_SCHEMA_VERSION,
        entries,
    };
    if root.current_identity()? != before {
        return Err(FoundationError::new(
            PROCESS_ROOTFS_IDENTITY_CHANGED,
            "rootfs root identity changed during complete verification",
        ));
    }
    validate_rootfs_manifest(&manifest)?;
    Ok(manifest)
}

fn scan_rootfs_directory(
    directory_fd: RawFd,
    parent: &str,
    depth: usize,
    trusted_owner_uid: u32,
    entries: &mut Vec<RootfsManifestEntry>,
    total: &mut u64,
) -> Result<()> {
    if depth > MAX_DIRECTORY_DEPTH {
        return Err(rootfs_entry(
            "rootfs directory depth exceeds the hard ceiling",
        ));
    }
    let mut names = read_directory_names(directory_fd)?;
    names.sort();
    for raw_name in names {
        if entries.len() >= MAX_ROOTFS_ENTRIES {
            return Err(rootfs_entry("rootfs entry count exceeds the hard ceiling"));
        }
        let name = validate_filename(&raw_name)?;
        let relative = if parent.is_empty() {
            name.to_owned()
        } else {
            format!("{parent}/{name}")
        };
        validate_relative_path(&relative, "rootfs entry path")?;
        let stat = stat_at(directory_fd, &raw_name)?;
        validate_rootfs_entry_authority(&stat, trusted_owner_uid, &relative)?;
        let mode = stat.st_mode & 0o7777;
        match stat.st_mode & libc::S_IFMT {
            libc::S_IFDIR => {
                let child = open_relative_component(directory_fd, &raw_name, true)?;
                let opened = physical_identity(child.as_raw_fd())?;
                if opened.device != stat.st_dev
                    || opened.inode != stat.st_ino
                    || opened.mode != mode
                {
                    return Err(FoundationError::new(
                        PROCESS_ROOTFS_IDENTITY_CHANGED,
                        format!("rootfs directory changed while opening: {relative}"),
                    ));
                }
                entries.push(RootfsManifestEntry::Directory {
                    path: relative.clone(),
                    mode: format!("{mode:04o}"),
                });
                scan_rootfs_directory(
                    child.as_raw_fd(),
                    &relative,
                    depth + 1,
                    trusted_owner_uid,
                    entries,
                    total,
                )?;
                if !same_stat_identity(&stat, &stat_at(directory_fd, &raw_name)?) {
                    return Err(FoundationError::new(
                        PROCESS_ROOTFS_IDENTITY_CHANGED,
                        format!("rootfs directory changed during traversal: {relative}"),
                    ));
                }
            }
            libc::S_IFREG => {
                let mut file = open_relative_component(directory_fd, &raw_name, false)?;
                let opened = physical_identity(file.as_raw_fd())?;
                if opened.device != stat.st_dev
                    || opened.inode != stat.st_ino
                    || opened.mode != mode
                {
                    return Err(FoundationError::new(
                        PROCESS_ROOTFS_IDENTITY_CHANGED,
                        format!("rootfs file changed while opening: {relative}"),
                    ));
                }
                reject_file_capability(file.as_raw_fd(), &relative)?;
                let (size, sha256) = hash_reader(&mut file, MAX_ROOTFS_REGULAR_BYTES)?;
                *total = total
                    .checked_add(size)
                    .ok_or_else(|| rootfs_entry("rootfs regular-file byte total overflows"))?;
                if *total > MAX_ROOTFS_REGULAR_BYTES {
                    return Err(rootfs_entry("rootfs regular bytes exceed the hard ceiling"));
                }
                let after = stat_at(directory_fd, &raw_name)?;
                if !same_stat_identity(&stat, &after) {
                    return Err(FoundationError::new(
                        PROCESS_ROOTFS_IDENTITY_CHANGED,
                        format!("rootfs file changed while hashing: {relative}"),
                    ));
                }
                entries.push(RootfsManifestEntry::RegularFile {
                    path: relative,
                    size,
                    sha256,
                    mode: format!("{mode:04o}"),
                });
            }
            libc::S_IFLNK => {
                let target = read_link_at(directory_fd, &raw_name)?;
                validate_symlink_target(&relative, &target)?;
                if !same_stat_identity(&stat, &stat_at(directory_fd, &raw_name)?) {
                    return Err(FoundationError::new(
                        PROCESS_ROOTFS_IDENTITY_CHANGED,
                        format!("rootfs symbolic link changed while reading: {relative}"),
                    ));
                }
                entries.push(RootfsManifestEntry::SymbolicLink {
                    path: relative,
                    target,
                });
            }
            _ => {
                return Err(rootfs_entry(format!(
                    "rootfs contains a forbidden special filesystem object: {relative}"
                )));
            }
        }
    }
    Ok(())
}

fn derive_rootfs_registry_generation(
    config: &ServiceConfig,
    rootfs: &BTreeMap<String, VerifiedRootfs>,
    launcher_identity_hash: &str,
    backend: &PinnedFile,
    seccomp_policy: &PinnedFile,
) -> Result<String> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct GenerationMaterial<'a> {
        launcher_protocol_version: u32,
        launcher_identity_hash: &'a str,
        trusted_configuration_hash: String,
        rootfs: Vec<(&'a str, &'a str, &'a str)>,
        sandbox_backend_identity_hash: &'a str,
        sandbox_backend_physical_identity: PhysicalIdentity,
        seccomp_policy_hash: &'a str,
        seccomp_policy_physical_identity: PhysicalIdentity,
        rootfs_manifest_schema_version: u32,
    }
    let trusted_configuration_hash = sha256_json(config)?;
    let rootfs_material = rootfs
        .values()
        .map(|item| {
            (
                item.config.id.as_str(),
                item.config.manifest_sha256.as_str(),
                item.authority.physical_identity_hash.as_str(),
            )
        })
        .collect();
    let hash = sha256_json(&GenerationMaterial {
        launcher_protocol_version: PROTOCOL_VERSION,
        launcher_identity_hash,
        trusted_configuration_hash,
        rootfs: rootfs_material,
        sandbox_backend_identity_hash: &backend.sha256,
        sandbox_backend_physical_identity: backend.identity,
        seccomp_policy_hash: &seccomp_policy.sha256,
        seccomp_policy_physical_identity: seccomp_policy.identity,
        rootfs_manifest_schema_version: ROOTFS_MANIFEST_SCHEMA_VERSION,
    })?;
    Ok(format!("rootfs-registry-v1-{hash}"))
}

fn inspect_host_prerequisites() -> Result<HostPrerequisiteInspection> {
    if std::env::consts::OS != "linux" {
        return Err(FoundationError::new(
            PROCESS_SANDBOX_PREREQUISITES_UNAVAILABLE,
            "launcher foundation requires Linux",
        ));
    }
    let kernel_release = uname_release()?;
    let cgroup_path = CString::new("/sys/fs/cgroup").expect("static path contains no NUL");
    let mut statfs: libc::statfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statfs(cgroup_path.as_ptr(), &mut statfs) } != 0
        || statfs.f_type != CGROUP2_SUPER_MAGIC
    {
        return Err(FoundationError::new(
            PROCESS_SANDBOX_PREREQUISITES_UNAVAILABLE,
            "cgroup v2 unified hierarchy is unavailable",
        ));
    }
    let mut controllers = fs::read_to_string("/sys/fs/cgroup/cgroup.controllers")
        .map_err(prerequisite)?
        .split_whitespace()
        .map(str::to_owned)
        .collect::<Vec<_>>();
    controllers.sort_by(|left, right| left.as_bytes().cmp(right.as_bytes()));
    for required in ["cpu", "memory", "pids"] {
        if !controllers.iter().any(|value| value == required) {
            return Err(FoundationError::new(
                PROCESS_SANDBOX_PREREQUISITES_UNAVAILABLE,
                format!("cgroup v2 controller is unavailable: {required}"),
            ));
        }
    }
    let max_user_namespaces = fs::read_to_string("/proc/sys/user/max_user_namespaces")
        .map_err(prerequisite)?
        .trim()
        .parse::<u64>()
        .map_err(|_| prerequisite_message("user namespace limit is invalid"))?;
    if max_user_namespaces == 0 {
        return Err(prerequisite_message("user namespaces are disabled"));
    }
    for namespace in ["user", "mnt", "pid", "net"] {
        let metadata =
            fs::symlink_metadata(format!("/proc/self/ns/{namespace}")).map_err(prerequisite)?;
        if !metadata.file_type().is_symlink() {
            return Err(prerequisite_message(format!(
                "{namespace} namespace handle is unavailable"
            )));
        }
    }
    let seccomp_actions =
        fs::read_to_string("/proc/sys/kernel/seccomp/actions_avail").map_err(prerequisite)?;
    if !seccomp_actions
        .split_whitespace()
        .any(|value| value == "allow")
        || !seccomp_actions
            .split_whitespace()
            .any(|value| value == "kill_process")
    {
        return Err(prerequisite_message(
            "seccomp filter actions are unavailable",
        ));
    }
    if unsafe { libc::prctl(libc::PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0) } < 0 {
        return Err(prerequisite_message(
            "no_new_privs kernel support is unavailable",
        ));
    }
    Ok(HostPrerequisiteInspection {
        platform: "linux".into(),
        kernel_release,
        cgroup_v2: "statically_present".into(),
        cgroup_controllers: controllers,
        delegated_cgroup_root: "statically_present".into(),
        user_namespaces: "statically_present".into(),
        mount_namespaces: "statically_present".into(),
        pid_namespaces: "statically_present".into(),
        network_namespaces: "statically_present".into(),
        seccomp_filter: "statically_present".into(),
        no_new_privs: "statically_present".into(),
        active_containment_proof: "not_proven_until_2a3".into(),
    })
}

fn pin_socket_directory(config: &ServiceConfig) -> Result<(PinnedDirectory, String)> {
    let socket_path = Path::new(&config.socket_path);
    let parent = socket_path
        .parent()
        .ok_or_else(|| protocol("socketPath has no parent directory"))?;
    let name = socket_path
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty() && !value.contains('/'))
        .ok_or_else(|| protocol("socketPath must end in one exact UTF-8 entry"))?;
    let directory =
        PinnedDirectory::open_absolute(parent, PROCESS_LAUNCHER_FOUNDATION_UNAVAILABLE)?;
    validate_service_directory(
        &directory,
        "launcher socket directory",
        0o750,
        config.runtime_client_gid,
    )?;
    Ok((directory, name.to_owned()))
}

fn validate_service_directory(
    directory: &PinnedDirectory,
    label: &str,
    exact_mode: u32,
    expected_gid: u32,
) -> Result<()> {
    if directory.identity.owner_uid != unsafe { libc::geteuid() }
        || directory.identity.owner_gid != expected_gid
        || directory.identity.mode != exact_mode
    {
        return Err(FoundationError::new(
            PROCESS_LAUNCHER_FOUNDATION_UNAVAILABLE,
            format!(
                "{label} must be service-owned by the configured group with mode {exact_mode:04o}"
            ),
        ));
    }
    Ok(())
}

fn chown_group(path: &Path, gid: u32) -> Result<()> {
    let path = CString::new(path.as_os_str().as_bytes())
        .map_err(|_| protocol("launcher socket path contains a NUL byte"))?;
    let status = unsafe { libc::chown(path.as_ptr(), u32::MAX, gid) };
    if status != 0 {
        return Err(FoundationError::new(
            PROCESS_LAUNCHER_FOUNDATION_UNAVAILABLE,
            format!(
                "cannot assign launcher socket to the runtime client group: {}",
                std::io::Error::last_os_error()
            ),
        ));
    }
    Ok(())
}

fn validate_rootfs_directory(directory: &PinnedDirectory, trusted_uid: u32) -> Result<()> {
    if directory.identity.owner_uid != trusted_uid || directory.identity.mode & 0o222 != 0 {
        return Err(FoundationError::new(
            PROCESS_ROOTFS_UNAVAILABLE,
            "rootfs must be trusted-owner-owned and not group- or world-writable",
        ));
    }
    Ok(())
}

fn validate_trusted_file(
    file: &PinnedFile,
    trusted_uid: u32,
    executable: bool,
    code: FailureCode,
    label: &str,
) -> Result<()> {
    if !file
        .descriptor
        .metadata()
        .map_err(|error| FoundationError::new(code, error.to_string()))?
        .is_file()
        || file.identity.owner_uid != trusted_uid
        || file.identity.mode & 0o022 != 0
        || file.identity.mode & 0o6000 != 0
        || executable && file.identity.mode & 0o111 == 0
    {
        return Err(FoundationError::new(
            code,
            format!("{label} ownership or mode is not trusted"),
        ));
    }
    Ok(())
}

fn acquire_instance_lock(state_root: &PinnedDirectory) -> Result<File> {
    let name = CString::new(INSTANCE_LOCK_NAME).expect("static lock name contains no NUL");
    let descriptor = unsafe {
        libc::openat(
            state_root.descriptor.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDWR | libc::O_CREAT | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            INSTANCE_LOCK_MODE,
        )
    };
    if descriptor < 0 {
        return Err(unavailable(std::io::Error::last_os_error()));
    }
    let file = unsafe { File::from_raw_fd(descriptor) };
    let identity = physical_identity(file.as_raw_fd())?;
    if identity.owner_uid != unsafe { libc::geteuid() } || identity.mode != INSTANCE_LOCK_MODE {
        return Err(FoundationError::new(
            PROCESS_LAUNCHER_FOUNDATION_UNAVAILABLE,
            "launcher lifetime lease must be service-owned with mode 0600",
        ));
    }
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::EWOULDBLOCK) {
            return Err(FoundationError::new(
                PROCESS_LAUNCHER_ALREADY_RUNNING,
                "Another launcher foundation instance already owns this state root",
            ));
        }
        return Err(unavailable(error));
    }
    Ok(file)
}

fn prepare_socket_path(directory: &PinnedDirectory, socket_name: &str) -> Result<PathBuf> {
    if directory.current_identity()? != directory.identity {
        return Err(FoundationError::new(
            PROCESS_LAUNCHER_FOUNDATION_UNAVAILABLE,
            "launcher socket directory authority changed after startup",
        ));
    }
    let path = PathBuf::from(socket_name);
    match fs::symlink_metadata(&path) {
        Ok(metadata)
            if metadata.file_type().is_socket() && metadata.uid() == unsafe { libc::geteuid() } =>
        {
            fs::remove_file(&path).map_err(unavailable)?;
        }
        Ok(_) => {
            return Err(FoundationError::new(
                PROCESS_LAUNCHER_FOUNDATION_UNAVAILABLE,
                "launcher socket entry exists with invalid type or ownership",
            ));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(unavailable(error)),
    }
    Ok(path)
}

fn pin_existing_protected_paths(config: &ServiceConfig) -> Result<Vec<PinnedDirectory>> {
    let mut output = Vec::new();
    for value in config
        .protected_host_paths
        .runtime_data
        .iter()
        .chain(config.protected_host_paths.materializer_state.iter())
        .chain(config.protected_host_paths.workspaces.iter())
    {
        let root =
            PinnedDirectory::open_absolute(Path::new(value), PROCESS_ROOTFS_REGISTRY_INVALID)?;
        output.push(root);
    }
    Ok(output)
}

fn directories_overlap(left: &PinnedDirectory, right: &PinnedDirectory) -> Result<bool> {
    Ok(directory_contains(left, right)? || directory_contains(right, left)?)
}

fn directory_contains(ancestor: &PinnedDirectory, descendant: &PinnedDirectory) -> Result<bool> {
    let mut current = descendant.duplicate()?;
    loop {
        let identity = physical_identity(current.as_raw_fd())?;
        if identity.device == ancestor.identity.device && identity.inode == ancestor.identity.inode
        {
            return Ok(true);
        }
        let name = CString::new("..").expect("static path contains no NUL");
        let fd = unsafe {
            libc::openat(
                current.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            )
        };
        if fd < 0 {
            return Err(rootfs_unavailable(std::io::Error::last_os_error()));
        }
        let parent = unsafe { File::from_raw_fd(fd) };
        let parent_identity = physical_identity(parent.as_raw_fd())?;
        if parent_identity.device == identity.device && parent_identity.inode == identity.inode {
            return Ok(false);
        }
        current = parent;
    }
}

#[repr(C)]
struct OpenHow {
    flags: u64,
    mode: u64,
    resolve: u64,
}

fn open_absolute(path: &Path, directory: bool, code: FailureCode) -> Result<File> {
    validate_host_path(path, "trusted absolute path")?;
    let root_name = CString::new("/").expect("static root contains no NUL");
    let root_fd = unsafe {
        libc::open(
            root_name.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
        )
    };
    if root_fd < 0 {
        return Err(FoundationError::new(
            code,
            std::io::Error::last_os_error().to_string(),
        ));
    }
    let root = unsafe { File::from_raw_fd(root_fd) };
    if path == Path::new("/") {
        if directory {
            return root
                .try_clone()
                .map_err(|error| FoundationError::new(code, error.to_string()));
        }
        return Err(FoundationError::new(code, "trusted file path cannot be /"));
    }
    let relative = path
        .strip_prefix("/")
        .map_err(|_| FoundationError::new(code, "trusted path must be absolute"))?;
    let name = CString::new(relative.as_os_str().as_bytes())
        .map_err(|_| FoundationError::new(code, "trusted path contains NUL"))?;
    let flags = libc::O_RDONLY
        | libc::O_CLOEXEC
        | libc::O_NOFOLLOW
        | if directory { libc::O_DIRECTORY } else { 0 };
    let how = OpenHow {
        flags: flags as u64,
        mode: 0,
        resolve: RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS,
    };
    let fd = unsafe {
        libc::syscall(
            libc::SYS_openat2,
            root.as_raw_fd(),
            name.as_ptr(),
            &how,
            std::mem::size_of::<OpenHow>(),
        ) as i32
    };
    if fd < 0 {
        return Err(FoundationError::new(
            code,
            format!(
                "trusted path cannot be pinned without symbolic or magic links: {}",
                std::io::Error::last_os_error()
            ),
        ));
    }
    Ok(unsafe { File::from_raw_fd(fd) })
}

fn open_relative_component(parent_fd: RawFd, name: &[u8], directory: bool) -> Result<File> {
    let name = CString::new(name).map_err(|_| rootfs_entry("rootfs component contains NUL"))?;
    let flags = libc::O_RDONLY
        | libc::O_CLOEXEC
        | libc::O_NOFOLLOW
        | if directory { libc::O_DIRECTORY } else { 0 };
    let how = OpenHow {
        flags: flags as u64,
        mode: 0,
        resolve: RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS,
    };
    let fd = unsafe {
        libc::syscall(
            libc::SYS_openat2,
            parent_fd,
            name.as_ptr(),
            &how,
            std::mem::size_of::<OpenHow>(),
        ) as i32
    };
    if fd < 0 {
        return Err(FoundationError::new(
            PROCESS_ROOTFS_IDENTITY_CHANGED,
            format!(
                "descriptor-relative rootfs open failed: {}",
                std::io::Error::last_os_error()
            ),
        ));
    }
    Ok(unsafe { File::from_raw_fd(fd) })
}

fn open_relative_path(root: &PinnedDirectory, path: &str, directory: bool) -> Result<File> {
    let name = CString::new(path.as_bytes()).map_err(|_| rootfs_entry("path contains NUL"))?;
    let flags = libc::O_RDONLY
        | libc::O_CLOEXEC
        | libc::O_NOFOLLOW
        | if directory { libc::O_DIRECTORY } else { 0 };
    let how = OpenHow {
        flags: flags as u64,
        mode: 0,
        resolve: RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS,
    };
    let fd = unsafe {
        libc::syscall(
            libc::SYS_openat2,
            root.descriptor.as_raw_fd(),
            name.as_ptr(),
            &how,
            std::mem::size_of::<OpenHow>(),
        ) as i32
    };
    if fd < 0 {
        return Err(FoundationError::new(
            PROCESS_EXECUTABLE_IDENTITY_MISMATCH,
            format!(
                "executable cannot be resolved inside pinned rootfs: {}",
                std::io::Error::last_os_error()
            ),
        ));
    }
    Ok(unsafe { File::from_raw_fd(fd) })
}

fn read_directory_names(directory_fd: RawFd) -> Result<Vec<Vec<u8>>> {
    let duplicate = unsafe { libc::dup(directory_fd) };
    if duplicate < 0 {
        return Err(rootfs_unavailable(std::io::Error::last_os_error()));
    }
    let directory = unsafe { libc::fdopendir(duplicate) };
    if directory.is_null() {
        unsafe { libc::close(duplicate) };
        return Err(rootfs_unavailable(std::io::Error::last_os_error()));
    }
    let mut names = Vec::new();
    loop {
        unsafe { *libc::__errno_location() = 0 };
        let entry = unsafe { libc::readdir(directory) };
        if entry.is_null() {
            let error = unsafe { *libc::__errno_location() };
            unsafe { libc::closedir(directory) };
            if error != 0 {
                return Err(rootfs_unavailable(std::io::Error::from_raw_os_error(error)));
            }
            return Ok(names);
        }
        let bytes = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) }.to_bytes();
        if bytes != b"." && bytes != b".." {
            names.push(bytes.to_vec());
            if names.len() > MAX_ROOTFS_ENTRIES {
                unsafe { libc::closedir(directory) };
                return Err(rootfs_entry(
                    "one rootfs directory exceeds the entry ceiling",
                ));
            }
        }
    }
}

fn stat_at(directory_fd: RawFd, raw_name: &[u8]) -> Result<libc::stat> {
    let name = CString::new(raw_name).map_err(|_| rootfs_entry("path component contains NUL"))?;
    let mut stat: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe {
        libc::fstatat(
            directory_fd,
            name.as_ptr(),
            &mut stat,
            libc::AT_SYMLINK_NOFOLLOW,
        )
    } != 0
    {
        return Err(FoundationError::new(
            PROCESS_ROOTFS_IDENTITY_CHANGED,
            format!("rootfs entry changed: {}", std::io::Error::last_os_error()),
        ));
    }
    Ok(stat)
}

fn same_stat_identity(left: &libc::stat, right: &libc::stat) -> bool {
    left.st_dev == right.st_dev
        && left.st_ino == right.st_ino
        && left.st_mode == right.st_mode
        && left.st_uid == right.st_uid
        && left.st_gid == right.st_gid
        && left.st_size == right.st_size
}

fn read_link_at(directory_fd: RawFd, raw_name: &[u8]) -> Result<String> {
    let name = CString::new(raw_name).map_err(|_| rootfs_entry("link name contains NUL"))?;
    let mut bytes = vec![0_u8; MAX_PATH_BYTES + 1];
    let length = unsafe {
        libc::readlinkat(
            directory_fd,
            name.as_ptr(),
            bytes.as_mut_ptr().cast::<libc::c_char>(),
            bytes.len(),
        )
    };
    if length < 0 {
        return Err(FoundationError::new(
            PROCESS_ROOTFS_IDENTITY_CHANGED,
            format!(
                "cannot read rootfs symbolic link: {}",
                std::io::Error::last_os_error()
            ),
        ));
    }
    let length = length as usize;
    if length == 0 || length > MAX_PATH_BYTES {
        return Err(rootfs_entry(
            "rootfs symbolic-link target is empty or oversized",
        ));
    }
    bytes.truncate(length);
    String::from_utf8(bytes)
        .map_err(|_| rootfs_entry("rootfs symbolic-link target must be exact UTF-8"))
}

fn reject_file_capability(fd: RawFd, path: &str) -> Result<()> {
    let name = CString::new("security.capability").expect("static xattr name contains no NUL");
    let status = unsafe { libc::fgetxattr(fd, name.as_ptr(), std::ptr::null_mut(), 0) };
    if status >= 0 {
        return Err(rootfs_entry(format!(
            "rootfs file capabilities are forbidden: {path}"
        )));
    }
    let error = std::io::Error::last_os_error();
    if !matches!(
        error.raw_os_error(),
        Some(libc::ENODATA) | Some(libc::ENOTSUP)
    ) {
        return Err(rootfs_entry(format!(
            "rootfs file capability inspection failed for {path}: {error}"
        )));
    }
    Ok(())
}

fn validate_rootfs_entry_authority(
    stat: &libc::stat,
    trusted_owner_uid: u32,
    path: &str,
) -> Result<()> {
    let mode = stat.st_mode & 0o7777;
    let kind = stat.st_mode & libc::S_IFMT;
    if stat.st_uid != trusted_owner_uid
        || kind != libc::S_IFLNK && (mode & 0o222 != 0 || mode & 0o6000 != 0)
    {
        return Err(rootfs_entry(format!(
            "rootfs entry ownership or mode is not immutable: {path}"
        )));
    }
    Ok(())
}

fn validate_manifest_mode(value: &str, directory: bool) -> Result<()> {
    if value.len() != 4 || !value.bytes().all(|byte| matches!(byte, b'0'..=b'7')) {
        return Err(rootfs_entry("rootfs mode must be four octal digits"));
    }
    let mode = u32::from_str_radix(value, 8).map_err(|_| rootfs_entry("rootfs mode is invalid"))?;
    if mode & 0o222 != 0 || mode & 0o6000 != 0 || directory && mode & 0o111 == 0 {
        return Err(rootfs_entry(
            "rootfs entries must be read-only, unprivileged, and directories searchable",
        ));
    }
    Ok(())
}

fn validate_symlink_target(path: &str, target: &str) -> Result<()> {
    if target.is_empty()
        || target.len() > MAX_PATH_BYTES
        || target.as_bytes().iter().any(|byte| byte.is_ascii_control())
        || target.starts_with('/')
    {
        return Err(rootfs_entry(
            "rootfs symbolic-link targets must be bounded relative UTF-8 paths",
        ));
    }
    let mut depth = Path::new(path)
        .parent()
        .map(|parent| parent.components().count())
        .unwrap_or(0);
    for component in Path::new(target).components() {
        match component {
            Component::Normal(value) => {
                let bytes = value.as_bytes();
                if bytes.is_empty()
                    || bytes.len() > MAX_COMPONENT_BYTES
                    || bytes.iter().any(|byte| byte.is_ascii_control())
                {
                    return Err(rootfs_entry("rootfs symbolic-link target is invalid"));
                }
                depth += 1;
            }
            Component::CurDir => {}
            Component::ParentDir if depth > 0 => depth -= 1,
            Component::ParentDir => {
                return Err(rootfs_entry(
                    "rootfs symbolic-link target can escape the sandbox root",
                ));
            }
            _ => return Err(rootfs_entry("rootfs symbolic-link target is invalid")),
        }
    }
    Ok(())
}

fn validate_executable_path(value: &str) -> Result<&str> {
    if !value.starts_with('/') || value == "/" || value.len() > MAX_PATH_BYTES {
        return Err(FoundationError::new(
            PROCESS_EXECUTABLE_IDENTITY_MISMATCH,
            "executablePath must be a normalized absolute path inside the rootfs",
        ));
    }
    let relative = &value[1..];
    validate_relative_path(relative, "executablePath").map_err(|error| {
        FoundationError::new(PROCESS_EXECUTABLE_IDENTITY_MISMATCH, error.message)
    })?;
    Ok(relative)
}

fn validate_executable_mode(mode: u32) -> Result<()> {
    if mode & 0o111 == 0 {
        return Err(FoundationError::new(
            PROCESS_EXECUTABLE_IDENTITY_MISMATCH,
            "Executable manifest entry has no execute permission",
        ));
    }
    Ok(())
}

pub(crate) fn verify_elf_identity(
    root: &PinnedDirectory,
    relative: &str,
    expected_size: u64,
    expected_sha256: &str,
) -> Result<()> {
    let mut file = open_relative_path(root, relative, false)?;
    let metadata = file.metadata().map_err(rootfs_unavailable)?;
    if metadata.len() != expected_size || !metadata.is_file() {
        return Err(FoundationError::new(
            PROCESS_ROOTFS_IDENTITY_CHANGED,
            "Executable identity changed after rootfs verification",
        ));
    }
    let mut header = [0_u8; 20];
    file.read_exact(&mut header).map_err(|_| {
        FoundationError::new(
            PROCESS_EXECUTABLE_FORMAT_UNSUPPORTED,
            "Executable is too short to contain a valid ELF header",
        )
    })?;
    let byte_order = header[5];
    let object_type = match byte_order {
        1 => u16::from_le_bytes([header[16], header[17]]),
        2 => u16::from_be_bytes([header[16], header[17]]),
        _ => 0,
    };
    let machine = match byte_order {
        1 => u16::from_le_bytes([header[18], header[19]]),
        2 => u16::from_be_bytes([header[18], header[19]]),
        _ => 0,
    };
    if header[..4] != [0x7f, b'E', b'L', b'F']
        || !matches!(header[4], 1 | 2)
        || !matches!(byte_order, 1 | 2)
        || header[6] != 1
        || !matches!(object_type, 2 | 3)
        || machine == 0
    {
        return Err(FoundationError::new(
            PROCESS_EXECUTABLE_FORMAT_UNSUPPORTED,
            "Executable does not have a supported ELF header; scripts and shebangs are unsupported",
        ));
    }
    file.rewind().map_err(rootfs_unavailable)?;
    if hash_reader(&mut file, MAX_ROOTFS_REGULAR_BYTES)?.1 != expected_sha256 {
        return Err(FoundationError::new(
            PROCESS_ROOTFS_IDENTITY_CHANGED,
            "Executable bytes changed after rootfs verification",
        ));
    }
    Ok(())
}

fn validate_relative_path(value: &str, label: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > MAX_PATH_BYTES
        || value.starts_with('/')
        || value.ends_with('/')
        || value.as_bytes().iter().any(|byte| byte.is_ascii_control())
    {
        return Err(rootfs_entry(format!(
            "{label} is not a bounded relative path"
        )));
    }
    let mut depth = 0;
    for component in value.split('/') {
        if component.is_empty()
            || component == "."
            || component == ".."
            || component.len() > MAX_COMPONENT_BYTES
        {
            return Err(rootfs_entry(format!(
                "{label} contains an invalid component"
            )));
        }
        depth += 1;
        if depth > MAX_DIRECTORY_DEPTH {
            return Err(rootfs_entry(format!("{label} exceeds the depth ceiling")));
        }
    }
    Ok(())
}

fn validate_filename(value: &[u8]) -> Result<&str> {
    if value.is_empty()
        || value.len() > MAX_COMPONENT_BYTES
        || value.iter().any(|byte| byte.is_ascii_control())
    {
        return Err(rootfs_entry("rootfs filename is invalid"));
    }
    let name = std::str::from_utf8(value)
        .map_err(|_| rootfs_entry("rootfs filenames must be exact UTF-8"))?;
    if name == "." || name == ".." || name.contains('/') {
        return Err(rootfs_entry("rootfs filename is not canonical"));
    }
    Ok(name)
}

fn validate_host_path(path: &Path, label: &str) -> Result<()> {
    let bytes = path.as_os_str().as_bytes();
    if !path.is_absolute()
        || bytes.len() > MAX_CONFIG_PATH_BYTES
        || bytes.iter().any(|byte| byte.is_ascii_control())
    {
        return Err(protocol(format!(
            "{label} must be a bounded normalized absolute path"
        )));
    }
    for component in path.components() {
        if !matches!(component, Component::RootDir | Component::Normal(_)) {
            return Err(protocol(format!("{label} must be normalized")));
        }
    }
    Ok(())
}

fn is_forbidden_live_root(path: &Path) -> bool {
    ["/", "/usr", "/lib", "/lib64", "/bin", "/home"]
        .iter()
        .any(|value| path == Path::new(value))
        || path.starts_with("/home/")
}

pub fn validate_identifier(value: &str, label: &str) -> Result<()> {
    let bytes = value.as_bytes();
    if bytes.is_empty()
        || bytes.len() > MAX_IDENTIFIER_BYTES
        || !bytes[0].is_ascii_alphanumeric()
        || bytes.iter().any(|byte| {
            !(byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || matches!(byte, b'.' | b'_' | b'-'))
        })
    {
        return Err(protocol(format!(
            "{label} must use the bounded canonical process identifier syntax"
        )));
    }
    Ok(())
}

pub fn validate_sha256(value: &str, label: &str) -> Result<()> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    {
        return Err(protocol(format!("{label} must be a lowercase SHA-256")));
    }
    Ok(())
}

fn physical_identity(fd: RawFd) -> Result<PhysicalIdentity> {
    let mut stat: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstat(fd, &mut stat) } != 0 {
        return Err(rootfs_unavailable(std::io::Error::last_os_error()));
    }
    Ok(PhysicalIdentity {
        device: stat.st_dev,
        inode: stat.st_ino,
        owner_uid: stat.st_uid,
        owner_gid: stat.st_gid,
        mode: stat.st_mode & 0o7777,
    })
}

fn hash_reader(file: &mut File, limit: u64) -> Result<(u64, String)> {
    hash_reader_with_code(
        file,
        limit,
        PROCESS_ROOTFS_ENTRY_INVALID,
        "rootfs regular file",
    )
}

fn hash_reader_with_code(
    file: &mut File,
    limit: u64,
    code: FailureCode,
    label: &str,
) -> Result<(u64, String)> {
    let mut bytes = 0_u64;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 65_536];
    loop {
        let read = file.read(&mut buffer).map_err(rootfs_unavailable)?;
        if read == 0 {
            break;
        }
        bytes = bytes
            .checked_add(read as u64)
            .ok_or_else(|| FoundationError::new(code, format!("{label} byte count overflows")))?;
        if bytes > limit {
            return Err(FoundationError::new(
                code,
                format!("{label} exceeds the hard byte ceiling"),
            ));
        }
        hasher.update(&buffer[..read]);
    }
    Ok((bytes, format!("{:x}", hasher.finalize())))
}

fn read_bounded_file(file: &File, maximum: usize, code: FailureCode) -> Result<Vec<u8>> {
    let mut duplicate = file
        .try_clone()
        .map_err(|error| FoundationError::new(code, error.to_string()))?;
    duplicate
        .rewind()
        .map_err(|error| FoundationError::new(code, error.to_string()))?;
    let mut output = Vec::new();
    duplicate
        .take((maximum + 1) as u64)
        .read_to_end(&mut output)
        .map_err(|error| FoundationError::new(code, error.to_string()))?;
    if output.len() > maximum {
        return Err(FoundationError::new(
            code,
            "trusted file exceeds its byte ceiling",
        ));
    }
    Ok(output)
}

fn hash_current_binary() -> Result<String> {
    let name = CString::new("/proc/self/exe").expect("static path contains no NUL");
    let descriptor = unsafe { libc::open(name.as_ptr(), libc::O_RDONLY | libc::O_CLOEXEC) };
    if descriptor < 0 {
        return Err(unavailable(std::io::Error::last_os_error()));
    }
    let mut file = unsafe { File::from_raw_fd(descriptor) };
    if !file.metadata().map_err(unavailable)?.is_file() {
        return Err(FoundationError::new(
            PROCESS_LAUNCHER_FOUNDATION_UNAVAILABLE,
            "running launcher binary is not a regular file",
        ));
    }
    Ok(hash_reader_with_code(
        &mut file,
        MAX_LAUNCHER_BINARY_BYTES,
        PROCESS_LAUNCHER_FOUNDATION_UNAVAILABLE,
        "running launcher binary",
    )?
    .1)
}

pub(crate) fn canonical_json<T: Serialize>(value: &T) -> Result<Vec<u8>> {
    serde_json::to_vec(value).map_err(protocol_json)
}

pub(crate) fn canonical_json_bytes<T: Serialize>(value: &T) -> Result<Vec<u8>> {
    let value = serde_json::to_value(value).map_err(protocol_json)?;
    Ok(canonical_json_value_bytes(&value))
}

pub(crate) fn canonical_json_value_bytes(value: &Value) -> Vec<u8> {
    fn write(value: &Value, output: &mut Vec<u8>) {
        match value {
            Value::Null => output.extend_from_slice(b"null"),
            Value::Bool(value) => output.extend_from_slice(value.to_string().as_bytes()),
            Value::Number(value) => output.extend_from_slice(value.to_string().as_bytes()),
            Value::String(value) => {
                output.extend_from_slice(
                    serde_json::to_string(value)
                        .expect("serializing canonical string")
                        .as_bytes(),
                );
            }
            Value::Array(values) => {
                output.push(b'[');
                for (index, value) in values.iter().enumerate() {
                    if index > 0 {
                        output.push(b',');
                    }
                    write(value, output);
                }
                output.push(b']');
            }
            Value::Object(values) => {
                output.push(b'{');
                let mut values: Vec<_> = values.iter().collect();
                values.sort_by(|left, right| left.0.as_bytes().cmp(right.0.as_bytes()));
                for (index, (key, value)) in values.into_iter().enumerate() {
                    if index > 0 {
                        output.push(b',');
                    }
                    output.extend_from_slice(
                        serde_json::to_string(key)
                            .expect("serializing canonical key")
                            .as_bytes(),
                    );
                    output.push(b':');
                    write(value, output);
                }
                output.push(b'}');
            }
        }
    }
    let mut output = Vec::new();
    write(value, &mut output);
    output
}

pub(crate) fn sha256_json<T: Serialize>(value: &T) -> Result<String> {
    Ok(sha256_bytes(&canonical_json_bytes(value)?))
}

pub(crate) fn sha256_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn read_frame(stream: &mut UnixStream) -> Result<Vec<u8>> {
    let mut header = [0_u8; 4];
    stream.read_exact(&mut header).map_err(protocol_io)?;
    let length = u32::from_be_bytes(header) as usize;
    if length == 0 || length > MAX_MESSAGE_BYTES {
        return Err(protocol("launcher request frame size is invalid"));
    }
    let mut bytes = vec![0_u8; length];
    stream.read_exact(&mut bytes).map_err(protocol_io)?;
    Ok(bytes)
}

fn write_response<T: Serialize>(stream: &mut UnixStream, response: &T) -> Result<()> {
    let bytes = canonical_json(response)?;
    if bytes.is_empty() || bytes.len() > MAX_MESSAGE_BYTES {
        return Err(protocol("launcher response exceeds the message ceiling"));
    }
    stream
        .write_all(&(bytes.len() as u32).to_be_bytes())
        .and_then(|_| stream.write_all(&bytes))
        .and_then(|_| stream.flush())
        .map_err(protocol_io)
}

fn peer_uid(stream: &UnixStream) -> Result<u32> {
    let mut credentials: libc::ucred = unsafe { std::mem::zeroed() };
    let mut length = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    if unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            &mut credentials as *mut _ as *mut libc::c_void,
            &mut length,
        )
    } != 0
        || length as usize != std::mem::size_of::<libc::ucred>()
    {
        return Err(FoundationError::new(
            PROCESS_LAUNCHER_CLIENT_UNAUTHORIZED,
            "SO_PEERCRED validation failed",
        ));
    }
    Ok(credentials.uid)
}

fn uname_release() -> Result<String> {
    let mut value: libc::utsname = unsafe { std::mem::zeroed() };
    if unsafe { libc::uname(&mut value) } != 0 {
        return Err(prerequisite(std::io::Error::last_os_error()));
    }
    let bytes = unsafe { CStr::from_ptr(value.release.as_ptr()) }.to_bytes();
    String::from_utf8(bytes.to_vec())
        .map_err(|_| prerequisite_message("kernel release is not UTF-8"))
}

fn unix_time() -> Result<i64> {
    let value = unsafe { libc::time(std::ptr::null_mut()) };
    if value < 0 {
        return Err(prerequisite_message("system UTC clock is unavailable"));
    }
    Ok(value)
}

pub(crate) fn canonical_utc(seconds: i64) -> Result<String> {
    let mut broken_down: libc::tm = unsafe { std::mem::zeroed() };
    if unsafe { libc::gmtime_r(&seconds, &mut broken_down) }.is_null() {
        return Err(prerequisite_message("system UTC clock cannot be converted"));
    }
    Ok(format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.000Z",
        broken_down.tm_year + 1900,
        broken_down.tm_mon + 1,
        broken_down.tm_mday,
        broken_down.tm_hour,
        broken_down.tm_min,
        broken_down.tm_sec
    ))
}

fn protocol(message: impl Into<String>) -> FoundationError {
    FoundationError::new(PROCESS_LAUNCHER_PROTOCOL_INVALID, message)
}

fn operation_lock<T>(_: std::sync::PoisonError<T>) -> FoundationError {
    FoundationError::new(
        PROCESS_CONTAINMENT_UNAVAILABLE,
        "launcher operation registry lock is poisoned",
    )
}

fn validate_operation_identity_text(value: &str) -> Result<()> {
    let hash = value.strip_prefix("process-operation:").ok_or_else(|| {
        FoundationError::new(
            PROCESS_LAUNCH_PLAN_INVALID,
            "operationIdentity must use the process-operation prefix",
        )
    })?;
    validate_sha256(hash, "operationIdentity hash")
}

fn make_launcher_tree_writable(path: &Path) -> Result<()> {
    if path.is_dir() {
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(unavailable)?;
        for entry in fs::read_dir(path).map_err(unavailable)? {
            let entry = entry.map_err(unavailable)?;
            if entry.path().is_dir() {
                make_launcher_tree_writable(&entry.path())?;
            } else {
                fs::set_permissions(entry.path(), fs::Permissions::from_mode(0o600))
                    .map_err(unavailable)?;
            }
        }
    }
    Ok(())
}

fn validate_inspection_probe(artifacts: &executor::ExecutionArtifacts) -> Result<()> {
    if artifacts.seccomp_mode != 2
        || !artifacts.namespaces.mount_isolated
        || !artifacts.namespaces.pid_isolated
        || !artifacts.namespaces.network_isolated
        || !artifacts.namespaces.ipc_isolated
        || !artifacts.namespaces.uts_isolated
        || !artifacts.namespaces.cgroup_isolated
    {
        return Err(FoundationError::new(
            PROCESS_CONTAINMENT_UNAVAILABLE,
            "active inspection probe did not retain host-observed namespace/seccomp evidence",
        ));
    }
    let output: Value = serde_json::from_slice(&artifacts.trusted_stdout).map_err(|error| {
        FoundationError::new(
            PROCESS_CONTAINMENT_UNAVAILABLE,
            format!("active inspection probe output is invalid: {error}"),
        )
    })?;
    let required = [
        "rootfsReadOnly",
        "workspaceReadOnly",
        "hostPathsAbsent",
        "procPrivate",
        "networkDenied",
        "unixDenied",
        "netlinkDenied",
        "dnsDenied",
        "seccompDenied",
        "environmentClean",
        "stdinDisabled",
        "fileDescriptorsClean",
    ];
    if required
        .iter()
        .any(|field| output.get(*field) != Some(&Value::Bool(true)))
    {
        return Err(FoundationError::new(
            PROCESS_CONTAINMENT_UNAVAILABLE,
            "active inspection probe reported an unenforced containment boundary",
        ));
    }
    Ok(())
}

fn protocol_io(error: std::io::Error) -> FoundationError {
    FoundationError::new(PROCESS_LAUNCHER_PROTOCOL_INVALID, error.to_string())
}

fn protocol_json(error: serde_json::Error) -> FoundationError {
    FoundationError::new(PROCESS_LAUNCHER_PROTOCOL_INVALID, error.to_string())
}

fn unavailable(error: std::io::Error) -> FoundationError {
    FoundationError::new(PROCESS_LAUNCHER_FOUNDATION_UNAVAILABLE, error.to_string())
}

fn rootfs_unavailable(error: std::io::Error) -> FoundationError {
    FoundationError::new(PROCESS_ROOTFS_UNAVAILABLE, error.to_string())
}

fn rootfs_entry(message: impl Into<String>) -> FoundationError {
    FoundationError::new(PROCESS_ROOTFS_ENTRY_INVALID, message)
}

fn prerequisite(error: std::io::Error) -> FoundationError {
    FoundationError::new(PROCESS_SANDBOX_PREREQUISITES_UNAVAILABLE, error.to_string())
}

fn prerequisite_message(message: impl Into<String>) -> FoundationError {
    FoundationError::new(PROCESS_SANDBOX_PREREQUISITES_UNAVAILABLE, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn sha() -> String {
        "a".repeat(64)
    }

    fn temporary_root(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "ticket-launcher-{label}-{}-{}",
            std::process::id(),
            unix_time().unwrap()
        ));
        let mut candidate = path;
        let mut suffix = 0_u32;
        while candidate.exists() {
            suffix += 1;
            candidate.set_extension(suffix.to_string());
        }
        fs::create_dir(&candidate).unwrap();
        candidate
    }

    fn make_writable(root: &Path) {
        let Ok(metadata) = fs::symlink_metadata(root) else {
            return;
        };
        if metadata.is_dir() && !metadata.file_type().is_symlink() {
            fs::set_permissions(root, fs::Permissions::from_mode(0o700)).unwrap();
            for entry in fs::read_dir(root).unwrap() {
                make_writable(&entry.unwrap().path());
            }
        } else if metadata.is_file() {
            fs::set_permissions(root, fs::Permissions::from_mode(0o600)).unwrap();
        }
    }

    fn create_elf_tree(label: &str) -> (PathBuf, String, u64) {
        let root = temporary_root(label);
        let bin = root.join("usr/bin");
        fs::create_dir_all(&bin).unwrap();
        let mut bytes = vec![0_u8; 64];
        bytes[..7].copy_from_slice(b"\x7fELF\x02\x01\x01");
        bytes[16..18].copy_from_slice(&2_u16.to_le_bytes());
        bytes[18..20].copy_from_slice(&62_u16.to_le_bytes());
        fs::write(bin.join("node"), &bytes).unwrap();
        fs::set_permissions(root.join("usr"), fs::Permissions::from_mode(0o555)).unwrap();
        fs::set_permissions(&bin, fs::Permissions::from_mode(0o555)).unwrap();
        fs::set_permissions(bin.join("node"), fs::Permissions::from_mode(0o555)).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o555)).unwrap();
        let size = bytes.len() as u64;
        (root, sha256_bytes(&bytes), size)
    }

    fn configuration() -> ServiceConfig {
        let launcher_uid = unsafe { libc::geteuid() };
        ServiceConfig {
            version: 1,
            socket_path: "/run/ticket-system-process/launcher/launcher.sock".into(),
            state_root: "/var/lib/ticket-system/process-launcher".into(),
            allowed_client_uid: launcher_uid + 1,
            launcher_service_uid: launcher_uid,
            materializer_service_uid: launcher_uid + 2,
            runtime_client_gid: unsafe { libc::getegid() }.saturating_add(1),
            handoff_gid: unsafe { libc::getegid() },
            trusted_rootfs_owner_uid: launcher_uid + 3,
            materializer_socket_path: "/run/ticket-system-process/materializer/materializer.sock"
                .into(),
            health_validity_ms: 30_000,
            rootfs_registry: vec![RootfsConfiguration {
                id: "node-24-fedora-runtime-v1".into(),
                root_path: "/var/lib/ticket-system/runtime-rootfs/node-24-fedora-runtime-v1/root"
                    .into(),
                manifest_path:
                    "/var/lib/ticket-system/runtime-rootfs/node-24-fedora-runtime-v1/manifest.json"
                        .into(),
                manifest_sha256: sha(),
            }],
            sandbox_backend: SandboxBackendConfiguration {
                kind: "bubblewrap".into(),
                binary_path: "/usr/bin/bwrap".into(),
                binary_sha256: sha(),
            },
            seccomp_policy_path: "/etc/ticket-system/process-seccomp-v1.json".into(),
            seccomp_policy_sha256: sha(),
            containment_probe: ContainmentProbeConfiguration {
                rootfs_id: "node-24-fedora-runtime-v1".into(),
                executable_path: "/usr/bin/node".into(),
                executable_sha256: sha(),
                format: "elf".into(),
            },
            protected_host_paths: ProtectedHostPaths {
                runtime_data: vec!["/var/lib/ticket-system/runtime".into()],
                materializer_state: vec!["/var/lib/ticket-system/process-inputs".into()],
                workspaces: vec!["/srv/ticket-system/workspace".into()],
            },
        }
    }

    #[test]
    fn manifest_rejects_absolute_symlink_targets_and_writable_entries() {
        let absolute = RootfsManifest {
            version: 1,
            entries: vec![RootfsManifestEntry::SymbolicLink {
                path: "lib".into(),
                target: "/usr/lib".into(),
            }],
        };
        assert_eq!(
            validate_rootfs_manifest(&absolute).unwrap_err().code,
            PROCESS_ROOTFS_ENTRY_INVALID
        );
        let writable = RootfsManifest {
            version: 1,
            entries: vec![RootfsManifestEntry::RegularFile {
                path: "node".into(),
                size: 1,
                sha256: sha(),
                mode: "0755".into(),
            }],
        };
        assert_eq!(
            validate_rootfs_manifest(&writable).unwrap_err().code,
            PROCESS_ROOTFS_ENTRY_INVALID
        );
    }

    #[test]
    fn canonical_manifest_requires_explicit_ordered_directories() {
        let valid = RootfsManifest {
            version: 1,
            entries: vec![
                RootfsManifestEntry::Directory {
                    path: "usr".into(),
                    mode: "0555".into(),
                },
                RootfsManifestEntry::Directory {
                    path: "usr/bin".into(),
                    mode: "0555".into(),
                },
                RootfsManifestEntry::RegularFile {
                    path: "usr/bin/node".into(),
                    size: 4,
                    sha256: sha(),
                    mode: "0555".into(),
                },
            ],
        };
        validate_rootfs_manifest(&valid).unwrap();
        let mut unordered = valid.clone();
        unordered.entries.swap(0, 1);
        assert!(validate_rootfs_manifest(&unordered).is_err());
    }

    #[test]
    fn identifier_and_executable_paths_are_closed() {
        validate_identifier("node-24.runtime_v1", "id").unwrap();
        assert!(validate_identifier("Node", "id").is_err());
        assert_eq!(
            validate_executable_path("/usr/bin/node").unwrap(),
            "usr/bin/node"
        );
        assert!(validate_executable_path("/usr/../etc/passwd").is_err());
        assert!(validate_executable_path("usr/bin/node").is_err());
    }

    #[test]
    fn host_live_roots_are_forbidden() {
        for value in ["/", "/usr", "/lib", "/lib64", "/bin", "/home/operator"] {
            assert!(is_forbidden_live_root(Path::new(value)));
        }
        assert!(!is_forbidden_live_root(Path::new(
            "/var/lib/ticket-system/runtime-rootfs/node-v1/root"
        )));
    }

    #[test]
    fn configuration_rejects_duplicate_ids_and_canonicalizes_authority_order() {
        let mut duplicate = configuration();
        duplicate
            .rootfs_registry
            .push(duplicate.rootfs_registry[0].clone());
        assert_eq!(
            duplicate.validate().unwrap_err().code,
            PROCESS_ROOTFS_REGISTRY_INVALID
        );
        let mut ordered = configuration();
        ordered.rootfs_registry.push(RootfsConfiguration {
            id: "a-runtime".into(),
            root_path: "/var/lib/ticket-system/runtime-rootfs/a-runtime/root".into(),
            manifest_path: "/var/lib/ticket-system/runtime-rootfs/a-runtime/manifest.json".into(),
            manifest_sha256: sha(),
        });
        ordered.protected_host_paths.runtime_data = vec![
            "/var/lib/ticket-system/runtime-z".into(),
            "/var/lib/ticket-system/runtime-a".into(),
        ];
        ordered.canonicalize().unwrap();
        assert_eq!(ordered.rootfs_registry[0].id, "a-runtime");
        assert_eq!(
            ordered.protected_host_paths.runtime_data,
            [
                "/var/lib/ticket-system/runtime-a",
                "/var/lib/ticket-system/runtime-z"
            ]
        );
    }

    #[test]
    fn rootfs_registry_cardinality_boundary_is_exact() {
        let mut exact = configuration();
        exact.rootfs_registry.clear();
        for index in 0..MAX_ROOTFS_REGISTRY_ENTRIES {
            exact.rootfs_registry.push(RootfsConfiguration {
                id: format!("runtime-{index:02}"),
                root_path: format!("/var/lib/ticket-system/runtime-rootfs/runtime-{index:02}/root"),
                manifest_path: format!(
                    "/var/lib/ticket-system/runtime-rootfs/runtime-{index:02}/manifest.json"
                ),
                manifest_sha256: sha(),
            });
        }
        exact.containment_probe.rootfs_id = "runtime-00".into();
        exact.validate().unwrap();
        exact.rootfs_registry.push(RootfsConfiguration {
            id: "runtime-over".into(),
            root_path: "/var/lib/ticket-system/runtime-rootfs/runtime-over/root".into(),
            manifest_path: "/var/lib/ticket-system/runtime-rootfs/runtime-over/manifest.json"
                .into(),
            manifest_sha256: sha(),
        });
        assert_eq!(
            exact.validate().unwrap_err().code,
            PROCESS_ROOTFS_REGISTRY_INVALID
        );
    }

    #[test]
    fn runtime_or_launcher_owned_rootfs_authority_is_rejected() {
        let mut value = configuration();
        value.trusted_rootfs_owner_uid = value.launcher_service_uid;
        assert_eq!(
            value.validate().unwrap_err().code,
            PROCESS_ROOTFS_REGISTRY_INVALID
        );
        let mut value = configuration();
        value.trusted_rootfs_owner_uid = value.allowed_client_uid;
        assert_eq!(
            value.validate().unwrap_err().code,
            PROCESS_ROOTFS_REGISTRY_INVALID
        );
    }

    #[test]
    fn protocol_exposes_only_bounded_execution_lifecycle() {
        for operation in ["execute", "spawn", "cancel", "signal", "output", "attach"] {
            let value = serde_json::json!({
                "version": 1,
                "requestId": "request-1",
                "operation": operation,
                "body": {}
            });
            assert!(serde_json::from_value::<RequestEnvelope>(value).is_err());
        }
        for operation in ["launch", "getOperation", "cancelOperation"] {
            let value = serde_json::json!({
                "version": 1,
                "requestId": "request-1",
                "operation": operation,
                "body": {}
            });
            assert!(serde_json::from_value::<RequestEnvelope>(value).is_ok());
        }
    }

    #[test]
    fn complete_descriptor_relative_rootfs_scan_and_elf_identity_are_exact() {
        let (root, hash, size) = create_elf_tree("complete-scan");
        let pinned = PinnedDirectory::open_absolute(&root, PROCESS_ROOTFS_UNAVAILABLE).unwrap();
        let manifest = scan_rootfs(&pinned, unsafe { libc::geteuid() }).unwrap();
        assert_eq!(manifest.entries.len(), 3);
        assert_eq!(
            manifest.entries.last().unwrap(),
            &RootfsManifestEntry::RegularFile {
                path: "usr/bin/node".into(),
                size,
                sha256: hash.clone(),
                mode: "0555".into()
            }
        );
        verify_elf_identity(&pinned, "usr/bin/node", size, &hash).unwrap();
        assert_eq!(
            verify_elf_identity(&pinned, "usr/bin/node", size, &sha())
                .unwrap_err()
                .code,
            PROCESS_ROOTFS_IDENTITY_CHANGED
        );
        make_writable(&root);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn configured_path_replacement_cannot_redirect_pinned_rootfs() {
        let (root, _, _) = create_elf_tree("pinned-root");
        let pinned = PinnedDirectory::open_absolute(&root, PROCESS_ROOTFS_UNAVAILABLE).unwrap();
        let original = scan_rootfs(&pinned, unsafe { libc::geteuid() }).unwrap();
        let retained = root.with_extension("retained");
        fs::rename(&root, &retained).unwrap();
        fs::create_dir(&root).unwrap();
        fs::write(root.join("redirected"), b"redirected").unwrap();
        fs::set_permissions(root.join("redirected"), fs::Permissions::from_mode(0o444)).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o555)).unwrap();
        assert_eq!(
            scan_rootfs(&pinned, unsafe { libc::geteuid() }).unwrap(),
            original
        );
        assert_ne!(
            PinnedDirectory::open_absolute(&root, PROCESS_ROOTFS_UNAVAILABLE)
                .unwrap()
                .identity,
            pinned.identity
        );
        make_writable(&root);
        make_writable(&retained);
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(retained).unwrap();
    }

    #[test]
    fn symlinked_trusted_path_and_duplicate_physical_root_are_rejected() {
        let root = temporary_root("symlink-path");
        let actual = root.join("actual");
        fs::create_dir(&actual).unwrap();
        let alias = root.join("alias");
        std::os::unix::fs::symlink(&actual, &alias).unwrap();
        assert_eq!(
            PinnedDirectory::open_absolute(&alias, PROCESS_ROOTFS_UNAVAILABLE)
                .unwrap_err()
                .code,
            PROCESS_ROOTFS_UNAVAILABLE
        );
        let first = PinnedDirectory::open_absolute(&actual, PROCESS_ROOTFS_UNAVAILABLE).unwrap();
        let second = PinnedDirectory::open_absolute(&actual, PROCESS_ROOTFS_UNAVAILABLE).unwrap();
        assert!(directories_overlap(&first, &second).unwrap());
        make_writable(&root);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn pinned_backend_path_replacement_cannot_redirect_live_identity() {
        let root = temporary_root("backend-pinning");
        let backend = root.join("bwrap");
        fs::write(&backend, b"\x7fELForiginal").unwrap();
        let pinned = PinnedFile::open_absolute(
            &backend,
            PROCESS_SANDBOX_BACKEND_INVALID,
            MAX_LAUNCHER_BINARY_BYTES,
        )
        .unwrap();
        let original_identity = pinned.identity;
        let retained = root.join("bwrap-retained");
        fs::rename(&backend, retained).unwrap();
        fs::write(&backend, b"\x7fELFreplacement").unwrap();
        pinned
            .revalidate(PROCESS_SANDBOX_BACKEND_INVALID, "Bubblewrap binary")
            .unwrap();
        let replacement = PinnedFile::open_absolute(
            &backend,
            PROCESS_SANDBOX_BACKEND_INVALID,
            MAX_LAUNCHER_BINARY_BYTES,
        )
        .unwrap();
        assert_ne!(replacement.identity, original_identity);
        assert_ne!(replacement.sha256, pinned.sha256);
        make_writable(&root);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn launcher_lifetime_lock_is_kernel_owned_and_restartable() {
        let root = temporary_root("lifetime-lock");
        fs::set_permissions(&root, fs::Permissions::from_mode(0o750)).unwrap();
        let pinned =
            PinnedDirectory::open_absolute(&root, PROCESS_LAUNCHER_FOUNDATION_UNAVAILABLE).unwrap();
        let first = acquire_instance_lock(&pinned).unwrap();
        assert_eq!(
            acquire_instance_lock(&pinned).unwrap_err().code,
            PROCESS_LAUNCHER_ALREADY_RUNNING
        );
        drop(first);
        let restarted = acquire_instance_lock(&pinned).unwrap();
        assert!(root.join(INSTANCE_LOCK_NAME).exists());
        drop(restarted);
        make_writable(&root);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn complete_tree_changes_and_special_files_fail_closed() {
        let (root, _, _) = create_elf_tree("tree-change");
        let pinned = PinnedDirectory::open_absolute(&root, PROCESS_ROOTFS_UNAVAILABLE).unwrap();
        let original = scan_rootfs(&pinned, unsafe { libc::geteuid() }).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o755)).unwrap();
        fs::write(root.join("additional"), b"x").unwrap();
        fs::set_permissions(root.join("additional"), fs::Permissions::from_mode(0o444)).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o555)).unwrap();
        assert_ne!(
            scan_rootfs(&pinned, unsafe { libc::geteuid() }).unwrap(),
            original
        );
        fs::set_permissions(&root, fs::Permissions::from_mode(0o755)).unwrap();
        fs::remove_file(root.join("additional")).unwrap();
        let fifo = CString::new(root.join("fifo").as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o444) }, 0);
        fs::set_permissions(&root, fs::Permissions::from_mode(0o555)).unwrap();
        assert_eq!(
            scan_rootfs(&pinned, unsafe { libc::geteuid() })
                .unwrap_err()
                .code,
            PROCESS_ROOTFS_ENTRY_INVALID
        );
        make_writable(&root);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn script_identity_is_not_elf() {
        let root = temporary_root("script");
        fs::write(root.join("tool"), b"#!/bin/sh\n").unwrap();
        fs::set_permissions(root.join("tool"), fs::Permissions::from_mode(0o555)).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o555)).unwrap();
        let pinned = PinnedDirectory::open_absolute(&root, PROCESS_ROOTFS_UNAVAILABLE).unwrap();
        let hash = sha256_bytes(b"#!/bin/sh\n");
        assert_eq!(
            verify_elf_identity(&pinned, "tool", 10, &hash)
                .unwrap_err()
                .code,
            PROCESS_EXECUTABLE_FORMAT_UNSUPPORTED
        );
        make_writable(&root);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn executable_manifest_entry_requires_execute_permission() {
        validate_executable_mode(0o555).unwrap();
        assert_eq!(
            validate_executable_mode(0o444).unwrap_err().code,
            PROCESS_EXECUTABLE_IDENTITY_MISMATCH
        );
    }

    #[test]
    fn manifest_entry_and_byte_hard_boundaries_are_exact() {
        let mut entries = Vec::with_capacity(MAX_ROOTFS_ENTRIES);
        entries.push(RootfsManifestEntry::Directory {
            path: "files".into(),
            mode: "0555".into(),
        });
        for index in 0..(MAX_ROOTFS_ENTRIES - 1) {
            entries.push(RootfsManifestEntry::RegularFile {
                path: format!("files/{index:06}"),
                size: 0,
                sha256: sha(),
                mode: "0444".into(),
            });
        }
        let exact = RootfsManifest {
            version: 1,
            entries,
        };
        validate_rootfs_manifest(&exact).unwrap();
        let mut over = exact.clone();
        over.entries.push(RootfsManifestEntry::RegularFile {
            path: "files/zzzzzz".into(),
            size: 0,
            sha256: sha(),
            mode: "0444".into(),
        });
        assert_eq!(
            validate_rootfs_manifest(&over).unwrap_err().code,
            PROCESS_ROOTFS_MANIFEST_INVALID
        );
        let exact_bytes = RootfsManifest {
            version: 1,
            entries: vec![RootfsManifestEntry::RegularFile {
                path: "blob".into(),
                size: MAX_ROOTFS_REGULAR_BYTES,
                sha256: sha(),
                mode: "0444".into(),
            }],
        };
        validate_rootfs_manifest(&exact_bytes).unwrap();
        let too_many_bytes = RootfsManifest {
            version: 1,
            entries: vec![RootfsManifestEntry::RegularFile {
                path: "blob".into(),
                size: MAX_ROOTFS_REGULAR_BYTES + 1,
                sha256: sha(),
                mode: "0444".into(),
            }],
        };
        assert_eq!(
            validate_rootfs_manifest(&too_many_bytes).unwrap_err().code,
            PROCESS_ROOTFS_MANIFEST_INVALID
        );
    }

    #[test]
    fn manifest_json_byte_boundary_is_enforced_before_unbounded_read() {
        let root = temporary_root("manifest-bytes");
        let file_path = root.join("manifest");
        fs::write(&file_path, vec![b'x'; MAX_ROOTFS_MANIFEST_BYTES]).unwrap();
        let file = File::open(&file_path).unwrap();
        assert_eq!(
            read_bounded_file(
                &file,
                MAX_ROOTFS_MANIFEST_BYTES,
                PROCESS_ROOTFS_MANIFEST_INVALID
            )
            .unwrap()
            .len(),
            MAX_ROOTFS_MANIFEST_BYTES
        );
        fs::write(&file_path, vec![b'x'; MAX_ROOTFS_MANIFEST_BYTES + 1]).unwrap();
        let file = File::open(&file_path).unwrap();
        assert_eq!(
            read_bounded_file(
                &file,
                MAX_ROOTFS_MANIFEST_BYTES,
                PROCESS_ROOTFS_MANIFEST_INVALID
            )
            .unwrap_err()
            .code,
            PROCESS_ROOTFS_MANIFEST_INVALID
        );
        fs::remove_dir_all(root).unwrap();
    }
}
