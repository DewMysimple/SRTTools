# v0.4.0 发布审阅与逐项交付

> 此页保留第四阶段2026-11-04的历史验收时点，源码28cadee及以下旧产物哈希不代表第五阶段当前发布目录。最新候选、重新检查、许可资源与Git交付以[收尾报告](RELEASE_CLOSURE_v0.4.0.md)为准。

状态：完成。2026-11-04在本机Windows 11完成P0/Gate0–6、正式ZIP原生流程、固定NSIS安装/卸载与源码主线交付。以下区分构建源码、故障保全、性能采集与文档交接提交。

| 项目 | 实际结果 |
| --- | --- |
| 基线 | 2026-11-04真实核验origin/main=`97500418df0ebc036a08987987f87798cb35c091`，v0.3.0；重新执行231 Vitest/57 Chromium/27 Rust/12发布测试及lint/typecheck/build/npm ci，详见[基线审计](REVIEW_v0.3.0_to_v0.4.0.md) |
| 新版本 | v0.4.0；package.json/package-lock、Tauri配置、Cargo app crate/lock及About已同步 |
| 组合流程 | 删除空白、清空格、替换、简繁、换行、去HTML、偏移、重编号八操作；20步/512KiB，单一registry/schema；一次输入解码/解析，内存逐步变换，末端严格序列化/编码。两SRT“删空→清空格→替换→延后500ms”真实预览/执行字节一致；纯简繁保源布局，ASS/SSA/VTT混合默认拒绝，显式同意才规范化 |
| 预设 | 命名保存/更新/重命名/复制/删除；旧工具键兼容，20/工具、100总量/256KiB；独立流程50项含隔离/512KiB；JSON1MiB/150项，选中导出和隐私确认，跳过/改名/明确覆盖，原子两键CAS/journal恢复；损坏/未来数据保留隔离。完整[导入示例](examples/SRTTools-Presets.json) |
| 目录批量 | 层级/平铺树预览，多根别名，目录和ZIP共享相对路径；原生100项/256MiB，来源授权、双向源/目标重叠拒绝、路径/reparse防护、句柄锁和guard、原子不覆盖；失败/取消/重试保留成功项和真实避让路径 |
| 性能 | Win11/i7-14700KF/约32GiB/Node24，100/1k/10k/50k、10/50/100文件，warmup+5runs。三步流程1000条11.11→5.15ms、50000条620.31→293.23ms；长行310.68→7.72ms且输出SHA一致。7255b02实测，其后计算引擎/Worker/benchmark未变；非本次构建现场重测。详见[完整报告](PERFORMANCE_v0.4.0.md) |
| 前端检查 | `28cadeeaf92654f1598dd4f7385811b28fa2a757`：lint/typecheck/build PASS，21files/311 Vitest PASS（1.11s），15发布安全测试PASS，72 Chromium PASS（1.6m）；主chunk511.43kB提示保留，编辑器lazy load |
| 原生检查 | 同源42 Rust PASS（0.67s）、Clippy -D warnings PASS；PS5.1安全10/状态12 PASS；正式ZIP原生workflow10/10+原9源SHA/Store恢复/退出/cleanup全true。固定Setup 19/19检查+10流程全true，安装版实际读取/应用旧工具和流程预设、重启再读、卸载及恢复通过 |
| 发布检查 | 干净main `28cadeeaf92654f1598dd4f7385811b28fa2a757`，dirty=false，FP=`B64CDECC0CD947B5CDE73A7E9486D923CFB8D0BD0FEE947CDD80CCCDFCB21C3C`；正式release:win PASS（262.310s），release:verify PASS。5ffa85a实际before-publish预期失败且旧0.3六文件/清单原始字节完全不变；两份证据分别署源，不混成同轮 |
| 清理情况 | 最新6文件8,773,460B；自动移除原始NSIS2,022,889B、失败标记247B和自有staging/旧版六件。Setup后按冻结清单清理本轮旧开发包/初次失败E2E12文件14,704,087B及CI自有失败fixture26文件2,078B；保留编译缓存和下述历史拒清边界 |
| Git交付 | 开发/产品源码`codex/v0.4.0=28cadeeaf92654f1598dd4f7385811b28fa2a757`；本地main正常快进包含全部阶段提交并推送，远端产品源码SHA实际核对一致；无强推/删历史。其后的普通文档/记忆交接不改变产物指纹，最终交接提交及远端main完整SHA以本轮最终答复和实际`git ls-remote origin refs/heads/main`为准 |
| 未完成 | Explorer实际菜单显示/点击仍BLOCKED（实验性默认关闭）；Win10、125%/150%/200% DPI、无WebView2干净系统、超MAX_PATH系统选择器NOT_RUN，原因是没有对应可交互环境；安装包未签名；独立Worker OS峰值NOT_MEASURED。无伪造PASS，无公开Release/tag |

## 要求与证据映射

