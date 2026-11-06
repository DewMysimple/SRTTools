# v0.7.0 精准校时验收

第七阶段起始基线为 v0.6.0。v0.7.0 从已经远端核实的 v0.6.1 主线 `e4120ebf74e5eb31244937509087672d1e8cc374` 创建 `codex/v0.7.0-precision-timing`。前一阶段见 [v0.6.1 草稿验收](TIMELINE_V0.6.1_QA.md)。

## Gate 4–7 候选实现

- `TimelineWorkspace.tsx` 与 `core/precision-timing.ts` 从实际播放位置或无视频游标设置单端，区分重叠来源，并提供列表导航与受焦点约束的快捷键。
- `MediaPreview.tsx`、`media-sync.ts` 复用媒体元素、寻址队列与已授予的只读媒体会话。选中区间可单次或循环播放，结束时保留 A/B 配置。拆分使用可编辑的双正文预览和现有事务、校验与 SRT 往返服务。
- `CalibrationPanel.tsx` 和 `core/precision-calibration.ts` 以整数比值进行线性校准，显示非法值、时长和实际新增的重叠对。确认绑定当前 revision 和作用范围，超过 10,000 条复用现有 Worker，只传时间元数据。
- 两点校准、拆分和端点写入使用 v0.6.1 已有草稿 schema，原文件仍经安全另存为路径保护。

## 候选验证

`npm test` 的 350 项 Vitest、20 项发布安全、24 个 PowerShell 5.1 脚本解析、14 项专项 Chromium 已通过。早期 Chromium 复测修正了正文定位器，并按实测容器 seek 偏差校验区间终点。实际 WebM 首轮在 2,900 ms 目标处报告 2,902 ms，端点设时仍按动作发生时的真实媒体值读取。

真实 v0.7.0 开发 EXE 的初次全流程已通过最小窗口、视频设时、预览和拆分，随后测试驱动误用 Invoke 操作校准展开控件。按控件实际模式修正后，独立 `windows-smoke.ps1 -Scenario precision -ExpectedVersion 0.7.0` 已通过所有精准校时场景，包括强制重启、源和导出校验。旧流程组合框一次焦点丢失，以重新确认同一应用窗口和原生字段的方式重试。诊断回执保存在 `src-tauri/target/v070-direct-*`。

首个干净候选 `a4a43daaebf4b0c2272c3faec352c9d539bb2bc3` 的完整 Chromium 回归出现一次区间结束位置晚 12 ms。帧时间到达终点时，实际媒体时钟可能已超过终点。现在停止后由共享寻址队列定位目标，并用模拟帧时间落后于实际时钟的回归测试覆盖。该候选未晋升，现有 0.6.1 安装包和 ZIP 哈希经重新验证保持一致。

## 正式质量门槛

