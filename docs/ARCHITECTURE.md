# 架构与数据流

Subtitle Tools 是本地优先的 Tauri 2 桌面应用。React 负责界面，独立 TypeScript 引擎负责字幕业务，Rust 负责经过用户授权的系统文件访问。字幕处理不会访问服务器，也不会自动上传字幕。

## 模块职责

| 目录 / 文件 | 职责 |
| --- | --- |
| `src/app/` | 工具注册表、分类和参数定义，供首页、工具列表和统一工作区使用 |
| `src/components/` | 文件列表、参数表单、预览、诊断、处理状态与导出界面 |
| `src/stores/app-store.ts` | Zustand 全局文件队列、设置、历史摘要、通知与忙碌状态 |
| `src/core/` | 统一模型、解析、序列化、时间计算、文本操作、合并、拆分和校验 |
| `src/core/operation-registry.ts` / `workflow.ts` | 八个流程操作的唯一无图标元数据、严格参数 schema、适用性分析和线性内存执行 |
| `src/core/chinese.ts` / `chinese-subtitle.ts` | 离线词组简繁转换、控制标记保护、按解析器确认的正文跨度写回 |
| `src/core/encoding.ts` | Unicode 与严格 GBK/GB18030 编码，字符位置错误及分块/完整输出往返校验 |
| `src/services/file-service.ts` | 桌面原生文件服务；浏览器预览使用 File 和 Blob 下载 |
| `src/services/processing-service.ts` | 顺序批量调度、Worker 生命周期、单文件状态和取消 |
| `src/workers/worker-logic.ts` | 解码 → 解析 → 校验 → 处理 → 序列化 → 编码的可测试完整流程 |
| `src/services/export-service.ts` | Windows 文件名清理、重名去重、ZIP 打包 |
| `src/services/persistence.ts` | 固定键的桌面持久化 IPC；浏览器使用 localStorage |
| `src/services/preset-service.ts` | 按工具隔离的预设、参数校验、兼容读取与串行写入 |
| `src/services/workflow-preset-service.ts` / `preset-exchange.ts` / `preset-queue.ts` | 流程配置/隔离、选择导出、冲突预览、共享串行锁与原子导入 |
| `src/services/settings-service.ts` | 设置默认值、命名规则校验及保存 / 加载 |
| `src/services/history-service.ts` | 有界历史列表、并发写入串行化、元数据白名单 |
| `src-tauri/src/commands/` | 原生对话框、路径授权、读取、安全写入、打开目录、固定 Store |
| `src-tauri/src/commands/folder_import.rs` | 目录选择后的受限扫描、句柄边界、进度 Channel、取消与队列预算 |
| `src-tauri/src/commands/folder_export.rs` / `preset_storage.rs` | 有界目录输出会话、原生两键 CAS 与独立预设 JSON 选择器 |
| `scripts/` | 固定发布目录、ZIP/哈希校验、可回滚替换、安全清理及真实 Windows UIA 验收 |
| `src-tauri/capabilities/` | 主窗口所需的最小 Tauri 事件权限 |

## 字幕模型

`SubtitleDocument` 保存文件格式、编码、换行、字幕条目和修改状态。每条 `SubtitleCue` 使用稳定内部 ID；显示编号与内部 ID 分开。所有时间均为整数毫秒，正文使用字符串保存多行内容。

`ParseDiagnostic` 与字幕数据分开保存，包含级别、错误码、原因及可用的字幕编号和行号。解析器尽可能恢复合法条目，但恢复不会被视为原文件无错误。

## 处理与预览

