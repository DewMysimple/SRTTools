use super::{
    display_path, ensure_main, FileAccess, ImportedFile, IMPORT_BATCH_LIMIT, IMPORT_COUNT_LIMIT,
    INPUT_LIMIT,
};
use serde::Serialize;
use std::{
    cmp::Ordering,
    collections::HashMap,
    ffi::OsStr,
    fs::{self, File},
    io::{self, Read},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering as AtomicOrdering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{ipc::Channel, AppHandle, Manager, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

const MAX_DEPTH: usize = 5;
const MAX_ENTRIES: usize = 2000;
const EXTENSIONS: [&str; 6] = ["srt", "vtt", "ass", "ssa", "txt", "csv"];

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderSummary {
    visited_entries: usize,
    scanned_files: usize,
    added: usize,
    duplicates: usize,
    unsupported: usize,
    over_limit: usize,
    failed: usize,
    unreadable_directories: usize,
    skipped_links: usize,
    depth_skipped: usize,
    limit_stopped: bool,
    cancelled: bool,
    selected: bool,
    cancelled_files: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderEvent {
    scan_id: String,
    phase: &'static str,
    summary: FolderSummary,
    #[serde(skip_serializing_if = "Option::is_none")]
    file: Option<ImportedFile>,
}

#[derive(Clone, Default)]
pub struct FolderImports(Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>);

struct Session {
    id: String,
    cancel: Arc<AtomicBool>,
    registry: FolderImports,
}

impl Drop for Session {
    fn drop(&mut self) {
        if let Ok(mut active) = self.registry.0.lock() {
            active.remove(&self.id.to_ascii_lowercase());
        }
    }
}

pub(super) fn valid_id(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(index, character)| {
            if [8, 13, 18, 23].contains(&index) {
                character == b'-'
            } else {
                character.is_ascii_hexdigit()
            }
        })
}

impl FolderImports {
    fn begin(&self, id: String) -> Result<Session, String> {
        if !valid_id(&id) {
            return Err("文件夹扫描标识无效。".into());
        }
        let mut active = self.0.lock().map_err(|_| "扫描状态异常，请重启应用。")?;
        if !active.is_empty() {
            return Err("另一个文件夹扫描仍在进行，请等待或取消后重试。".into());
        }
        let cancel = Arc::new(AtomicBool::new(false));
        active.insert(id.to_ascii_lowercase(), cancel.clone());
        Ok(Session {
            id,
            cancel,
            registry: self.clone(),
        })
    }

    fn cancel(&self, id: &str) -> Result<(), String> {
        if !valid_id(id) {
            return Err("文件夹扫描标识无效。".into());
        }
        let active = self.0.lock().map_err(|_| "扫描状态异常，请重启应用。")?;
        if let Some(cancel) = active.get(&id.to_ascii_lowercase()) {
            cancel.store(true, AtomicOrdering::Relaxed);
        }
        Ok(())
    }
}

struct ScanOptions {
    scan_id: String,
    recursive: bool,
    extensions: Vec<String>,
    known_paths: Vec<String>,
    existing_count: usize,
    existing_bytes: u64,
}

impl ScanOptions {
    fn checked(
        scan_id: String,
        recursive: bool,
        extensions: Vec<String>,
        existing_paths: Vec<String>,
        existing_count: usize,
        existing_bytes: u64,
    ) -> Result<Self, String> {
        let extensions: Vec<_> = extensions
            .into_iter()
            .map(|extension| extension.to_ascii_lowercase())
            .collect();
        if extensions.is_empty()
            || extensions.len() > EXTENSIONS.len()
            || extensions
                .iter()
                .any(|extension| !EXTENSIONS.contains(&extension.as_str()))
        {
            return Err("请选择受支持的字幕格式。".into());
        }
        if !valid_id(&scan_id)
            || existing_count > IMPORT_COUNT_LIMIT
            || existing_bytes > IMPORT_BATCH_LIMIT
            || existing_paths.len() > IMPORT_COUNT_LIMIT
            || existing_paths
                .iter()
                .any(|path| path.encode_utf16().count() > 32767)
        {
            return Err("现有文件队列或扫描参数超出限制。".into());
        }
        // These are comparison hints only. Never resolve or read renderer-supplied paths.
        let known_paths = existing_paths
            .into_iter()
            .map(|value| display_path(Path::new(&value.replace('/', "\\"))))
            .collect();
        Ok(Self {
            scan_id,
            recursive,
            extensions,
            known_paths,
            existing_count,
            existing_bytes,
        })
    }
}

#[cfg(windows)]
pub(super) fn ordinal_compare(left: &OsStr, right: &OsStr, ignore_case: bool) -> Ordering {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Globalization::{CompareStringOrdinal, CSTR_EQUAL, CSTR_LESS_THAN};
    let left: Vec<_> = left.encode_wide().collect();
    let right: Vec<_> = right.encode_wide().collect();
    let result = unsafe {
        CompareStringOrdinal(
            left.as_ptr(),
            left.len() as i32,
            right.as_ptr(),
            right.len() as i32,
            i32::from(ignore_case),
        )
    };
    match result {
        CSTR_EQUAL => Ordering::Equal,
        CSTR_LESS_THAN => Ordering::Less,
        _ => Ordering::Greater,
    }
}

#[cfg(not(windows))]
pub(super) fn ordinal_compare(left: &OsStr, right: &OsStr, ignore_case: bool) -> Ordering {
    if ignore_case {
        left.to_string_lossy()
            .to_lowercase()
            .cmp(&right.to_string_lossy().to_lowercase())
    } else {
        left.cmp(right)
    }
}

pub(super) fn within(root: &Path, candidate: &Path) -> bool {
    let mut children = candidate.components();
    root.components().all(|component| {
        children.next().is_some_and(|child| {
            ordinal_compare(component.as_os_str(), child.as_os_str(), true) == Ordering::Equal
        })
    })
}

#[cfg(windows)]
fn is_reparse(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_reparse(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

pub(super) struct LockedEntry {
    pub(super) file: File,
    pub(super) final_path: PathBuf,
    pub(super) metadata: fs::Metadata,
}

#[derive(Debug)]
pub(super) enum OpenFailure {
    Unsafe,
    Io(io::Error),
}

impl From<io::Error> for OpenFailure {
    fn from(value: io::Error) -> Self {
        Self::Io(value)
    }
}

#[cfg(windows)]
fn final_path(file: &File) -> io::Result<PathBuf> {
    use std::os::windows::{ffi::OsStringExt, io::AsRawHandle};
    use windows_sys::Win32::Storage::FileSystem::GetFinalPathNameByHandleW;
    let mut buffer = vec![0u16; 512];
    loop {
        let length = unsafe {
            GetFinalPathNameByHandleW(
                file.as_raw_handle(),
                buffer.as_mut_ptr(),
                buffer.len() as u32,
                0,
            )
        };
        if length == 0 {
            return Err(io::Error::last_os_error());
        }
        if length as usize >= buffer.len() {
            buffer.resize(length as usize + 1, 0);
        } else {
            return Ok(std::ffi::OsString::from_wide(&buffer[..length as usize]).into());
        }
    }
}

#[cfg(windows)]
fn locked_open_mode(
    path: &Path,
    root: Option<&Path>,
    directory: bool,
    output: bool,
) -> Result<LockedEntry, OpenFailure> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ, FILE_SHARE_WRITE,
    };
    let file = fs::OpenOptions::new()
        .read(true)
        // Deny writes and deletion while checking and reading this exact handle.
        .share_mode(if output {
            FILE_SHARE_READ | FILE_SHARE_WRITE
        } else {
            FILE_SHARE_READ
        })
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)?;
    let metadata = file.metadata()?;
    if is_reparse(&metadata)
        || metadata.is_dir() != directory
        || (!directory && !metadata.is_file())
    {
        return Err(OpenFailure::Unsafe);
    }
    let final_path = final_path(&file)?;
    if root.is_some_and(|root| !within(root, &final_path)) {
        return Err(OpenFailure::Unsafe);
    }
    Ok(LockedEntry {
        file,
        final_path,
        metadata,
    })
}

#[cfg(not(windows))]
fn locked_open_mode(
    _path: &Path,
    _root: Option<&Path>,
    _directory: bool,
    _output: bool,
) -> Result<LockedEntry, OpenFailure> {
    Err(OpenFailure::Io(io::Error::new(
        io::ErrorKind::Unsupported,
        "文件夹导入需要 Windows 桌面环境。",
    )))
}

pub(super) fn locked_open(
    path: &Path,
    root: Option<&Path>,
    directory: bool,
) -> Result<LockedEntry, OpenFailure> {
    locked_open_mode(path, root, directory, false)
}

/// Output parents permit child entry publication, while denying deletion/renaming of the parent.
pub(super) fn locked_output_directory(
    path: &Path,
    root: Option<&Path>,
) -> Result<LockedEntry, OpenFailure> {
    locked_open_mode(path, root, true, true)
}

#[derive(Debug)]
enum ReadFailure {
    Cancelled,
    TooLarge,
    Io,
}

fn read_bounded(
    reader: &mut impl Read,
    limit: u64,
    cancel: &AtomicBool,
    mut progress: impl FnMut(),
) -> Result<Vec<u8>, ReadFailure> {
    let mut bytes = Vec::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        if cancel.load(AtomicOrdering::Relaxed) {
            return Err(ReadFailure::Cancelled);
        }
        let size = (limit - bytes.len() as u64 + 1).min(buffer.len() as u64) as usize;
        let read = match reader.read(&mut buffer[..size]) {
            Ok(read) => read,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => return Err(ReadFailure::Io),
        };
        if read == 0 {
            return Ok(bytes);
        }
        bytes.extend_from_slice(&buffer[..read]);
        if bytes.len() as u64 > limit {
            return Err(ReadFailure::TooLarge);
        }
        progress();
    }
}

