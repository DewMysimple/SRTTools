# SRTTools 工程记忆维护协议

本协议把「原始事实」「当前结论」「历史审计」分开，采用用户指定的工程记忆构建理论架构。源码、测试和用户要求为事实来源，Markdown 记忆是可更新的导航层。本文件是程序性约定。

## 读取顺序

先读本文件，再读当前状态的项目概览、系统架构、当前约束和当前待办。之后按任务读取有效决策、知识和已知问题；需追溯时才读取最近 1–3 篇日志。启动上下文尽量不超过约 6,000 tokens。

## 写入规则

- 当前状态保存现在有效的事实；决策保存影响未来的取舍；知识保存稳定的模块和流程；日志记录每轮任务。
- 用户明确要求及已验证实现事实可直接记录为 active；本次已授权建立工程与记忆，无须重复索取同一授权。新需求、未证实判断或重大新方向先记录 proposed，明确依据与待确认条件。
- 每个长期主题只有一个 active 版本。变化时更新当前页；旧决策保留并标记 superseded/deprecated，新页记录 supersedes。
- 任务日志先 draft，填入实际验证后才 archived；封存后用新日志更正，不回写历史。
- 不记完整聊天、隐藏推理、凭据、用户内容或私人绝对路径。只记录必要结论，附仓库相对源码、测试或来源链接。
- 长期页面填写 source_logs。元数据必须包含 type、status、kind、importance、updated、topic、source_logs、supersedes。

## 页面和任务类型

类型：state、decision、knowledge、log、moc。状态：active、proposed、deprecated、superseded、archived；工作中日志可用 draft。日志 kind：feature、ui、bug、discussion、test、maintenance；长期页另可用 architecture、process、module、operations。importance 为 high/medium/low，updated 使用真实日期。

模板位于模板目录。正文使用普通 Markdown 相对链接以便 GitHub 阅读，source_logs 也支持根相对 wiki 链接。路径统一使用正斜线。

## 固定操作与收尾

1. 记忆同步：每轮实质任务创建日志，更新受影响的已确认事实；新的长期候选单独列出。
2. 记忆检索：当前状态 → 主题知识/决策 → 单一日志索引。
3. 记忆体检：运行 `python wiki_memory/工具/memory_lint.py index` 和 `check`。
4. 记忆压缩：将重复结论归纳到长期页，保留来源关系和原日志，不批量删除历史。
5. 验证、打包、显式暂存、提交、推送，再核对远端哈希。日志不得在推送前声称推送成功；最终答复报告核验结果。
