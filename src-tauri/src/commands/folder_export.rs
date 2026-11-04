//! Session-scoped, non-overwriting tree exports. All paths remain under a native selected root.
use super::{display_path, ensure_main, folder_import, safe_files, FileAccess, OUTPUT_LIMIT};
use folder_import::{
    locked_open, locked_output_directory, ordinal_compare, within, LockedEntry, OpenFailure,
};
use serde::{Deserialize, Serialize};
use std::{
    cmp::Ordering,
    collections::{HashMap, HashSet},
    ffi::OsStr,
    fs::{self, File},
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering as AtomicOrdering},
        Arc, Mutex,
    },
};
use tauri::{AppHandle, Manager, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

const MAX_ENTRIES: usize = 100;
const MAX_RELATIVE_UNITS: usize = 2048;
static GUARD_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExportEntry {
    id: String,
    relative_path: String,
    source_path: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedEntry {
    id: String,
    relative_path: String,
    renamed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedExport {
    export_id: String,
    directory: String,
    entries: Vec<PreparedEntry>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WrittenEntry {
    path: String,
    relative_path: String,
}

struct Session {
    root: PathBuf,
    // Keep every ancestor and checked existing/created child pinned until the session is finished.
    guards: Vec<LockedEntry>,
    // A locked child prevents an empty directory from becoming an in-place reparse point.
    // DELETE_ON_CLOSE also releases these guards after an unexpected process exit.
    sentinels: Vec<File>,
    entries: Vec<PreparedEntry>,
    completed: HashSet<String>,
    written_bytes: usize,
    reserved_directories: Vec<String>,
}

#[derive(Clone)]
struct ActiveExport {
    session: Arc<Mutex<Session>>,
    cancel: Arc<AtomicBool>,
}

#[derive(Clone, Default)]
pub struct FolderExports(Arc<Mutex<HashMap<String, ActiveExport>>>);

fn io_error(error: OpenFailure) -> String {
    match error {
        OpenFailure::Unsafe => "输出路径含链接、junction/reparse point 或已离开授权目录。".into(),
        OpenFailure::Io(error) => format!("无法锁定输出目录，请检查权限或文件占用：{error}"),
    }
}

fn same(left: &str, right: &str) -> bool {
    ordinal_compare(OsStr::new(left), OsStr::new(right), true) == Ordering::Equal
}

#[cfg(windows)]
fn directory_sentinel(directory: &Path) -> Result<File, String> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::{
        DELETE, FILE_ATTRIBUTE_HIDDEN, FILE_FLAG_DELETE_ON_CLOSE, FILE_GENERIC_READ,
        FILE_GENERIC_WRITE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    };
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let name = format!(
        ".srttools-output-{}-{nonce}-{}.guard",
        std::process::id(),
        GUARD_SEQUENCE.fetch_add(1, AtomicOrdering::Relaxed)
    );
    fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .access_mode(FILE_GENERIC_READ | FILE_GENERIC_WRITE | DELETE)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_DELETE_ON_CLOSE | FILE_ATTRIBUTE_HIDDEN)
        .open(directory.join(name))
        .map_err(|error| format!("无法创建会话目录保护，请检查输出权限：{error}"))
}

#[cfg(not(windows))]
fn directory_sentinel(_directory: &Path) -> Result<File, String> {
    Err("目录输出需要 Windows 桌面环境。".into())
}

fn validate_component(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value == "."
        || value == ".."
        || value.encode_utf16().count() > 220
        || value.ends_with(['.', ' '])
        || value
            .chars()
            .any(|c| c.is_control() || "<>:\"/\\|?*".contains(c))
    {
        return Err("输出路径包含不安全或过长的目录/文件名。".into());
    }
    let base = value
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    let device = base
        .strip_prefix("COM")
        .or_else(|| base.strip_prefix("LPT"));
    if ["CON", "PRN", "AUX", "NUL"].contains(&base.as_str())
        || matches!(
            device,
            Some("1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³")
        )
    {
        return Err("输出路径包含 Windows 保留名称。".into());
    }
    Ok(())
}

fn prefix(parent: &str, child: &str) -> bool {
    let parent: Vec<_> = parent.split('/').collect();
    let child: Vec<_> = child.split('/').collect();
    parent.len() < child.len()
        && parent
            .iter()
            .zip(child)
            .all(|(left, right)| same(left, right))
}

fn checked_relative(value: &str) -> Result<PathBuf, String> {
    if value.is_empty() || value.encode_utf16().count() > MAX_RELATIVE_UNITS || value.contains('\\')
    {
        return Err("输出相对路径无效或超过 2048 个 UTF-16 单元。".into());
    }
    let parts: Vec<_> = value.split('/').collect();
    if parts.len() > 10 {
        return Err("输出路径层级过深。".into());
    }
    for part in &parts {
        validate_component(part)?;
    }
    safe_files::validate_name(parts.last().ok_or("输出文件名无效。")?)?;
    let path = PathBuf::from(value);
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("输出仅接受安全相对路径。".into());
    }
    Ok(path)
}

fn validate_entries(entries: &[ExportEntry], access: &FileAccess) -> Result<Vec<PathBuf>, String> {
    if entries.is_empty() || entries.len() > MAX_ENTRIES {
        return Err("目录输出需要 1 至 100 个结果。".into());
    }
    let mut ids = HashSet::new();
    let mut paths: Vec<&str> = Vec::new();
    let mut roots = Vec::new();
    for entry in entries {
        if entry.id.is_empty()
            || entry.id.len() > 200
            || !ids.insert(&entry.id)
            || entry.source_path.encode_utf16().count() > 32767
        {
            return Err("目录输出项目标识或源路径无效。".into());
        }
        checked_relative(&entry.relative_path)?;
        if paths.iter().any(|path| {
            same(path, &entry.relative_path)
                || prefix(path, &entry.relative_path)
                || prefix(&entry.relative_path, path)
        }) {
            return Err("输出计划含重复路径或文件/目录冲突。".into());
        }
        paths.push(&entry.relative_path);
        roots.push(access.approved_source_root(&entry.source_path)?);
    }
    Ok(roots)
}

fn lock_root(
    path: &Path,
    source_roots: &[PathBuf],
) -> Result<(PathBuf, Vec<LockedEntry>, File), String> {
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir | Component::CurDir))
    {
        return Err("请使用原生选择器选择完整输出目录。".into());
    }
    let mut strong_guards = Vec::new();
    let ancestors: Vec<_> = path
        .ancestors()
        .filter(|path| !path.as_os_str().is_empty())
        .collect();
    for ancestor in ancestors.into_iter().rev() {
        strong_guards.push(locked_open(ancestor, None, true).map_err(io_error)?);
    }
    let root = strong_guards
        .last()
        .ok_or("输出目录无效。")?
        .final_path
        .clone();
    if source_roots
        .iter()
        .any(|source| within(source, &root) || within(&root, source))
    {
        return Err(
            "输出目录与源目录重叠（相同、包含或被包含）。请选择独立目录，源文件不会被覆盖。".into(),
        );
    }
    let sentinel = directory_sentinel(&root)?;
    // Ancestors contain pinned children, the final root contains sentinel: none can become empty.
    let guards = strong_guards
        .iter()
        .map(|guard| locked_output_directory(&guard.final_path, None).map_err(io_error))
        .collect::<Result<Vec<_>, _>>()?;
    drop(strong_guards);
    Ok((root, guards, sentinel))
}

