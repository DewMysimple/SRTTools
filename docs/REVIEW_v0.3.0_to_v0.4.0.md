# v0.3.0 → v0.4.0 审计与执行门槛

## Gate 0：真实基线（2026-11-04）

任务依据为 `prompt/04_SRTTools_v0.4.0_高级效率工具_Codex执行提示词.md`。已读取根 AGENTS、工程记忆协议、导航及当前状态；历史测试不作为本轮执行证据。

- 工作区：`E:\Software Development\SRTTool`；Windows 11 Pro，build 26200，x64；Intel Core i7-14700KF（20 核 / 28 线程），物理可见内存 33,338,600 KiB。
- Node v24.16.0 / npm 12.0.1 / Rust 1.97.0 MSVC；应用、Tauri 和 Cargo 版本为 0.3.0。
- `origin` fetch/push 均为 `https://github.com/DewMysimple/SRTTools.git`。
- `git fetch origin --prune`、`git ls-remote origin refs/heads/main` 确认 main、origin/main、原始 HEAD 均为 `97500418df0ebc036a08987987f87798cb35c091`。`git branch -vv`、最近 15 条提交已审阅，无其它未合并本地功能成果。
- 开始时唯一未提交文件是用户提供的第四阶段任务书，保留其内容。首次 pull 遇临时 TLS 握手失败；重试 `git pull --ff-only origin main` 成功且 Already up to date。已建立 `codex/v0.4.0`，未覆盖文件或重写历史。

### 本轮重新执行的基线

在原始 v0.3.0 产品源码、尚未开始实现时运行：

| 检查 | 实际结果 |
| --- | --- |
| `npm ci` | PASS；268 packages，5s |
| lint / typecheck | PASS |
| `npm test` | PASS；15 files / 231 tests，1.09s |
| `npm run test:release` | PASS；12 tests，2.05s |
| `npm run build` | PASS；Vite 321ms（另含 typecheck） |
| Chromium E2E | PASS；57 tests，48.3s；输出 `src-tauri/target/v040-baseline-e2e` |
| Rust tests | PASS；27 tests，0.78s；编译工具输出链接器提示，未发现测试失败 |
| Clippy all-targets / deny warnings | PASS |

以上是本轮真实重新运行的数字。Windows 原生新功能、性能基线与最终发布尚未执行，不能据此宣称 v0.4.0 完成。

## 现有实现、缺口与风险

审阅了工具注册、Worker、processing-service、preset-service、persistence、file/export-service、folder_import、安全写入、release policy、gitignore 和 CI。

- 统一 Parser/Document、正文变换、严格编码和有界差异预览可复用。现有 Worker 是逐文件单工具入口；需要新增线性流程入口，一次解码/解析、末端一次序列化/编码，保留单工具路径。
- 参数元数据和核心校验存在重复；八个流程操作应共用严格 schema 和单一操作注册。排除合并、拆分、对比、文本提取、模板与文件写入步骤。
- 简繁有安全原文跨度写回；纯简繁流程复用该路径。ASS/SSA/VTT 混合步骤默认拒绝；仅经明确确认后规范化至 SRT，并显示布局损失。不能暗中破坏控制标记。
- 旧工具预设固定键为 `tool-presets-v1`，20/工具、100 总量、256 KiB。流程使用独立固定版本键。工具与流程混合导入需一次原生 Store 事务；浏览器须有恢复 journal，避免跨键半写入。
- 原生目录导入已有同句柄边界与限额，但未向前端传递授权根的相对层级。新输出规划必须来自原生确认的 root metadata；ZIP 和目录共用路径校验/避让，原生端重新检查授权、重叠及 reparse。
- 保持单文件 32 MiB、队列 100 / 128 MiB、原生输出 256 MiB，以及逐文件单 Worker 调度。大步骤循环、异常退出/超时、取消和重试的资源释放需新增验证。
- 旧正式发布物仍在唯一 `release-output/`。新候选未验证前不得触碰旧成功套件；失败保全与源指纹继续复用。历史自动审批拒绝的 QA 清理范围保持原状，不换工具重试。
- Explorer 实际菜单显示/点击仍为历史 BLOCKED、默认关闭；只读审阅相关实现和诊断，不把注册成功当作修复。Windows10、其它 DPI、无 WebView2 环境需要实机证据，缺少时标 NOT_RUN。

## 执行顺序与验收证据

1. Gate 1：严格流程模型、八操作注册、内存引擎、Worker 集成，核心测试证明顺序/禁用/停止/确定性/编码/布局约束。
2. Gate 2：批量页分段模式、纵向编辑卡、旧工具预设快照、管理与真实差异预览；修改配置立即作废结果。浏览器端到端及真实桌面验收。
3. Gate 3：本地流程 CRUD、受控 JSON 选择导出、预览冲突和确认导入、原子恢复/旧 Store 兼容测试。
4. Gate 4：原生输入根 metadata、平铺/层级规划、ZIP、授权目录逐文件原子输出、取消/重试/重叠/链接/源哈希验证。
5. Gate 5：先记录 v0.3.0 基线，再比较 v0.4.0。100/1k/10k/50k、批量10/50/100，warm-up+至少5次；阶段计时/内存/取消的可测范围明确记录。
6. Gate 6：统一0.4.0版本，全部检查、干净提交构建、ZIP真实流程导入/处理/导出、NSIS安装/卸载和数据恢复、模拟故障保全、最新单套产物核验；普通合并/推送main并核验实际远程SHA。

开发阶段每个增量单独提交；最终证据与逐条要求映射保存在 `docs/REVIEW_v0.4.0_RELEASE.md`，性能实测保存在 `docs/PERFORMANCE_v0.4.0.md`。当前 Gate 0 完成，其余门槛仍待实现与验证。
