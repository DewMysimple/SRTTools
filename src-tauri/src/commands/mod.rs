pub mod explorer;
pub mod folder_export;
pub mod folder_import;
pub mod preset_storage;
mod safe_files;
pub use folder_export::FolderExports;
pub use folder_import::FolderImports;

use serde::Serialize;
use serde_json::{Map, Value};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{AppHandle, Manager, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_store::{resolve_store_path, Error as StoreError, StoreExt};

const INPUT_LIMIT: u64 = 32 * 1024 * 1024;
const IMPORT_BATCH_LIMIT: u64 = 128 * 1024 * 1024;
const IMPORT_COUNT_LIMIT: usize = 100;
const OUTPUT_LIMIT: usize = 256 * 1024 * 1024;
const STORE_NAME: &str = "subtitle-tools.json";
const STORE_RECOVERY_NAME: &str = "subtitle-tools-recovery.json";
const PRESET_KEY: &str = "tool-presets-v1";
const PRESET_LIMIT: usize = 256 * 1024;
const WORKFLOW_KEY: &str = "workflow-presets-v1";
const WORKFLOW_LIMIT: usize = 512 * 1024;
static STORE_TRANSACTION: Mutex<()> = Mutex::new(());

fn display_path(path: &Path) -> String {
    let value = path.to_string_lossy();
    #[cfg(windows)]
    {
        // canonicalize uses Win32 extended paths, which are useful for IO but not Explorer/UI.
        if let Some(network) = value.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{network}");
        }
        if let Some(drive) = value.strip_prefix(r"\\?\") {
            return drive.to_owned();
        }
    }
    value.into_owned()
}

#[derive(Default)]
struct Grants {
    imports: HashSet<PathBuf>,
    directories: HashSet<PathBuf>,
    folder_roots: HashMap<String, PathBuf>,
    folder_files: HashMap<PathBuf, FolderSource>,
}

#[derive(Default)]
pub struct FileAccess(Mutex<Grants>);

impl FileAccess {
    fn approve_folder_file(&self, path: PathBuf) -> io::Result<()> {
        self.0
            .lock()
            .map_err(|_| io::Error::other("文件授权状态异常。"))?
            .imports
            .insert(path);
        Ok(())
    }

    fn approve_folder_source(
        &self,
        path: PathBuf,
        root: &Path,
        proposed_root_id: &str,
    ) -> io::Result<FolderSource> {
        let mut grants = self
            .0
            .lock()
            .map_err(|_| io::Error::other("文件授权状态异常。"))?;
        let root_id = grants
            .folder_roots
            .iter()
            .find_map(|(id, known)| {
                (folder_import::within(known, root) && folder_import::within(root, known))
                    .then(|| id.clone())
            })
            .unwrap_or_else(|| proposed_root_id.to_owned());
        let relative = path
            .strip_prefix(root)
            .map_err(|_| io::Error::other("源文件不在已选择目录中。"))?;
        let relative_path = relative
            .components()
            .map(|component| component.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/");
        let source = FolderSource {
            root_id: root_id.clone(),
            root_name: root
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| "字幕目录".into()),
            relative_path,
        };
        grants.folder_roots.insert(root_id, root.to_path_buf());
        grants.folder_files.insert(path.clone(), source.clone());
        grants.imports.insert(path);
        Ok(source)
    }

    fn folder_source(&self, path: &Path) -> Option<FolderSource> {
        self.0.lock().ok()?.folder_files.get(path).cloned()
    }

