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
| 本轮 Windows 安装版复核 | 执行中；不沿用历史 PASS |

环境为本机 Windows 11 x64 / PowerShell。Windows 10、无 WebView2 干净系统和其他 DPI 不能由 Chromium 测试证明。

## 现有实现审计与保留边界

- `src/core/diff/subtitle-diff.ts` 的对齐、歧义保守处理及 10,000 合计 cue / 2,000,000 UTF-16 单位预算已存在并有测试；本轮复用，独立来源比较明确关闭 cue ID 信任。
- `src/components/subtitle-diff-preview.tsx` 已有正文高亮、字段变化、筛选、分页和规模降级。现有处理前后预览继续保留。
- `src/services/preset-service.ts` 和 `tool-presets.tsx` 已有固定键 `tool-presets-v1`、白名单参数、串行写入、版本和容量保护。批量页已复用 `ToolWorkspace`，本轮沿同一组件补足验收，不新建存储框架。
- `src/core/encoding.ts` 现有 GBK/GB18030 只有手动解码，编码函数拒绝输出；新增能力必须验证真实字节和严格不可表示字符失败。
- `src-tauri/src/commands/mod.rs` 保留会话文件授权、目录写入授权和 Store 恢复事务。文件夹扫描只能由本次原生目录选择产生授权，不能给 Renderer 任意目录读取入口。
- `dist/` 为 Vite 暂存，`src-tauri/target/` 为 Rust 缓存；原先没有统一发布脚本和最终发布目录。本轮新增 `release-output/`，不改 `frontendDist`，不默认清除依赖与编译缓存。

## 阶段风险和验收位置

发布替换须先验证新产物、ZIP 清单和实际导入导出，再以可回滚方式发布。未知文件、链接跳转和外部 Cargo target 必须拒绝或跳过。Windows 右键菜单默认关闭，仅在具备安全启停和卸载证据时开放。功能、发布、清理和原生验收结果最终归入 [测试记录](TESTING.md) 与 [发布规则](RELEASE_POLICY.md)。