| 范围 | 实现/验证入口 | 结果 |
| --- | --- | --- |
| Gate0/§0–2 | 根指令、记忆、真实远端/版本/分支审计及重新基线 | PASS |
| Gate1/§3–6 | core/operation-registry、workflow、worker-logic、processing-service；纯引擎/Worker回归 | PASS；八操作、严格参数、预执行拒绝、真实步骤摘要、取消/超时/失败隔离 |
| Gate2/§3/16 | WorkflowWorkspace、ParameterForm、ToolPresets快照、ResultDetails/SubtitleDiffPreview；pipelines E2E | PASS；900/1200浅/深布局、键盘、CRUD、真实Worker与导出字节 |
| Gate3/§4/7–9 | workflow-preset、preset-exchange、preset-queue、persistence、native preset_storage | PASS；事务失败/回滚/隔离/并发/容量/外部ID/旧数据/时间回退覆盖 |
| Gate4/§10–12 | folder_import、export-service、folder_export、FolderExportPanel | PASS；原生五层、多根/Unicode/重名/重叠/真实写失败重试、真实junction和原地reparse阳性对照；UI取消合同与原生写入中取消分列 |
| Gate5/§13–15 | benchmark脚本及四份机器JSON、长行等价优化 | PASS；真实1017 Worker创建/终止、max1/active0；限额未放宽，IO与计算分列 |
| §18–19兼容回归 | 全量311/42/72含旧Parser、严格编码、简繁布局、diff、单项与批量 | PASS；没有复制历史数字冒充本轮 |
| Gate6/§20–23 | 正式clean build、ZIP解压运行、固定Setup、失败保全、版本/文档/记忆、main交付 | PASS；机器记录和固定产物如下 |
| §17可选Explorer | 重新核历史诊断与实现，未改机器策略/默认关联 | BLOCKED，保持默认关闭实验入口，不是本轮P0阻塞 |

## 运行环境与命令