    /// Look up a renderer path only in concrete native import grants; never read arbitrary hints.
    fn approved_source_root(&self, source: &str) -> Result<PathBuf, String> {
        let grants = self.0.lock().map_err(|_| "文件授权状态异常。")?;
        let path = grants
            .imports
            .iter()
            .find(|path| {
                folder_import::ordinal_compare(
                    std::ffi::OsStr::new(&display_path(path)),
                    std::ffi::OsStr::new(source),
                    true,
                ) == std::cmp::Ordering::Equal
            })
            .ok_or("目录输出的源文件未经本次原生导入授权，请重新导入。")?;
        if let Some(source) = grants.folder_files.get(path) {
            return grants
                .folder_roots
                .get(&source.root_id)
                .cloned()
                .ok_or_else(|| "源目录会话已失效，请重新导入。".into());
        }
        path.parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| "源文件目录无效。".into())
    }

    pub fn approve_dropped(&self, paths: &[PathBuf]) {
        if let Ok(mut grants) = self.0.lock() {
            for path in paths {
                if let Ok(path) = fs::canonicalize(path) {
                    if path.is_file() {
                        grants.imports.insert(path);
                    }
                }
            }
        }
    }

    fn approve_directory(&self, path: &Path) -> Result<PathBuf, String> {
        let path = fs::canonicalize(path).map_err(|e| format!("无法访问输出目录：{e}"))?;
        if !path.is_dir() {
            return Err("请选择一个有效的文件夹。".into());
        }
        self.0
            .lock()
            .map_err(|_| "文件授权状态异常，请重新启动应用。")?
            .directories
            .insert(path.clone());
        Ok(path)
    }

    fn can_read(&self, path: &Path) -> bool {
        self.0
            .lock()
            .map(|grants| grants.imports.contains(path))
            .unwrap_or(false)
    }

    fn can_write_directory(&self, path: &Path) -> bool {
        self.0
            .lock()
            .map(|grants| grants.directories.contains(path))
            .unwrap_or(false)
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderSource {
    root_id: String,
    root_name: String,
    relative_path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedFile {
    name: String,
    path: String,
    bytes: Vec<u8>,
    size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    folder_source: Option<FolderSource>,
}

fn ensure_main(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("此窗口无权访问本地文件。".into())
    }
}

fn import_one(path: &Path, access: &FileAccess, remaining_bytes: u64) -> ImportedFile {
    let mut file = ImportedFile {
        name: path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        path: display_path(path),
        bytes: Vec::new(),
        size: 0,
        error: None,
        folder_source: None,
    };
    let result = (|| {
        let canonical = fs::canonicalize(path).map_err(|e| format!("无法读取文件：{e}"))?;
        if !access.can_read(&canonical) {
            return Err("请通过文件对话框选择文件，或将文件拖入应用后再读取。".into());
        }
        let metadata = fs::metadata(&canonical).map_err(|e| format!("无法读取文件信息：{e}"))?;
        file.size = metadata.len();
        if !metadata.is_file() {
            return Err("这里只支持文件，请不要添加文件夹。".into());
        }
        if file.size > INPUT_LIMIT {
            return Err("文件超过 32 MiB。请先拆分文件再导入，避免处理时内存不足。".into());
        }
        let extension = canonical
            .extension()
            .unwrap_or_default()
            .to_string_lossy()
            .to_ascii_lowercase();
        if !["srt", "vtt", "ass", "ssa", "txt", "csv"].contains(&extension.as_str()) {
            return Err("不支持此文件类型。请选择 SRT、VTT、ASS、SSA、TXT 或 CSV 文件。".into());
        }
        if file.size > remaining_bytes {
            return Err("本次导入的总内容超过 128 MiB，请分批选择文件。".into());
        }
        fs::File::open(&canonical)
            .and_then(|reader| {
                reader
                    .take(INPUT_LIMIT.min(remaining_bytes) + 1)
                    .read_to_end(&mut file.bytes)
            })
            .map_err(|e| format!("文件读取失败：{e}"))?;
        // Check again in case the file changed between metadata and read.
        if file.bytes.len() as u64 > INPUT_LIMIT {
            file.bytes.clear();
            return Err("读取时文件大小发生变化，已超过 32 MiB 限制。".into());
        }
        if file.bytes.len() as u64 > remaining_bytes {
            file.bytes.clear();
            return Err("读取时总内容超过 128 MiB 限制，请分批选择文件。".into());
        }
        file.path = display_path(&canonical);
        file.folder_source = access.folder_source(&canonical);
        Ok(())
    })();
    if let Err(error) = result {
        file.bytes.clear();
        file.error = Some(error);
    }
    file
}

fn import_many(paths: &[PathBuf], access: &FileAccess) -> Result<Vec<ImportedFile>, String> {
    if paths.len() > IMPORT_COUNT_LIMIT {
        return Err("一次最多导入 100 个文件，请分批添加。".into());
    }
    let mut used_bytes = 0;
    Ok(paths
        .iter()
        .map(|path| {
            let imported = import_one(path, access, IMPORT_BATCH_LIMIT - used_bytes);
            used_bytes += imported.bytes.len() as u64;
            imported
        })
        .collect())
}

#[tauri::command]
pub async fn select_files(
    app: AppHandle,
    window: WebviewWindow,
    single_srt: Option<bool>,
) -> Result<Vec<ImportedFile>, String> {
    ensure_main(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let single_srt = single_srt.unwrap_or(false);
        let dialog = app.dialog().file();
        let selected = if single_srt {
            dialog
                .set_title("选择时间轴字幕")
                .add_filter("SRT 字幕", &["srt"])
                .blocking_pick_file()
                .map(|file| vec![file])
        } else {
            dialog
                .set_title("选择字幕文件")
                .add_filter(
                    "字幕及文本文件",
                    &["srt", "vtt", "ass", "ssa", "txt", "csv"],
                )
                .blocking_pick_files()
        };
        let Some(selected) = selected else {
            return Ok(Vec::new());
        };
        let paths: Vec<_> = selected
            .into_iter()
            .map(|file| {
                file.into_path()
                    .map_err(|e| format!("无法识别所选路径：{e}"))
            })
            .collect::<Result<_, _>>()?;
        if single_srt
            && !paths
                .first()
                .and_then(|path| path.extension())
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| extension.eq_ignore_ascii_case("srt"))
        {
            return Err("时间轴仅编辑 SRT。其他格式请先在工具箱中显式转换为 SRT。".into());
        }
        let access = app.state::<FileAccess>();
        access.approve_dropped(&paths);
        import_many(&paths, &access)
    })
    .await
    .map_err(|e| format!("文件选择任务未能完成：{e}"))?
}

