use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::launch_contract::{ExecutionResult, LaunchPlan, OperationStatus};
use crate::{
    FoundationError, PROCESS_LAUNCHER_REGISTRY_FULL, PROCESS_LAUNCHER_REGISTRY_INVALID,
    PROCESS_OPERATION_NOT_FOUND, PROCESS_OUTPUT_ACKNOWLEDGEMENT_FAILED,
    PROCESS_OUTPUT_CHUNK_INVALID, PROCESS_OUTPUT_UNAVAILABLE, Result, canonical_json,
    canonical_utc, sha256_bytes, sha256_json,
};

pub(crate) const REGISTRY_SCHEMA_VERSION: u32 = 1;
pub(crate) const MAX_FULL_OPERATION_RECORDS: usize = 4096;
pub(crate) const MAX_COMPACT_TOMBSTONES: usize = 65_536;
pub(crate) const MAX_OUTPUT_CHUNK_BYTES: u64 = 65_536;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DurableOperationRecord {
    pub version: u32,
    pub operation_identity: String,
    pub launch_plan_hash: String,
    pub containment_generation_id: String,
    pub workspace_snapshot_id: String,
    pub workspace_manifest_sha256: String,
    pub rootfs_id: String,
    pub rootfs_manifest_sha256: String,
    pub executable_sha256: String,
    pub authority_hash: String,
    pub launcher_acceptance_identity: String,
    pub state: String,
    pub accepted_at: String,
    pub started_at: Option<String>,
    pub terminal_result: Option<ExecutionResult>,
    pub terminal_result_hash: Option<String>,
    pub output_available: bool,
    pub output_acknowledged: bool,
    #[serde(default)]
    pub compacted_at: Option<String>,
    #[serde(default)]
    pub durable_finalization_hash: Option<String>,
    #[serde(default)]
    pub record_hash: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RegistryMetrics {
    pub version: u32,
    pub full_record_count: u64,
    pub compact_tombstone_count: u64,
    pub full_record_capacity: u64,
    pub compact_tombstone_capacity: u64,
    pub full_record_capacity_remaining: u64,
    pub compact_tombstone_capacity_remaining: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct OutputChunk {
    pub operation_identity: String,
    pub stream: String,
    pub offset: u64,
    pub total_bytes: u64,
    pub sha256: String,
    pub data_base64: String,
    pub end: bool,
}

#[derive(Debug)]
pub(crate) struct OperationRegistry {
    root: PathBuf,
    records: BTreeMap<String, DurableOperationRecord>,
    full_record_capacity: usize,
    compact_tombstone_capacity: usize,
}

impl OperationRegistry {
    pub(crate) fn open(state_root: &Path) -> Result<Self> {
        Self::open_with_limits(
            state_root,
            MAX_FULL_OPERATION_RECORDS,
            MAX_COMPACT_TOMBSTONES,
        )
    }

    fn open_with_limits(
        state_root: &Path,
        full_record_capacity: usize,
        compact_tombstone_capacity: usize,
    ) -> Result<Self> {
        if full_record_capacity == 0 || compact_tombstone_capacity == 0 {
            return Err(invalid(
                "launcher operation registry capacities must be positive",
            ));
        }
        let total_capacity = full_record_capacity
            .checked_add(compact_tombstone_capacity)
            .ok_or_else(|| invalid("launcher operation registry capacity overflows"))?;
        let root = state_root.join("operations");
        if !root.exists() {
            fs::create_dir(&root).map_err(registry_io)?;
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).map_err(registry_io)?;
            sync_directory(state_root)?;
        }
        let metadata = fs::symlink_metadata(&root).map_err(registry_io)?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(invalid(
                "launcher operation registry root is not a directory",
            ));
        }
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(invalid(
                "launcher operation registry root must have mode 0700",
            ));
        }
        let mut records = BTreeMap::new();
        let entries = fs::read_dir(&root).map_err(registry_io)?;
        for entry in entries {
            let entry = entry.map_err(registry_io)?;
            if records.len() >= total_capacity {
                return Err(invalid(
                    "launcher operation registry exceeds its hard ceiling",
                ));
            }
            let metadata = entry.file_type().map_err(registry_io)?;
            if !metadata.is_dir() {
                return Err(invalid(
                    "launcher operation registry contains an unknown entry",
                ));
            }
            let path = entry.path();
            let bytes = fs::read(path.join("record.json")).map_err(registry_io)?;
            if bytes.len() > 2_097_152 {
                return Err(invalid(
                    "launcher operation record exceeds its byte ceiling",
                ));
            }
            let record: DurableOperationRecord =
                serde_json::from_slice(&bytes).map_err(|error| {
                    invalid(format!("launcher operation record is invalid: {error}"))
                })?;
            validate_record(&record)?;
            if operation_directory_name(&record.operation_identity) != entry.file_name() {
                return Err(invalid(
                    "launcher operation directory does not match its operation identity",
                ));
            }
            if canonical_json(&record)? != bytes {
                return Err(invalid("launcher operation record is not canonical JSON"));
            }
            reconcile_output_files(&path, &record)?;
            if records
                .insert(record.operation_identity.clone(), record)
                .is_some()
            {
                return Err(invalid("launcher operation identity is duplicated"));
            }
        }
        let registry = Self {
            root,
            records,
            full_record_capacity,
            compact_tombstone_capacity,
        };
        let metrics = registry.metrics();
        if metrics.full_record_count > full_record_capacity as u64
            || metrics.compact_tombstone_count > compact_tombstone_capacity as u64
        {
            return Err(invalid(
                "launcher operation registry exceeds its configured capacity",
            ));
        }
        Ok(registry)
    }

    pub(crate) fn get(&self, operation_identity: &str) -> Option<&DurableOperationRecord> {
        self.records.get(operation_identity)
    }

    pub(crate) fn metrics(&self) -> RegistryMetrics {
        let compact_tombstone_count = self
            .records
            .values()
            .filter(|record| record.compacted_at.is_some())
            .count() as u64;
        let full_record_count = self.records.len() as u64 - compact_tombstone_count;
        RegistryMetrics {
            version: REGISTRY_SCHEMA_VERSION,
            full_record_count,
            compact_tombstone_count,
            full_record_capacity: self.full_record_capacity as u64,
            compact_tombstone_capacity: self.compact_tombstone_capacity as u64,
            full_record_capacity_remaining: (self.full_record_capacity as u64)
                .saturating_sub(full_record_count),
            compact_tombstone_capacity_remaining: (self.compact_tombstone_capacity as u64)
                .saturating_sub(compact_tombstone_count),
        }
    }

    pub(crate) fn accept(
        &mut self,
        plan: &LaunchPlan,
        containment_generation_id: &str,
    ) -> Result<(DurableOperationRecord, bool)> {
        let authority_hash = authority_hash(plan, containment_generation_id)?;
        if let Some(existing) = self.records.get(&plan.operation_identity) {
            if existing.launch_plan_hash != plan.launch_plan_hash
                || existing.containment_generation_id != containment_generation_id
                || existing.authority_hash != authority_hash
            {
                return Err(FoundationError::new(
                    crate::PROCESS_EXECUTION_INTENT_CONFLICT,
                    "launcher operation identity is already bound to other authority",
                ));
            }
            return Ok((existing.clone(), false));
        }
        if self.metrics().full_record_count >= self.full_record_capacity as u64
            || self.records.len() >= self.full_record_capacity + self.compact_tombstone_capacity
        {
            return Err(FoundationError::new(
                PROCESS_LAUNCHER_REGISTRY_FULL,
                "launcher operation registry is full",
            ));
        }
        let accepted_at = now()?;
        let launcher_acceptance_identity = format!(
            "process-launcher-acceptance:{}",
            sha256_json(&serde_json::json!({
                "operationIdentity": plan.operation_identity,
                "launchPlanHash": plan.launch_plan_hash,
                "containmentGenerationId": containment_generation_id,
                "authorityHash": authority_hash
            }))?
        );
        let record = DurableOperationRecord {
            version: REGISTRY_SCHEMA_VERSION,
            operation_identity: plan.operation_identity.clone(),
            launch_plan_hash: plan.launch_plan_hash.clone(),
            containment_generation_id: containment_generation_id.to_owned(),
            workspace_snapshot_id: plan.workspace_snapshot.id.clone(),
            workspace_manifest_sha256: plan.workspace_snapshot.manifest_sha256.clone(),
            rootfs_id: plan.runtime_rootfs.id.clone(),
            rootfs_manifest_sha256: plan.runtime_rootfs.manifest_sha256.clone(),
            executable_sha256: plan.executable_identity.sha256.clone(),
            authority_hash,
            launcher_acceptance_identity,
            state: "accepted".into(),
            accepted_at: accepted_at.clone(),
            started_at: None,
            terminal_result: None,
            terminal_result_hash: None,
            output_available: false,
            output_acknowledged: false,
            compacted_at: None,
            durable_finalization_hash: None,
            record_hash: None,
            updated_at: accepted_at,
        };
        self.persist_new(&record)?;
        self.records
            .insert(record.operation_identity.clone(), record.clone());
        Ok((record, true))
    }

    pub(crate) fn mark_active(&mut self, operation_identity: &str) -> Result<()> {
        let mut record = self
            .records
            .get(operation_identity)
            .cloned()
            .ok_or_else(not_found)?;
        if record.state == "active" {
            return Ok(());
        }
        if record.state != "accepted" {
            return Err(invalid(
                "only an accepted launcher operation can become active",
            ));
        }
        let timestamp = now()?;
        record.state = "active".into();
        record.started_at = Some(timestamp.clone());
        record.updated_at = timestamp;
        self.replace(record)
    }

    pub(crate) fn mark_terminal(
        &mut self,
        operation_identity: &str,
        result: ExecutionResult,
        stdout: &[u8],
        stderr: &[u8],
    ) -> Result<DurableOperationRecord> {
        let mut record = self
            .records
            .get(operation_identity)
            .cloned()
            .ok_or_else(not_found)?;
        if record.state == "terminal" {
            return Ok(record);
        }
        if !["accepted", "active"].contains(&record.state.as_str()) {
            return Err(invalid("launcher operation cannot become terminal"));
        }
        if result.operation_identity != operation_identity {
            return Err(invalid("terminal result operation identity mismatch"));
        }
        if result.output_complete {
            if result.stdout_bytes != stdout.len() as u64
                || result.stderr_bytes != stderr.len() as u64
                || result.stdout_sha256 != sha256_bytes(stdout)
                || result.stderr_sha256 != sha256_bytes(stderr)
            {
                return Err(invalid("terminal output does not match terminal result"));
            }
            self.write_output(operation_identity, "stdout", stdout)?;
            self.write_output(operation_identity, "stderr", stderr)?;
        } else if !stdout.is_empty() || !stderr.is_empty() {
            return Err(invalid("incomplete terminal output cannot be published"));
        }
        record.state = "terminal".into();
        record.started_at = record
            .started_at
            .clone()
            .or(Some(result.started_at.clone()));
        record.terminal_result_hash = Some(sha256_json(&result)?);
        record.terminal_result = Some(result);
        record.output_available = record
            .terminal_result
            .as_ref()
            .is_some_and(|value| value.output_complete);
        record.updated_at = now()?;
        self.replace(record.clone())?;
        Ok(record)
    }

    pub(crate) fn status(&self, operation_identity: &str) -> Result<OperationStatus> {
        let record = self.records.get(operation_identity).ok_or_else(not_found)?;
        Ok(OperationStatus {
            operation_identity: record.operation_identity.clone(),
            state: if record.state == "accepted" {
                "active".into()
            } else {
                record.state.clone()
            },
            launcher_acceptance_identity: record.launcher_acceptance_identity.clone(),
            terminal_result_hash: record.terminal_result_hash.clone(),
            output_available: record.output_available && !record.output_acknowledged,
            result: record.terminal_result.clone(),
        })
    }

    pub(crate) fn read_output(
        &self,
        operation_identity: &str,
        stream: &str,
        offset: u64,
        maximum_bytes: u64,
        expected_total_bytes: u64,
        expected_sha256: &str,
    ) -> Result<OutputChunk> {
        if !["stdout", "stderr"].contains(&stream) {
            return Err(chunk_invalid("stream must be stdout or stderr"));
        }
        if maximum_bytes == 0 || maximum_bytes > MAX_OUTPUT_CHUNK_BYTES {
            return Err(chunk_invalid(
                "maximumBytes exceeds the launcher chunk ceiling",
            ));
        }
        let record = self.records.get(operation_identity).ok_or_else(not_found)?;
        if record.state != "terminal" || !record.output_available || record.output_acknowledged {
            return Err(FoundationError::new(
                PROCESS_OUTPUT_UNAVAILABLE,
                "terminal launcher output is unavailable",
            ));
        }
        let result = record
            .terminal_result
            .as_ref()
            .ok_or_else(|| invalid("terminal launcher record has no result"))?;
        let (total, hash) = if stream == "stdout" {
            (result.stdout_bytes, &result.stdout_sha256)
        } else {
            (result.stderr_bytes, &result.stderr_sha256)
        };
        if total != expected_total_bytes || hash != expected_sha256 {
            return Err(chunk_invalid("expected output identity does not match"));
        }
        if offset > total {
            return Err(chunk_invalid(
                "output offset exceeds the terminal byte count",
            ));
        }
        let mut file = File::open(self.operation_path(operation_identity).join(stream))
            .map_err(output_unavailable)?;
        file.seek(SeekFrom::Start(offset))
            .map_err(output_unavailable)?;
        let remaining = total.saturating_sub(offset);
        let length = remaining.min(maximum_bytes);
        let mut bytes = vec![
            0_u8;
            usize::try_from(length).map_err(|_| {
                chunk_invalid("output chunk length exceeds the host integer range")
            })?
        ];
        file.read_exact(&mut bytes).map_err(output_unavailable)?;
        Ok(OutputChunk {
            operation_identity: operation_identity.to_owned(),
            stream: stream.to_owned(),
            offset,
            total_bytes: total,
            sha256: hash.clone(),
            data_base64: encode_base64(&bytes),
            end: offset.saturating_add(length) == total,
        })
    }

    pub(crate) fn acknowledge(
        &mut self,
        operation_identity: &str,
        terminal_result_hash: &str,
    ) -> Result<OperationStatus> {
        let mut record = self
            .records
            .get(operation_identity)
            .cloned()
            .ok_or_else(not_found)?;
        if record.state != "terminal"
            || record.terminal_result_hash.as_deref() != Some(terminal_result_hash)
        {
            return Err(FoundationError::new(
                PROCESS_OUTPUT_ACKNOWLEDGEMENT_FAILED,
                "output acknowledgement does not match the terminal result",
            ));
        }
        if !record.output_acknowledged {
            record.output_acknowledged = true;
            record.output_available = false;
            record.updated_at = now()?;
            self.replace(record)?;
        }
        for stream in ["stdout", "stderr"] {
            let path = self.operation_path(operation_identity).join(stream);
            if path.exists() {
                fs::remove_file(path).map_err(|error| {
                    FoundationError::new(
                        PROCESS_OUTPUT_ACKNOWLEDGEMENT_FAILED,
                        format!("cannot remove acknowledged launcher output: {error}"),
                    )
                })?;
            }
        }
        self.status(operation_identity)
    }

    pub(crate) fn compact(
        &mut self,
        operation_identity: &str,
        terminal_result_hash: &str,
        durable_finalization_hash: &str,
    ) -> Result<DurableOperationRecord> {
        if !canonical_sha256(durable_finalization_hash) {
            return Err(invalid("durable finalization hash is invalid"));
        }
        let mut record = self
            .records
            .get(operation_identity)
            .cloned()
            .ok_or_else(not_found)?;
        if record.state != "terminal"
            || record.terminal_result_hash.as_deref() != Some(terminal_result_hash)
            || !record.output_acknowledged
            || record.output_available
        {
            return Err(invalid(
                "launcher operation is not durably eligible for compaction",
            ));
        }
        if record.compacted_at.is_some() {
            if record.durable_finalization_hash.as_deref() != Some(durable_finalization_hash) {
                return Err(invalid(
                    "compacted launcher operation is bound to other finalization authority",
                ));
            }
            return Ok(record);
        }
        if self.metrics().compact_tombstone_count >= self.compact_tombstone_capacity as u64 {
            return Err(FoundationError::new(
                PROCESS_LAUNCHER_REGISTRY_FULL,
                "launcher compact tombstone registry is full",
            ));
        }
        let compacted_at = now()?;
        record.compacted_at = Some(compacted_at);
        record.durable_finalization_hash = Some(durable_finalization_hash.to_owned());
        record.record_hash = Some(compact_record_hash(&record)?);
        record.updated_at = now()?;
        self.replace(record.clone())?;
        Ok(record)
    }

    pub(crate) fn interrupt_incomplete(&mut self) -> Result<()> {
        let identities: Vec<String> = self
            .records
            .values()
            .filter(|record| record.state != "terminal")
            .map(|record| record.operation_identity.clone())
            .collect();
        for identity in identities {
            self.mark_infrastructure_terminal(
                &identity,
                "runtime_interrupted",
                "launcher_restart",
            )?;
        }
        Ok(())
    }

    pub(crate) fn mark_infrastructure_terminal(
        &mut self,
        operation_identity: &str,
        outcome: &str,
        cause: &str,
    ) -> Result<()> {
        if !["failed_to_start", "runtime_interrupted"].contains(&outcome) {
            return Err(invalid("invalid infrastructure terminal outcome"));
        }
        let record = self
            .records
            .get(operation_identity)
            .cloned()
            .ok_or_else(not_found)?;
        let result = ExecutionResult {
            operation_identity: operation_identity.to_owned(),
            terminal_outcome: outcome.into(),
            started_at: record
                .started_at
                .clone()
                .unwrap_or_else(|| record.accepted_at.clone()),
            ended_at: now()?,
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
            enforcement_cause: Some(cause.into()),
            cpu_throttled_events: 0,
            launcher_environment: BTreeMap::from([
                ("LANG".into(), "C.UTF-8".into()),
                ("LC_ALL".into(), "C.UTF-8".into()),
                ("TMPDIR".into(), "/tmp".into()),
            ]),
        };
        self.mark_terminal(operation_identity, result, &[], &[])?;
        Ok(())
    }

    fn persist_new(&self, record: &DurableOperationRecord) -> Result<()> {
        let directory = self.operation_path(&record.operation_identity);
        fs::create_dir(&directory).map_err(registry_io)?;
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).map_err(registry_io)?;
        sync_directory(&self.root)?;
        if let Err(error) = write_canonical_atomic(&directory, "record.json", record) {
            let _ = fs::remove_dir_all(&directory);
            return Err(error);
        }
        Ok(())
    }

    fn replace(&mut self, record: DurableOperationRecord) -> Result<()> {
        let directory = self.operation_path(&record.operation_identity);
        write_canonical_atomic(&directory, "record.json", &record)?;
        self.records
            .insert(record.operation_identity.clone(), record);
        Ok(())
    }

    fn write_output(&self, operation_identity: &str, stream: &str, bytes: &[u8]) -> Result<()> {
        let directory = self.operation_path(operation_identity);
        let temporary = directory.join(format!(".{stream}.tmp"));
        let final_path = directory.join(stream);
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temporary)
            .map_err(registry_io)?;
        file.write_all(bytes).map_err(registry_io)?;
        file.sync_all().map_err(registry_io)?;
        fs::rename(&temporary, &final_path).map_err(registry_io)?;
        sync_directory(&directory)
    }

    fn operation_path(&self, operation_identity: &str) -> PathBuf {
        self.root.join(operation_directory_name(operation_identity))
    }
}

