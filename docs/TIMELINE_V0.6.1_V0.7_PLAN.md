# 第七阶段基线审计

2026-11-06，在 Windows 11 Pro x64 26200 上执行 `git status --short --branch`、`git remote -v`、`git fetch origin`、`git ls-remote origin refs/heads/main`、`git log --oneline --decorate -n 15`。本地 `main`、`origin/main` 和远端实际引用均为 `d74e14c7420fad026e5bce14dbbc7b135a22e261`。`origin` 的 fetch/push 均指向 `https://github.com/DewMysimple/SRTTools.git`，读取及 fetch 成功，写入结果以阶段推送为准。跟踪文件无改动，用户提供的第七阶段任务书是唯一未跟踪文件。

`npm run check:versions` 的六个 npm/Cargo/Tauri 版本字段均为 0.6.0，README、功能清单、变更记录与已交付清单均指向该版。发布前库存六件共 9,840,893 字节。现有 `release:win` 从独立暂存完成 ZIP、安装版验收与事务式晋升。

## 入口和缺口

| 范围 | 现有实现与本轮切入点 |
| --- | --- |
| 字幕与事务 | `src/core/models.ts`、`src/core/time.ts` 和 `src/features/timeline/core/editing-session.ts`。时间轴已有单/多选、精确输入、指针拖动/修剪、吸附、微调和撤销重做。拖动预览留在 `TimelineView`，工作区只在确认后接收事务。尚无提交 revision 和跨进程恢复。 |
| 工作区与导出 | `TimelineWorkspace.tsx`、`timeline-document-service.ts`、Worker、`file-service.ts` 和 `commands/safe_files.rs`。编辑保真、SRT 严格往返检查、重名避让和取消离开已实现。保留原导出链路，恢复或冲突仅进入内存。 |
| 校时与媒体 | `MediaPreview.tsx`、`media-sync.ts`、`core/media-timing.ts`、`commands/media.rs` 已有共享时钟、点击定位、字幕叠加、A/B 循环、限权 Range。当前没有播放头设端点、相邻字幕导航、选区预览、校时拆分或两点线性校准。 |
| 设置与差异 | `settings-service.ts` 的固定设置键、`SubtitleDiffPreview` 与共享逻辑对齐可复用。草稿使用独立本地目录，历史和预设继续只保存原有数据。 |

## 基线验证

`npm run lint`、`npm run build`（含 TypeScript）、`npm test`（332）、`npm run test:e2e`（81 Chromium）、`npm run test:release`（19）、`cargo test --locked --manifest-path src-tauri/Cargo.toml`（46）、`cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` 均 PASS。基线 Vite 已有单个 500 kB 压缩前分块提示。`npm run disk:report` 记录基线库存。相同主机独立运行 `npm run benchmark` 通过，50,000 条三步工作流的 Node / Chromium Worker 中位数为 295.10 / 456.40 ms，Worker 创建和终止各 1,017 次，活动数 0。回执在 `src-tauri/target/v061-baseline-benchmark.log`。

## 阶段边界

1. 在 `codex/v0.6.1-recovery` 完成 Gate 1 存储事务与故障注入、Gate 2 恢复/冲突与生命周期、Gate 3 Windows 两种发行形态与基准。使用独立、不可变的本地快照，先校验再发布，容量耗尽时保全活跃记录。字节指纹来自原生选择导入，自动复核受限于已记录的原字幕。已完成验收才替换现有交付并合并主线。
2. 从已核验的 v0.6.1 主线创建 `codex/v0.7.0-precision-timing`，按 Gate 4 设时与导航、Gate 5 选区预览与拆分、Gate 6 两点校准、Gate 7 界面/回归顺序推进。复用媒体时钟和编辑事务，复杂预览与当前 revision 绑定。
3. 本机具备 Windows 11、WebView2 和 FFmpeg 测试素材依赖。Win10、完全干净 WebView2、实际休眠及不同物理 DPI 组合依可用设备实测，缺环境逐项记录。两阶段验收各有独立 QA 文档，正式产物目录仅保留最后一次成功交付。
