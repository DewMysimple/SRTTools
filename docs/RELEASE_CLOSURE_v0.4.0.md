# v0.4.0 项目收尾与发布候选

状态：本地项目收尾完成（2026-11-05）。本轮重新执行干净源码构建、回归、原生与安装验收，保持0.4.0，无字幕业务引擎变更。公开tag/Release仍待批准；项目LICENSE按用户明确决定暂不选择，安装包未签名。历史与本轮证据分别署源。

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

`npm ci`实际安装268包/26s，版本检查和17项发布安全测试通过。沿用现有`npm run benchmark`完成两轮，均保持输出等价、真实Worker1017创建/终止及active0/max1；部分耗时较第四阶段偏高，计算bundle SHA与旧轮完全相同，原因未确定，未改业务引擎或编造提速。两轮原始证据及对照见[性能报告](PERFORMANCE_v0.4.0.md)。最终干净构建及原生验收已完成，具体新证据见下文。

原随包NOTICE主要覆盖OpenCC、text-encoding和single-instance，遗漏了React/JSZip等声明。本轮保留原文本并追加锁定安装图28个npm包和Windows解析图251个Cargo包的上游许可、精确版本和源代码链接，按完整文本SHA去重，资源现为728,050B。清单包含构建/类型依赖，不宣称所有列项均进入运行时。缺少发布包根许可文件的6个crate，依据各自`.cargo_vcs_info.json`固定commit取上游文本；selectors保留原MPL头及MPL完整文本和对应版本源码下载链接。没有为项目本身选择许可证，也不把依赖清点当作对公开分发的法律结论。最终ZIP与安装版已核验该资源的实际大小/哈希。

## 公开发布前待决定

仓库API显示description/homepage均为空，项目license=null，未发现项目LICENSE，Releases和tags列表均为空。用户于本轮明确选择“暂不选择，列为公开发布前待决定事项”；不自行添加MIT或Apache授权。依赖声明见[THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES.txt)，须随本地候选继续分发。

仓库description建议草稿：“Windows本地字幕工具箱：组合流程、预设交换、安全目录批量与可视差异（Tauri）”。仅准备文案，未修改远端仓库设置。公开v0.4.0 tag、GitHub Release与附件上传需另行明确批准；代码签名方案及证书同样待用户决定，不自动采购或配置。发布说明见[草稿](RELEASE_NOTES_v0.4.0.md)。

## Gate 1–4：本轮最终候选和实测

干净main源码`e6bcd1842a1b710b670eb009a7ce5c5804f79269`，dirty=false，源码指纹`73274261537860C42BA866961A31CC757EE180012057FF52129116DE3E5CA201`，构建时间`2026-11-05T02:10:51.117Z`。所有app版本仍为0.4.0；无用户可见业务修复，故不升级0.4.1。`src/core`、`src/workers`、`src/services`及原生字幕/文件业务未修改。构建文件大小的增加来自上游许可资源，非新增业务引擎。