impl Session {
    fn parent(&mut self, relative: &Path, create: bool) -> Result<Option<PathBuf>, String> {
        let mut directory = self.root.clone();
        if let Some(parent) = relative.parent() {
            for part in parent.components() {
                directory.push(part);
                if self
                    .guards
                    .iter()
                    .any(|guard| guard.final_path == directory)
                {
                    continue;
                }
                match fs::symlink_metadata(&directory) {
                    Ok(_) => (),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                        if !create {
                            return Ok(None);
                        }
                        match fs::create_dir(&directory) {
                            Ok(()) => (),
                            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => (),
                            Err(error) => return Err(format!("无法创建输出子目录：{error}")),
                        }
                    }
                    Err(error) => return Err(format!("无法检查输出子目录：{error}")),
                }
                let strong = locked_open(&directory, Some(&self.root), true).map_err(io_error)?;
                let sentinel = directory_sentinel(&strong.final_path)?;
                let guard = locked_output_directory(&strong.final_path, Some(&self.root))
                    .map_err(io_error)?;
                if !within(&directory, &guard.final_path) || !within(&guard.final_path, &directory)
                {
                    return Err("输出子目录位置已改变，请重新选择目录。".into());
                }
                directory = guard.final_path.clone();
                self.guards.push(guard);
                self.sentinels.push(sentinel);
                drop(strong);
            }
        }
        Ok(Some(directory))
    }

    fn available_name(
        &self,
        relative: &str,
        except_id: &str,
        parent_exists: bool,
    ) -> Result<String, String> {
        let relative = checked_relative(relative)?;
        let parent = relative.parent().unwrap_or_else(|| Path::new(""));
        let name = relative
            .file_name()
            .ok_or("输出文件名无效。")?
            .to_string_lossy();
        let source = Path::new(name.as_ref());
        let stem = source.file_stem().unwrap_or_default().to_string_lossy();
        let extension = source.extension().unwrap_or_default().to_string_lossy();
        for index in 0..10_000 {
            let name = if index == 0 {
                name.to_string()
            } else {
                let suffix = format!(" ({index}).{extension}");
                let mut base = String::new();
                let mut units = 0;
                for c in stem.chars() {
                    if units + c.len_utf16() + suffix.encode_utf16().count() > 220 {
                        break;
                    }
                    base.push(c);
                    units += c.len_utf16();
                }
                format!("{base}{suffix}")
            };
            let candidate = parent.join(&name);
            let display = candidate
                .components()
                .map(|p| p.as_os_str().to_string_lossy())
                .collect::<Vec<_>>()
                .join("/");
            if self
                .entries
                .iter()
                .any(|entry| entry.id != except_id && same(&entry.relative_path, &display))
                || self
                    .reserved_directories
                    .iter()
                    .any(|directory| same(directory, &display))
            {
                continue;
            }
            // An absent parent has not been pinned. Never stat through it if another process races
            // a junction into the missing tree; the write phase will create and pin each component.
            if !parent_exists {
                return Ok(display);
            }
            match fs::symlink_metadata(self.root.join(&candidate)) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(display),
                Ok(_) => (),
                Err(error) => return Err(format!("无法检查重名文件：{error}")),
            }
        }
        Err("同名文件过多，请更换输出目录。".into())
    }
}

