use std::ffi::{CStr, CString};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, RawFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::contract::{
    FilesystemPolicy, MANIFEST_SCHEMA_VERSION, MAX_INPUT_FILES_HARD, MAX_MESSAGE_BYTES, Manifest,
    ManifestEntry, MaterializerError, PROCESS_INPUT_FILENAME_UNSUPPORTED,
    PROCESS_INPUT_LIMIT_EXCEEDED, PROCESS_INPUT_MANIFEST_INVALID, PROCESS_INPUT_PATH_INVALID,
    PROCESS_INPUT_SOURCE_CHANGED, PROCESS_INPUT_SPECIAL_FILE_REJECTED,
    PROCESS_INPUT_STORAGE_UNAVAILABLE, PROCESS_INPUT_SYMLINK_REJECTED, ProcessInputPolicy, Result,
    sha256_bytes, validate_relative_manifest_path,
};

const RESOLVE_NO_MAGICLINKS: u64 = 0x02;
const RESOLVE_NO_SYMLINKS: u64 = 0x04;
const RESOLVE_BENEATH: u64 = 0x08;
const DIRECTORY_MODE: u32 = 0o550;
const FILE_MODE: u32 = 0o440;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DirectoryIdentity {
    pub device: u64,
    pub inode: u64,
    pub owner_uid: u32,
    pub owner_gid: u32,
    pub mode: u32,
}

#[derive(Debug)]
pub struct PinnedDirectory {
    descriptor: File,
    identity: DirectoryIdentity,
}

impl PinnedDirectory {
    pub fn open_absolute(path: &Path) -> Result<Self> {
        let descriptor = open_absolute_directory(path)?;
        let stat = file_stat(descriptor.as_raw_fd())?;
        Ok(Self {
            descriptor,
            identity: DirectoryIdentity {
                device: stat.st_dev,
                inode: stat.st_ino,
                owner_uid: stat.st_uid,
                owner_gid: stat.st_gid,
                mode: stat.st_mode & 0o7777,
            },
        })
    }

    pub fn duplicate(&self) -> Result<File> {
        let current = CString::new(".").expect("current component contains no NUL");
        let descriptor = unsafe {
            libc::openat(
                self.descriptor.as_raw_fd(),
                current.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            )
        };
        if descriptor < 0 {
            return Err(storage(std::io::Error::last_os_error()));
        }
        Ok(unsafe { File::from_raw_fd(descriptor) })
    }

    pub fn identity(&self) -> DirectoryIdentity {
        self.identity
    }

    pub fn current_identity(&self) -> Result<DirectoryIdentity> {
        let stat = file_stat(self.descriptor.as_raw_fd())?;
        Ok(DirectoryIdentity {
            device: stat.st_dev,
            inode: stat.st_ino,
            owner_uid: stat.st_uid,
            owner_gid: stat.st_gid,
            mode: stat.st_mode & 0o7777,
        })
    }

    pub fn proc_path(&self) -> PathBuf {
        PathBuf::from(format!("/proc/self/fd/{}", self.descriptor.as_raw_fd()))
    }

    pub fn set_as_current_directory(&self) -> Result<()> {
        if unsafe { libc::fchdir(self.descriptor.as_raw_fd()) } != 0 {
            return Err(storage(std::io::Error::last_os_error()));
        }
        Ok(())
    }

    pub(crate) fn raw_fd(&self) -> RawFd {
        self.descriptor.as_raw_fd()
    }
}

pub fn same_physical_directory(left: &PinnedDirectory, right: &PinnedDirectory) -> bool {
    left.identity.device == right.identity.device && left.identity.inode == right.identity.inode
}

pub fn physical_directories_overlap(
    left: &PinnedDirectory,
    right: &PinnedDirectory,
) -> Result<bool> {
    Ok(directory_contains(left, right)? || directory_contains(right, left)?)
}

