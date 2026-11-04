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

先复现缺失能力：8 个 Worker 测试失败，纯转换模块缺失。实现后完整 `npm test` 为 184 PASS（新增 27），Chromium 28 PASS（新增 3），lint/typecheck/build PASS。发布安全测试因新增许可证资源保护扩展为 12 PASS。Worker 生产包为 1,246.16 kB，应用主 JS 450.88 kB；词典不需网络加载。该阶段尚未执行 Windows 新功能验收，随后结果分别见 Gate 3–5 与最终 Gate 6；浏览器结果不替代原生检查。

## 严格旧编码（Gate 3）

固定采用 `@kayahr/text-encoding 2.2.0`（MIT，许可证随安装器与 ZIP 分发）。使用独立 GBK/GB18030 编码路径，每段及整份输出均与原生 WHATWG 解码器核对。无法表示、非完整代理对和不能逐字往返的兼容映射明确失败；Worker 提供字幕条目或文件头/报告元数据位置及 Unicode 字符。编码与命名、目录等设置继续与预设隔离。

字节向量包括 GBK `中文=D6D0CEC4`、GBK `€=80` 与 GB18030 `€=A2E3`、GB18030 `😀=9439FC36`。实际码表及原生解码器为核验依据，不将旧版 Python 码表当作通用标准。全 Unicode 标量回归验证 1,112,045 个可往返字符，19 个有损 PUA 兼容映射严格拒绝；这是 WHATWG 映射的无损输出能力，不宣称覆盖所有 GB18030 标准版本或认证。

先有 13 个编码能力失败用例，实现后完整 208 Vitest / 31 Chromium、lint/typecheck/build PASS，覆盖 Unicode 原有编码、手动输入确认、单文件与 ZIP 一致、失败无可导出结果及默认编码重载。应用主 JS 450.23 kB、按需编码模块 154.17 kB、Worker 1,399.90 kB，无构建体积警告。当时等待 Windows 保存字节验收，随后 7 项原生结果如下，完成后进入 Gate 4。

同一提交 `fd614b830634221da4facab6c6766bc4f0fa7ec1` 另以自有临时配置真实运行 Firefox 157.0：31/31 E2E PASS，31.0 秒，包含全部简繁、严格编码和原有流程。未改默认 CI。自动审批曾拒绝宽泛递归删除该临时目录；随后改为核对完整 inventory、绝对路径和无 reparse，精确删除 6 个自有文件（170,218 bytes），再仅删除已空目录，退出 0，无该临时目录残留。

Gate 3 原生验收 PASS（2026-11-04 14:03:57，Win 11 26200.9711 / WebView2 156.0.4314.58）：实际构建并通过 Windows 对话框保存 GBK 全文与 GB18030 emoji，单文件及 ZIP entry 均与准确向量一致；GBK emoji 报第 1 条与 U+1F600 且无可导出结果；GBK 自动输入拒绝、手动输入成功；SRT 简繁仅正文变化，编号 8 / LF / HTML 属性和占位符保留；ASS 头、样式、注释、控制序列保留；方向预设在进程重启后实际应用。6 个合成源文件哈希不变，正常退出、原 Store 恢复、临时目录清理均为 true。EXE SHA-256 `A4221E272DF13A1AEB0707872559F8428741CDFDF481A6F573F9B8FC12C7A1EC`；NSIS 1,903,743 bytes、SHA-256 `9AD7248D3B18580EA89542D9697318E15A2C631FEBA5BB767B3A7D3EBFC0368A`。原始摘要当时为忽略的 `src-tauri/target/gate3-native-features.json`，driver 源码已提炼至 `scripts/`。此构建仍为开发中的 0.2.0 标识，最后验证发布目录未被替换。

## 文件夹导入（Gate 4）

前后端已联调，前端新增队列与 Channel 合同测试，完整 35 Chromium 通过；Rust 原有 13 项加 10 项目录边界测试为 23 PASS，严格 Clippy PASS。UI 仅桌面显示，默认不递归、六种格式可选，进度按实际加入与失败计数，取消保留已加入项。后端目录/文件句柄边界、reparse 拒绝、深度 5 / 总目录项 2,000、32 MiB / 100 文件 / 128 MiB 预算均有验证；IPC 不接受任意扫描路径。

独立审阅发现 JavaScript `.toLowerCase()` 将两个真实 Windows 文件 `İ.srt` 与 `i`+U+0307`.srt` 合并的问题，暂停了该构建验收。修复为保留完整非 ASCII 实际拼写，Unicode 大小写别名由原生 canonical 路径和 Windows ordinal 比较处理。真实 Windows 探针确认 `Σ/σ`、`Ä/ä`、`SS/ss`、`I/i` 返回相同真实 canonical 名，而 `İ` 与 `i`+U+0307、`ß` 与 `SS` 可分别创建且保持不同。前端新增回归为 4 PASS，修复后类型检查和 lint PASS；因此原生矩阵从头重跑，不沿用旧构建的部分结果，结果如下。

