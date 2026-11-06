# Subtitle Tools

Subtitle Tools 0.6.0 是轻量的 Windows 本地字幕工具箱，包含独立的字幕时间轴和本地视频同步预览。使用 **Tauri 2 + React + Vite + TypeScript**，默认简体中文、浅色主题。字幕和视频在本机处理。

操作流程：**选择文件 → 选择工具 → 设置参数 → 预览 → 确认导出**。默认生成 `原文件名_processed.ext`，不会覆盖原文件。

![v0.4.0 浏览器预览首页](docs/screenshots/home-v040.png)

## 已实现

- 首页、可搜索 / 分类的全部工具、批量处理、处理记录、设置和统一工具页。
- 文本查找替换（大小写 / 正则）、删除空白 / 重复字幕、空格清理、标点转换、英文大小写、自动换行、HTML 清理、纯文本提取。
- 重新编号、结构 / 时间 / 重叠 / 重复 / 字数和显示时长检测；按明确策略修复时间并重新检测。
- 时间偏移、显示时长增减、最短 / 最长时长、时间范围裁剪。
- 多文件合并（文件顺序 / 时间排序）、双语合并（编号 / 时间容差，保留未匹配）、按条数 / 时间拆分、字幕差异报告。
- SRT、VTT、CSV、ASS、SSA、带时间信息的 TXT 导入；SRT / VTT / CSV / ASS / TXT 导出。格式说明见 [功能文档](docs/FEATURES.md)。
- UTF-8、UTF-8 BOM、UTF-16 LE / BE 读写；GBK / GB18030 手动导入；CRLF / LF 导出。
- 原生多选 / 拖放、安全另存为、重名自动避让、文件名模板、ZIP 去重导出、文件统计、空白 SRT 模板。
- Worker 顺序批处理、逐文件失败隔离、取消与重试、浅色 / 深色 / 系统主题、本地设置与历史摘要持久化。
- 处理前后按字幕逻辑对齐，可筛选并分页查看增删、正文高亮、毫秒时间及编号变化。
- 按工具保存本地命名参数预设。应用预设只填充表单并清除旧结果，重新处理后才可导出。
- 简繁转换采用本地 OpenCC 词典，支持通用简→繁、繁→简；只写回正文，保留编号、时间、换行、VTT 设置和 ASS/SSA 样式。
- GBK / GB18030 严格字节导出，不能逐字往返的字符会明确拒绝并定位，单文件与 ZIP 使用相同结果字节。
- 桌面文件夹导入、可选递归与格式过滤，扫描进度、去重、限额和取消恢复复用现有队列。
- 独立字幕对比复用逻辑对齐视图和时间容差，保留不含正文的 JSON 报告；错误结构或未确认编码先给诊断。
- 批量页应用和更新同一套工具预设；实验性的当前用户 Explorer 右键入口默认关闭，可在设置中显式登记、禁用和修复。
- 批量“处理流程”模式可组合八种单文档操作，最多20步，一次解码/解析、末端编码；支持启停重排、逐步摘要、真实差异预览与失败项重试。
- 我的流程支持命名保存、更新、重命名、复制和删除；工具/流程预设可选择导出 UTF-8 JSON，先预览导入影响再处理跳过/改名/覆盖冲突，旧工具预设保留。
- 文件夹批量和流程可平铺或保持相对目录层级，目录与 ZIP 共用可见输出树；多根别名、重名避让、授权边界和源目录重叠拒绝。

## 使用处理流程

打开“批量处理 → 处理流程”，依次添加“删除空白字幕 → 空格清理 → 查找和替换 → 整体时间偏移”。填写查找/替换文字，将偏移量设为500毫秒；添加文件或文件夹后查看适用性，再点击“预览影响”。左右预览和逐步摘要来自真实执行，修改配置后需重新处理。核对结果后导出 ZIP，或在桌面版选择独立输出目录、预览文件树并确认写入。原文件保持不变，预览和保存流程都不等于导出字幕。

