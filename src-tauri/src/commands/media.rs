use super::{
    ensure_main,
    folder_import::{locked_open, within, LockedEntry, OpenFailure},
};
use serde::Serialize;
use std::{
    fs::{self, File},
    io::{Read, Seek, SeekFrom},
    path::Path,
    sync::{
        atomic::{AtomicU64, AtomicUsize, Ordering},
        Arc, Mutex,
    },
};
use tauri::{
    http::{header, Method, Request, Response, StatusCode, Uri},
    AppHandle, Manager, UriSchemeContext, UriSchemeResponder, WebviewWindow, Wry,
};
use tauri_plugin_dialog::DialogExt;

pub(crate) const SCHEME: &str = "srtmedia";
const MAX_RESPONSE_BYTES: u64 = 1024 * 1024;
const MAX_FILE_BYTES: u64 = 64 * 1024 * 1024 * 1024;
const VIDEO_EXTENSIONS: [&str; 6] = ["mp4", "m4v", "webm", "mov", "mkv", "hevc"];

struct MediaFile {
    token: String,
    file: File,
    len: u64,
    content_type: &'static str,
}

#[derive(Serialize)]
pub(crate) struct MediaSelection {
    token: String,
    name: String,
}

#[derive(Clone, Default)]
pub(crate) struct MediaAccess {
    current: Arc<Mutex<Option<MediaFile>>>,
    picker: Arc<AtomicUsize>,
    requests: Arc<AtomicUsize>,
    epoch: Arc<AtomicU64>,
}

struct Permit(Arc<AtomicUsize>);

impl Permit {
    fn acquire(counter: &Arc<AtomicUsize>, limit: usize) -> Option<Self> {
        counter
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |count| {
                (count < limit).then_some(count + 1)
            })
            .ok()?;
        Some(Self(counter.clone()))
    }
}

impl Drop for Permit {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::Release);
    }
}

impl MediaAccess {
    pub(crate) fn clear(&self) {
        let mut current = self.current.lock().unwrap();
        self.epoch.fetch_add(1, Ordering::Release);
        current.take();
    }

    fn close(&self, token: &str) {
        let mut current = self.current.lock().unwrap();
        if current.as_ref().is_some_and(|file| file.token == token) {
            current.take();
        }
    }

    fn respond(&self, token: &str, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
        let mut current = self.current.lock().unwrap();
        let Some(file) = current.as_mut().filter(|file| file.token == token) else {
            return empty(StatusCode::NOT_FOUND);
        };
        serve(file, request)
    }
}

fn media_type(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "mp4" | "m4v" => Some("video/mp4"),
        "webm" => Some("video/webm"),
        "mov" => Some("video/quicktime"),
        "mkv" => Some("video/x-matroska"),
        "hevc" => Some("video/h265"),
        _ => None,
    }
}

#[cfg(windows)]
fn local_path(path: &Path) -> bool {
    use std::{
        os::windows::ffi::OsStrExt,
        path::{Component, Prefix},
    };
    use windows_sys::Win32::Storage::FileSystem::GetDriveTypeW;
    let mut components = path.components();
    let Some(Component::Prefix(prefix)) = components.next() else {
        return false;
    };
    let (Prefix::Disk(drive) | Prefix::VerbatimDisk(drive)) = prefix.kind() else {
        return false;
    };
    if components.next() != Some(Component::RootDir)
        || !components.all(|part| {
            matches!(part, Component::Normal(name) if !name.encode_wide().any(|unit| unit == 0 || unit == u16::from(b':')))
        })
    {
        return false;
    }
    let root = [u16::from(drive), u16::from(b':'), u16::from(b'\\'), 0];
    // Removable, fixed, optical and RAM disks are local. UNC and mapped shares
    // are rejected before canonicalization or opening any path component.
    matches!(unsafe { GetDriveTypeW(root.as_ptr()) }, 2 | 3 | 5 | 6)
}

#[cfg(not(windows))]
fn local_path(_path: &Path) -> bool {
    false
}

