use std::fs::File;
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, RawFd};
use std::os::unix::fs::MetadataExt;
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    FoundationError, MAX_MESSAGE_BYTES, PROCESS_SNAPSHOT_DESCRIPTOR_INVALID,
    PROCESS_SNAPSHOT_DESCRIPTOR_UNAVAILABLE, Result, canonical_json_bytes, sha256_bytes,
    validate_identifier, validate_sha256,
};

const MATERIALIZER_PROTOCOL_VERSION: u32 = 1;
const IO_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MaterializerHealth {
    pub materializer_generation: String,
    pub materializer_identity_hash: String,
    pub input_policy_hash: String,
    pub manifest_schema_version: u32,
    pub registry_schema_version: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AcquireSnapshotRequest<'a> {
    pub snapshot_id: &'a str,
    pub expected_run_id: u64,
    pub expected_ticket_id: u64,
    pub expected_operation_id: &'a str,
    pub expected_operation_identity: &'a str,
    pub expected_policy_snapshot_hash: &'a str,
    pub expected_materializer_generation: &'a str,
    pub expected_filesystem_policy_hash: &'a str,
    pub expected_manifest_sha256: &'a str,
    pub expected_file_count: u64,
    pub expected_total_bytes: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SnapshotDescriptorAuthority {
    snapshot_id: String,
    manifest_sha256: String,
    file_count: u64,
    total_bytes: u64,
    descriptor_count: u32,
}

#[derive(Debug)]
pub(crate) struct AcquiredSnapshot {
    pub tree: File,
    pub manifest: File,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RequestEnvelope<T: Serialize> {
    version: u32,
    request_id: String,
    operation: String,
    body: T,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResponseEnvelope {
    version: u32,
    request_id: Option<String>,
    ok: bool,
    #[serde(default)]
    result: Option<Value>,
    #[serde(default)]
    error: Option<ErrorDocument>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ErrorDocument {
    code: String,
    message: String,
}

#[derive(Debug)]
pub(crate) struct MaterializerClient {
    socket_path: String,
    expected_uid: u32,
}

impl MaterializerClient {
    pub(crate) fn new(socket_path: String, expected_uid: u32) -> Self {
        Self {
            socket_path,
            expected_uid,
        }
    }

    pub(crate) fn health(&self) -> Result<MaterializerHealth> {
        let (value, descriptors) =
            self.request("launcher-health", "health", serde_json::json!({}))?;
        if !descriptors.is_empty() {
            return Err(descriptor_invalid(
                "materializer health returned descriptors",
            ));
        }
        let health: MaterializerHealth = serde_json::from_value(value).map_err(|error| {
            descriptor_invalid(format!("materializer health is invalid: {error}"))
        })?;
        validate_identifier(&health.materializer_generation, "materializerGeneration")?;
        validate_sha256(
            &health.materializer_identity_hash,
            "materializerIdentityHash",
        )?;
        validate_sha256(&health.input_policy_hash, "inputPolicyHash")?;
        if health.manifest_schema_version != 1 || health.registry_schema_version != 1 {
            return Err(descriptor_invalid(
                "materializer health uses unsupported manifest or registry schema",
            ));
        }
        Ok(health)
    }

    pub(crate) fn acquire(&self, request: &AcquireSnapshotRequest<'_>) -> Result<AcquiredSnapshot> {
        let (value, descriptors) = self.request("launcher-acquire", "acquireSnapshot", request)?;
        let authority: SnapshotDescriptorAuthority =
            serde_json::from_value(value).map_err(|error| {
                descriptor_invalid(format!("snapshot descriptor authority is invalid: {error}"))
            })?;
        if authority.snapshot_id != request.snapshot_id
            || authority.manifest_sha256 != request.expected_manifest_sha256
            || authority.file_count != request.expected_file_count
            || authority.total_bytes != request.expected_total_bytes
            || authority.descriptor_count != 2
            || descriptors.len() != 2
        {
            return Err(descriptor_invalid(
                "materializer descriptor response does not match launch authority",
            ));
        }
        let mut descriptors = descriptors.into_iter();
        let tree = descriptors.next().expect("length checked");
        let mut manifest = descriptors.next().expect("length checked");
        let tree_metadata = tree.metadata().map_err(|error| {
            descriptor_invalid(format!("cannot inspect sealed tree descriptor: {error}"))
        })?;
        let manifest_metadata = manifest.metadata().map_err(|error| {
            descriptor_invalid(format!(
                "cannot inspect sealed manifest descriptor: {error}"
            ))
        })?;
        if !tree_metadata.is_dir()
            || tree_metadata.uid() != self.expected_uid
            || tree_metadata.mode() & 0o222 != 0
            || !manifest_metadata.is_file()
            || manifest_metadata.uid() != self.expected_uid
            || manifest_metadata.mode() & 0o222 != 0
            || manifest_metadata.len() > MAX_MESSAGE_BYTES as u64
        {
            return Err(descriptor_invalid(
                "received snapshot descriptors have invalid type, owner, mode, or size",
            ));
        }
        let mut bytes = Vec::with_capacity(manifest_metadata.len() as usize);
        manifest.read_to_end(&mut bytes).map_err(|error| {
            descriptor_invalid(format!("cannot read received manifest descriptor: {error}"))
        })?;
        if sha256_bytes(&bytes) != request.expected_manifest_sha256 {
            return Err(descriptor_invalid(
                "received manifest descriptor hash does not match launch authority",
            ));
        }
        use std::io::{Seek, SeekFrom};
        manifest.seek(SeekFrom::Start(0)).map_err(|error| {
            descriptor_invalid(format!(
                "cannot rewind received manifest descriptor: {error}"
            ))
        })?;
        Ok(AcquiredSnapshot { tree, manifest })
    }

    fn request<T: Serialize>(
        &self,
        request_id: &str,
        operation: &str,
        body: T,
    ) -> Result<(Value, Vec<File>)> {
        let mut stream = UnixStream::connect(Path::new(&self.socket_path)).map_err(|error| {
            FoundationError::new(
                PROCESS_SNAPSHOT_DESCRIPTOR_UNAVAILABLE,
                format!("cannot connect to trusted materializer socket: {error}"),
            )
        })?;
        stream
            .set_read_timeout(Some(IO_TIMEOUT))
            .map_err(unavailable)?;
        stream
            .set_write_timeout(Some(IO_TIMEOUT))
            .map_err(unavailable)?;
        if peer_uid(&stream)? != self.expected_uid {
            return Err(descriptor_invalid(
                "materializer socket peer UID does not match trusted configuration",
            ));
        }
        let request = RequestEnvelope {
            version: MATERIALIZER_PROTOCOL_VERSION,
            request_id: request_id.to_owned(),
            operation: operation.to_owned(),
            body,
        };
        let bytes = canonical_json_bytes(&request)?;
        if bytes.len() > MAX_MESSAGE_BYTES {
            return Err(descriptor_invalid(
                "materializer launcher request exceeds the protocol limit",
            ));
        }
        stream
            .write_all(&(bytes.len() as u32).to_be_bytes())
            .and_then(|_| stream.write_all(&bytes))
            .and_then(|_| stream.flush())
            .map_err(unavailable)?;
        let response = read_response(&mut stream)?;
        if response.version != MATERIALIZER_PROTOCOL_VERSION
            || response.request_id.as_deref() != Some(request_id)
        {
            return Err(descriptor_invalid(
                "materializer response correlation is invalid",
            ));
        }
        if !response.ok {
            let error = response
                .error
                .ok_or_else(|| descriptor_invalid("materializer error document is missing"))?;
            return Err(FoundationError::new(
                PROCESS_SNAPSHOT_DESCRIPTOR_UNAVAILABLE,
                format!(
                    "materializer refused descriptor handoff: {}: {}",
                    error.code, error.message
                ),
            ));
        }
        let result = response
            .result
            .ok_or_else(|| descriptor_invalid("materializer success result is missing"))?;
        let descriptors = if operation == "acquireSnapshot" {
            receive_descriptors(&stream)?
        } else {
            vec![]
        };
        Ok((result, descriptors))
    }
}

fn read_response(stream: &mut UnixStream) -> Result<ResponseEnvelope> {
    let mut header = [0_u8; 4];
    stream.read_exact(&mut header).map_err(unavailable)?;
    let length = u32::from_be_bytes(header) as usize;
    if length == 0 || length > MAX_MESSAGE_BYTES {
        return Err(descriptor_invalid(
            "materializer response frame length is invalid",
        ));
    }
    let mut bytes = vec![0; length];
    stream.read_exact(&mut bytes).map_err(unavailable)?;
    serde_json::from_slice(&bytes)
        .map_err(|error| descriptor_invalid(format!("materializer response is invalid: {error}")))
}

fn receive_descriptors(stream: &UnixStream) -> Result<Vec<File>> {
    let mut marker = [0_u8; 1];
    let mut iovec = libc::iovec {
        iov_base: marker.as_mut_ptr().cast(),
        iov_len: 1,
    };
    let control_length =
        unsafe { libc::CMSG_SPACE((2 * std::mem::size_of::<RawFd>()) as u32) as usize };
    let mut control = vec![0_u8; control_length];
    let mut message: libc::msghdr = unsafe { std::mem::zeroed() };
    message.msg_iov = &mut iovec;
    message.msg_iovlen = 1;
    message.msg_control = control.as_mut_ptr().cast();
    message.msg_controllen = control.len();
    let read = unsafe { libc::recvmsg(stream.as_raw_fd(), &mut message, libc::MSG_CMSG_CLOEXEC) };
    if read != 1 || marker[0] != b'D' || message.msg_flags & libc::MSG_CTRUNC != 0 {
        return Err(descriptor_invalid(
            "snapshot descriptor control message is invalid",
        ));
    }
    let header = unsafe { libc::CMSG_FIRSTHDR(&message) };
    if header.is_null()
        || unsafe { (*header).cmsg_level } != libc::SOL_SOCKET
        || unsafe { (*header).cmsg_type } != libc::SCM_RIGHTS
    {
        return Err(descriptor_invalid(
            "snapshot descriptor control message has no SCM_RIGHTS authority",
        ));
    }
    let payload =
        unsafe { (*header).cmsg_len }.saturating_sub(unsafe { libc::CMSG_LEN(0) } as usize);
    if payload != 2 * std::mem::size_of::<RawFd>() {
        return Err(descriptor_invalid(
            "snapshot descriptor control message must contain exactly two descriptors",
        ));
    }
    let values = unsafe { std::slice::from_raw_parts(libc::CMSG_DATA(header).cast::<RawFd>(), 2) };
    Ok(values
        .iter()
        .map(|descriptor| unsafe { File::from_raw_fd(*descriptor) })
        .collect())
}

fn peer_uid(stream: &UnixStream) -> Result<u32> {
    let mut credentials: libc::ucred = unsafe { std::mem::zeroed() };
    let mut length = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    if unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            (&mut credentials as *mut libc::ucred).cast(),
            &mut length,
        )
    } != 0
        || length as usize != std::mem::size_of::<libc::ucred>()
    {
        return Err(descriptor_invalid(
            "cannot authenticate the materializer socket peer",
        ));
    }
    Ok(credentials.uid)
}

fn descriptor_invalid(message: impl Into<String>) -> FoundationError {
    FoundationError::new(PROCESS_SNAPSHOT_DESCRIPTOR_INVALID, message)
}

fn unavailable(error: std::io::Error) -> FoundationError {
    FoundationError::new(
        PROCESS_SNAPSHOT_DESCRIPTOR_UNAVAILABLE,
        format!("materializer descriptor protocol is unavailable: {error}"),
    )
}