“保存流程”只保存参数，不保存字幕和授权。工具预设可快照复制到某一步。跨设备分享使用“导出预设 JSON”，个人查找/替换文字会包含在配置中，导出前需明确确认。完整可导入示例见 [SRTTools-Presets.json](docs/examples/SRTTools-Presets.json)。ASS/SSA/VTT 混合步骤默认拒绝，需明确同意布局损失才规范化为 SRT；仅简繁的流程保留原布局。容量和安全边界见 [功能文档](docs/FEATURES.md)。

![v0.4.0 四步处理流程配置](docs/screenshots/workflow-v040.png)

![v0.4.0 真实处理结果与差异预览](docs/screenshots/workflow-preview-v040.png)

## 字幕时间轴

1. 在侧栏打开「字幕时间轴」，点击「打开字幕」，选择一份 SRT。若自动检测失败，先选择读取编码再打开。
2. 点击列表或轨道字幕块选择字幕。拖块平移，拖左右边缘修剪，或在检查器中输入开始、结束时间和多行正文后应用编辑。按 Ctrl 或 Shift 多选，方向键按指定步长微调。
3. 用 Ctrl + 滚轮或缩放按钮查看细节，用「拟合全部」回到总览。空白轨道可拖动定位光标。重叠条目分行显示，可展开「保存前检查」查看诊断。
4. 用 Ctrl + Z 撤销，Ctrl + Y 或 Ctrl + Shift + Z 重做。点击「另存为」导出新 SRT；切换文件、工作区或关闭窗口时，可保存并继续、放弃或取消。

## 本地视频同步预览

1. 在桌面版时间轴打开 SRT 后，点击「关联视频」，选择本地视频。优先使用 H.264/AAC 的 MP4，实际解码取决于 Windows 和 WebView2。
2. 播放时画面叠加当前字幕，时间轴光标随视频推进。点击刻度、拖动光标、点击检查器的「定位字幕」，或输入毫秒时间，均可跳转视频。播放器提供倍速、音量和静音。
3. 展开「A/B 区间循环」，填写 A、B 或用当前位置设置，点击「应用循环」。再次检查时可暂停或清除循环。小窗口可收起画面，并用「列表宽度」调整两侧比例。
4. 更换或关闭视频后可继续编辑及另存 SRT。视频按会话只读打开，关闭后释放；保存只输出新的 SRT。超出视频时长的字幕仍可编辑和导出。

![v0.6.0 视频预览与时间轴](docs/screenshots/media-preview-v060.png)

