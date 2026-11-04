# v0.4.0 发布审阅与逐项交付

状态：进行中；Gate6正式干净构建、NSIS安装/卸载、主线推送尚未完成。此页随真实证据更新，不把开发包验收当作正式发布。

## 基线与变更

| 项目 | 当前实际结果 |
| --- | --- |
| 基线 | 2026-11-04核验origin/main=`97500418df0ebc036a08987987f87798cb35c091`，v0.3.0；详见[审计](REVIEW_v0.3.0_to_v0.4.0.md) |
| 新版本 | 产品代码0.4.0；npm清单/lock、Tauri、Cargo app crate/lock与About版本同步；正式发布待验 |
| 组合流程 | 八操作、20步/512KiB；一次输入解析、统一模型逐步变换、末端编码；纯简繁保原布局，ASS/SSA/VTT混合须明确同意转SRT |
| 预设 | 工具旧键兼容20/工具、100总量/256KiB；流程50含隔离/512KiB；JSON1MiB/150项，选中导出+隐私提示，冲突预览/确认/事务恢复 |
| 目录批量 | 层级/平铺同树预览，多根别名，目录+ZIP共享实际冲突路径，原生100项/256MiB会话，重叠/reparse/路径逃逸拒绝、原子无覆盖 |
| 性能 | [完整实测与复测命令](PERFORMANCE_v0.4.0.md)，原v0.3基线修改前采集；当前最终clean测量待刷新 |
| 前端检查 | Gate0重新231/57；开发阶段全量299 Vitest，63 Chromium及后续专项新增；最终统一门槛待验，不能将分阶段数字合并冒充同次全量 |
| 原生检查 | 当前41 Rust/Clippy通过；dirty开发ZIP完整Windows workflow10项、source9哈希/Store恢复/cleanup/shutdown通过；正式包与Setup待验 |
| 发布检查 | 14发布安全回归PASS，v0.4强制10原生workflow检查；旧v0.3六产物与起始快照仍相同；正式失败保全/成功发布待验 |
| 清理情况 | 起始release-output六文件8,464,904B；旧成功仍保留。新增benchmark临时数据已自动清零，编译缓存/源文件/应用数据不清理。最终前后磁盘记录待验 |
| Git交付 | 开发分支codex/v0.4.0；baa919c审计、48a8f68引擎、672328d预设、c3e4d78原生/目录；最终开发/合并/远程SHA待核实 |
| 未完成/限制 | 当前Gate6未完；Explorer实际菜单仍BLOCKED实验性默认关；Win10/其它DPI/无WebView2/超MAX_PATH选择器NOT_RUN；未签名；独立Worker OS峰值NOT_MEASURED |

## 要求与证据映射

| 任务书条目 | 实现/验证入口 | 当前状态 |
| --- | --- | --- |
| §0–2 / Gate0 | 根指令、记忆、真实fetch/remote/分支/版本/日志与重新基线，REVIEW_v0.3.0_to_v0.4.0 | PASS |
| §3–6 / Gate1 | operation-registry、workflow、worker-logic、processing-service；core/workflow.test与workflow-processing.test | 实现/单元通过；独立审阅修复后复核中 |
| §3/16 / Gate2 | Batch分段、WorkflowWorkspace、ParameterForm/ToolPresets快照、ResultDetails、真实pipelines E2E；900/1200浅/深布局 | 浏览器与dirty开发UIA通过；最终正式包待验 |
| §4/7–9 / Gate3 | workflow-preset/preset-exchange/preset-queue/persistence、native preset_storage；5文件49 tests、完整示例JSON | 单元/原生事务/dirty开发原生JSON与重启通过 |
| §10–12 / Gate4 | folder_import metadata、export-service、folder_export、FolderExportPanel；树/ZIP/真实junction/原地reparse阳性对照 | 原生自动与dirty开发多根/深5层/真实写入失败通过；处理retry新状态回归4/4 |
| §13–15 / Gate5 | scripts/benchmark*、PERFORMANCE报告及4机器报告；长行等价优化、Worker生命周期和取消 | 已实测；最终clean命令待跑 |
| §17 Explorer可选 | 重新读取现有实现和gate5-native-explorer历史诊断；未改变owner/ACL/默认关联策略 | BLOCKED保留，未声称修复；不阻塞P0 |
| §18/19 兼容回归 | 旧简繁/编码/解析/diff/单项/合并/文件夹测试仍保留，新增pipeline/preset/tree覆盖 | 最终全量门槛待验 |
| §20–23 / Gate6 | 版本、文档/记忆、全检查、正式ZIP/NSIS、失败保全、最新单套、普通合并/推送/remoteSHA | 待完成 |

## 已发现并修复的问题

- 独立探针发现ASS `头{\i1}发` 单简繁成功、流程却因通用模型strip控制标记后改变OpenCC词组边界而误拒绝。改为原始正文跨度唯一转换来源，每步处理实际正文，末端一次写回/复验；新增ASS/SSA、CSV、VTT和调用次数回归。
- 独立审阅发现处理重试会卸载导出面板，丢失平铺模式，单项批量还丢失written IDs与实际避让路径。两工作区持有完整导出状态，真正invalidate才清空；两种模式均新增“处理失败→先导出成功项→处理重试→只写第三项”真实Worker合同，4/4通过。
- 预设条件冲突行在删除合法项后可能复活，已用不可执行隔离包装保留raw；多标签页可能把活跃journal当成中断写入，增加同源Web Locks。旧工具损坏行也保留，计入容量。
- 新目录允许原子发布需要共享WRITE，仅denyDELETE不能阻止空目录原地reparse。增加delete-on-close guard，并以真实DeviceIoControl保护失败/释放后成功验证，不以路径字符串检查替代竞态防护。
- 首轮UIA取消检查因badge属于task accessibleName而非Text失败；修验收定位后真实取消和重试通过，未将失败尝试写PASS。

## 正式发布与产物

待干净提交和独立审阅通过后，先模拟发布前失败证明旧0.3最后成功六文件/manifest逐字节不变，再正式发布一次；最终列出源码SHA、dirty=false、源码指纹、实际检查数量/耗时、六文件完整字节/哈希、固定Setup安装/卸载和远程mainSHA。交付目录固定 `E:\Software Development\SRTTool\release-output`，不得伪填manifest。
