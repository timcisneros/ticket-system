use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use crate::{
    FoundationError, PROCESS_CONTAINMENT_GENERATION_MISMATCH, PROCESS_ENVIRONMENT_INVALID,
    PROCESS_LAUNCH_PLAN_INVALID, Result, canonical_json_bytes, sha256_bytes, validate_identifier,
    validate_sha256,
};

pub(crate) const LAUNCH_PLAN_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LaunchBody {
    pub launch_plan: LaunchPlan,
    pub containment_generation_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct OperationBody {
    pub operation_identity: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LaunchPlan {
    pub version: u32,
    pub operation_id: String,
    pub operation_identity: String,
    pub run_id: u64,
    pub ticket_id: u64,
    pub target_id: String,
    pub profile_id: String,
    pub policy_snapshot_hash: String,
    pub runtime_phase: String,
    pub sandbox_capability: SandboxCapabilityProjection,
    pub runtime_rootfs: RuntimeRootfs,
    pub executable_identity: ExecutableIdentity,
    pub arguments: Vec<String>,
    pub working_directory: String,
    pub environment: BTreeMap<String, String>,
    pub workspace_snapshot: WorkspaceSnapshot,
    pub filesystem_policy: FilesystemPolicy,
    pub limits: ProcessLimits,
    pub execution_policy: ExecutionPolicy,
    pub launch_plan_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SandboxCapabilityProjection {
    pub generation_id: String,
    pub launcher_protocol_version: u32,
    pub launcher_identity_hash: String,
    pub sandbox_backend_identity_hash: String,
    pub seccomp_policy_hash: String,
    pub rootfs_registry_generation: String,
    pub materializer_generation: String,
    pub delegated_cgroup_identity_hash: String,
    pub containment_probe_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RuntimeRootfs {
    pub id: String,
    pub manifest_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ExecutableIdentity {
    pub path: String,
    pub sha256: String,
    pub format: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WorkspaceSnapshot {
    pub id: String,
    pub run_id: u64,
    pub policy_snapshot_hash: String,
    pub materializer_generation: String,
    pub manifest_sha256: String,
    pub file_count: u64,
    pub total_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FilesystemPolicy {
    pub input_mode: String,
    pub writable_roots: Vec<String>,
    pub allow_symlinks: bool,
    pub allow_special_files: bool,
    pub max_input_files: u64,
    pub max_input_bytes: u64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProcessLimits {
    pub wall_time_ms: u64,
    pub max_output_bytes: u64,
    pub max_processes: u64,
    pub memory_bytes: u64,
    pub cpu_quota_micros_per_100ms: u64,
    pub max_open_files: u64,
    pub max_file_bytes: u64,
    pub max_temp_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ExecutionPolicy {
    pub shell: bool,
    pub stdin: String,
    pub detached: bool,
    pub network_access: String,
    pub environment_mode: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContainmentCapability {
    pub version: u32,
    pub status: String,
    pub generation_id: String,
    pub launcher_protocol_version: u32,
    pub launcher_identity_hash: String,
    pub sandbox_backend_identity_hash: String,
    pub seccomp_policy_hash: String,
    pub rootfs_registry_generation: String,
    pub materializer_generation: String,
    pub delegated_cgroup_identity_hash: String,
    pub containment_probe_hash: String,
    pub verified_at: String,
    pub expires_at: String,
    pub ready_for_execution: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ExecutionResult {
    pub operation_identity: String,
    pub terminal_outcome: String,
    pub started_at: String,
    pub ended_at: String,
    pub duration_ms: u64,
    pub exit_code: Option<i32>,
    pub signal: Option<i32>,
    pub stdout_bytes: u64,
    pub stderr_bytes: u64,
    pub combined_output_bytes: u64,
    pub stdout_sha256: String,
    pub stderr_sha256: String,
    pub resource_cause: Option<String>,
    pub enforcement_cause: Option<String>,
    pub cpu_throttled_events: u64,
    pub launcher_environment: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct OperationStatus {
    pub operation_identity: String,
    pub state: String,
    pub result: Option<ExecutionResult>,
}

impl LaunchPlan {
    pub(crate) fn validate(&self, capability: &ContainmentCapability) -> Result<()> {
        if self.version != LAUNCH_PLAN_VERSION {
            return Err(invalid("launch plan version must be 1"));
        }
        validate_identifier(&self.operation_id, "operationId")?;
        validate_operation_identity(&self.operation_identity)?;
        if self.operation_identity != build_operation_identity(self.run_id, &self.operation_id)? {
            return Err(invalid(
                "operationIdentity does not match runId and operationId",
            ));
        }
        positive_id(self.run_id, "runId")?;
        positive_id(self.ticket_id, "ticketId")?;
        validate_identifier(&self.target_id, "targetId")?;
        validate_identifier(&self.profile_id, "profileId")?;
        validate_sha256(&self.policy_snapshot_hash, "policySnapshotHash")?;
        if !matches!(
            self.runtime_phase.as_str(),
            "inspection" | "mutation" | "verification"
        ) {
            return Err(invalid("runtimePhase is unsupported"));
        }
        self.validate_capability(capability)?;
        validate_identifier(&self.runtime_rootfs.id, "runtimeRootfs.id")?;
        validate_sha256(
            &self.runtime_rootfs.manifest_sha256,
            "runtimeRootfs.manifestSha256",
        )?;
        validate_executable(&self.executable_identity)?;
        validate_arguments(&self.arguments)?;
        validate_working_directory(&self.working_directory)?;
        validate_environment(&self.environment)?;
        validate_identifier(&self.workspace_snapshot.id, "workspaceSnapshot.id")?;
        positive_id(self.workspace_snapshot.run_id, "workspaceSnapshot.runId")?;
        validate_sha256(
            &self.workspace_snapshot.policy_snapshot_hash,
            "workspaceSnapshot.policySnapshotHash",
        )?;
        validate_identifier(
            &self.workspace_snapshot.materializer_generation,
            "workspaceSnapshot.materializerGeneration",
        )?;
        validate_sha256(
            &self.workspace_snapshot.manifest_sha256,
            "workspaceSnapshot.manifestSha256",
        )?;
        if self.workspace_snapshot.run_id != self.run_id
            || self.workspace_snapshot.policy_snapshot_hash != self.policy_snapshot_hash
            || self.workspace_snapshot.materializer_generation != capability.materializer_generation
        {
            return Err(invalid(
                "workspace snapshot does not match run, policy, or materializer authority",
            ));
        }
        validate_filesystem_policy(&self.filesystem_policy)?;
        if self.workspace_snapshot.file_count > self.filesystem_policy.max_input_files
            || self.workspace_snapshot.total_bytes > self.filesystem_policy.max_input_bytes
        {
            return Err(invalid(
                "workspace snapshot exceeds the immutable filesystem policy",
            ));
        }
        validate_limits(self.limits)?;
        if self.execution_policy
            != (ExecutionPolicy {
                shell: false,
                stdin: "disabled".into(),
                detached: false,
                network_access: "none".into(),
                environment_mode: "replace".into(),
            })
        {
            return Err(invalid(
                "executionPolicy is not the frozen version-3 policy",
            ));
        }
        validate_sha256(&self.launch_plan_hash, "launchPlanHash")?;
        let mut value = serde_json::to_value(self).map_err(json)?;
        value
            .as_object_mut()
            .expect("serialized launch plan is an object")
            .remove("launchPlanHash");
        if sha256_bytes(&crate::canonical_json_value_bytes(&value)) != self.launch_plan_hash {
            return Err(invalid("launchPlanHash does not match the canonical plan"));
        }
        Ok(())
    }

    fn validate_capability(&self, capability: &ContainmentCapability) -> Result<()> {
        let expected = SandboxCapabilityProjection {
            generation_id: capability.generation_id.clone(),
            launcher_protocol_version: capability.launcher_protocol_version,
            launcher_identity_hash: capability.launcher_identity_hash.clone(),
            sandbox_backend_identity_hash: capability.sandbox_backend_identity_hash.clone(),
            seccomp_policy_hash: capability.seccomp_policy_hash.clone(),
            rootfs_registry_generation: capability.rootfs_registry_generation.clone(),
            materializer_generation: capability.materializer_generation.clone(),
            delegated_cgroup_identity_hash: capability.delegated_cgroup_identity_hash.clone(),
            containment_probe_hash: capability.containment_probe_hash.clone(),
        };
        if self.sandbox_capability != expected {
            return Err(FoundationError::new(
                PROCESS_CONTAINMENT_GENERATION_MISMATCH,
                "launch plan does not bind the exact active containment generation",
            ));
        }
        Ok(())
    }

    pub(crate) fn filesystem_policy_hash(&self) -> Result<String> {
        Ok(sha256_bytes(&canonical_json_bytes(
            &self.filesystem_policy,
        )?))
    }
}

pub(crate) fn build_operation_identity(run_id: u64, operation_id: &str) -> Result<String> {
    positive_id(run_id, "runId")?;
    validate_identifier(operation_id, "operationId")?;
    Ok(format!(
        "process-operation:{}",
        sha256_bytes(
            format!(
                "{{\"operationId\":{},\"runId\":{run_id}}}",
                serde_json::to_string(operation_id).expect("string serialization")
            )
            .as_bytes()
        )
    ))
}

fn validate_operation_identity(value: &str) -> Result<()> {
    let hash = value
        .strip_prefix("process-operation:")
        .ok_or_else(|| invalid("operationIdentity must use the process-operation prefix"))?;
    validate_sha256(hash, "operationIdentity hash")
}

fn positive_id(value: u64, label: &str) -> Result<()> {
    if value == 0 || value > 9_007_199_254_740_991 {
        return Err(invalid(format!(
            "{label} must be a positive JavaScript-safe integer"
        )));
    }
    Ok(())
}

fn validate_executable(value: &ExecutableIdentity) -> Result<()> {
    if value.format != "elf" || !value.path.starts_with('/') || value.path.len() > 4096 {
        return Err(invalid(
            "executableIdentity must name one normalized rootfs-internal ELF path",
        ));
    }
    if value
        .path
        .split('/')
        .any(|part| part == ".." || part == ".")
        || value.path.contains('\0')
        || value.path.contains('\n')
        || value.path.contains('\r')
    {
        return Err(invalid("executableIdentity.path is not normalized"));
    }
    validate_sha256(&value.sha256, "executableIdentity.sha256")
}

fn validate_arguments(arguments: &[String]) -> Result<()> {
    if arguments.len() > 128 {
        return Err(invalid("argument vector exceeds 128 entries"));
    }
    let mut total = 0_usize;
    for argument in arguments {
        if argument.as_bytes().contains(&0) || argument.len() > 16_384 {
            return Err(invalid("argument contains a NUL or exceeds 16384 bytes"));
        }
        total = total.saturating_add(argument.len());
    }
    if total > 131_072 {
        return Err(invalid("aggregate argument vector exceeds 131072 bytes"));
    }
    Ok(())
}

fn validate_working_directory(value: &str) -> Result<()> {
    if value.is_empty() || value.len() > 4096 || value.starts_with('/') || value.contains('\0') {
        return Err(invalid("workingDirectory must be a bounded relative path"));
    }
    if value != "."
        && value
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err(invalid(
            "workingDirectory is not normalized beneath /workspace",
        ));
    }
    Ok(())
}

fn validate_environment(environment: &BTreeMap<String, String>) -> Result<()> {
    if environment.len() > 64 {
        return Err(FoundationError::new(
            PROCESS_ENVIRONMENT_INVALID,
            "environment exceeds 64 entries",
        ));
    }
    let denied = [
        "DATABASE_URL",
        "NODE_OPTIONS",
        "LD_PRELOAD",
        "LD_LIBRARY_PATH",
        "SSH_AUTH_SOCK",
        "GPG_AGENT_INFO",
        "DBUS_SESSION_BUS_ADDRESS",
        "XDG_RUNTIME_DIR",
        "HOME",
        "PATH",
        "LANG",
        "LC_ALL",
        "TMPDIR",
    ];
    let denied: BTreeSet<&str> = denied.into_iter().collect();
    for (name, value) in environment {
        let valid_name = !name.is_empty()
            && name.len() <= 128
            && name
                .as_bytes()
                .first()
                .is_some_and(|byte| byte.is_ascii_alphabetic() || *byte == b'_')
            && name
                .as_bytes()
                .iter()
                .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'_');
        if !valid_name
            || denied.contains(name.as_str())
            || value.len() > 16_384
            || value.as_bytes().contains(&0)
        {
            return Err(FoundationError::new(
                PROCESS_ENVIRONMENT_INVALID,
                format!("environment entry is invalid or denied: {name}"),
            ));
        }
    }
    Ok(())
}

fn validate_filesystem_policy(policy: &FilesystemPolicy) -> Result<()> {
    if policy.input_mode != "materialized_read_only"
        || !policy.writable_roots.is_empty()
        || policy.allow_symlinks
        || policy.allow_special_files
        || policy.max_input_files == 0
        || policy.max_input_files > 10_000
        || policy.max_input_bytes == 0
        || policy.max_input_bytes > 268_435_456
    {
        return Err(invalid("filesystemPolicy is outside version-3 authority"));
    }
    Ok(())
}

fn validate_limits(limits: ProcessLimits) -> Result<()> {
    let checks = [
        (limits.wall_time_ms, 300_000, "wallTimeMs"),
        (limits.max_output_bytes, 16_777_216, "maxOutputBytes"),
        (limits.max_processes, 64, "maxProcesses"),
        (limits.memory_bytes, 1_073_741_824, "memoryBytes"),
        (
            limits.cpu_quota_micros_per_100ms,
            100_000,
            "cpuQuotaMicrosPer100ms",
        ),
        (limits.max_open_files, 256, "maxOpenFiles"),
        (limits.max_file_bytes, 67_108_864, "maxFileBytes"),
        (limits.max_temp_bytes, 268_435_456, "maxTempBytes"),
    ];
    for (value, maximum, label) in checks {
        if value == 0 || value > maximum {
            return Err(invalid(format!("{label} exceeds version-3 authority")));
        }
    }
    Ok(())
}

fn invalid(message: impl Into<String>) -> FoundationError {
    FoundationError::new(PROCESS_LAUNCH_PLAN_INVALID, message)
}

fn json(error: serde_json::Error) -> FoundationError {
    invalid(format!("launch plan JSON is invalid: {error}"))
}