struct Scanner<'a> {
    options: ScanOptions,
    summary: FolderSummary,
    added_bytes: u64,
    access: &'a FileAccess,
    cancel: Arc<AtomicBool>,
    send: &'a mut dyn FnMut(FolderEvent) -> bool,
    last_progress: Instant,
    disconnected: bool,
    quota_stopped: bool,
    terminal_sent: bool,
}

impl<'a> Scanner<'a> {
    fn new(
        options: ScanOptions,
        access: &'a FileAccess,
        cancel: Arc<AtomicBool>,
        send: &'a mut dyn FnMut(FolderEvent) -> bool,
    ) -> Self {
        Self {
            options,
            summary: FolderSummary::default(),
            added_bytes: 0,
            access,
            cancel,
            send,
            last_progress: Instant::now(),
            disconnected: false,
            quota_stopped: false,
            terminal_sent: false,
        }
    }

    fn stopped(&self) -> bool {
        self.quota_stopped || self.cancel.load(AtomicOrdering::Relaxed)
    }

    fn emit(&mut self, phase: &'static str, file: Option<ImportedFile>, force: bool) -> bool {
        if self.disconnected {
            return false;
        }
        if file.is_none() && !force && self.last_progress.elapsed() < Duration::from_millis(50) {
            return true;
        }
        self.last_progress = Instant::now();
        let sent = (self.send)(FolderEvent {
            scan_id: self.options.scan_id.clone(),
            phase,
            summary: self.summary.clone(),
            file,
        });
        if !sent {
            self.disconnected = true;
            self.cancel.store(true, AtomicOrdering::Relaxed);
        }
        sent
    }