1. 文件服务导入字节，不在 UI 内自行解析字幕。
2. 每个批量文件依次进入独立 Web Worker，同时最多运行一个 Worker。
3. Worker 自动检测或使用手动指定编码解码，再调用统一解析器。
4. 检测 / 信息工具生成 JSON 报告，可报告损坏文件和无效时间。报告不包含字幕全文。
5. 普通工具遇到结构解析错误时停止生成输出，避免悄悄丢弃无法解析的内容。修复工具仅允许保留了完整条目的时间错误进入明确的修复策略。
6. 无 BOM 的推测 UTF-16 结果标记为低置信度；未手动指定编码时停止字幕导出并提示核对。GBK / GB18030 输入仍需手选；输出使用固定版本离线编码器，GBK 和 GB18030 使用独立路径，逐段及整份结果与 WHATWG 原生解码核对，不允许静默替换或有损兼容映射。
7. 普通工具返回输出文档和诊断，序列化器再次验证时间。简繁工具则可选捕获原文正文跨度，只替换正文后重解析验证编号、条数与时间，保留 ASS/SSA 样式、VTT 元数据、CSV 布局及原换行；跨度和完整源文本仅留在 Worker 内，不附在前端文档或持久化对象中。所有输出最后经过严格编码，正文和文件头/报告元数据的错误可定位。
8. 界面分页展示原文和处理结果。预览不会写入文件；导出由用户单独执行。

原始导入字节保留在当前会话的文件队列，方便修改编码和重试。任务预览持有原文文档与输出文档；清空队列或切换工具会释放对应状态。处理记录不保存这些正文数据。

### 线性处理流程

`WorkflowDefinition` v1含稳定唯一步骤ID、现有operation ID、enabled和严格参数，以及显式 `lossyMode`。`operation-registry.ts` 同时提供工具表单元数据、Zod参数约束、预执行影响类型和流程白名单，不在UI/持久化/Worker分别维护操作清单。最多20步/512KiB；不包含多输入、多输出或文件写入步骤。

`processWorkflowFiles` 复用既有顺序调度器和独立Worker，请求前校验并快照配置。Worker只读取/解码/解析输入一次；`executeWorkflow` 在统一Document内顺序执行，禁用跳过，错误停止当前文件、无部分输出。最后统一序列化（包括安全重解析）和严格编码。进度只发送当前步骤和有界摘要，不发送每步全文快照；取消终止Worker，60秒watchdog处理卡死/极端正则，所有终态清理timer、abort监听和Worker。

纯简繁流程使用解析器确认的原始正文跨度作为唯一转换来源，每步在同一正文集合变换，末端一次写回/复验。不能先strip ASS控制标记再转换，否则会改变词组边界（如 `头{\i1}发`）；逐步统计来自实际正文变化，最终预览来自实际写回模型。ASS/SSA/VTT混合流程默认拒绝；明确同意后规范化为SRT并展示布局损失。标准序列化的隐式编号变化进入诊断和最终预览。

批量页只增加模式分段；流程编辑器按需加载，复用ParameterForm、ToolPresets快照和ResultDetails/SubtitleDiffPreview。分析仅估计步骤、文件和影响类型，实际变化摘要由引擎返回。文件/参数/步骤/编码改变立即清空旧结果；处理失败项重试保留已成功任务及目录导出状态（结构模式、已写ID、实际避让路径），新执行和配置变化才清空它。

### 处理前后差异

- 序列化器同时提供编号、毫秒时间和正文的展示快照，保留处理结果的 cue ID。快照反映格式实际输出，例如自动连续编号、ASS 的 10 毫秒精度。TXT 和 JSON 使用实际输出文本。
- `src/core/diff/subtitle-diff.ts` 先用已验证同源的唯一 cue ID，再用唯一时间和正文锚点。局部缺口最多在前后各 12 条内匹配，仅采用具有双向证据且在最佳对齐中一致的配对。重排与不确定条目单独标记。
- 前后合计超过 10,000 条或正文超过 2,000,000 个 UTF-16 单元时，显示数量及各自的分页预览。正文差异仅为可见配对行按字素簇计算，设有长度和矩阵预算，超出预算显示正文与变化标记。
- 展示层按任务和所选输出缓存对比，按差异行过滤、分页。导出继续使用 Worker 生成的字节。多输入合成显示输出概览，拆分对比以所选输出为范围。
- 独立对比由 Worker 保留两份文档的内存引用，显式 `trustIds: false`；时间容差仅用于已配对行的变化分类，不改原锚点/歧义算法和预算。JSON 只新增 `visualComparison` 的数量摘要，原按列表位置诊断与参数语义保留。UI 标注两种摘要来源；解析错误或未确认编码令逻辑比较 `unavailable`，仍可导出无正文的原诊断报告。

