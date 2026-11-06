//! Local-only, immutable recovery snapshots. No renderer-supplied filesystem paths.
use super::{ensure_main, safe_files, INPUT_LIMIT};
#[cfg(windows)]
use super::{
    folder_export::directory_sentinel,
    folder_import::{locked_open, locked_output_directory, LockedEntry, OpenFailure},
    media::local_path,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet, VecDeque},
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager, WebviewWindow};

const SOFT_LIMIT: u64 = 8 * 1024 * 1024;
const SNAPSHOT_LIMIT: u64 = 16 * 1024 * 1024;
const TOTAL_LIMIT: u64 = 64 * 1024 * 1024;
const DRAFT_LIMIT: usize = 20;
const ENTRY_LIMIT: usize = 256;
const JS_MAX: u64 = (1 << 53) - 1;
const MAGIC: &[u8; 8] = b"SRTDRFT1";
const HEADER_LEN: usize = 48;
static TRANSACTION: Mutex<()> = Mutex::new(());

fn now_ms() -> u64 {
    millis(SystemTime::now()).unwrap_or_default()
}

fn millis(time: SystemTime) -> Option<u64> {
    time.duration_since(UNIX_EPOCH)
        .ok()?
        .as_millis()
        .try_into()
        .ok()
}

fn id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

fn valid_id(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn io_message(error: io::Error) -> String {
    // OS errors carry a code and message, with no input path or subtitle content.
    format!("草稿文件操作失败。请检查本地空间、访问权限或文件占用（{error}）。")
}

fn invalid_data() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "草稿内容校验失败")
}

#[derive(Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct SourceFingerprint {
    path: String,
    bytes: u64,
    sha256: String,
    mtime_ms: Option<u64>,
}

impl SourceFingerprint {
    pub(super) fn from_import(path: &str, bytes: &[u8]) -> Self {
        Self {
            path: path.to_owned(),
            bytes: bytes.len() as u64,
            sha256: format!("{:x}", Sha256::digest(bytes)),
            mtime_ms: fs::metadata(path)
                .and_then(|metadata| metadata.modified())
                .ok()
                .and_then(millis),
        }
    }

    fn valid(&self) -> bool {
        self.path.len() <= 131_072
            && is_srt(Path::new(&self.path))
            && self.bytes <= INPUT_LIMIT
            && self.sha256.len() == 64
            && self.sha256.bytes().all(|b| b.is_ascii_hexdigit())
            && self.mtime_ms.is_none_or(|ms| ms <= JS_MAX)
    }
}

#[derive(Default)]
pub(crate) struct DraftSources(Mutex<VecDeque<(String, SourceFingerprint)>>);

impl DraftSources {
    pub(super) fn remember(&self, fingerprint: SourceFingerprint) -> Result<String, String> {
        let mut sources = self.0.lock().map_err(|_| "字幕来源记录暂不可用。")?;
        if let Some(index) = sources
            .iter()
            .position(|(_, source)| source == &fingerprint)
        {
            let record = sources.remove(index).expect("matching source index");
            let token = record.0.clone();
            sources.push_back(record);
            return Ok(token);
        }
        let token = id();
        if sources.len() >= 40 {
            sources.pop_front();
        }
        sources.push_back((token.clone(), fingerprint));
        Ok(token)
    }

    fn get(&self, token: &str) -> Result<SourceFingerprint, String> {
        let sources = self.0.lock().map_err(|_| "字幕来源记录暂不可用。")?;
        sources
            .iter()
            .find(|(key, _)| key == token)
            .map(|(_, source)| source.clone())
            .ok_or_else(|| "当前字幕来源已失效。请重新打开字幕或另存为。".into())
    }
}

#[derive(Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Cue {
    id: String,
    index: i64,
    start_ms: u64,
    end_ms: u64,
    text: String,
}

fn valid_cues(cues: &[Cue]) -> bool {
    let mut ids = HashSet::with_capacity(cues.len());
    cues.len() <= 100_000
        && cues.iter().all(|cue| {
            !cue.id.is_empty()
                && cue.id.len() <= 128
                && !cue.id.chars().any(char::is_control)
                && ids.insert(cue.id.as_str())
                && cue.index.unsigned_abs() <= JS_MAX
                && cue.start_ms <= JS_MAX
                && cue.end_ms <= JS_MAX
                && cue.text.len() as u64 <= SNAPSHOT_LIMIT
        })
    // Keep representable, invalid durations for repair; the shared validator still blocks export.
}

fn is_srt(path: &Path) -> bool {
    path.extension()
        .and_then(|part| part.to_str())
        .is_some_and(|part| part.eq_ignore_ascii_case("srt"))
}

#[derive(Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Draft {
    schema_version: u32,
    draft_id: String,
    revision: u64,
    file_name: String,
    format: String,
    encoding: String,
    line_ending: String,
    original: Vec<Cue>,
    cues: Vec<Cue>,
}