#[tauri::command]
pub async fn read_dropped_files(
    app: AppHandle,
    window: WebviewWindow,
    paths: Vec<String>,
) -> Result<Vec<ImportedFile>, String> {
    ensure_main(&window)?;
    if paths.len() > IMPORT_COUNT_LIMIT {
        return Err("一次最多导入 100 个文件，请分批添加。".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let access = app.state::<FileAccess>();
        let paths: Vec<_> = paths.into_iter().map(PathBuf::from).collect();
        import_many(&paths, &access)
    })
    .await
    .map_err(|e| format!("文件读取任务未能完成：{e}"))?
}

#[tauri::command]
pub async fn select_directory(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<Option<String>, String> {
    ensure_main(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let Some(directory) = app
            .dialog()
            .file()
            .set_title("选择字幕输出目录")
            .blocking_pick_folder()
        else {
            return Ok(None);
        };
        let path = directory
            .into_path()
            .map_err(|e| format!("路径无效：{e}"))?;
        let path = app.state::<FileAccess>().approve_directory(&path)?;
        Ok(Some(display_path(&path)))
    })
    .await
    .map_err(|e| format!("目录选择任务未能完成：{e}"))?
}

#[tauri::command]
pub async fn save_output(
    app: AppHandle,
    window: WebviewWindow,
    name: String,
    bytes: Vec<u8>,
    directory: Option<String>,
) -> Result<Option<String>, String> {
    ensure_main(&window)?;
    safe_files::validate_name(&name)?;
    if bytes.len() > OUTPUT_LIMIT {
        return Err("导出内容超过 256 MiB，请分批导出。".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let access = app.state::<FileAccess>();
        let (directory, name) = if let Some(directory) = directory.filter(|s| !s.trim().is_empty())
        {
            let directory = fs::canonicalize(&directory)
                .map_err(|e| format!("默认输出目录无法访问，请重新选择目录：{e}"))?;
            let directory = if access.can_write_directory(&directory) {
                directory
            } else {
                // Persisted paths are only hints, never grants. Ask the user in this session.
                let Some(selected) = app
                    .dialog()
                    .file()
                    .set_title("确认输出目录（本次启动首次使用）")
                    .set_directory(&directory)
                    .blocking_pick_folder()
                else {
                    return Ok(None);
                };
                access.approve_directory(
                    &selected.into_path().map_err(|e| format!("路径无效：{e}"))?,
                )?
            };
            (directory, name)
        } else {
            let extension = Path::new(&name)
                .extension()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned();
            let Some(selected) = app
                .dialog()
                .file()
                .set_title("导出处理结果（已有文件会自动添加序号）")
                .set_file_name(&name)
                .add_filter("处理结果", &[&extension])
                .blocking_save_file()
            else {
                return Ok(None);
            };
            let path = selected.into_path().map_err(|e| format!("路径无效：{e}"))?;
            let chosen_extension = path
                .extension()
                .unwrap_or_default()
                .to_string_lossy()
                .to_ascii_lowercase();
            if chosen_extension != extension.to_ascii_lowercase() {
                return Err(format!(
                    "导出扩展名必须为 .{extension}，以保证格式与内容一致。"
                ));
            }
            let directory = access.approve_directory(path.parent().ok_or("输出目录无效。")?)?;
            let name = path
                .file_name()
                .ok_or("输出文件名无效。")?
                .to_string_lossy()
                .into_owned();
            (directory, name)
        };
        safe_files::validate_name(&name)?;
        let path = safe_files::write_unique(&directory, &name, &bytes)
            .map_err(|e| format!("导出失败，处理结果仍保留，请检查磁盘空间或更换目录：{e}"))?;
        Ok(Some(display_path(&path)))
    })
    .await
    .map_err(|e| format!("文件写入任务未能完成：{e}"))?
}

