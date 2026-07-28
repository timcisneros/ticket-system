use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::contract::{
    EmptyBody, ErrorDocument, ErrorResponse, GetSnapshotBody, MANIFEST_SCHEMA_VERSION,
    MAX_MESSAGE_BYTES, MaterializeBody, MaterializerError, MaterializerGeneration,
    PROCESS_INPUT_GENERATION_MISMATCH, PROCESS_INPUT_MANIFEST_INVALID,
    PROCESS_INPUT_REGISTRY_INVALID, PROCESS_INPUT_SNAPSHOT_MISMATCH,
    PROCESS_INPUT_SNAPSHOT_NOT_FOUND, PROCESS_INPUT_SNAPSHOT_SEAL_FAILED,
    PROCESS_INPUT_SOURCE_CHANGED, PROCESS_INPUT_STORAGE_UNAVAILABLE,
    PROCESS_MATERIALIZER_CLIENT_UNAUTHORIZED, PROCESS_MATERIALIZER_PROTOCOL_INVALID,
    PROCESS_MATERIALIZER_REQUEST_INVALID, PROCESS_MATERIALIZER_UNAVAILABLE,
    PROCESS_WORKSPACE_ALLOCATION_UNKNOWN, PROTOCOL_VERSION, ProcessInputPolicy, ProtocolOperation,
    REGISTRY_SCHEMA_VERSION, RegistryRecord, RequestEnvelope, Result, ServiceConfig,
    SuccessResponse, WorkspaceSnapshotDescriptor, canonical_struct_json, filesystem_policy_hash,
    sha256_bytes, validate_get_snapshot_body, validate_identifier, validate_materialize_body,
    validate_sha256,
};
use crate::filesystem::{
    PinnedDirectory, materialize_source_tree_from_descriptor, physical_directories_overlap,
    revalidate_materialized_source_from_descriptor, same_physical_directory, sync_directory,
    validate_manifest, verify_sealed_tree, write_and_sync_file,
};

const SOCKET_MODE: u32 = 0o660;
const PRIVATE_DIRECTORY_MODE: u32 = 0o700;
const REGISTRY_FILE_MODE: u32 = 0o440;
const PROTOCOL_IO_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Debug)]
pub struct MaterializerService {
    state: Arc<ServiceState>,
}

#[derive(Debug)]
struct ServiceState {
    config: ServiceConfig,
    input_policy: ProcessInputPolicy,
    generation: MaterializerGeneration,
    allocations: BTreeMap<String, PinnedDirectory>,
    _sealed_root: PinnedDirectory,
    socket_directory: PinnedDirectory,
    socket_name: String,
    staging: PathBuf,
    sealed: PathBuf,
    registry: PathBuf,
    quarantine: PathBuf,
    records: Mutex<BTreeMap<String, RegistryRecord>>,
    materialization_lock: Mutex<()>,
}

impl MaterializerService {
    pub fn new(config: ServiceConfig) -> Result<Self> {
        config.validate()?;
        let input_policy = ProcessInputPolicy::load(&config.input_policy_path)?;
        let allocations = pin_workspace_allocations(&config)?;
        let sealed_root = PinnedDirectory::open_absolute(Path::new(&config.sealed_snapshot_root))?;
        validate_service_owned_root(&sealed_root, "sealedSnapshotRoot", None)?;
        let (socket_directory, socket_name) = pin_socket_directory(&config)?;
        validate_existing_socket_entry(&socket_directory, &socket_name)?;
        validate_physical_boundaries(&config, &allocations, &sealed_root, &socket_directory)?;
        let root = sealed_root.proc_path();
        let staging = root.join("staging");
        let sealed = root.join("sealed");
        let registry = root.join("registry");
        let quarantine = root.join("quarantine");
        for directory in [&staging, &sealed, &registry, &quarantine] {
            create_private_directory(directory)?;
        }
        clear_abandoned_staging(&staging)?;
        let generation = derive_generation(&config, &input_policy, &allocations)?;
        let records = load_and_validate_registry(&registry, &sealed)?;
        let state = ServiceState {
            config,
            input_policy,
            generation,
            allocations,
            _sealed_root: sealed_root,
            socket_directory,
            socket_name,
            staging,
            sealed,
            registry,
            quarantine,
            records: Mutex::new(records),
            materialization_lock: Mutex::new(()),
        };
        for record in state.records.lock().map_err(registry_lock)?.values() {
            validate_record_storage(&state.sealed, record)?;
        }
        Ok(Self {
            state: Arc::new(state),
        })
    }

    pub fn generation(&self) -> &MaterializerGeneration {
        &self.state.generation
    }

    pub fn serve(self) -> Result<()> {
        self.state.socket_directory.set_as_current_directory()?;
        let socket_path =
            prepare_socket_path(&self.state.socket_directory, &self.state.socket_name)?;
        let listener = UnixListener::bind(&socket_path).map_err(|error| {
            MaterializerError::new(
                PROCESS_MATERIALIZER_UNAVAILABLE,
                format!("cannot bind materializer Unix socket: {error}"),
            )
        })?;
        fs::set_permissions(&socket_path, fs::Permissions::from_mode(SOCKET_MODE))
            .map_err(storage)?;
        for connection in listener.incoming() {
            match connection {
                Ok(stream) => {
                    if let Err(error) = handle_connection(&self.state, stream) {
                        eprintln!(
                            "materializer request failed: {}: {}",
                            error.code, error.message
                        );
                    }
                }
                Err(error) => {
                    return Err(MaterializerError::new(
                        PROCESS_MATERIALIZER_UNAVAILABLE,
                        format!("materializer socket accept failed: {error}"),
                    ));
                }
            }
        }
        Ok(())
    }
}

