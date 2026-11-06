# v0.6.1 草稿恢复验收

起始主线与基线证据见[第七阶段基线审计](TIMELINE_V0.6.1_V0.7_PLAN.md)。本地候选进入 Windows 打包验收，正式包、源码 SHA 与兼容性矩阵待实测后写入。

## 实现和故障覆盖

- `commands/drafts.rs` 管理有界、带 SHA-256 的不可变快照，以及受限 SRT 字节复核。原子发布、错误码 17 的同步副本回退及退役标记均保留上一次完整提交。
- `draft-recovery-service.ts` 和 `TimelineWorkspace.tsx` 在共享编辑事务外调度保护，处理可等待的切换、保留和导出。媒体 grant 保持由现有组件和原生协议管理。
- Rust 草稿专项八项已通过。故障注入包括部分暂存、完整暂存后发布失败、模拟权限/磁盘失败、最新快照截断/损坏、退役清理中断。另实测 Windows 独占占用、junction 拒绝和本机 AppLocalData 目录重定向。

## 早期候选

首个干净候选 `0cff034036b3e68e485a0b191e11c85b84a547e4` 的 86 项 Chromium 回归、Rust 和构建通过。原生在旧组合框驱动的 PowerShell 5.1 `Windows.Point` 无参构造失败，发布保留 0.6.0 的旧包。独立真实草稿场景进一步发现此测试机的新建 AppLocalData 目录由系统映射到另一块本地磁盘，普通作用域比较拒绝了其写入。当前候选固定两条路径的各级句柄并拒绝 reparse 和非本地目标，正向与 junction 反例均通过。初次失败及诊断回执保存在 `src-tauri/target/v061-*`。

`fd3f2a554cc0c65a4955750b9e28eaab6e18a9d0` 的 ZIP 候选通过工作流、媒体与六项真实草稿场景，性能驱动在原生文件打开尚未完成时访问禁用字段，候选未晋升。增加检查器可编辑等待后，同一程序的独立 `windows-smoke.ps1 -Scenario recovery -ExpectedVersion 0.6.1` 完整通过，包含 500 / 5,000 / 10,000 条采样。此回执用于诊断，正式验收仍要求 ZIP 与 Setup 分别通过。
