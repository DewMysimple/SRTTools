# 本地 Windows 发布与清理

项目只在 `release-output/` 交付最新一套产物，文件名固定。该目录由 Git 忽略。Vite `dist/` 和 Rust `src-tauri/target/` 是构建中间目录。

| 路径 | 内容 |
| --- | --- |
| `release-output/SRTTools/` | 解压运行文件，包含主程序及其实际引用的本地 DLL |
| `release-output/SRTTools.zip` | 包含顶层 `SRTTools/` 的同内容 ZIP |
| `release-output/SRTTools-Setup.exe` | Windows x64 NSIS 安装器 |
| `release-output/SHA256SUMS.txt` | 产物和构建清单的 SHA-256 |
| `release-output/build-info.json` | 版本、源码 SHA、源码指纹、工具版本、质量门槛和解压运行验收 |

解压运行依赖 Windows x64 与 Microsoft Edge WebView2 Runtime。安装器配置缺少 WebView2 时下载官方引导程序。实际安装、卸载和干净系统覆盖范围按测试文档记录。

## 构建和验证

在具备 README 所列 Windows 构建环境的 PowerShell 中执行。

```powershell
npm run release:win -- --check
npm run release:win
npm run release:verify
npm run disk:report
```

脚本要求已安装的依赖与 lockfile 一致，npm、Tauri、Cargo 版本一致，并检查真实 Cargo target 位置。共享或自定义 target 不参与本脚本发布和清理。发生版本漂移时先同步版本清单，再重新执行。

正式交付从已提交的源码构建。开发验收可明确使用 `npm run release:win -- --allow-dirty`，构建清单会记录 `dirty: true`。源码指纹覆盖 Git 可见的源码、脚本、配置、锁文件及实际分发的 `docs/THIRD_PARTY_NOTICES.txt`，排除其它 docs、wiki_memory、prompt、README 和根 AGENTS。纯文档交接提交不会使相同源码的产物失效。

构建依次执行 lint、类型检查、发布脚本安全测试、Vitest、前端构建、Windows Rust 测试和 Clippy、Chromium E2E，以及 Tauri NSIS 构建。测试输出放在本次受控暂存目录。

之后复制主程序、本地依赖 DLL 及明确配置的第三方许可文件，生成 ZIP，核对目录、ZIP 数据流和实际解压文件的完整清单、大小及 SHA-256。在解压得到的 EXE 上调用 Windows UI Automation 冒烟，完成真实选择字幕、处理、导出、原字节保护和应用退出。冒烟驱动临时使用的应用设置在结束时恢复。

当前资源白名单只接受 Tauri map `../docs/THIRD_PARTY_NOTICES.txt` → `THIRD_PARTY_NOTICES.txt`，并验证源文件在仓库内、非链接且非空。其它资源或 sidecar 新增到 Tauri 配置后，须先补齐经验证的打包清单。

只有全部通过并确认构建过程中源码指纹没有变化，才将旧发布目录移入本次事务，再晋升新目录。发布前确认旧目录内没有运行中的程序。发布后再次校验，失败时回滚。回滚本身受锁定等原因阻断时，包含旧版本的暂存目录受保护并报告具体恢复位置，后续通用清理也会保留。现有发布目录出现未知文件、目录或哈希变化会阻止替换，供人工核对。构建失败保留上一套成功产物。

`release:verify` 检查清单、ZIP 与目录字节一致、原生冒烟证据、源码 SHA 存在以及当前源码指纹和版本。它复核已记录的冒烟证据。

## 清理等级

```powershell
npm run clean:outputs
npm run clean:outputs -- --apply
npm run clean:release-cache -- --confirm-release-cache
npm run clean:release-cache -- --apply --confirm-release-cache
```

清理默认只预览目标和字节数。成功发布后自动移除本项目 NSIS 输出目录中可识别的版本化安装器，以及带本脚本所有权标记且没有活跃进程的暂存目录。最新发布目录始终保留。遇到锁定文件会报告并跳过。

清理使用 resolve、realpath 和逐级 lstat 验证，只操作项目内白名单路径，拒绝 symlink 与 junction。未知文件和未知暂存目录保持原位并报告。应用设置、预设、历史、用户字幕、源码、文档、示例、Git、依赖目录和用户缓存均不在清理范围。

release 缓存清理需要两个显式开关及一套已验证的发布产物，仅面向确认属于本项目的 `src-tauri/target/release/`。顶层存在未知条目时停止。Windows 上还会检查 Cargo、Rust、链接器进程和该目录中的运行程序，发现占用就跳过。此模式删除编译缓存，下次 release 会重新编译。debug 缓存保留。

脚本构建和实际清理共享排他锁。发现遗留锁时先核对锁记录和进程，避免与其他构建并行。以前的 QA 目录由维护者在保留精简验收摘要后，按准确路径单独核对清理。

## 安全回归

`npm run test:release` 使用隔离的合成产物检查哈希、ZIP、未知文件保护、成功替换、失败保护、路径越界、junction、预览清理和重复清理。CI 同步执行此测试。

人工故障验收可执行 `npm run release:win -- --simulate-failure=before-publish`。该命令在本轮真实构建、解压与冒烟后主动失败，上一套产物应通过 `release:verify`，文件哈希保持一致。此开关会返回失败退出码。