    fn finish(&mut self) -> bool {
        if self.terminal_sent {
            return !self.disconnected;
        }
        self.terminal_sent = true;
        self.summary.cancelled = self.cancel.load(AtomicOrdering::Relaxed);
        self.emit("complete", None, true)
    }

    fn walk(&mut self, path: &Path, root: Option<&Path>, depth: usize) -> io::Result<()> {
        if self.stopped() {
            return Ok(());
        }
        let directory = match locked_open(path, root, true) {
            Ok(directory) => directory,
            Err(OpenFailure::Unsafe) => {
                self.summary.skipped_links += 1;
                return Err(io::Error::other("该目录为链接或不在已选择范围内。"));
            }
            Err(OpenFailure::Io(error)) => {
                self.summary.unreadable_directories += 1;
                return Err(error);
            }
        };
        let root = root.unwrap_or(&directory.final_path);
        let mut iterator = match fs::read_dir(&directory.final_path) {
            Ok(iterator) => iterator,
            Err(error) => {
                self.summary.unreadable_directories += 1;
                return Err(error);
            }
        };
        let mut entries = Vec::new();
        while self.summary.visited_entries < MAX_ENTRIES && !self.stopped() {
            let Some(entry) = iterator.next() else { break };
            self.summary.visited_entries += 1;
            match entry {
                Ok(entry) => entries.push(entry),
                Err(_) => self.summary.failed += 1,
            }
            self.emit("scanning", None, false);
        }
        if self.summary.visited_entries >= MAX_ENTRIES {
            self.summary.limit_stopped = true;
        }
        entries.sort_by(|left, right| {
            let left = left.file_name();
            let right = right.file_name();
            ordinal_compare(&left, &right, true).then_with(|| ordinal_compare(&left, &right, false))
        });
        for entry in entries {
            if self.stopped() {
                break;
            }
            let metadata = match fs::symlink_metadata(entry.path()) {
                Ok(metadata) => metadata,
                Err(_) => {
                    self.summary.failed += 1;
                    continue;
                }
            };
            if is_reparse(&metadata) {
                self.summary.skipped_links += 1;
            } else if metadata.is_dir() {
                if self.options.recursive {
                    if depth >= MAX_DEPTH {
                        self.summary.depth_skipped += 1;
                    } else if self.summary.visited_entries < MAX_ENTRIES {
                        // Keep this ancestor's read-only, non-delete handle alive through recursion.
                        let _ = self.walk(&entry.path(), Some(root), depth + 1);
                    }
                }
            } else if metadata.is_file() {
                self.summary.scanned_files += 1;
                let extension = entry
                    .path()
                    .extension()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_ascii_lowercase();
                if self.options.extensions.contains(&extension) {
                    self.read_file(&entry.path(), root);
                } else {
                    self.summary.unsupported += 1;
                }
            } else {
                self.summary.unsupported += 1;
            }
            self.emit("scanning", None, false);
        }
        Ok(())
    }