impl FolderExports {
    fn prepare(
        &self,
        export_id: &str,
        path: &Path,
        entries: Vec<ExportEntry>,
        access: &FileAccess,
    ) -> Result<PreparedExport, String> {
        if !folder_import::valid_id(export_id) {
            return Err("目录导出会话标识无效。".into());
        }
        let roots = validate_entries(&entries, access)?;
        let mut active = self.0.lock().map_err(|_| "目录导出状态异常。")?;
        if !active.is_empty() {
            return Err("已有目录导出正在进行，请先完成或取消。".into());
        }
        let (root, guards, sentinel) = lock_root(path, &roots)?;
        let mut reserved_directories = Vec::new();
        for entry in &entries {
            let parts: Vec<_> = entry.relative_path.split('/').collect();
            for count in 1..parts.len() {
                reserved_directories.push(parts[..count].join("/"));
            }
        }
        let mut session = Session {
            root,
            guards,
            sentinels: vec![sentinel],
            entries: Vec::new(),
            completed: HashSet::new(),
            written_bytes: 0,
            reserved_directories,
        };
        for entry in entries {
            let mut prepared = PreparedEntry {
                id: entry.id,
                relative_path: entry.relative_path,
                renamed: false,
                error: None,
            };
            match checked_relative(&prepared.relative_path)
                .and_then(|relative| session.parent(&relative, false))
                .and_then(|parent| {
                    session.available_name(&prepared.relative_path, &prepared.id, parent.is_some())
                }) {
                Ok(path) => {
                    prepared.renamed = path != prepared.relative_path;
                    prepared.relative_path = path;
                }
                Err(error) => prepared.error = Some(error),
            }
            session.entries.push(prepared);
        }
        let prepared = PreparedExport {
            export_id: export_id.into(),
            directory: display_path(&session.root),
            entries: session.entries.clone(),
        };
        active.insert(
            export_id.to_ascii_lowercase(),
            ActiveExport {
                session: Arc::new(Mutex::new(session)),
                cancel: Arc::new(AtomicBool::new(false)),
            },
        );
        Ok(prepared)
    }

    fn find(&self, id: &str) -> Result<ActiveExport, String> {
        if !folder_import::valid_id(id) {
            return Err("目录导出会话标识无效。".into());
        }
        self.0
            .lock()
            .map_err(|_| "目录导出状态异常。")?
            .get(&id.to_ascii_lowercase())
            .cloned()
            .ok_or_else(|| "目录导出会话已结束，请重新选择目录。".into())
    }

