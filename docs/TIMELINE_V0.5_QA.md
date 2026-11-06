# v0.5.0 时间轴验收

Windows 11 Pro 25H2 x64 26200.9711，WebView2 156.0.4314.58，Node 24.16.0，Rust 1.97.0。起始主线与基线测试见[实施记录](TIMELINE_IMPLEMENTATION.md)。

## 开发验证

- PASS，`npm test -- src/features/timeline`，14 项纯逻辑及编码/解析/导出集成断言。
- PASS，`npm run test:e2e -- e2e/timeline.spec.ts --output src-tauri/target/timeline-v050-browser --reporter=list,html`，6 项 Chromium 场景。早期运行发现工作区兄弟元素 key 重复，在切换文档时残留 DOM；区分 key 后通过。另用浏览器中的桌面 IPC 模拟检查取消、权限拒绝和等字节重试。
- PASS，`npm run test:release`，18 项。包含 0.5.0 缺便携或安装时间轴证据及错误 Setup 哈希时拒绝晋升，旧 0.4.0 全部字节保留。

### 视口测量

Chromium 900×620，同一页面顺序打开合成字幕。首个可操作状态包括 Playwright 文件选择与 Worker，缩放/滚动包含两次按钮点击和两帧等待，拖动为 12 段真实指针路径并等待 dirty 状态。下表记录一次开发运行的墙钟时间和 Chromium renderer JS 使用量，无 GC 控制，含页面既有对象。

| 字幕条数 | 打开 ms | 缩放/滚动 ms | 拖动 ms | 拟合/缩放后轨道块 | 列表项 | JS 已用字节 |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 500 | 159 | 140 | 297 | 27 / 27 | 8 | 34,058,680 |
| 5,000 | 280 | 137 | 266 | 27 / 27 | 8 | 36,483,472 |
| 10,000 | 286 | 124 | 283 | 27 / 27 | 8 | 63,975,160 |

重现命令为上述 Playwright 场景。工作区截图使用合成 SRT，可查看[浏览器 1200×800 工作区](screenshots/timeline-v050.png)。

## 发布门槛

首次正式构建（`ae0f1af19133ddeee8d14c3c038a81b51cdc0547`）ZIP 原工作流和 7 项时间轴全部通过。安装后子测试失败，旧 0.4.0 六件仍通过产物完整性校验，清单和校验文件哈希不变。补充子阶段采集后，同一 Setup 复现为 WebView2 UIA 未暴露「参数预设」中的既有预设选项。测试驱动增加受焦点与进程约束的键盘选择并继续实测 123ms 应用值，同包复查通过 19 项 Setup、10 项原工作流和 7 项时间轴。最终晋升以干净源码重跑的构建清单为准。

### 干净候选

构建源码 `ce7af71fb50facf44599250bb204fd357ee81b4b`，源码指纹 `3D8047FD2898D8264ED0ABC71D5B5532C3B5733D7ACC2B3E77BDA6CD13EB54C1`。2026-11-06 完成 `npm ci`（268 包）、`npm run check:versions`（6 个版本字段）、`npm run release:win -- --check`、`npm run release:win` 和 `npm run release:verify`。

正式构建通过 lint、类型检查、18 项发布安全、325 项 Vitest、78 项 Chromium、42 项 Rust、严格 Clippy、PowerShell 5.1 的 21 文件解析及 10 项安全/12 项状态保护、前端和 Tauri NSIS 构建。Vite 提示主入口约 567.61 kB。ZIP 解压版与实际 NSIS 安装版均通过旧工作流 10 项和时间轴 7 项。实际安装、运行、卸载及 Store/注册状态恢复共 19 项；已安装 EXE 的独立哈希为 `A3283912BAEC94726C54558D684B2CC9CA7E80E837C002AAC4F359028ADD1389`。

| 固定产物 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `SRTTools-Setup.exe` | 2,104,659 | `A7F364084546AED5D3B40EEE9D3A3CA6C7A794BF4579148192F34F033312CB15` |
| `SRTTools.zip` | 2,421,059 | `DAD412017AC2B25AA207175A6DF9304D86DFEF9E48D9D7CB65155F3559BF5302` |
| `SRTTools/subtitle-tools.exe` | 4,487,168 | `B1DDF8958170C65203B5BD2415FF4DBDD5F3B7C07D86731F22484C5095E54254` |
| `SRTTools/THIRD_PARTY_NOTICES.txt` | 728,050 | `A17EA3B35FF06CEC85022E4034F85F2061505E68D5D18306B2B1EC0B257E7780` |
| `build-info.json` | 6,832 | `20EFA3BB37BF5E441DD91E2F884F8B53187E989B2259E83837D3AB44AF80B1BC` |
| `SHA256SUMS.txt` | 439 | `E05596A2154C8C872DCC8E14A94E84B66F175A01BD0B2C9407F7362956D25B82` |

`npm run disk:report` 核对六件合计 9,748,207 字节。受控阶段目录和可识别的 NSIS 中间安装器由脚本清理，未知目录保留。两个 EXE 均为 `NotSigned`。

Windows 10、125%/150%/200% DPI、干净无 WebView2 环境和超长路径系统选择器为 NOT RUN。浏览器 900×620 与 Windows 物理指针分别验证。权限拒绝重试的新增 IPC 场景使用 Chromium 模拟，原生实测包括保存对话框取消、导出、原字节保护与原工作流的失败重试。v0.5.0 的媒体验证属于下一阶段。

### 完整基准

`npm run benchmark` 在同一提交完成，报告写入 `src-tauri/target/benchmark/PERFORMANCE_v0.5.0.md` 及同名 `_current.json`、`_browser.json`。既有 v0.4.0 历史报告保留。

| 现有三步流程 | 中位数 ms | 实测范围 ms |
| --- | ---: | ---: |
| 50,000 条，Node 引擎 | 295.94 | 290.47–302.91 |
| 50,000 条，Chromium Worker | 455.90 | 453.00–456.10 |
| 100 文件，Chromium Worker | 3,053.40 | 3,047.40–3,076.20 |

旧基线输出哈希、长行优化输出哈希与 Worker 终止检查通过。实际创建、终止均为 1,017，结束时活动 Worker 为 0。单次复测的时长用于记录当前环境，不据此归因跨版本波动。