fn directory_contains(ancestor: &PinnedDirectory, descendant: &PinnedDirectory) -> Result<bool> {
    let mut current = descendant.duplicate()?;
    loop {
        if fd_identity(current.as_raw_fd())? == (ancestor.identity.device, ancestor.identity.inode)
        {
            return Ok(true);
        }
        let parent_name = CString::new("..").expect("parent component contains no NUL");
        let parent_fd = unsafe {
            libc::openat(
                current.as_raw_fd(),
                parent_name.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            )
        };
        if parent_fd < 0 {
            return Err(storage(std::io::Error::last_os_error()));
        }
        let parent = unsafe { File::from_raw_fd(parent_fd) };
        if fd_identity(parent.as_raw_fd())? == fd_identity(current.as_raw_fd())? {
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

#[derive(Debug, Clone, PartialEq, Eq)]
enum SourceKind {
    Directory,
    RegularFile,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SourceEvidence {
    path: String,
    kind: SourceKind,
    device: u64,
    inode: u64,
    size: u64,
    sha256: Option<String>,
}

#[derive(Debug)]
pub struct MaterializedTree {
    pub manifest_bytes: Vec<u8>,
    pub manifest_sha256: String,
    pub file_count: u64,
    pub total_bytes: u64,
    source_root_identity: (u64, u64),
    source_evidence: Vec<SourceEvidence>,
    manifest: Manifest,
}

struct ScanState<'a> {
    policy: &'a ProcessInputPolicy,
    limits: &'a FilesystemPolicy,
    output_root: Option<&'a Path>,
    entries: Vec<ManifestEntry>,
    evidence: Vec<SourceEvidence>,
    file_count: u64,
    total_bytes: u64,
    visited_entries: u64,
}

#[cfg(test)]
pub fn materialize_source_tree(
    source_root: &Path,
    staging_tree: &Path,
    policy: &ProcessInputPolicy,
    limits: &FilesystemPolicy,
) -> Result<MaterializedTree> {
    let root = open_absolute_directory(source_root)?;
    materialize_source_tree_from_descriptor(&root, staging_tree, policy, limits)
}

pub fn materialize_source_tree_from_descriptor(
    source_root: &File,
    staging_tree: &Path,
    policy: &ProcessInputPolicy,
    limits: &FilesystemPolicy,
) -> Result<MaterializedTree> {
    let root = source_root.try_clone().map_err(storage)?;
    fs::create_dir(staging_tree).map_err(|error| {
        MaterializerError::new(
            PROCESS_INPUT_STORAGE_UNAVAILABLE,
            format!("cannot create private staging tree: {error}"),
        )
    })?;
    fs::set_permissions(staging_tree, fs::Permissions::from_mode(0o700)).map_err(storage)?;

    let source_root_identity = fd_identity(root.as_raw_fd())?;
    let first = scan(&root, Some(staging_tree), policy, limits)?;

    normalize_tree_permissions(staging_tree)?;
    let manifest = Manifest {
        version: MANIFEST_SCHEMA_VERSION,
        entries: first.entries,
    };
    validate_manifest(&manifest)?;
    let manifest_bytes = crate::contract::canonical_struct_json(&manifest)?;
    if manifest_bytes.len() > MAX_MESSAGE_BYTES {
        return Err(MaterializerError::new(
            PROCESS_INPUT_LIMIT_EXCEEDED,
            "canonical process-input manifest exceeds the hard byte ceiling",
        ));
    }
    let manifest_sha256 = sha256_bytes(&manifest_bytes);
    Ok(MaterializedTree {
        manifest_bytes,
        manifest_sha256,
        file_count: first.file_count,
        total_bytes: first.total_bytes,
        source_root_identity,
        source_evidence: first.evidence,
        manifest,
    })
}

pub fn revalidate_materialized_source_from_descriptor(
    source_root: &File,
    policy: &ProcessInputPolicy,
    limits: &FilesystemPolicy,
    materialized: &MaterializedTree,
) -> Result<()> {
    let rescan_root = source_root.try_clone().map_err(storage)?;
    if fd_identity(rescan_root.as_raw_fd())? != materialized.source_root_identity {
        return Err(MaterializerError::new(
            PROCESS_INPUT_SOURCE_CHANGED,
            "workspace root was replaced during materialization",
        ));
    }
    let rescan = scan(&rescan_root, None, policy, limits)?;
    if rescan.evidence != materialized.source_evidence {
        return Err(MaterializerError::new(
            PROCESS_INPUT_SOURCE_CHANGED,
            "workspace file identity or content changed while execution input was materialized",
        ));
    }
    if rescan.entries != materialized.manifest.entries
        || rescan.file_count != materialized.file_count
        || rescan.total_bytes != materialized.total_bytes
    {
        return Err(MaterializerError::new(
            PROCESS_INPUT_SOURCE_CHANGED,
            "workspace manifest changed while execution input was materialized",
        ));
    }
    Ok(())
}

pub fn verify_sealed_tree(
    tree_root: &Path,
    expected_manifest: &Manifest,
    file_count: u64,
    total_bytes: u64,
) -> Result<()> {
    validate_manifest(expected_manifest)?;
    let no_exclusions = ProcessInputPolicy {
        version: 1,
        excluded_basenames: vec![],
        excluded_basename_prefixes: vec![],
        excluded_path_prefixes: vec![],
        excluded_suffixes: vec![],
    };
    let limits = FilesystemPolicy {
        input_mode: "materialized_read_only".into(),
        writable_roots: vec![],
        allow_symlinks: false,
        allow_special_files: false,
        max_input_files: file_count.max(1),
        max_input_bytes: total_bytes.max(1),
    };
    let root = open_internal_directory(tree_root)?;
    let scan = scan(&root, None, &no_exclusions, &limits)?;
    if scan.entries != expected_manifest.entries
        || scan.file_count != file_count
        || scan.total_bytes != total_bytes
    {
        return Err(MaterializerError::new(
            PROCESS_INPUT_MANIFEST_INVALID,
            "sealed tree does not match its canonical manifest",
        ));
    }
    Ok(())
}

pub fn write_and_sync_file(path: &Path, bytes: &[u8], mode: u32) -> Result<()> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .map_err(storage)?;
    file.write_all(bytes).map_err(storage)?;
    file.sync_all().map_err(storage)?;
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).map_err(storage)?;
    Ok(())
}

pub fn sync_directory(path: &Path) -> Result<()> {
    let directory = File::open(path).map_err(storage)?;
    directory.sync_all().map_err(storage)
}

pub fn validate_manifest(manifest: &Manifest) -> Result<()> {
    if manifest.version != MANIFEST_SCHEMA_VERSION {
        return Err(MaterializerError::new(
            PROCESS_INPUT_MANIFEST_INVALID,
            "manifest version is unsupported",
        ));
    }
    let mut previous: Option<&str> = None;
    for entry in &manifest.entries {
        validate_relative_manifest_path(entry.path()).map_err(|error| {
            MaterializerError::new(PROCESS_INPUT_MANIFEST_INVALID, error.message)
        })?;
        if let Some(prior) = previous
            && prior.as_bytes() >= entry.path().as_bytes()
        {
            return Err(MaterializerError::new(
                PROCESS_INPUT_MANIFEST_INVALID,
                "manifest paths must be unique and bytewise ordered",
            ));
        }
        match entry {
            ManifestEntry::Directory { mode, .. } if mode == "0550" => {}
            ManifestEntry::RegularFile { sha256, mode, .. }
                if mode == "0440"
                    && sha256.len() == 64
                    && sha256
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)) => {}
            _ => {
                return Err(MaterializerError::new(
                    PROCESS_INPUT_MANIFEST_INVALID,
                    "manifest entry has invalid normalized mode or hash",
                ));
            }
        }
        previous = Some(entry.path());
    }
    Ok(())
}