fn validate_record(record: &DurableOperationRecord) -> Result<()> {
    if record.version != REGISTRY_SCHEMA_VERSION
        || !canonical_operation_identity(&record.operation_identity)
        || !canonical_sha256(&record.launch_plan_hash)
        || !canonical_sha256(&record.workspace_manifest_sha256)
        || !canonical_sha256(&record.rootfs_manifest_sha256)
        || !canonical_sha256(&record.executable_sha256)
        || !canonical_sha256(&record.authority_hash)
        || !record
            .launcher_acceptance_identity
            .strip_prefix("process-launcher-acceptance:")
            .is_some_and(canonical_sha256)
        || !["accepted", "active", "terminal"].contains(&record.state.as_str())
    {
        return Err(invalid("launcher operation record shape is invalid"));
    }
    if record.state == "accepted"
        && (record.started_at.is_some()
            || record.terminal_result.is_some()
            || record.terminal_result_hash.is_some()
            || record.output_available
            || record.output_acknowledged)
    {
        return Err(invalid("accepted launcher operation has impossible facts"));
    }
    if record.state == "active"
        && (record.started_at.is_none()
            || record.terminal_result.is_some()
            || record.terminal_result_hash.is_some()
            || record.output_available
            || record.output_acknowledged)
    {
        return Err(invalid("active launcher operation has impossible facts"));
    }
    if record.state == "terminal" {
        let result = record
            .terminal_result
            .as_ref()
            .ok_or_else(|| invalid("terminal launcher operation lacks terminal facts"))?;
        let hash = record
            .terminal_result_hash
            .as_ref()
            .filter(|value| canonical_sha256(value))
            .ok_or_else(|| invalid("terminal launcher result hash is invalid"))?;
        if record.started_at.is_none()
            || result.operation_identity != record.operation_identity
            || sha256_json(result)? != *hash
            || record.output_available != (result.output_complete && !record.output_acknowledged)
        {
            return Err(invalid(
                "terminal launcher operation contains contradictory facts",
            ));
        }
    }
    let compact_fields = [
        record.compacted_at.is_some(),
        record.durable_finalization_hash.is_some(),
        record.record_hash.is_some(),
    ];
    if compact_fields.iter().any(|value| *value)
        && (!compact_fields.iter().all(|value| *value)
            || record.state != "terminal"
            || !record.output_acknowledged
            || record.output_available
            || !record
                .durable_finalization_hash
                .as_deref()
                .is_some_and(canonical_sha256)
            || !record.record_hash.as_deref().is_some_and(canonical_sha256)
            || record.record_hash.as_deref() != Some(&compact_record_hash(record)?))
    {
        return Err(invalid(
            "compacted launcher tombstone contains contradictory facts",
        ));
    }
    Ok(())
}

