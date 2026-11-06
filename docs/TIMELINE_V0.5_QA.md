# v0.5.0 时间轴验收

Windows 11 Pro 25H2 x64 26200.9711，WebView2 156.0.4314.58，Node 24.16.0，Rust 1.97.0。起始主线与基线测试见[实施记录](TIMELINE_IMPLEMENTATION.md)。

## 开发验证

- PASS，`npm test -- src/features/timeline`，14 项纯逻辑及编码/解析/导出集成断言。
- PASS，`npm run test:e2e -- e2e/timeline.spec.ts --output src-tauri/target/timeline-browser-initial`，5 项真实 Chromium 场景。早期运行发现工作区兄弟元素 key 重复，在切换文档时残留 DOM；区分 key 后，同套测试通过。
- PASS，`npm run test:release`，18 项。包含 0.5.0 缺便携或安装时间轴证据及错误 Setup 哈希时拒绝晋升，旧 0.4.0 全部字节保留。

### 视口测量

Chromium 900×620，同一页面顺序打开合成字幕。首个可操作状态包括 Playwright 文件选择与 Worker，缩放/滚动包含两次按钮点击和两帧等待，拖动为 12 段真实指针路径并等待 dirty 状态。下表记录一次开发运行的墙钟时间和 Chromium renderer JS 使用量，无 GC 控制，含页面既有对象。

| 字幕条数 | 打开 ms | 缩放/滚动 ms | 拖动 ms | 拟合/缩放后轨道块 | 列表项 | JS 已用字节 |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 500 | 159 | 140 | 297 | 27 / 27 | 8 | 34,058,680 |
| 5,000 | 280 | 137 | 266 | 27 / 27 | 8 | 36,483,472 |
| 10,000 | 286 | 124 | 283 | 27 / 27 | 8 | 63,975,160 |

重现命令为上述 Playwright 场景。工作区截图和测量数据由测试输出，不随软件分发。

## 发布门槛

正式 Windows 构建和完整原生复核待本阶段执行。只有现有流程及新增时间轴检查在 ZIP 解压与 NSIS 安装两种入口都通过，才能晋升。