## 字幕时间轴

`src/features/timeline/` 为独立编辑会话。哈希数据路由保留原 URL，并用路由阻止器保护退出；Tauri 主窗口只增加关闭确认所需的 destroy 权限。现有原生字幕选择命令增加单文件 SRT 模式，路径授权与容量限制继续使用现有 Rust 边界。

工作区通过原 Worker 读取和诊断一次，草稿与输入快照使用同一 `SubtitleDocument`，按稳定 cue ID 应用稀疏事务。编辑提交后用共享校验器重新诊断。另存为经现有 SRT 严格往返序列化、编码器和无覆盖写入；可按需展开共享差异视图。过程不接入工具箱队列和持久化草稿。

区间索引、重叠布局和坐标函数与 UI 分离。列表按可见行挂载，时间轴按可见时段和行挂载，并在缩得很小时限制每个点击槽的块数。拖动期间使用临时坐标，松开后一次提交。设计与基线见[实施记录](TIMELINE_IMPLEMENTATION.md)。

## 本地视频同步预览

时间轴的 `MediaPreview` 负责本次关联、播放控件、叠加和 A/B。视频元素的帧时间或 `currentTime` 更新本地 `TimelineClock`，光标、时间和叠加单独订阅。画面隐藏或帧回调不可用时用 `timeupdate`。播放中的区间查询复用时间轴索引。相邻或重叠字幕按 `[startMs, endMs)` 查询，编辑命令和媒体时间通过独立入口更新。等待中的 seek 只保留最后一次用户意图，完成后读回视频的实际位置。

`select_video` 在主窗口调用 Windows 原生选择器。后端检查本地驱动器和路径各级属性后锁定只读文件，生成仅在当前会话有效的 UUID。WebView2 的精确媒体源为 `http://srtmedia.localhost`，经 Tauri 自定义协议处理，单响应最多 1 MiB、同时至多四个请求。关闭、替换和主窗口卸载撤销令牌，页面重载或窗口销毁另有后端清理。WebView2 在发放首个令牌前禁用缓存，避免关闭后的重复 URL 从同页面缓存恢复。用户可见文件名和令牌仅在会话内存中保存。协议和实际 Range 测量见[媒体访问实验](MEDIA_ACCESS_SPIKE.md)。

## 批量隔离与取消

调度器为每个文件维护 `queued / processing / success / failed / cancelled` 状态。一个文件的读取、解析、参数或 Worker 错误不会阻止后续文件。重试由工作区重新提交失败和取消项，已成功项可以保留。

取消会终止正在运行的 Worker，并将后续任务标为取消。处理过程不写磁盘，因此取消不会生成半写入文件。已经生成的成功结果仍可以导出。传统另存为显示忙碌；新目录输出在64KiB边界和原子发布前检查取消，ZIP流可暂停取消并释放chunk/监听。已完整发布项保留，未发布临时文件移除。

## IPC 与文件边界

前端不拥有 Node Integration，不暴露任意 Shell 或通用文件读写插件权限。生产 CSP 仅允许本地资源、Tauri IPC 和本地 Worker，不允许远程页面嵌入。