fn file_error(error: OpenFailure) -> String {
    match error {
        OpenFailure::Unsafe => "视频路径包含链接、重解析点，或在选择后发生了变化。".into(),
        OpenFailure::Io(error) => format!(
            "无法以只读方式打开所选视频。请检查权限或关闭正在写入文件的程序（{}）。",
            error.kind()
        ),
    }
}

fn open_media(path: &Path) -> Result<(MediaFile, MediaSelection), String> {
    if !local_path(path) {
        return Err("请选择本地磁盘上的视频。网络路径或特殊设备路径不可用。".into());
    }
    let content_type = media_type(path).ok_or("请选择 MP4、WebM、MOV、MKV 或 HEVC 文件。")?;
    let parent = path.parent().ok_or("视频路径无效。")?;
    let ancestors: Vec<_> = parent.ancestors().collect();
    let mut directories = Vec::<LockedEntry>::new();
    for directory in ancestors.into_iter().rev() {
        let root = directories.last().map(|entry| entry.final_path.as_path());
        directories.push(locked_open(directory, root, true).map_err(file_error)?);
    }
    let root = directories.last().map(|entry| entry.final_path.as_path());
    let entry = locked_open(path, root, false).map_err(file_error)?;
    let canonical = fs::canonicalize(path).map_err(|_| "无法核对所选视频的实际路径。")?;
    if !within(&canonical, &entry.final_path) || !within(&entry.final_path, &canonical) {
        return Err("视频路径在选择后发生了变化。".into());
    }
    let len = entry.metadata.len();
    if len == 0 || len > MAX_FILE_BYTES {
        return Err("视频为空或超过 64 GiB 的预览上限。".into());
    }
    let token = uuid::Uuid::new_v4().simple().to_string();
    let name = path
        .file_name()
        .ok_or("视频文件名无效。")?
        .to_string_lossy()
        .into_owned();
    Ok((
        MediaFile {
            token: token.clone(),
            file: entry.file,
            len,
            content_type,
        },
        MediaSelection { token, name },
    ))
}

#[tauri::command]
pub(crate) async fn select_video(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<Option<MediaSelection>, String> {
    ensure_main(&window)?;
    let access = app.state::<MediaAccess>().inner().clone();
    let picker = Permit::acquire(&access.picker, 1).ok_or("视频选择器已经打开。")?;
    let epoch = access.epoch.load(Ordering::Acquire);
    tauri::async_runtime::spawn_blocking(move || {
        let _picker = picker;
        let Some(file) = app
            .dialog()
            .file()
            .set_parent(&window)
            .set_title("选择本地视频")
            .add_filter("本地视频", &VIDEO_EXTENSIONS)
            .blocking_pick_file()
        else {
            return Ok(None);
        };
        let path = file
            .into_path()
            .map_err(|_| "所选视频没有可用的本地路径。")?;
        let (opened, selection) = open_media(&path)?;
        let mut current = access.current.lock().unwrap();
        if access.epoch.load(Ordering::Acquire) != epoch {
            return Ok(None);
        }
        *current = Some(opened);
        Ok(Some(selection))
    })
    .await
    .map_err(|_| "视频选择任务未能完成。")?
}

#[tauri::command]
pub(crate) async fn release_video(
    app: AppHandle,
    window: WebviewWindow,
    token: String,
) -> Result<(), String> {
    ensure_main(&window)?;
    let access = app.state::<MediaAccess>().inner().clone();
    tauri::async_runtime::spawn_blocking(move || access.close(&token))
        .await
        .map_err(|_| "视频访问会话未能释放。".into())
}

fn request_token(uri: &Uri) -> Option<&str> {
    if uri.scheme_str() != Some(SCHEME)
        || uri.authority()?.as_str() != "localhost"
        || uri.query().is_some()
    {
        return None;
    }
    let token = uri.path().strip_prefix('/')?;
    (token.len() == 32
        && token
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f')))
    .then_some(token)
}

pub(crate) fn handle(
    context: UriSchemeContext<'_, Wry>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    if context.webview_label() != "main" || request_token(request.uri()).is_none() {
        responder.respond(empty(StatusCode::NOT_FOUND));
        return;
    }
    if !matches!(*request.method(), Method::GET | Method::HEAD) || !request.body().is_empty() {
        let mut response = empty(StatusCode::METHOD_NOT_ALLOWED);
        response
            .headers_mut()
            .insert(header::ALLOW, "GET, HEAD".parse().unwrap());
        responder.respond(response);
        return;
    }
    let access = context.app_handle().state::<MediaAccess>().inner().clone();
    let Some(permit) = Permit::acquire(&access.requests, 4) else {
        responder.respond(empty(StatusCode::SERVICE_UNAVAILABLE));
        return;
    };
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        let token = request_token(request.uri()).expect("URI was checked above");
        responder.respond(access.respond(token, &request));
    });
}