fn compact_record_hash(record: &DurableOperationRecord) -> Result<String> {
    sha256_json(&serde_json::json!({
        "version": record.version,
        "operationIdentity": record.operation_identity,
        "authorityHash": record.authority_hash,
        "terminalResultHash": record.terminal_result_hash,
        "outputAcknowledged": record.output_acknowledged,
        "compactedAt": record.compacted_at,
        "durableFinalizationHash": record.durable_finalization_hash
    }))
}

fn reconcile_output_files(path: &Path, record: &DurableOperationRecord) -> Result<()> {
    for temporary in [".stdout.tmp", ".stderr.tmp"] {
        let candidate = path.join(temporary);
        if candidate.exists() {
            fs::remove_file(candidate).map_err(registry_io)?;
        }
    }
    if record.state != "terminal" || record.output_acknowledged {
        for stream in ["stdout", "stderr"] {
            let candidate = path.join(stream);
            if candidate.exists() {
                fs::remove_file(candidate).map_err(registry_io)?;
            }
        }
        reject_unknown_operation_files(path)?;
        sync_directory(path)?;
        return Ok(());
    }
    if !record.output_available {
        reject_unknown_operation_files(path)?;
        return Ok(());
    }
    let result = record
        .terminal_result
        .as_ref()
        .ok_or_else(|| invalid("launcher output has no terminal result"))?;
    for (name, expected_bytes, expected_hash) in [
        ("stdout", result.stdout_bytes, result.stdout_sha256.as_str()),
        ("stderr", result.stderr_bytes, result.stderr_sha256.as_str()),
    ] {
        let bytes = fs::read(path.join(name)).map_err(registry_io)?;
        if bytes.len() as u64 != expected_bytes || sha256_bytes(&bytes) != expected_hash {
            return Err(invalid(
                "launcher output file does not match terminal facts",
            ));
        }
    }
    reject_unknown_operation_files(path)?;
    Ok(())
}