本机Windows 11 Pro25H2 26200.9711、x64、96DPI/100%、WebView2 156.0.4314.58；i7-14700KF20核28线程、约32GiB；Node24.16.0/npm12.0.1、Rust1.97.0 MSVC、Tauri2.12.4。实际执行npm ci、lint、typecheck、Vitest、build、Chromium、release tests、cargo test/clippy、benchmark及release:win/verify；正式构建还执行真实PS5.1.26100.9711/Desktop安全/状态回归。托管[28cadee CI](https://github.com/DewMysimple/SRTTools/actions/runs/41827759104)两个job均实际success。

正式成功时间2026-11-04T12:19:21.005Z–12:23:43.315Z；构建时间12:23:14.906Z。各命令墙钟耗时（含启动）：lint1.799s、typecheck2.459s、发布测试2.904s、Vitest1.598s、build3.268s、Rust1.151s、Clippy0.355s、QA安全5.159s、状态2.331s、Tauri102.650s。Vitest与Rust自身报告耗时分别1.11s/0.67s，Chromium1.6m。Vite大chunk和MSVC linker库创建提示未被隐藏；Clippy严格检查通过。

## 真实失败、审阅与修复

- b85d5a0首轮Chromium71/72提前失败，尚未到Tauri/预定故障点。原因是CRUD测试等待删除不足，下一次Quota注入阻断了上次异步删除；增加等待及旧raw精确断言后专项20/20通过。
- 6c2d806首轮QA9/10因Node直接启动PS5缺Get-FileHash提前失败；改测试为.NET SHA256，并固定Node→pwsh→PS5链路，后续直接与转发矩阵均通过。
- 5ffa85a完整质量门槛/构建/ZIP原生流程后，实际`--simulate-failure=before-publish`按预期exit1（251.784s），旧0.3六文件SHA/字节和manifest原始Buffer不变，verify PASS。同源后续成功轮在Tauri编译时因新发现的产品缺陷主动停止，未晋升。
- 产品缺陷为跨设备/系统时钟回退时覆盖预设会保留future createdAt却写较早updatedAt，令合法预设不可读。28cadee使用max(now,createdAt,updatedAt)，五个新增回归覆盖工具/流程、未来时间及9999年边界；本轮正式311全通过。
- ASS `头{\i1}发`跨override词组边界以原始正文跨度为唯一转换来源，避免strip后OpenCC产生不一致；六格式独立bytes/ID对照通过。处理重试跨面板卸载保存模式/已写ID/真实冲突路径；隔离行不可复活；原地reparse用真实FSCTL阳性对照而非字符串判断。
- Setup QA采用自有Windows Job和持久owner记录，确认全部写者停止再恢复；原生句柄路径/祖先校验、父子lease/token、严格PS5 JSON shape/depth/roundtrip、Registry值和Owner/Group/DACL恢复。未声称SACL覆盖。

## 固定Setup安装/卸载

实际命令为`pwsh -NoProfile -File scripts/windows-setup-acceptance.ps1 -SetupPath <固定Setup绝对路径> -ExpectedVersion 0.4.0 -ExpectedSha256 <下表哈希> -PortableDirectory <固定便携目录> -SmokeScenario workflow -ReportPath <target/v040-final-setup.json>`。

Setup 19项及子流程10项全部true，用时29.571s。安装前seed既有设置和两类合法预设，应用通过真实UIA选择并应用Existing Tool/Flow，等待偏移字段=123，完成本次四步流程后重启再读；未声称对旧123预设另做字幕字节导出，本次导出流程使用500ms。安装/应用/卸载前后seed原始字节相同，最终恢复真实用户Store和七个专属注册树的值、Owner、Group、DACL。源文件保护、无残留进程/安装登记、测试目录清理均通过。原生结果只适用于上述本机环境。

安装后EXE SHA-256：`129E1503F38C70B92CDEBA8C60B0E835E5D8686643B1C38467476918863F3CB2`；portable EXE哈希见下表。两种载荷分别核对，不要求打包器处理后的字节相等。报告`src-tauri/target/v040-final-setup.json`，版本0.4.0；完整workflow与原子恢复证明保留在报告，未用浏览器mock替代。

## 正式产物

唯一交付根：`E:\Software Development\SRTTool\release-output`；只含下列六件，共8,773,460B。源码SHA=`28cadeeaf92654f1598dd4f7385811b28fa2a757`，sourceFingerprint=`B64CDECC0CD947B5CDE73A7E9486D923CFB8D0BD0FEE947CDD80CCCDFCB21C3C`，dirty=false。

| 相对release-output路径 | 字节 | SHA-256 |
| --- | ---: | --- |
| `build-info.json` | 4,274 | `5835F7BECF823B06C3BA4ABAB62ADBAEF21252EA09F7629F66F74A6B055EA940` |
| `SHA256SUMS.txt` | 439 | `46C078E228FD8757F2A61C5E1A33AF945CBCC951054F0230291B684012647ADE` |
| `SRTTools-Setup.exe` | 2,022,889 | `78AB5649CFA2C77AAA135096CDF8E9ED76702B4D197674BC4B7547A913A8DE6D` |
| `SRTTools.zip` | 2,285,509 | `2989DC26B63299F7C11138FB20F77F3AA903FF2723E50EC1AD59F448F14A554C` |
| `SRTTools/subtitle-tools.exe` | 4,446,208 | `F4A70A91B396CED885829DC11A845BE42A391172D14AAB299DC5FA537C291EFC` |
| `SRTTools/THIRD_PARTY_NOTICES.txt` | 14,141 | `2A0F32D23F15B38196B76C18B58F76B024C5CAB7B8285D431CF86D103726BA89` |

`SHA256SUMS.txt`覆盖其余五件，自身摘要另列上表。目录/ZIP清单、大小、解压字节、实际EXE和许可证均一致。不得修改build-info伪造验证。交接文档完成后再次release:verify，确认产品指纹仍匹配。

## 磁盘与清理边界

| 路径 | 开始字节 | 最终字节 | 最终文件数 |
| --- | ---: | ---: | ---: |
| `release-output` | 8464904 | 8773460 | 6 |
| `dist` | 2154915 | 2337105 | 9 |
| `src-tauri/target/release` | 1902147915 | 2111513240 | 3750 |
| `src-tauri/target/debug` | 10627224921 | 13644677432 | 13424 |
| `src-tauri/target/benchmark` | 未单列 | 0 | 0 |
| `test-results` | 300276 | 300276 | 16 |
| `playwright-report` | 0 | 0 | 0 |
| `.release-work` | 279726 | 279726 | 15 |

缓存增加来自本轮真实编译/测试，未为追求占用数字默认删debug/release增量缓存、node_modules、Git历史或用户数据。benchmark夹具0B；原始NSIS、受管stage、最后失败标记和本轮已核对开发旧包已清理。自有额外清理12files/14,704,087B+26files/2,078B共38files/14,706,165B，保留精简报告和冻结清单。

此前自动审批拒绝的`.release-work/firefox-final`15files/279,726B、根`test-results`16files/300,276B和旧`src-tauri/target/smoke`201files/11,106,633B保持原位，不换工具绕过；它们不进入release-output。没有宣称所有QA目录均清空。

机器证据（Git忽略）：`src-tauri/target/v040-release-summary.json`（保留真实失败/暂停/故障/成功）、`v040-release-final-success.log`、`v040-release-final-verify.log`、`v040-final-setup.json`、`v040-root-qa-cleanup-result.json`、`v040-ci-owned-cleanup.json`、`v040-disk-before.json`、`v040-disk-after.json`。可复核的产物manifest和基准JSON随交付记录，测试驱动/用例随源码提交。

工程记忆收尾统一执行一次`index --project . --apply`和一次普通`check --project .`：12pages、errors=[]、warnings=[]；这是引用/结构检查，不替代上述业务与原生验收。
