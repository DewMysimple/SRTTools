# v0.2.0 → v0.3.0 工程审阅

核验日期：2026-11-04。本记录区分历史证据、本轮执行和待验证内容；最终状态随阶段验收更新。

## 主线合并（Gate 0）

| 引用 | 实际 SHA |
| --- | --- |
| 合并前 `origin/main` | `123eb499336f4f571c4ecf41f5fbe47da4223640` |
| 原开发分支 `origin/codex/v0.1.1-v0.2.0` | `f5c92e6afc056bee0dbeae052caa15f0bf70b226` |
| 快进合并后 `main` | `f5c92e6afc056bee0dbeae052caa15f0bf70b226` |
| 合并推送后 `git ls-remote origin refs/heads/main` | `f5c92e6afc056bee0dbeae052caa15f0bf70b226` |

实际执行 fetch/prune、remote/branch/log/diff 审计、`git switch main`、`git pull --ff-only origin main`、`git merge --ff-only origin/codex/v0.1.1-v0.2.0`、祖先检查、`git push origin main` 和远程 SHA 复核。快进合并没有制造额外 merge commit。未删除旧开发分支、历史或 tag。开始时唯一未跟踪文件为本轮任务书，完整保留并纳入任务提交。

本轮在合并后、开发 v0.3.0 之前重新执行：

| 检查 | 结果 |
| --- | --- |
| `npm ci` | PASS，266 packages |
| `npm run lint` / `npm run typecheck` | PASS |
| `npm test` | PASS，157 tests / 8 files |
| `npm run build` | PASS |
| `npm run test:e2e` | PASS，25 Chromium tests |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml` | PASS，13 tests |
| `cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` | PASS |
| 本轮 Windows 安装版复核 | PASS，17 项，安装/启动/选择器/导出/预设重启/Store 中断恢复/卸载，原 Store 已恢复 |

环境为本机 Windows 11 Pro 25H2（26200.9711）x64 / 96 DPI、PowerShell、Node 24.16.0 / npm 12.0.1、Rust/Cargo 1.97.0 MSVC、WebView2 156.0.4314.58。原生复核发生于 2026-11-04 13:01 起，安装器 1,394,885 bytes，SHA-256 `2E547758EB149D1F1DE59BBF84B7CA1FDF2FC035C95B6369EF336EF494906EA5`。原始摘要当时位于忽略的 `src-tauri/target/qa-v011/run-114203a4/native-report.json`，精简结果在此保留，不依赖永久保留临时目录。安装器业务源码 `581aaae` 与合并基线 `f5c92e6` 之间仅文档变化。Windows 10、无 WebView2 干净系统和其他 DPI 不能由 Chromium 测试证明。

## 现有实现审计与保留边界

- `src/core/diff/subtitle-diff.ts` 的对齐、歧义保守处理及 10,000 合计 cue / 2,000,000 UTF-16 单位预算已存在并有测试；本轮复用，独立来源比较明确关闭 cue ID 信任。
- `src/components/subtitle-diff-preview.tsx` 已有正文高亮、字段变化、筛选、分页和规模降级。现有处理前后预览继续保留。
- `src/services/preset-service.ts` 和 `tool-presets.tsx` 已有固定键 `tool-presets-v1`、白名单参数、串行写入、版本和容量保护。批量页已复用 `ToolWorkspace`，本轮沿同一组件补足验收，不新建存储框架。
- `src/core/encoding.ts` 现有 GBK/GB18030 只有手动解码，编码函数拒绝输出；新增能力必须验证真实字节和严格不可表示字符失败。
- `src-tauri/src/commands/mod.rs` 保留会话文件授权、目录写入授权和 Store 恢复事务。文件夹扫描只能由本次原生目录选择产生授权，不能给 Renderer 任意目录读取入口。
- `dist/` 为 Vite 暂存，`src-tauri/target/` 为 Rust 缓存；原先没有统一发布脚本和最终发布目录。本轮新增 `release-output/`，不改 `frontendDist`，不默认清除依赖与编译缓存。

## 阶段风险和验收位置

发布替换须先验证新产物、ZIP 清单和实际导入导出，再以可回滚方式发布。未知文件、链接跳转和外部 Cargo target 必须拒绝或跳过。Windows 右键菜单默认关闭，仅在具备安全启停和卸载证据时开放。功能、发布、清理和原生验收结果最终归入 [测试记录](TESTING.md) 与 [发布规则](RELEASE_POLICY.md)。

## 发布工程验收过程（Gate 1）

发布安全回归已扩展至 11 项，覆盖哈希/ZIP、固定目录替换、候选失败保护、候选重命名与回滚同时失败时保留唯一旧副本、未知手写文件、junction 越界、清理幂等、残留锁/活动锁和源码指纹。严格缓存清理的实际 dry-run 限于项目 `src-tauri/target/release`；将 `CARGO_TARGET_DIR` 指向项目外临时目录时，命令在删除前明确失败。此过程未清理编译缓存。

最初三次完整流水线均通过自动回归和 Tauri 构建，但原生冒烟分别在导入或处理阶段失败，没有晋升半成品。诊断证实 Node 后台调用链下测试主窗可保持隐藏，Windows 也可能拒绝前台焦点请求。驱动改为显式显示本次创建的测试窗、校验窗口可见且未最小化，再通过 UIA Invoke 操作；没有放宽生产 IPC 或系统策略。相同 `Node spawn → pwsh → PowerShell STA`、`windowsHide=true`、`shell=false` 调用链连续 10/10 PASS，四步骤、源文件保护、正常退出、原 Store 恢复和临时目录清理均通过。2026-11-04 13:23 的精简汇总当时位于忽略的 `src-tauri/target/qa-v011/node-restored-10-summary.json`。

修复后 `npm run release:win -- --allow-dirty` 与 `npm run release:verify` 均退出 0，11 发布安全测试 / 157 Vitest / 25 Chromium / 13 Rust、Clippy、lint/typecheck/build 和真实 Tauri NSIS 构建均 PASS；实际 ZIP 解压 EXE 的启动、导入、处理、导出、原文件保护、退出、Store 恢复与 QA 清理全部通过。Gate 1 放行时版本仍为 0.2.0、记录提交 `c016a99` 与 `dirty: true` 及源码指纹，属于开发验收，最终交付会从已提交的 0.3.0 源码重建。

首次最新发布目录仅 5 个文件，共 6,726,046 bytes；staging/lock 清空，3 个旧 NSIS 安装器（审计前共 4,147,314 bytes）及本脚本失败摘要自动清理。Setup SHA-256 `2AD70557F539BB9E8A904BFA3E492842558BCC7548A3E32F7A448FA6A879095D`；ZIP SHA-256 `F5F3118F9152745B9C02378F809096EF6269F70702470865F41865D80B6DED34`。连续两次成功和一次真实故障保留验收在最终 0.3.0 已提交源码上执行。