impl Draft {
    fn valid(&self) -> bool {
        self.schema_version == 1
            && valid_id(&self.draft_id)
            && (1..=JS_MAX).contains(&self.revision)
            && !self.file_name.is_empty()
            && self.file_name.encode_utf16().count() <= 255
            && !self
                .file_name
                .chars()
                .any(|c| c.is_control() || "<>:\"/\\|?*".contains(c))
            && is_srt(Path::new(&self.file_name))
            && self.format == "srt"
            && matches!(
                self.encoding.as_str(),
                "UTF-8" | "UTF-8 BOM" | "UTF-16 LE" | "UTF-16 BE" | "GBK" | "GB18030"
            )
            && matches!(self.line_ending.as_str(), "CRLF" | "LF" | "CR")
            && valid_cues(&self.original)
            && valid_cues(&self.cues)
    }
}

fn base_hash(draft: &Draft) -> String {
    let mut hash = Sha256::new();
    // The original cue digest is stable across revisions and independent of current edits.
    serde_json::to_writer(&mut hash, &draft.original).expect("serializing typed cues into SHA-256");
    format!("{:x}", hash.finalize())
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Snapshot {
    draft: Draft,
    source: Option<SourceFingerprint>,
    base_document_hash: String,
    saved_at_ms: u64,
}

fn pack(value: &Snapshot) -> Result<Vec<u8>, String> {
    let mut bytes = vec![0; HEADER_LEN];
    serde_json::to_writer(&mut bytes, value).map_err(|_| "无法编码本地草稿。")?;
    let size = bytes.len() as u64;
    if size > SNAPSHOT_LIMIT {
        return Err("单份草稿超过 16 MiB。请另存为 SRT，或拆分字幕后再编辑。".into());
    }
    let sha = Sha256::digest(&bytes[HEADER_LEN..]);
    bytes[..8].copy_from_slice(MAGIC);
    bytes[8..16].copy_from_slice(&size.to_le_bytes());
    bytes[16..HEADER_LEN].copy_from_slice(&sha);
    Ok(bytes)
}

#[cfg(windows)]
fn read_file(root: &Path, path: &Path, limit: u64) -> io::Result<Vec<u8>> {
    let entry = locked_open(path, Some(root), false).map_err(|error| match error {
        OpenFailure::Io(error) => error,
        OpenFailure::Unsafe => {
            io::Error::new(io::ErrorKind::PermissionDenied, "草稿不是安全的普通文件")
        }
    })?;
    if entry.metadata.len() > limit {
        return Err(invalid_data());
    }
    read_bounded(entry.file, limit)
}

#[cfg(not(windows))]
fn read_file(root: &Path, path: &Path, limit: u64) -> io::Result<Vec<u8>> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file() || metadata.len() > limit || !fs::canonicalize(path)?.starts_with(root) {
        return Err(invalid_data());
    }
    read_bounded(File::open(path)?, limit)
}

fn read_bounded(file: File, limit: u64) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(invalid_data());
    }
    Ok(bytes)
}

#[derive(Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
enum Health {
    Ready,
    Fallback,
    Damaged,
    Incompatible,
    Inaccessible,
    Retired,
}

fn read_snapshot(root: &Path, entry: &Version) -> Result<Snapshot, Health> {
    let bytes = read_file(root, &entry.path, SNAPSHOT_LIMIT).map_err(|error| {
        if matches!(
            error.kind(),
            io::ErrorKind::InvalidData | io::ErrorKind::NotFound
        ) {
            Health::Damaged
        } else {
            Health::Inaccessible
        }
    })?;
    let (header, payload) = bytes.split_at_checked(HEADER_LEN).ok_or(Health::Damaged)?;
    if &header[..8] != MAGIC
        || header[8..16] != (bytes.len() as u64).to_le_bytes()
        || header[16..] != Sha256::digest(payload)[..]
    {
        return Err(Health::Damaged);
    }
    // Inspect the version without decoding an unknown schema or discarding it.
    #[derive(Deserialize)]
    struct Schema {
        #[serde(rename = "schemaVersion")]
        version: u32,
    }
    #[derive(Deserialize)]
    struct Manifest {
        draft: Schema,
    }
    let manifest: Manifest = serde_json::from_slice(payload).map_err(|_| Health::Damaged)?;
    if manifest.draft.version != 1 {
        return Err(Health::Incompatible);
    }
    let snapshot: Snapshot = serde_json::from_slice(payload).map_err(|_| Health::Damaged)?;
    if snapshot.draft.draft_id != entry.id
        || snapshot.draft.revision != entry.revision
        || snapshot.saved_at_ms > JS_MAX
        || !snapshot.draft.valid()
        || snapshot.base_document_hash != base_hash(&snapshot.draft)
        || snapshot
            .source
            .as_ref()
            .is_some_and(|source| !source.valid())
    {
        return Err(Health::Damaged);
    }
    Ok(snapshot)
}

