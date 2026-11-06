//! Atomic publication without replacement, including concurrent exports.
use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

static SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub fn validate_name(name: &str) -> Result<(), String> {
    if name.is_empty()
        || name.encode_utf16().count() > 220
        || name == "."
        || name == ".."
        || name.ends_with(['.', ' '])
        || name
            .chars()
            .any(|c| c.is_control() || "<>:\"/\\|?*".contains(c))
    {
        return Err("文件名无效，请移除路径分隔符或特殊字符，并使用较短的文件名。".into());
    }
    let path = Path::new(name);
    let stem = path.file_stem().unwrap_or_default().to_string_lossy();
    let reserved = stem
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    let device_number = reserved
        .strip_prefix("COM")
        .or_else(|| reserved.strip_prefix("LPT"));
    if ["CON", "PRN", "AUX", "NUL"].contains(&reserved.as_str())
        || matches!(
            device_number,
            Some("1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³")
        )
    {
        return Err("此文件名为系统保留名称，请更换文件名。".into());
    }
    let extension = path
        .extension()
        .unwrap_or_default()
        .to_string_lossy()
        .to_ascii_lowercase();
    if !["srt", "vtt", "ass", "ssa", "txt", "csv", "zip", "json"].contains(&extension.as_str()) {
        return Err("导出文件扩展名不受支持。".into());
    }
    Ok(())
}

pub fn write_unique(directory: &Path, name: &str, bytes: &[u8]) -> io::Result<PathBuf> {
    write_unique_cancellable(directory, name, bytes, None)
}

pub(super) fn write_unique_cancellable(
    directory: &Path,
    name: &str,
    bytes: &[u8],
    cancel: Option<&AtomicBool>,
) -> io::Result<PathBuf> {
    validate_name(name).map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))?;
    write_staged_cancellable(directory, bytes, cancel, |temporary| {
        let source = Path::new(name);
        let stem = source.file_stem().unwrap_or_default().to_string_lossy();
        let extension = source.extension().unwrap_or_default().to_string_lossy();
        for attempt in 0..10_000 {
            let target = directory.join(if attempt == 0 {
                name.to_owned()
            } else {
                let suffix = format!(" ({attempt}).{extension}");
                let mut trimmed = String::new();
                let mut units = 0;
                for character in stem.chars() {
                    if units + character.len_utf16() + suffix.encode_utf16().count() > 220 {
                        break;
                    }
                    trimmed.push(character);
                    units += character.len_utf16();
                }
                format!("{trimmed}{suffix}")
            });
            if cancel.is_some_and(|cancel| cancel.load(Ordering::Relaxed)) {
                return Err(io::Error::new(
                    io::ErrorKind::Interrupted,
                    "目录导出已取消。",
                ));
            }
            match publish(temporary, &target, false) {
                Ok(()) => return Ok(target),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error),
            }
        }
        Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "同名文件过多，请更换文件名。",
        ))
    })
}

/// Replace only the application's own settings file after its new content is complete.
pub(super) fn replace_local_store(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let directory = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "无效的本地设置位置。"))?;
    fs::create_dir_all(directory)?;
    write_staged(directory, bytes, |temporary| publish(temporary, path, true))
}

pub(super) fn write_staged<T>(
    directory: &Path,
    bytes: &[u8],
    commit: impl FnOnce(&Path) -> io::Result<T>,
) -> io::Result<T> {
    write_staged_cancellable(directory, bytes, None, commit)
}

fn write_staged_cancellable<T>(
    directory: &Path,
    bytes: &[u8],
    cancel: Option<&AtomicBool>,
    commit: impl FnOnce(&Path) -> io::Result<T>,
) -> io::Result<T> {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temporary = directory.join(format!(
        ".subtitle-tools-{}-{nonce}-{}.tmp",
        std::process::id(),
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)?;
    let result = (|| {
        for chunk in bytes.chunks(64 * 1024) {
            if cancel.is_some_and(|cancel| cancel.load(Ordering::Relaxed)) {
                return Err(io::Error::new(
                    io::ErrorKind::Interrupted,
                    "目录导出已取消。",
                ));
            }
            file.write_all(chunk)?;
        }
        file.sync_all()?;
        drop(file);
        if cancel.is_some_and(|cancel| cancel.load(Ordering::Relaxed)) {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "目录导出已取消。",
            ));
        }
        commit(&temporary)
    })();
    // Remove a partial temporary file after failure. A published result is never removed.
    let _ = fs::remove_file(&temporary);
    result
}

#[cfg(windows)]
pub(super) fn publish(source: &Path, target: &Path, replace: bool) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let target: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    // Exported subtitles omit the replace flag. Only the fixed local store can use it.
    let flags = if replace {
        MOVEFILE_WRITE_THROUGH | MOVEFILE_REPLACE_EXISTING
    } else {
        MOVEFILE_WRITE_THROUGH
    };
    if unsafe { MoveFileExW(source.as_ptr(), target.as_ptr(), flags) } != 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(not(windows))]
