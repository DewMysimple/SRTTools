# 时间轴与本地视频预览实施记录

## Gate 0 · v0.4.0 基线

2026-11-06，`git fetch origin` 成功。唯一工作树在 `main`，本地与实际远端均为 `20314ade488b49813f17e53cb889098f5ffc8177`，fetch/push 均指向 `DewMysimple/SRTTools`。无已跟踪改动。用户提供的第六阶段任务书与执行背景两份未跟踪文件保留在原位。六处 npm、Cargo 与 Tauri 版本为 0.4.0，README、更新记录及第五阶段收尾报告相符。

| 当前基线 | 已核实入口 |
| --- | --- |
| 默认工具箱导航 | `src/app/App.tsx` 的哈希路由，首页、全部工具、批量、记录、设置、模板 |
| 共享字幕语义 | `src/core/models.ts`、`parser.ts`、`time.ts`、`serializer.ts`、`encoding.ts`、`validate.ts` |
| 文件边界 | `src/services/file-service.ts` 与 Rust `commands/mod.rs` 的原生选择、授权、容量限制和无覆盖写入 |
| 既有复用点 | `src/workers/worker-logic.ts` 的解码/解析入口、`src/components/subtitle-diff-preview.tsx` 的差异预览 |
| 验证和晋升 | `scripts/build-release.mjs`、`verify-release.mjs`、`windows-smoke.ps1`、`windows-setup-acceptance.ps1` |

没有既有时间轴、视频元素或媒体协议。原 CSP 以字幕文件工具箱为范围。任务书明确允许独立时间轴和视频预览。v0.5.0 先通过无视频 SRT 编辑与 Windows Gate，再从已合并主线开展 v0.6.0 的原生媒体验证。媒体访问的放行、分段读取与撤销须有 WebView2 证据。

### 基线命令

Windows 11 Pro 25H2 x64，26200.9711，Node 24.16.0、Rust 1.97.0、WebView2 156.0.4314.58。

| 命令 | 结果 |
| --- | --- |
| `npm run check:versions`、`npm run lint`、`npm run build`（含类型检查） | PASS |
| `npm test`、`npm run test:e2e`、`npm run test:release` | PASS，311、72、17 |
| `cargo test --manifest-path src-tauri/Cargo.toml --locked`、`cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings` | PASS，42 Rust 测试 |
| `npm run release:verify` | PASS，既有 0.4.0 产物与当前源码指纹一致 |
| `npm run release:win -- --check` | 预检按设计拒绝含未跟踪任务文件的工作树。正式构建在提交后的干净工作树运行 |
| `npm run disk:report` | PASS，当前发布目录六件共 9,629,542 字节 |

基线未重做 0.4.0 Windows 安装，历史证据见[第五阶段收尾](RELEASE_CLOSURE_v0.4.0.md)。

## Gate 1 · 编辑和坐标模型

`src/features/timeline/core/` 直接使用 `SubtitleDocument` 与稳定的 `cue.id`。每次提交保存受影响条目和原位置，最多保留 100 个事务。原始文档与上次成功导出是独立基准。多条移动先验证所有新时间再应用，负值、越序、溢出都会使整个事务失败。

时间轴使用整数毫秒和连续像素坐标。长时间范围用有限滚动轨道映射逻辑时间。区间索引通过分支最大结束时间跳过不可见字幕；重叠行由已排序区间的最早结束堆分配。重叠显示与时间数据分别计算。

`npm test -- src/features/timeline/core/timeline-core.test.ts` 通过 8 项，`npm run typecheck` 通过。