fn reject_unknown_operation_files(path: &Path) -> Result<()> {
    for entry in fs::read_dir(path).map_err(registry_io)? {
        let entry = entry.map_err(registry_io)?;
        let name = entry.file_name();
        if !["record.json", "stdout", "stderr"]
            .iter()
            .any(|allowed| name == std::ffi::OsStr::new(allowed))
        {
            return Err(invalid(
                "launcher operation directory contains an unknown entry",
            ));
        }
        if !entry.file_type().map_err(registry_io)?.is_file() {
            return Err(invalid(
                "launcher operation directory contains a non-file entry",
            ));
        }
    }
    Ok(())
}

fn canonical_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .as_bytes()
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
}

fn canonical_operation_identity(value: &str) -> bool {
    value
        .strip_prefix("process-operation:")
        .is_some_and(canonical_sha256)
}

fn authority_hash(plan: &LaunchPlan, containment_generation_id: &str) -> Result<String> {
    sha256_json(&serde_json::json!({
        "operationIdentity": plan.operation_identity,
        "launchPlanHash": plan.launch_plan_hash,
        "containmentGenerationId": containment_generation_id,
        "workspaceSnapshot": plan.workspace_snapshot,
        "runtimeRootfs": plan.runtime_rootfs,
        "executableIdentity": plan.executable_identity
    }))
}