fn scan<'a>(
    root: &File,
    output_root: Option<&'a Path>,
    policy: &'a ProcessInputPolicy,
    limits: &'a FilesystemPolicy,
) -> Result<ScanState<'a>> {
    let mut state = ScanState {
        policy,
        limits,
        output_root,
        entries: vec![],
        evidence: vec![],
        file_count: 0,
        total_bytes: 0,
        visited_entries: 0,
    };
    scan_directory(root.as_raw_fd(), "", 0, &mut state)?;
    state
        .entries
        .sort_by(|left, right| left.path().as_bytes().cmp(right.path().as_bytes()));
    state
        .evidence
        .sort_by(|left, right| left.path.as_bytes().cmp(right.path.as_bytes()));
    Ok(state)
}

fn scan_directory(
    directory_fd: RawFd,
    parent: &str,
    depth: usize,
    state: &mut ScanState<'_>,
) -> Result<()> {
    if depth > crate::contract::MAX_DIRECTORY_DEPTH {
        return Err(MaterializerError::new(
            PROCESS_INPUT_PATH_INVALID,
            "process-input directory depth exceeds the hard maximum",
        ));
    }
    let mut names = read_directory_names(directory_fd)?;
    names.sort();
    for raw_name in names {
        state.visited_entries = state.visited_entries.checked_add(1).ok_or_else(|| {
            MaterializerError::new(PROCESS_INPUT_LIMIT_EXCEEDED, "source entry count overflow")
        })?;
        if state.visited_entries > MAX_INPUT_FILES_HARD {
            return Err(MaterializerError::new(
                PROCESS_INPUT_LIMIT_EXCEEDED,
                "workspace traversal exceeds the process-input hard entry ceiling",
            ));
        }
        let name = validate_filename(&raw_name)?;
        let relative = if parent.is_empty() {
            name.to_owned()
        } else {
            format!("{parent}/{name}")
        };
        validate_relative_manifest_path(&relative)?;
        if state.policy.excludes(&relative, name) {
            continue;
        }
        let metadata = stat_at(directory_fd, &raw_name)?;
        let file_type = metadata.st_mode & libc::S_IFMT;
        if file_type == libc::S_IFLNK {
            return Err(MaterializerError::new(
                PROCESS_INPUT_SYMLINK_REJECTED,
                format!("symbolic link is not valid process input: {relative}"),
            ));
        }
        if file_type == libc::S_IFDIR {
            increment_materialized_entry_count(state)?;
            let child = open_relative(directory_fd, &raw_name, true)?;
            let identity = fd_identity(child.as_raw_fd())?;
            if let Some(output_root) = state.output_root {
                let output = output_root.join(&relative);
                fs::create_dir(&output).map_err(storage)?;
                fs::set_permissions(&output, fs::Permissions::from_mode(0o700)).map_err(storage)?;
            }
            state.entries.push(ManifestEntry::Directory {
                path: relative.clone(),
                mode: "0550".into(),
            });
            state.evidence.push(SourceEvidence {
                path: relative.clone(),
                kind: SourceKind::Directory,
                device: identity.0,
                inode: identity.1,
                size: 0,
                sha256: None,
            });
            scan_directory(child.as_raw_fd(), &relative, depth + 1, state)?;
            continue;
        }
        if file_type != libc::S_IFREG {
            return Err(MaterializerError::new(
                PROCESS_INPUT_SPECIAL_FILE_REJECTED,
                format!("special filesystem object is not valid process input: {relative}"),
            ));
        }

        increment_materialized_entry_count(state)?;
        let source = open_relative(directory_fd, &raw_name, false)?;
        let before = file_stat(source.as_raw_fd())?;
        let expected_size = before.st_size.try_into().map_err(|_| {
            MaterializerError::new(
                PROCESS_INPUT_SPECIAL_FILE_REJECTED,
                format!("regular file has a negative size: {relative}"),
            )
        })?;
        state.total_bytes = state
            .total_bytes
            .checked_add(expected_size)
            .ok_or_else(|| {
                MaterializerError::new(PROCESS_INPUT_LIMIT_EXCEEDED, "byte total overflow")
            })?;
        if state.total_bytes > state.limits.max_input_bytes {
            return Err(MaterializerError::new(
                PROCESS_INPUT_LIMIT_EXCEEDED,
                "process-input bytes exceed the selected profile limit",
            ));
        }
        let (actual_size, hash) = copy_and_hash(
            source,
            state.output_root.map(|root| root.join(&relative)),
            state.limits.max_input_bytes,
        )?;
        let after = file_stat_from_path_fd(directory_fd, &raw_name)?;
        if before.st_dev != after.st_dev
            || before.st_ino != after.st_ino
            || before.st_mode & libc::S_IFMT != libc::S_IFREG
            || after.st_mode & libc::S_IFMT != libc::S_IFREG
            || expected_size != actual_size
            || after.st_size != before.st_size
        {
            return Err(MaterializerError::new(
                PROCESS_INPUT_SOURCE_CHANGED,
                format!("file changed while it was copied: {relative}"),
            ));
        }
        state.entries.push(ManifestEntry::RegularFile {
            path: relative.clone(),
            size: actual_size,
            sha256: hash.clone(),
            mode: "0440".into(),
        });
        state.evidence.push(SourceEvidence {
            path: relative,
            kind: SourceKind::RegularFile,
            device: before.st_dev,
            inode: before.st_ino,
            size: actual_size,
            sha256: Some(hash),
        });
    }
    Ok(())
}

