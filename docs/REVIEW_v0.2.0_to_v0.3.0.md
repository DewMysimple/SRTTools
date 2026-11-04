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

## 简繁转换（Gate 2）

采用固定版本 `opencc-js 1.4.2`（代码 MIT、词典 Apache-2.0），仅提供通用简→繁、繁→简。离线词组转换在 Worker 内运行，不访问服务。许可证原文放入 `docs/THIRD_PARTY_NOTICES.txt`，安装器与便携 ZIP 都分发该文件；发布脚本仅允许这一明确资源映射，其他未知资源仍需审阅后才能打包。

现解析器可选返回正文跨度，只有简繁 Worker 请求该信息；其他工具原有序列化语义不变。简繁只替换正文，重解析验证条数、编号和毫秒时间一致，并恢复原 cue ID 供既有差异预览使用。保留原换行，所以此工具的换行下拉明确禁用。SRT 的原编号及时间字面量、带时间 TXT、VTT 元数据/标识/设置、CSV 列序/转义/多行、ASS/SSA 样式与控制序列都有整文件精确输出测试。绘图模式和不能可靠解析的结构继续明确拒绝。

先复现缺失能力：8 个 Worker 测试失败，纯转换模块缺失。实现后完整 `npm test` 为 184 PASS（新增 27），Chromium 28 PASS（新增 3），lint/typecheck/build PASS。发布安全测试因新增许可证资源保护扩展为 12 PASS。Worker 生产包为 1,246.16 kB，应用主 JS 450.88 kB；词典不需网络加载。实际 Windows 新功能及最终安装/解压验收仍待 Gate 6，不以浏览器结果替代。

## 严格旧编码（Gate 3）

固定采用 `@kayahr/text-encoding 2.2.0`（MIT，许可证随安装器与 ZIP 分发）。使用独立 GBK/GB18030 编码路径，每段及整份输出均与原生 WHATWG 解码器核对。无法表示、非完整代理对和不能逐字往返的兼容映射明确失败；Worker 提供字幕条目或文件头/报告元数据位置及 Unicode 字符。编码与命名、目录等设置继续与预设隔离。

字节向量包括 GBK `中文=D6D0CEC4`、GBK `€=80` 与 GB18030 `€=A2E3`、GB18030 `😀=9439FC36`。实际码表及原生解码器为核验依据，不将旧版 Python 码表当作通用标准。全 Unicode 标量回归验证 1,112,045 个可往返字符，19 个有损 PUA 兼容映射严格拒绝；这是 WHATWG 映射的无损输出能力，不宣称覆盖所有 GB18030 标准版本或认证。

先有 13 个编码能力失败用例，实现后完整 208 Vitest / 31 Chromium、lint/typecheck/build PASS，覆盖 Unicode 原有编码、手动输入确认、单文件与 ZIP 一致、失败无可导出结果及默认编码重载。应用主 JS 450.23 kB、按需编码模块 154.17 kB、Worker 1,399.90 kB，无构建体积警告。实际 Windows 保存后的字节验收正在安排，完成后才进入 Gate 4。

同一提交 `fd614b830634221da4facab6c6766bc4f0fa7ec1` 另以自有临时配置真实运行 Firefox 157.0：31/31 E2E PASS，31.0 秒，包含全部简繁、严格编码和原有流程。未改默认 CI。自动审批曾拒绝宽泛递归删除该临时目录；随后改为核对完整 inventory、绝对路径和无 reparse，精确删除 6 个自有文件（170,218 bytes），再仅删除已空目录，退出 0，无该临时目录残留。