struct Version {
    path: PathBuf,
    id: String,
    revision: u64,
    size: u64,
}

#[derive(Default)]
struct Group {
    versions: Vec<Version>,
    marker: Option<PathBuf>,
}

#[derive(Default)]
struct Inventory {
    groups: BTreeMap<String, Group>,
    staged: Vec<PathBuf>,
    used_bytes: u64,
}

fn inventory(root: &Path) -> Result<Inventory, String> {
    let mut result = Inventory::default();
    for (i, entry) in fs::read_dir(root).map_err(io_message)?.enumerate() {
        if i >= ENTRY_LIMIT {
            return Err("本地草稿目录包含过多条目，已暂停访问。".into());
        }
        let entry = entry.map_err(io_message)?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let parts: Vec<_> = name.split('.').collect();
        if let [key, revision, nonce, "draft"] = parts.as_slice() {
            if valid_id(key) && valid_id(nonce) {
                let Ok(revision) = revision.parse::<u64>() else {
                    continue;
                };
                if !(1..=JS_MAX).contains(&revision) {
                    continue;
                }
                let size = fs::symlink_metadata(entry.path())
                    .map_err(io_message)?
                    .len();
                result.used_bytes = result.used_bytes.saturating_add(size);
                result
                    .groups
                    .entry((*key).into())
                    .or_default()
                    .versions
                    .push(Version {
                        path: entry.path(),
                        id: (*key).into(),
                        revision,
                        size,
                    });
            }
        } else if let [key, "retired"] = parts.as_slice() {
            if valid_id(key) {
                let size = fs::symlink_metadata(entry.path())
                    .map_err(io_message)?
                    .len();
                result.used_bytes = result.used_bytes.saturating_add(size);
                result.groups.entry((*key).into()).or_default().marker = Some(entry.path());
            }
        } else if let ["", temporary, "tmp"] = parts.as_slice() {
            let mut sequence = temporary
                .strip_prefix("subtitle-tools-")
                .unwrap_or_default()
                .split('-');
            if (0..3).all(|_| {
                sequence.next().is_some_and(|part| {
                    !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit())
                })
            }) && sequence.next().is_none()
            {
                let size = fs::symlink_metadata(entry.path())
                    .map_err(io_message)?
                    .len();
                result.used_bytes = result.used_bytes.saturating_add(size);
                result.staged.push(entry.path());
            }
        }
    }
    for group in result.groups.values_mut() {
        group
            .versions
            .sort_unstable_by_key(|entry| std::cmp::Reverse(entry.revision));
    }
    Ok(result)
}

fn retired(key: &str) -> Vec<u8> {
    format!("SRTDRFT-RETIRED-1:{key}").into_bytes()
}

fn is_retired(root: &Path, key: &str, group: &Group) -> bool {
    group
        .marker
        .as_ref()
        .is_some_and(|marker| read_file(root, marker, 128).is_ok_and(|bytes| bytes == retired(key)))
}

fn newest(root: &Path, group: &Group) -> (Option<Snapshot>, Health) {
    let mut health = Health::Damaged;
    for (i, version) in group.versions.iter().enumerate() {
        match read_snapshot(root, version) {
            Ok(snapshot) => {
                return (
                    Some(snapshot),
                    if i == 0 {
                        Health::Ready
                    } else {
                        Health::Fallback
                    },
                )
            }
            // A newer format or locked version may be intact. Avoid reverting it silently.
            Err(status @ (Health::Incompatible | Health::Inaccessible)) => return (None, status),
            Err(status) => health = status,
        }
    }
    (None, health)
}

fn remove_managed(path: &Path) -> io::Result<()> {
    let meta = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
        if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(invalid_data());
        }
    }
    if !meta.is_file() {
        return Err(invalid_data());
    }
    fs::remove_file(path)
}

fn purge_retired(group: &Group) -> io::Result<()> {
    // Remove the marker last. A crash or locked file cannot resurrect a retired snapshot.
    for version in group.versions.iter().rev() {
        remove_managed(&version.path)?;
    }
    if let Some(marker) = &group.marker {
        remove_managed(marker)?;
    }
    Ok(())
}

fn prune(root: &Path, inventory: &Inventory) -> usize {
    let mut pending = 0;
    for path in &inventory.staged {
        pending += usize::from(remove_managed(path).is_err());
    }
    for (key, group) in &inventory.groups {
        if is_retired(root, key, group) {
            pending += usize::from(purge_retired(group).is_err());
        }
    }
    pending
}

fn write_complete(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}

fn publish(root: &Path, target: &Path, bytes: &[u8]) -> io::Result<()> {
    publish_with(root, target, bytes, |staged, target| {
        safe_files::publish(staged, target, false)
    })
}