    fn write(&self, export_id: &str, id: &str, bytes: &[u8]) -> Result<WrittenEntry, String> {
        let active = self.find(export_id)?;
        let mut session = active.session.lock().map_err(|_| "目录导出状态异常。")?;
        if active.cancel.load(AtomicOrdering::Relaxed) {
            return Err("目录导出已取消。".into());
        }
        if bytes.len() > OUTPUT_LIMIT.saturating_sub(session.written_bytes) {
            return Err("本次导出内容超过 256 MiB，请分批导出。".into());
        }
        if session.completed.contains(id) {
            return Err("此结果已成功导出，不会重复写入。".into());
        }
        let entry = session
            .entries
            .iter()
            .find(|entry| entry.id == id)
            .cloned()
            .ok_or("此文件不在本次确认的输出计划中。")?;
        if let Some(error) = entry.error {
            return Err(error);
        }
        let relative = checked_relative(&entry.relative_path)?;
        if session
            .root
            .join(&relative)
            .to_string_lossy()
            .encode_utf16()
            .count()
            > 32760
        {
            return Err(
                "完整输出路径超过 Windows 32760 个 UTF-16 单元限制，请选择更短目录。".into(),
            );
        }
        let parent = session.parent(&relative, true)?.ok_or("输出子目录无效。")?;
        let name = relative
            .file_name()
            .ok_or("输出文件名无效。")?
            .to_string_lossy();
        let written =
            safe_files::write_unique_cancellable(&parent, &name, bytes, Some(&active.cancel))
                .map_err(|error| format!("目录导出失败，已成功文件保留：{error}"))?;
        let relative_path = written
            .strip_prefix(&session.root)
            .map_err(|_| "输出路径离开授权目录。")?
            .components()
            .map(|component| component.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/");
        session.completed.insert(id.to_owned());
        session.written_bytes += bytes.len();
        Ok(WrittenEntry {
            path: display_path(&written),
            relative_path,
        })
    }

    fn finish(&self, id: &str) -> Result<(), String> {
        if !folder_import::valid_id(id) {
            return Err("目录导出会话标识无效。".into());
        }
        let active = self
            .0
            .lock()
            .map_err(|_| "目录导出状态异常。")?
            .remove(&id.to_ascii_lowercase());
        if let Some(active) = active {
            active.cancel.store(true, AtomicOrdering::Relaxed);
            // Wait for a current atomic publication or cancelled staged write to release its handles.
            drop(active.session.lock().map_err(|_| "目录导出状态异常。")?);
        }
        Ok(())
    }
}

#[tauri::command]
pub async fn prepare_folder_export(
    app: AppHandle,
    window: WebviewWindow,
    export_id: String,
    directory: Option<String>,
    entries: Vec<ExportEntry>,
) -> Result<Option<PreparedExport>, String> {
    ensure_main(&window)?;
    // Validate all source grants and paths before showing a chooser or touching output directories.
    validate_entries(&entries, &app.state::<FileAccess>())?;
    tauri::async_runtime::spawn_blocking(move || {
        let access = app.state::<FileAccess>();
        let path = if let Some(directory) = directory.filter(|value| !value.trim().is_empty()) {
            let hint = PathBuf::from(directory);
            let canonical = fs::canonicalize(&hint).ok();
            if canonical
                .as_ref()
                .is_some_and(|path| access.can_write_directory(path))
            {
                hint
            } else {
                let Some(selected) = app
                    .dialog()
                    .file()
                    .set_title("选择独立输出文件夹（不覆盖源文件）")
                    .set_directory(&hint)
                    .blocking_pick_folder()
                else {
                    return Ok(None);
                };
                selected
                    .into_path()
                    .map_err(|error| format!("输出目录无效：{error}"))?
            }
        } else {
            let Some(selected) = app
                .dialog()
                .file()
                .set_title("选择独立输出文件夹（不覆盖源文件）")
                .blocking_pick_folder()
            else {
                return Ok(None);
            };
            selected
                .into_path()
                .map_err(|error| format!("输出目录无效：{error}"))?
        };
        let result = app
            .state::<FolderExports>()
            .prepare(&export_id, &path, entries, &access)?;
        // Grant only this exact selected root for opening the result directory, never all descendants.
        if let Err(error) = access.approve_directory(&path) {
            app.state::<FolderExports>().finish(&export_id)?;
            return Err(error);
        }
        Ok(Some(result))
    })
    .await
    .map_err(|_| "目录导出准备任务未能完成。".to_owned())?
}

#[tauri::command]
pub async fn write_folder_export(
    app: AppHandle,
    window: WebviewWindow,
    export_id: String,
    id: String,
    bytes: Vec<u8>,
) -> Result<WrittenEntry, String> {
    ensure_main(&window)?;
    if bytes.len() > OUTPUT_LIMIT {
        return Err("导出内容超过 256 MiB，请分批导出。".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<FolderExports>().write(&export_id, &id, &bytes)
    })
    .await
    .map_err(|_| "目录写入任务未能完成。".to_owned())?
}

#[tauri::command]
pub async fn finish_folder_export(
    app: AppHandle,
    window: WebviewWindow,
    export_id: String,
) -> Result<(), String> {
    ensure_main(&window)?;
    tauri::async_runtime::spawn_blocking(move || app.state::<FolderExports>().finish(&export_id))
        .await
        .map_err(|_| "目录导出结束任务未能完成。".to_owned())?
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::{
        os::windows::fs::OpenOptionsExt,
        time::{SystemTime, UNIX_EPOCH},
    };
    const ID: &str = "05633f59-8738-44ad-ae7a-f39a109a05ca";

    struct Fixture {
        root: PathBuf,
        input: PathBuf,
        output: PathBuf,
        source: PathBuf,
        access: FileAccess,
    }
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "srttools-tree-export-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            let input = root.join("输入 字幕 🐱");
            let output = root.join("输出");
            fs::create_dir_all(&input).unwrap();
            fs::create_dir(&output).unwrap();
            let source = input.join("source.srt");
            fs::write(&source, b"original subtitle").unwrap();
            let access = FileAccess::default();
            access.approve_dropped(std::slice::from_ref(&source));
            Self {
                root: fs::canonicalize(&root).unwrap(),
                input: fs::canonicalize(&input).unwrap(),
                output: fs::canonicalize(&output).unwrap(),
                source: fs::canonicalize(&source).unwrap(),
                access,
            }
        }
        fn entry(&self, id: &str, relative: &str) -> ExportEntry {
            ExportEntry {
                id: id.into(),
                relative_path: relative.into(),
                source_path: display_path(&self.source),
            }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn paths_reject_windows_injection_traversal_devices_and_unicode_prefix_panics() {
        for value in [
            "../bad.srt",
            "a/../bad.srt",
            "a\\bad.srt",
            "/bad.srt",
            "C:/bad.srt",
            "//server/bad.srt",
            "a//bad.srt",
            "a/./bad.srt",
            "a./b.srt",
            "CON/b.srt",
            "NUL.srt",
            "COM¹/b.srt",
            "foo:stream/b.srt",
            "a/b.exe",
            "a\u{7f}/b.srt",
        ] {
            assert!(
                checked_relative(value).is_err(),
                "unexpected allowed path {value}"
            );
        }
        assert!(checked_relative("中文字幕/繁體 😀/a.srt").is_ok());
        assert!(checked_relative(&format!("{}/a.srt", "字".repeat(220))).is_ok());
        assert!(checked_relative(&format!("{}/a.srt", "字".repeat(221))).is_err());
        let fixture = Fixture::new();
        let entries = vec![
            fixture.entry("1", "测试😀.srt"),
            fixture.entry("2", "测试a.srt"),
        ];
        assert!(validate_entries(&entries, &fixture.access).is_ok());
        let entries = vec![
            fixture.entry("1", "目录.srt"),
            fixture.entry("2", "目录.srt/下一集.srt"),
        ];
        assert!(validate_entries(&entries, &fixture.access).is_err());
        let entries = vec![fixture.entry("1", "A.srt"), fixture.entry("2", "a.srt")];
        assert!(validate_entries(&entries, &fixture.access).is_err());
    }

    #[test]
    fn only_concrete_import_grants_and_one_native_scoped_session_can_write() {
        let fixture = Fixture::new();
        let exports = FolderExports::default();
        let mut entry = fixture.entry("1", "sub/result.srt");
        entry.source_path = "C:\\private\\never-read.srt".into();
        assert!(exports
            .prepare(ID, &fixture.output, vec![entry], &fixture.access)
            .is_err());
        assert_eq!(fs::read_dir(&fixture.output).unwrap().count(), 0);
        exports
            .prepare(
                ID,
                &fixture.output,
                vec![fixture.entry("1", "sub/result.srt")],
                &fixture.access,
            )
            .unwrap();
        assert!(exports
            .prepare(
                "05633f59-8738-44ad-ae7a-f39a109a05cb",
                &fixture.output,
                vec![fixture.entry("2", "x.srt")],
                &fixture.access
            )
            .is_err());
        assert!(exports.write(ID, "unconfirmed", b"never write").is_err());
        exports.finish(ID).unwrap();
        exports.finish(ID).unwrap();
        assert!(exports.write(ID, "1", b"ended").is_err());
        assert_eq!(fs::read_dir(&fixture.output).unwrap().count(), 0);
    }

    #[test]
    fn nested_unicode_tree_is_atomic_non_overwriting_and_retains_source_and_completed_items() {
        let fixture = Fixture::new();
        let exports = FolderExports::default();
        fs::create_dir_all(fixture.output.join("剧集/S01/繁體 😀")).unwrap();
        fs::write(
            fixture.output.join("剧集/S01/繁體 😀/E01.srt"),
            b"prior export",
        )
        .unwrap();
        let plan = exports
            .prepare(
                ID,
                &fixture.output,
                vec![
                    fixture.entry("one", "剧集/S01/繁體 😀/E01.srt"),
                    fixture.entry("two", "第一/二/三/四/五/E02.srt"),
                ],
                &fixture.access,
            )
            .unwrap();
        assert!(plan.entries[0].renamed);
        assert_eq!(
            plan.entries[0].relative_path,
            "剧集/S01/繁體 😀/E01 (1).srt"
        );
        let first = exports.write(ID, "one", b"new first").unwrap();
        assert_eq!(fs::read(&first.path).unwrap(), b"new first");
        assert!(exports.write(ID, "one", b"duplicate attempt").is_err());
        let second = exports.write(ID, "two", b"new second").unwrap();
        assert_eq!(second.relative_path, "第一/二/三/四/五/E02.srt");
        exports.finish(ID).unwrap();
        assert_eq!(
            fs::read(fixture.output.join("剧集/S01/繁體 😀/E01.srt")).unwrap(),
            b"prior export"
        );
        assert_eq!(fs::read(&fixture.source).unwrap(), b"original subtitle");
        assert_eq!(fs::read(&second.path).unwrap(), b"new second");
        // Closing the session releases all directory handles.
        let moved = fixture.root.join("输出已释放");
        fs::rename(&fixture.output, &moved).unwrap();
        fs::rename(&moved, &fixture.output).unwrap();
    }

    #[test]
    fn overlapping_roots_and_locked_targets_are_rejected_before_output_creation() {
        let fixture = Fixture::new();
        let exports = FolderExports::default();
        let nested = fixture.input.join("子输出");
        fs::create_dir(&nested).unwrap();
        for path in [&fixture.input, &nested, &fixture.root] {
            assert!(exports
                .prepare(
                    ID,
                    path,
                    vec![fixture.entry("1", "result.srt")],
                    &fixture.access
                )
                .unwrap_err()
                .contains("重叠"));
        }
        let lock = fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_BACKUP_SEMANTICS)
            .open(&fixture.output)
            .unwrap();
        assert!(exports
            .prepare(
                ID,
                &fixture.output,
                vec![fixture.entry("1", "result.srt")],
                &fixture.access
            )
            .is_err());
        drop(lock);
        assert_eq!(fs::read_dir(&fixture.output).unwrap().count(), 0);
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
            "could not create owned junction fixture"
        );
    }

    #[test]
    fn reparse_roots_and_children_are_never_followed_and_other_files_continue() {
        let fixture = Fixture::new();
        let exports = FolderExports::default();
        let outside = fixture.root.join("目录外");
        fs::create_dir(&outside).unwrap();
        let link = fixture.output.join("跳转");
        junction(&link, &outside);
        let plan = exports
            .prepare(
                ID,
                &fixture.output,
                vec![
                    fixture.entry("unsafe", "跳转/escape.srt"),
                    fixture.entry("safe", "real/safe.srt"),
                ],
                &fixture.access,
            )
            .unwrap();
        assert!(plan.entries[0].error.as_ref().unwrap().contains("链接"));
        assert!(exports.write(ID, "unsafe", b"escaped").is_err());
        exports.write(ID, "safe", b"safe").unwrap();
        exports.finish(ID).unwrap();
        assert_eq!(fs::read_dir(&outside).unwrap().count(), 0);
        assert_eq!(
            fs::read(fixture.output.join("real/safe.srt")).unwrap(),
            b"safe"
        );
        assert!(exports
            .prepare(
                ID,
                &link,
                vec![fixture.entry("1", "escape.srt")],
                &fixture.access
            )
            .is_err());
        fs::remove_dir(&link).unwrap();
    }

    #[test]
    fn pinned_parents_cannot_be_replaced_and_newly_raced_targets_are_preserved() {
        let fixture = Fixture::new();
        let exports = FolderExports::default();
        fs::create_dir(fixture.output.join("child")).unwrap();
        exports
            .prepare(
                ID,
                &fixture.output,
                vec![fixture.entry("1", "child/result.srt")],
                &fixture.access,
            )
            .unwrap();
        assert!(fs::rename(fixture.output.join("child"), fixture.output.join("moved")).is_err());
        fs::write(fixture.output.join("child/result.srt"), b"raced prior file").unwrap();
        let written = exports.write(ID, "1", b"new result").unwrap();
        assert_eq!(written.relative_path, "child/result (1).srt");
        assert_eq!(
            fs::read(fixture.output.join("child/result.srt")).unwrap(),
            b"raced prior file"
        );
        exports.finish(ID).unwrap();
    }

    #[test]
    fn failure_and_cancel_preserve_successes_and_fresh_retry_does_not_replace_them() {
        let fixture = Fixture::new();
        let exports = FolderExports::default();
        fs::write(fixture.output.join("blocked"), b"existing user file").unwrap();
        let plan = exports
            .prepare(
                ID,
                &fixture.output,
                vec![
                    fixture.entry("ok", "success.srt"),
                    fixture.entry("bad", "blocked/result.srt"),
                    fixture.entry("cancelled", "cancelled.srt"),
                ],
                &fixture.access,
            )
            .unwrap();
        assert!(plan.entries[1].error.is_some());
        exports.write(ID, "ok", b"success").unwrap();
        assert!(exports.write(ID, "bad", b"bad").is_err());
        exports.finish(ID).unwrap();
        assert!(exports.write(ID, "cancelled", b"cancelled").is_err());
        assert!(!fixture.output.join("cancelled.srt").exists());
        exports
            .prepare(
                ID,
                &fixture.output,
                vec![fixture.entry("bad", "recovered/result.srt")],
                &fixture.access,
            )
            .unwrap();
        exports.write(ID, "bad", b"retried").unwrap();
        exports.finish(ID).unwrap();
        assert_eq!(
            fs::read(fixture.output.join("success.srt")).unwrap(),
            b"success"
        );
        assert_eq!(
            fs::read(fixture.output.join("recovered/result.srt")).unwrap(),
            b"retried"
        );
        assert_eq!(
            fs::read(fixture.output.join("blocked")).unwrap(),
            b"existing user file"
        );
    }

    #[test]
    fn source_roots_are_native_derived_stable_and_multi_root_overlap_checks_cover_every_root() {
        let fixture = Fixture::new();
        let first = fixture
            .access
            .approve_folder_source(fixture.source.clone(), &fixture.input, ID)
            .unwrap();
        let repeated = fixture
            .access
            .approve_folder_source(
                fixture.source.clone(),
                &fixture.input,
                "05633f59-8738-44ad-ae7a-f39a109a05cb",
            )
            .unwrap();
        assert_eq!(first.root_id, repeated.root_id);
        assert_eq!(first.relative_path, "source.srt");
        assert!(first.root_name.contains("输入"));
        let second_root = fixture.root.join("其他输入");
        fs::create_dir(&second_root).unwrap();
        let second = second_root.join("other.srt");
        fs::write(&second, b"other").unwrap();
        let second = fs::canonicalize(second).unwrap();
        fixture
            .access
            .approve_folder_source(
                second.clone(),
                &fs::canonicalize(&second_root).unwrap(),
                "05633f59-8738-44ad-ae7a-f39a109a05cb",
            )
            .unwrap();
        let mut second_entry = fixture.entry("2", "second/other.srt");
        second_entry.source_path = display_path(&second);
        let exports = FolderExports::default();
        assert!(exports
            .prepare(
                ID,
                &second_root,
                vec![fixture.entry("1", "first/source.srt"), second_entry],
                &fixture.access
            )
            .unwrap_err()
            .contains("重叠"));
        assert_eq!(fs::read(&fixture.source).unwrap(), b"original subtitle");
        assert_eq!(fs::read(&second).unwrap(), b"other");
    }

    #[test]
    fn total_output_budget_and_entry_count_are_enforced_without_reading_or_writing_large_inputs() {
        let fixture = Fixture::new();
        let exports = FolderExports::default();
        let excessive: Vec<_> = (0..101)
            .map(|index| fixture.entry(&index.to_string(), &format!("{index}.srt")))
            .collect();
        assert!(exports
            .prepare(ID, &fixture.output, excessive, &fixture.access)
            .unwrap_err()
            .contains("100"));
        exports
            .prepare(
                ID,
                &fixture.output,
                vec![fixture.entry("1", "one.srt"), fixture.entry("2", "two.srt")],
                &fixture.access,
            )
            .unwrap();
        exports
            .find(ID)
            .unwrap()
            .session
            .lock()
            .unwrap()
            .written_bytes = OUTPUT_LIMIT - 1;
        assert!(exports
            .write(ID, "1", b"ab")
            .unwrap_err()
            .contains("256 MiB"));
        assert!(!fixture.output.join("one.srt").exists());
        exports.write(ID, "2", b"x").unwrap();
        assert!(exports.write(ID, "1", b"y").is_err());
        exports.finish(ID).unwrap();
        assert_eq!(fs::read(fixture.output.join("two.srt")).unwrap(), b"x");
        assert_eq!(fs::read(&fixture.source).unwrap(), b"original subtitle");
    }

    #[test]
    fn cancellation_flag_aborts_staging_and_session_finish_releases_pinned_handles() {
        let fixture = Fixture::new();
        let exports = FolderExports::default();
        exports
            .prepare(
                ID,
                &fixture.output,
                vec![fixture.entry("1", "cancelled.srt")],
                &fixture.access,
            )
            .unwrap();
        let active = exports.find(ID).unwrap();
        active.cancel.store(true, AtomicOrdering::Relaxed);
        assert!(exports
            .write(ID, "1", b"cancelled")
            .unwrap_err()
            .contains("取消"));
        // Also prove the low-level staged writer cannot publish when cancellation is already set.
        assert!(safe_files::write_unique_cancellable(
            &fixture.output,
            "partial.srt",
            &vec![1u8; 128 * 1024],
            Some(&active.cancel)
        )
        .is_err());
        assert!(fs::read_dir(&fixture.output).unwrap().all(|entry| entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .ends_with(".guard")));
        drop(active);
        exports.finish(ID).unwrap();
        assert_eq!(fs::read_dir(&fixture.output).unwrap().count(), 0);
        let moved = fixture.root.join("释放");
        fs::rename(&fixture.output, &moved).unwrap();
        fs::rename(moved, &fixture.output).unwrap();
    }

    #[test]
    fn finish_cancels_observed_in_flight_io_without_publishing_partial_output_and_allows_retry() {
        use std::{
            io,
            os::windows::io::AsRawHandle,
            thread,
            time::{Duration, Instant},
        };
        use windows_sys::Win32::{
            Foundation::ERROR_IO_INCOMPLETE,
            Storage::FileSystem::{
                ReadDirectoryChangesW, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OVERLAPPED,
                FILE_NOTIFY_CHANGE_FILE_NAME, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
            },
            System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED},
        };

        // Queue the real directory notification before starting the writer. A pending OVERLAPPED
        // request, rather than a sleep or a writer test hook, establishes observer readiness.
        struct DirectoryWatch {
            directory: File,
            overlapped: Box<OVERLAPPED>,
            _buffer: Vec<u32>, // DWORD alignment and lifetime are required by ReadDirectoryChangesW.
            pending: bool,
        }
        impl DirectoryWatch {
            fn new(path: &Path) -> io::Result<Self> {
                let directory = fs::OpenOptions::new()
                    .read(true)
                    .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
                    .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OVERLAPPED)
                    .open(path)?;
                let mut watch = Self {
                    directory,
                    overlapped: Box::new(unsafe { std::mem::zeroed() }),
                    _buffer: vec![0; 4096],
                    pending: false,
                };
                let queued = unsafe {
                    ReadDirectoryChangesW(
                        watch.directory.as_raw_handle(),
                        watch._buffer.as_mut_ptr().cast(),
                        (watch._buffer.len() * 4) as u32,
                        0,
                        FILE_NOTIFY_CHANGE_FILE_NAME,
                        std::ptr::null_mut(),
                        watch.overlapped.as_mut(),
                        None,
                    )
                };
                if queued == 0 {
                    return Err(io::Error::last_os_error());
                }
                watch.pending = true;
                assert!(
                    !watch.signaled()?,
                    "directory notification was not pending before writer start"
                );
                Ok(watch)
            }
            fn signaled(&mut self) -> io::Result<bool> {
                let mut transferred = 0;
                let result = unsafe {
                    GetOverlappedResult(
                        self.directory.as_raw_handle(),
                        self.overlapped.as_ref(),
                        &mut transferred,
                        0,
                    )
                };
                if result != 0 {
                    self.pending = false;
                    return Ok(true);
                }
                let error = io::Error::last_os_error();
                if error.raw_os_error() == Some(ERROR_IO_INCOMPLETE as i32) {
                    Ok(false)
                } else {
                    Err(error)
                }
            }
        }
        impl Drop for DirectoryWatch {
            fn drop(&mut self) {
                if self.pending {
                    // An observation failure must also cancel/drain native IO before its buffer drops.
                    unsafe {
                        CancelIoEx(self.directory.as_raw_handle(), self.overlapped.as_ref());
                        let mut transferred = 0;
                        GetOverlappedResult(
                            self.directory.as_raw_handle(),
                            self.overlapped.as_ref(),
                            &mut transferred,
                            1,
                        );
                    }
                }
            }
        }

        const LARGE_BYTES: usize = 128 * 1024 * 1024;
        let fixture = Fixture::new();
        let exports = FolderExports::default();
        exports
            .prepare(
                ID,
                &fixture.output,
                vec![
                    fixture.entry("retained", "retained.srt"),
                    fixture.entry("in-flight", "in-flight.srt"),
                ],
                &fixture.access,
            )
            .unwrap();
        exports
            .write(ID, "retained", b"prior complete result")
            .unwrap();
        // Allocate before arming the observer so a pending watch directly precedes actual file IO.
        let bytes = vec![0x5au8; LARGE_BYTES];
        let mut watch = DirectoryWatch::new(&fixture.output).unwrap();
        let writer_exports = exports.clone();
        let writer = thread::spawn(move || writer_exports.write(ID, "in-flight", &bytes));
        let deadline = Instant::now() + Duration::from_secs(10);
        let observed = (|| -> Result<u64, String> {
            while !watch.signaled().map_err(|error| error.to_string())? {
                if writer.is_finished() {
                    return Err("writer finished before staged creation was observed".into());
                }
                if Instant::now() >= deadline {
                    return Err("timed out waiting for staged creation notification".into());
                }
                thread::yield_now();
            }
            loop {
                for entry in fs::read_dir(&fixture.output).map_err(|error| error.to_string())? {
                    let entry = entry.map_err(|error| error.to_string())?;
                    let name = entry.file_name();
                    let name = name.to_string_lossy();
                    if name.starts_with(".subtitle-tools-") && name.ends_with(".tmp") {
                        // Enumeration can retain zero length until close. Query the live handle,
                        // sharing all modes so the observer cannot block publication or cleanup.
                        let observed_file = fs::OpenOptions::new()
                            .read(true)
                            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
                            .open(entry.path())
                            .map_err(|error| error.to_string())?;
                        let length = observed_file
                            .metadata()
                            .map_err(|error| error.to_string())?
                            .len();
                        if length >= 64 * 1024
                            && length < LARGE_BYTES as u64
                            && !writer.is_finished()
                        {
                            return Ok(length);
                        }
                    }
                }
                if writer.is_finished() {
                    return Err(
                        "writer finished without observing a partially written staged file".into(),
                    );
                }
                if Instant::now() >= deadline {
                    return Err("timed out waiting for the first completed 64 KiB write".into());
                }
                thread::yield_now();
            }
        })();
        let cancellation_started = Instant::now();
        // Always finish and join, including an observation failure; never leak test file IO/handles.
        let finish = exports.finish(ID);
        let result = writer.join().expect("real writer thread panicked");
        let cancel_elapsed = cancellation_started.elapsed();
        drop(watch);
        let observed_bytes = observed.expect("in-flight cancellation was not actually observed");
        finish.unwrap();
        let cancelled =
            result.expect_err("observed in-flight cancellation falsely reported success");
        assert!(
            cancelled.contains("取消"),
            "expected cancellation after {observed_bytes} bytes, got {cancelled}"
        );
        let remaining: Vec<_> = fs::read_dir(&fixture.output)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(
            remaining,
            [std::ffi::OsString::from("retained.srt")],
            "partial final/staging/guard files remain"
        );
        assert_eq!(
            fs::read(fixture.output.join("retained.srt")).unwrap(),
            b"prior complete result"
        );
        assert_eq!(fs::read(&fixture.source).unwrap(), b"original subtitle");
        let moved = fixture.root.join("released-after-in-flight-cancel");
        fs::rename(&fixture.output, &moved).unwrap();
        fs::rename(&moved, &fixture.output).unwrap();
        exports
            .prepare(
                ID,
                &fixture.output,
                vec![fixture.entry("in-flight", "in-flight.srt")],
                &fixture.access,
            )
            .unwrap();
        exports
            .write(ID, "in-flight", b"fresh retry completed")
            .unwrap();
        exports.finish(ID).unwrap();
        assert_eq!(
            fs::read(fixture.output.join("in-flight.srt")).unwrap(),
            b"fresh retry completed"
        );
        assert_eq!(
            fs::read(fixture.output.join("retained.srt")).unwrap(),
            b"prior complete result"
        );
        println!("real Windows staged IO cancellation: observed {observed_bytes}/{LARGE_BYTES} bytes; finish+join {} microseconds; retained result/source unchanged; no temporary or partial final; handles released; fresh retry passed", cancel_elapsed.as_micros());
    }

    #[test]
    fn non_deletable_sentinel_prevents_in_place_reparse_mutation_until_session_finishes() {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::{
            Storage::FileSystem::{
                FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ,
                FILE_SHARE_WRITE,
            },
            System::{Ioctl::FSCTL_SET_REPARSE_POINT, IO::DeviceIoControl},
        };
        let fixture = Fixture::new();
        let exports = FolderExports::default();
        let outside = fixture.root.join("不会越界");
        fs::create_dir(&outside).unwrap();
        exports
            .prepare(
                ID,
                &fixture.output,
                vec![fixture.entry("1", "result.srt")],
                &fixture.access,
            )
            .unwrap();
        let directory = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(&fixture.output)
            .unwrap();
        let substitute: Vec<u16> = format!(r"\??\{}", display_path(&outside))
            .encode_utf16()
            .collect();
        let print: Vec<u16> = display_path(&outside).encode_utf16().collect();
        let mut data = Vec::new();
        data.extend_from_slice(&0xa0000003u32.to_le_bytes()); // IO_REPARSE_TAG_MOUNT_POINT
        data.extend_from_slice(
            &((8 + (substitute.len() + print.len() + 2) * 2) as u16).to_le_bytes(),
        );
        data.extend_from_slice(&0u16.to_le_bytes());
        data.extend_from_slice(&0u16.to_le_bytes());
        data.extend_from_slice(&((substitute.len() * 2) as u16).to_le_bytes());
        data.extend_from_slice(&(((substitute.len() + 1) * 2) as u16).to_le_bytes());
        data.extend_from_slice(&((print.len() * 2) as u16).to_le_bytes());
        for character in substitute.into_iter().chain([0]).chain(print).chain([0]) {
            data.extend_from_slice(&character.to_le_bytes());
        }
        let set_reparse = || {
            let mut returned = 0;
            let result = unsafe {
                DeviceIoControl(
                    directory.as_raw_handle(),
                    FSCTL_SET_REPARSE_POINT,
                    data.as_ptr().cast(),
                    data.len() as u32,
                    std::ptr::null_mut(),
                    0,
                    &mut returned,
                    std::ptr::null_mut(),
                )
            };
            if result == 0 {
                Err(std::io::Error::last_os_error())
            } else {
                Ok(())
            }
        };
        let denied = set_reparse().unwrap_err();
        assert_eq!(
            denied.raw_os_error(),
            Some(145),
            "expected ERROR_DIR_NOT_EMPTY, got {denied}"
        );
        exports.finish(ID).unwrap();
        // Positive control: the exact same handle and buffer succeed after our guard is released.
        set_reparse().unwrap();
        drop(directory);
        assert_eq!(fs::read_dir(&outside).unwrap().count(), 0);
        fs::remove_dir(&fixture.output).unwrap();
    }
}
