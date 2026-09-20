---
type: moc
status: active
kind: process
importance: high
updated: 2026-09-20
topic: work-log-index
source_logs: []
supersedes: null
---

# 工作日志 MOC

> 单一工作日志索引，按更新时间倒序。任务类型通过 `kind` 元数据区分。

| 时间 | 类型 | 目标 | 状态 | 主题 | 日志 |
| --- | --- | --- | --- | --- | --- |
| 2026-09-20 | ui | - | archived | explicit-export-controls | [明确格式、时间戳与固定输出栏](./2026-09-20-明确格式时间戳与固定输出栏.md) |
| 2026-09-20 | ui | 减少拥挤，明确文件形式与类型，设置实时预览且导出与预览一致。 | archived | live-preview-export-parity | [2026-09-20｜实时预览与导出一致性](./2026-09-20-实时预览与导出一致性.md) |
| 2026-09-20 | ui | - | archived | document-workspace-redesign | [字幕整理文档式重构](./2026-09-20-字幕整理文档式重构.md) |
| 2026-09-16 | ui | - | archived | srt-composable-workbench | [SRT 综合工作台重设计](./2026-09-16-SRT综合工作台重设计.md) |
| 2026-09-15 | ui | - | archived | unified-text-workbench | [合并文本转换工作台](./2026-09-15-合并文本转换工作台.md) |
| 2026-09-14 | feature | 实现用户四项字幕处理与实用补充能力，建立独立工程、工程记忆、文档和远程管理。 | archived | initial-release | [SRTTools 首版构建](./2026-09-14-SRTTools首版构建.md) |
| 2026-09-14 | bug | 完成首版 GitHub Windows 自动验收，修复英文系统的中文输出失败。 | archived | ci-output-encoding | [CI 中文输出编码修复](./2026-09-14-CI中文输出编码修复.md) |

## 使用方式

- 从仓库根目录执行 `python wiki_memory/工具/memory_lint.py index` 生成或刷新。
- 查询时先阅读当前状态，再按关键词定位日志。
- 历史日志是审计记录，不应直接覆盖当前状态。

## 入口

- [SRTTools 工程记忆](../README.md)
- [记忆维护协议](../AGENTS.md)
- [当前项目概览](../当前状态/项目概览.md)
- [当前系统架构](../当前状态/系统架构.md)