    fn read_file(&mut self, path: &Path, root: &Path) {
        let mut entry = match locked_open(path, Some(root), false) {
            Ok(entry) => entry,
            Err(OpenFailure::Unsafe) => {
                self.summary.skipped_links += 1;
                return;
            }
            Err(OpenFailure::Io(_)) => {
                self.summary.failed += 1;
                return;
            }
        };
        let display = display_path(&entry.final_path);
        if self.options.known_paths.iter().any(|known| {
            ordinal_compare(OsStr::new(known), OsStr::new(&display), true) == Ordering::Equal
        }) {
            self.summary.duplicates += 1;
            return;
        }
        let remaining = IMPORT_BATCH_LIMIT - self.options.existing_bytes - self.added_bytes;
        if self.options.existing_count + self.summary.added >= IMPORT_COUNT_LIMIT || remaining == 0
        {
            self.summary.over_limit += 1;
            self.summary.limit_stopped = true;
            self.quota_stopped = true;
            return;
        }
        if entry.metadata.len() > INPUT_LIMIT || entry.metadata.len() > remaining {
            self.summary.over_limit += 1;
            return;
        }
        if !self.emit("reading", None, true) {
            return;
        }
        let cancel = self.cancel.clone();
        let bytes = match read_bounded(&mut entry.file, INPUT_LIMIT.min(remaining), &cancel, || {
            self.emit("reading", None, false);
        }) {
            Ok(bytes) => bytes,
            Err(ReadFailure::Cancelled) => {
                self.summary.cancelled_files += 1;
                return;
            }
            Err(ReadFailure::TooLarge) => {
                self.summary.over_limit += 1;
                return;
            }
            Err(ReadFailure::Io) => {
                self.summary.failed += 1;
                return;
            }
        };
        if self.cancel.load(AtomicOrdering::Relaxed) {
            self.summary.cancelled_files += 1;
            return;
        }
        let folder_source = match self.access.approve_folder_source(
            entry.final_path.clone(),
            root,
            &self.options.scan_id,
        ) {
            Ok(source) => source,
            Err(_) => {
                self.summary.failed += 1;
                return;
            }
        };
        let size = bytes.len() as u64;
        let file = ImportedFile {
            name: entry
                .final_path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
            path: display.clone(),
            bytes,
            size,
            error: None,
            folder_source: Some(folder_source),
        };
        self.summary.added += 1;
        self.added_bytes += size;
        self.options.known_paths.push(display);
        if !self.emit("reading", Some(file), true) {
            self.summary.added -= 1;
            self.added_bytes -= size;
            self.summary.cancelled_files += 1;
        }
    }
}