fn handle_connection(state: &ServiceState, mut stream: UnixStream) -> Result<()> {
    stream
        .set_read_timeout(Some(PROTOCOL_IO_TIMEOUT))
        .map_err(protocol)?;
    stream
        .set_write_timeout(Some(PROTOCOL_IO_TIMEOUT))
        .map_err(protocol)?;
    let peer_uid = peer_uid(&stream)?;
    if peer_uid != state.config.allowed_client_uid {
        let error = MaterializerError::new(
            PROCESS_MATERIALIZER_CLIENT_UNAUTHORIZED,
            "Materializer client is not authorized",
        );
        let _ = write_response(&mut stream, &pre_authentication_error_response());
        return Err(error);
    }
    let request_bytes = read_frame(&mut stream)?;
    let envelope: RequestEnvelope = serde_json::from_slice(&request_bytes).map_err(|error| {
        MaterializerError::new(
            PROCESS_MATERIALIZER_PROTOCOL_INVALID,
            format!("request envelope is invalid: {error}"),
        )
    })?;
    validate_identifier(&envelope.request_id, "requestId")?;
    if envelope.version != PROTOCOL_VERSION {
        let error = MaterializerError::new(
            PROCESS_MATERIALIZER_PROTOCOL_INVALID,
            "request protocol version must be 1",
        );
        write_response(
            &mut stream,
            &error_response(Some(&envelope.request_id), &error),
        )?;
        return Ok(());
    }

    let response = match dispatch(state, &envelope) {
        Ok(result) => serde_json::to_value(SuccessResponse {
            version: PROTOCOL_VERSION,
            request_id: envelope.request_id.clone(),
            ok: true,
            result,
        })
        .map_err(protocol)?,
        Err(error) => serde_json::to_value(error_response(Some(&envelope.request_id), &error))
            .map_err(protocol)?,
    };
    write_response(&mut stream, &response)
}

fn dispatch(state: &ServiceState, envelope: &RequestEnvelope) -> Result<Value> {
    match envelope.operation {
        ProtocolOperation::Health => {
            parse_body::<EmptyBody>(&envelope.body)?;
            serde_json::to_value(&state.generation).map_err(protocol)
        }
        ProtocolOperation::Materialize => {
            let body: MaterializeBody = parse_body(&envelope.body)?;
            validate_materialize_body(&body)?;
            let descriptor = materialize(state, &body)?;
            serde_json::to_value(descriptor).map_err(protocol)
        }
        ProtocolOperation::GetSnapshot => {
            let body: GetSnapshotBody = parse_body(&envelope.body)?;
            validate_get_snapshot_body(&body)?;
            let descriptor = get_snapshot(state, &body)?;
            serde_json::to_value(descriptor).map_err(protocol)
        }
    }
}

fn materialize(
    state: &ServiceState,
    request: &MaterializeBody,
) -> Result<WorkspaceSnapshotDescriptor> {
    if request.materializer_generation != state.generation.materializer_generation {
        return Err(MaterializerError::new(
            PROCESS_INPUT_GENERATION_MISMATCH,
            "materialization request does not name the current service generation",
        ));
    }
    let allocation = state
        .allocations
        .get(&request.workspace_allocation_id)
        .ok_or_else(|| {
            MaterializerError::new(
                PROCESS_WORKSPACE_ALLOCATION_UNKNOWN,
                "workspace allocation is not configured",
            )
        })?;
    let _guard = state.materialization_lock.lock().map_err(|_| {
        MaterializerError::new(
            PROCESS_MATERIALIZER_UNAVAILABLE,
            "materializer serialization lock is poisoned",
        )
    })?;
    validate_pinned_source_identity(allocation)?;
    validate_service_owned_root(&state._sealed_root, "sealedSnapshotRoot", None)?;

    {
        let records = state.records.lock().map_err(registry_lock)?;
        if let Some(existing) = records
            .values()
            .find(|record| record.operation_identity == request.operation_identity)
        {
            if record_matches_materialize_request(existing, request) {
                return validate_and_project_record(state, existing);
            }
            return Err(MaterializerError::new(
                PROCESS_INPUT_SNAPSHOT_MISMATCH,
                "operation identity is already bound to different materialization authority",
            ));
        }
    }

    let snapshot_id = format!("snapshot-{}", secure_random_hex(32)?);
    validate_identifier(&snapshot_id, "snapshotId")?;
    let staging_name = format!("staging-{}", secure_random_hex(24)?);
    let staging_root = state.staging.join(&staging_name);
    fs::create_dir(&staging_root).map_err(storage)?;
    fs::set_permissions(
        &staging_root,
        fs::Permissions::from_mode(PRIVATE_DIRECTORY_MODE),
    )
    .map_err(storage)?;
    let staging_tree = staging_root.join("tree");

    let source_root = allocation.duplicate()?;
    let materialized = match materialize_source_tree_from_descriptor(
        &source_root,
        &staging_tree,
        &state.input_policy,
        &request.filesystem_policy,
    ) {
        Ok(value) => value,
        Err(error) => {
            let _ = fs::remove_dir_all(&staging_root);
            return Err(error);
        }
    };

    let manifest_path = staging_root.join("manifest.json");
    if let Err(error) = write_and_sync_file(
        &manifest_path,
        &materialized.manifest_bytes,
        REGISTRY_FILE_MODE,
    )
    .and_then(|_| sync_directory(&staging_root))
    {
        let _ = fs::remove_dir_all(&staging_root);
        return Err(error);
    }
    sync_directory(&staging_root)?;
    let rescan_root = allocation.duplicate()?;
    if let Err(error) = revalidate_materialized_source_from_descriptor(
        &rescan_root,
        &state.input_policy,
        &request.filesystem_policy,
        &materialized,
    ) {
        let _ = make_service_tree_writable(&staging_root);
        let _ = fs::remove_dir_all(&staging_root);
        return Err(error);
    }
    validate_pinned_source_identity(allocation)?;

    let final_root = state.sealed.join(&snapshot_id);
    fs::rename(&staging_root, &final_root).map_err(|error| {
        MaterializerError::new(
            PROCESS_INPUT_SNAPSHOT_SEAL_FAILED,
            format!("atomic snapshot publication failed: {error}"),
        )
    })?;
    sync_directory(&state.sealed)?;

    let request_filesystem_policy_hash = filesystem_policy_hash(&request.filesystem_policy)?;
    let record = RegistryRecord {
        version: REGISTRY_SCHEMA_VERSION,
        snapshot_id: snapshot_id.clone(),
        state: "sealed".into(),
        run_id: request.run_id,
        ticket_id: request.ticket_id,
        operation_id: request.operation_id.clone(),
        operation_identity: request.operation_identity.clone(),
        workspace_allocation_id: request.workspace_allocation_id.clone(),
        policy_snapshot_hash: request.policy_snapshot_hash.clone(),
        materializer_generation: state.generation.materializer_generation.clone(),
        materializer_identity_hash: state.generation.materializer_identity_hash.clone(),
        input_policy_hash: state.generation.input_policy_hash.clone(),
        filesystem_policy: request.filesystem_policy.clone(),
        filesystem_policy_hash: request_filesystem_policy_hash,
        manifest_schema_version: MANIFEST_SCHEMA_VERSION,
        manifest_sha256: materialized.manifest_sha256,
        file_count: materialized.file_count,
        total_bytes: materialized.total_bytes,
        created_at: canonical_utc_now()?,
    };
    if let Err(error) = persist_registry_record(state, &record) {
        quarantine_unregistered_tree(state, &snapshot_id)?;
        return Err(error);
    }
    state
        .records
        .lock()
        .map_err(registry_lock)?
        .insert(snapshot_id, record.clone());
    validate_and_project_record(state, &record)
}