pub(super) fn publish(source: &Path, target: &Path, replace: bool) -> io::Result<()> {
    if replace {
        fs::rename(source, target)
    } else {
        fs::hard_link(source, target)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestDir(PathBuf);
    impl TestDir {
        fn new() -> Self {
            let directory = std::env::temp_dir().join(format!(
                "subtitle-tools-test-{}-{}",
                std::process::id(),
                SEQUENCE.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&directory).unwrap();
            Self(directory)
        }
    }
    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn rejects_traversal_reserved_names_and_executable_extensions() {
        for name in [
            "../x.srt",
            "..\\x.srt",
            "C:\\x.srt",
            "CON.srt",
            "LPT1.txt",
            "COM¹.srt",
            "lpt³.vtt",
            "a.exe",
            "a.srt ",
            "a:stream.srt",
        ] {
            assert!(
                validate_name(name).is_err(),
                "unexpected valid name: {name}"
            );
        }
        assert!(validate_name("课程_processed.srt").is_ok());
        assert!(validate_name(&format!("{}.srt", "课".repeat(200))).is_ok());
        assert!(validate_name(&format!("{}.srt", "课".repeat(217))).is_err());
        assert!(validate_name(&format!("{}.srt", "🦊".repeat(109))).is_err());
    }

    #[test]
    fn conflict_preserves_original_and_publishes_complete_result() {
        let directory = TestDir::new();
        fs::write(directory.0.join("sample.srt"), b"original").unwrap();
        let path = write_unique(&directory.0, "sample.srt", b"result").unwrap();
        assert_eq!(path.file_name().unwrap(), "sample (1).srt");
        assert_eq!(
            fs::read(directory.0.join("sample.srt")).unwrap(),
            b"original"
        );
        assert_eq!(fs::read(path).unwrap(), b"result");
        assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 2);
    }

    #[test]
    #[cfg(windows)]
    fn unicode_long_path_conflicts_preserve_original_bytes() {
        let root = TestDir::new();
        let directory = fs::canonicalize(&root.0)
            .unwrap()
            .join("字幕 工程 (😀)".repeat(9))
            .join("长路径".repeat(52));
        fs::create_dir_all(&directory).unwrap();
        let original = directory.join("片段 (😀) CASE.srt");
        assert!(original.to_string_lossy().encode_utf16().count() > 260);
        fs::write(&original, b"original").unwrap();
        let output = write_unique(&directory, "片段 (😀) case.srt", b"result").unwrap();
        assert_eq!(output.file_name().unwrap(), "片段 (😀) case (1).srt");
        assert_eq!(fs::read(original).unwrap(), b"original");
        assert_eq!(fs::read(output).unwrap(), b"result");
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 2);
    }

    #[test]
    #[cfg(windows)]
    fn failed_store_replacement_preserves_all_existing_keys() {
        use std::os::windows::fs::OpenOptionsExt;

        let root = TestDir::new();
        let store = root.0.join("subtitle-tools.json");
        let previous = br#"{"settings":{"theme":"dark"},"history":[]}"#;
        let next = br#"{"settings":{"theme":"dark"},"history":[],"tool-presets-v1":{"schemaVersion":1,"presets":[]}}"#;
        replace_local_store(&store, previous).unwrap();
        let lock = OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&store)
            .unwrap();
        assert!(replace_local_store(&store, next).is_err());
        drop(lock);
        assert_eq!(fs::read(&store).unwrap(), previous);
        assert_eq!(fs::read_dir(&root.0).unwrap().count(), 1);
        replace_local_store(&store, next).unwrap();
        assert_eq!(fs::read(&store).unwrap(), next);
    }

    #[test]
    fn concurrent_writers_never_replace_each_other() {
        let directory = TestDir::new();
        let workers: Vec<_> = (0..8)
            .map(|i| {
                let directory = directory.0.clone();
                std::thread::spawn(move || {
                    write_unique(&directory, "same.txt", format!("{i}").as_bytes()).unwrap()
                })
            })
            .collect();
        let paths: std::collections::HashSet<_> =
            workers.into_iter().map(|w| w.join().unwrap()).collect();
        assert_eq!(paths.len(), 8);
        let contents: std::collections::HashSet<_> = paths
            .iter()
            .map(|p| fs::read_to_string(p).unwrap())
            .collect();
        assert_eq!(contents.len(), 8);
        assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 8);
    }

    #[test]
    fn failure_leaves_no_temporary_file() {
        let directory = TestDir::new();
        assert!(write_unique(&directory.0.join("missing"), "result.txt", b"data").is_err());
        assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 0);
    }
}
