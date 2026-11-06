# 本地媒体访问技术验证

本实验从 v0.5.0 已验主线 `8790e73e7a6a12f4b0b2b5538a9805cbe671aa1d` 开始。实验包沿用 0.5.0 版本字段，在受控测试目录运行。实际用户候选仍由 `release-output/` 的最后一次合格版本提供。

## 技术选择

锁定 Tauri 2.12.5、Wry 0.57.1。Tauri 的 asset scope 可追加单文件允许项和禁止项，禁止项优先且没有撤销单项的公开 API。连续打开、关闭及重新选择同一文件需要可撤销会话，因此采用 Wry 的专用 `srtmedia` 协议，保留资产协议禁用。WebView2 使用 `http://srtmedia.localhost/<token>`，前端 CSP 仅在 `media-src` 允许该来源。[Tauri 资产范围](https://v2.tauri.app/security/asset-protocol/) · [Tauri 2.12.5 Scope](https://docs.rs/tauri/2.12.5/tauri/scope/fs/struct.Scope.html) · [Tauri 2.12.5 Builder](https://docs.rs/tauri/2.12.5/tauri/struct.Builder.html#method.register_asynchronous_uri_scheme_protocol)

只有主窗口的原生文件选择器能创建权限。Rust 校验本地盘、普通文件、扩展名、大小、路径组件和每层重解析点，并核对打开句柄的规范路径。该会话持有只读句柄，IPC 返回随机令牌与文件名。URL 仅接受固定来源和一个令牌路径段。新选择替换旧句柄，关闭、主页面重新加载或窗口销毁撤销。浏览器收到的读取响应单次最多 1 MiB，支持 GET 单 Range 与 HEAD，越界或畸形 Range 返回 416。[HTTP Range](https://www.rfc-editor.org/rfc/rfc9110.html#name-range-requests)

UUID 使用既有锁定并已有 NOTICE 的 `uuid 1.29.0`。实验未添加媒体运行时、外部服务或分发资源。第一轮 QA 尝试用隔离 WebView2 的 DevTools 端口抓取响应，但本机正式构建的自有 WebView2 进程没有启用指定端口。改用实验包内的 HTML5 事件记录与原生协议响应观测，由 Windows UI Automation 读取。记录仅含状态、时长、响应头和长度。[WebView2 调试](https://learn.microsoft.com/en-us/microsoft-edge/webview2/how-to/remote-debugging-desktop)

## 验证状态

- PASS，`cargo test --manifest-path src-tauri/Cargo.toml --locked commands::media`，2 项，涵盖受限 URI、字节 Range、句柄锁、替换及撤销。
- NOT RUN，真实 WebView2 的原生对话框、元数据、播放、Range、错误、内存与关闭。