fn get_snapshot(
    state: &ServiceState,
    request: &GetSnapshotBody,
) -> Result<WorkspaceSnapshotDescriptor> {
    if request.expected_materializer_generation != state.generation.materializer_generation {
        return Err(MaterializerError::new(
            PROCESS_INPUT_GENERATION_MISMATCH,
            "getSnapshot does not name the current service generation",
        ));
    }
    let records = state.records.lock().map_err(registry_lock)?;
    let record = records.get(&request.snapshot_id).ok_or_else(|| {
        MaterializerError::new(
            PROCESS_INPUT_SNAPSHOT_NOT_FOUND,
            "sealed process-input snapshot was not found",
        )
    })?;
    let matches = record.state == "sealed"
        && record.run_id == request.expected_run_id
        && record.ticket_id == request.expected_ticket_id
        && record.operation_id == request.expected_operation_id
        && record.operation_identity == request.expected_operation_identity
        && record.policy_snapshot_hash == request.expected_policy_snapshot_hash
        && record.materializer_generation == request.expected_materializer_generation
        && record.filesystem_policy_hash == request.expected_filesystem_policy_hash;
    if !matches {
        return Err(MaterializerError::new(
            PROCESS_INPUT_SNAPSHOT_MISMATCH,
            "sealed process-input snapshot does not match every expected authority field",
        ));
    }
    validate_and_project_record(state, record)
}

fn validate_and_project_record(
    state: &ServiceState,
    record: &RegistryRecord,
) -> Result<WorkspaceSnapshotDescriptor> {
    validate_registry_record(record)?;
    if record.materializer_generation != state.generation.materializer_generation {
        return Err(MaterializerError::new(
            PROCESS_INPUT_GENERATION_MISMATCH,
            "snapshot belongs to a different materializer generation",
        ));
    }
    validate_record_storage(&state.sealed, record)?;
    Ok(public_descriptor(record))
}

fn validate_record_storage(sealed_root: &Path, record: &RegistryRecord) -> Result<()> {
    let snapshot_root = sealed_root.join(&record.snapshot_id);
    let manifest_path = snapshot_root.join("manifest.json");
    if fs::metadata(&manifest_path)
        .map_err(|error| {
            MaterializerError::new(
                PROCESS_INPUT_MANIFEST_INVALID,
                format!("sealed manifest is unavailable: {error}"),
            )
        })?
        .len()
        > MAX_MESSAGE_BYTES as u64
    {
        return Err(MaterializerError::new(
            PROCESS_INPUT_MANIFEST_INVALID,
            "sealed manifest exceeds the hard byte ceiling",
        ));
    }
    let manifest_bytes = fs::read(&manifest_path).map_err(|error| {
        MaterializerError::new(
            PROCESS_INPUT_MANIFEST_INVALID,
            format!("sealed manifest is unavailable: {error}"),
        )
    })?;
    if sha256_bytes(&manifest_bytes) != record.manifest_sha256 {
        return Err(MaterializerError::new(
            PROCESS_INPUT_MANIFEST_INVALID,
            "sealed manifest hash does not match the private registry",
        ));
    }
    let manifest: crate::contract::Manifest =
        serde_json::from_slice(&manifest_bytes).map_err(|error| {
            MaterializerError::new(
                PROCESS_INPUT_MANIFEST_INVALID,
                format!("sealed manifest is invalid: {error}"),
            )
        })?;
    validate_manifest(&manifest)?;
    if canonical_struct_json(&manifest)? != manifest_bytes {
        return Err(MaterializerError::new(
            PROCESS_INPUT_MANIFEST_INVALID,
            "sealed manifest is not canonical JSON",
        ));
    }
    verify_sealed_tree(
        &snapshot_root.join("tree"),
        &manifest,
        record.file_count,
        record.total_bytes,
    )?;
    Ok(())
}