fn increment_materialized_entry_count(state: &mut ScanState<'_>) -> Result<()> {
    state.file_count = state.file_count.checked_add(1).ok_or_else(|| {
        MaterializerError::new(PROCESS_INPUT_LIMIT_EXCEEDED, "input entry count overflow")
    })?;
    if state.file_count > state.limits.max_input_files {
        return Err(MaterializerError::new(
            PROCESS_INPUT_LIMIT_EXCEEDED,
            "process-input entry count exceeds the selected profile limit",
        ));
    }
    Ok(())
}

fn copy_and_hash(
    source: File,
    output: Option<PathBuf>,
    hard_byte_limit: u64,
) -> Result<(u64, String)> {
    let mut source = source;
    let mut output_file = match output {
        Some(path) => Some(
            OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(path)
                .map_err(storage)?,
        ),
        None => None,
    };
    let mut hasher = Sha256::new();
    let mut bytes = 0_u64;
    let mut buffer = [0_u8; 65_536];
    loop {
        let read = source.read(&mut buffer).map_err(|error| {
            MaterializerError::new(
                PROCESS_INPUT_SOURCE_CHANGED,
                format!("cannot read source file consistently: {error}"),
            )
        })?;
        if read == 0 {
            break;
        }
        bytes = bytes.checked_add(read as u64).ok_or_else(|| {
            MaterializerError::new(PROCESS_INPUT_LIMIT_EXCEEDED, "file byte count overflow")
        })?;
        if bytes > hard_byte_limit {
            return Err(MaterializerError::new(
                PROCESS_INPUT_LIMIT_EXCEEDED,
                "one source file exceeds the selected aggregate byte limit",
            ));
        }
        hasher.update(&buffer[..read]);
        if let Some(file) = output_file.as_mut() {
            file.write_all(&buffer[..read]).map_err(storage)?;
        }
    }
    if let Some(file) = output_file {
        file.sync_all().map_err(storage)?;
        if unsafe { libc::fchmod(file.as_raw_fd(), FILE_MODE) } != 0 {
            return Err(storage(std::io::Error::last_os_error()));
        }
    }
    Ok((bytes, format!("{:x}", hasher.finalize())))
}