WebM 和其他编码的实测范围、草稿行为及容量边界见[功能文档](docs/FEATURES.md#本地视频同步预览)。

## 运行环境

- Windows 10 / 11，x64，Microsoft Edge WebView2 Runtime。
- 开发：Node.js **24 LTS**、npm，Rust stable **MSVC** 工具链、Visual Studio C++ Build Tools 与 Windows SDK。
- 媒体验收使用 PATH 上支持 `libx264`、`aac`、`libvpx` 的 FFmpeg 生成合成样本。安装后使用 SRTTools 由系统 WebView2 解码。
- 原生构建依赖按 [Tauri 官方 Windows 环境说明](https://v2.tauri.app/start/prerequisites/) 安装。

依赖已固定到 `package-lock.json` 和 `src-tauri/Cargo.lock`。前端使用 React 19、Vite 8、TypeScript 5.9 strict、Tailwind 4、Zustand、Zod、Lucide、JSZip；测试使用 Vitest 与 Playwright。

在项目目录打开 PowerShell：

```powershell
cd "E:\Software Development\SRTTool"
npm ci
npm run tauri -- dev
```

仅浏览器预览：`npm run dev`，访问 `http://127.0.0.1:1420`。该模式支持文件导入、实际处理和下载；系统目录、Explorer 与原生授权只在桌面版可用。

## 检查与测试

```powershell
npm run lint
npm run check:versions
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:e2e
npm run test:release
cargo test --locked --manifest-path src-tauri/Cargo.toml
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
npm run benchmark
```

覆盖核心边界、字节导入到导出、批次失败与取消、编码不确定时阻止导出、ZIP 重名、设置 / 历史重载，以及真实浏览器 Worker 流程。详细范围与手工验收见 [TESTING](docs/TESTING.md)。

## Windows 构建与最新产物

```powershell
npm run release:win
npm run release:verify
npm run disk:report
```

当前 Windows 媒体、时间轴与打包验收见 [v0.6.0 QA](docs/TIMELINE_V0.6_QA.md)。历史证据见 [v0.5.0 时间轴验收](docs/TIMELINE_V0.5_QA.md)和 [v0.4.0 收尾报告](docs/RELEASE_CLOSURE_v0.4.0.md)。

最终文件统一放在项目的 `release-output/`：

```text
release-output/
  SRTTools/subtitle-tools.exe
  SRTTools/THIRD_PARTY_NOTICES.txt
  SRTTools.zip
  SRTTools-Setup.exe
  SHA256SUMS.txt
  build-info.json
```

ZIP 包含顶层 `SRTTools/`，解压后运行其中的程序，需要系统安装 Microsoft Edge WebView2 Runtime。安装器供当前用户安装。ZIP 解压版和 NSIS 安装版均通过原生工作流、时间轴和媒体检查后，才会替换上一套结果。验收需已登录的可交互 Windows 桌面，并先关闭正在使用的 Subtitle Tools。

`release:win` 默认要求已提交的干净工作树，版本清单须一致；开发验收可显式使用 `npm run release:win -- --allow-dirty`，此状态会写入构建记录。成功后使用固定文件名替换旧版，并清理已复制验证的 NSIS 中间安装器和脚本暂存报告。Vite 的 `dist/` 与 Rust `target/` 是开发中间产物，最终交付目录始终是 `release-output/`。

清理默认只列出目标和大小；确认目标后显式执行：

```powershell
npm run clean:outputs
npm run clean:outputs -- --apply
```

默认保留编译增量缓存。低占用模式先预览 `npm run clean:release-cache -- --confirm-release-cache`，再加 `--apply` 仅清理经核实的本项目 Rust release 缓存，下次 release 会重新编译。不会清理 `node_modules`、用户应用数据或共享的外部 Cargo target。未知文件、链接跳转、仍在使用的产物与待恢复的旧发布副本均受保护。详细规则见 [RELEASE_POLICY](docs/RELEASE_POLICY.md)。

NSIS 提供简体中文界面。初次构建需要下载 Rust crates 和 NSIS 工具；缺少 WebView2 的机器由安装器下载官方运行时。应用本身没有云端字幕服务。当前包未配置代码签名。仅需内部打包时可使用 `npm run tauri -- build`，它不会执行上述发布晋升与清理流程。

## 目录

```text
src/
  app/              路由、布局、工具注册表和参数定义
  pages/            首页 / 工具 / 批量 / 历史 / 设置 / 模板
  features/timeline/ 字幕时间轴工作区、编辑事务与区间索引
  components/       文件选择、参数、预览、诊断和导出
  core/             独立字幕模型、解析、序列化和业务算法
  services/         文件、批次调度、ZIP、设置与历史
  workers/          独立 Worker 处理流程
  stores/           Zustand 会话状态
src-tauri/          Rust IPC、路径授权、安全写入、NSIS 配置
e2e/               Playwright 真实浏览器流程
docs/              架构、功能、测试说明与截图
examples/          可手动导入的示例文件
scripts/           受控发布、哈希校验、安全清理与 Windows 冒烟
release-output/    最新一套本地交付物（Git 忽略）
```

架构和安全边界见 [ARCHITECTURE](docs/ARCHITECTURE.md)。

工程交接和维护见[工程记忆](wiki_memory/README.md)与[项目维护指令](AGENTS.md)。

## 使用注意与常见问题

**无法导入或提示解析错误？** 普通工具遇到无法恢复的结构会停止导出。先运行“字幕检测”，修正报告中的时间行或孤立正文后重新导入。缺失 / 重复编号可以重新编号；无法知道原始时间的内容不会凭空恢复。

**中文乱码？** 展开工具页“输入与导出选项”，手动选择输入编码，再核对预览。没有 BOM 的推测 UTF-16 或含替代字符的内容默认不允许直接导出。手动选择编码表示你已核对文字，警告仍会保留。GBK / GB18030 输出采用严格 WHATWG 往返校验，不会把不支持字符替换成问号；失败时可改用 UTF-8。

**简繁是否会改排版？** 简繁工具只转换正文，保留原换行和格式布局；因此该工具的换行选项固定为“保留原文件”。这是字词转换，不等同于翻译，专有名词、歧义词和跨格式标记分段的词组建议人工核对，往返不保证逐字还原。

**如何添加目录？** 桌面版点击“添加文件夹”，默认只扫当前目录，可勾选包含子文件夹和筛选格式。最多递归 5 层、检查 2,000 个目录项，并遵守队列 100 文件 / 128 MiB 和单文件 32 MiB。链接、越界与失败会统计，取消保留已完成加入项。浏览器预览不显示原生目录入口。

**右键菜单在哪里？** 此入口目前为实验性，默认关闭。桌面设置可显式登记当前用户的六种字幕扩展专属键，不改默认打开方式；Windows 11 通常在“显示更多选项”，传统菜单最多选 15 文件。本轮测试机登记和 Shell 命令查找成功，但真实菜单没有显示该项，显示验收为 BLOCKED；登记状态不代表已能看到菜单。程序移动后可显式修复，禁用和卸载保护另一安装位置。独立文件导入、目录导入和处理不受此限制影响，详见测试记录。

**为什么重新启动后还要确认输出目录？** 保存的目录是偏好，不是永久授权。原生层只允许当前会话明确选取的文件和目录；第一次使用旧目录会再次显示系统对话框。

**保存失败怎么办？** 结果保留在当前工具页，可再次选择位置导出；切换工具前请保存。多个文件可一次导出 ZIP。重名文件会追加序号。

**预设保存哪些内容？** 只保存你确认保存的当前工具参数，可能包含你输入的查找和替换文字。编码、文件、导出目录和命名规则仍独立设置。重置表单会恢复工具默认值，并保留已存预设。

**格式转换会丢失什么？** 普通格式转换保留时间与多行正文，不保留 ASS / SSA 样式特效、VTT 位置等专有信息。文本提取输出 TXT 会丢时间；TXT 导入必须带可识别的时间行。简繁同格式正文写回保留原布局，也可保留 SSA 与带时间 TXT。CSV 必须使用 `index,start,end,text` 四列。

**处理容量？** 单输入文件最多 32 MiB；队列最多 100 个文件、总计 128 MiB；单次原生输出最多 256 MiB。预览每页 20 条。请将更大的工作拆成多批。

**尚未实现？** 关键词过滤、独立字幕时间匹配、专用每行字数截断工具尚未开放。自定义可保存流程已在批量页提供。自动换行使用字符规则。

Windows 验证范围、未覆盖环境和实际命令见[测试记录](docs/TESTING.md)。本地安装包为未签名候选。版本变更见[更新记录](docs/CHANGELOG.md)。

## 下载与项目授权

本轮准备本地候选包，路径为 `release-output/SRTTools-Setup.exe` 和 `release-output/SRTTools.zip`；安装版供当前用户安装，便携版解压后运行 `SRTTools/subtitle-tools.exe`。GitHub Releases 尚无公开下载版本，源码用户可按上文 Windows 构建步骤生成。对外 tag、Release 和附件上传需维护者另行确认；发布文案见[v0.4.0 发布说明草稿](docs/RELEASE_NOTES_v0.4.0.md)。

项目 LICENSE 尚未选择，用户已决定将其保留为公开发布前待决定事项。第三方依赖声明随安装包和 ZIP 分发，见[THIRD_PARTY_NOTICES](docs/THIRD_PARTY_NOTICES.txt)。