fn public_descriptor(record: &RegistryRecord) -> WorkspaceSnapshotDescriptor {
    WorkspaceSnapshotDescriptor {
        id: record.snapshot_id.clone(),
        run_id: record.run_id,
        policy_snapshot_hash: record.policy_snapshot_hash.clone(),
        materializer_generation: record.materializer_generation.clone(),
        manifest_sha256: record.manifest_sha256.clone(),
        file_count: record.file_count,
        total_bytes: record.total_bytes,
    }
}

fn record_matches_materialize_request(record: &RegistryRecord, request: &MaterializeBody) -> bool {
    let Ok(request_filesystem_policy_hash) = filesystem_policy_hash(&request.filesystem_policy)
    else {
        return false;
    };
    record.state == "sealed"
        && record.run_id == request.run_id
        && record.ticket_id == request.ticket_id
        && record.operation_id == request.operation_id
        && record.operation_identity == request.operation_identity
        && record.workspace_allocation_id == request.workspace_allocation_id
        && record.policy_snapshot_hash == request.policy_snapshot_hash
        && record.materializer_generation == request.materializer_generation
        && record.filesystem_policy == request.filesystem_policy
        && record.filesystem_policy_hash == request_filesystem_policy_hash
}

fn persist_registry_record(state: &ServiceState, record: &RegistryRecord) -> Result<()> {
    validate_registry_record(record)?;
    let final_path = state.registry.join(format!("{}.json", record.snapshot_id));
    let temporary_path = state.registry.join(format!(
        ".{}.{}.tmp",
        record.snapshot_id,
        secure_random_hex(8)?
    ));
    let bytes = canonical_struct_json(record)
        .map_err(|error| MaterializerError::new(PROCESS_INPUT_REGISTRY_INVALID, error.message))?;
    write_and_sync_file(&temporary_path, &bytes, 0o600)?;
    fs::rename(&temporary_path, &final_path).map_err(|error| {
        MaterializerError::new(
            PROCESS_INPUT_REGISTRY_INVALID,
            format!("cannot atomically commit snapshot registry record: {error}"),
        )
    })?;
    fs::set_permissions(&final_path, fs::Permissions::from_mode(REGISTRY_FILE_MODE))
        .map_err(storage)?;
    sync_directory(&state.registry)
}

fn validate_registry_record(record: &RegistryRecord) -> Result<()> {
    if record.version != REGISTRY_SCHEMA_VERSION
        || record.state != "sealed"
        || record.manifest_schema_version != MANIFEST_SCHEMA_VERSION
        || record.run_id == 0
        || record.ticket_id == 0
        || record.file_count > crate::contract::MAX_INPUT_FILES_HARD
        || record.total_bytes > crate::contract::MAX_INPUT_BYTES_HARD
    {
        return Err(MaterializerError::new(
            PROCESS_INPUT_REGISTRY_INVALID,
            "private registry record has invalid fixed fields or bounds",
        ));
    }
    for (value, label) in [
        (&record.snapshot_id, "snapshotId"),
        (&record.operation_id, "operationId"),
        (&record.workspace_allocation_id, "workspaceAllocationId"),
        (&record.materializer_generation, "materializerGeneration"),
    ] {
        validate_identifier(value, label).map_err(|error| {
            MaterializerError::new(PROCESS_INPUT_REGISTRY_INVALID, error.message)
        })?;
    }
    for (value, label) in [
        (&record.policy_snapshot_hash, "policySnapshotHash"),
        (
            &record.materializer_identity_hash,
            "materializerIdentityHash",
        ),
        (&record.input_policy_hash, "inputPolicyHash"),
        (&record.filesystem_policy_hash, "filesystemPolicyHash"),
        (&record.manifest_sha256, "manifestSha256"),
    ] {
        validate_sha256(value, label).map_err(|error| {
            MaterializerError::new(PROCESS_INPUT_REGISTRY_INVALID, error.message)
        })?;
    }
    let expected_filesystem_policy_hash = filesystem_policy_hash(&record.filesystem_policy)
        .map_err(|error| MaterializerError::new(PROCESS_INPUT_REGISTRY_INVALID, error.message))?;
    if expected_filesystem_policy_hash != record.filesystem_policy_hash {
        return Err(MaterializerError::new(
            PROCESS_INPUT_REGISTRY_INVALID,
            "private registry filesystem policy hash is inconsistent",
        ));
    }
    let expected = crate::contract::build_operation_identity(record.run_id, &record.operation_id)
        .map_err(|error| {
        MaterializerError::new(PROCESS_INPUT_REGISTRY_INVALID, error.message)
    })?;
    if expected != record.operation_identity {
        return Err(MaterializerError::new(
            PROCESS_INPUT_REGISTRY_INVALID,
            "private registry operation identity is inconsistent",
        ));
    }
    validate_utc_timestamp(&record.created_at)?;
    Ok(())
}