`npm ci`在版本/脚本修正后实际执行：268包/26s；之后npm依赖声明与lock未变，正式预检再次执行npm ls及Cargo --locked元数据。当前[源码CI](https://github.com/DewMysimple/SRTTools/actions/runs/41953024037)的前端/Chromium与Windows Rust两个job均实际success；前端新增check:versions，Windows新增真实PS5解析/BOM门槛。不会把旧baace40的绿色结果当作本轮结果。

最终`npm run release:win` PASS，221.362s，`2026-11-05T02:07:31.8969518Z`至`2026-11-05T02:11:13.2580990Z`；`npm run release:win -- --check`、`npm run check:versions`与构建后`npm run release:verify`均PASS。实际17发布安全、311 Vitest（21files）、42 Rust、72 Chromium、真实PS5解析20文件、安全10/状态12及Clippy均通过。下表为构建清单记录的命令墙钟毫秒，Chromium自身耗时见日志；未把各类检查合并成虚构测试总数。

| 实际命令 | 结果 | elapsedMs |
| --- | --- | ---: |
| `npm run lint` | PASS | 3298 |
| `npm run typecheck` | PASS | 2571 |
| `npm run test:release` | PASS | 2874 |
| `npm run test` | PASS | 3089 |
| `npm run build` | PASS | 3443 |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml` | PASS | 11829 |
| `cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` | PASS | 2780 |
| `pwsh -NoLogo -NoProfile -File scripts/check-windows-scripts.ps1` | PASS | 522 |
| `pwsh -NoLogo -NoProfile -File scripts/windows-qa-safety.test.ps1` | PASS | 4247 |
| `pwsh -NoLogo -NoProfile -File scripts/windows-state-protection.test.ps1` | PASS | 2411 |
| `npm run test:e2e` | PASS | 日志单列 |
| `npm run tauri -- build` | PASS | 74370 |

Vite主chunk仍约511.43kB并保留超过500kB提示；MSVC库创建提示未隐藏，Clippy严格-D warnings通过。大批量内存/耗时和未归因波动参见[本轮两次基准](PERFORMANCE_v0.4.0.md)，独立Worker OS峰值NOT_MEASURED，未宣称绝对性能无退化。

### 新便携版与固定Setup真实Windows验收

全部针对上述新候选，使用pwsh→Windows PowerShell5.1链路与真实UIA/系统对话框；不以Playwright模拟Tauri代替。先验证构建中ZIP解压EXE的10流程与平铺输出，再对固定便携EXE运行下列场景，最后安装固定Setup。

| 场景 | 结果 | elapsedMs | 范围/报告（target下） |
| --- | --- | ---: | --- |
| native-smoke | PASS | 4351 | 启动/选择/预览/另存为/原字节；`closure-final-native-smoke.json` |
| native-features | PASS | 12040 | 7项真实feature检查；`closure-final-native-features-retry1.json` |
| native-folder | PASS | 24152 | 13项真实feature检查；`closure-final-native-folder.json` |
| native-closure | PASS | 11122 | 3项真实feature检查；`closure-final-native-closure.json` |
| setup | PASS | 24015 | 19项总检查+10流程；`closure-final-setup-retry1.json` |

覆盖单文件选择、编码确认、GBK/GB18030严格拒绝、简繁源布局、预览和另存为、真实物理单/多文件拖放；文件夹递归/过滤/Unicode/锁定/权限/深度/数量/取消与重试；组合流程保存/重启/原生JSON/坏JSON保旧值；层级/平铺、多根重名、源重叠拒绝、写入失败只重试未完成项及真实目录/ZIP字节。流程的SRT/VTT/ASS/SSA有损组合许可边界及Worker超时/异常/清理另由全量Vitest/Chromium覆盖，未声称每一种边界都做了系统UIA。

Setup19项与子流程10项全部true，安装/启动/处理/实际导出/卸载通过。既有设置、旧工具和流程预设在操作前后及重启后由App实际读取，应用后字段为123；本次四步导出使用500ms，未冒称为旧123预设另外导出字节。真实Store与七个专属注册树值、Owner/Group/DACL已恢复，无残留app/安装登记/备份/测试目录；不声称SACL覆盖。安装EXE SHA-256=`A80FF234C03AAA43ACF08D3B627C92C282255E7E25733FF47265E8AA7BAA3F44`，独立于下表portable EXE哈希记录。随包NOTICE实际资源校验通过，SHA=`A17EA3B35FF06CEC85022E4034F85F2061505E68D5D18306B2B1EC0B257E7780`。

## 真实失败和修复记录

- 4627725首轮完整质量门槛后在新增平铺UIA提前失败：断言写了(1)，而同批规划重名现有规则为(2)；四文件已安全写完，只是预期文件名错误。旧六件逐项哈希不变。修正测试，未修改命名算法。
- c3f7e3f在完整质量/构建/ZIP解压原生10项及平铺检查之后实际到达before-publish故障点，按预期exit1（252.103s）；旧28cadee六件及manifest原始Buffer逐字节相同，旧产物完整性verifyRelease PASS。旧源码产物与新源码FP不同，不伪称当时当前源码release:verify通过。
- 同源c3f7e3f随后成功晋升（252.078s），但新增closure场景在PS5读无BOM的非ASCII脚本时解析失败。独立开发复核还定位夹具契约、重启后首页与工具列表导航竞争、ComboBox尚未就绪，以及Explorer可见区域坐标/根窗口问题。各失败均有报告，Store恢复/退出/清理通过，不改写为PASS。
- 最终e6bcd18修正UTF-8 BOM、等待真实目标页面和可用UIA模式、显式恢复并核对自有Explorer根窗口/可见点击点；保留严格拥有窗口检查，不点击被遮挡的未知窗口。夹具区分匹配/不匹配内容，完整输出字节断言保留。新增真实PS5 Desktop20文件解析和非ASCII-BOM检查，CI/发布复用。后续开发probe7完整3项通过只是驱动复核；正式结果以本节最终候选的新报告为准。
- 最终源码与c3f7e3f之间未改晋升/回滚/清理事务，新增的是QA修正和前置解析门槛；本轮不重复已经实际完成的同事务故障注入，不把它改署最终SHA。最终源码重新执行全部质量门槛、真实构建与全部原生/Setup验收。
- 最终e6bcd18额外原生features首轮未观察到GBK下拉选项，固定Setup首轮的installed-native-smoke子进程也曾非零退出；外层均已恢复用户状态。没有改动源码/产物，保持独占桌面分别重试后，features7项及Setup19+10项均PASS。前者确切原因未确认，后者内层细节未被旧外层报告保留，不能编造根因。两次失败的报告和summary-attempt1/2原样保留；最终表格引用有通过证据的同源重试，不声称所有尝试都通过。这也表明UIA验收需独占桌面，尚存在自动化稳定性限制。

## Gate 4：唯一当前交付物

固定根`E:\Software Development\SRTTool\release-output`，只有下列六文件，共9,629,542B。`SRTTools.zip`包含顶层SRTTools/及同一EXE/NOTICE；大小、哈希、ZIP流与解压字节一致，未放入测试数据/缓存/旧版本目录。

| 相对路径 | 字节 | SHA-256 |
| --- | ---: | --- |
| `build-info.json` | 4,420 | `94947C34A6E21A68E1CF6A4327108D4B1FE1BCF0C9484F03010EEFFCE4D0D6E4` |
| `SHA256SUMS.txt` | 439 | `5CB876963D44835024CD2D12F7D4CD8368D4E6BBBD7F3193FBE67E3B98DDA27C` |
| `SRTTools-Setup.exe` | 2,066,718 | `4952200C7EA1060EC8DE74E25C8838D1419DF4E61AE2ABDD97293DF116E62B2B` |
| `SRTTools.zip` | 2,383,707 | `07E24C5176ADF7645063EA1EB780795C8A9D42E780B73786D6317DD0A9F8441A` |
| `SRTTools/subtitle-tools.exe` | 4,446,208 | `DC6A5694E22FD0808454B1F023E8B9FAB9663CC2C41C63B6CB83F376680BFC9E` |
| `SRTTools/THIRD_PARTY_NOTICES.txt` | 728,050 | `A17EA3B35FF06CEC85022E4034F85F2061505E68D5D18306B2B1EC0B257E7780` |

EXE和Setup的Authenticode实际状态均为NotSigned。构建清单记录正式源码与FP；SHA256SUMS覆盖另外五件，自身摘要由上表给出。最终普通文档交接后再次release:verify确认FP匹配，不手工改manifest。

白名单清理先执行`npm run clean:outputs`预览，再执行`npm run clean:outputs -- --apply`；实际结果保留于target/closure-cleanup-plan.json和closure-cleanup-result.json。成功构建自动清理可识别NSIS中间包和本次staging；最终未累积旧成功套件。默认保留Rust增量缓存、node_modules、Git历史及用户数据。下表是本轮实际disk:report前后记录，不把缓存增长伪装为清理下降。

| 路径 | 收尾开始字节 | 收尾完成字节 | 完成文件数 |
| --- | ---: | ---: | ---: |
| `release-output` | 8773460 | 9629542 | 6 |
| `dist` | 2337105 | 2337105 | 9 |
| `src-tauri/target/release` | 2111513240 | 2112284493 | 3750 |
| `src-tauri/target/debug` | 13644677432 | 13645258869 | 13424 |
| `src-tauri/target/benchmark` | 0 | 0 | 0 |
| `test-results` | 300276 | 300276 | 16 |
| `playwright-report` | 0 | 0 | 0 |
| `.release-work` | 279726 | 279726 | 15 |

此前自动审批拒绝的旧target/smoke、.release-work/firefox-final和根test-results仍保持原位，不换工具重试，不进入release-output。仅保留本轮精简日志、JSON、许可来源和基准记录；没有默认删除第三方/编译缓存。

## Gate 6：主线与交接

基线main=`baace4072ce9a41141447837a300dc1168360b21`；阶段提交cd31c6e（共享版本门槛/收尾文档截图）、4627725（依赖声明/复测）、c3f7e3f（平铺断言修正）、最终已验源码`e6bcd1842a1b710b670eb009a7ce5c5804f79269`（PS5/原生驱动修正）。各提交正常推送main并读取实际远端SHA，无强推、删历史、删除用户分支或新建大型功能分支。全部v0.4开发分支均已被main包含。

最终普通文档/工程记忆交接不改变产品FP；其实际最终main完整SHA与主线当前提交CI状态由交付时git ls-remote、GitHub Actions再次核对，并在最终答复给出，不在本提交内伪造自引用SHA。公开Release/tag、项目LICENSE及签名决定保留给用户；本轮没有创建这些外部发布对象。

工程记忆按协议统一执行一次`python wiki_memory/工具/memory.py index --project . --apply`及普通`check --project .`，均退出0；未扩展运行初始化/迁移专用的`--require-ready`。随后共享版本检查和`npm run release:verify`再次通过，普通文档/记忆修改未改变候选指纹。

本轮证据入口：target/closure-delivery-final.json、closure-final-success-result.json、closure-final-native-summary.json、closure-final-setup-retry1.json、closure-e6bcd18-ci.json、closure-release-expected-fault-result.json、closure-signatures.json及对应日志。基线和首次失败另存，不用旧报告覆盖本轮事实。

## 兼容性未验收矩阵与人工步骤

本机为Windows11 Pro25H2 26200.9711、x64、96DPI/100%、WebView2 156.0.4314.58。浏览器900×620/1200×800浅深主题测试不等于真实Windows缩放测试。

| 场景 | 状态 | 在独立测试环境执行的方法 |
| --- | --- | --- |
| Windows10 x64 | NOT_RUN：没有对应可交互系统 | 记录系统/Runtime版本和候选哈希；安装并启动，导入SRT/VTT/ASS/SSA，运行四步流程和简繁，分别另存为/ZIP/目录，核对源SHA，退出重启读预设，卸载并核对设置保留 |
| 125%/150%/200% DPI | NOT_RUN：没有对应原生缩放验收 | 在测试机设置该缩放后重启应用；分别检查900×620及常用窗口、浅/深主题、参数长文本、原生选择器、键盘焦点和差异分页，逐项实际导出并截图记录 |
| 干净系统无WebView2 | NOT_RUN：没有干净VM | 从独立VM快照确认未装Runtime，分别联网和断网运行Setup与便携版；记录引导安装/明确失败、回滚和用户数据状态；Runtime就绪后再执行完整单文件/流程与卸载 |
| 超MAX_PATH系统选择器 | NOT_RUN：没有覆盖该入口的交互证据 | 在支持长路径的独立测试机创建中文/emoji及超过260字符的完整路径；分别原生选择文件、递归文件夹、独立目录输出/ZIP，记录拒绝或成功及诊断、完整路径、字节与源SHA；Rust路径单测不能替代这些选择器步骤 |
| Explorer实际菜单显示/点击 | BLOCKED：历史本机菜单未显示；本轮保持默认关闭，未开启复测 | 维护者以后明确安排专项时，在独立用户环境通过应用显式启用，核对HKCU专属owner/path和真实传统菜单的冷/暖选择；实际点击后检查队列。登记成功不记菜单可用。本轮物理拖放另列证据 |
| 代码签名 | UNSIGNED / 待用户决定 | 维护者选定方案并提供受控证书后，对最终EXE/Setup签名，验证签名链/发布者/时间戳；若字节改变，重新构建验收与计算清单，不能沿用当前哈希 |
| 独立Worker OS峰值 | NOT_MEASURED | 在独立进程采样环境同步记录renderer/worker/原生进程RSS与峰值及采样方法；当前Node阶段采样和页面heap不能替代 |

后续优先级：先确认项目LICENSE和公开发布意图；再处理受控性能复测及Win10/DPI/干净WebView2矩阵；Explorer菜单、签名和自动更新各自作为单独专项，不加入本轮新功能。

## 对外发布操作草稿（未执行）

当前只准备本地候选和此文案。项目LICENSE暂不选择是用户本轮明确决定；公开tag、Release及附件上传仍需用户另行批准。仓库description建议已列在Gate0审计中，尚未修改远端设置。若后续LICENSE/签名或资源变化，先重新构建/验收，批准对象应是届时的最终main及真实产物。

以下命令仅为维护者审批后的执行草稿；需要先安装并登录GitHub CLI。未授权时不运行任何创建/推送tag或Release命令。

```powershell
# 仅在用户明确批准对外发布并处理项目LICENSE决定后执行。
git fetch origin
$approvedSha = '<经用户批准且与产物指纹一致的最终main完整SHA>'
git rev-parse origin/main
npm run check:versions
npm run release:verify
# 确认上面的main SHA和批准对象一致；若已有同名tag，停止并保留。
git ls-remote origin refs/tags/v0.4.0
git tag -a v0.4.0 $approvedSha -m 'Subtitle Tools v0.4.0'
git push origin refs/tags/v0.4.0
gh release create v0.4.0 --draft --target $approvedSha --title 'Subtitle Tools v0.4.0' --notes-file docs/RELEASE_NOTES_v0.4.0.md
gh release upload v0.4.0 release-output/SRTTools-Setup.exe release-output/SRTTools.zip release-output/SHA256SUMS.txt release-output/build-info.json
# 下载草稿附件重新核对SHA-256，确认后再单独批准公开发布。
```

此草稿没有自动公开的最后一步；不把“草稿准备完成”写成已发布。
