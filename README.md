# SRTTools

**把字幕变成文字，也把需要的片段单独留下。**

一个面向 Windows 的中文桌面字幕工具。拖入字幕，选好导出格式，右边直接查看最终文件内容；修改设置，预览自动更新。没有任务组合，只有一个导出按钮。全程本地处理，原文件始终保留。

![SRTTools 字幕整理：文件列表与正文阅读区](docs/images/workspace.png)

## 选对功能

| 你的需求 | 工作台 / 处理方式 | 得到什么 |
| --- | --- | --- |
| SRT 只要字幕正文 | 导出为：纯文本 · .txt | 原文件名的 TXT，去掉序号与时间轴 |
| 已有 TXT 里还残留字幕信息 | 同样选纯文本，直接导入 | 自动整理，保留正文数字 |
| 集中保存字幕副本 | 导出为：原字幕副本 · .srt | 原字节 SRT 副本，来源不移动 |
| SRT 改成 TXT，内容一点不变 | 导出为：带时间轴文本 · .txt | 保留原始字节、编码和换行的 TXT |
| 只导出 2 分钟到 3 分钟的字幕 | 时间范围导出 | 新 SRT 或纯文本 TXT，可从零开始计时 |

还包括拖放、多文件批处理、输入编码选择、UTF-8 / UTF-16 输出、文本排版、常见字幕标签清理、毫秒级时间偏移、冲突文件名自动编号，以及最新记录在顶部的操作日志。

## 开始使用

便携版：解压 `SRTTools.zip`，双击根目录的 `SRTTools.exe`，无需安装 Python。保留旁边的 `_internal` 文件夹。

1. 在「字幕整理」添加 SRT、TXT 或文件夹，也可直接拖入。
2. 默认导出纯文本 TXT；在右上角选择格式，展开「格式设置」调整排版、编码或去标签，预览实时更新。
3. 查看预览上方的文件名、扩展名和编码。点击 **导出 TXT / SRT**，选择保存目录；保存的就是这份预览对应的文件内容。按钮数量是整批有效文件数，不只是当前查看的文件。

例如 `课程.srt` 直接保存为所选目录中的 `课程.txt`，不额外创建分类文件夹。同名时自动生成 `课程 (2).txt`，不覆盖已有文件。添加文件夹时保留其内部子目录层级；手动添加的文件直接保存到所选目录。预览不写文件，保存前复核来源；失败与取消逐文件显示，已完成文件保留。

设置变化后约 180 ms 自动更新；连续修改只应用最新结果，更新中不能导出旧预览。「恢复默认」只重置文字设置，不清空文件或改变格式。原样两种格式停用正文排版和保存编码，预览会显示原始序号、时间轴与正文，不再藏在另一个保存菜单里。时间截取页也自动更新预览。

长文可以翻页查看全部内容，不再只展示开头；导出包含所有页，翻页提示不写入文件。预览按真实换行显示，不自动软换行，长行可横向滚动。日志默认收起，点击底部「操作日志」查看最新记录；文件错误仍直接显示在列表和预览中。

文件夹扫描跳过链接、目录联接以及本次会话已选择的保存目录（作为扫描子目录时）；不根据文件夹名称擅自忽略输入。首次扫描前不知道未来保存位置，建议把输出放在来源目录以外。读取失败或取消会明确提示列表可能不完整。

仓库内提供可直接体验的 [示例字幕](examples/示例字幕.srt)。便携包由源码构建生成在本地 `dist/`，二进制不提交进 Git。完整说明见 [使用指南](docs/使用指南.md)。

## 时间范围怎么选

例如从完整视频中提取 **第 2 分钟到第 3 分钟**：开始填 `00:02:00`，结束填 `00:03:00`。也可以填秒数 `120` 和 `180`；单独输入 `2`、`3` 表示第 2 秒到第 3 秒。

- 默认选择与范围有交集的字幕，并把跨边界的开始/结束时间裁切到范围内。
- 可改为“整条完全在范围内”或“开始时间在范围内”。范围为左闭右开：在结束点才开始的字幕不纳入。
- 勾选“以范围起点为零”，导出的 SRT 适合对应的截取视频；不勾选则保留原视频时间位置。
- 时间偏移在选取、裁切和归零之后应用。会产生负时间的组合直接报错，避免悄悄丢字幕。
- 新 SRT 的序号从 1 开始；保留正文、样式和时间轴附加设置。字幕有重叠或原始顺序异常时提示，不自动重排。