fn normalize_tree_permissions(root: &Path) -> Result<()> {
    let mut directories = vec![];
    collect_directories(root, &mut directories)?;
    directories.sort_by_key(|path| std::cmp::Reverse(path.components().count()));
    for directory in directories {
        fs::set_permissions(&directory, fs::Permissions::from_mode(DIRECTORY_MODE))
            .map_err(storage)?;
        sync_directory(&directory)?;
    }
    Ok(())
}

fn collect_directories(root: &Path, output: &mut Vec<PathBuf>) -> Result<()> {
    output.push(root.to_path_buf());
    for entry in fs::read_dir(root).map_err(storage)? {
        let entry = entry.map_err(storage)?;
        let metadata = entry.file_type().map_err(storage)?;
        if metadata.is_dir() {
            collect_directories(&entry.path(), output)?;
        }
    }
    Ok(())
}

fn validate_filename(raw: &[u8]) -> Result<&str> {
    if raw.is_empty()
        || raw.len() > crate::contract::MAX_COMPONENT_BYTES
        || raw.iter().any(|byte| *byte == 0 || byte.is_ascii_control())
    {
        return Err(MaterializerError::new(
            PROCESS_INPUT_PATH_INVALID,
            "filename is empty, contains controls, or exceeds the component limit",
        ));
    }
    let name = std::str::from_utf8(raw).map_err(|_| {
        MaterializerError::new(
            PROCESS_INPUT_FILENAME_UNSUPPORTED,
            "process input initially supports only exact UTF-8 filenames",
        )
    })?;
    if name == "." || name == ".." || name.contains('/') {
        return Err(MaterializerError::new(
            PROCESS_INPUT_PATH_INVALID,
            "filename is not a normalized path component",
        ));
    }
    Ok(name)
}

fn open_absolute_directory(path: &Path) -> Result<File> {
    if !path.is_absolute() {
        return Err(MaterializerError::new(
            PROCESS_INPUT_PATH_INVALID,
            "trusted directory path must be absolute",
        ));
    }
    let root_path = CString::new("/").expect("root path contains no NUL");
    let root_fd = unsafe {
        libc::open(
            root_path.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
        )
    };
    if root_fd < 0 {
        return Err(storage(std::io::Error::last_os_error()));
    }
    let root = unsafe { File::from_raw_fd(root_fd) };
    if path == Path::new("/") {
        return root.try_clone().map_err(storage);
    }
    let relative = path.strip_prefix("/").map_err(|_| {
        MaterializerError::new(PROCESS_INPUT_PATH_INVALID, "trusted path is not absolute")
    })?;
    let name = CString::new(relative.as_os_str().as_bytes()).map_err(|_| {
        MaterializerError::new(PROCESS_INPUT_PATH_INVALID, "trusted path contains NUL")
    })?;
    let how = OpenHow {
        flags: (libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW) as u64,
        mode: 0,
        resolve: RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS,
    };
    let descriptor = unsafe {
        libc::syscall(
            libc::SYS_openat2,
            root.as_raw_fd(),
            name.as_ptr(),
            &how,
            std::mem::size_of::<OpenHow>(),
        ) as i32
    };
    if descriptor < 0 {
        let error = std::io::Error::last_os_error();
        let code = if matches!(error.raw_os_error(), Some(libc::ELOOP) | Some(libc::EXDEV)) {
            PROCESS_INPUT_SYMLINK_REJECTED
        } else {
            PROCESS_INPUT_PATH_INVALID
        };
        return Err(MaterializerError::new(
            code,
            format!("trusted directory cannot be opened without symlinks: {error}"),
        ));
    }
    Ok(unsafe { File::from_raw_fd(descriptor) })
}

