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

### 干净主线候选

功能分支 `ce7af71fb50facf44599250bb204fd357ee81b4b` 先通过完整发布。快进合并时，Git 将部分新文件从 LF 重新签出为 CRLF，导致原始字节指纹变化。在 `main` 重建的第一轮 ZIP 通过，Setup 在重启后的既有预设选框等待焦点失败，分支候选保持原样。延长并验证自有控件焦点后，同一 Setup 复查通过，再从干净的 `main` 执行完整发布。

最终构建源码 `86660d75a0e3fe20d8e1be603d91b5c73ec70959`，源码指纹 `E5E0152E2BB62B6D4813AF2C9A8BFCCF9778FA68F310BC6478626BFA9D2ADAEC`。2026-11-06 完成 `npm ci`（268 包）、`npm run check:versions`（6 个版本字段）、`npm run release:win -- --check`、`npm run release:win` 和 `npm run release:verify`。

正式构建通过 lint、类型检查、18 项发布安全、325 项 Vitest、78 项 Chromium、42 项 Rust、严格 Clippy、PowerShell 5.1 的 21 文件解析及 10 项安全/12 项状态保护、前端和 Tauri NSIS 构建。Vite 提示主入口约 567.61 kB。ZIP 解压版与实际 NSIS 安装版均通过旧工作流 10 项和时间轴 7 项。实际安装、运行、卸载及 Store/注册状态恢复共 19 项。已安装 EXE 的独立哈希为 `10355C969F98FE714FA02A1F7AE8DDEEA6D9F79A42433E5C419759DBCBCD2DC9`。

| 固定产物 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `SRTTools-Setup.exe` | 2,104,959 | `88F32D776488B29BEBDE6FABD61F320D397A0F1C53284D9672F98B8751FA14B7` |
| `SRTTools.zip` | 2,421,057 | `3602A7EBEBCC577D8C115F773AAB17939BECB31BE9F24ECB5DDAEA869B6F57B1` |
| `SRTTools/subtitle-tools.exe` | 4,487,168 | `CB047118E9310A03190E4EA69A36248C273E78BC31CD1F1BFDDB8D1F98D0B89E` |
| `SRTTools/THIRD_PARTY_NOTICES.txt` | 728,050 | `A17EA3B35FF06CEC85022E4034F85F2061505E68D5D18306B2B1EC0B257E7780` |
| `build-info.json` | 6,815 | `D53A99F2234CDDEEB6A74C98A3DE58FD6B45699691D87850430774E62B018114` |
| `SHA256SUMS.txt` | 439 | `5F6A021515E3B4FAB3A7A50BBE1B653B809B12054F95B1313B0E82F43F265AD3` |

六件合计 9,748,488 字节。受控阶段目录和可识别的 NSIS 中间安装器由脚本清理，未知目录保留。两个 EXE 均为 `NotSigned`。

Windows 10、125%/150%/200% DPI、干净无 WebView2 环境和超长路径系统选择器为 NOT RUN。浏览器 900×620 与 Windows 物理指针分别验证。权限拒绝重试的新增 IPC 场景使用 Chromium 模拟，原生实测包括保存对话框取消、导出、原字节保护与原工作流的失败重试。v0.5.0 的媒体验证属于下一阶段。

### 完整基准

`npm run benchmark` 在功能分支合格源码 `ce7af71fb50facf44599250bb204fd357ee81b4b` 完成，报告写入 `src-tauri/target/benchmark/PERFORMANCE_v0.5.0.md` 及同名 `_current.json`、`_browser.json`。既有 v0.4.0 历史报告保留。

| 现有三步流程 | 中位数 ms | 实测范围 ms |
| --- | ---: | ---: |
| 50,000 条，Node 引擎 | 295.94 | 290.47–302.91 |
| 50,000 条，Chromium Worker | 455.90 | 453.00–456.10 |
| 100 文件，Chromium Worker | 3,053.40 | 3,047.40–3,076.20 |

旧基线输出哈希、长行优化输出哈希与 Worker 终止检查通过。实际创建、终止均为 1,017，结束时活动 Worker 为 0。单次复测的时长用于记录当前环境，不据此归因跨版本波动。