fn load_and_validate_registry(
    registry_root: &Path,
    sealed_root: &Path,
) -> Result<BTreeMap<String, RegistryRecord>> {
    let mut records = BTreeMap::new();
    for entry in fs::read_dir(registry_root).map_err(storage)? {
        let entry = entry.map_err(storage)?;
        if !entry.file_type().map_err(storage)?.is_file() {
            return Err(MaterializerError::new(
                PROCESS_INPUT_REGISTRY_INVALID,
                "registry contains a non-file entry",
            ));
        }
        let name = entry.file_name();
        let name = name.to_str().ok_or_else(|| {
            MaterializerError::new(
                PROCESS_INPUT_REGISTRY_INVALID,
                "registry filename is not UTF-8",
            )
        })?;
        if name.starts_with('.') && name.ends_with(".tmp") {
            fs::remove_file(entry.path()).map_err(storage)?;
            continue;
        }
        let snapshot_id = name.strip_suffix(".json").ok_or_else(|| {
            MaterializerError::new(
                PROCESS_INPUT_REGISTRY_INVALID,
                "registry filename does not use the canonical .json suffix",
            )
        })?;
        validate_identifier(snapshot_id, "registry snapshotId").map_err(|error| {
            MaterializerError::new(PROCESS_INPUT_REGISTRY_INVALID, error.message)
        })?;
        if entry.metadata().map_err(storage)?.len() > MAX_MESSAGE_BYTES as u64 {
            return Err(MaterializerError::new(
                PROCESS_INPUT_REGISTRY_INVALID,
                "registry record exceeds the maximum size",
            ));
        }
        let bytes = fs::read(entry.path()).map_err(storage)?;
        let record: RegistryRecord = serde_json::from_slice(&bytes).map_err(|error| {
            MaterializerError::new(
                PROCESS_INPUT_REGISTRY_INVALID,
                format!("registry record is invalid: {error}"),
            )
        })?;
        if canonical_struct_json(&record)? != bytes {
            return Err(MaterializerError::new(
                PROCESS_INPUT_REGISTRY_INVALID,
                "registry record is not canonical JSON",
            ));
        }
        validate_registry_record(&record)?;
        if record.snapshot_id != snapshot_id {
            return Err(MaterializerError::new(
                PROCESS_INPUT_REGISTRY_INVALID,
                "registry filename and snapshotId disagree",
            ));
        }
        if !sealed_root.join(snapshot_id).is_dir() {
            return Err(MaterializerError::new(
                PROCESS_INPUT_REGISTRY_INVALID,
                "registry record points to a missing sealed tree",
            ));
        }
        if records.insert(snapshot_id.to_owned(), record).is_some() {
            return Err(MaterializerError::new(
                PROCESS_INPUT_REGISTRY_INVALID,
                "duplicate snapshotId in private registry",
            ));
        }
    }
    for entry in fs::read_dir(sealed_root).map_err(storage)? {
        let entry = entry.map_err(storage)?;
        let name = entry.file_name();
        let name = name.to_str().ok_or_else(|| {
            MaterializerError::new(
                PROCESS_INPUT_REGISTRY_INVALID,
                "sealed snapshot directory name is not UTF-8",
            )
        })?;
        if !entry.file_type().map_err(storage)?.is_dir() || !records.contains_key(name) {
            return Err(MaterializerError::new(
                PROCESS_INPUT_REGISTRY_INVALID,
                "sealed tree has no matching valid registry record",
            ));
        }
    }
    Ok(records)
}

fn derive_generation(
    config: &ServiceConfig,
    input_policy: &ProcessInputPolicy,
    allocations: &BTreeMap<String, PinnedDirectory>,
) -> Result<MaterializerGeneration> {
    let executable = std::env::current_exe().map_err(storage)?;
    let materializer_identity_hash = sha256_file(&executable)?;
    let input_policy_hash = sha256_bytes(&canonical_struct_json(input_policy)?);
    let mut canonical_config = config.clone();
    canonical_config
        .workspace_allocations
        .sort_by(|left, right| left.id.as_bytes().cmp(right.id.as_bytes()));
    for paths in [
        &mut canonical_config.protected_host_paths.runtime_data,
        &mut canonical_config.protected_host_paths.artifacts,
        &mut canonical_config.protected_host_paths.database,
    ] {
        paths.sort_by(|left, right| left.as_bytes().cmp(right.as_bytes()));
    }
    let trusted_configuration_hash = sha256_bytes(&canonical_struct_json(&canonical_config)?);
    let allocation_identities = allocations
        .iter()
        .map(|(id, allocation)| {
            let identity = allocation.identity();
            serde_json::json!({
                "device": identity.device,
                "id": id,
                "inode": identity.inode,
                "mode": identity.mode,
                "ownerGid": identity.owner_gid,
                "ownerUid": identity.owner_uid
            })
        })
        .collect::<Vec<_>>();
    let authority = serde_json::json!({
        "allocationPhysicalIdentities": allocation_identities,
        "inputPolicyHash": input_policy_hash,
        "manifestSchemaVersion": MANIFEST_SCHEMA_VERSION,
        "materializerIdentityHash": materializer_identity_hash,
        "protocolVersion": PROTOCOL_VERSION,
        "registrySchemaVersion": REGISTRY_SCHEMA_VERSION,
        "trustedServiceConfigurationHash": trusted_configuration_hash
    });
    let generation_hash = sha256_bytes(crate::contract::canonical_json(&authority).as_bytes());
    Ok(MaterializerGeneration {
        materializer_generation: format!("materializer-v1-{generation_hash}"),
        materializer_identity_hash,
        input_policy_hash,
        manifest_schema_version: MANIFEST_SCHEMA_VERSION,
        registry_schema_version: REGISTRY_SCHEMA_VERSION,
    })
}

fn pin_workspace_allocations(config: &ServiceConfig) -> Result<BTreeMap<String, PinnedDirectory>> {
    let mut pinned = BTreeMap::new();
    for allocation in &config.workspace_allocations {
        let root = PinnedDirectory::open_absolute(Path::new(&allocation.source_root)).map_err(
            |error| {
                MaterializerError::new(
                    error.code,
                    format!(
                        "workspace allocation {} cannot be pinned: {}",
                        allocation.id, error.message
                    ),
                )
            },
        )?;
        if pinned
            .values()
            .any(|existing| same_physical_directory(existing, &root))
        {
            return Err(MaterializerError::new(
                PROCESS_MATERIALIZER_REQUEST_INVALID,
                "workspace allocations must identify distinct physical directories",
            ));
        }
        pinned.insert(allocation.id.clone(), root);
    }
    Ok(pinned)
}

