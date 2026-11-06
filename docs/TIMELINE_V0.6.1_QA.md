# v0.6.1 草稿恢复验收

2026-11-06，在 Windows 11 Pro 25H2 x64 26200.9711、96 DPI、WebView2 156.0.4314.58 验收。Node 24.16.0、npm 12.0.1、Rust 1.97.0 MSVC、Tauri 2.12.5 / CLI 2.12.4，测试素材由本机 FFmpeg n8.0.1 生成。起始主线 `d74e14c7420fad026e5bce14dbbc7b135a22e261`，构建源码 `8af0f924442d75065770415f4f2fee381f29af9e`，干净工作树。源码指纹 `98EBCC1A4D20917D789644C5399DF9E652422304E068E80B2FE776809132C6A5`。开发分支的同源码远端引用已由 `git ls-remote` 核对。见[基线审计](TIMELINE_V0.6.1_V0.7_PLAN.md)和[构建源码 CI](https://github.com/DewMysimple/SRTTools/actions/runs/42195562251)。

## 实现和故障覆盖

- `commands/drafts.rs` 管理有界、带 SHA-256 的不可变快照，以及受限 SRT 字节复核。原子发布、错误码 17 的同步副本回退及退役标记均保留上一次完整提交。
- `draft-recovery-service.ts` 和 `TimelineWorkspace.tsx` 在共享编辑事务外调度保护，处理可等待的切换、保留和导出。媒体 grant 保持由现有组件和原生协议管理。
- Rust 草稿专项八项已通过。故障注入包括部分暂存、完整暂存后发布失败、模拟权限/磁盘失败、最新快照截断/损坏、退役清理中断。另实测 Windows 独占占用、junction 拒绝和本机 AppLocalData 目录重定向。

## 早期候选

首个干净候选 `0cff034036b3e68e485a0b191e11c85b84a547e4` 的 86 项 Chromium 回归、Rust 和构建通过。原生在旧组合框驱动的 PowerShell 5.1 `Windows.Point` 无参构造失败，发布保留 0.6.0 的旧包。独立真实草稿场景进一步发现此测试机的新建 AppLocalData 目录由系统映射到另一块本地磁盘，普通作用域比较拒绝了其写入。当前候选固定两条路径的各级句柄并拒绝 reparse 和非本地目标，正向与 junction 反例均通过。初次失败及诊断回执保存在 `src-tauri/target/v061-*`。

`fd3f2a554cc0c65a4955750b9e28eaab6e18a9d0` 的 ZIP 候选通过工作流、媒体与六项真实草稿场景，性能驱动在原生文件打开尚未完成时访问禁用字段，候选未晋升。增加检查器可编辑等待后，同一程序的独立 `windows-smoke.ps1 -Scenario recovery -ExpectedVersion 0.6.1` 完整通过，包含 500 / 5,000 / 10,000 条采样。此回执用于诊断，正式验收仍要求 ZIP 与 Setup 分别通过。

## 正式包验证

| 验证 | 状态与证据 |
| --- | --- |
| `npm ci`、`npm run check:versions`、`npm run release:win -- --check` | PASS，268 包、6 个版本字段、干净源码 |
| lint、typecheck、build、Vitest | PASS，337 项。Vite 保留原有大分块提示 |
| `npm run test:e2e` | PASS，86 项 Chromium，包括 5 项草稿交互及真实 pointerup。桌面 IPC 由测试模拟 |
| Cargo test / Clippy | PASS，54 项 Rust，含 8 项草稿存储。Clippy 零警告 |
| `npm run test:release`、PowerShell 5.1 | PASS，20 项发布安全、23 脚本解析、10 项 QA 安全、12 项状态保护 |
| `npm run release:win`、`npm run release:verify` | PASS，ZIP 真实解压、安装版实际安装和卸载，各通过工作流 10、媒体 7、时间轴 7、恢复 8 项。Setup 另通过生命周期 19 项 |

两个发行形态各自使用独立的 Windows 本地数据命名空间。实测等待草稿回执后强制结束应用，重启恢复最近完整 revision，文件独占失败后可重试，源 SRT 同长度改字后保留受控外部修改。原始和故意修改后的源 SHA-256 分别为 `BDDE540C068C1E885DABB7459D37555FD4A037BCEAFCE0749FCB01525BD6B790` 与 `F4AEB78091F338AEDD89EDC977A6A1EAE23BB892A019A7B0737B70C6EE2F65C9`。H.264/AAC 合成 MP4 为 61,433 字节，SHA-256 `4E9ABDDB12FA4E879728459454BC54E8C80D819E39E54EF6A639DBF65C27B3FA`。进程终止后视频可重新写入测试句柄，媒体和原字幕均按场景核对哈希。取消导出保留草稿，成功导出精确正文与时间后完成退役。其他工作流的旧设置及两种预设在安装和卸载后验证保留。

## 性能

每组 3 次保存，均值取整，P95 取最近秩。保存时间从 UI 发起到可读快照回执，包含 1.2 秒防抖。打开包含系统选择器，恢复包含复核与渲染。峰值为累积的宿主进程工作集，WebView2 独立进程另计。

| 条数 | 快照字节 | ZIP 打开 / 保存均值 / P95 / 恢复 (ms) | Setup 打开 / 保存均值 / P95 / 恢复 (ms) | ZIP / Setup 宿主峰值字节 |
| --- | ---: | --- | --- | --- |
| 500 | 131,611 | 715 / 1,385 / 1,408 / 615 | 706 / 1,427 / 1,454 / 502 | 79,659,008 / 81,788,928 |
| 5,000 | 1,350,616 | 497 / 1,409 / 1,509 / 637 | 584 / 1,502 / 1,612 / 658 | 83,869,696 / 85,909,504 |
| 10,000 | 2,710,620 | 558 / 1,502 / 1,628 / 507 | 541 / 1,557 / 1,724 / 652 | 99,209,216 / 101,888,000 |

Chromium 的 10,000 条媒体播放测量为 76 帧、帧间隔 P95 16.7 ms、长任务 0、编辑区 DOM 变更 0。500 / 5,000 / 10,000 条的固定视口各挂载 8 条列表行和 27 个轨道块。

同机 `npm run benchmark` 两次 PASS。50,000 条三步工作流的 Node / Chromium Worker 中位数分别为 325.42 / 892.60 ms 和 573.62 / 784.30 ms，基线为 295.10 / 456.40 ms。通用引擎、Worker 与基准脚本的 Git 差异为空。复测开始时系统 CPU 采样为 21%，背景负载与基线未完全匹配，耗时差异尚未归因。两次均创建并终止 1,017 个 Worker，活动数 0。原始日志为 `src-tauri/target/v061-final-benchmark.log` 与 `v061-benchmark-isolated.log`。

## 产物和清理

| 文件 | 字节 | SHA-256 |
| --- | ---: | --- |
| `SRTTools-Setup.exe` | 2,178,804 | `AC983E8E8EBD89364568414F62F1C794690FC92E964CBDC73DED5C911976A43F` |
| `SRTTools.zip` | 2,522,770 | `35ECA6392B6999939A97EBD3C6F707E7667F14B5913F4BEEE2F84E4C1580BE99` |
| `SRTTools/subtitle-tools.exe` | 4,697,088 | `B7A4DE65391B4EE39CA3D9F029DCDFAEF3CC8E4C702B2614F2FD91ACB5754842` |
| `SRTTools/THIRD_PARTY_NOTICES.txt` | 728,050 | `A17EA3B35FF06CEC85022E4034F85F2061505E68D5D18306B2B1EC0B257E7780` |
| `build-info.json` | 10,899 | `6E285FE1ED549D7A8CC391A91B4A26CA68D24845BC1EDA2D462F1C8674703833` |
| `SHA256SUMS.txt` | 439 | `F7452B0692E6644293D29FEB522945EC90F9E9AB843321AAB6B0D16E5C420061` |

安装后的 EXE 哈希为 `BB735DB8B04BAFFF2962EEAB4F798B3C058B15DB800AB1041D8220C268327D88`。发布前后 `disk:report` 显示交付库存从六件 9,840,893 B 到六件 10,138,050 B。已清理已核实的中间安装器 2,178,804 B 和旧故障摘要 1,733 B，旧故障回执和运行日志保留在 `src-tauri/target/v061-*`。开发编译缓存与未归属目录保留。

## 兼容性边界

- PASS，Win11 已有 WebView2、100% DPI、Unicode 和空格路径、独占文件、源外部修改和删除、真实重启、媒体选择取消及重复打开。取消替换保留仍在使用的当前视频，成功替换和关闭释放旧句柄。
- BLOCKED，实际 Windows 10、完全干净 WebView2、125% / 150% / 200% 物理 DPI、系统休眠与恢复。此主机只提供现有 Win11 桌面环境。
- 模拟故障覆盖磁盘空间不足、权限拒绝和暂存中断。实际磁盘耗尽、Windows 超长路径选择器和完整网络共享矩阵 NOT RUN。源指纹复核会将网络、设备或 reparse 路径判为不可核对。
- 已保存快照可恢复，意外终止时仍处于防抖或未完成写入的编辑可能丢失。项目许可证仍待决定，交付的 EXE 和 Setup 为 NotSigned。