| 命令 | 授权与限制 |
| --- | --- |
| `select_files` | Rust 打开系统对话框，仅批准用户选取的规范化文件路径 |
| `read_dropped_files` | 只能读取 Rust 侧主窗口拖放事件已经批准的具体文件；登记后才发自定义 `subtitle-tools:files-dropped` 事件，避免前端与授权的先后竞态 |
| `select_directory` | 系统对话框选择并批准本次会话的输出目录 |
| `select_import_folder` | 本次原生选择根目录后扫描；只接收递归/格式/队列预算等参数，不接收 Renderer 任意扫描路径。Channel 逐份传完整已验证文件及计数，最后发唯一终态 |
| `cancel_folder_import` | 仅取消主窗口对应 UUID 的当前扫描，不授予目录权限 |
| `save_output` | 校验文件名、扩展名、大小；只写用户当前选择或已授权的目录 |
| `open_output_directory` | 只能打开本次会话已经授权的输出目录，通过固定系统程序参数传递路径 |
| `get_local_value` / `set_local_value` | 允许 `settings`、`history`、`tool-presets-v1`、`workflow-presets-v1` 四个固定键，后端 Store 文件名固定 |
| `get_preset_values` / `set_preset_values` | 只读写两个固定preset键；读取一致快照，按expected做CAS，单次完整Store提交，不接收任意键/路径 |
| `read_preset_import_file` | 独立JSON原生选择器；最多1MiB，拒绝链接/占用/类型错误，不给字幕队列授予路径权限 |
| `prepare_folder_export` / `write_folder_export` / `finish_folder_export` | 用户选择独立输出根和不可变计划，token仅当前会话有效，具体源授权复查、无覆盖原子写入、取消与句柄释放 |
| `get_explorer_integration` / `set_explorer_integration` | 仅操作 HKCU 六个扩展的本应用专属菜单；默认不注册，变更前完整检查所有权/路径及备份 |
| `take_external_imports` | 仅消费原生命令行/单实例转发的具体文件待导入队列；Renderer 只提供既有队列预算与比较提示，不能添加任意读取路径 |

所有命令还会检查调用窗口为 `main`。路径比较基于系统规范化路径；批准某个目录并不会自动批准任意子目录。持久化的默认输出路径只是提示，应用重新启动后首次使用需通过系统目录对话框授权。历史中的旧路径也不会自动授予访问权。

导入单文件上限为 32 MiB；原生 / 浏览器文件服务在读取前限制单次 100 个文件、总计 128 MiB，界面同时限制跨次队列为 100 个文件、实际字节总计 128 MiB。读取失败的条目保留原因但清空字节，不消耗内容预算。单次原生输出上限为 256 MiB。大于限制的文件有明确错误，可分批或拆分后重试。

目录扫描默认不递归，可选择六种支持格式；递归最多 5 层、所有目录项累计最多 2,000。Windows 通过只读、拒绝 WRITE/DELETE 共享的目录及文件句柄锁定检查范围，拒绝 reparse point，并核对同一文件句柄的最终路径处于已选择根目录内，再分块读取与检查取消。具体文件进入既有 FileAccess 授权，不授予任何目录写入权。未选格式、超限和读失败只统计，不以空内容伪装成功文件。

扫描保留既有队列顺序，按 Windows ordinal 规则排序、比较路径；不同目录同名文件可共存。原生句柄给出文件系统实际 Unicode 拼写，前端仅统一路径前缀、分隔符与 ASCII 大小写，避免 JavaScript Unicode 大小写扩张合并两个真实文件。前端同时等待命令返回和 Channel 终态消费，防止文件事件尚未入队就启动新处理。取消保留已加入文件，丢弃未读完的单文件；离开页面请求取消。

Explorer 使用官方 single-instance 插件作为首个插件注册。首次启动与后续实例的 `--import` 具体路径在原生侧排队；前端先订阅再消费，初始化且空闲时持有统一 busy 锁导入，保留既有队列。后端同句柄读取并拒绝文件/祖先 reparse，限制文件格式、32 MiB / 100 文件 / 128 MiB；Renderer 不能伪造待处理路径。菜单直接调用带引号 EXE 与参数，不经过 cmd/PowerShell。HKCU `SRTTools.Import` owner 标记、安装路径、未知值保护与事务恢复避免覆盖其他菜单；NSIS 仅修复同路径的已启用项，卸载仅清理 owner+路径匹配的专属键。

## 安全导出

默认命名规则是 `{name}_processed`，扩展名由实际输出格式追加。可使用 `{index}`；不允许把路径嵌入命名规则。传统ZIP平铺；`planFolderOutputs` 从原生 `folderSource={rootId,rootName,relativePath}` 构建层级或平铺树，多根重名分组。路径验证、名称规范化、Windows大小写/Unicode冲突避让供界面、ZIP和原生计划共用。原生prepare之后及write遇并发冲突后的真实relativePath保留到导出状态中，后续ZIP沿同树打包。

