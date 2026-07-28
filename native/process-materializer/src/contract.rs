use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

pub const PROTOCOL_VERSION: u32 = 1;
pub const MANIFEST_SCHEMA_VERSION: u32 = 1;
pub const REGISTRY_SCHEMA_VERSION: u32 = 1;
pub const MAX_MESSAGE_BYTES: usize = 2_097_152;
pub const MAX_CONFIG_PATH_BYTES: usize = 4096;
pub const MAX_WORKSPACE_ALLOCATIONS: usize = 32;
pub const MAX_POLICY_RULES_PER_KIND: usize = 128;
pub const MAX_IDENTIFIER_BYTES: usize = 128;
pub const MAX_PATH_BYTES: usize = 4096;
pub const MAX_COMPONENT_BYTES: usize = 255;
pub const MAX_DIRECTORY_DEPTH: usize = 64;
pub const MAX_INPUT_FILES_HARD: u64 = 10_000;
pub const MAX_INPUT_BYTES_HARD: u64 = 268_435_456;

pub type FailureCode = &'static str;

pub const PROCESS_MATERIALIZER_UNAVAILABLE: FailureCode = "PROCESS_MATERIALIZER_UNAVAILABLE";
pub const PROCESS_MATERIALIZER_PROTOCOL_INVALID: FailureCode =
    "PROCESS_MATERIALIZER_PROTOCOL_INVALID";
pub const PROCESS_MATERIALIZER_CLIENT_UNAUTHORIZED: FailureCode =
    "PROCESS_MATERIALIZER_CLIENT_UNAUTHORIZED";
pub const PROCESS_MATERIALIZER_REQUEST_INVALID: FailureCode =
    "PROCESS_MATERIALIZER_REQUEST_INVALID";
pub const PROCESS_WORKSPACE_MUTATION_BOUNDARY_UNAVAILABLE: FailureCode =
    "PROCESS_WORKSPACE_MUTATION_BOUNDARY_UNAVAILABLE";
pub const PROCESS_WORKSPACE_ALLOCATION_UNKNOWN: FailureCode =
    "PROCESS_WORKSPACE_ALLOCATION_UNKNOWN";
pub const PROCESS_INPUT_POLICY_INVALID: FailureCode = "PROCESS_INPUT_POLICY_INVALID";
pub const PROCESS_INPUT_PATH_INVALID: FailureCode = "PROCESS_INPUT_PATH_INVALID";
pub const PROCESS_INPUT_FILENAME_UNSUPPORTED: FailureCode = "PROCESS_INPUT_FILENAME_UNSUPPORTED";
pub const PROCESS_INPUT_SYMLINK_REJECTED: FailureCode = "PROCESS_INPUT_SYMLINK_REJECTED";
pub const PROCESS_INPUT_SPECIAL_FILE_REJECTED: FailureCode = "PROCESS_INPUT_SPECIAL_FILE_REJECTED";
pub const PROCESS_INPUT_LIMIT_EXCEEDED: FailureCode = "PROCESS_INPUT_LIMIT_EXCEEDED";
pub const PROCESS_INPUT_SOURCE_CHANGED: FailureCode = "PROCESS_INPUT_SOURCE_CHANGED";
pub const PROCESS_INPUT_STORAGE_UNAVAILABLE: FailureCode = "PROCESS_INPUT_STORAGE_UNAVAILABLE";
pub const PROCESS_INPUT_MANIFEST_INVALID: FailureCode = "PROCESS_INPUT_MANIFEST_INVALID";
pub const PROCESS_INPUT_SNAPSHOT_SEAL_FAILED: FailureCode = "PROCESS_INPUT_SNAPSHOT_SEAL_FAILED";
pub const PROCESS_INPUT_SNAPSHOT_NOT_FOUND: FailureCode = "PROCESS_INPUT_SNAPSHOT_NOT_FOUND";
pub const PROCESS_INPUT_SNAPSHOT_MISMATCH: FailureCode = "PROCESS_INPUT_SNAPSHOT_MISMATCH";
pub const PROCESS_INPUT_REGISTRY_INVALID: FailureCode = "PROCESS_INPUT_REGISTRY_INVALID";
pub const PROCESS_INPUT_GENERATION_MISMATCH: FailureCode = "PROCESS_INPUT_GENERATION_MISMATCH";