fn validate_service_owned_root(
    root: &PinnedDirectory,
    label: &str,
    exact_mode: Option<u32>,
) -> Result<()> {
    let identity = root.current_identity()?;
    if identity != root.identity() {
        return Err(MaterializerError::new(
            PROCESS_INPUT_STORAGE_UNAVAILABLE,
            format!("{label} identity or authority changed after startup"),
        ));
    }
    let service_uid = unsafe { libc::geteuid() };
    if identity.owner_uid != service_uid {
        return Err(MaterializerError::new(
            PROCESS_INPUT_STORAGE_UNAVAILABLE,
            format!("{label} must be owned by the materializer service UID"),
        ));
    }
    if identity.mode & 0o022 != 0 {
        return Err(MaterializerError::new(
            PROCESS_INPUT_STORAGE_UNAVAILABLE,
            format!("{label} must not be group- or world-writable"),
        ));
    }
    if let Some(mode) = exact_mode
        && identity.mode != mode
    {
        return Err(MaterializerError::new(
            PROCESS_INPUT_STORAGE_UNAVAILABLE,
            format!("{label} must have mode {mode:04o}"),
        ));
    }
    Ok(())
}

fn validate_pinned_source_identity(root: &PinnedDirectory) -> Result<()> {
    if root.current_identity()? != root.identity() {
        return Err(MaterializerError::new(
            PROCESS_INPUT_SOURCE_CHANGED,
            "workspace allocation root identity or mode changed after startup",
        ));
    }
    Ok(())
}

fn pin_socket_directory(config: &ServiceConfig) -> Result<(PinnedDirectory, String)> {
    let socket_path = Path::new(&config.socket_path);
    let parent = socket_path.parent().ok_or_else(|| {
        MaterializerError::new(
            PROCESS_MATERIALIZER_REQUEST_INVALID,
            "socketPath has no parent directory",
        )
    })?;
    let name = socket_path
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty() && !value.contains('/'))
        .ok_or_else(|| {
            MaterializerError::new(
                PROCESS_MATERIALIZER_REQUEST_INVALID,
                "socketPath must end in one valid UTF-8 entry name",
            )
        })?;
    let directory = PinnedDirectory::open_absolute(parent)?;
    validate_service_owned_root(&directory, "materializer socket directory", Some(0o750))?;
    Ok((directory, name.to_owned()))
}

fn validate_physical_boundaries(
    config: &ServiceConfig,
    allocations: &BTreeMap<String, PinnedDirectory>,
    sealed: &PinnedDirectory,
    socket_directory: &PinnedDirectory,
) -> Result<()> {
    for allocation in allocations.values() {
        if physical_directories_overlap(sealed, allocation)?
            || physical_directories_overlap(socket_directory, allocation)?
        {
            return Err(MaterializerError::new(
                PROCESS_MATERIALIZER_REQUEST_INVALID,
                "workspace allocation physically overlaps sealed storage or socket directory",
            ));
        }
    }
    if physical_directories_overlap(sealed, socket_directory)? {
        return Err(MaterializerError::new(
            PROCESS_MATERIALIZER_REQUEST_INVALID,
            "sealed storage physically overlaps the socket directory",
        ));
    }
    for candidate in config
        .protected_host_paths
        .runtime_data
        .iter()
        .chain(config.protected_host_paths.artifacts.iter())
        .chain(config.protected_host_paths.database.iter())
        .map(Path::new)
    {
        if candidate.exists() {
            let protected = PinnedDirectory::open_absolute(candidate)?;
            if physical_directories_overlap(sealed, &protected)? {
                return Err(MaterializerError::new(
                    PROCESS_MATERIALIZER_REQUEST_INVALID,
                    "sealedSnapshotRoot physically overlaps a protected host path",
                ));
            }
        }
    }
    Ok(())
}

fn create_private_directory(path: &Path) -> Result<()> {
    match fs::create_dir(path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(storage(error)),
    }
    let metadata = fs::symlink_metadata(path).map_err(storage)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(MaterializerError::new(
            PROCESS_INPUT_STORAGE_UNAVAILABLE,
            format!(
                "private storage path is not a real directory: {}",
                path.display()
            ),
        ));
    }
    if metadata.uid() != unsafe { libc::geteuid() } {
        return Err(MaterializerError::new(
            PROCESS_INPUT_STORAGE_UNAVAILABLE,
            "private storage directory is not owned by the materializer service UID",
        ));
    }
    fs::set_permissions(path, fs::Permissions::from_mode(PRIVATE_DIRECTORY_MODE)).map_err(storage)
}

fn clear_abandoned_staging(staging: &Path) -> Result<()> {
    for entry in fs::read_dir(staging).map_err(storage)? {
        let entry = entry.map_err(storage)?;
        let metadata = entry.file_type().map_err(storage)?;
        if metadata.is_dir() {
            make_service_tree_writable(&entry.path())?;
            fs::remove_dir_all(entry.path()).map_err(storage)?;
        } else {
            fs::remove_file(entry.path()).map_err(storage)?;
        }
    }
    sync_directory(staging)
}

fn make_service_tree_writable(root: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(root).map_err(storage)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(MaterializerError::new(
            PROCESS_INPUT_STORAGE_UNAVAILABLE,
            "abandoned staging entry is not a service-owned directory",
        ));
    }
    fs::set_permissions(root, fs::Permissions::from_mode(PRIVATE_DIRECTORY_MODE))
        .map_err(storage)?;
    for entry in fs::read_dir(root).map_err(storage)? {
        let entry = entry.map_err(storage)?;
        if entry.file_type().map_err(storage)?.is_dir() {
            make_service_tree_writable(&entry.path())?;
        }
    }
    Ok(())
}

fn quarantine_unregistered_tree(state: &ServiceState, snapshot_id: &str) -> Result<()> {
    let source = state.sealed.join(snapshot_id);
    let destination = state.quarantine.join(format!("{snapshot_id}-unregistered"));
    fs::rename(source, destination).map_err(|error| {
        MaterializerError::new(
            PROCESS_INPUT_SNAPSHOT_SEAL_FAILED,
            format!("registry failed and sealed tree quarantine also failed: {error}"),
        )
    })?;
    sync_directory(&state.sealed)?;
    sync_directory(&state.quarantine)
}

