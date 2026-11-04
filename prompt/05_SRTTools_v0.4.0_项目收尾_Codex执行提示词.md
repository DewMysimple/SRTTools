# SRTTools v0.4.0 — 四阶段完成后的项目收尾、质量封版与发布准备

> 面向 Codex 的可执行指令。目的不是进入 v0.5.0，不是新增字幕工具，而是在已有四阶段开发成果上完成 **主线同步、版本统一、质量复核、Windows 原生验收、发布产物确认、文档交接**。
>
> 仓库：`https://github.com/DewMysimple/SRTTools`；目标：以实际最新 `origin/main` 为准。默认不创建新的大型功能分支，不改写 Git 历史。
>
> 本文编写时的公开资料线索（2026-11-04）：`docs/REVIEW_v0.4.0_RELEASE.md` 记录了 v0.4.0 的组合流程、预设交换、文件夹批量、性能改进、Windows 安装包验收与 `main` 交付；`docs/CHANGELOG.md` 也记录 v0.4.0。但网页所示 `package.json`、`README.md`、`docs/FEATURES.md` 仍显示 0.3.0，`src-tauri/tauri.conf.json` 与 `src-tauri/Cargo.toml` 显示 0.4.0。**必须在同一最新提交上亲自核验，不能不加检查地照搬这些结论。**

---

## 0. 总执行约束

你是一名资深 Tauri/Windows、React/TypeScript、Rust 工程师与发布负责人。请直接检查仓库、制定简要计划并执行本收尾任务，不要只输出规划。以 `AGENTS.md`、`wiki_memory/AGENTS.md`、`wiki_memory/README.md`、`docs/RELEASE_POLICY.md` 和仓库现有测试要求为先，不覆盖已有合规机制。

**禁止事项：**
- 不做 v0.5.0 的新增功能，不重构现有稳定业务引擎，不加入视频、时间轴和 AI。
- 不强推、不改写历史、不随意删除任何源码、工作树修改、用户字幕文件、用户设置、第三方缓存和发布成功的产物。
- 不用更改文档来伪造 `PASS`。所有验收结论都必须记录实际命令、环境、结果和失败原因。
- 不为了提高测试计数虚构测试，不将浏览器模拟测试等同于真实 Windows 系统验收。
- 不擅自创建公开 GitHub Release、推送正式发布 tag 或替用户做“对外发布”的决定；可准备 release draft / 命令和变更说明，明确停在用户批准的节点。
- 不因发布准备而引入新的自动更新、注册表扩权或危险安装选项。

**完成标准：** 能明确回答“当前 `main` 上的是不是一致、可构建、可安装、可回滚、可分发的 v0.4.0”，提供可查证证据、最新唯一一套 `release-output/` 产物与未完成兼容性事项。

## Gate 0 — 工作区和主线真实性审计（必须先做）

1. 执行 `git status --short --branch`、`git remote -v`、`git fetch --prune origin`、`git log -n 15 --oneline --decorate`。
2. 核对当前分支与 `origin/main`；检查是否还有未合并的 v0.4.0 代码提交、只在其他工作树或分支上的开发内容。
3. 如果本地存在未提交修改，不得覆盖。优先保留并向用户解释冲突，或创建安全工作树/备份方案；不使用 `git reset --hard`、`git clean -fdx`。
4. 阅读 `docs/REVIEW_v0.4.0_RELEASE.md`、`docs/CHANGELOG.md`、`docs/TESTING.md`、`docs/RELEASE_POLICY.md`、`README.md`、`docs/FEATURES.md`、`package.json`、`package-lock.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`。
5. 制作基线表：**文件/实际版本/预期版本/是否一致/修复动作**。不要相信历史报告替代当前 `HEAD`。
6. 检查 GitHub Actions 当前主线最后一次实际运行状态、工作流覆盖范围；如果只是旧提交的绿色 CI，不能称为当前提交通过。

**Gate 0 退出条件：** 确认真实 `HEAD`、未合并内容、版本漂移、现有构建/测试脚本、发布目录规则后才开始修改。

## Gate 1 — 版本与文档统一（P0）

1. 以最终确认的产品版本为准。如果当前主线确实已经具备 v0.4.0 全部功能与质量门槛，优先保持 `0.4.0` 而非无故升级 `0.5.0`；如果修复涉及真实兼容性或用户可见问题，评估是否应使用 `0.4.1`，并记录决定。
2. 检查并统一：
   - `package.json` 与 `package-lock.json` 的根包版本。
   - `src-tauri/tauri.conf.json` 的版本。
   - `src-tauri/Cargo.toml` 的 application crate 版本以及 `src-tauri/Cargo.lock` 中对应条目。
   - 应用「关于」显示的版本（如果由这些文件自动读取，不要另建重复硬编码）。
   - `README.md`、`docs/FEATURES.md`、`docs/CHANGELOG.md`、其他存在“当前版本为 0.3.0”的活跃文档。