#[derive(Debug, Clone)]
pub struct MaterializerError {
    pub code: FailureCode,
    pub message: String,
}

impl MaterializerError {
    pub fn new(code: FailureCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for MaterializerError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for MaterializerError {}

pub type Result<T> = std::result::Result<T, MaterializerError>;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ServiceConfig {
    pub version: u32,
    pub socket_path: String,
    pub sealed_snapshot_root: String,
    pub allowed_client_uid: u32,
    pub input_policy_path: String,
    pub workspace_allocations: Vec<WorkspaceAllocation>,
    pub protected_host_paths: ProtectedHostPaths,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceAllocation {
    pub id: String,
    pub source_root: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProtectedHostPaths {
    pub runtime_data: Vec<String>,
    pub artifacts: Vec<String>,
    pub database: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProcessInputPolicy {
    pub version: u32,
    pub excluded_basenames: Vec<String>,
    pub excluded_basename_prefixes: Vec<String>,
    pub excluded_path_prefixes: Vec<String>,
    pub excluded_suffixes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MaterializerGeneration {
    pub materializer_generation: String,
    pub materializer_identity_hash: String,
    pub input_policy_hash: String,
    pub manifest_schema_version: u32,
    pub registry_schema_version: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RequestEnvelope {
    pub version: u32,
    pub request_id: String,
    pub operation: ProtocolOperation,
    pub body: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProtocolOperation {
    Health,
    Materialize,
    GetSnapshot,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EmptyBody {}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FilesystemPolicy {
    pub input_mode: String,
    pub writable_roots: Vec<String>,
    pub allow_symlinks: bool,
    pub allow_special_files: bool,
    pub max_input_files: u64,
    pub max_input_bytes: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MaterializeBody {
    pub workspace_allocation_id: String,
    pub run_id: u64,
    pub ticket_id: u64,
    pub operation_id: String,
    pub operation_identity: String,
    pub policy_snapshot_hash: String,
    pub materializer_generation: String,
    pub filesystem_policy: FilesystemPolicy,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GetSnapshotBody {
    pub snapshot_id: String,
    pub expected_run_id: u64,
    pub expected_ticket_id: u64,
    pub expected_operation_id: String,
    pub expected_operation_identity: String,
    pub expected_policy_snapshot_hash: String,
    pub expected_materializer_generation: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceSnapshotDescriptor {
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
pub struct Manifest {
    pub version: u32,
    pub entries: Vec<ManifestEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum ManifestEntry {
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
}

impl ManifestEntry {
    pub fn path(&self) -> &str {
        match self {
            Self::Directory { path, .. } | Self::RegularFile { path, .. } => path,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegistryRecord {
    pub version: u32,
    pub snapshot_id: String,
    pub state: String,
    pub run_id: u64,
    pub ticket_id: u64,
    pub operation_id: String,
    pub operation_identity: String,
    pub workspace_allocation_id: String,
    pub policy_snapshot_hash: String,
    pub materializer_generation: String,
    pub materializer_identity_hash: String,
    pub input_policy_hash: String,
    pub manifest_schema_version: u32,
    pub manifest_sha256: String,
    pub file_count: u64,
    pub total_bytes: u64,
    pub created_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SuccessResponse<T: Serialize> {
    pub version: u32,
    pub request_id: String,
    pub ok: bool,
    pub result: T,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorResponse {
    pub version: u32,
    pub request_id: String,
    pub ok: bool,
    pub error: ErrorDocument,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorDocument {
    pub code: String,
    pub message: String,
}

impl ServiceConfig {
    pub fn load(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref();
        validate_host_path_text(path.to_string_lossy().as_ref(), "configuration path")?;
        if fs::metadata(path)
            .map_err(|error| {
                MaterializerError::new(
                    PROCESS_INPUT_STORAGE_UNAVAILABLE,
                    format!("cannot inspect trusted service configuration: {error}"),
                )
            })?
            .len()
            > MAX_MESSAGE_BYTES as u64
        {
            return Err(MaterializerError::new(
                PROCESS_MATERIALIZER_REQUEST_INVALID,
                "trusted service configuration exceeds the maximum size",
            ));
        }
        let bytes = fs::read(path).map_err(|error| {
            MaterializerError::new(
                PROCESS_INPUT_STORAGE_UNAVAILABLE,
                format!("cannot read trusted service configuration: {error}"),
            )
        })?;
        if bytes.len() > MAX_MESSAGE_BYTES {
            return Err(MaterializerError::new(
                PROCESS_MATERIALIZER_REQUEST_INVALID,
                "trusted service configuration exceeds the maximum size",
            ));
        }
        let config: Self = serde_json::from_slice(&bytes).map_err(|error| {
            MaterializerError::new(
                PROCESS_MATERIALIZER_REQUEST_INVALID,
                format!("trusted service configuration is invalid: {error}"),
            )
        })?;
        config.validate()?;
        Ok(config)
    }

    pub fn validate(&self) -> Result<()> {
        if self.version != 1 {
            return Err(MaterializerError::new(
                PROCESS_MATERIALIZER_REQUEST_INVALID,
                "service configuration version must be 1",
            ));
        }
        validate_host_path_text(&self.socket_path, "socketPath")?;
        validate_host_path_text(&self.sealed_snapshot_root, "sealedSnapshotRoot")?;
        validate_host_path_text(&self.input_policy_path, "inputPolicyPath")?;
        if self.workspace_allocations.is_empty()
            || self.workspace_allocations.len() > MAX_WORKSPACE_ALLOCATIONS
        {
            return Err(MaterializerError::new(
                PROCESS_MATERIALIZER_REQUEST_INVALID,
                format!(
                    "workspaceAllocations must contain 1..={MAX_WORKSPACE_ALLOCATIONS} entries"
                ),
            ));
        }
        let mut allocation_ids = BTreeSet::new();
        for allocation in &self.workspace_allocations {
            validate_identifier(&allocation.id, "workspace allocation id")?;
            validate_host_path_text(&allocation.source_root, "workspace sourceRoot")?;
            if !allocation_ids.insert(allocation.id.as_str()) {
                return Err(MaterializerError::new(
                    PROCESS_MATERIALIZER_REQUEST_INVALID,
                    format!("duplicate workspace allocation id: {}", allocation.id),
                ));
            }
        }
        let protected = [
            ("runtimeData", &self.protected_host_paths.runtime_data),
            ("artifacts", &self.protected_host_paths.artifacts),
            ("database", &self.protected_host_paths.database),
        ];
        for (label, paths) in protected {
            if paths.len() > MAX_WORKSPACE_ALLOCATIONS {
                return Err(MaterializerError::new(
                    PROCESS_MATERIALIZER_REQUEST_INVALID,
                    format!("protectedHostPaths.{label} exceeds {MAX_WORKSPACE_ALLOCATIONS}"),
                ));
            }
            for value in paths {
                validate_host_path_text(value, &format!("protectedHostPaths.{label}"))?;
            }
        }
        validate_configured_path_separation(self)?;
        Ok(())
    }
}

impl ProcessInputPolicy {
    pub fn load(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref();
        if fs::metadata(path)
            .map_err(|error| {
                MaterializerError::new(
                    PROCESS_INPUT_POLICY_INVALID,
                    format!("cannot inspect process-input exclusion policy: {error}"),
                )
            })?
            .len()
            > MAX_MESSAGE_BYTES as u64
        {
            return Err(MaterializerError::new(
                PROCESS_INPUT_POLICY_INVALID,
                "process-input exclusion policy exceeds the maximum size",
            ));
        }
        let bytes = fs::read(path).map_err(|error| {
            MaterializerError::new(
                PROCESS_INPUT_POLICY_INVALID,
                format!("cannot read process-input exclusion policy: {error}"),
            )
        })?;
        if bytes.len() > MAX_MESSAGE_BYTES {
            return Err(MaterializerError::new(
                PROCESS_INPUT_POLICY_INVALID,
                "process-input exclusion policy exceeds the maximum size",
            ));
        }
        let mut policy: Self = serde_json::from_slice(&bytes).map_err(|error| {
            MaterializerError::new(
                PROCESS_INPUT_POLICY_INVALID,
                format!("process-input exclusion policy is invalid: {error}"),
            )
        })?;
        policy.validate_and_canonicalize()?;
        Ok(policy)
    }

    pub fn validate_and_canonicalize(&mut self) -> Result<()> {
        if self.version != 1 {
            return Err(MaterializerError::new(
                PROCESS_INPUT_POLICY_INVALID,
                "process-input exclusion policy version must be 1",
            ));
        }
        validate_policy_rules(&mut self.excluded_basenames, "excludedBasenames", false)?;
        validate_policy_rules(
            &mut self.excluded_basename_prefixes,
            "excludedBasenamePrefixes",
            false,
        )?;
        validate_policy_rules(
            &mut self.excluded_path_prefixes,
            "excludedPathPrefixes",
            true,
        )?;
        validate_policy_rules(&mut self.excluded_suffixes, "excludedSuffixes", false)?;
        Ok(())
    }

    pub fn excludes(&self, relative_path: &str, basename: &str) -> bool {
        if self
            .excluded_basenames
            .iter()
            .any(|rule| basename == rule || (rule == ".env" && basename.starts_with(".env.")))
        {
            return true;
        }
        if self
            .excluded_basename_prefixes
            .iter()
            .any(|rule| basename.starts_with(rule))
        {
            return true;
        }
        if self
            .excluded_suffixes
            .iter()
            .any(|rule| basename.ends_with(rule))
        {
            return true;
        }
        self.excluded_path_prefixes
            .iter()
            .any(|rule| relative_path == rule || relative_path.starts_with(&format!("{rule}/")))
    }
}

pub fn validate_materialize_body(body: &MaterializeBody) -> Result<()> {
    validate_identifier(&body.workspace_allocation_id, "workspaceAllocationId")?;
    validate_positive_id(body.run_id, "runId")?;
    validate_positive_id(body.ticket_id, "ticketId")?;
    validate_identifier(&body.operation_id, "operationId")?;
    validate_sha256(&body.policy_snapshot_hash, "policySnapshotHash")?;
    validate_identifier(&body.materializer_generation, "materializerGeneration")?;
    let expected_identity = build_operation_identity(body.run_id, &body.operation_id)?;
    if body.operation_identity != expected_identity {
        return Err(MaterializerError::new(
            PROCESS_MATERIALIZER_REQUEST_INVALID,
            "operationIdentity does not match runId and operationId",
        ));
    }
    validate_filesystem_policy(&body.filesystem_policy)?;
    Ok(())
}

pub fn validate_get_snapshot_body(body: &GetSnapshotBody) -> Result<()> {
    validate_identifier(&body.snapshot_id, "snapshotId")?;
    validate_positive_id(body.expected_run_id, "expectedRunId")?;
    validate_positive_id(body.expected_ticket_id, "expectedTicketId")?;
    validate_identifier(&body.expected_operation_id, "expectedOperationId")?;
    validate_sha256(
        &body.expected_policy_snapshot_hash,
        "expectedPolicySnapshotHash",
    )?;
    validate_identifier(
        &body.expected_materializer_generation,
        "expectedMaterializerGeneration",
    )?;
    let expected = build_operation_identity(body.expected_run_id, &body.expected_operation_id)?;
    if body.expected_operation_identity != expected {
        return Err(MaterializerError::new(
            PROCESS_MATERIALIZER_REQUEST_INVALID,
            "expectedOperationIdentity does not match expectedRunId and expectedOperationId",
        ));
    }
    Ok(())
}

pub fn validate_filesystem_policy(policy: &FilesystemPolicy) -> Result<()> {
    if policy.input_mode != "materialized_read_only"
        || !policy.writable_roots.is_empty()
        || policy.allow_symlinks
        || policy.allow_special_files
    {
        return Err(MaterializerError::new(
            PROCESS_INPUT_POLICY_INVALID,
            "filesystemPolicy must use the frozen read-only process-input policy",
        ));
    }
    if policy.max_input_files == 0 || policy.max_input_files > MAX_INPUT_FILES_HARD {
        return Err(MaterializerError::new(
            PROCESS_INPUT_POLICY_INVALID,
            format!("maxInputFiles must be in 1..={MAX_INPUT_FILES_HARD}"),
        ));
    }
    if policy.max_input_bytes == 0 || policy.max_input_bytes > MAX_INPUT_BYTES_HARD {
        return Err(MaterializerError::new(
            PROCESS_INPUT_POLICY_INVALID,
            format!("maxInputBytes must be in 1..={MAX_INPUT_BYTES_HARD}"),
        ));
    }
    Ok(())
}

pub fn validate_identifier(value: &str, label: &str) -> Result<()> {
    if value.is_empty() || value.len() > MAX_IDENTIFIER_BYTES {
        return Err(MaterializerError::new(
            PROCESS_MATERIALIZER_REQUEST_INVALID,
            format!("{label} must contain 1..={MAX_IDENTIFIER_BYTES} bytes"),
        ));
    }
    let bytes = value.as_bytes();
    if !bytes[0].is_ascii_lowercase() && !bytes[0].is_ascii_digit() {
        return Err(MaterializerError::new(
            PROCESS_MATERIALIZER_REQUEST_INVALID,
            format!("{label} must begin with a lowercase ASCII letter or number"),
        ));
    }
    if !bytes.iter().all(|byte| {
        byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(*byte, b'.' | b'_' | b'-')
    }) {
        return Err(MaterializerError::new(
            PROCESS_MATERIALIZER_REQUEST_INVALID,
            format!("{label} contains unsupported characters"),
        ));
    }
    Ok(())
}

pub fn validate_sha256(value: &str, label: &str) -> Result<()> {
    if value.len() != 64
        || !value
            .as_bytes()
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
    {
        return Err(MaterializerError::new(
            PROCESS_MATERIALIZER_REQUEST_INVALID,
            format!("{label} must be a lowercase SHA-256 hash"),
        ));
    }
    Ok(())
}

pub fn validate_positive_id(value: u64, label: &str) -> Result<()> {
    if value == 0 || value > 9_007_199_254_740_991 {
        return Err(MaterializerError::new(
            PROCESS_MATERIALIZER_REQUEST_INVALID,
            format!("{label} must be a positive JavaScript-safe integer"),
        ));
    }
    Ok(())
}

pub fn build_operation_identity(run_id: u64, operation_id: &str) -> Result<String> {
    validate_positive_id(run_id, "runId")?;
    validate_identifier(operation_id, "operationId")?;
    let value = serde_json::json!({
        "operationId": operation_id,
        "runId": run_id
    });
    Ok(format!(
        "process-operation:{}",
        sha256_bytes(canonical_json(&value).as_bytes())
    ))
}

pub fn canonical_json(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => serde_json::to_string(value).expect("serializing a string"),
        Value::Array(values) => format!(
            "[{}]",
            values
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(values) => {
            let sorted: BTreeMap<&String, &Value> = values.iter().collect();
            format!(
                "{{{}}}",
                sorted
                    .into_iter()
                    .map(|(key, value)| format!(
                        "{}:{}",
                        serde_json::to_string(key).expect("serializing an object key"),
                        canonical_json(value)
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
    }
}

pub fn canonical_struct_json<T: Serialize>(value: &T) -> Result<Vec<u8>> {
    let json = serde_json::to_value(value).map_err(|error| {
        MaterializerError::new(
            PROCESS_INPUT_MANIFEST_INVALID,
            format!("cannot serialize canonical structure: {error}"),
        )
    })?;
    Ok(canonical_json(&json).into_bytes())
}

pub fn sha256_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn validate_policy_rules(rules: &mut [String], label: &str, path_rules: bool) -> Result<()> {
    if rules.len() > MAX_POLICY_RULES_PER_KIND {
        return Err(MaterializerError::new(
            PROCESS_INPUT_POLICY_INVALID,
            format!("{label} exceeds {MAX_POLICY_RULES_PER_KIND} entries"),
        ));
    }
    for rule in rules.iter() {
        if rule.is_empty()
            || rule.len() > MAX_PATH_BYTES
            || rule
                .bytes()
                .any(|byte| byte == 0 || byte.is_ascii_control())
            || rule.starts_with('/')
            || rule.ends_with('/')
        {
            return Err(MaterializerError::new(
                PROCESS_INPUT_POLICY_INVALID,
                format!("{label} contains an invalid rule"),
            ));
        }
        if path_rules {
            validate_relative_manifest_path(rule)?;
        } else if rule.contains('/') {
            return Err(MaterializerError::new(
                PROCESS_INPUT_POLICY_INVALID,
                format!("{label} basename rules must not contain '/'"),
            ));
        }
    }
    rules.sort_by(|left, right| left.as_bytes().cmp(right.as_bytes()));
    if rules.windows(2).any(|window| window[0] == window[1]) {
        return Err(MaterializerError::new(
            PROCESS_INPUT_POLICY_INVALID,
            format!("{label} contains duplicate rules"),
        ));
    }
    Ok(())
}

pub fn validate_relative_manifest_path(value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > MAX_PATH_BYTES
        || value.starts_with('/')
        || value.ends_with('/')
        || value
            .bytes()
            .any(|byte| byte == 0 || byte.is_ascii_control())
    {
        return Err(MaterializerError::new(
            PROCESS_INPUT_PATH_INVALID,
            "process-input path is not a normalized relative UTF-8 path",
        ));
    }
    let components: Vec<&str> = value.split('/').collect();
    if components.len() > MAX_DIRECTORY_DEPTH
        || components.iter().any(|component| {
            component.is_empty()
                || *component == "."
                || *component == ".."
                || component.len() > MAX_COMPONENT_BYTES
        })
    {
        return Err(MaterializerError::new(
            PROCESS_INPUT_PATH_INVALID,
            "process-input path exceeds component or depth bounds",
        ));
    }
    Ok(())
}

fn validate_host_path_text(value: &str, label: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > MAX_CONFIG_PATH_BYTES
        || value
            .bytes()
            .any(|byte| byte == 0 || byte.is_ascii_control())
    {
        return Err(MaterializerError::new(
            PROCESS_MATERIALIZER_REQUEST_INVALID,
            format!("{label} is invalid or exceeds {MAX_CONFIG_PATH_BYTES} bytes"),
        ));
    }
    let path = Path::new(value);
    if !path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::CurDir))
    {
        return Err(MaterializerError::new(
            PROCESS_MATERIALIZER_REQUEST_INVALID,
            format!("{label} must be a normalized absolute path"),
        ));
    }
    Ok(())
}

fn lexical_normalize(path: &str) -> PathBuf {
    Path::new(path).components().collect()
}

fn paths_overlap(left: &Path, right: &Path) -> bool {
    left == right || left.starts_with(right) || right.starts_with(left)
}

fn validate_configured_path_separation(config: &ServiceConfig) -> Result<()> {
    let sealed = lexical_normalize(&config.sealed_snapshot_root);
    let socket = lexical_normalize(&config.socket_path);
    let mut forbidden = vec![socket];
    forbidden.extend(
        config
            .protected_host_paths
            .runtime_data
            .iter()
            .chain(config.protected_host_paths.artifacts.iter())
            .chain(config.protected_host_paths.database.iter())
            .map(|value| lexical_normalize(value)),
    );
    for allocation in &config.workspace_allocations {
        let source = lexical_normalize(&allocation.source_root);
        if paths_overlap(&sealed, &source) {
            return Err(MaterializerError::new(
                PROCESS_MATERIALIZER_REQUEST_INVALID,
                format!(
                    "sealedSnapshotRoot overlaps workspace allocation {}",
                    allocation.id
                ),
            ));
        }
        forbidden.push(source);
    }
    if let Some(conflict) = forbidden
        .iter()
        .find(|candidate| paths_overlap(&sealed, candidate))
    {
        return Err(MaterializerError::new(
            PROCESS_MATERIALIZER_REQUEST_INVALID,
            format!(
                "sealedSnapshotRoot overlaps a protected host path: {}",
                conflict.display()
            ),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn operation_identity_matches_the_frozen_canonical_contract() {
        assert_eq!(
            build_operation_identity(123, "operation-001").unwrap(),
            "process-operation:887b66d446a3d40fc026928bde60567b934104a61adfa8af8ef295c0a4b4eafc"
        );
    }

    #[test]
    fn policy_exclusion_is_deterministic_and_keeps_project_manifests() {
        let mut policy = ProcessInputPolicy {
            version: 1,
            excluded_basenames: vec![
                "node_modules".into(),
                ".git".into(),
                ".env".into(),
                "runtime-state".into(),
                "replay-snapshots".into(),
                "artifacts".into(),
            ],
            excluded_basename_prefixes: vec![".env.".into()],
            excluded_path_prefixes: vec![".runtime".into()],
            excluded_suffixes: vec!["~".into(), ".swp".into(), ".sock".into()],
        };
        policy.validate_and_canonicalize().unwrap();
        for (path, basename) in [
            (".git/config", ".git"),
            (".env", ".env"),
            (".env.local", ".env.local"),
            ("node_modules/a.js", "node_modules"),
            ("artifacts/out", "artifacts"),
            ("runtime-state/run", "runtime-state"),
            ("replay-snapshots/1", "replay-snapshots"),
            (".runtime/service.sock", ".runtime"),
            ("tmp/editor.swp", "editor.swp"),
            ("tmp/materializer.sock", "materializer.sock"),
        ] {
            assert!(policy.excludes(path, basename), "{path} should be excluded");
        }
        assert!(!policy.excludes("package.json", "package.json"));
        assert!(!policy.excludes("pnpm-lock.yaml", "pnpm-lock.yaml"));
        let serialized = canonical_struct_json(&policy).unwrap();
        assert_eq!(sha256_bytes(&serialized).len(), 64);
    }

    #[test]
    fn filesystem_policy_is_closed_and_bounded() {
        let valid = FilesystemPolicy {
            input_mode: "materialized_read_only".into(),
            writable_roots: vec![],
            allow_symlinks: false,
            allow_special_files: false,
            max_input_files: MAX_INPUT_FILES_HARD,
            max_input_bytes: MAX_INPUT_BYTES_HARD,
        };
        validate_filesystem_policy(&valid).unwrap();
        let mut invalid = valid.clone();
        invalid.max_input_files += 1;
        assert_eq!(
            validate_filesystem_policy(&invalid).unwrap_err().code,
            PROCESS_INPUT_POLICY_INVALID
        );
    }

    #[test]
    fn service_configuration_rejects_duplicate_allocations_and_path_overlap() {
        let base = ServiceConfig {
            version: 1,
            socket_path: "/run/ticket-system-process/materializer.sock".into(),
            sealed_snapshot_root: "/var/lib/ticket-system/process-inputs".into(),
            allowed_client_uid: 1000,
            input_policy_path: "/etc/ticket-system/process-input-policy.json".into(),
            workspace_allocations: vec![WorkspaceAllocation {
                id: "primary-workspace".into(),
                source_root: "/srv/ticket-system/workspace".into(),
            }],
            protected_host_paths: ProtectedHostPaths {
                runtime_data: vec!["/var/lib/ticket-system/runtime".into()],
                artifacts: vec!["/var/lib/ticket-system/artifacts".into()],
                database: vec!["/run/postgresql".into()],
            },
        };
        base.validate().unwrap();
        let mut duplicate = base.clone();
        duplicate
            .workspace_allocations
            .push(duplicate.workspace_allocations[0].clone());
        assert_eq!(
            duplicate.validate().unwrap_err().code,
            PROCESS_MATERIALIZER_REQUEST_INVALID
        );
        let mut overlap = base;
        overlap.workspace_allocations[0].source_root =
            "/var/lib/ticket-system/process-inputs/workspace".into();
        assert_eq!(
            overlap.validate().unwrap_err().code,
            PROCESS_MATERIALIZER_REQUEST_INVALID
        );
    }

    #[test]
    fn manifest_path_contract_is_exact_utf8_and_byte_bounded() {
        let maximum_component = "a".repeat(MAX_COMPONENT_BYTES);
        validate_relative_manifest_path(&maximum_component).unwrap();
        assert_eq!(
            validate_relative_manifest_path(&"a".repeat(MAX_COMPONENT_BYTES + 1))
                .unwrap_err()
                .code,
            PROCESS_INPUT_PATH_INVALID
        );
        let maximum_depth = (0..MAX_DIRECTORY_DEPTH)
            .map(|_| "a")
            .collect::<Vec<_>>()
            .join("/");
        validate_relative_manifest_path(&maximum_depth).unwrap();
        assert_eq!(
            validate_relative_manifest_path(&format!("{maximum_depth}/a"))
                .unwrap_err()
                .code,
            PROCESS_INPUT_PATH_INVALID
        );
        for invalid in ["/absolute", "../parent", "a/../b", "a//b", "control\nname"] {
            assert_eq!(
                validate_relative_manifest_path(invalid).unwrap_err().code,
                PROCESS_INPUT_PATH_INVALID
            );
        }
    }
}
