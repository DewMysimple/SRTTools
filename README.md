# Subtitle Tools

Subtitle Tools 0.2.0 是极简、轻量的 Windows 本地字幕工具箱。使用 **Tauri 2 + React + Vite + TypeScript**，默认简体中文、浅色主题。字幕处理在本机完成，不上传文件。

操作流程：**选择文件 → 选择工具 → 设置参数 → 预览 → 确认导出**。默认生成 `原文件名_processed.ext`，不会覆盖原文件。

![首页](docs/screenshots/home.png)

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

## 运行环境

- Windows 10 / 11，x64，Microsoft Edge WebView2 Runtime。
- 开发：Node.js **24 LTS**、npm，Rust stable **MSVC** 工具链、Visual Studio C++ Build Tools 与 Windows SDK。
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
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:e2e
npm run test:release
cargo test --locked --manifest-path src-tauri/Cargo.toml
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

覆盖核心边界、字节导入到导出、批次失败与取消、编码不确定时阻止导出、ZIP 重名、设置 / 历史重载，以及真实浏览器 Worker 流程。详细范围与手工验收见 [TESTING](docs/TESTING.md)。

## Windows 构建与最新产物

```powershell
npm run release:win
npm run release:verify
npm run disk:report
```

最终文件统一放在项目的 `release-output/`：

```text
release-output/
  SRTTools/subtitle-tools.exe
  SRTTools.zip
  SRTTools-Setup.exe
  SHA256SUMS.txt
  build-info.json
```

ZIP 包含顶层 `SRTTools/`，解压后运行其中的程序，仍需系统安装 Microsoft Edge WebView2 Runtime。安装器供当前用户安装。构建脚本会运行质量检查、真实 Tauri 打包和 ZIP 解压后的原生导入/处理/导出冒烟，全部通过才替换上一套结果。需要已登录的可交互 Windows 桌面，并先关闭正在使用的 Subtitle Tools；仅启动 EXE 不会被计为完整验收。

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

**中文乱码？** 展开工具页“输入与导出选项”，手动选择输入编码，再核对预览。没有 BOM 的推测 UTF-16 或含替代字符的内容默认不允许直接导出。手动选择编码表示你已核对文字，警告仍会保留。GBK / GB18030 不提供输出。

**为什么重新启动后还要确认输出目录？** 保存的目录是偏好，不是永久授权。原生层只允许当前会话明确选取的文件和目录；第一次使用旧目录会再次显示系统对话框。

**保存失败怎么办？** 结果保留在当前工具页，可再次选择位置导出；切换工具前请保存。多个文件可一次导出 ZIP。重名文件会追加序号。

**预设保存哪些内容？** 只保存你确认保存的当前工具参数，可能包含你输入的查找和替换文字。编码、文件、导出目录和命名规则仍独立设置。重置表单会恢复工具默认值，并保留已存预设。

**格式转换会丢失什么？** 通用模型保留时间与多行正文，不保留 ASS / SSA 样式特效、VTT 位置等专有信息。TXT 导出不可直接还原时间；TXT 导入必须带可识别的时间行。CSV 必须使用 `index,start,end,text` 四列。

**处理容量？** 单输入文件最多 32 MiB；队列最多 100 个文件、总计 128 MiB；单次原生输出最多 256 MiB。预览每页 20 条。请将更大的工作拆成多批。

**尚未实现？** 简繁转换、关键词过滤、独立字幕匹配、自定义可保存流程、专用每行字数截断工具尚未开放。自动换行是字符规则，不做语义分句。软件不包含视频播放、时间轴或轨道编辑。

0.2.0 验收、安装器校验值与剩余 Windows 验证范围见[测试记录](docs/TESTING.md)与 [v0.1.1 发布检查表](docs/RELEASE_CHECKLIST_v0.1.1.md)，版本变更见[更新记录](docs/CHANGELOG.md)。
