//! Explorer supplies concrete input files, never renderer-controlled filesystem authority.
use super::{
    display_path, ensure_main, FileAccess, ImportedFile, IMPORT_BATCH_LIMIT, IMPORT_COUNT_LIMIT,
    INPUT_LIMIT,
};
use serde::Serialize;
use std::{
    collections::VecDeque,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

pub const EVENT: &str = "subtitle-tools:external-import-pending";
const PENDING_LIMIT: usize = 256;
const EXTENSIONS: [&str; 6] = ["srt", "vtt", "ass", "ssa", "txt", "csv"];

#[derive(Default)]
struct Pending {
    paths: VecDeque<PathBuf>,
    rejected: usize,
}
#[derive(Default)]
pub struct ExternalImports(Mutex<Pending>);

impl ExternalImports {
    pub fn enqueue(&self, args: &[String], cwd: &Path) {
        let Ok(mut pending) = self.0.lock() else {
            return;
        };
        // No implicit positional arguments, URLs, flags, or shell evaluation.
        if args.get(1).map(String::as_str) != Some("--import") {
            return;
        }
        for argument in args.iter().skip(2) {
            let path = Path::new(argument);
            if argument.is_empty()
                || argument.starts_with('-')
                || argument.contains('\0')
                || argument.encode_utf16().count() > 32767
                || pending.paths.len() >= PENDING_LIMIT
            {
                pending.rejected = pending.rejected.saturating_add(1);
                continue;
            }
            pending.paths.push_back(if path.is_absolute() {
                path.to_owned()
            } else {
                cwd.join(path)
            });
        }
    }
}

pub fn forward(app: &AppHandle, args: Vec<String>, cwd: String) {
    app.state::<ExternalImports>()
        .enqueue(&args, Path::new(&cwd));
    let _ = app.emit_to("main", EVENT, ());
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalBatch {
    files: Vec<ImportedFile>,
    rejected: usize,
    duplicates: usize,
}

#[cfg(windows)]
fn same_path(left: &str, right: &str) -> bool {
    use windows_sys::Win32::Globalization::{CompareStringOrdinal, CSTR_EQUAL};
    let left: Vec<_> = left.replace('/', "\\").encode_utf16().collect();
    let right: Vec<_> = right.replace('/', "\\").encode_utf16().collect();
    unsafe {
        CompareStringOrdinal(
            left.as_ptr(),
            left.len() as i32,
            right.as_ptr(),
            right.len() as i32,
            1,
        ) == CSTR_EQUAL
    }
}
#[cfg(not(windows))]
fn same_path(left: &str, right: &str) -> bool {
    left == right
}

#[cfg(windows)]
fn read_external(path: &Path, remaining: u64, access: &FileAccess) -> Result<ImportedFile, ()> {
    use std::{
        fs::{File, OpenOptions},
        io::Read,
        os::windows::{
            ffi::OsStringExt,
            fs::{MetadataExt, OpenOptionsExt},
            io::AsRawHandle,
        },
    };
    use windows_sys::Win32::Storage::FileSystem::{
        GetFinalPathNameByHandleW, FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS,
        FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ,
    };
    // Hold each ancestor against replacement until the same input handle is read.
    // OPEN_REPARSE_POINT makes a link/junction itself visible for rejection.
    let open = |entry: &Path| -> Result<File, ()> {
        let file = OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(entry)
            .map_err(|_| ())?;
        if file.metadata().map_err(|_| ())?.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(());
        }
        Ok(file)
    };
    let mut ancestors = Vec::new();
    for ancestor in path.ancestors().skip(1) {
        if ancestor.as_os_str().is_empty() {
            continue;
        }
        let file = open(ancestor)?;
        if !file.metadata().map_err(|_| ())?.is_dir() {
            return Err(());
        }
        ancestors.push(file);
    }
    let mut file = open(path)?;
    let metadata = file.metadata().map_err(|_| ())?;
    if !metadata.is_file() || metadata.len() > INPUT_LIMIT || metadata.len() > remaining {
        return Err(());
    }
    let mut buffer = vec![0u16; 512];
    let canonical = loop {
        let length = unsafe {
            GetFinalPathNameByHandleW(
                file.as_raw_handle(),
                buffer.as_mut_ptr(),
                buffer.len() as u32,
                0,
            )
        };
        if length == 0 {
            return Err(());
        }
        if length as usize >= buffer.len() {
            buffer.resize(length as usize + 1, 0);
        } else {
            break PathBuf::from(std::ffi::OsString::from_wide(&buffer[..length as usize]));
        }
    };
    if !canonical
        .extension()
        .and_then(|s| s.to_str())
        .is_some_and(|ext| EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
    {
        return Err(());
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(INPUT_LIMIT.min(remaining) + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| ())?;
    if bytes.len() as u64 > INPUT_LIMIT.min(remaining) {
        return Err(());
    }
    access
        .approve_folder_file(canonical.clone())
        .map_err(|_| ())?;
    Ok(ImportedFile {
        name: canonical
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        path: display_path(&canonical),
        size: bytes.len() as u64,
        bytes,
        error: None,
        folder_source: access.folder_source(&canonical),
    })
}

#[cfg(not(windows))]
fn read_external(_path: &Path, _remaining: u64, _access: &FileAccess) -> Result<ImportedFile, ()> {
    Err(())
}

#[tauri::command]
pub async fn take_external_imports(
    window: WebviewWindow,
    app: AppHandle,
    existing_paths: Vec<String>,
    existing_count: usize,
    existing_bytes: u64,
) -> Result<ExternalBatch, String> {
    ensure_main(&window)?;
    if existing_count > IMPORT_COUNT_LIMIT
        || existing_bytes > IMPORT_BATCH_LIMIT
        || existing_paths.len() > IMPORT_COUNT_LIMIT
        || existing_paths
            .iter()
            .any(|p| p.encode_utf16().count() > 32767)
    {
        return Err("现有队列超出限制。".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<ExternalImports>();
        let mut pending = state.0.lock().map_err(|_| "待导入队列异常。")?;
        let paths = std::mem::take(&mut pending.paths);
        let mut result = ExternalBatch {
            files: Vec::new(),
            rejected: std::mem::take(&mut pending.rejected),
            duplicates: 0,
        };
        drop(pending);
        let access = app.state::<FileAccess>();
        let mut remaining = IMPORT_BATCH_LIMIT - existing_bytes;
        for path in paths {
            if existing_count + result.files.len() >= IMPORT_COUNT_LIMIT {
                result.rejected += 1;
                continue;
            }
            match read_external(&path, remaining, &access) {
                Ok(file) => {
                    // These renderer paths are comparison hints, never resolved or opened.
                    if existing_paths.iter().any(|p| same_path(p, &file.path))
                        || result.files.iter().any(|f| same_path(&f.path, &file.path))
                    {
                        result.duplicates += 1;
                    } else {
                        remaining -= file.size;
                        result.files.push(file);
                    }
                }
                Err(()) => result.rejected += 1,
            }
        }
        Ok(result)
    })
    .await
    .map_err(|_| "读取外部文件失败。".to_owned())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationStatus {
    available: bool,
    enabled: bool,
    conflict: bool,
    other_installation: bool,
}

#[cfg(windows)]
mod registry {
    use super::*;
    use std::io;
    use winreg::{
        enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WRITE},
        RegKey,
    };
    const OWNER: &str = "com.subtitletools.desktop";
    const VERB: &str = "SRTTools.Import";
    static LOCK: Mutex<()> = Mutex::new(());
    fn key(extension: &str) -> String {
        format!(r"Software\Classes\SystemFileAssociations\.{extension}\shell\{VERB}")
    }
    fn executable() -> Result<String, String> {
        let path = std::env::current_exe()
            .and_then(std::fs::canonicalize)
            .map_err(|_| "无法确认当前程序路径。")?;
        let path = display_path(&path);
        // Explorer expands command placeholders; such install paths cannot be registered safely.
        if path.contains(['%', '"', '\0']) {
            return Err(
                "当前安装路径含有 Explorer 命令占位符，请将程序移到不含 % 的目录后启用。".into(),
            );
        }
        Ok(path)
    }
    fn read(root: &RegKey, path: &str) -> io::Result<Option<RegKey>> {
        match root.open_subkey_with_flags(path, KEY_READ | KEY_WRITE) {
            Ok(key) => Ok(Some(key)),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e),
        }
    }
    fn owned(key: &RegKey) -> bool {
        key.get_value::<String, _>("Owner")
            .is_ok_and(|v| v == OWNER)
    }
    pub fn status() -> Result<IntegrationStatus, String> {
        let exe = executable()?;
        let root = RegKey::predef(HKEY_CURRENT_USER);
        let mut status = IntegrationStatus {
            available: true,
            enabled: true,
            conflict: false,
            other_installation: false,
        };
        for extension in EXTENSIONS {
            match read(&root, &key(extension)).map_err(|_| "无法读取 Explorer 菜单设置。")?
            {
                None => status.enabled = false,
                Some(entry) => {
                    let ours = owned(&entry);
                    let path = entry
                        .get_value::<String, _>("Executable")
                        .unwrap_or_default();
                    let command = entry
                        .open_subkey("command")
                        .and_then(|c| c.get_value::<String, _>(""))
                        .unwrap_or_default();
                    let matches =
                        same_path(&exe, &path) && command == format!("\"{exe}\" --import \"%1\"");
                    status.conflict |= !ours;
                    status.other_installation |= ours && !same_path(&exe, &path);
                    status.enabled &= ours && matches;
                }
            }
        }
        Ok(status)
    }
    pub fn set(enabled: bool) -> Result<IntegrationStatus, String> {
        let _guard = LOCK.lock().map_err(|_| "菜单设置正在更新。")?;
        let exe = executable()?;
        let root = RegKey::predef(HKEY_CURRENT_USER);
        // Preflight all keys before changing any of them. Unknown owners are always preserved.
        let mut snapshots = Vec::new();
        for extension in EXTENSIONS {
            let path = key(extension);
            let entry = read(&root, &path).map_err(|_| "无法读取 Explorer 菜单设置。")?;
            if let Some(entry) = &entry {
                if !owned(entry) {
                    return Err("同名菜单由其他程序管理，未作修改。".into());
                }
                if !enabled
                    && !entry
                        .get_value::<String, _>("Executable")
                        .is_ok_and(|p| same_path(&p, &exe))
                {
                    return Err("菜单属于另一个安装路径，未作修改。请在对应安装中禁用，或在此处重新启用以修复路径。".into());
                }
                let values = entry
                    .enum_values()
                    .collect::<io::Result<Vec<_>>>()
                    .map_err(|_| "无法备份菜单设置。")?;
                let children = entry
                    .enum_keys()
                    .collect::<io::Result<Vec<_>>>()
                    .map_err(|_| "无法检查菜单设置。")?;
                // Do not erase unexpected data even under an otherwise owned key.
                if children.iter().any(|name| name != "command")
                    || values.iter().any(|(name, _)| {
                        !["", "Owner", "Executable", "Icon", "MultiSelectModel"]
                            .contains(&name.as_str())
                    })
                {
                    return Err("菜单键包含未知数据，未作修改。".into());
                }
                let command = match entry.open_subkey("command") {
                    Ok(command) => {
                        let children = command
                            .enum_keys()
                            .collect::<io::Result<Vec<_>>>()
                            .map_err(|_| "无法完整检查菜单命令，未作修改。")?;
                        if !children.is_empty() {
                            return Err("菜单命令包含未知子键，未作修改。".into());
                        }
                        Some(
                            command
                                .enum_values()
                                .collect::<io::Result<Vec<_>>>()
                                .map_err(|_| "无法完整备份菜单命令，未作修改。")?,
                        )
                    }
                    Err(error) if error.kind() == io::ErrorKind::NotFound => None,
                    Err(_) => return Err("无法读取菜单命令，未作修改。".into()),
                };
                if command
                    .as_ref()
                    .is_some_and(|values| values.iter().any(|(name, _)| !name.is_empty()))
                {
                    return Err("菜单命令包含未知数据，未作修改。".into());
                }
                snapshots.push((path, Some((values, command))));
            } else {
                snapshots.push((path, None));
            }
        }
        let change = (|| -> io::Result<()> {
            for (path, _) in &snapshots {
                if enabled {
                    let (entry, _) = root.create_subkey(path)?;
                    entry.set_value("Owner", &OWNER)?;
                    entry.set_value("Executable", &exe)?;
                    entry.set_value("", &"使用 Subtitle Tools 打开")?;
                    entry.set_value("Icon", &format!("\"{exe}\",0"))?;
                    entry.set_value("MultiSelectModel", &"Document")?;
                    entry
                        .create_subkey("command")?
                        .0
                        .set_value("", &format!("\"{exe}\" --import \"%1\""))?;
                } else if read(&root, path)?.is_some() {
                    root.delete_subkey_all(path)?;
                }
            }
            Ok(())
        })();
        if change.is_err() {
            let mut rollback_failed = false;
            for (path, snapshot) in &snapshots {
                if let Ok(Some(entry)) = read(&root, path) {
                    if !owned(&entry) {
                        rollback_failed = true;
                        continue;
                    }
                }
                if let Err(e) = root.delete_subkey_all(path) {
                    if e.kind() != io::ErrorKind::NotFound {
                        rollback_failed = true;
                        continue;
                    }
                }
                if let Some((values, command)) = snapshot {
                    let restored = (|| -> io::Result<()> {
                        let entry = root.create_subkey(path)?.0;
                        for (name, value) in values {
                            entry.set_raw_value(name, value)?;
                        }
                        if let Some(command) = command {
                            let entry = entry.create_subkey("command")?.0;
                            for (name, value) in command {
                                entry.set_raw_value(name, value)?;
                            }
                        }
                        Ok(())
                    })();
                    rollback_failed |= restored.is_err();
                }
            }
            return Err(if rollback_failed {
                "菜单更新失败，部分恢复未完成，请检查当前用户注册表中的 SRTTools.Import 专属键。"
            } else {
                "菜单更新失败，已恢复原设置。"
            }
            .into());
        }
        unsafe {
            use windows_sys::Win32::UI::Shell::{SHChangeNotify, SHCNE_ASSOCCHANGED, SHCNF_IDLIST};
            SHChangeNotify(
                SHCNE_ASSOCCHANGED as i32,
                SHCNF_IDLIST,
                std::ptr::null(),
                std::ptr::null(),
            );
        }
        status()
    }
}

#[tauri::command]
pub fn get_explorer_integration(window: WebviewWindow) -> Result<IntegrationStatus, String> {
    ensure_main(&window)?;
    #[cfg(windows)]
    {
        registry::status()
    }
    #[cfg(not(windows))]
    {
        Ok(IntegrationStatus {
            available: false,
            enabled: false,
            conflict: false,
            other_installation: false,
        })
    }
}
#[tauri::command]
pub async fn set_explorer_integration(
    window: WebviewWindow,
    enabled: bool,
) -> Result<IntegrationStatus, String> {
    ensure_main(&window)?;
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(move || registry::set(enabled))
            .await
            .map_err(|_| "菜单更新失败。".to_owned())?
    }
    #[cfg(not(windows))]
    {
        let _ = enabled;
        Err("Explorer 菜单仅支持 Windows。".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn external_args_are_explicit_bounded_and_never_evaluated() {
        let state = ExternalImports::default();
        state.enqueue(
            &["app".into(), "plain.srt".into()],
            Path::new("C:\\fixtures"),
        );
        assert!(state.0.lock().unwrap().paths.is_empty());
        let mut args = vec!["app".into(), "--import".into(), "--bad".into(), "".into()];
        args.extend((0..300).map(|i| format!("字幕 {i} & $(x).srt")));
        state.enqueue(&args, Path::new("C:\\fixtures"));
        let pending = state.0.lock().unwrap();
        assert_eq!(pending.paths.len(), PENDING_LIMIT);
        assert_eq!(pending.rejected, 46);
        assert!(pending.paths[0].to_string_lossy().contains("& $(x)"));
    }
    #[test]
    fn windows_ordinal_does_not_expand_distinct_unicode_names() {
        assert!(same_path("C:\\Σ.srt", "c:\\σ.srt"));
        assert!(!same_path("C:\\İ.srt", "C:\\i\u{307}.srt"));
        assert!(!same_path("C:\\ß.srt", "C:\\SS.srt"));
    }

    #[cfg(windows)]
    #[test]
    fn external_files_require_safe_handles_limits_and_specific_input_grants() {
        use std::{
            fs,
            io::Write,
            os::windows::fs::{symlink_file, OpenOptionsExt},
            time::{SystemTime, UNIX_EPOCH},
        };
        let root = std::env::temp_dir().join(format!(
            "subtitle-tools-external-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&root).unwrap();
        let access = FileAccess::default();
        let source = root.join("字幕 & $(literal).srt");
        fs::write(&source, b"1\r\n00:00:00,000 --> 00:00:01,000\r\nbody\r\n").unwrap();
        let imported = read_external(&source, IMPORT_BATCH_LIMIT, &access).unwrap();
        assert_eq!(imported.bytes, fs::read(&source).unwrap());
        assert!(access.can_read(&fs::canonicalize(&source).unwrap()));
        assert!(!access.can_write_directory(&fs::canonicalize(&root).unwrap()));
        assert!(read_external(&source, 1, &access).is_err());
        assert!(read_external(&root, IMPORT_BATCH_LIMIT, &access).is_err());
        assert!(read_external(&root.join("missing.srt"), IMPORT_BATCH_LIMIT, &access).is_err());
        let unsupported = root.join("unsafe.exe");
        fs::write(&unsupported, b"x").unwrap();
        assert!(read_external(&unsupported, IMPORT_BATCH_LIMIT, &access).is_err());
        let large = root.join("large.srt");
        fs::File::create(&large)
            .unwrap()
            .set_len(INPUT_LIMIT + 1)
            .unwrap();
        assert!(read_external(&large, IMPORT_BATCH_LIMIT, &access).is_err());
        let mut locked = fs::OpenOptions::new()
            .write(true)
            .share_mode(0)
            .open(&source)
            .unwrap();
        locked.write_all(b"unchanged").unwrap();
        assert!(read_external(&source, IMPORT_BATCH_LIMIT, &access).is_err());
        drop(locked);
        let link = root.join("link.srt");
        if symlink_file(&source, &link).is_ok() {
            assert!(read_external(&link, IMPORT_BATCH_LIMIT, &access).is_err());
            fs::remove_file(link).unwrap();
        }
        for path in [&source, &unsupported, &large] {
            fs::remove_file(path).unwrap();
        }
        fs::remove_dir(root).unwrap();
    }
}