fn response(status: StatusCode) -> tauri::http::response::Builder {
    Response::builder()
        .status(status)
        .header(header::CACHE_CONTROL, "no-store")
        .header(
            header::CONTENT_SECURITY_POLICY,
            "default-src 'none'; sandbox",
        )
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
}

fn empty(status: StatusCode) -> Response<Vec<u8>> {
    response(status)
        .header(header::CONTENT_LENGTH, 0)
        .body(Vec::new())
        .unwrap()
}

fn decimal(value: &str) -> Option<u64> {
    (!value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()))
        .then(|| value.parse().ok())
        .flatten()
}

fn byte_range(value: &str, len: u64) -> Option<(u64, u64)> {
    if value.len() > 64 || len == 0 {
        return None;
    }
    let (unit, spec) = value.split_once('=')?;
    if !unit.eq_ignore_ascii_case("bytes") {
        return None;
    }
    let (start, end) = spec.split_once('-')?;
    let (start, end) = if start.is_empty() {
        let count = decimal(end)?;
        if count == 0 {
            return None;
        }
        (len - count.min(len).min(MAX_RESPONSE_BYTES), len - 1)
    } else {
        (
            decimal(start)?,
            if end.is_empty() {
                len - 1
            } else {
                decimal(end)?.min(len - 1)
            },
        )
    };
    (start <= end).then(|| (start, end.min(start.saturating_add(MAX_RESPONSE_BYTES - 1))))
}

