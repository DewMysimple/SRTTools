//! Atomic publication without replacement, including concurrent exports.
use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
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
    validate_name(name).map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temporary = directory.join(format!(
        ".subtitle-tools-{}-{nonce}-{}.tmp",
        std::process::id(),
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        let source = Path::new(name);
        let stem = source.file_stem().unwrap_or_default().to_string_lossy();
        let extension = source.extension().unwrap_or_default().to_string_lossy();
        for attempt in 0..10_000 {
            let target = directory.join(if attempt == 0 {
                name.to_owned()
            } else {
                format!("{stem} ({attempt}).{extension}")
            });
            match publish(&temporary, &target) {
                Ok(()) => return Ok(target),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error),
            }
        }
        Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "同名文件过多，请更换文件名。",
        ))
    })();
    // Remove a partial temporary file after failure. A published result is never removed.
    let _ = fs::remove_file(&temporary);
    result
}

#[cfg(windows)]
fn publish(source: &Path, target: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_WRITE_THROUGH};
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let target: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    // Deliberately omit MOVEFILE_REPLACE_EXISTING. Windows publishes on the same volume
    // without an existence-check race and supports NTFS, FAT and exFAT targets.
    if unsafe { MoveFileExW(source.as_ptr(), target.as_ptr(), MOVEFILE_WRITE_THROUGH) } != 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(not(windows))]
fn publish(source: &Path, target: &Path) -> io::Result<()> {
    fs::hard_link(source, target)
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
