# v0.4.0 项目收尾与发布候选

状态：收尾验收中。此文按第五阶段任务书记录新的检查，不将第四阶段历史 PASS 当成本轮证据。保持版本0.4.0；不修改字幕引擎、不引入0.5功能。公开Release/tag、项目许可证和代码签名均不在自动执行范围。

## Gate 0：真实基线

2026-11-04核对本地main与实际origin/main均为`baace4072ce9a41141447837a300dc1168360b21`。唯一已有未提交文件是本次用户提供的第五阶段任务书，保留原始内容并作为任务来源提交。仅一个工作树，`git branch --no-merged main`为空；开发分支`28cadeeaf92654f1598dd4f7385811b28fa2a757`已被main包含。没有遗漏开发提交。

初次Git直连github.com两次超时；发现PowerShell已使用本机既有系统代理后，以本次命令的`git -c http.proxy=<既有系统代理>`完成fetch --prune和ls-remote；未修改永久Git配置或系统代理。API同时核对最新主线[baace40 Actions](https://github.com/DewMysimple/SRTTools/actions/runs/41831053607)为completed/success，两个job覆盖前端/Chromium和Windows Rust/Clippy/PS5安全/状态测试；后续本轮源码CI单独记录。

| 文件/入口 | 基线实际版本 | 预期 | 一致 | 收尾动作 |
| --- | --- | --- | --- | --- |
| package.json | 0.4.0 | 0.4.0 | 是 | 无版本号修改；增加check:versions命令 |
| package-lock.json root / packages[""] | 0.4.0 / 0.4.0 | 0.4.0 | 是 | 保留锁文件 |
| src-tauri/tauri.conf.json | 0.4.0 | 0.4.0 | 是 | 保留 |
| src-tauri/Cargo.toml application crate | 0.4.0 | 0.4.0 | 是 | 保留 |
| src-tauri/Cargo.lock application entry | 0.4.0 | 0.4.0 | 是 | 保留 |
| src/pages/Settings.tsx / src/app/App.tsx | 导入package.json版本 | 同源0.4.0 | 是 | 不新增硬编码 |
| README / FEATURES / CHANGELOG | 当前主标题均0.4.0；README尾部残留0.3及“流程尚未开放” | 当前描述0.4.0 | 部分 | 修正文案，保留历史审阅和旧截图 |

网页线索中的npm0.3/Tauri0.4漂移在此同一最新提交上未复现。实际缺口是README尾部、旧界面截图、CI未单独执行版本一致性检查；原Windows发布预检已有部分版本比较，现提取共享检查并补Cargo.lock应用条目和六处漂移回归，CI、发布预检、release:verify复用。

## 本轮执行计划与结果位置

1. 完成最小文档与版本检查、原生收尾场景；版本保持0.4.0，无用户可见业务修复，不升级0.4.1。
2. npm ci后在干净提交运行完整质量门槛、既有性能基准与新的Windows构建；保全上一套成功产物。
3. 对新便携版执行features/folder/closure/工作流，固定Setup执行真实安装/卸载和旧数据恢复；检查目录、ZIP、Unicode、锁和取消重试，Explorer菜单继续默认关闭。
4. 校验唯一release-output、磁盘和白名单清理；填入本轮SHA/指纹/哈希/实测命令，准备发布说明与审批命令。
5. 同步文档/工程记忆，按协议提交推送main，读取实际远端SHA；仅普通文档交接不改变构建指纹。

## 性能复测和第三方声明补齐

`npm ci`实际安装268包/26s，版本检查和17项发布安全测试通过。沿用现有`npm run benchmark`完成两轮，均保持输出等价、真实Worker1017创建/终止及active0/max1；部分耗时较第四阶段偏高，计算bundle SHA与旧轮完全相同，原因未确定，未改业务引擎或编造提速。两轮原始证据及对照见[性能报告](PERFORMANCE_v0.4.0.md)。后续正式构建仍待验。

原随包NOTICE主要覆盖OpenCC、text-encoding和single-instance，遗漏了React/JSZip等声明。本轮保留原文本并追加锁定安装图28个npm包和Windows解析图251个Cargo包的上游许可、精确版本和源代码链接，按完整文本SHA去重，资源现为728,050B。清单包含构建/类型依赖，不宣称所有列项均进入运行时。缺少发布包根许可文件的6个crate，依据各自`.cargo_vcs_info.json`固定commit取上游文本；selectors保留原MPL头及MPL完整文本和对应版本源码下载链接。没有为项目本身选择许可证，也不把依赖清点当作对公开分发的法律结论。正式ZIP与安装版还将核验该资源的实际大小/哈希。

## 公开发布前待决定

仓库API显示description/homepage均为空，项目license=null，未发现项目LICENSE，Releases和tags列表均为空。用户于本轮明确选择“暂不选择，列为公开发布前待决定事项”；不自行添加MIT或Apache授权。依赖声明见[THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES.txt)，须随本地候选继续分发。

仓库description建议草稿：“Windows本地字幕工具箱：组合流程、预设交换、安全目录批量与可视差异（Tauri）”。仅准备文案，未修改远端仓库设置。公开v0.4.0 tag、GitHub Release与附件上传需另行明确批准；代码签名方案及证书同样待用户决定，不自动采购或配置。发布说明见[草稿](RELEASE_NOTES_v0.4.0.md)。

## 尚待写入的本轮证据

本轮干净构建SHA、FP、命令计数/耗时、便携和安装原生结果、六件产物完整字节/SHA、磁盘前后、最新源码CI与最终远端main核对均待实际完成后写入。此处不沿用旧值冒充新结果。
