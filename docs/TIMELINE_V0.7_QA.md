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

正式 ZIP、Setup、产物哈希及兼容范围待候选发布事务完成后核对。