3. 历史阶段审阅文档中的 0.3.0 属于**历史事实**，不要机械批量替换；仅更新当前版本描述。
4. 研究并增加小型的 **版本一致性检查**（复用现有发布脚本检查或追加脚本和测试），在日后 CI / 发布前阻止版本漂移。避免引入新的复杂版本管理基础设施。
5. README 需用普通用户能理解的语言说明 v0.4.0 主要功能：组合流程、预设导入导出、目录批量、安全导出、可视化对比；明确该工具**不包含视频时间轴**。
6. 明确实验性 Explorer 菜单仍默认关闭、Win10 和不同 DPI 等未覆盖状态以及安装包签名状况，不把它们写成已经兼容。

**Gate 1 退出条件：** 同一个提交上所有可执行版本清单一致，文档与当前实际实现相符，版本一致性检查通过。

## Gate 2 — 回归与质量封版（P0）

运行仓库实际存在且适用的完整检查，至少包括：

```powershell
npm ci
npm run lint
npm run typecheck
npm test
npm run build
npm run test:e2e
npm run test:release
cargo test --locked --manifest-path src-tauri/Cargo.toml
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

- 版本修复后需要重新运行全部关键检查，不可使用改动前的通过结果代替。
- 回归 v0.4.0 四大功能闭环：线性组合流程、预设 JSON 交换与迁移、文件夹输出树与避让、Worker 性能/超时与取消。
- 覆盖 SRT/VTT/ASS/SSA 组合操作需要明确规范化许可的边界；简繁独立处理保持样式和换行；GBK/GB18030 严格编码拒绝不可往返字符；取消/重试后的成功输出仍保持安全。
- 对失败文件要保持逐项隔离；不能因为某个条目失败导致误覆盖已有文件。
- 不为追求所有环境 100% PASS 删除或跳过有意义的测试。不可运行的系统环境明确写成 `NOT_RUN`/`BLOCKED` 并说明验证方法。
- 追踪构建文件大小、基础启动和大批量任务的内存/耗时；仅回归严重退化，不要求重新设计性能引擎。仓库已有性能基准时复用，不另造不一致基准。

**Gate 2 退出条件：** 关键检查全 PASS，或明确列出阻塞和对应复现步骤；有阻塞则不能继续“正式发布”操作。

## Gate 3 — Windows 原生发行验收（P0）

在可交互 Windows 环境，针对**当前提交的新构建**：

1. 测试单文件选择、拖放、编码确认、预览、处理、另存为、原文件字节保护。
2. 测试多文件与文件夹导入、递归筛选、重名避让、层级/平铺输出、ZIP 导出、取消/重试。
3. 测试组合流程保存、重启恢复、导入导出 JSON 和旧预设兼容。
4. 测试不同输出目录、Unicode 文件名/中文路径、目录不可写、文件占用和输出目录冲突。
5. 运行便携 ZIP 解压后的真实启动/导入/处理/导出冒烟。
6. 运行 NSIS 实际安装、启动、处理、卸载与设置恢复（优先复用现有 `scripts/windows-smoke.ps1` 和已有 QA 脚本）。
7. 已知的 Explorer 右键菜单实际“显示/点击”受环境阻塞时，**不为此次收尾强行开启**；维持默认关闭并记录。若用户希望以后正式支持，列入后续专项。
8. Win10、125%/150%/200% DPI、干净系统无 WebView2、超长路径若无可交互环境，不得声明测试通过。给出真实未验收矩阵和用户可执行的人工步骤。
9. 代码签名缺失应清楚写入发布限制。不得声称“签名通过”或自动下载不明证书。

**Gate 3 退出条件：** 当前构建的 ZIP 与安装版能够完成主工作流；不支持的环境或实验功能有透明的限制说明。

## Gate 4 — 唯一最终发布目录与空间卫生（P0）

继续沿用项目已经实现的 `release-output/` 规则，**不要更名为 `dist/`、不要另建多套发布目录**。预期结构：

```text
release-output/
├── SRTTools/
│   ├── subtitle-tools.exe
│   └── ...运行所需文件
├── SRTTools.zip
├── SRTTools-Setup.exe
├── SHA256SUMS.txt
└── build-info.json
```

在有真实 Windows 构建环境、干净源码提交和全部质量门槛通过的前提下执行：

```powershell
npm run release:win -- --check
npm run release:win
npm run release:verify
npm run disk:report
```

- 仅新候选构建、验证、原生冒烟全部通过后，才晋升为当前唯一正式产物。
- 构建失败必须保留上一次验证成功的发布目录，不得出现“失败后无可用发布包”。
- 不在 `release-output/` 下累计 `0.1`/`0.2`/`0.3`/`0.4` 历史目录或重复 ZIP。
- 沿用 `SHA256SUMS.txt` 和 `build-info.json` 记录源码 SHA、版本、清单与校验结果。
- 沿用现有安全清理脚本：默认 dry-run；只有检查允许的白名单后，才 `npm run clean:outputs -- --apply`。
- Rust release 缓存清理遵循仓库现有双确认和目标归属规则。保留默认增量缓存，并在磁盘确有压力时再选择低占用模式。
- **绝不**删除源代码、Git 历史、node_modules、用户设置/历史/字幕、未知文件、共享 Cargo target、junction/symlink 或上次成功发布的保护副本。
- 不为追求“完全无旧文件”清空开发环境：清理应优先保证可恢复、可复现和不会误伤。

**Gate 4 退出条件：** `release-output/` 只包含最新一套完整可验证产物，旧受控中间产物按白名单清理，结果和磁盘占用有记录。

## Gate 5 — 对外发布准备（不自动公开发布）

1. 核对仓库主页 description、README、截图/演示、受支持平台、许可证与第三方依赖声明；如果仓库尚无明确项目 LICENSE，提出选项并由用户决定，**不要自行选择法律授权方式**。
2. 生成面向普通用户的简短 `v0.4.0` 发布说明：核心能力、新功能、兼容性、下载方式、已知限制、文件默认不上传。
3. 把发布候选对应的 Git SHA、构建指纹、运行环境、校验值、检查结论、未执行矩阵整理为 `docs/RELEASE_CLOSURE_v0.4.0.md`。
4. 现有 GitHub Releases 页面若尚未发布版本，应把“准备创建 `v0.4.0` tag / GitHub Release / 上传 Setup 与 ZIP”列成明确待用户批准事项。
5. 如果用户确认要对外发布，后续按安全流程：基于最终 `main` 的经过验证的提交创建标签、推送标签、创建 Release 并上传经验证文件，复查附件哈希；无确认则仅生成草稿和命令。
6. 记录未来可能开展的专项（Explorer 菜单、Win10 兼容、DPI、干净 WebView2 机器、代码签名、自动更新），不把它们塞入本轮“必须实现”的新功能。

**Gate 5 退出条件：** 用户可以凭 README、发布说明和验证报告独立安装使用，并清楚知道仍有哪些限制。

## Gate 6 — Git 主线交付与最终报告

1. 收尾修改应为小范围修复，不要混入功能大改。合理拆分 `fix/chore/docs/test` 提交。
2. 在提交前再检查 `git diff --check`、工作树和全部关键质量门槛。
3. 按仓库现有协作约定将必要修复合并/推送到 `main`；不得强推或删除用户分支。若无法推送，报告阻碍和精确下一步。
4. 根据 `AGENTS.md` 与 `wiki_memory/` 的协议记录有效的工程交接信息，避免写入重复、缺证据的状态。
5. 再次验证实际远端 `origin/main` 提交与本地记录一致。发布构建的 SHA 和最新版源码应能够关联；仅普通文档交接提交不改动发布指纹时，遵循现有校验策略。
6. 最终回答须包含以下小节：
   - 基线 SHA / 交付 SHA / 版本清单核对结果。
   - 发现并修复的问题及文件位置。
   - 实际执行命令和结果（PASS/FAIL/NOT_RUN/BLOCKED），区分浏览器/原生。
   - 最新 `release-output/` 文件清单、大小、SHA-256，是否保持仅一套。
   - 仍需用户审批的正式 GitHub Release/tag 和签名决定。
   - 遗留风险与下一次维护优先级。

## 收尾总验收表

- [ ] `main` 已经包括全部 v0.4.0 开发内容，没有遗漏分支。
- [ ] npm、Cargo、Tauri、About 当前版本统一且 lockfile 一致。
- [ ] README、FEATURES、CHANGELOG 均准确反映 v0.4.0 当前能力。
- [ ] 无新增重复功能，且旧预设和用户设置不丢失。
- [ ] lint、typecheck、Vitest、Playwright、Rust test、Clippy、发布安全测试达到原有质量门槛。
- [ ] ZIP 的真实运行流程与 NSIS 真实安装/卸载在可用 Windows 环境完成。
- [ ] 只保留一套最新 `release-output/`；失败回滚和安全清理仍成立。
- [ ] 未覆盖兼容性场景透明列出，Explorer 实验入口默认关闭。
- [ ] 发布说明与验收报告完成，公开 tag/Release 操作有用户确认。
- [ ] 收尾提交安全地到达 `main`，没有强推、清库或误删用户资料。

**现在开始：先核对实际 `origin/main` 并逐文件查明“v0.3.0/v0.4.0”版本差异，再执行最小必要修复与验收。不要把旧的 v0.4.0 记录当成当前提交的测试结果。**