修复后原生矩阵从头重跑，13/13 PASS，含空目录、默认不递归、递归、Unicode 真正不同文件/真实大小写别名、不同目录同名、junction 外跳/环、既有处理与 ZIP、锁输入、32 MiB 超限、格式过滤、深度 5、队列 100、目录项 2,000、拒绝目录及取消恢复。取消测试使用 3×32 MiB 的真实读取批次，在读取中取消，只有 1 份完整文件加入，2 份未加入；此前有效队列保留，随后另一目录导入成功。126 个合成源文件哈希不变，原 Store 恢复、正常退出和本次测试工作目录清理为 true。原始摘要当时位于 `src-tauri/target/gate4-native-folder.json`。永久 canonical 回归已加，Rust 合计 24 项（新增项与严格 Clippy 均通过）；前端 4 队列回归及 9 个目录合同/浅深色/尺寸/键盘用例通过，视觉截图不冒充原生测试。

## 可视对比、批量预设与可选系统入口（Gate 5）

独立对比显式不信任输入间 cue ID，复用原引擎和预算；容差只影响已配对行的时间变化分类，原列表位置诊断/summary 不变，JSON 新增无正文 `visualComparison`。UI 明确区分两种摘要，第一份/第二份文件标签、仅变化、分页和逐字高亮均复用。测试发现结构损坏被错当全部删除，已守卫解析 error 和未确认编码：逻辑比较 `unavailable`，保留原诊断报告；合法空文档仍允许真实增删。

完整当时 228 Vitest，独立对比 10 项真实 Worker E2E、批量预设 3 项 E2E PASS；统一 0.3.0 后 9 个 spec 的 53 项 Chromium 全 PASS（44.8 秒）。覆盖相同字幕、增删/重排/编号/重复歧义、容差、emoji/组合字符、5,000 条长正文预算回退、JSON/界面摘要一致、分页筛选后导出字节不变；批量与独立页预设重载/更新/跨工具隔离、单文件/ZIP 字节一致、编码变更失效、处理锁定和失败保参。

Explorer 用官方 single-instance 和具体路径 pending 队列，设置默认关闭、仅六种扩展的 HKCU owner/path 专属键。独立安全审阅发现 command 子键预检 `.ok()` 吞 AccessDenied 导致备份不完整风险，已改仅 NotFound 映射缺失，其余读取/枚举错误在写入前返回；真实 ACL 故障下六键未变化。fresh 安装不注册、显式登记、直接带引号命令与 Shell 查询均有本机证据。