fn operation_directory_name(operation_identity: &str) -> std::ffi::OsString {
    format!("operation-{}", sha256_bytes(operation_identity.as_bytes())).into()
}

fn write_canonical_atomic<T: Serialize>(directory: &Path, name: &str, value: &T) -> Result<()> {
    let bytes = canonical_json(value)?;
    let temporary = directory.join(format!(".{name}.tmp"));
    let final_path = directory.join(name);
    if temporary.exists() {
        fs::remove_file(&temporary).map_err(registry_io)?;
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temporary)
        .map_err(registry_io)?;
    file.write_all(&bytes).map_err(registry_io)?;
    file.sync_all().map_err(registry_io)?;
    fs::rename(&temporary, &final_path).map_err(registry_io)?;
    sync_directory(directory)
}

fn sync_directory(path: &Path) -> Result<()> {
    File::open(path)
        .and_then(|file| file.sync_all())
        .map_err(registry_io)
}

fn now() -> Result<String> {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| invalid("system clock precedes the Unix epoch"))?
        .as_secs();
    canonical_utc(i64::try_from(seconds).map_err(|_| invalid("system clock exceeds range"))?)
}

fn encode_base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let first = chunk[0];
        let second = *chunk.get(1).unwrap_or(&0);
        let third = *chunk.get(2).unwrap_or(&0);
        output.push(TABLE[(first >> 2) as usize] as char);
        output.push(TABLE[(((first & 0x03) << 4) | (second >> 4)) as usize] as char);
        output.push(if chunk.len() > 1 {
            TABLE[(((second & 0x0f) << 2) | (third >> 6)) as usize] as char
        } else {
            '='
        });
        output.push(if chunk.len() > 2 {
            TABLE[(third & 0x3f) as usize] as char
        } else {
            '='
        });
    }
    output
}