fn serve(file: &mut MediaFile, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let headers = |status, length| {
        response(status)
            .header(header::CONTENT_TYPE, file.content_type)
            .header(header::ACCEPT_RANGES, "bytes")
            .header(header::CONTENT_LENGTH, length)
    };
    if request.method() == Method::HEAD {
        return headers(StatusCode::OK, file.len).body(Vec::new()).unwrap();
    }
    let mut ranges = request.headers().get_all(header::RANGE).iter();
    let range = ranges.next();
    let slice = match range {
        Some(value) if ranges.next().is_none() => value
            .to_str()
            .ok()
            .and_then(|value| byte_range(value, file.len)),
        None if file.len <= MAX_RESPONSE_BYTES => Some((0, file.len - 1)),
        _ => None,
    };
    let Some((start, end)) = slice else {
        return headers(StatusCode::RANGE_NOT_SATISFIABLE, 0)
            .header(header::CONTENT_RANGE, format!("bytes */{}", file.len))
            .body(Vec::new())
            .unwrap();
    };
    let mut bytes = vec![0; (end - start + 1) as usize];
    if file
        .file
        .seek(SeekFrom::Start(start))
        .and_then(|_| file.file.read_exact(&mut bytes))
        .is_err()
    {
        return empty(StatusCode::INTERNAL_SERVER_ERROR);
    }
    let builder = if range.is_some() {
        headers(StatusCode::PARTIAL_CONTENT, bytes.len() as u64).header(
            header::CONTENT_RANGE,
            format!("bytes {start}-{end}/{}", file.len),
        )
    } else {
        headers(StatusCode::OK, bytes.len() as u64)
    };
    builder.body(bytes).unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unbounded_invalid_and_noncanonical_requests() {
        let len = 16 * MAX_RESPONSE_BYTES;
        assert_eq!(byte_range("bytes=2-4", len), Some((2, 4)));
        assert_eq!(
            byte_range("bytes=0-", len),
            Some((0, MAX_RESPONSE_BYTES - 1))
        );
        assert_eq!(byte_range("bytes=-2", len), Some((len - 2, len - 1)));
        assert_eq!(
            byte_range("bytes=-999999999", len),
            Some((len - MAX_RESPONSE_BYTES, len - 1))
        );
        assert_eq!(
            byte_range("bytes=16-999999999", len),
            Some((16, MAX_RESPONSE_BYTES + 15))
        );
        for invalid in [
            "bytes=99-12",
            "bytes=-0",
            "bytes=0-1,4-5",
            "bits=0-1",
            "bytes=0-18446744073709551616",
            "bytes=+2-3",
            "bytes=16777216-",
        ] {
            assert_eq!(byte_range(invalid, len), None, "{invalid}");
        }
        let id = "0123456789abcdef0123456789abcdef";
        let exact = format!("{SCHEME}://localhost/{id}").parse().unwrap();
        assert_eq!(request_token(&exact), Some(id));
        for uri in [
            format!("http://localhost/{id}"),
            format!("{SCHEME}://other/{id}"),
            format!("{SCHEME}://localhost/{id}?path=C:%5Csecret.mp4"),
            format!("{SCHEME}://localhost/x/../{id}"),
            format!("{SCHEME}://localhost/%2e%2e/{id}"),
            format!("{SCHEME}://localhost/{id}/extra"),
        ] {
            assert_eq!(request_token(&uri.parse().unwrap()), None, "{uri}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn only_the_live_native_handle_supports_bounded_reads_and_is_released_on_close() {
        let folder = std::env::temp_dir().join(format!("srttools-media-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&folder).unwrap();
        let path = folder.join("测试 # 视频.MP4");
        let replacement_path = folder.join("另一份.webm");
        let write = File::create(&path).unwrap();
        let len = 8 * MAX_RESPONSE_BYTES + 7;
        write.set_len(len).unwrap();
        drop(write);
        fs::write(&replacement_path, b"short media fixture").unwrap();
        let (first, selection) = open_media(&path).unwrap();
        assert_eq!(selection.name, "测试 # 视频.MP4");
        assert!(!local_path(Path::new(r"\\server\share\test.mp4")));
        assert!(!local_path(Path::new(r"C:\x\test.mp4:secret")));
        assert!(!local_path(Path::new(r"C:relative.mp4")));
        let access = MediaAccess::default();
        *access.current.lock().unwrap() = Some(first);
        let response = access.respond(
            &selection.token,
            &Request::builder()
                .header(header::RANGE, "bytes=4194304-")
                .body(Vec::new())
                .unwrap(),
        );
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(
            response.headers()[header::CONTENT_RANGE],
            format!("bytes 4194304-5242879/{len}")
        );
        assert_eq!(response.body().len(), MAX_RESPONSE_BYTES as usize);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        let head = access.respond(
            &selection.token,
            &Request::builder()
                .method(Method::HEAD)
                .body(Vec::new())
                .unwrap(),
        );
        assert_eq!(head.status(), StatusCode::OK);
        assert_eq!(head.headers()[header::CONTENT_LENGTH], len.to_string());
        assert!(head.body().is_empty());
        let plain = Request::new(Vec::new());
        let rejected = access.respond(&selection.token, &plain);
        assert_eq!(rejected.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(
            rejected.headers()[header::CONTENT_RANGE],
            format!("bytes */{len}")
        );
        assert_eq!(
            access.respond(&"0".repeat(32), &plain).status(),
            StatusCode::NOT_FOUND
        );
        assert!(fs::OpenOptions::new().write(true).open(&path).is_err());
        let (replacement, next) = open_media(&replacement_path).unwrap();
        *access.current.lock().unwrap() = Some(replacement);
        assert_eq!(
            access.respond(&selection.token, &plain).status(),
            StatusCode::NOT_FOUND
        );
        access.close(&selection.token);
        assert_eq!(
            access.respond(&next.token, &plain).body(),
            b"short media fixture"
        );
        access.close(&next.token);
        assert_eq!(
            access.respond(&next.token, &plain).status(),
            StatusCode::NOT_FOUND
        );
        fs::remove_file(path).unwrap();
        fs::remove_file(replacement_path).unwrap();
        fs::remove_dir(folder).unwrap();
    }
}