#[tauri::command]
pub async fn open_output_directory(
    app: AppHandle,
    window: WebviewWindow,
    path: String,
) -> Result<(), String> {
    ensure_main(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let path = Path::new(&path);
        let path = if path.is_file()
            || (!path.exists()
                && path
                    .file_name()
                    .is_some_and(|name| safe_files::validate_name(&name.to_string_lossy()).is_ok()))
        {
            path.parent().ok_or("输出目录不存在。")?
        } else {
            path
        };
        let path = fs::canonicalize(path).map_err(|e| format!("无法访问输出目录：{e}"))?;
        if !path.is_dir() {
            return Err("输出位置不是有效的文件夹。".into());
        }
        let access = app.state::<FileAccess>();
        let path = if access.can_write_directory(&path) {
            path
        } else {
            // History survives restarts, while filesystem grants do not. Let the user
            // authorize the historical folder directly instead of reporting a dead end.
            let Some(selected) = app
                .dialog()
                .file()
                .set_title("确认要打开的输出目录")
                .set_directory(&path)
                .blocking_pick_folder()
            else {
                return Ok(());
            };
            access
                .approve_directory(&selected.into_path().map_err(|e| format!("路径无效：{e}"))?)?
        };
        open_directory(&path).map_err(|e| format!("无法打开输出目录：{e}"))
    })
    .await
    .map_err(|e| format!("打开目录任务未能完成：{e}"))?
}

fn open_directory(path: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let explorer = std::env::var_os("SystemRoot")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("C:\\Windows"))
            .join("explorer.exe");
        std::process::Command::new(explorer)
            .arg(display_path(path))
            .creation_flags(0x08000000)
            .spawn()?;
    }
    #[cfg(target_os = "macos")]
    std::process::Command::new("open").arg(path).spawn()?;
    #[cfg(all(not(windows), not(target_os = "macos")))]
    std::process::Command::new("xdg-open").arg(path).spawn()?;
    Ok(())
}

fn validate_store_key(key: &str) -> Result<(), String> {
    if ["settings", "history", PRESET_KEY, WORKFLOW_KEY].contains(&key) {
        Ok(())
    } else {
        Err("无效的本地设置键。".into())
    }
}

fn local_values(app: &AppHandle) -> Result<(Map<String, Value>, PathBuf), String> {
    let path = resolve_store_path(app, STORE_NAME).map_err(|e| format!("无法定位本地设置：{e}"))?;
    if let Some(values) =
        recovery_values(&path).map_err(|e| format!("无法读取设置恢复记录：{e}"))?
    {
        return Ok((values, path));
    }
    // Load explicitly to detect read failures, and release the temporary Store
    // handle so the plugin cannot rewrite the file on application exit.
    let store = app
        .store_builder(STORE_NAME)
        .create_new()
        .disable_auto_save()
        .build()
        .map_err(|e| format!("无法加载本地设置：{e}"))?;
    let loaded = store.reload_ignore_defaults();
    let values = store.entries().into_iter().collect();
    store.close_resource();
    match loaded {
        Ok(()) => Ok((values, path)),
        Err(StoreError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok((Map::new(), path))
        }
        Err(StoreError::Deserialize(_)) => Err("本地设置文件损坏，请备份后恢复。".into()),
        Err(error) => Err(format!("无法加载本地设置：{error}")),
    }
}