本机内置 Administrator / session 1 / EnableLUA=0；32/64 位与 Explorer SID 一致。实际物理 Shift+右键的传统菜单读取到约 30 项，但没有本应用项，`AssocQueryStringW` 查找返回成功且 HKCR 合并可见。故显示与菜单点击导入标为 **BLOCKED**，不是 PASS。官方 [关联数组](https://learn.microsoft.com/en-us/windows/win32/shell/fa-associationarray) 支持现注册位置；[HKCR 合并规则](https://learn.microsoft.com/en-us/windows/win32/sysinfo/merged-view-of-hkey-classes-root) 对管理员/UAC 关闭的说明限于 COM 配置，不能据此证明静态菜单缺失根因。保持实验性/默认关闭，登记状态不声称可见，不更改 UAC、默认关联或机器级设置。任务书 §9 明确允许此独立 P1 在不能安全实证时降级；其余 CLI 转发、更新/卸载和桌面流程继续分项验收。

早先两处失败 feature driver 残留的 `target/windows-smoke-*` 经核对无活跃进程、reparse 或未知顶层项，改用固定文件 inventory、长度/mtime 复查后逐文件删除，再仅删空目录。53 个文件、6,065,982 bytes 已实际清除；此前自动审批对宽泛递归删除的拒绝没有被改工具等价重试。

0.3.0 最终 Gate5 原生报告为 **PARTIAL**：14 个分项 PASS、菜单显示 1 项 BLOCKED，整体不写全 PASS。其余项目包含 CLI 冷启动双 Unicode、单实例暖转发保队列、3×32 MiB 真正读取忙碌时延后消费、目录/移动/超限/格式拒绝、实际 ZIP、禁用/未知 owner、同路径更新保留 opt-in、移动路径修复与另一安装卸载保护、自有卸载保护、Explorer 单/多物理拖放、WebView2 独立对比左右/仅变化/真实无正文 JSON 摘要一致、批量预设重启及单输出/实际双 entry ZIP。最终加强了三份 CLI ZIP 与来源完整 bytes、batch ZIP 与单文件参考完整 bytes 的断言，9 个源文件哈希不变；原 Store/注册表（含 DACL）恢复、正常退出和当前测试目录清理均 true。报告当时为 `src-tauri/target/gate5-native-explorer.json`，首次 15:03:47 后同产物加强重验，原始 EXE `F47B50B611BD84399E11FE4381E89EFA909A5CB660094E0DD3CE0794EAC97814`、NSIS `2C4B0C35052737F4DB1B5F825AE55D1DD0CD4155B8611819DB7E5DAFF63333B9`。Tauri NSIS 实际安装的 payload EXE 为 `72D96D91721E720D9D84DDC7C45D31ED3D793383A54ED7C24E9E767316C11D7F`，版本同为 0.3.0，独立记录，不冒称其与便携 EXE 字节相同。

旧 `target/qa-v011` 的复用部分已提炼为 tracked Windows 驱动，并由新版本真实验收。保存精简证据后，核对无活跃进程、reparse、Git 目录及未知顶层项，以冻结文件清单逐文件删除，再仅删空目录；实际清除 4,689 个文件、368,053,365 bytes，目录不存在。源码、正式夹具、应用数据、Git 历史和编译缓存均保留。


## 最终重复发布与故障保留（Gate 6）

正式源码为 `4feb035c2837eeb71b8fcaf822811d1cccea4a0c`。版本 0.3.0、dirty=false，实际同源执行两次 `release:win` + `release:verify`，每轮 lint/typecheck/build、12 发布安全、231 Vitest、27 Rust、Clippy、57 Chromium、Tauri NSIS 构建和 ZIP 解压后的 UIA 启动/选择文件/处理/另存为均 PASS。原始输入哈希、Store 恢复、应用退出和本轮 native 临时目录清理均通过。builtAt 为 07:39:45.697Z / 07:42:41.984Z，发布目录均为六文件，大小为 8,464,740 / 8,464,904 bytes，没有版本目录累积。

第三次执行 `npm run release:win -- --simulate-failure=before-publish`，同样完成全部质量检查、真实构建、解压和原生冒烟后主动 exit 1。第二次成功发布的六文件 SHA-256 及 manifest 原字节完全不变，随后的 verify PASS。白名单清理删除故障轮 raw NSIS（1,945,713 bytes）和失败摘要（372 bytes），managed staging/lock 与原始安装器目录均空；正式产物、精确大小和全部 SHA-256 见 [测试记录](TESTING.md#最终构建与本地产物)。源码提交已推送并通过 `git ls-remote origin refs/heads/main` 核验，普通文档交接不改变产品指纹。

之前 4411fb8 首次发布通过，第二次在 Explorer E2E 真实失败（55/56），上一套六文件未变。focused 20 次为 10 PASS / 10 FAIL；事件探针捕获 active listen 1 → inactive listen 2 → unlisten 2 → 单值 mock 仍向 2 通知的顺序，pending warm 文件仍在而有效监听未收到。真实 Tauri 按事件 ID 保留多个监听，产品代码无需更改。4feb035 只修测试模拟为多监听、按 ID 幂等注销及受控迟到订阅回归，事件 ID 从 1001 开始与回调 ID 分开；两项各 repeat30，共 60/60 PASS。随后重新进行上述完整三轮，没有把失败轮记成成功。独立 Firefox157 全量 56/56 @4411fb8、修复后 Explorer4/4 @4feb035 均 PASS。

合并基线 f5c92e6 的 [托管 CI](https://github.com/DewMysimple/SRTTools/actions/runs/41776374027) 实际 success；v0.3 源码的 [CI 运行](https://github.com/DewMysimple/SRTTools/actions/runs/41795341222) 也已实际 success：Ubuntu 前端/Chromium 与 Windows Rust 两 job 均通过，与本地检查分开记录。

### 最终清理边界

旧 qa-v011、两处失败 native driver、最初三个旧 NSIS 的清除量分别为 368,053,365 / 6,065,982 / 4,147,314 bytes；另有早期 Firefox 170,218 bytes 已清，均为准确所有权清单核验后的操作。源码、示例、Git 历史、node_modules、用户 Store/字幕和默认 Rust 缓存保留。

最终 Firefox 自有输出 15 files / 279,726 bytes、根 test-results 16 files / 300,276 bytes 已核实无 reparse 与未知文件，但精确清理在 CreateProcess 前被自动审批以 `blocked by policy` 拒绝；未重试或换工具绕过。旧 target/smoke 的隔离 WebView QA 缓存/报告 201 files / 11,106,633 bytes 此前也被拒绝，保留原状。它们不是历史安装包或正式产物，不进入发行包。故“正式目录仅最新一套”为 PASS，“全部 QA 缓存清空”不能写 PASS。

### 任务书 §15–18 逐项结果

| 要求 | 状态与证据 |
| --- | --- |
| 原开发分支实际 HEAD 和已有工作 | PASS：f5c92e6，未以旧 main 重做 |
| v0.2 稳定性、差异预览、参数预设并入主线 | PASS：先完成 Gate0 并推送，再开发 0.3 |
| 远程 main 包含 v0.2 工作分支 | PASS：祖先检查与远程核验 |
| 设置/历史/预设兼容与 Store 恢复 | PASS：Rust、浏览器重载及真实安装版重启/EFS 恢复 |
| Parser/Serializer/批次/ZIP/原文件保护 | PASS：原有回归及最终 231/57/27 |
| 正式目录与 Vite dist 分离 | PASS：仅 release-output 交付 |
| SRTTools 目录必需资源 | PASS：EXE 和第三方许可，PE 依赖检查 |
| ZIP 与目录精确一致并可运行 | PASS：CRC/清单/逐文件 hash/解压 UIA |
| 最新固定 NSIS 安装/卸载 | PASS：固定 Setup 原生 16 项、版本/许可/默认关闭/真实导入导出/卸载和恢复 |
| SHA-256 与 build-info | PASS：六文件完整表见 TESTING |
| 两次成功不累积旧产物 | PASS：每次六文件、可回滚替换 |
| 构建失败保留上一套 | PASS：真实注入 exit1，六 hash/manifest 原字节未变 |
| 白名单清理与非产物保护 | PASS：未知/链接/外部 target/活动锁/唯一旧副本保护；QA 手工清理有上述审批阻塞 |
| Git 忽略产物与缓存 | PASS：最终提交仅源码/测试/脚本/普通文档/记忆 |
| 简繁方向、词组、预览/批量/预设 | PASS：Gate2 + 原生7项及最终回归 |
| 严格 GBK/GB18030 真实字节与失败定位 | PASS：向量、全标量、Worker及真实保存/ZIP |
| 文件夹递归/取消/限制/去重 | PASS：Gate4原生13项与前后端回归 |
| 独立可视对比共享原引擎 | PASS：10真实Worker E2E与WebView2实际JSON |
| 批量应用已有预设及旧结果失效 | PASS：3专项E2E与原生重启/完整ZIP字节 |
| Explorer 入口安全启停与卸载 | PARTIAL：原生14项PASS，真实菜单显示/点击BLOCKED；实验默认关闭 |
| lint/typecheck | PASS：三轮正式流程分别通过 |
| 单元/E2E/Rust | PASS：231/57/27，另12发布安全 |
| Windows真实构建/ZIP/安装器 | PASS：三轮Tauri与解压运行、最终固定Setup真实安装验收16项 |
| npm/Tauri/Cargo/UI版本 | PASS：全部0.3.0，preflight与真实UI核验 |
| 文档、记忆、Changelog | PASS：已同步实际证据，普通交接提交不改变产物指纹 |
| 本轮提交推送main并核远程 | PASS：源码4feb035已推送核验；最终文档提交SHA以交付时remote为准 |


最终固定 Setup（SHA-256 `3FDBF459632DDD29C4DAC282F088780E3D0164D5872E50C12C0DA8102F3D8D0E`）在 07:54:50Z 完成实际安装验收，16 项全部 PASS。真实安装 payload 为 0.3.0，SHA-256 `5E8F562C9E27226297D189EAAE41D97D5B5FEEA1731B864A6CFE3F81BA1C4FF5`；许可与最终 portable 一致，菜单默认未登记。安装版系统文件选择、处理、真实导出、源保护及卸载通过，Store/registry 恢复，应用、卸载注册、测试安装目录与备份均无残留。此结果与菜单显示 BLOCKED 分开，不将默认关闭验收等同菜单功能可见。


Gate6 自有诊断跟踪已另按冻结 SHA/长度/UTCmtime 清单、无 reparse 和占用检查逐文件清除：24 files、14 个已空目录、5,653,500 bytes，四个 `target/gate6-explorer-*` 自有目录均不存在。此前一次本地校验因时间类型转换在删除前保护退出，核实文件全在后修正 UTC ticks 比较再成功执行；未发生自动审批拒绝，也未碰上述被拒的三个范围。
