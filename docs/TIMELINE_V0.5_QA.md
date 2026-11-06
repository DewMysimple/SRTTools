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