Gate 3 原生验收 PASS（2026-11-04 14:03:57，Win 11 26200.9711 / WebView2 156.0.4314.58）：实际构建并通过 Windows 对话框保存 GBK 全文与 GB18030 emoji，单文件及 ZIP entry 均与准确向量一致；GBK emoji 报第 1 条与 U+1F600 且无可导出结果；GBK 自动输入拒绝、手动输入成功；SRT 简繁仅正文变化，编号 8 / LF / HTML 属性和占位符保留；ASS 头、样式、注释、控制序列保留；方向预设在进程重启后实际应用。6 个合成源文件哈希不变，正常退出、原 Store 恢复、临时目录清理均为 true。EXE SHA-256 `A4221E272DF13A1AEB0707872559F8428741CDFDF481A6F573F9B8FC12C7A1EC`；NSIS 1,903,743 bytes、SHA-256 `9AD7248D3B18580EA89542D9697318E15A2C631FEBA5BB767B3A7D3EBFC0368A`。原始摘要当时为忽略的 `src-tauri/target/gate3-native-features.json`，driver 源码已提炼至 `scripts/`。此构建仍为开发中的 0.2.0 标识，最后验证发布目录未被替换。

## 文件夹导入（Gate 4）

前后端已联调，前端新增队列与 Channel 合同测试，完整 35 Chromium 通过；Rust 原有 13 项加 10 项目录边界测试为 23 PASS，严格 Clippy PASS。UI 仅桌面显示，默认不递归、六种格式可选，进度按实际加入与失败计数，取消保留已加入项。后端目录/文件句柄边界、reparse 拒绝、深度 5 / 总目录项 2,000、32 MiB / 100 文件 / 128 MiB 预算均有验证；IPC 不接受任意扫描路径。

独立审阅发现 JavaScript `.toLowerCase()` 将两个真实 Windows 文件 `İ.srt` 与 `i`+U+0307`.srt` 合并的问题，暂停了该构建验收。修复为保留完整非 ASCII 实际拼写，Unicode 大小写别名由原生 canonical 路径和 Windows ordinal 比较处理。真实 Windows 探针确认 `Σ/σ`、`Ä/ä`、`SS/ss`、`I/i` 返回相同真实 canonical 名，而 `İ` 与 `i`+U+0307、`ß` 与 `SS` 可分别创建且保持不同。前端新增回归为 4 PASS，修复后类型检查和 lint PASS；原生矩阵将从头重跑，不沿用旧构建的部分结果。

修复后原生矩阵从头重跑，13/13 PASS，含空目录、默认不递归、递归、Unicode 真正不同文件/真实大小写别名、不同目录同名、junction 外跳/环、既有处理与 ZIP、锁输入、32 MiB 超限、格式过滤、深度 5、队列 100、目录项 2,000、拒绝目录及取消恢复。取消测试使用 3×32 MiB 的真实读取批次，在读取中取消，只有 1 份完整文件加入，2 份未加入；此前有效队列保留，随后另一目录导入成功。126 个合成源文件哈希不变，原 Store 恢复、正常退出和本次测试工作目录清理为 true。原始摘要当时位于 `src-tauri/target/gate4-native-folder.json`。永久 canonical 回归已加，Rust 合计 24 项（新增项与严格 Clippy 均通过）；前端 4 队列回归及 9 个目录合同/浅深色/尺寸/键盘用例通过，视觉截图不冒充原生测试。

## 可视对比、批量预设与可选系统入口（Gate 5）

独立对比显式不信任输入间 cue ID，复用原引擎和预算；容差只影响已配对行的时间变化分类，原列表位置诊断/summary 不变，JSON 新增无正文 `visualComparison`。UI 明确区分两种摘要，第一份/第二份文件标签、仅变化、分页和逐字高亮均复用。测试发现结构损坏被错当全部删除，已守卫解析 error 和未确认编码：逻辑比较 `unavailable`，保留原诊断报告；合法空文档仍允许真实增删。

完整当时 228 Vitest，独立对比 10 项真实 Worker E2E、批量预设 3 项 E2E PASS；统一 0.3.0 后 9 个 spec 的 53 项 Chromium 全 PASS（44.8 秒）。覆盖相同字幕、增删/重排/编号/重复歧义、容差、emoji/组合字符、5,000 条长正文预算回退、JSON/界面摘要一致、分页筛选后导出字节不变；批量与独立页预设重载/更新/跨工具隔离、单文件/ZIP 字节一致、编码变更失效、处理锁定和失败保参。