fn publish_with(
    root: &Path,
    target: &Path,
    bytes: &[u8],
    rename: impl FnOnce(&Path, &Path) -> io::Result<()>,
) -> io::Result<()> {
    safe_files::write_staged(root, bytes, |staged| {
        if read_file(root, staged, SNAPSHOT_LIMIT)? != bytes {
            return Err(invalid_data());
        }
        match rename(staged, target) {
            Ok(()) => Ok(()),
            // Some Windows encrypted AppData locations reject even same-directory moves.
            // Each destination is immutable and self-validating, so a torn copy stays invalid
            // and readers fall back to the previous complete version. Never replace an old file.
            Err(error) if cfg!(windows) && error.raw_os_error() == Some(17) => {
                write_complete(target, bytes)?;
                if read_file(root, target, SNAPSHOT_LIMIT)? != bytes {
                    return Err(invalid_data());
                }
                Ok(())
            }
            Err(error) => Err(error),
        }
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveReceipt {
    saved_at_ms: u64,
    bytes: u64,
    over_soft_limit: bool,
}

fn save(
    root: &Path,
    draft: Draft,
    source: Option<SourceFingerprint>,
    commit: impl FnOnce(&Path, &Path, &[u8]) -> io::Result<()>,
) -> Result<SaveReceipt, String> {
    if !draft.valid() || source.as_ref().is_some_and(|source| !source.valid()) {
        return Err("草稿结构无效。请另存为并重新打开字幕。".into());
    }
    let mut entries = inventory(root)?;
    if !entries.staged.is_empty() {
        // No writer can be active inside the process-wide draft transaction.
        for path in &entries.staged {
            let _ = remove_managed(path);
        }
        entries = inventory(root)?;
    }
    let group = entries.groups.get(&draft.draft_id);
    if group.and_then(|group| group.marker.as_ref()).is_some() {
        return Err("该草稿正在清理。请在草稿管理中完成清理。".into());
    }
    let base_document_hash = base_hash(&draft);
    if let Some(group) = group {
        let (previous, health) = newest(root, group);
        if matches!(health, Health::Incompatible | Health::Inaccessible) {
            return Err("已有草稿版本不兼容或被占用，已保留。".into());
        }
        let head = group.versions.first().map_or(0, |version| version.revision);
        if let Some(previous) = previous {
            if previous.base_document_hash != base_document_hash || previous.source != source {
                return Err("草稿基线不一致，已有草稿已保留。".into());
            }
            if previous.draft.revision == head && previous.draft == draft {
                let bytes = group.versions[0].size;
                return Ok(SaveReceipt {
                    saved_at_ms: previous.saved_at_ms,
                    bytes,
                    over_soft_limit: bytes > SOFT_LIMIT,
                });
            }
            if previous.draft.revision >= draft.revision {
                return Err("已有相同或更新的草稿。请从草稿管理重新载入。".into());
            }
        }
        if head > draft.revision {
            return Err("已有相同或更新的草稿。请从草稿管理重新载入。".into());
        }
    } else if entries.groups.len() >= DRAFT_LIMIT {
        return Err("已达到 20 份草稿上限。请管理现有草稿或另存为 SRT。".into());
    }
    let snapshot = Snapshot {
        draft,
        source,
        base_document_hash,
        saved_at_ms: now_ms(),
    };
    let bytes = pack(&snapshot)?;
    let size = bytes.len() as u64;
    if entries.used_bytes.saturating_add(size) > TOTAL_LIMIT {
        return Err("本地草稿已达到 64 MiB 预算。请管理现有草稿或另存为 SRT。".into());
    }
    let path = root.join(format!(
        "{}.{}.{}.draft",
        snapshot.draft.draft_id,
        snapshot.draft.revision,
        id()
    ));
    commit(root, &path, &bytes).map_err(io_message)?;
    if let Some(group) = group {
        // Current snapshot is already durable. Keep one older valid fallback, then prune
        // older known revisions. Unsupported files are retained for their original version.
        let mut retained = false;
        for version in &group.versions {
            match read_snapshot(root, version) {
                Ok(_) if !retained => retained = true,
                Err(Health::Incompatible | Health::Inaccessible) => {}
                _ => {
                    let _ = remove_managed(&version.path);
                }
            }
        }
    }
    Ok(SaveReceipt {
        saved_at_ms: snapshot.saved_at_ms,
        bytes: size,
        over_soft_limit: size > SOFT_LIMIT,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DraftSummary {
    draft_id: String,
    health: Health,
    file_name: Option<String>,
    saved_at_ms: Option<u64>,
    source_path: Option<String>,
    bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DraftList {
    drafts: Vec<DraftSummary>,
    used_bytes: u64,
    budget_bytes: u64,
    draft_limit: usize,
}

fn list(root: &Path) -> Result<DraftList, String> {
    let entries = inventory(root)?;
    let mut drafts = Vec::with_capacity(entries.groups.len());
    for (key, group) in entries.groups {
        let (snapshot, health) = if is_retired(root, &key, &group) {
            (None, Health::Retired)
        } else {
            newest(root, &group)
        };
        drafts.push(DraftSummary {
            draft_id: key,
            health,
            file_name: snapshot
                .as_ref()
                .map(|snapshot| snapshot.draft.file_name.clone()),
            saved_at_ms: snapshot.as_ref().map(|snapshot| snapshot.saved_at_ms),
            source_path: snapshot.and_then(|snapshot| snapshot.source.map(|source| source.path)),
            bytes: group.versions.iter().map(|version| version.size).sum(),
        });
    }
    drafts.sort_by_key(|row| std::cmp::Reverse(row.saved_at_ms));
    Ok(DraftList {
        drafts,
        used_bytes: entries.used_bytes,
        budget_bytes: TOTAL_LIMIT,
        draft_limit: DRAFT_LIMIT,
    })
}

fn discard(root: &Path, key: &str, through_revision: Option<u64>) -> Result<bool, String> {
    if !valid_id(key) {
        return Err("无效的草稿标识。".into());
    }
    let entries = inventory(root)?;
    let Some(group) = entries.groups.get(key) else {
        return Ok(true);
    };
    if through_revision.is_some_and(|max| {
        group
            .versions
            .first()
            .is_some_and(|entry| entry.revision > max)
    }) {
        return Err("更新的草稿仍待保护，未清理。".into());
    }
    if !is_retired(root, key, group) {
        if let Some(incomplete) = &group.marker {
            remove_managed(incomplete).map_err(io_message)?;
        }
        publish(root, &root.join(format!("{key}.retired")), &retired(key)).map_err(io_message)?;
    }
    // Even if Windows prevents deletion now, the complete marker resolves discovery.
    Ok(purge_retired(group)
        .and_then(|_| remove_managed(&root.join(format!("{key}.retired"))))
        .is_ok())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
enum SourceStatus {
    Unchanged,
    Changed,
    Missing,
    Unverified,
}

#[cfg(windows)]
fn source_status(source: &SourceFingerprint) -> SourceStatus {
    let path = Path::new(&source.path);
    if !source.valid() || !local_path(path) {
        return SourceStatus::Unverified;
    }
    let Some(parent) = path.parent() else {
        return SourceStatus::Unverified;
    };
    let mut guards = Vec::<LockedEntry>::new();
    for directory in parent.ancestors().collect::<Vec<_>>().into_iter().rev() {
        let scope = guards.last().map(|entry| entry.final_path.as_path());
        match locked_open(directory, scope, true) {
            Ok(guard) => guards.push(guard),
            Err(error) => return source_error(error),
        }
    }
    let scope = guards.last().map(|entry| entry.final_path.as_path());
    let entry = match locked_open(path, scope, false) {
        Ok(entry) => entry,
        Err(error) => return source_error(error),
    };
    if entry.metadata.len() != source.bytes {
        return SourceStatus::Changed;
    }
    let mut digest = Sha256::new();
    if io::copy(&mut entry.file.take(INPUT_LIMIT + 1), &mut digest).ok() != Some(source.bytes) {
        return SourceStatus::Unverified;
    }
    if format!("{:x}", digest.finalize()) == source.sha256 {
        SourceStatus::Unchanged
    } else {
        SourceStatus::Changed
    }
}

#[cfg(windows)]
fn source_error(error: OpenFailure) -> SourceStatus {
    match error {
        OpenFailure::Io(error) if error.kind() == io::ErrorKind::NotFound => SourceStatus::Missing,
        _ => SourceStatus::Unverified,
    }
}

#[cfg(not(windows))]
fn source_status(_source: &SourceFingerprint) -> SourceStatus {
    SourceStatus::Unverified
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LoadedDraft {
    draft: Draft,
    source_status: SourceStatus,
    source_token: Option<String>,
    head_revision: u64,
    saved_at_ms: u64,
    health: Health,
}

#[cfg(windows)]
fn with_root<T>(path: &Path, work: impl FnOnce(&Path) -> Result<T, String>) -> Result<T, String> {
    if !local_path(path) {
        return Err("草稿需要安全的本机应用数据目录。".into());
    }
    let unsafe_path = |error| match error {
        OpenFailure::Unsafe => "草稿目录包含链接或目录联接，已暂停保护。".into(),
        OpenFailure::Io(error) => io_message(error),
    };
    let mut guards = Vec::<LockedEntry>::new();
    for component in path.ancestors().collect::<Vec<_>>().into_iter().rev() {
        let scope = guards.last().map(|entry| entry.final_path.as_path());
        match locked_output_directory(component, scope) {
            Ok(guard) => guards.push(guard),
            Err(OpenFailure::Io(error))
                if error.kind() == io::ErrorKind::NotFound && scope.is_some() =>
            {
                match fs::create_dir(component) {
                    Ok(()) => {}
                    Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                    Err(error) => return Err(io_message(error)),
                }
                guards.push(locked_output_directory(component, scope).map_err(unsafe_path)?);
            }
            Err(error) => return Err(unsafe_path(error)),
        }
    }
    let root = &guards.last().ok_or("本地草稿目录不可用。")?.final_path;
    let _sentinel = directory_sentinel(root)?;
    work(root)
}

#[cfg(not(windows))]
fn with_root<T>(_path: &Path, _work: impl FnOnce(&Path) -> Result<T, String>) -> Result<T, String> {
    Err("本地草稿保护需要 Windows 桌面版。".into())
}

async fn transaction<T: Send + 'static>(
    app: AppHandle,
    window: WebviewWindow,
    work: impl FnOnce(&Path, &DraftSources) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    ensure_main(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _lock = TRANSACTION.lock().map_err(|_| "草稿服务暂不可用。")?;
        let app_data = app
            .path()
            .app_local_data_dir()
            .map_err(|_| "应用本地数据目录不可用。")?;
        // Native acceptance uses a unique, bounded sibling namespace under the same known folder.
        // Renderer IPC cannot select a profile or provide a storage path.
        let name = match std::env::var("SRTTOOLS_QA_DRAFT_PROFILE") {
            Ok(profile) if valid_id(&profile) => format!("timeline-drafts-qa-{profile}"),
            _ => "timeline-drafts".into(),
        };
        with_root(&app_data.join(name), |root| {
            work(root, &app.state::<DraftSources>())
        })
    })
    .await
    .map_err(|_| "本地草稿任务未能完成。".to_string())?
}

#[tauri::command]
pub(crate) async fn save_draft(
    app: AppHandle,
    window: WebviewWindow,
    payload: String,
    source_token: Option<String>,
) -> Result<SaveReceipt, String> {
    if payload.len() as u64 > SNAPSHOT_LIMIT {
        return Err("单份草稿超过 16 MiB。请另存为 SRT。".into());
    }
    transaction(app, window, move |root, sources| {
        let draft = serde_json::from_str(&payload).map_err(|_| "草稿数据结构无效。")?;
        let source = source_token
            .as_deref()
            .map(|token| sources.get(token))
            .transpose()?;
        save(root, draft, source, publish)
    })
    .await
}

#[tauri::command]
pub(crate) async fn list_drafts(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<DraftList, String> {
    transaction(app, window, |root, _| list(root)).await
}

#[tauri::command]
pub(crate) async fn load_draft(
    app: AppHandle,
    window: WebviewWindow,
    draft_id: String,
) -> Result<LoadedDraft, String> {
    if !valid_id(&draft_id) {
        return Err("无效的草稿标识。".into());
    }
    transaction(app, window, move |root, sources| {
        let entries = inventory(root)?;
        let group = entries.groups.get(&draft_id).ok_or("草稿已不在本地。")?;
        if is_retired(root, &draft_id, group) {
            return Err("草稿已处理。".into());
        }
        let (snapshot, health) = newest(root, group);
        let snapshot = snapshot.ok_or(match health {
            Health::Incompatible => "当前版本无法读取这份草稿。请使用保存它的应用版本。",
            Health::Inaccessible => "无法访问草稿。请检查本地权限或文件占用后重试。",
            _ => "找不到通过完整性校验的草稿。",
        })?;
        let head_revision = group
            .versions
            .first()
            .map_or(snapshot.draft.revision, |entry| entry.revision);
        Ok(LoadedDraft {
            draft: snapshot.draft,
            source_status: snapshot
                .source
                .as_ref()
                .map_or(SourceStatus::Unverified, source_status),
            source_token: snapshot
                .source
                .map(|source| sources.remember(source))
                .transpose()?,
            head_revision,
            saved_at_ms: snapshot.saved_at_ms,
            health,
        })
    })
    .await
}

#[tauri::command]
pub(crate) async fn discard_draft(
    app: AppHandle,
    window: WebviewWindow,
    draft_id: String,
    through_revision: Option<u64>,
) -> Result<bool, String> {
    transaction(app, window, move |root, _| {
        discard(root, &draft_id, through_revision)
    })
    .await
}

#[tauri::command]
pub(crate) async fn prune_drafts(app: AppHandle, window: WebviewWindow) -> Result<usize, String> {
    transaction(app, window, |root, _| Ok(prune(root, &inventory(root)?))).await
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("srttools-drafts-{}", id()));
            fs::create_dir(&path).unwrap();
            Self(fs::canonicalize(path).unwrap())
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn draft(key: &str, revision: u64) -> Draft {
        Draft {
            schema_version: 1,
            draft_id: key.into(),
            revision,
            file_name: "合成 草稿.srt".into(),
            format: "srt".into(),
            encoding: "UTF-8".into(),
            line_ending: "CRLF".into(),
            original: vec![Cue {
                id: "cue-1".into(),
                index: 9,
                start_ms: 1,
                end_ms: 2,
                text: "初稿 🐱".into(),
            }],
            cues: vec![Cue {
                id: "cue-1".into(),
                index: 9,
                start_ms: 1,
                end_ms: 2,
                text: format!("测试 {revision}\n第二行"),
            }],
        }
    }

    fn current(root: &Path, key: &str) -> (Option<Snapshot>, Health) {
        newest(root, &inventory(root).unwrap().groups[key])
    }

    #[test]
    fn staged_interruptions_and_write_failures_preserve_the_confirmed_version() {
        let Fixture(ref root) = Fixture::new();
        let key = id();
        let first = save(root, draft(&key, 1), None, publish).unwrap();
        for kind in [
            io::ErrorKind::PermissionDenied,
            io::ErrorKind::StorageFull,
            io::ErrorKind::Interrupted,
        ] {
            let incomplete = root.join(".subtitle-tools-1-123-0.tmp");
            fs::write(&incomplete, &MAGIC[..4]).unwrap();
            assert_eq!(current(root, &key).0.unwrap().draft.revision, 1);
            assert!(save(root, draft(&key, 2), None, |root, path, bytes| {
                publish_with(root, path, bytes, |staged, _| {
                    assert_eq!(fs::read(staged)?, bytes);
                    Err(io::Error::from(kind))
                })
            })
            .is_err());
            assert!(!incomplete.exists());
            assert_eq!(current(root, &key).0.unwrap().draft.revision, 1);
        }
        let retry = save(root, draft(&key, 1), None, publish).unwrap();
        assert_eq!(first.saved_at_ms, retry.saved_at_ms);
        assert_eq!(inventory(root).unwrap().groups[&key].versions.len(), 1);
        save(root, draft(&key, 3), None, publish).unwrap();
        assert!(save(root, draft(&key, 2), None, publish).is_err());
        assert!(discard(root, &key, Some(2)).is_err());
        assert_eq!(current(root, &key).0.unwrap().draft.revision, 3);
    }

    #[test]
    fn two_complete_versions_fall_back_after_truncation_or_digest_damage() {
        let Fixture(ref root) = Fixture::new();
        let key = id();
        for revision in 1..=3 {
            save(root, draft(&key, revision), None, publish).unwrap();
        }
        let inventory = inventory(root).unwrap();
        let group = &inventory.groups[&key];
        assert_eq!(group.versions.len(), 2);
        let latest = &group.versions[0].path;
        let mut bytes = fs::read(latest).unwrap();
        let len = bytes.len();
        bytes[len - 1] ^= 0x80;
        for broken in [bytes.as_slice(), &bytes[..len - 5]] {
            fs::write(latest, broken).unwrap();
            let (snapshot, health) = current(root, &key);
            assert!(health == Health::Fallback);
            assert_eq!(snapshot.unwrap().draft.revision, 2);
        }
        save(root, draft(&key, 4), None, publish).unwrap();
        assert!(!latest.exists());
        assert_eq!(current(root, &key).0.unwrap().draft.revision, 4);
    }

    #[test]
    fn interrupted_publication_cleanup_keeps_new_snapshot_and_hides_resolved_versions() {
        let Fixture(ref root) = Fixture::new();
        let key = id();
        for revision in 1..=3 {
            let snapshot = Snapshot {
                draft: draft(&key, revision),
                source: None,
                base_document_hash: base_hash(&draft(&key, revision)),
                saved_at_ms: now_ms(),
            };
            let path = root.join(format!("{key}.{revision}.{}.draft", id()));
            publish(root, &path, &pack(&snapshot).unwrap()).unwrap();
        }
        assert_eq!(current(root, &key).0.unwrap().draft.revision, 3);
        let marker = root.join(format!("{key}.retired"));
        fs::write(&marker, b"partial retirement").unwrap();
        assert!(list(root).unwrap().drafts[0].health == Health::Ready);
        fs::write(&marker, retired(&key)).unwrap();
        assert!(list(root).unwrap().drafts[0].health == Health::Retired);
        assert_eq!(prune(root, &inventory(root).unwrap()), 0);
        assert!(list(root).unwrap().drafts.is_empty());
    }

    #[test]
    fn incompatible_and_invalid_schemas_are_isolated_and_unknown_files_preserved() {
        let Fixture(ref root) = Fixture::new();
        let key = id();
        save(root, draft(&key, 1), None, publish).unwrap();
        let mut future = draft(&key, 2);
        future.schema_version = 2;
        let value = Snapshot {
            base_document_hash: base_hash(&future),
            draft: future,
            source: None,
            saved_at_ms: now_ms(),
        };
        let future_path = root.join(format!("{key}.2.{}.draft", id()));
        fs::write(&future_path, pack(&value).unwrap()).unwrap();
        assert!(current(root, &key).1 == Health::Incompatible);
        assert!(save(root, draft(&key, 3), None, publish).is_err());
        assert_eq!(prune(root, &inventory(root).unwrap()), 0);
        assert!(future_path.exists());
        let unknown = root.join("do-not-touch.txt");
        fs::write(&unknown, "preserve").unwrap();
        assert!(discard(root, "../do-not-touch", None).is_err());
        assert_eq!(fs::read_to_string(unknown).unwrap(), "preserve");
        let mut invalid = draft(&id(), 1);
        invalid.cues[0].start_ms = JS_MAX + 1;
        assert!(save(root, invalid, None, publish).is_err());
        let mut duplicate = draft(&id(), 1);
        duplicate.cues.push(Cue {
            id: "cue-1".into(),
            index: 2,
            start_ms: 3,
            end_ms: 4,
            text: String::new(),
        });
        assert!(save(root, duplicate, None, publish).is_err());
        let mut unsafe_name = draft(&id(), 1);
        unsafe_name.file_name = "..\\outside.srt".into();
        assert!(save(root, unsafe_name, None, publish).is_err());
    }

    #[test]
    fn budgets_reject_new_writes_without_removing_active_records() {
        let Fixture(ref root) = Fixture::new();
        let key = id();
        for _ in 1..DRAFT_LIMIT {
            save(root, draft(&id(), 1), None, publish).unwrap();
        }
        save(root, draft(&key, 1), None, publish).unwrap();
        assert!(save(root, draft(&id(), 1), None, publish)
            .err()
            .unwrap()
            .contains("20"));
        let mut oversized = draft(&key, 2);
        oversized.cues[0].text = "a".repeat(SNAPSHOT_LIMIT as usize);
        assert!(save(root, oversized, None, publish)
            .err()
            .unwrap()
            .contains("16 MiB"));
        let big = root.join(format!("{}.1.{}.draft", id(), id()));
        File::create(&big).unwrap().set_len(TOTAL_LIMIT).unwrap();
        assert!(save(root, draft(&key, 2), None, publish)
            .err()
            .unwrap()
            .contains("64 MiB"));
        assert_eq!(current(root, &key).0.unwrap().draft.revision, 1);
    }

    #[cfg(windows)]
    #[test]
    fn windows_copy_fallback_and_real_file_lock_keep_a_complete_snapshot() {
        use std::os::windows::fs::OpenOptionsExt;
        let Fixture(ref root) = Fixture::new();
        let key = id();
        save(root, draft(&key, 1), None, |root, path, bytes| {
            publish_with(root, path, bytes, |_, _| {
                Err(io::Error::from_raw_os_error(17))
            })
        })
        .unwrap();
        let group = &inventory(root).unwrap().groups[&key];
        let lock = OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&group.versions[0].path)
            .unwrap();
        assert!(current(root, &key).1 == Health::Inaccessible);
        assert!(save(root, draft(&key, 2), None, publish).is_err());
        assert!(!discard(root, &key, Some(1)).unwrap());
        assert!(list(root).unwrap().drafts[0].health == Health::Retired);
        drop(lock);
        assert_eq!(prune(root, &inventory(root).unwrap()), 0);
        assert!(list(root).unwrap().drafts.is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn source_probe_matches_exact_bytes_and_rejects_links_devices_and_network() {
        use super::super::display_path;
        use std::os::windows::process::CommandExt;
        let Fixture(ref root) = Fixture::new();
        let path = root.join("源文件 中文.srt");
        fs::write(&path, b"abcdef").unwrap();
        let source = SourceFingerprint::from_import(&display_path(&path), b"abcdef");
        assert!(matches!(source_status(&source), SourceStatus::Unchanged));
        fs::write(&path, b"uvwxyz").unwrap();
        assert!(matches!(source_status(&source), SourceStatus::Changed));
        fs::remove_file(&path).unwrap();
        assert!(matches!(source_status(&source), SourceStatus::Missing));
        for path in [
            r"\\server\share\file.srt",
            r"\\.\GLOBALROOT\file.srt",
            r"C:\data\..\file.srt",
            r"C:\data\file:stream.srt",
        ] {
            let denied = SourceFingerprint {
                path: path.into(),
                ..source.clone()
            };
            assert!(matches!(source_status(&denied), SourceStatus::Unverified));
        }
        let link = root.join("junction");
        let other = root.join("target");
        fs::create_dir(&other).unwrap();
        let shell = std::env::var_os("COMSPEC").unwrap_or_else(|| "cmd.exe".into());
        let command = format!(
            r#"mklink /J "{}" "{}""#,
            display_path(&link),
            display_path(&other)
        );
        assert!(std::process::Command::new(shell)
            .args(["/D", "/C"])
            .raw_arg(command)
            .output()
            .unwrap()
            .status
            .success());
        assert!(with_root(&link.join("drafts"), |_| Ok(())).is_err());
        assert!(!other.join("drafts").exists());
        let denied = SourceFingerprint {
            path: display_path(&link.join("source.srt")),
            ..source
        };
        assert!(matches!(source_status(&denied), SourceStatus::Unverified));
        fs::remove_dir(link).unwrap();
    }
}