原生写入先在目标目录创建唯一临时文件、写入并同步，再通过不覆盖已有文件的策略发布最终名称。已有目标自动追加序号，失败时清理临时文件。用户输入不会参与 Shell 字符串拼接。浏览器预览使用下载机制，最终目录和重复文件处理由浏览器决定。

目录输出每会话最多100项/累计256MiB，具体sourcePath必须属于已导入授权，根与目标三种重叠全部拒绝。相对路径拒绝绝对/UNC/盘符、点段、无效/保留名称与过长层级；原生再次核实。祖先/根/子目录被句柄固定，拒绝reparse；为允许Windows原子发布所需共享WRITE而引入隐藏delete-on-close guard，使目录保持非空，阻断原地FSCTL_SET_REPARSE_POINT。guard在finish或进程退出自动释放，不进入最终输出/ZIP。真实测试用同一DeviceIoControl在guard存在时失败、释放后成功作阳性对照。逐项失败不影响其它项，成功ID不能在同会话再次写入；前端跨处理重试也保留成功ID。

## 持久化

桌面后端使用官方 Tauri Store，文件固定为应用数据目录内的 `subtitle-tools.json`。前端未获得插件的任意文件路径读写权限。设置使用明确字段，历史仅保存时间、工具名称、数量、摘要及输出路径，最多 200 条。

原生读写命令串行获取 Store 快照。更新后先将完整 JSON 写入同目录临时文件并同步，再原子替换固定的应用数据文件。若 Windows 返回同目录无法重命名的错误码 17，例如本轮的加密 AppData，先同步写入独立的旧值恢复文件，再写入并同步主文件。恢复文件删除前仍以旧值为准，写入失败可重试。用户字幕导出始终使用无覆盖的发布路径。

历史写入在前端按顺序执行，避免并发处理记录互相覆盖。保存前显式选取元数据字段，额外的正文或条目属性不会持久化。保存失败会显示通知，内存中的处理结果仍保留。

预设在同一个固定 Store 中使用独立的 `tool-presets-v1` 键，浏览器使用同名独立 localStorage 项。预设服务串行化读取和读改写，保存工具注册表声明的字段，并用同一校验函数验证选项、范围和正则。v1 条目缺失的新字段以工具默认值补齐，坏条目隔离，未知版本保留。明确确认后仅可清理已识别损坏的预设键。工作区应用预设时复用参数变更与结果失效逻辑。

流程使用独立 `workflow-presets-v1`，50项/512KiB；旧工具仍20/工具、100总量、256KiB。未知版本/无效流程只读隔离并保留raw；重复ID/同名等条件性冲突包装成不可执行隔离行，防止删除合法项后复活。共享preset队列加浏览器同源Web Locks串行化，读取时先恢复未完成journal。交换JSON1MiB/150项严格纯配置，先私有计划预览，再显式确认；外部ID重建，确认时重读快照，过期计划拒绝。原生CAS只在同一全Store mutex内一次提交两个键；浏览器journal保留两个旧原始字符串，部分写入失败回滚，恢复失败则保留journal并阻止预设读取，设置/历史不受损。

## 扩展方式

新工具先扩展纯函数引擎和测试，再注册参数定义并复用统一工作区。涉及多文档的工具通过 `processCombinedFiles`，普通工具通过 `processFiles`。新增格式必须同时提供输入校验、诊断、序列化约束和往返测试；有损转换必须返回可见警告。

## 本地发布工程

Vite `dist/` 与 Rust `target/` 仍为中间产物。`release:win` 先核实版本清单、Git 源码指纹、项目内 target 和质量门槛，再真实构建 NSIS；复制实际 PE 运行依赖和唯一允许的许可证资源，生成含顶层 `SRTTools/` 的 ZIP。重新解压并核对逐文件哈希，真实 UIA 完成导入、处理和导出后，才可回滚地晋升至固定 `release-output/`。旧副本未恢复、未知文件、链接和运行中的产物会阻止危险清理。默认保留编译缓存；显式低占用模式也不得清理项目外共享 target。详见 [发布策略](RELEASE_POLICY.md)。