Explorer 用官方 single-instance 和具体路径 pending 队列，设置默认关闭、仅六种扩展的 HKCU owner/path 专属键。独立安全审阅发现 command 子键预检 `.ok()` 吞 AccessDenied 导致备份不完整风险，已改仅 NotFound 映射缺失，其余读取/枚举错误在写入前返回；真实 ACL 故障下六键未变化。fresh 安装不注册、显式登记、直接带引号命令与 Shell 查询均有本机证据。

本机内置 Administrator / session 1 / EnableLUA=0；32/64 位与 Explorer SID 一致。实际物理 Shift+右键的传统菜单读取到约 30 项，但没有本应用项，`AssocQueryStringW` 查找返回成功且 HKCR 合并可见。故显示与菜单点击导入标为 **BLOCKED**，不是 PASS。官方 [关联数组](https://learn.microsoft.com/en-us/windows/win32/shell/fa-associationarray) 支持现注册位置；[HKCR 合并规则](https://learn.microsoft.com/en-us/windows/win32/sysinfo/merged-view-of-hkey-classes-root) 对管理员/UAC 关闭的说明限于 COM 配置，不能据此证明静态菜单缺失根因。保持实验性/默认关闭，登记状态不声称可见，不更改 UAC、默认关联或机器级设置。任务书 §9 明确允许此独立 P1 在不能安全实证时降级；其余 CLI 转发、更新/卸载和桌面流程继续分项验收。

早先两处失败 feature driver 残留的 `target/windows-smoke-*` 经核对无活跃进程、reparse 或未知顶层项，改用固定文件 inventory、长度/mtime 复查后逐文件删除，再仅删空目录。53 个文件、6,065,982 bytes 已实际清除；此前自动审批对宽泛递归删除的拒绝没有被改工具等价重试。

0.3.0 最终 Gate5 原生报告为 **PARTIAL**：14 个分项 PASS、菜单显示 1 项 BLOCKED，整体不写全 PASS。其余项目包含 CLI 冷启动双 Unicode、单实例暖转发保队列、3×32 MiB 真正读取忙碌时延后消费、目录/移动/超限/格式拒绝、实际 ZIP、禁用/未知 owner、同路径更新保留 opt-in、移动路径修复与另一安装卸载保护、自有卸载保护、Explorer 单/多物理拖放、WebView2 独立对比左右/仅变化/真实无正文 JSON 摘要一致、批量预设重启及单输出/实际双 entry ZIP。最终加强了三份 CLI ZIP 与来源完整 bytes、batch ZIP 与单文件参考完整 bytes 的断言，9 个源文件哈希不变；原 Store/注册表（含 DACL）恢复、正常退出和当前测试目录清理均 true。报告当时为 `src-tauri/target/gate5-native-explorer.json`，首次 15:03:47 后同产物加强重验，原始 EXE `F47B50B611BD84399E11FE4381E89EFA909A5CB660094E0DD3CE0794EAC97814`、NSIS `2C4B0C35052737F4DB1B5F825AE55D1DD0CD4155B8611819DB7E5DAFF63333B9`。Tauri NSIS 实际安装的 payload EXE 为 `72D96D91721E720D9D84DDC7C45D31ED3D793383A54ED7C24E9E767316C11D7F`，版本同为 0.3.0，独立记录，不冒称其与便携 EXE 字节相同。

旧 `target/qa-v011` 的复用部分已提炼为 tracked Windows 驱动，并由新版本真实验收。保存精简证据后，核对无活跃进程、reparse、Git 目录及未知顶层项，以冻结文件清单逐文件删除，再仅删空目录；实际清除 4,689 个文件、368,053,365 bytes，目录不存在。源码、正式夹具、应用数据、Git 历史和编译缓存均保留。