干净构建源码 `9f2d72423f36098a080bbe83f227c6f99b2202f8`，源码指纹 `7961ADA39C1DFC64E642F8885B07A8C5CACADA2C9A918085CE48BA8CC4280B04`。[同一源码的 GitHub CI](https://github.com/DewMysimple/SRTTools/actions/runs/42201841276) 为 PASS。v0.6.1 主线另有 [独立 CI 回执](https://github.com/DewMysimple/SRTTools/actions/runs/42197660278)。

| 命令 | 结果 |
| --- | --- |
| `npm ci` | PASS，268 个包 |
| `npm run check:versions`、`npm run release:win -- --check` | PASS，npm、Cargo、Tauri 六处字段均为 0.7.0，README 和 Changelog 已同步 |
| `npm run lint`、`npm run typecheck`、`npm run build` | PASS。Vite 保留单个约 598 kB 的压缩前分块提示 |
| `npm test`、`npm run test:e2e` | PASS，351 Vitest、92 Chromium，含旧工具、批量、组合流程、预设、媒体、草稿与校时回归 |
| `npm run test:release` | PASS，20 项，含回执缺失或校验失败时保留旧包 |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml` | PASS，54 项 |
| `cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` | PASS |
| `scripts/check-windows-scripts.ps1`、`scripts/windows-qa-safety.test.ps1`、`scripts/windows-state-protection.test.ps1` | PASS，24 个脚本经 PowerShell 5.1 解析，安全 10 项、状态恢复 12 项 |
| `npm run release:win`、`npm run release:verify` | PASS，实际构建 NSIS，ZIP 与 Setup 双回执和文件 SHA-256 校验均通过 |

## 原生 Windows 验收

2026-11-06，Windows 11 Pro 25H2 26200.9711 x64、WebView2 156.0.4314.58、100% DPI，实际 900×620 窗口。Node 24.16.0、npm 12.0.1、Rust 1.97.0 MSVC、Tauri 2.12.5 / CLI 2.12.4。发布事务使用 `windows-smoke.ps1` 与 `windows-setup-acceptance.ps1`，版本参数均为 `0.7.0`。

| 场景 | 解压 ZIP | NSIS 安装版 |
| --- | --- | --- |
| 旧工作流、时间轴、媒体 | PASS，10 / 7 / 7 项 | PASS，10 / 7 / 7 项 |
| 草稿恢复 | PASS，8 项 | PASS，8 项 |
| 精准校时 | PASS，7 项 | PASS，7 项 |
| 安装版本、启动、第三方许可、卸载、设置和注册表恢复 | 便携版无需安装 | PASS，19 项，已安装版本 0.7.0 |

七项精准校时包括最小窗口导航、真实媒体时间设端与最近定位、区间播放恢复 A/B、Unicode 拆分与撤销、失效预览与重新校准、校准后强制终止并恢复草稿、精确另存与输入哈希保持。Setup 安装后的 EXE SHA-256 为 `5BF5FB2B2C80FD82F68138EC7D0905582D07D5A8B595EA51B2BA491D70AF523C`。两种包的合成源 SRT 前后均为 `C3902A68DA8F6046B7B9482F7E364597F7C18812120611C3B39E5783ADC4F97D`，精确另存结果均为 `C0CB56D10821ECAE207EDDCAE60DEFE1F3911844CA5C33178CCFFA5818D40942`。用于两种包的合成 H.264/AAC 样本 61,433 B，原样本 SHA-256 前后均为 `4E9ABDDB12FA4E879728459454BC54E8C80D819E39E54EF6A639DBF65C27B3FA`。FFmpeg 仅在测试主机生成样本。

## 性能

正式 Chromium 回归采样采用分页差异，实际最多 40 行。10,000 条预览 / 应用为 52.79 / 99.03 ms，50,000 条为 259.41 / 406.63 ms；后者经既有 Worker，传入时间元数据。两次 Chromium JS 堆快照均报告 60,300,000 B，属于粗粒度单点读数。播放采样 76 帧、帧间隔 P95 16.7 ms，观测到 0 次长任务、0 次编辑区 DOM 变更。

| 草稿条数 | 快照 B | ZIP 打开 / 保存均值 / 保存 P95 / 恢复 ms | Setup 打开 / 保存均值 / 保存 P95 / 恢复 ms |
| --- | ---: | ---: | ---: |
| 500 | 131,611 | 804 / 1,412 / 1,451 / 393 | 741 / 1,404 / 1,440 / 636 |
| 5,000 | 1,350,616 | 533 / 1,459 / 1,542 / 504 | 606 / 1,481 / 1,547 / 667 |
| 10,000 | 2,710,620 | 523 / 1,540 / 1,577 / 641 | 672 / 1,496 / 1,641 / 631 |

保存计时含 1,200 ms 防抖与 UIA 观察间隔，每档三次，P95 用最近秩，等于该档最高值。桌面主进程峰值工作集见 `build-info.json`，10,000 条为 ZIP 101,314,560 B、Setup 100,937,728 B。v0.6.1 独立采样及基线条件见 [草稿验收](TIMELINE_V0.6.1_QA.md)。

`npm run benchmark` 在发布验收结束后单独运行，PASS。Windows 11 / i7-14700KF / 32 GiB / Chromium 156.0.8078.4，每组一次预热、五次计时，50,000 条三步通用流程的 Node 中位数 568.19 ms（548.05–647.48），高于本轮初始基线 295.10 ms，接近 v0.6.1 的第二次 573.62 ms。Chromium Worker 中位数 460.50 ms（456.40–484.20），初始基线 456.40 ms。Worker 创建和终止各 1,017 次，活动数 0。通用流程引擎、Worker 实现与基准脚本同基线，Node 波动原因未隔离。机器报告在 `src-tauri/target/benchmark/PERFORMANCE_v0.7.0*`。

## 产物与发布事务

`release-output/` 保留一套六件，共 10,169,868 B；发布前 0.6.1 为 10,137,809 B，相差 32,059 B。构建与回执时间为 2026-11-06 10:25–10:26 UTC。`build-info.json` 为完整机器回执。

| 文件 | 字节 | SHA-256 |
| --- | ---: | --- |
| `SRTTools-Setup.exe` | 2,188,671 | `AE40F655CD777F777749C5CB0A742343D0E513BF103FD18B1E07E2B956593E40` |
| `SRTTools.zip` | 2,533,445 | `F965B726EB44ADE351F8E8B1FEBFB1FFE90C7B6856322C2066FD6BD535C2B262` |
| `SRTTools/subtitle-tools.exe` | 4,707,328 | `091648DD8F8F5496231974ABC637A004FCC97AF3D28EB390BAF93EFBBA3D05EA` |
| `SRTTools/THIRD_PARTY_NOTICES.txt` | 728,050 | `A17EA3B35FF06CEC85022E4034F85F2061505E68D5D18306B2B1EC0B257E7780` |
| `SHA256SUMS.txt` | 439 | `7509585CBC34FE2F10424BF17D514C7A9813AE6953FA8D7FFA04DBBED1D72700` |
| `build-info.json` | 11,935 | `BBF7CF435751AEA8765347D3C4F49FA59459B5ACB14B37B429DF7B4FB95EB971` |

安装器的 Authenticode 实测为 `NotSigned`。项目许可证按用户决定列入公开发布前待办，未创建公开 tag 或 Release。

成功晋升后，脚本已清理已核实的临时 NSIS 文件和托管暂存。按四个本轮测试输出目录的确切文件名清理 14 份合成 WebM，共 114,758 B；测试回执、跟踪与编译缓存保留。`npm run clean:outputs` 预演无托管目标，保留未归属的 `.release-work/firefox-final`。`npm run disk:report` 实测 `dist` 2,516,033 B，Rust release 2,368,811,784 B、debug 23,619,795,079 B，均为开发中间目录。前一候选失败时核验 v0.6.1 安装器和 ZIP 原哈希，正式候选通过后才替换。

## Git 交付依据

`origin` 为 `https://github.com/DewMysimple/SRTTools.git`。起始 v0.6.0 主线 `d74e14c7420fad026e5bce14dbbc7b135a22e261`，v0.6.1 草稿分支源码 `ba7c5e97de1c92e3d4f7b5056eaea4c6b8a068da`，v0.6.1 主线里程碑 `e4120ebf74e5eb31244937509087672d1e8cc374`。v0.7.0 分支通过 `a4a43da`、`9f2d724` 交付实现与端点修正。最终 QA 与工程记忆作为构建后文档提交，构建清单保留真实构建源码 SHA。

## 兼容性与复验

- **BLOCKED**，现有测试机只具备 Windows 11 和已装 WebView2、100% DPI。Windows 10、缺少 WebView2 的干净系统、物理 125% / 150% / 200% DPI 与实际系统休眠恢复需要对应环境。可在目标系统对同 SHA 的安装包执行 `scripts/windows-setup-acceptance.ps1 -SetupPath release-output/SRTTools-Setup.exe -ReportPath src-tauri/target/setup-compatibility.json -ExpectedVersion 0.7.0`，再手动缩放和挂起，分别记录真实媒体、窗口和状态恢复。
- **NOT RUN**，实际耗尽磁盘、Windows 超长路径选择器、完整网络共享和受限非管理员矩阵。Rust 回归覆盖注入的权限拒绝与磁盘满，以及真实文件占用、junction 和路径边界。原生测试在此设备已实际强制结束应用后重新启动。