fn not_found() -> FoundationError {
    FoundationError::new(
        PROCESS_OPERATION_NOT_FOUND,
        "process operation is not present in the durable launcher registry",
    )
}

fn invalid(message: impl Into<String>) -> FoundationError {
    FoundationError::new(PROCESS_LAUNCHER_REGISTRY_INVALID, message)
}

fn chunk_invalid(message: impl Into<String>) -> FoundationError {
    FoundationError::new(PROCESS_OUTPUT_CHUNK_INVALID, message)
}

fn registry_io(error: std::io::Error) -> FoundationError {
    invalid(format!("launcher operation registry I/O failed: {error}"))
}

fn output_unavailable(error: std::io::Error) -> FoundationError {
    FoundationError::new(
        PROCESS_OUTPUT_UNAVAILABLE,
        format!("launcher output is unavailable: {error}"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::launch_contract::{
        ExecutableIdentity, ExecutionPolicy, FilesystemPolicy, ProcessLimits, RuntimeRootfs,
        SandboxCapabilityProjection, WorkspaceSnapshot,
    };

    fn test_root(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "ticket-launcher-registry-{label}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        root
    }

    fn plan(identity_digit: char) -> LaunchPlan {
        let operation_identity = format!(
            "process-operation:{}",
            identity_digit.to_string().repeat(64)
        );
        LaunchPlan {
            version: 1,
            operation_id: format!("operation-{identity_digit}"),
            operation_identity,
            run_id: 1,
            ticket_id: 2,
            target_id: "ticket-system-local".into(),
            profile_id: "syntax-check".into(),
            policy_snapshot_hash: "1".repeat(64),
            runtime_phase: "verification".into(),
            sandbox_capability: SandboxCapabilityProjection {
                generation_id: format!("sandbox-containment-v1-{}", "2".repeat(64)),
                launcher_protocol_version: 1,
                launcher_identity_hash: "3".repeat(64),
                sandbox_backend_identity_hash: "4".repeat(64),
                seccomp_policy_hash: "5".repeat(64),
                rootfs_registry_generation: format!("rootfs-registry-v1-{}", "6".repeat(64)),
                materializer_generation: format!("materializer-v1-{}", "7".repeat(64)),
                delegated_cgroup_identity_hash: "8".repeat(64),
                containment_probe_hash: "9".repeat(64),
            },
            runtime_rootfs: RuntimeRootfs {
                id: "node-runtime-v1".into(),
                manifest_sha256: "a".repeat(64),
            },
            executable_identity: ExecutableIdentity {
                path: "/usr/bin/node".into(),
                sha256: "b".repeat(64),
                format: "elf".into(),
            },
            arguments: vec!["--check".into(), "server.js".into()],
            working_directory: ".".into(),
            environment: BTreeMap::from([("CI".into(), "1".into())]),
            workspace_snapshot: WorkspaceSnapshot {
                id: "workspace-snapshot-001".into(),
                run_id: 1,
                policy_snapshot_hash: "1".repeat(64),
                materializer_generation: format!("materializer-v1-{}", "7".repeat(64)),
                manifest_sha256: "c".repeat(64),
                file_count: 1,
                total_bytes: 12,
            },
            filesystem_policy: FilesystemPolicy {
                input_mode: "materialized_read_only".into(),
                writable_roots: vec![],
                allow_symlinks: false,
                allow_special_files: false,
                max_input_files: 10_000,
                max_input_bytes: 268_435_456,
            },
            limits: ProcessLimits {
                wall_time_ms: 30_000,
                max_output_bytes: 1_048_576,
                max_processes: 8,
                memory_bytes: 268_435_456,
                cpu_quota_micros_per_100ms: 100_000,
                max_open_files: 128,
                max_file_bytes: 16_777_216,
                max_temp_bytes: 67_108_864,
            },
            execution_policy: ExecutionPolicy {
                shell: false,
                stdin: "disabled".into(),
                detached: false,
                network_access: "none".into(),
                environment_mode: "replace".into(),
            },
            launch_plan_hash: identity_digit.to_string().repeat(64),
        }
    }

    fn terminal_result(operation_identity: &str, stdout: &[u8], stderr: &[u8]) -> ExecutionResult {
        ExecutionResult {
            operation_identity: operation_identity.into(),
            terminal_outcome: "completed".into(),
            started_at: "2026-07-28T12:00:00.000Z".into(),
            ended_at: "2026-07-28T12:00:00.001Z".into(),
            duration_ms: 1,
            exit_code: Some(0),
            signal: None,
            stdout_bytes: stdout.len() as u64,
            stderr_bytes: stderr.len() as u64,
            combined_output_bytes: (stdout.len() + stderr.len()) as u64,
            stdout_sha256: sha256_bytes(stdout),
            stderr_sha256: sha256_bytes(stderr),
            output_complete: true,
            resource_cause: None,
            enforcement_cause: None,
            cpu_throttled_events: 1,
            launcher_environment: BTreeMap::from([
                ("LANG".into(), "C.UTF-8".into()),
                ("LC_ALL".into(), "C.UTF-8".into()),
                ("TMPDIR".into(), "/tmp".into()),
            ]),
        }
    }

    #[test]
    fn durable_replay_output_and_acknowledgement_survive_restart() {
        let root = test_root("replay");
        let authority = plan('d');
        let identity = authority.operation_identity.clone();
        let stdout = b"raw\0stdout";
        let stderr = b"raw stderr";
        let terminal_hash;
        {
            let mut registry = OperationRegistry::open(&root).unwrap();
            let (_, inserted) = registry
                .accept(&authority, &authority.sandbox_capability.generation_id)
                .unwrap();
            assert!(inserted);
            let (_, replayed) = registry
                .accept(&authority, &authority.sandbox_capability.generation_id)
                .unwrap();
            assert!(!replayed);
            let mut conflicting = authority.clone();
            conflicting.launch_plan_hash = "e".repeat(64);
            assert_eq!(
                registry
                    .accept(&conflicting, &authority.sandbox_capability.generation_id)
                    .unwrap_err()
                    .code,
                crate::PROCESS_EXECUTION_INTENT_CONFLICT
            );
            registry.mark_active(&identity).unwrap();
            let terminal = registry
                .mark_terminal(
                    &identity,
                    terminal_result(&identity, stdout, stderr),
                    stdout,
                    stderr,
                )
                .unwrap();
            terminal_hash = terminal.terminal_result_hash.unwrap();
        }
        {
            let mut registry = OperationRegistry::open(&root).unwrap();
            assert_eq!(registry.status(&identity).unwrap().state, "terminal");
            let chunk = registry
                .read_output(
                    &identity,
                    "stdout",
                    0,
                    65_536,
                    stdout.len() as u64,
                    &sha256_bytes(stdout),
                )
                .unwrap();
            assert_eq!(chunk.data_base64, encode_base64(stdout));
            registry.acknowledge(&identity, &terminal_hash).unwrap();
        }
        let registry = OperationRegistry::open(&root).unwrap();
        let status = registry.status(&identity).unwrap();
        assert_eq!(status.state, "terminal");
        assert!(!status.output_available);
        assert_eq!(
            registry
                .read_output(
                    &identity,
                    "stdout",
                    0,
                    1,
                    stdout.len() as u64,
                    &sha256_bytes(stdout)
                )
                .unwrap_err()
                .code,
            PROCESS_OUTPUT_UNAVAILABLE
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn restart_terminalizes_incomplete_acceptance_without_reexecution() {
        let root = test_root("restart");
        let authority = plan('e');
        let identity = authority.operation_identity.clone();
        {
            let mut registry = OperationRegistry::open(&root).unwrap();
            registry
                .accept(&authority, &authority.sandbox_capability.generation_id)
                .unwrap();
            registry.mark_active(&identity).unwrap();
        }
        {
            let mut registry = OperationRegistry::open(&root).unwrap();
            registry.interrupt_incomplete().unwrap();
        }
        let registry = OperationRegistry::open(&root).unwrap();
        let status = registry.status(&identity).unwrap();
        assert_eq!(status.state, "terminal");
        let result = status.result.unwrap();
        assert_eq!(result.terminal_outcome, "runtime_interrupted");
        assert_eq!(result.exit_code, None);
        assert!(!result.output_complete);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn canonical_registry_corruption_fails_closed() {
        let root = test_root("corrupt");
        let authority = plan('f');
        let identity = authority.operation_identity.clone();
        let directory;
        let mut corrupt;
        {
            let mut registry = OperationRegistry::open(&root).unwrap();
            let (record, _) = registry
                .accept(&authority, &authority.sandbox_capability.generation_id)
                .unwrap();
            directory = registry.operation_path(&identity);
            corrupt = record;
        }
        corrupt.authority_hash = "not-a-hash".into();
        write_canonical_atomic(&directory, "record.json", &corrupt).unwrap();
        assert_eq!(
            OperationRegistry::open(&root).unwrap_err().code,
            PROCESS_LAUNCHER_REGISTRY_INVALID
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn compaction_requires_acknowledged_terminal_authority_and_preserves_replay() {
        let root = test_root("compact");
        let authority = plan('1');
        let identity = authority.operation_identity.clone();
        let finalization_hash = "f".repeat(64);
        let terminal_hash;
        {
            let mut registry = OperationRegistry::open(&root).unwrap();
            registry
                .accept(&authority, &authority.sandbox_capability.generation_id)
                .unwrap();
            assert_eq!(
                registry
                    .compact(&identity, &"a".repeat(64), &finalization_hash)
                    .unwrap_err()
                    .code,
                PROCESS_LAUNCHER_REGISTRY_INVALID
            );
            registry.mark_active(&identity).unwrap();
            terminal_hash = registry
                .mark_terminal(
                    &identity,
                    terminal_result(&identity, b"output", b""),
                    b"output",
                    b"",
                )
                .unwrap()
                .terminal_result_hash
                .unwrap();
            assert_eq!(
                registry
                    .compact(&identity, &terminal_hash, &finalization_hash)
                    .unwrap_err()
                    .code,
                PROCESS_LAUNCHER_REGISTRY_INVALID
            );
            registry.acknowledge(&identity, &terminal_hash).unwrap();
            let compacted = registry
                .compact(&identity, &terminal_hash, &finalization_hash)
                .unwrap();
            assert!(compacted.compacted_at.is_some());
            assert!(compacted.record_hash.is_some());
            assert_eq!(registry.metrics().full_record_count, 0);
            assert_eq!(registry.metrics().compact_tombstone_count, 1);
            let replay = registry
                .accept(&authority, &authority.sandbox_capability.generation_id)
                .unwrap();
            assert!(!replay.1);
            let again = registry
                .compact(&identity, &terminal_hash, &finalization_hash)
                .unwrap();
            assert_eq!(again.record_hash, compacted.record_hash);
        }
        let mut reopened = OperationRegistry::open(&root).unwrap();
        assert_eq!(reopened.metrics().compact_tombstone_count, 1);
        assert_eq!(
            reopened
                .compact(&identity, &terminal_hash, &"e".repeat(64))
                .unwrap_err()
                .code,
            PROCESS_LAUNCHER_REGISTRY_INVALID
        );
        let mut conflicting = authority.clone();
        conflicting.launch_plan_hash = "e".repeat(64);
        assert_eq!(
            reopened
                .accept(&conflicting, &authority.sandbox_capability.generation_id)
                .unwrap_err()
                .code,
            crate::PROCESS_EXECUTION_INTENT_CONFLICT
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn compaction_releases_full_record_capacity_without_releasing_identity() {
        let root = test_root("compact-capacity");
        let first = plan('3');
        let second = plan('4');
        let third = plan('5');
        let mut registry = OperationRegistry::open_with_limits(&root, 2, 1).unwrap();

        assert!(
            registry
                .accept(&first, &first.sandbox_capability.generation_id)
                .unwrap()
                .1
        );
        assert!(
            registry
                .accept(&second, &second.sandbox_capability.generation_id)
                .unwrap()
                .1
        );
        assert_eq!(registry.metrics().full_record_capacity_remaining, 0);
        assert_eq!(
            registry
                .accept(&third, &third.sandbox_capability.generation_id)
                .unwrap_err()
                .code,
            PROCESS_LAUNCHER_REGISTRY_FULL
        );

        registry.mark_active(&first.operation_identity).unwrap();
        let first_terminal_hash = registry
            .mark_terminal(
                &first.operation_identity,
                terminal_result(&first.operation_identity, b"first", b""),
                b"first",
                b"",
            )
            .unwrap()
            .terminal_result_hash
            .unwrap();
        registry
            .acknowledge(&first.operation_identity, &first_terminal_hash)
            .unwrap();
        registry
            .compact(
                &first.operation_identity,
                &first_terminal_hash,
                &"d".repeat(64),
            )
            .unwrap();
        assert_eq!(registry.metrics().full_record_capacity_remaining, 1);
        assert_eq!(registry.metrics().compact_tombstone_capacity_remaining, 0);

        assert!(
            registry
                .accept(&third, &third.sandbox_capability.generation_id)
                .unwrap()
                .1,
            "compaction must release one full-record admission slot"
        );
        assert!(
            !registry
                .accept(&first, &first.sandbox_capability.generation_id)
                .unwrap()
                .1,
            "a compacted identity must replay without launching"
        );
        let mut conflicting = first.clone();
        conflicting.launch_plan_hash = "e".repeat(64);
        assert_eq!(
            registry
                .accept(&conflicting, &first.sandbox_capability.generation_id)
                .unwrap_err()
                .code,
            crate::PROCESS_EXECUTION_INTENT_CONFLICT
        );

        registry.mark_active(&second.operation_identity).unwrap();
        let second_terminal_hash = registry
            .mark_terminal(
                &second.operation_identity,
                terminal_result(&second.operation_identity, b"second", b""),
                b"second",
                b"",
            )
            .unwrap()
            .terminal_result_hash
            .unwrap();
        registry
            .acknowledge(&second.operation_identity, &second_terminal_hash)
            .unwrap();
        assert_eq!(
            registry
                .compact(
                    &second.operation_identity,
                    &second_terminal_hash,
                    &"c".repeat(64),
                )
                .unwrap_err()
                .code,
            PROCESS_LAUNCHER_REGISTRY_FULL,
            "compact tombstones retain a separately enforced hard capacity"
        );

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn compact_record_hash_tampering_fails_startup_validation() {
        let root = test_root("compact-corrupt");
        let authority = plan('2');
        let identity = authority.operation_identity.clone();
        let directory;
        {
            let mut registry = OperationRegistry::open(&root).unwrap();
            registry
                .accept(&authority, &authority.sandbox_capability.generation_id)
                .unwrap();
            registry.mark_active(&identity).unwrap();
            let terminal_hash = registry
                .mark_terminal(&identity, terminal_result(&identity, b"", b""), b"", b"")
                .unwrap()
                .terminal_result_hash
                .unwrap();
            registry.acknowledge(&identity, &terminal_hash).unwrap();
            registry
                .compact(&identity, &terminal_hash, &"d".repeat(64))
                .unwrap();
            directory = registry.operation_path(&identity);
        }
        let mut record: DurableOperationRecord =
            serde_json::from_slice(&fs::read(directory.join("record.json")).unwrap()).unwrap();
        record.durable_finalization_hash = Some("c".repeat(64));
        write_canonical_atomic(&directory, "record.json", &record).unwrap();
        assert_eq!(
            OperationRegistry::open(&root).unwrap_err().code,
            PROCESS_LAUNCHER_REGISTRY_INVALID
        );
        fs::remove_dir_all(root).unwrap();
    }
}
