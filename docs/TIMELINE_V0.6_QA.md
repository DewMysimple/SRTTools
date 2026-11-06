# v0.6.0 时间轴与本地视频验收

## 测试环境

Windows 11 Pro 25H2 x64（26200.9711），Edge WebView2 156.0.4314.58，Node 24.16.0，npm 12.0.1，Rust 1.97.0 MSVC，Tauri Rust 2.12.5 / CLI 2.12.4。原生脚本使用 Windows PowerShell 5.1 与 UI Automation，浏览器回归使用 Playwright Chromium。

## 媒体样本和重现

`scripts/generate-media-fixture.mjs` 生成 320×180、30 fps、8 秒的纯色样本。Windows 使用 H.264 Baseline 和 48 kHz、48 kbps AAC 正弦音，MP4 启用 faststart。Chromium 用 VP8 WebM，浏览器测试模拟 IPC 与 Range 响应，使用真实 HTML 视频解码。FFmpeg 只在测试主机生成素材，安装器和便携版使用系统 WebView2。

```powershell
npm ci
npm run check:versions
npm run test:e2e -- e2e/media-preview.spec.ts
cargo test --locked --manifest-path src-tauri/Cargo.toml commands::media::tests
npm run release:win -- --check
npm run release:win
npm run release:verify
npm run disk:report
```

正式流程在 ZIP 解压 EXE 和 Setup 安装后的 EXE 上分别运行 `windows-smoke.ps1 -Scenario workflow -ExpectedVersion 0.6.0`。仅重跑媒体场景时可传 `-Scenario media`，并传入绝对 `-ExePath` 和 `-ReportPath`。驱动以独立临时配置启动实际应用，结束后校验源文件哈希并恢复设置。Windows 构建、安装和验收需要已登录桌面。

## 检查范围

| 检查 | 验证方式 |
| --- | --- |
| 同步与草稿 | Chromium 检查起点含、末端开、间隙、重叠、文本安全、实际播放与定位。Windows 验证 0.4 / 2.2 / 4 / 5 / 7.6 秒跳转及 8 秒结束，草稿与导出继续有效。 |
| 播放控制与 A/B | 原生 UI Automation 操作播放、暂停、音量、静音、倍速，验证实际时间经过 B 前回到 A，清除后继续越过 B。Vitest 另覆盖缓冲、播放拒绝、连续 seek、到达媒体末尾后的循环。 |
| 异常与生命周期 | 检查取消选择、损坏文件、人为占用、源句柄锁定和释放、替换与重开。原生 Rust 回归覆盖 junction 祖先、UNC/设备路径、非法 URI、未授权、过期令牌和读取边界。 |
| 兼容性 | MP4 H.264/AAC 是本次正式包主验收。VP8/Opus WebM、无音轨 MP4、H.264/AAC MOV/MKV、HEVC/AAC MP4 各一个样本在同一运行时的技术实验通过。结果限于该编码、容器与环境。 |
| 体积与资源 | 280,707,222 字节视频的实际原生 Range、内存和撤销证据见 [Gate 4](MEDIA_ACCESS_SPIKE.md)。最终包保持现有运行时文件白名单。 |

10000 条字幕、900×620 窗口、收起画面后，Chromium 实测 1.25 秒内采集 76 次动画帧间隔，P95 16.7 ms，长任务 0，字幕列表与检查器 DOM 变动 0。光标继续推进，播放、展开画面和另存可到达。此结果来自本机单次采样，反映前端工作区在该负载下的表现。

![合成样本的重叠字幕与播放光标](screenshots/media-preview-v060.png)

## 兼容与验证边界

Windows 10、全新 WebView2 安装、实际系统休眠恢复、125%/150%/200% 系统 DPI、受限用户真实目录、映射网络盘及 Windows 原生长路径选择器为 NOT RUN。技术实验覆盖中文、空格、`#` 与 emoji 文件名，正式包延续同一安全协议。本轮发布仅限项目固定本地产物，项目许可证由用户留待公开发布前决定。