fn prepare_socket_path(directory: &PinnedDirectory, socket_name: &str) -> Result<PathBuf> {
    validate_service_owned_root(directory, "materializer socket directory", Some(0o750))?;
    let socket_path = PathBuf::from(socket_name);
    match fs::symlink_metadata(&socket_path) {
        Ok(metadata)
            if metadata.file_type().is_socket() && metadata.uid() == unsafe { libc::geteuid() } =>
        {
            fs::remove_file(&socket_path).map_err(storage)?;
        }
        Ok(metadata) if metadata.file_type().is_socket() => {
            return Err(MaterializerError::new(
                PROCESS_MATERIALIZER_UNAVAILABLE,
                "socketPath contains a socket not owned by the materializer service",
            ));
        }
        Ok(_) => {
            return Err(MaterializerError::new(
                PROCESS_MATERIALIZER_UNAVAILABLE,
                "socketPath exists and is not a Unix socket",
            ));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(storage(error)),
    }
    Ok(socket_path)
}

fn validate_existing_socket_entry(directory: &PinnedDirectory, socket_name: &str) -> Result<()> {
    let socket_path = directory.proc_path().join(socket_name);
    match fs::symlink_metadata(socket_path) {
        Ok(metadata)
            if metadata.file_type().is_socket() && metadata.uid() == unsafe { libc::geteuid() } =>
        {
            Ok(())
        }
        Ok(metadata) if metadata.file_type().is_socket() => Err(MaterializerError::new(
            PROCESS_MATERIALIZER_UNAVAILABLE,
            "socketPath contains a socket not owned by the materializer service",
        )),
        Ok(_) => Err(MaterializerError::new(
            PROCESS_MATERIALIZER_UNAVAILABLE,
            "socketPath exists and is not a Unix socket",
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(storage(error)),
    }
}

fn peer_uid(stream: &UnixStream) -> Result<u32> {
    let mut credentials: libc::ucred = unsafe { std::mem::zeroed() };
    let mut length = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    let status = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            &mut credentials as *mut _ as *mut libc::c_void,
            &mut length,
        )
    };
    if status != 0 || length as usize != std::mem::size_of::<libc::ucred>() {
        return Err(MaterializerError::new(
            PROCESS_MATERIALIZER_CLIENT_UNAUTHORIZED,
            "SO_PEERCRED validation failed",
        ));
    }
    Ok(credentials.uid)
}

fn read_frame(stream: &mut UnixStream) -> Result<Vec<u8>> {
    let mut header = [0_u8; 4];
    stream.read_exact(&mut header).map_err(|error| {
        MaterializerError::new(
            PROCESS_MATERIALIZER_PROTOCOL_INVALID,
            format!("cannot read request frame header: {error}"),
        )
    })?;
    let length = u32::from_be_bytes(header) as usize;
    if length == 0 || length > MAX_MESSAGE_BYTES {
        return Err(MaterializerError::new(
            PROCESS_MATERIALIZER_PROTOCOL_INVALID,
            format!("request frame must contain 1..={MAX_MESSAGE_BYTES} bytes"),
        ));
    }
    let mut bytes = vec![0_u8; length];
    stream.read_exact(&mut bytes).map_err(|error| {
        MaterializerError::new(
            PROCESS_MATERIALIZER_PROTOCOL_INVALID,
            format!("cannot read complete request frame: {error}"),
        )
    })?;
    Ok(bytes)
}

fn write_response<T: Serialize>(stream: &mut UnixStream, response: &T) -> Result<()> {
    let bytes = canonical_struct_json(response).map_err(protocol)?;
    if bytes.len() > MAX_MESSAGE_BYTES {
        return Err(MaterializerError::new(
            PROCESS_MATERIALIZER_PROTOCOL_INVALID,
            "response exceeds the bounded protocol message size",
        ));
    }
    stream
        .write_all(&(bytes.len() as u32).to_be_bytes())
        .and_then(|_| stream.write_all(&bytes))
        .and_then(|_| stream.flush())
        .map_err(|error| {
            MaterializerError::new(
                PROCESS_MATERIALIZER_PROTOCOL_INVALID,
                format!("cannot write bounded response frame: {error}"),
            )
        })
}

fn error_response(request_id: Option<&str>, error: &MaterializerError) -> ErrorResponse {
    ErrorResponse {
        version: PROTOCOL_VERSION,
        request_id: request_id.map(str::to_owned),
        ok: false,
        error: ErrorDocument {
            code: error.code.to_owned(),
            message: error.message.clone(),
        },
    }
}

fn pre_authentication_error_response() -> ErrorResponse {
    ErrorResponse {
        version: PROTOCOL_VERSION,
        request_id: None,
        ok: false,
        error: ErrorDocument {
            code: PROCESS_MATERIALIZER_CLIENT_UNAUTHORIZED.to_owned(),
            message: "Materializer client is not authorized".to_owned(),
        },
    }
}

fn parse_body<T: DeserializeOwned>(value: &Value) -> Result<T> {
    serde_json::from_value(value.clone()).map_err(|error| {
        MaterializerError::new(
            PROCESS_MATERIALIZER_REQUEST_INVALID,
            format!("request body is invalid: {error}"),
        )
    })
}

fn sha256_file(path: &Path) -> Result<String> {
    let mut file = File::open(path).map_err(storage)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 65_536];
    loop {
        let count = file.read(&mut buffer).map_err(storage)?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

pub fn secure_random_hex(bytes: usize) -> Result<String> {
    let mut random = vec![0_u8; bytes];
    File::open("/dev/urandom")
        .and_then(|mut file| file.read_exact(&mut random))
        .map_err(|error| {
            MaterializerError::new(
                PROCESS_INPUT_STORAGE_UNAVAILABLE,
                format!("cryptographic randomness is unavailable: {error}"),
            )
        })?;
    Ok(random.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn canonical_utc_now() -> Result<String> {
    let seconds = unsafe { libc::time(std::ptr::null_mut()) };
    if seconds < 0 {
        return Err(MaterializerError::new(
            PROCESS_INPUT_REGISTRY_INVALID,
            "system UTC clock is unavailable",
        ));
    }
    let mut broken_down: libc::tm = unsafe { std::mem::zeroed() };
    if unsafe { libc::gmtime_r(&seconds, &mut broken_down) }.is_null() {
        return Err(MaterializerError::new(
            PROCESS_INPUT_REGISTRY_INVALID,
            "system UTC clock could not be converted",
        ));
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

fn validate_utc_timestamp(value: &str) -> Result<()> {
    let bytes = value.as_bytes();
    if bytes.len() != 24
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[10] != b'T'
        || bytes[13] != b':'
        || bytes[16] != b':'
        || &bytes[19..] != b".000Z"
        || !bytes
            .iter()
            .copied()
            .enumerate()
            .filter(|(index, _)| ![4, 7, 10, 13, 16, 19, 20, 21, 22, 23].contains(index))
            .all(|(_, byte)| byte.is_ascii_digit())
    {
        return Err(MaterializerError::new(
            PROCESS_INPUT_REGISTRY_INVALID,
            "registry createdAt must be a canonical UTC timestamp",
        ));
    }
    Ok(())
}

fn registry_lock<T>(_: std::sync::PoisonError<T>) -> MaterializerError {
    MaterializerError::new(
        PROCESS_INPUT_REGISTRY_INVALID,
        "private registry lock is poisoned",
    )
}

fn protocol(error: impl std::fmt::Display) -> MaterializerError {
    MaterializerError::new(PROCESS_MATERIALIZER_PROTOCOL_INVALID, error.to_string())
}

fn storage(error: std::io::Error) -> MaterializerError {
    MaterializerError::new(PROCESS_INPUT_STORAGE_UNAVAILABLE, error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generation_binds_every_authority_relevant_input() {
        let root = std::env::temp_dir().join(format!(
            "ticket-materializer-generation-{}-{}",
            std::process::id(),
            secure_random_hex(8).unwrap()
        ));
        let workspace = root.join("workspace");
        let sealed = root.join("sealed");
        fs::create_dir_all(&workspace).unwrap();
        let policy_path = root.join("policy.json");
        fs::write(
            &policy_path,
            br#"{"version":1,"excludedBasenames":[".git"],"excludedBasenamePrefixes":[".env."],"excludedPathPrefixes":[],"excludedSuffixes":["~"]}"#,
        )
        .unwrap();
        let config = ServiceConfig {
            version: 1,
            socket_path: root
                .join("socket/materializer.sock")
                .to_string_lossy()
                .into(),
            sealed_snapshot_root: sealed.to_string_lossy().into(),
            allowed_client_uid: unsafe { libc::geteuid() },
            input_policy_path: policy_path.to_string_lossy().into(),
            workspace_allocations: vec![crate::contract::WorkspaceAllocation {
                id: "primary-workspace".into(),
                source_root: workspace.to_string_lossy().into(),
            }],
            protected_host_paths: crate::contract::ProtectedHostPaths {
                runtime_data: vec![root.join("runtime").to_string_lossy().into()],
                artifacts: vec![root.join("artifacts").to_string_lossy().into()],
                database: vec![root.join("database").to_string_lossy().into()],
            },
        };
        config.validate().unwrap();
        let policy = ProcessInputPolicy::load(&config.input_policy_path).unwrap();
        let allocations = pin_workspace_allocations(&config).unwrap();
        let first = derive_generation(&config, &policy, &allocations).unwrap();
        let second = derive_generation(&config, &policy, &allocations).unwrap();
        assert_eq!(first, second);
        let mut changed = policy.clone();
        changed.excluded_basenames.push("extra".into());
        changed.validate_and_canonicalize().unwrap();
        let third = derive_generation(&config, &changed, &allocations).unwrap();
        assert_ne!(first.materializer_generation, third.materializer_generation);
        let mut changed_config = config.clone();
        changed_config.allowed_client_uid += 1;
        let fourth = derive_generation(&changed_config, &policy, &allocations).unwrap();
        assert_ne!(
            first.materializer_generation,
            fourth.materializer_generation
        );
        assert_eq!(first.materializer_generation.len(), 80);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn protocol_structs_reject_extra_fields() {
        let error = serde_json::from_value::<MaterializeBody>(serde_json::json!({
            "workspaceAllocationId": "primary-workspace",
            "runId": 1,
            "ticketId": 1,
            "operationId": "op",
            "operationIdentity": crate::contract::build_operation_identity(1, "op").unwrap(),
            "policySnapshotHash": "a".repeat(64),
            "materializerGeneration": "generation",
            "filesystemPolicy": {
                "inputMode": "materialized_read_only",
                "writableRoots": [],
                "allowSymlinks": false,
                "allowSpecialFiles": false,
                "maxInputFiles": 1,
                "maxInputBytes": 1
            },
            "sourcePath": "/host"
        }))
        .unwrap_err();
        assert!(error.to_string().contains("unknown field"));
    }

    #[test]
    fn pre_authentication_refusal_is_fixed_and_uncorrelated() {
        let bytes = canonical_struct_json(&pre_authentication_error_response()).unwrap();
        assert_eq!(
            String::from_utf8(bytes).unwrap(),
            concat!(
                "{\"error\":{\"code\":\"PROCESS_MATERIALIZER_CLIENT_UNAUTHORIZED\",",
                "\"message\":\"Materializer client is not authorized\"},",
                "\"ok\":false,\"requestId\":null,\"version\":1}"
            )
        );
    }
}