fn open_internal_directory(path: &Path) -> Result<File> {
    let c_path = CString::new(path.as_os_str().as_bytes()).map_err(|_| {
        MaterializerError::new(PROCESS_INPUT_PATH_INVALID, "internal path contains NUL")
    })?;
    let descriptor = unsafe {
        libc::open(
            c_path.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
        )
    };
    if descriptor < 0 {
        return Err(storage(std::io::Error::last_os_error()));
    }
    Ok(unsafe { File::from_raw_fd(descriptor) })
}

fn open_relative(directory_fd: RawFd, raw_name: &[u8], directory: bool) -> Result<File> {
    let name = CString::new(raw_name).map_err(|_| {
        MaterializerError::new(PROCESS_INPUT_PATH_INVALID, "path component contains NUL")
    })?;
    let flags = libc::O_RDONLY
        | libc::O_CLOEXEC
        | libc::O_NOFOLLOW
        | if directory { libc::O_DIRECTORY } else { 0 };
    let how = OpenHow {
        flags: flags as u64,
        mode: 0,
        resolve: RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS,
    };
    let descriptor = unsafe {
        libc::syscall(
            libc::SYS_openat2,
            directory_fd,
            name.as_ptr(),
            &how,
            std::mem::size_of::<OpenHow>(),
        ) as i32
    };
    if descriptor < 0 {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ELOOP) {
            return Err(MaterializerError::new(
                PROCESS_INPUT_SYMLINK_REJECTED,
                "openat2 rejected a symbolic or magic link",
            ));
        }
        if error.raw_os_error() == Some(libc::ENOSYS) {
            return Err(MaterializerError::new(
                PROCESS_INPUT_PATH_INVALID,
                "openat2 is unavailable; descriptor-relative containment cannot be enforced",
            ));
        }
        return Err(MaterializerError::new(
            PROCESS_INPUT_SOURCE_CHANGED,
            format!("descriptor-relative source open failed: {error}"),
        ));
    }
    Ok(unsafe { File::from_raw_fd(descriptor) })
}

fn read_directory_names(directory_fd: RawFd) -> Result<Vec<Vec<u8>>> {
    let duplicate = unsafe { libc::dup(directory_fd) };
    if duplicate < 0 {
        return Err(storage(std::io::Error::last_os_error()));
    }
    let directory = unsafe { libc::fdopendir(duplicate) };
    if directory.is_null() {
        unsafe {
            libc::close(duplicate);
        }
        return Err(storage(std::io::Error::last_os_error()));
    }
    let mut names = vec![];
    loop {
        unsafe {
            *libc::__errno_location() = 0;
        }
        let entry = unsafe { libc::readdir(directory) };
        if entry.is_null() {
            let errno = unsafe { *libc::__errno_location() };
            unsafe {
                libc::closedir(directory);
            }
            if errno != 0 {
                return Err(storage(std::io::Error::from_raw_os_error(errno)));
            }
            break;
        }
        let bytes = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) }.to_bytes();
        if bytes != b"." && bytes != b".." {
            names.push(bytes.to_vec());
            if names.len() > MAX_INPUT_FILES_HARD as usize {
                unsafe {
                    libc::closedir(directory);
                }
                return Err(MaterializerError::new(
                    PROCESS_INPUT_LIMIT_EXCEEDED,
                    "one source directory exceeds the hard entry ceiling",
                ));
            }
        }
    }
    Ok(names)
}

fn stat_at(directory_fd: RawFd, raw_name: &[u8]) -> Result<libc::stat> {
    let name = CString::new(raw_name).map_err(|_| {
        MaterializerError::new(PROCESS_INPUT_PATH_INVALID, "path component contains NUL")
    })?;
    let mut stat: libc::stat = unsafe { std::mem::zeroed() };
    let status = unsafe {
        libc::fstatat(
            directory_fd,
            name.as_ptr(),
            &mut stat,
            libc::AT_SYMLINK_NOFOLLOW,
        )
    };
    if status != 0 {
        return Err(MaterializerError::new(
            PROCESS_INPUT_SOURCE_CHANGED,
            format!(
                "source entry changed during traversal: {}",
                std::io::Error::last_os_error()
            ),
        ));
    }
    Ok(stat)
}