fn recovery_values(path: &Path) -> io::Result<Option<Map<String, Value>>> {
    match fs::read(path.with_file_name(STORE_RECOVERY_NAME)) {
        // An interrupted journal write leaves the primary file untouched.
        Ok(bytes) => Ok(serde_json::from_slice(&bytes).ok()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn clear_store_recovery(path: &Path) -> io::Result<()> {
    match fs::remove_file(path.with_file_name(STORE_RECOVERY_NAME)) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        result => result,
    }
}

fn synced_store_write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut file = fs::File::create(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

fn write_store_with_recovery(
    path: &Path,
    previous: &Map<String, Value>,
    content: &[u8],
) -> io::Result<()> {
    // A valid journal is the committed state until the complete new Store has
    // been synced and the journal is removed. Leave it in place on any failure.
    if recovery_values(path)?.is_none() {
        let old = serde_json::to_vec_pretty(previous)?;
        synced_store_write(&path.with_file_name(STORE_RECOVERY_NAME), &old)?;
    }
    synced_store_write(path, content)?;
    clear_store_recovery(path)
}

fn supports_store_write_fallback(error: &io::Error) -> bool {
    #[cfg(windows)]
    return error.raw_os_error()
        == Some(windows_sys::Win32::Foundation::ERROR_NOT_SAME_DEVICE as i32);

    #[cfg(not(windows))]
    {
        let _ = error;
        false
    }
}

#[tauri::command]
pub fn get_local_value(
    app: AppHandle,
    window: WebviewWindow,
    key: String,
) -> Result<Option<Value>, String> {
    ensure_main(&window)?;
    validate_store_key(&key)?;
    let _transaction = STORE_TRANSACTION
        .lock()
        .map_err(|_| "本地设置正在恢复，请重启应用。")?;
    let (mut values, _) = local_values(&app)?;
    Ok(values.remove(&key))
}

#[tauri::command]
pub fn set_local_value(
    app: AppHandle,
    window: WebviewWindow,
    key: String,
    value: Value,
) -> Result<(), String> {
    ensure_main(&window)?;
    validate_store_key(&key)?;
    let bytes = serde_json::to_vec(&value).map_err(|e| e.to_string())?;
    if key == PRESET_KEY && bytes.len() > PRESET_LIMIT {
        return Err("参数预设过大，请缩短文本或删除不用的预设。".into());
    }
    if key == WORKFLOW_KEY && bytes.len() > WORKFLOW_LIMIT {
        return Err("流程预设过大，最多 512 KiB，请缩短文本或删除不用的流程。".into());
    }
    if bytes.len() > 4 * 1024 * 1024 {
        return Err("本地设置或历史记录过大，请先清理处理记录。".into());
    }
    let _transaction = STORE_TRANSACTION
        .lock()
        .map_err(|_| "本地设置正在恢复，请重启应用。")?;
    let (mut values, path) = local_values(&app)?;
    let previous = values.clone();
    values.insert(key, value);
    commit_local_values(&path, &previous, &values)
}

fn commit_local_values(
    path: &Path,
    previous: &Map<String, Value>,
    values: &Map<String, Value>,
) -> Result<(), String> {
    let content = serde_json::to_vec_pretty(values).map_err(|e| e.to_string())?;
    match safe_files::replace_local_store(path, &content) {
        Ok(()) => clear_store_recovery(path),
        Err(error) if supports_store_write_fallback(&error) => {
            // Some Windows encrypted AppData folders reject same-volume renames.
            // Preserve the committed snapshot before writing the fixed file in place.
            write_store_with_recovery(path, previous, &content)
        }
        Err(error) => Err(error),
    }
    .map_err(|e| format!("无法保存本地设置：{e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct ImportFixture(PathBuf);
    impl ImportFixture {
        fn new(extension: &str) -> Self {
            let nonce = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "subtitle-tools-import-{}-{nonce}.{extension}",
                std::process::id()
            ));
            fs::write(&path, b"test content").unwrap();
            Self(path)
        }
    }
    impl Drop for ImportFixture {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.0);
        }
    }

    #[test]
    fn grants_reject_arbitrary_paths_and_subdirectories() {
        let state = FileAccess::default();
        let directory = std::env::temp_dir();
        let directory = state.approve_directory(&directory).unwrap();
        assert!(state.can_write_directory(&directory));
        assert!(!state.can_write_directory(&directory.join("unselected-child")));
        assert!(!state.can_read(&directory.join("unselected.srt")));
    }

    #[test]
    fn only_fixed_store_keys_are_accessible() {
        assert!(validate_store_key("settings").is_ok());
        assert!(validate_store_key("history").is_ok());
        assert!(validate_store_key("tool-presets-v1").is_ok());
        assert!(validate_store_key("tool-presets-v2").is_err());
        assert!(validate_store_key("../secret.json").is_err());
    }

    #[test]
    #[cfg(windows)]
    fn journal_preserves_committed_store_until_in_place_write_succeeds() {
        use std::os::windows::fs::OpenOptionsExt;

        let fixture = ImportFixture::new("json");
        let path = &fixture.0;
        // Isolate the fixed journal name from other tests and applications.
        let directory = path.with_extension("dir");
        fs::create_dir(&directory).unwrap();
        let store = directory.join(STORE_NAME);
        let previous =
            serde_json::from_str(r#"{"settings":{"theme":"dark"},"history":[]}"#).unwrap();
        let next = br#"{"settings":{"theme":"dark"},"history":[],"tool-presets-v1":{"schemaVersion":1,"presets":[]}}"#;
        synced_store_write(&store, &serde_json::to_vec(&previous).unwrap()).unwrap();
        let lock = fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&store)
            .unwrap();
        assert!(write_store_with_recovery(&store, &previous, next).is_err());
        assert_eq!(recovery_values(&store).unwrap(), Some(previous.clone()));
        drop(lock);
        assert_eq!(
            serde_json::from_slice::<Map<String, Value>>(&fs::read(&store).unwrap()).unwrap(),
            previous
        );
        write_store_with_recovery(&store, &previous, next).unwrap();
        assert_eq!(recovery_values(&store).unwrap(), None);
        assert_eq!(fs::read(&store).unwrap(), next);
        fs::remove_file(&store).unwrap();
        fs::remove_dir(&directory).unwrap();
    }

    #[test]
    #[cfg(windows)]
    fn canonical_paths_are_human_readable_and_explorer_compatible() {
        assert_eq!(
            display_path(Path::new(r"\\?\C:\字幕\one.srt")),
            r"C:\字幕\one.srt"
        );
        assert_eq!(
            display_path(Path::new(r"\\?\UNC\server\share\one.srt")),
            r"\\server\share\one.srt"
        );
        assert_eq!(display_path(Path::new(r"C:\one.srt")), r"C:\one.srt");
    }

    #[test]
    fn import_reads_only_after_native_drop_grant_is_registered() {
        let fixture = ImportFixture::new("srt");
        let state = FileAccess::default();
        let denied = import_one(&fixture.0, &state, INPUT_LIMIT);
        assert!(denied.error.unwrap().contains("文件对话框"));
        assert!(denied.bytes.is_empty());
        state.approve_dropped(std::slice::from_ref(&fixture.0));
        let imported = import_one(&fixture.0, &state, INPUT_LIMIT);
        assert!(imported.error.is_none());
        assert_eq!(imported.bytes, b"test content");
    }

    #[test]
    fn oversized_and_unsupported_files_return_no_content() {
        let oversized = ImportFixture::new("srt");
        let unsupported = ImportFixture::new("exe");
        fs::OpenOptions::new()
            .write(true)
            .open(&oversized.0)
            .unwrap()
            .set_len(INPUT_LIMIT + 1)
            .unwrap();
        let state = FileAccess::default();
        state.approve_dropped(&[oversized.0.clone(), unsupported.0.clone()]);
        let oversized = import_one(&oversized.0, &state, INPUT_LIMIT);
        assert!(oversized.error.unwrap().contains("32 MiB"));
        assert!(oversized.bytes.is_empty());
        let unsupported = import_one(&unsupported.0, &state, INPUT_LIMIT);
        assert!(unsupported.error.unwrap().contains("不支持"));
        assert!(unsupported.bytes.is_empty());
    }

    #[test]
    fn import_budget_is_enforced_before_reading_file_bytes() {
        let fixture = ImportFixture::new("srt");
        let state = FileAccess::default();
        state.approve_dropped(std::slice::from_ref(&fixture.0));
        let imported = import_one(&fixture.0, &state, 2);
        assert!(imported.error.unwrap().contains("128 MiB"));
        assert!(imported.bytes.is_empty());
        let too_many = vec![fixture.0.clone(); IMPORT_COUNT_LIMIT + 1];
        assert!(import_many(&too_many, &state)
            .err()
            .unwrap()
            .contains("100"));
    }
}