#[tauri::command]
pub fn cancel_folder_import(
    app: AppHandle,
    window: WebviewWindow,
    scan_id: String,
) -> Result<(), String> {
    ensure_main(&window)?;
    app.state::<FolderImports>().cancel(&scan_id)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)] // Flat IPC parameters preserve the renderer's explicit contract.
pub async fn select_import_folder(
    app: AppHandle,
    window: WebviewWindow,
    scan_id: String,
    recursive: bool,
    extensions: Vec<String>,
    existing_paths: Vec<String>,
    existing_count: usize,
    existing_bytes: u64,
    on_event: Channel<FolderEvent>,
) -> Result<(), String> {
    ensure_main(&window)?;
    let options = ScanOptions::checked(
        scan_id.clone(),
        recursive,
        extensions,
        existing_paths,
        existing_count,
        existing_bytes,
    )?;
    let session = app.state::<FolderImports>().begin(scan_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let access = app.state::<FileAccess>();
        let mut send = |event| on_event.send(event).is_ok();
        let mut scanner = Scanner::new(options, &access, session.cancel.clone(), &mut send);
        let mut failure = None;
        if !session.cancel.load(AtomicOrdering::Relaxed) {
            if let Some(selected) = app
                .dialog()
                .file()
                .set_title("选择字幕文件夹")
                .blocking_pick_folder()
            {
                scanner.summary.selected = true;
                scanner.emit("scanning", None, true);
                match selected.into_path() {
                    Ok(path) => {
                        if let Err(error) = scanner.walk(&path, None, 0) {
                            failure = Some(format!("无法安全扫描所选文件夹：{error}"));
                        }
                    }
                    Err(_) => {
                        scanner.summary.unreadable_directories += 1;
                        failure = Some("无法识别所选文件夹。".into());
                    }
                }
            } else {
                session.cancel.store(true, AtomicOrdering::Relaxed);
            }
        }
        if !scanner.finish() {
            return Err("文件夹扫描通道已关闭，本次扫描已停止。".into());
        }
        failure.map_or(Ok(()), Err)
    })
    .await
    .map_err(|_| "文件夹扫描任务未能完成，请重试。")?
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::{io::Cursor, os::windows::fs::OpenOptionsExt, time::SystemTime};

    const ID: &str = "05633f59-8738-44ad-ae7a-f39a109a05ca";

    struct TestDir(PathBuf);

    impl TestDir {
        fn new() -> Self {
            let directory = std::env::temp_dir().join(format!(
                "subtitle-tools-folder-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(SystemTime::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
            ));
            fs::create_dir(&directory).unwrap();
            Self(fs::canonicalize(directory).unwrap())
        }

        fn put(&self, name: &str, bytes: &[u8]) -> PathBuf {
            let file = self.0.join(name);
            fs::create_dir_all(file.parent().unwrap()).unwrap();
            fs::write(&file, bytes).unwrap();
            file
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            // This immutable canonical path is the unique directory created by new().
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn options(recursive: bool) -> ScanOptions {
        ScanOptions::checked(
            ID.into(),
            recursive,
            EXTENSIONS.iter().map(|value| (*value).into()).collect(),
            Vec::new(),
            0,
            0,
        )
        .unwrap()
    }

    fn scan(
        directory: &Path,
        options: ScanOptions,
    ) -> (FolderSummary, Vec<FolderEvent>, FileAccess) {
        let access = FileAccess::default();
        let mut events = Vec::new();
        let mut send = |event| {
            events.push(event);
            true
        };
        let summary = {
            let mut scanner = Scanner::new(
                options,
                &access,
                Arc::new(AtomicBool::new(false)),
                &mut send,
            );
            scanner.summary.selected = true;
            scanner.walk(directory, None, 0).unwrap();
            assert!(scanner.finish());
            assert!(scanner.finish());
            scanner.summary.clone()
        };
        (summary, events, access)
    }

    fn names(events: &[FolderEvent]) -> Vec<&str> {
        events
            .iter()
            .filter_map(|event| event.file.as_ref().map(|file| file.name.as_str()))
            .collect()
    }

    fn junction(link: &Path, target: &Path) {
        let output = std::process::Command::new("cmd.exe")
            .args(["/C", "mklink", "/J"])
            .arg(display_path(link))
            .arg(display_path(target))
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "synthetic junction creation failed"
        );
    }

    #[test]
    fn validates_hints_without_reading_them_and_scopes_session_lifetime() {
        assert!(
            ScanOptions::checked(ID.into(), false, vec!["exe".into()], Vec::new(), 0, 0).is_err()
        );
        assert!(
            ScanOptions::checked(ID.into(), false, vec!["srt".into()], Vec::new(), 101, 0).is_err()
        );
        assert!(ScanOptions::checked(
            ID.into(),
            false,
            vec!["srt".into()],
            Vec::new(),
            0,
            IMPORT_BATCH_LIMIT + 1
        )
        .is_err());
        let mut selected = options(false);
        selected
            .known_paths
            .push("Z:\\never-read\\private.srt".into());
        let directory = TestDir::new();
        directory.put("a.srt", b"content");
        assert_eq!(scan(&directory.0, selected).0.added, 1);

        let registry = FolderImports::default();
        let session = registry.begin(ID.into()).unwrap();
        assert!(registry.begin(ID.to_ascii_uppercase()).is_err());
        registry.cancel(&ID.to_ascii_uppercase()).unwrap();
        assert!(session.cancel.load(AtomicOrdering::Relaxed));
        drop(session);
        assert!(registry.begin(ID.into()).is_ok());
        assert!(registry.begin("invalid".into()).is_err());
    }

    #[test]
    fn empty_root_finishes_once_and_default_scan_sorts_and_filters_without_recursion() {
        let directory = TestDir::new();
        let (summary, events, _) = scan(&directory.0, options(false));
        assert!(summary.selected);
        assert_eq!(summary.added, 0);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].scan_id, ID);
        assert_eq!(events[0].phase, "complete");
        directory.put("Z.srt", b"z");
        directory.put("a.SRT", b"a");
        directory.put("b.txt", b"b");
        directory.put("skip.exe", b"ignored");
        directory.put("child/c.srt", b"nested");
        let (summary, events, access) = scan(&directory.0, options(false));
        assert_eq!(names(&events), ["a.SRT", "b.txt", "Z.srt"]);
        assert_eq!(summary.added, 3);
        assert_eq!(summary.unsupported, 1);
        assert_eq!(summary.visited_entries, 5);
        assert_eq!(summary.scanned_files, 4);
        assert!(access.can_read(&fs::canonicalize(directory.0.join("a.SRT")).unwrap()));
        assert!(!access.can_write_directory(&directory.0));
        assert!(!access.can_read(&fs::canonicalize(directory.0.join("child/c.srt")).unwrap()));
        assert_eq!(
            events
                .iter()
                .filter(|event| event.phase == "complete")
                .count(),
            1
        );
    }

    #[test]
    fn recursive_same_names_are_distinct_and_windows_case_variants_are_duplicates() {
        let directory = TestDir::new();
        let first = directory.put("a/Ä.srt", b"first");
        directory.put("b/Ä.srt", b"second");
        let mut selected = options(true);
        selected
            .known_paths
            .push(display_path(&first).replace('Ä', "ä").to_ascii_uppercase());
        selected.existing_count = 1;
        let (summary, events, _) = scan(&directory.0, selected);
        assert_eq!(summary.duplicates, 1);
        assert_eq!(summary.added, 1);
        assert_eq!(
            events
                .iter()
                .filter_map(|event| event.file.as_ref())
                .next()
                .unwrap()
                .bytes,
            b"second"
        );
        assert_eq!(
            ordinal_compare(OsStr::new("ä"), OsStr::new("Ä"), true),
            Ordering::Equal
        );
    }

    #[test]
    fn native_canonical_spelling_preserves_distinct_unicode_filenames() {
        let directory = TestDir::new();
        for (actual, alias) in [("Ä.srt", "ä.srt"), ("Σ.srt", "σ.srt")] {
            let path = directory.put(actual, b"same native file");
            let alias = directory.0.join(alias);
            assert_eq!(fs::canonicalize(&alias).unwrap(), path);
            let opened = locked_open(&alias, Some(&directory.0), false).unwrap();
            assert_eq!(opened.final_path, path);
        }
        for (first, second) in [("İ.srt", "i\u{0307}.srt"), ("ß.srt", "SS.srt")] {
            let first = directory.put(first, b"first");
            let second = directory.put(second, b"second");
            let first = fs::canonicalize(first).unwrap();
            let second = fs::canonicalize(second).unwrap();
            assert_ne!(first, second);
            assert_ne!(
                ordinal_compare(first.as_os_str(), second.as_os_str(), true),
                Ordering::Equal
            );
            assert_eq!(fs::read(first).unwrap(), b"first");
            assert_eq!(fs::read(second).unwrap(), b"second");
        }
        let (summary, events, _) = scan(&directory.0, options(false));
        assert_eq!(summary.added, 6);
        assert_eq!(summary.duplicates, 0);
        let names = names(&events);
        for name in ["İ.srt", "i\u{0307}.srt", "ß.srt", "SS.srt"] {
            assert!(names.contains(&name));
        }
    }

    #[test]
    fn queue_count_and_byte_budgets_include_existing_files_and_allow_later_smaller_files() {
        let directory = TestDir::new();
        directory.put("a.srt", b"1234");
        directory.put("b.srt", b"12");
        directory.put("c.srt", b"12");
        directory.put("d.srt", b"1");
        let mut selected = options(false);
        selected.existing_bytes = IMPORT_BATCH_LIMIT - 3;
        let (summary, events, _) = scan(&directory.0, selected);
        assert_eq!(names(&events), ["b.srt", "d.srt"]);
        assert_eq!(summary.over_limit, 2);
        assert_eq!(summary.added, 2);
        let mut selected = options(false);
        selected.existing_count = 99;
        let (summary, events, _) = scan(&directory.0, selected);
        assert_eq!(names(&events), ["a.srt"]);
        assert_eq!(summary.over_limit, 1);
        assert!(summary.limit_stopped);
    }

    #[test]
    fn native_batch_limit_is_independent_and_oversized_files_do_not_hide_valid_empty_files() {
        let directory = TestDir::new();
        let oversized = directory.put("large.srt", b"");
        File::options()
            .write(true)
            .open(oversized)
            .unwrap()
            .set_len(INPUT_LIMIT + 1)
            .unwrap();
        directory.put("small.srt", b"");
        let (summary, events, _) = scan(&directory.0, options(false));
        assert_eq!(summary.over_limit, 1);
        assert_eq!(names(&events), ["small.srt"]);
        assert!(events
            .iter()
            .filter_map(|event| event.file.as_ref())
            .all(|file| file.bytes.is_empty()));
        for index in 0..102 {
            directory.put(&format!("item-{index:03}.srt"), b"a");
        }
        let (summary, _, _) = scan(&directory.0, options(false));
        assert_eq!(summary.added, 100);
        assert!(summary.limit_stopped);
    }

    #[test]
    fn depth_and_entry_limits_bound_directory_work() {
        let directory = TestDir::new();
        let mut path = PathBuf::new();
        for _ in 0..8 {
            directory.put(&path.join("one.srt").to_string_lossy(), b"a");
            path.push("child");
        }
        let (summary, _, _) = scan(&directory.0, options(true));
        assert_eq!(summary.added, 6);
        assert_eq!(summary.depth_skipped, 1);
        let many = TestDir::new();
        for index in 0..2003 {
            many.put(&format!("ignored-{index}.log"), b"");
        }
        let (summary, _, _) = scan(&many.0, options(true));
        assert_eq!(summary.visited_entries, MAX_ENTRIES);
        assert!(summary.limit_stopped);
    }

    #[test]
    fn reparse_loops_and_outside_targets_are_skipped_and_same_handle_guards_replacement() {
        let directory = TestDir::new();
        let outside = TestDir::new();
        directory.put("valid.srt", b"inside");
        outside.put("private.srt", b"never read");
        junction(&directory.0.join("loop"), &directory.0);
        junction(&directory.0.join("outside"), &outside.0);
        let (summary, events, _) = scan(&directory.0, options(true));
        assert_eq!(summary.skipped_links, 2);
        assert_eq!(names(&events), ["valid.srt"]);
        assert!(matches!(
            locked_open(&outside.0.join("private.srt"), Some(&directory.0), false),
            Err(OpenFailure::Unsafe)
        ));

        let replace = directory.0.join("swapped");
        fs::create_dir(&replace).unwrap();
        assert!(fs::symlink_metadata(&replace).unwrap().is_dir());
        fs::remove_dir(&replace).unwrap();
        junction(&replace, &outside.0);
        assert!(matches!(
            locked_open(&replace, Some(&directory.0), true),
            Err(OpenFailure::Unsafe)
        ));
        let _root_lock = locked_open(&directory.0, None, true).unwrap();
        assert!(fs::rename(&directory.0, directory.0.with_extension("renamed")).is_err());
        let file = directory.0.join("valid.srt");
        let _file_lock = locked_open(&file, Some(&directory.0), false).unwrap();
        assert!(File::options().write(true).open(&file).is_err());
        assert!(fs::rename(&file, directory.0.join("changed.srt")).is_err());
    }

    #[test]
    fn locked_files_and_directories_report_failures_without_losing_later_inputs() {
        let directory = TestDir::new();
        let file = directory.put("a.srt", b"busy");
        directory.put("b.srt", b"valid");
        let subdirectory = directory.0.join("child");
        fs::create_dir(&subdirectory).unwrap();
        let _file_lock = File::options()
            .read(true)
            .share_mode(0)
            .open(&file)
            .unwrap();
        use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_BACKUP_SEMANTICS;
        let _directory_lock = File::options()
            .read(true)
            .share_mode(0)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
            .open(subdirectory)
            .unwrap();
        let (summary, events, _) = scan(&directory.0, options(true));
        assert_eq!(summary.failed, 1);
        assert_eq!(summary.unreadable_directories, 1);
        assert_eq!(names(&events), ["b.srt"]);
    }

    #[test]
    fn bounded_reads_discard_partial_bytes_on_cancellation_and_reject_growth() {
        let cancel = AtomicBool::new(false);
        assert!(matches!(
            read_bounded(&mut Cursor::new(b"1234"), 3, &cancel, || {}),
            Err(ReadFailure::TooLarge)
        ));
        struct Cancelling<'a>(&'a AtomicBool);
        impl Read for Cancelling<'_> {
            fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
                buffer[0] = b'a';
                self.0.store(true, AtomicOrdering::Relaxed);
                Ok(1)
            }
        }
        assert!(matches!(
            read_bounded(&mut Cancelling(&cancel), 100, &cancel, || {}),
            Err(ReadFailure::Cancelled)
        ));
    }

    #[test]
    fn cancellation_retains_delivered_files_and_disconnect_stops_following_reads() {
        let directory = TestDir::new();
        directory.put("a.srt", b"first");
        directory.put("b.srt", b"second");
        let access = FileAccess::default();
        let cancel = Arc::new(AtomicBool::new(false));
        let mut events = Vec::new();
        let mut send = |event: FolderEvent| {
            if event.file.is_some() {
                cancel.store(true, AtomicOrdering::Relaxed);
            }
            events.push(event);
            true
        };
        {
            let mut scanner = Scanner::new(options(false), &access, cancel.clone(), &mut send);
            scanner.walk(&directory.0, None, 0).unwrap();
            scanner.finish();
            assert_eq!(scanner.summary.added, 1);
            assert!(scanner.summary.cancelled);
        }
        assert_eq!(names(&events), ["a.srt"]);
        assert_eq!(events.last().unwrap().phase, "complete");
        let mut send = |event: FolderEvent| event.file.is_none();
        let mut scanner = Scanner::new(
            options(false),
            &access,
            Arc::new(AtomicBool::new(false)),
            &mut send,
        );
        scanner.walk(&directory.0, None, 0).unwrap();
        assert!(!scanner.finish());
        assert_eq!(scanner.summary.added, 0);
        assert_eq!(scanner.summary.cancelled_files, 1);
        assert!(scanner.summary.cancelled);
    }
}