fn file_stat_from_path_fd(directory_fd: RawFd, raw_name: &[u8]) -> Result<libc::stat> {
    stat_at(directory_fd, raw_name)
}

fn file_stat(fd: RawFd) -> Result<libc::stat> {
    let mut stat: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstat(fd, &mut stat) } != 0 {
        return Err(storage(std::io::Error::last_os_error()));
    }
    Ok(stat)
}

fn fd_identity(fd: RawFd) -> Result<(u64, u64)> {
    let stat = file_stat(fd)?;
    Ok((stat.st_dev, stat.st_ino))
}

fn storage(error: std::io::Error) -> MaterializerError {
    MaterializerError::new(PROCESS_INPUT_STORAGE_UNAVAILABLE, error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;
    use std::os::unix::ffi::OsStringExt;
    use std::os::unix::fs::MetadataExt;
    use std::os::unix::fs::symlink;

    fn temp_root(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "ticket-materializer-{label}-{}-{}",
            std::process::id(),
            crate::service::secure_random_hex(8).unwrap()
        ));
        fs::create_dir(&root).unwrap();
        root
    }

    fn policy() -> ProcessInputPolicy {
        ProcessInputPolicy {
            version: 1,
            excluded_basenames: vec![".git".into(), ".env".into(), "node_modules".into()],
            excluded_basename_prefixes: vec![".env.".into()],
            excluded_path_prefixes: vec![],
            excluded_suffixes: vec![".swp".into()],
        }
    }

    fn limits(files: u64, bytes: u64) -> FilesystemPolicy {
        FilesystemPolicy {
            input_mode: "materialized_read_only".into(),
            writable_roots: vec![],
            allow_symlinks: false,
            allow_special_files: false,
            max_input_files: files,
            max_input_bytes: bytes,
        }
    }

    fn remove_test_tree(root: &Path) {
        fn make_writable(path: &Path) {
            if let Ok(metadata) = fs::symlink_metadata(path)
                && metadata.is_dir()
            {
                let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o700));
                if let Ok(entries) = fs::read_dir(path) {
                    for entry in entries.flatten() {
                        make_writable(&entry.path());
                    }
                }
            }
        }
        make_writable(root);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn copies_regular_files_deterministically_and_normalizes_modes() {
        let root = temp_root("copy");
        let source = root.join("source");
        let staging = root.join("staging");
        fs::create_dir(&source).unwrap();
        fs::create_dir(source.join("z")).unwrap();
        fs::write(source.join("z/b.txt"), b"bravo").unwrap();
        fs::write(source.join("a.txt"), b"alpha").unwrap();
        fs::set_permissions(source.join("a.txt"), fs::Permissions::from_mode(0o6777)).unwrap();
        fs::create_dir(source.join(".git")).unwrap();
        fs::write(source.join(".git/config"), b"excluded").unwrap();
        fs::write(source.join("package.json"), b"{}").unwrap();
        let output =
            materialize_source_tree(&source, &staging, &policy(), &limits(10, 1024)).unwrap();
        assert_eq!(output.file_count, 4);
        assert_eq!(output.total_bytes, 12);
        let output_manifest: Manifest = serde_json::from_slice(&output.manifest_bytes).unwrap();
        assert_eq!(
            output_manifest
                .entries
                .iter()
                .map(ManifestEntry::path)
                .collect::<Vec<_>>(),
            vec!["a.txt", "package.json", "z", "z/b.txt"]
        );
        assert!(!staging.join(".git").exists());
        assert_eq!(
            fs::metadata(staging.join("a.txt")).unwrap().mode() & 0o7777,
            FILE_MODE
        );
        assert_eq!(fs::metadata(staging.join("a.txt")).unwrap().uid(), unsafe {
            libc::geteuid()
        });
        remove_test_tree(&root);
    }

    #[test]
    fn rejects_symlinks_and_special_files() {
        let root = temp_root("unsafe");
        let source = root.join("source");
        let outside = root.join("outside");
        fs::create_dir(&source).unwrap();
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("secret"), b"secret").unwrap();
        symlink("/etc/passwd", source.join("escape")).unwrap();
        let error = materialize_source_tree(
            &source,
            &root.join("stage-one"),
            &policy(),
            &limits(10, 1024),
        )
        .unwrap_err();
        assert_eq!(error.code, PROCESS_INPUT_SYMLINK_REJECTED);
        fs::remove_file(source.join("escape")).unwrap();

        symlink(&outside, source.join("directory-substitution")).unwrap();
        let error = materialize_source_tree(
            &source,
            &root.join("stage-directory"),
            &policy(),
            &limits(10, 1024),
        )
        .unwrap_err();
        assert_eq!(error.code, PROCESS_INPUT_SYMLINK_REJECTED);
        fs::remove_file(source.join("directory-substitution")).unwrap();

        symlink("/proc/self/fd", source.join("magic-link")).unwrap();
        let error = materialize_source_tree(
            &source,
            &root.join("stage-magic"),
            &policy(),
            &limits(10, 1024),
        )
        .unwrap_err();
        assert_eq!(error.code, PROCESS_INPUT_SYMLINK_REJECTED);
        fs::remove_file(source.join("magic-link")).unwrap();

        let fifo = CString::new(source.join("pipe").as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
        let error = materialize_source_tree(
            &source,
            &root.join("stage-two"),
            &policy(),
            &limits(10, 1024),
        )
        .unwrap_err();
        assert_eq!(error.code, PROCESS_INPUT_SPECIAL_FILE_REJECTED);
        remove_test_tree(&root);
    }

    #[test]
    fn exact_limits_are_accepted_and_plus_one_is_rejected() {
        let root = temp_root("limits");
        let source = root.join("source");
        fs::create_dir(&source).unwrap();
        fs::write(source.join("a"), b"1234").unwrap();
        materialize_source_tree(&source, &root.join("accepted"), &policy(), &limits(1, 4)).unwrap();
        fs::write(source.join("b"), b"x").unwrap();
        assert_eq!(
            materialize_source_tree(&source, &root.join("too-many"), &policy(), &limits(1, 5),)
                .unwrap_err()
                .code,
            PROCESS_INPUT_LIMIT_EXCEEDED
        );
        fs::remove_file(source.join("b")).unwrap();
        assert_eq!(
            materialize_source_tree(&source, &root.join("too-large"), &policy(), &limits(1, 3),)
                .unwrap_err()
                .code,
            PROCESS_INPUT_LIMIT_EXCEEDED
        );
        remove_test_tree(&root);
    }

    #[test]
    fn rejects_non_utf8_and_control_character_filenames() {
        let root = temp_root("filenames");
        let source = root.join("source");
        fs::create_dir(&source).unwrap();
        fs::write(
            source.join(OsString::from_vec(vec![b'b', b'a', b'd', 0xff])),
            b"x",
        )
        .unwrap();
        assert_eq!(
            materialize_source_tree(
                &source,
                &root.join("non-utf8"),
                &policy(),
                &limits(10, 1024),
            )
            .unwrap_err()
            .code,
            PROCESS_INPUT_FILENAME_UNSUPPORTED
        );
        fs::remove_file(source.join(OsString::from_vec(vec![b'b', b'a', b'd', 0xff]))).unwrap();
        fs::write(source.join("bad\nname"), b"x").unwrap();
        assert_eq!(
            materialize_source_tree(&source, &root.join("control"), &policy(), &limits(10, 1024),)
                .unwrap_err()
                .code,
            PROCESS_INPUT_PATH_INVALID
        );
        remove_test_tree(&root);
    }

    #[test]
    fn manifest_validator_rejects_duplicate_or_non_bytewise_paths() {
        let duplicate = Manifest {
            version: 1,
            entries: vec![
                ManifestEntry::Directory {
                    path: "a".into(),
                    mode: "0550".into(),
                },
                ManifestEntry::RegularFile {
                    path: "a".into(),
                    size: 0,
                    sha256: sha256_bytes(b""),
                    mode: "0440".into(),
                },
            ],
        };
        assert_eq!(
            validate_manifest(&duplicate).unwrap_err().code,
            PROCESS_INPUT_MANIFEST_INVALID
        );
        let unordered = Manifest {
            version: 1,
            entries: vec![
                ManifestEntry::Directory {
                    path: "z".into(),
                    mode: "0550".into(),
                },
                ManifestEntry::Directory {
                    path: "a".into(),
                    mode: "0550".into(),
                },
            ],
        };
        assert_eq!(
            validate_manifest(&unordered).unwrap_err().code,
            PROCESS_INPUT_MANIFEST_INVALID
        );
    }
}
