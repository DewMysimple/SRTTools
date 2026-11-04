# 测试与验收

v0.1.1 的复现步骤、版本基线、Windows 测试环境和实际结果见 [发布检查表](RELEASE_CHECKLIST_v0.1.1.md)。回归夹具位于 [examples/回归](../examples/回归)，包含 UTF-8 BOM、GBK CRLF、Unicode 文件名、重复编号和损坏时间行。Playwright 将本次运行的截图留在 `test-results/`。

## v0.4.0 正式验收（2026-11-04）

产品源码`28cadeeaf92654f1598dd4f7385811b28fa2a757`在干净main完整发布，dirty=false、sourceFingerprint=`B64CDECC0CD947B5CDE73A7E9486D923CFB8D0BD0FEE947CDD80CCCDFCB21C3C`；正式release:win 262.310s及release:verify均PASS。最终六文件、完整哈希、故障历史、安装/卸载、磁盘前后和主线交付见[发布审阅](REVIEW_v0.4.0_RELEASE.md)。

| 检查 | 本轮实际结果与范围 |
| --- | --- |
| npm ci | 基线及0.4清单均实际执行：268 packages/5s |
| lint/typecheck/build | 正式同源PASS；Vite主chunk511.43kB提示保留，流程编辑器lazy load |
| Vitest | 21files/311tests PASS，1.11s（命令墙钟1.598s） |
| Rust/Clippy | 42/42 PASS，0.67s；all-targets -D warnings PASS |
| 发布安全 | 15/15 PASS，含0.4完整原生证据、旧0.3保护和既有事务/路径边界 |
| Chromium | 全量72/72 PASS，1.6m；真实Worker、流程CRUD/预设/字节、900/1200浅深主题和目录合同 |
| 正式ZIP原生 | workflow10/10、9源文件hash、Store恢复/退出/cleanup全true；真实解压EXE/import/process/export |
| 固定Setup | 19/19检查及workflow10/10；实际安装/旧设置和工具+流程预设应用/重启/卸载/恢复通过，Registry覆盖值和O/G/DACL，不声称SACL |
| 写入中取消 | 真实128MiB输出，在观察到0.7–1.4MiB已写后finish，20/20 PASS；无partial/tmp/guard、源与成功项不变、句柄释放/fresh retry成功。与browser mocked IPC取消合同分列，不冒称UIA写入中点击 |
| PS5 QA安全/状态 | 10/10和12/12 PASS；actual5.1.26100.9711/Desktop，真实Job/路径/lease/Registry O/G/DACL/严格JSON；自有GUID夹具清理 |
| benchmark | Node22组+温缓存IO4组、生产真实Worker11组，各warmup+5runs；1017创建/终止、active0/max1，取消无假成功。7255b02同引擎测量，非最终构建现场重测；[详细报告](PERFORMANCE_v0.4.0.md) |
| 托管CI | [28cadee Actions](https://github.com/DewMysimple/SRTTools/actions/runs/41827759104)前端/Chromium和Windows Rust两job实际success |
| 故障保全 | 5ffa85a实际before-publish预期exit1，完整构建/ZIP原生后旧0.3六hash及manifest原始字节完全不变，verify PASS；与28cadee成功分开署源 |

环境为Win11 Pro25H2 26200.9711/x64/96DPI100%/WebView2 156.0.4314.58，i7-14700KF约32GiB，Node24.16/npm12.0.1/Rust1.97 MSVC。质量命令耗时与原生完整字段见发布审阅和build-info；CLI耗时包括启动，测试自身耗时单列。

### 真实失败与修复

b85d5a0首轮71/72因CRUD测试对异步删除等待不足，尚未到Tauri/预定故障点；显式等对话框/保存列表后再注入Quota失败，旧raw严格不变，专项20/20重复通过。6c2d806首轮QA9/10因直接PS5缺Get-FileHash提前失败，改.NET SHA256并固定pwsh转PS5链路，后续全部通过。这两次保全不冒称已到故障点。

5ffa85a完整预定故障通过后，随后启动的成功发布尝试在Tauri编译被主动停止：独立探针发现未来createdAt的预设覆盖后updatedAt回退导致不可读。28cadee采用max(now,createdAt,updatedAt)，新增五个回归（含9999年边界），最终311全通过。日志保留失败/暂停，不改写PASS。

其余已修复：ASS跨控制标记词组边界、处理重试丢模式/已写ID/真实避让路径、隔离预设复活、原地reparse防护及QA Job/lease/持久恢复。纯Chinese六格式独立bytes/ID对照一致；浏览器合同、真实文件系统和原生UIA证据分开列。

Explorer实际菜单显示/点击仍BLOCKED（实验性默认关闭）；Win10、125%/150%/200% DPI、无WebView2干净系统、超MAX_PATH系统选择器NOT_RUN，原因是没有对应可交互环境；安装包未签名；独立Worker OS峰值NOT_MEASURED。历史Firefox及旧原生数字仅代表当时版本。

## v0.3.0 历史验收（2026-11-04）

以下是当时0.3交付的历史证据；其中“当前/保留/最终目录”等描述属于该次验收时点，不表示后续版本的发布目录内容。新的正式交付以本页0.4节及发布审阅为准。

合并前 `origin/main=123eb499336f4f571c4ecf41f5fbe47da4223640`，开发分支与快进目标 `f5c92e6afc056bee0dbeae052caa15f0bf70b226`，推送后已核实主线包含 v0.2.0。阶段提交为 `a67fab9`（发布）、`d2a68a1`（简繁）、`fd614b8`（严格编码）、`81e5cb4`（目录导入）。当前版本清单均为 0.3.0。环境仍为本机 Win11 Pro 25H2 26200.9711、x64、96 DPI / 100%、WebView2 156.0.4314.58、Node24.16/npm12.0.1、Rust1.97 MSVC。

| 阶段检查 | 实际结果 |
| --- | --- |
| 合并后原有质量门槛 | PASS：npm ci、lint/typecheck、157 Vitest、build、25 Chromium、13 Rust、Clippy；原生安装版另 17 项 PASS |
| Gate 1 发布与清理 | PASS：真实 `release:win -- --allow-dirty`、`release:verify`、ZIP 解压后导入处理导出、哈希清单，旧 3 个 NSIS 包清理；开发验收记录 dirty=true，不充当最终 0.3 安装包 |
| 发布安全回归 | PASS：12 tests，未知文件/junction/路径逃逸、可回滚替换、双失败唯一副本、残留/活动锁、源码指纹、许可资源、重复清理 |
| Gate 2 简繁 | PASS：27 新增 core/Worker、3 新增 UI，原文布局覆盖六种格式，完整当时 184 Vitest / 28 Chromium |
| Gate 3 严格旧编码 | PASS：完整当时 208 Vitest / 31 Chromium；全标量 1,112,045 往返、19 aliases 拒绝；Firefox157 全 31 tests PASS；原生 7 项字节/布局/预设重启 PASS |
| Gate 4 目录 | PASS：4 队列回归、9 目录合同/视觉/键盘、原生 13 项，真实读取中取消后重试；24 Rust 已分阶段通过，Clippy PASS |
| Gate 5 对比与批量预设 | PASS：228 Vitest（含新增核心/Worker），独立对比 10 E2E、批量预设 3 E2E，原有 9 spec 共 53 Chromium PASS（44.8 秒） |
| Gate 5 Explorer 与桌面交互 | PARTIAL：14 项原生 PASS（注册/ACL/冷暖/忙碌/无效输入/ZIP/启停/更新/路径/卸载/物理拖放/对比/批量），实际菜单显示与点击导入 BLOCKED，默认关闭的实验入口；原 Store/注册表恢复 true |
| 托管 CI | PASS：[4feb035 的 Actions](https://github.com/DewMysimple/SRTTools/actions/runs/41795341222)，Ubuntu 前端/Chromium和Windows Rust两job实际success |
| 最终质量门槛 | PASS：lint/typecheck/build、12 发布安全测试、231 Vitest、27 Rust、严格 Clippy、57 Chromium；在三轮完整发布中分别通过 |
| Firefox 157.0 | PASS：全量 56/56（47.2 秒，4411fb8）；后续仅改测试 mock，Explorer 专项 4/4（4.5 秒，4feb035） |
| Gate 6 两次正式发布 | PASS：同一干净提交 4feb035，两次 `release:win` + `release:verify`，真实 Tauri NSIS 构建、ZIP 清单/解压/实际 UIA 导入处理导出均通过 |
| Gate 6 故障保留 | PASS：第三轮全部检查/真实构建/解压冒烟后 `--simulate-failure=before-publish` 按预期 exit 1；第二轮六文件哈希和 manifest 逐字节不变，之后 verify PASS |
| 最终固定 Setup 安装验收 | PASS：16 项均 true，实际安装/0.3.0/许可/菜单默认关闭/启动/系统导入/处理/真实导出/源保护/卸载/Store 与注册表恢复/无进程无安装注册/测试目录清理 |

原生 Gate3/Gate4 每项内容、合成文件数量、构建 SHA 与校验值见[逐阶段审阅](REVIEW_v0.2.0_to_v0.3.0.md)。目录 E2E 使用模拟 Tauri 合同，不能替代 Windows 真对话框；独立对比和编码 E2E 均运行真实 Worker。曾发现且已回归修复：Node 后台 UIA 隐藏/前台限制、JS Unicode 扩张误去重、损坏/未确认编码输入被错误显示为删除。初次失败记录保留在审阅摘要，不伪称这些尝试 PASS。

Windows10、125%/150%/200%DPI、无 WebView2 干净系统、超过 MAX_PATH 的系统对话框仍无对应可交互环境，标为 NOT_RUN；Rust 超长路径、当前 Win11 实际 Unicode 路径与限额测试独立列证据。安装包未签名，不将这些缺口改写为兼容性通过。

### 最终构建与本地产物

产品与测试源码提交为 `4feb035c2837eeb71b8fcaf822811d1cccea4a0c`，2026-11-04 已推送并通过 `git ls-remote` 核对 `origin/main`。随后交接提交仅更新普通文档和工程记忆；`release:verify` 通过源码指纹确认其与产物一致。构建清单记录 `dirty: false`、版本 `0.3.0`、指纹 `3BDCBAD3952677CC8FA9783571A1DAD54061C955087A08C218A24B4EFC6AF441`。`npm ci` 安装 268 个包，在 4411fb8 执行；两提交的 npm 清单与锁文件逐字不变。

两次成功的 builtAt 为 `2026-11-04T07:39:45.697Z` / `2026-11-04T07:42:41.984Z`，目录均为六文件，大小为 8,464,740 / 8,464,904 bytes；后者保留为最终交付（8.07 MiB）。时间和 PE/NSIS 打包差异会改变哈希，不声明字节可复现。每轮新候选验证后替换旧目录，不产生版本子目录。

固定目录：`E:\Software Development\SRTTool\release-output`。`SRTTools/` 合计 4,319,549 bytes，其哈希以两个文件及 SHA256SUMS 为准：

| 文件 | 字节 | SHA-256 |
| --- | ---: | --- |
| `SRTTools/subtitle-tools.exe` | 4,305,408 | `72D973D6EABC178DAE87039B14CC1617CCA0B5064119D4CE65DA9DCF5E149128` |
| `SRTTools/THIRD_PARTY_NOTICES.txt` | 14,141 | `2A0F32D23F15B38196B76C18B58F76B024C5CAB7B8285D431CF86D103726BA89` |
| `SRTTools.zip` | 2,195,616 | `10094CCC0B8A841B4B2F0724917CB39D70EFF24DC9D31333DAC1A45088220C4E` |
| `SRTTools-Setup.exe` | 1,945,973 | `3FDBF459632DDD29C4DAC282F088780E3D0164D5872E50C12C0DA8102F3D8D0E` |
| `build-info.json` | 3,327 | `8D9F39D03D75111CD77DF886C10ED044245C4F11B5C0D34AB74B8BFB2C458EA3` |
| `SHA256SUMS.txt` | 439 | `DD81EE0619F6FCFA8580041EFE4F0C3449D709F3869CF2C686A6D92A4B400E61` |

实际运行的发布命令为 `npm run release:win`（两次）、`npm run release:verify`、`npm run release:win -- --simulate-failure=before-publish`、`npm run clean:outputs -- --apply`、`npm run disk:report`。故障轮返回 1 是预期验证；其余命令返回 0。失败产生的原始安装器（1,945,713 bytes）和失败摘要（372 bytes）已由白名单清理，managed staging/lock 和原始 NSIS 目录均空，正式交付只有最新一套。开发依赖、Rust debug/release 缓存和用户数据保留。

最终固定 Setup 于 `2026-11-04T07:54:50.5659251Z` 实际验收 PASS（Win11 26200.9711 / WebView2 156.0.4314.58）。安装和卸载均退出 0；16 项检查全部 true，安装目录、快捷方式/卸载项与应用进程无残留，原 Store（2 bytes）和六扩展注册表恢复，恢复文件与测试备份为 0。安装版 EXE SHA-256 为 `5E8F562C9E27226297D189EAAE41D97D5B5FEEA1731B864A6CFE3F81BA1C4FF5`，实际版本 0.3.0；许可文件与上述 portable 资源相同。Tauri 安装 payload 与便携 EXE 分别记录，不声称二者哈希相同。精简机器报告为本地忽略的 `src-tauri/target/gate6-final-setup.json`，调用 tracked `scripts/windows-smoke.ps1` 在实际安装的 EXE 上完成系统选择字幕、处理及另存为。

### 失败诊断与清理边界

首次在 4411fb8 的正式构建通过；第二次真实失败于 Explorer E2E（55/56）。20 次重复为 10 PASS / 10 FAIL。探针证实 React StrictMode 的迟到 inactive 订阅覆盖测试 mock 的单值监听，注销后有效监听收不到 warm 通知；真实 Tauri 支持独立事件 ID，产品代码无需修改。4feb035 将 mock 改为多监听与按 ID 幂等注销，并增加受控响应乱序回归，事件 ID 与回调 ID 分开编号；两相关用例各重复 30 次，共 60/60 PASS，再重启上述三轮完整发布。早期失败没有晋升候选，首套六文件保持不变。

旧 `target/qa-v011` 4,689 files / 368,053,365 bytes、两处失败 native driver 53 files / 6,065,982 bytes、最早 3 个旧安装器 4,147,314 bytes 已受控清除；驱动复用源码保存在 `scripts/`，精简证据保存在本页及审阅文档。

自动审批拒绝了本轮 Firefox 输出（15 files / 279,726 bytes）和根 `test-results/`（16 files / 300,276 bytes）的精确清理，均在 CreateProcess 前返回 `blocked by policy`，没有执行，也没有换工具等价重试。初版遗留 `src-tauri/target/smoke/` 的隔离 WebView QA 缓存与报告（201 files / 11,106,633 bytes）此前也被拒绝清理，保持原状。这些目录不进入发行包；不能把“最新正式产物无历史累积”写成“所有 QA 缓存已清空”。

## v0.2.0 实际执行结果（2026-11-04）

前端验收对应 `b9cecf8a140ead4dced20f6caec07fb9fdb501d7`。最终 Rust 回归与安装包对应 `581aaae8c26e2ae39c74d88e2ef6ffb671a9cdfa`，两次提交之间的产品代码变化只在 Rust Store。环境为 Windows 11 专业版 25H2（26200.9711）、x64、100% DPI、WebView2 156.0.4314.58、Node.js 24.16.0、npm 12.0.1 与 Rust 1.97.0 MSVC。

| 检查 | 状态 | 实际结果 |
| --- | --- | --- |
| `npm run lint` | PASS | 退出 0，零错误与警告，1.55 s |
| `npm run typecheck` | PASS | 退出 0，1.93 s |
| `npm test` | PASS | 退出 0，8 个文件、157 项，1.63 s |
| `npm run build` | PASS | 退出 0，Worker 与 ZIP 分块，2.68 s |
| `npm run test:e2e` | PASS | 退出 0，Chromium 25 项，20.42 s |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml` | PASS | 退出 0，13 项，含 Store 恢复回归 |
| `cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` | PASS | 修复后退出 0 |
| `npm run tauri -- build` | PASS | 最终重建退出 0，59.88 s，生成 Windows x64 NSIS 安装包 |

产物为 `src-tauri/target/release/bundle/nsis/Subtitle Tools_0.2.0_x64-setup.exe`，1,394,885 字节。SHA-256 为 `2E547758EB149D1F1DE59BBF84B7CA1FDF2FC035C95B6369EF336EF494906EA5`。

首次 v0.2.0 安装验收中，Windows 在加密 AppData 拒绝同目录重命名并返回错误码 17，导致原生设置、历史和预设无法保存。独立文件探针复现了错误。最终构建仅对此错误启用本地恢复文件，先同步旧值，主文件写入失败时仍可读取旧值。Rust 回归模拟文件锁定，再解除锁定并完成写入。

### 稳定性验收

| 项目 | 状态 | 证据 |
| --- | --- | --- |
| 核对分支、工作树、工程协议及 0.1.0 基线 | PASS | `123eb49` 与 `origin/main` 一致，任务书和原始需求的用户改动保留。 |
| 原有自动化回归 | PASS | 0.1.0 基线为 122 Vitest、9 Chromium、10 Rust，均通过。 |
| 文件选择、拖放、编码、导出、取消与重试 | PASS | 结合安装版流程、真实 Chromium 和 Rust 回归。环境级未覆盖项见发布检查表。 |
| 已发现问题有复现和回归 | PASS | 取消与重复导入、目录重选、空输入、模板替换和坏数据隔离均有专项覆盖。 |
| 原文件保护、重名避让和路径授权 | PASS | 安装版对比输入 SHA-256，并核验大小写重名和 ACL 拒写后的重试。 |
| Windows 原生矩阵及证据 | PASS | [v0.1.1 发布检查表](RELEASE_CHECKLIST_v0.1.1.md)逐项记录。 |
| 基础 CI | PASS | 前端、Chromium 和 Windows Rust 托管检查均通过。[v0.1.1 CI](https://github.com/DewMysimple/SRTTools/actions/runs/41755468783) |
| 0.1.1 里程碑与更新记录 | PASS | 独立提交 `5abfbbc` 和 [CHANGELOG](CHANGELOG.md)。 |

### 处理预览验收

| 项目 | 状态 | 证据 |
| --- | --- | --- |
| 原工作区与左右预览 | PASS | 在 900 × 620 深色和默认视窗检查，保留 [真实预览截图](screenshots/replace-preview.png)。 |
| 逻辑字幕对齐 | PASS | ID、锚点、局部匹配、重复歧义、插入、删除和重排单测。 |
| 正文、毫秒时间、编号独立变化 | PASS | 核心单测和 Chromium 测试分别验证中文高亮、纯偏移和重新编号。 |
| 增删及未匹配占位 | PASS | 新增与未匹配由核心模型和视图映射覆盖，中间删除由真实处理流程验证。 |
| 筛选与配对行分页 | PASS | 41 条输入、39 条输出按 41 行分页，切换筛选后从第一页显示。 |
| 多输出、TXT/JSON、失败与空结果 | PASS | 拆分切换、合成概览、空结果、编码失败和诊断回归。 |
| 旧预览和旧导出失效 | PASS | 改输入、工具、参数、编码或应用预设后须重新处理。 |
| 大文件与长正文 | PASS | 4,000 条配对单测和 5,101 条浏览器回退，受限局部矩阵及单行字素预算。 |
| 展示与导出一致性 | PASS | SRT/VTT/CSV/ASS 预览字段与实际导出字节重读一致，筛选后导出仍含完整正文。 |

### 参数预设验收

| 项目 | 状态 | 证据 |
| --- | --- | --- |
| 创建、应用、更新、重命名和删除 | PASS | Chromium 覆盖确认和取消，服务测试覆盖日期与持久化。 |
| 工具隔离、名称、参数与正则校验 | PASS | 同名跨工具、类型、数值边界、未知选项、非法正则和无效名称测试。 |
| 重启持久化 | PASS | Chromium 重载和 Tauri 安装版进程重启均保留已保存预设，表单等待显式应用。 |
| 明确保存才写入 | PASS | 表单编辑不写入预设，已保存参数只在确认更新时改变。 |
| 数据最小化 | PASS | 注册字段白名单排除文件、字幕、编码、路径和授权。 |
| 旧数据和写入失败 | PASS | 缺字段补默认、坏条目隔离、未知版本保留、损坏键恢复和模拟写失败不影响现有表单。Rust 验证 Store 锁定时保持原内容。 |
| 应用预设清除结果且不自动运行 | PASS | Chromium 比较旧结果、应用后失效及重新处理后实际导出。 |
| 无参数工具与忙碌状态 | PASS | 无参数工具隐藏预设栏，处理期间禁用应用和保存。 |

### 工程与发布验收

| 项目 | 状态 | 证据 |
| --- | --- | --- |
| 前端和 Rust 全量检查 | PASS | 上表列出本轮实际命令、退出状态和测试数。 |
| Windows x64 NSIS | PASS | 最终构建和校验值见本节，原生交互结果单独记录。 |
| 版本清单 | PASS | npm 清单及锁文件、Cargo 清单及锁文件、Tauri 配置、应用界面均使用 0.2.0。 |
| 版本文档 | PASS | README、架构、功能、测试、更新记录与稳定性矩阵均已更新。 |
| Git 与工程记忆 | PASS | v0.1.1、差异预览、v0.2.0 和 Windows Store 修复独立提交到工作分支，记忆导航和任务日志随分支交付。 |
| 测试范围与发布风险 | PASS | Windows 10、干净系统、显示缩放和原生边界缺口见稳定性矩阵。 |

### Windows 11 安装版验收

| 项目 | 状态 | 证据 |
| --- | --- | --- |
| 安装、启动、卸载 | PASS | 安装和卸载均退出 0，UI Automation 读取了真实安装版的 0.2.0 首页。卸载后程序目录、快捷方式和卸载项移除。 |
| 原生对话框、Unicode 路径与另存为 | PASS | 单选、多选、取消、重复文件、长名称和多行正文。导出核对毫秒时间和原始输入 SHA-256。 |
| Explorer 与拒绝写入 | PASS | 同一 SHA 的独立安装运行覆盖单拖、多拖、重复、不支持扩展名和 ACL 拒绝后更换目录重试。 |
| 目录授权及批量重名 | PASS | 重启后重新授权，取消保留结果，改选目录后批量写入并避免大小写重名覆盖。 |
| 设置、历史与预设重启 | PASS | 设置与历史摘要保留。显式保存后才写入固定预设键。重启表单仍为默认值，应用预设清除旧导出，重新处理后真实差异和导出正文一致。 |
| 加密 AppData 中断恢复 | PASS | 主文件模拟部分写入，恢复文件包含上次提交值。真实进程启动后加载全部三键，下一次写入修复主文件并移除恢复记录。 |
| 其他 Windows 环境与桌面边界 | NOT_RUN | Windows 10、无 WebView2 的干净系统、125% / 150% / 200% DPI、超 MAX_PATH 的系统对话框、完整原生批量上限尚未覆盖。 |

主要桌面运行的 17 项检查全部通过。机器可读证据保存在本地忽略目录 `src-tauri/target/qa-v011/run-35200ff1/native-report.json`，同安装器的 Explorer/ACL 补充见 `run-8214bc11/native-report.json`。测试结束后恢复了既有 Store，且无测试安装进程或恢复文件残留。

## 自动检查

在项目根目录执行：

```powershell
npm ci
npm run lint
npm run typecheck
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
npm run tauri -- build
```

`npm run test:watch` 进入单元测试监听模式。`npm run test:e2e` 运行 Playwright 浏览器测试，首次使用需执行 `npx playwright install chromium`。浏览器测试验证网页工作区，不替代 Windows 原生对话框和安装器的手工验收。

Windows 原生构建需要 Rust MSVC 工具链、Visual Studio C++ Build Tools、Windows SDK 和 WebView2 Runtime。NSIS 构建产物位于 `src-tauri/target/release/bundle/nsis/`。请以构建命令实际退出结果为准；配置存在不代表已验证安装、启动和卸载。

## 自动测试覆盖

| 范围 | 验证内容 |
| --- | --- |
| 核心解析与序列化 | 标准 / 多行 / BOM / 换行差异、缺失和异常编号、错误结构恢复、无效时间、往返一致性 |
| 时间与文本 | 整数毫秒边界、跨小时 / 跨天、负偏移策略、正则错误、空白、重复、换行及文本转换 |
| 合并与格式 | 文件 / 时间顺序合并、双语未匹配保留、拆分、VTT / CSV / ASS 的格式与有损提示 |
| 编码 | UTF-8、UTF-8 BOM、UTF-16 LE / BE 往返，旧中文编码手动输入和无损输出限制 |
| 处理集成 | 实际输入字节到导出字节、原文保留、损坏结构阻止输出、检测报告、明确时间修复 |
| 批次 | 单文件读取 / 解析失败隔离、Worker 意外失败后继续、取消后的任务状态 |
| ZIP | 同名、大小写冲突、Unicode 等价名称、安全文件名、无目录穿越、空结果拒绝导出 |
| 本地持久化 | 设置保存 / 重载 / 默认值、损坏数据错误、固定 IPC 键、历史并发写入和正文剥离 |
| 原生文件服务 | 对话框桥接、读取失败、浏览器导入校验、保存错误和授权范围 |
| Rust 文件边界 | 未选路径拒绝、目录授权不扩展到子目录、路径和文件名校验、冲突不覆盖及完整写入 |

## 手工验收步骤

### 启动与导航

1. 执行 `npm run tauri -- dev`，检查首次启动为简体中文浅色主题。
2. 依次打开首页、全部工具、批量处理、处理记录和设置；缩放到 900 × 620，检查按钮和表单仍可使用。
3. 搜索“时间”“VTT”“替换”，检查工具列表；切换深色和跟随系统，重新启动确认设置持久化。
4. 使用键盘遍历按钮和表单，检查焦点可见；测试实际界面中提供的快捷键。

### 文件导入与常用工具

1. 用系统对话框选择包含中文、英文、emoji 和多行正文的 SRT，再通过拖放导入另一文件。
2. 导入一个不支持的扩展名或超过 32 MiB 的文件，确认有具体原因，其他文件仍保留。
3. 预览查找替换、空格清理、删除空白字幕和重新编号，确认时间与未选取的正文保持一致。
4. 输入非法正则，确认在字段或任务结果中展示错误，界面仍可继续使用。
5. 输入会产生负时间的提前量，确认默认拒绝输出；选取明确的裁剪或删除策略后再处理。
6. 对含缺失编号、非法时间、重叠和空白的文件执行检测，检查字幕编号与原因。选择修复策略后重新查看剩余问题。
7. 转换 SRT ↔ VTT、CSV ↔ SRT；用包含逗号、双引号和多行的正文检查 CSV 引号。ASS / SSA 转 SRT 应展示样式丢失提醒。
8. 选择纯文本 TXT 转 SRT，确认无时间信息时拒绝凭空生成字幕；包含可识别字幕时间信息的 TXT 可按规则导入。

### 预览、导出与编码

1. 处理前后预览切换多页，确认只渲染当前页，完整结果可以导出。
2. 分别导出 UTF-8、UTF-8 BOM、UTF-16 LE 和 UTF-16 BE，重新导入确认中文和 emoji 完整。
3. 手动指定错误编码，确认有解码错误或可见诊断；推测编码不确定时应要求核对并手动选择。
4. 导出到含相同文件名的目录，确认原文件内容不变，新文件自动追加序号。
5. 将输出目录改为无写入权限位置或模拟磁盘错误，确认显示失败，预览结果仍可再次导出。
6. 修改“另存为”扩展名为错误格式，确认原生服务拒绝不一致扩展名。
7. 关闭并重启，使用已保存的默认输出目录时应重新出现本次会话授权对话框；取消应不产生文件。

### 批量、合并和记录

1. 添加三份字幕：一份合法、一份结构损坏、一份合法。执行相同操作，检查成功 / 失败独立统计。
2. 重试未完成项，确认成功项保留；处理进行时取消，检查后续项标记取消。
3. 对开始时间交错的两个文件分别按文件顺序和时间顺序合并，确认保留原始时间。
4. 双语合并时刻意制造未匹配条目，确认摘要有双方未匹配数，条目未被静默丢弃。
5. 导入不同目录下同名字幕，导出 ZIP，检查每份结果都存在，没有同名覆盖和多余路径。
6. 查看记录并重新启动，确认记录包含摘要和输出路径；检查应用数据文件不包含字幕全文。
7. 清理历史前应有应用内确认，确认后重启仍为空。

### Windows 安装器

1. 执行 `npm run tauri -- build` 生成 NSIS 安装器，核对产品名称、版本和图标。
2. 在干净的 Windows 用户环境安装，检查快捷方式与首次启动；无 WebView2 时检查安装器引导行为。
3. 从安装版本完成一次原生导入、预览、导出，检查窗口关闭后进程退出。
4. 卸载，检查应用文件和快捷方式移除。用户本地设置是否保留应记录在实际验收结果中。

安装、卸载、原生拖放及系统权限对话框属于必须在 Windows 桌面环境执行的手工验收，不能仅凭前端构建或单元测试判定通过。

## 本次实际验收（2026-11-03）

| 检查 | 结果 |
| --- | --- |
| `npm run lint` / `npm run typecheck` | 通过，零错误与 lint 警告 |
| `npm test` | 5 个测试文件、122 项测试全部通过 |
| Playwright Chromium | 9 项真实浏览器流程全部通过，包括导出字节、ZIP 去重、乱码阻止、修复后诊断、失败重试、模板时间规则与设置重载 |
| `npm run build` | 通过；ZIP 按需加载，Worker 独立产物，无包体积警告 |
| Rust 测试 / Clippy | 10 项测试全部通过，`-D warnings` 通过 |
| `npm run tauri -- build` | Windows x64 NSIS 构建成功 |
| 最终包安装 | 静默安装到本工程隔离目录 `smoke-install`，退出码 0 |
| 安装版本启动 | 隐藏启动后进程响应正常；UIAutomation 识别真实主窗口与 WebView 文档标题 |
| 最终包卸载 | 退出码 0，测试安装目录、应用进程与卸载注册项均已移除 |
| 生产 npm 依赖审计 | 使用 npm 官方 registry 审计，0 个已知漏洞 |

最终安装器为 `Subtitle Tools_0.1.0_x64-setup.exe`，1,375,951 字节，SHA-256：

```text
F5A6CA391992D12F8D38C77044A2D2F6ED7B587E517D3B70948112D983200CCE
```

安装、启动和卸载的机器可读报告在 `src-tauri/target/smoke/final-install-report.json`。实际视觉检查使用 `docs/screenshots/` 内的浏览器截图，覆盖 1200 × 800 和 900 × 620、浅色 / 深色、预览与导航。

**尚需交互验收：** 原生文件对话框、原生拖放的完整端到端流程，以及干净系统缺少 WebView2 时的引导安装。原生路径授权、范围限制、导入预算、安全写入与冲突保护已经 Rust 单元测试验证，但不把这些测试等同于原生桌面交互验收。本机提升权限环境禁用 WebView2 环境变量远程调试，因此没有执行原生 CDP 截图；没有更改系统策略或给生产程序加入调试参数。

隔离 WebView 测试缓存保留在 `src-tauri/target/smoke/webview-profile/`。自动审批拒绝了对此已校验工程内目录的清理，未提供具体原因；没有改用其他工具绕过拒绝。此目录位于构建忽略目录，不会进入安装包。测试创建的开发服务器已停止。


Gate6 自有诊断跟踪已另按冻结 SHA/长度/UTCmtime 清单、无 reparse 和占用检查逐文件清除：24 files、14 个已空目录、5,653,500 bytes，四个 `target/gate6-explorer-*` 自有目录均不存在。此前一次本地校验因时间类型转换在删除前保护退出，核实文件全在后修正 UTC ticks 比较再成功执行；未发生自动审批拒绝，也未碰上述被拒的三个范围。