## 源码运行与命令行

使用 Windows、Python 3.14。依赖版本固定在 requirements 文件中。

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
.\.venv\Scripts\python.exe run_srttools.py
```

命令行与界面共用处理内核，不启动 Qt 窗口。不指定 `-o` 时只预览；输出目录需已存在。

```powershell
# 首次使用示例时创建输出目录
New-Item -ItemType Directory -Force .\output
# 原样转 TXT
.\.venv\Scripts\python.exe -m srttools.cli raw .\examples\示例字幕.srt -o .\output
# SRT 提取正文，清理样式，每条字幕一行
.\.venv\Scripts\python.exe -m srttools.cli text .\examples\示例字幕.srt --strip-tags --layout lines -o .\output
# 已转换 TXT 再清理
.\.venv\Scripts\python.exe -m srttools.cli clean .\output\示例字幕_original.txt -o .\output
# 2–3 分钟，新 SRT 从零开始
.\.venv\Scripts\python.exe -m srttools.cli range .\examples\示例字幕.srt --start 02:00 --end 03:00 --rebase -o .\output
# 同一范围导出纯文本
.\.venv\Scripts\python.exe -m srttools.cli range .\examples\示例字幕.srt --start 120 --end 180 --format txt -o .\output
```

`--help` 列出编码、范围匹配、裁切、偏移和排版选项。多个输入路径可以连续传入；任意处理失败时退出码为 1。

## 工程结构

沿用 ObManage 的分层思路：中文桌面壳、独立业务引擎、隔离测试、可重复打包与可审计工程记忆。

```text
SRTTools/
├── run_srttools.py       # GUI 入口
├── srttools/
│   ├── app.py / ui.py    # 静态工作台导航与受控后台线程
│   ├── workbench.py     # 文件列表、正文阅读与直接保存
│   ├── preview.py       # 实时预览调度、旧结果保护与全文分页
│   ├── workflow.py      # 扫描、自动正文整理与安全导出（无 Qt）
│   ├── subtitles.py     # 字幕解析、清理、范围与时间计算（无 Qt）
│   ├── service.py       # 只读预览、来源复核、原子新文件导出
│   ├── cli.py           # 无界面批处理入口
│   └── smoke.py         # 演示数据端到端验收
├── tests/               # 编码、内容、边界、失败与 CLI 回归
├── tools/               # 图标与便携包构建
├── docs/ / examples/    # 使用指南、截图与演示字幕
├── wiki_memory/         # 当前状态、ADR、知识、日志、模板和检查工具
├── AGENTS.md            # 统一协作约定
└── AGENT.md             # 指向统一约定的兼容入口
```

开发前读 [AGENT.md](AGENT.md)，当前项目事实见 [工程记忆](wiki_memory/README.md)。

```powershell
.\.venv\Scripts\python.exe -m pytest -q
.\.venv\Scripts\python.exe wiki_memory\工具\memory_lint.py index
.\.venv\Scripts\python.exe wiki_memory\工具\memory_lint.py check
.\.venv\Scripts\python.exe tools\build.py
.\dist\SRTTools\SRTTools.exe --smoke-test .\artifacts\frozen\workspace.png
```

构建生成 `dist/SRTTools/SRTTools.exe` 与 `dist/SRTTools.zip`，ZIP 根层直接包含 EXE、`_internal`、使用说明和许可证。Windows CI 会执行回归、记忆检查、构建和冻结包验收。

## 支持范围

支持标准 SRT，兼容带 BOM、CRLF/LF、逗号/点号毫秒、无序号字幕块、多行正文与时间轴附加设置。缺少块分隔、错误时间或空正文会报告错误。TXT 清理保留非字幕段落，不按“全是数字就删除”的规则处理。

自动编码识别只接受 UTF-8 和有 BOM 的 UTF-16；GB18030、Big5、Windows-1252 需要手动选择。界面必须成功解码显示预览后才允许保存，不会把错误说明当成文件内容；CLI 原样转换保留旧行为。每文件上限 64 MiB，每批输入及输出预览分别上限 256 MiB；界面每页最多 50,000 字符，全文均可访问。原样文件的 BOM、CRLF/LF 和编码字节不变；换行符在预览中显示为换行，BOM 不显示为文字。

不包含音视频识别、翻译、语义改写或 ASS/VTT 转换。取消在文件处理边界生效；不会撤销已经导出的新文件。第三方组件信息见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
