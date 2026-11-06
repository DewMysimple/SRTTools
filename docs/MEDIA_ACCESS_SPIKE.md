# 本地媒体访问技术验证

本实验从 v0.5.0 已验主线 `8790e73e7a6a12f4b0b2b5538a9805cbe671aa1d` 开始。实验包沿用 0.5.0 版本字段，在受控测试目录运行。实际用户候选仍由 `release-output/` 的最后一次合格版本提供。

## 技术选择

锁定 Tauri 2.12.5、Wry 0.57.1。Tauri 的 asset scope 可追加单文件允许项和禁止项，禁止项优先且没有撤销单项的公开 API。连续打开、关闭及重新选择同一文件需要可撤销会话，因此采用 Wry 的专用 `srtmedia` 协议，保留资产协议禁用。WebView2 使用 `http://srtmedia.localhost/<token>`，前端 CSP 仅在 `media-src` 允许该来源。[Tauri 资产范围](https://v2.tauri.app/security/asset-protocol/) · [Tauri 2.12.5 Scope](https://docs.rs/tauri/2.12.5/tauri/scope/fs/struct.Scope.html) · [Tauri 2.12.5 Builder](https://docs.rs/tauri/2.12.5/tauri/struct.Builder.html#method.register_asynchronous_uri_scheme_protocol)

只有主窗口的原生文件选择器能创建权限。Rust 校验本地盘、普通文件、扩展名、大小、路径组件和每层重解析点，并核对打开句柄的规范路径。该会话持有只读句柄，IPC 返回随机令牌与文件名。URL 仅接受固定来源和一个令牌路径段。新选择替换旧句柄，关闭、主页面重新加载或窗口销毁撤销。浏览器收到的读取响应单次最多 1 MiB，支持 GET 单 Range 与 HEAD，越界或畸形 Range 返回 416。[HTTP Range](https://www.rfc-editor.org/rfc/rfc9110.html#name-range-requests)

UUID 使用既有锁定并已有 NOTICE 的 `uuid 1.29.0`。实验未添加媒体运行时、外部服务或分发资源。第一轮 QA 尝试用隔离 WebView2 的 DevTools 端口抓取响应，但本机正式构建的自有 WebView2 进程没有启用指定端口。改用实验包内的 HTML5 事件记录与原生协议响应观测，由 Windows UI Automation 读取。记录仅含状态、时长、响应头和长度。[WebView2 调试](https://learn.microsoft.com/en-us/microsoft-edge/webview2/how-to/remote-debugging-desktop)

## 关闭与缓存

首轮 H.264/AAC 样本通过元数据、播放、暂停、三处 seek 和结束事件。随机令牌请求返回 404。关闭后重播旧 URL 时，WebView2 在同一文档复用已读过的媒体内存，新请求未到达 Rust；仅设置 HTTP `no-store` 无法实现完整撤销。该轮 Gate 记录为 FAIL。

最终方案在原生选中并验证文件后、发放令牌前，通过主 WebView2 的 COM 宿主 API 调用固定的 `Network.enable`（诊断缓冲限额为 0）和 `Network.setCacheDisabled`。两次回调须成功，才发放权限。该设置作用于本次使用视频的应用 WebView，WebView 销毁后结束。该 API 没有从前端接受命令或打开远程调试端口。关视频时暂停、去除 `src`、调用 `load()`，然后原生撤销；同一旧 URL 在实际重播探针中重新到达 Rust 并返回 404。COM 封装 `webview2-com 0.39.1` 已在锁定清单和 NOTICE 内。[WebView2 宿主 API](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2#calldevtoolsprotocolmethod) · [Chromium 播放器缓存路径](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/core/html/media/html_media_element.cc)

## 原生证据

- PASS，`cargo test --manifest-path src-tauri/Cargo.toml --locked commands::media`，2 项，涵盖受限 URI、字节 Range、句柄锁、替换及撤销。
- PASS，Windows 11 Pro 25H2 x64 26200.9711，WebView2 156.0.4314.58。实验包源码 `f7654639957ae58d678abb74f88d220887d8d576`，原生 QA 驱动 `d4bc597595b549ff4e22362ce4a188e33f5c8c0e`。从真实 ZIP 解压的 EXE SHA-256 为 `285D9D13403FC3ACABC8D946E2600AD43231D299317D3694405966DF72CFE6EF`。NSIS SHA-256 为 `B19043F7A6CF577168F49BEE1483B51A3C5FCD40238DED872117D35DF4D23182`，已安装 EXE 为 `61A065C8792C176FE47F8F1EADE87F39EDCFA8361C196005C837EFC5C13B9643`。
- 两个入口均实测原生选择、取消、八份样本的只读共享锁与关闭释放。可播放样本均记录 `loadedmetadata`、`playing`、`pause`、`seeking`、`seeked` 和 `ended`。损坏 MP4 触发 `error` 4。每份原字节 SHA-256 不变，取消未产生会话，随机与关闭后的令牌均被拒绝。NSIS 实际安装/卸载和 Store/注册状态恢复通过。
- 缓存修复后的首次便携实验八项媒体检查均通过，但应用进程已退出时 WebView2 隔离目录仍有写入，清理 Gate 为 FAIL。加入等待自有 WebView2 写入进程结束后，同一实验包重跑便携和安装验收均通过，旧失败目录确认已停止写入后按既有保护函数清除。

| 合成样本 | 字节数 | 本机 ZIP / Setup |
| --- | ---: | --- |
| H.264/AAC MP4，中文、空格、`#`、emoji 文件名 | 59,999 | PASS，8 秒，seek 0.4 / 4 / 7.6 秒 |
| H.264/AAC MP4，大文件 | 280,707,222 | PASS，160 秒，seek 8 / 80 / 152 秒 |
| H.264 MP4，无音轨 | 5,232 | PASS，视频可播 |
| 损坏 MP4 | 56 | PASS，预期解码错误 |
| VP8/Opus WebM | 92,209 | PASS |
| H.264/AAC MOV | 60,050 | PASS |
| H.264/AAC MKV | 56,648 | PASS |
| HEVC/AAC MP4 | 68,133 | PASS |

上述结果只覆盖给定编码、样本和运行时。其他编码、Windows 10、无解码扩展的 HEVC 环境、映射网络盘和长路径系统选择器为 NOT RUN。UNC 和映射网络盘在路径授权规则中拒绝，`?` 不属于常规 Windows 文件名。Rust 测试覆盖大小写扩展名、UNC、驱动器相对路径和 NTFS 数据流拒绝。

大文件在两种入口各实际返回 25 个 206 响应，共 25,903,254 字节，最大响应 1,048,576 字节。起始响应为 `Content-Range: bytes 0-1048575/280707222`；末段为 `bytes 279969792-280707221/280707222`，长度 737,430。未知和撤销令牌的实际请求都是 404 且响应体 0 字节。大文件选择 IPC 的令牌和文件名 JSON 为 63 字节。间隔采样的 renderer JS heap 增量为 56,358 字节（ZIP）与 58,856 字节（Setup），这项采样的范围是 renderer JS，媒体进程和系统峰值未测量。

## 重现与素材

使用本机 FFmpeg n8.0.1-23 在 `src-tauri/target/media-gate-fixtures/` 生成合成测试文件。小 MP4 使用 320×180、30 fps、8 秒纯色画面和 48 kHz 正弦音，H.264 baseline、AAC 48 kbps、faststart。大 MP4 使用 640×360、24 fps、160 秒 `testsrc2` 与正弦音，H.264 固定 14 Mbps、每 24 帧关键帧、AAC 48 kbps、faststart。无音轨版从小样本移除音频，MOV/MKV 直接封装，WebM 转 VP8/Opus，HEVC 版本用 x265、`hvc1` 和原 AAC。损坏样本为 56 字节的合成文本。小、大主样本 SHA-256 分别为 `56C7209E107F7C91D0C51C47BF69ABE65371EB722000FAE572DD8F2315B2B2EF` 与 `001FBB58F36B785B15402BD5F4C42A81AF32B9D52F559DCEBED96534007063BC`。逐样本哈希与响应明细在测试回执中。

实验构建用 `npm run tauri -- build`。在实验提交 `d4bc597595b549ff4e22362ce4a188e33f5c8c0e` 可使用 `scripts/windows-smoke.ps1 -Scenario media-spike -ExpectedVersion 0.5.0` 对实际解压 EXE 执行检查，并以 `scripts/windows-setup-acceptance.ps1 -SmokeScenario media-spike -ExpectedVersion 0.5.0` 对同批 Setup 检查。绝对产物和回执路径按脚本参数传入。原始回执位于 `src-tauri/target/media-spike-candidate/cache-bypass/portable-proof-quiescent.json` 与 `installed-proof-quiescent.json`。v0.6.0 清除了实验控件和诊断 IPC，正式包改用实际时间轴界面验收，见 [v0.6.0 QA](TIMELINE_V0.6_QA.md)。
