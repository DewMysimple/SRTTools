import * as fs from 'node:fs/promises';
import path from 'node:path';
import { PROJECT_ROOT, controlledPath } from './release-common.mjs';
import { benchmarkPath, benchmarkVersion } from './benchmark-paths.mjs';

if (process.argv.length > 2) throw new Error('Benchmark report takes no path arguments.');
async function load(name) {
  const file = await controlledPath(PROJECT_ROOT, benchmarkPath(name));
  return JSON.parse(await fs.readFile(file, 'utf8'));
}
const [baseline, current, before, browser] = await Promise.all([load('baseline'), load('current'), load('pre_optimization'), load('browser')]);
const result = (report, id) => {
  const found = report.results.find(item => item.id === id);
  if (!found) throw new Error(`Missing performance case ${id}.`);
  return found;
};
for (const previous of baseline.results) {
  if (result(current, previous.id).outputSha256 !== previous.outputSha256) throw new Error(`Baseline output byte regression: ${previous.id}`);
}
const beforeWrap = result(before, 'single-wrap-long-line');
const afterWrap = result(current, 'single-wrap-long-line');
if (beforeWrap.outputSha256 !== afterWrap.outputSha256) throw new Error('Long-line optimization changed output bytes.');
const fixed = value => Number(value).toFixed(2);
const range = value => `${fixed(value.median)} (${fixed(value.min)}–${fixed(value.max)})`;
const pct = (old, next) => `${((next / old - 1) * 100).toFixed(1)}%`;
const mib = value => fixed(value / 1024 / 1024);
const sizes = [100, 1000, 10000, 50000];
const regression = sizes.map(count => {
  const previous = result(baseline, `single-${count}`), next = result(current, `single-${count}`);
  return `| ${count.toLocaleString('en-US')} | ${range(previous.totalMs)} | ${range(next.totalMs)} | ${pct(previous.totalMs.median, next.totalMs.median)} |`;
}).join('\n');
const flows = sizes.map(count => {
  const oldSerial = result(baseline, `serial-three-${count}`), serial = result(current, `serial-three-${count}`), flow = result(current, `workflow-three-${count}`);
  return `| ${count.toLocaleString('en-US')} | ${fixed(oldSerial.totalMs.median)} | ${fixed(serial.totalMs.median)} | ${range(flow.totalMs)} |`;
}).join('\n');
const batches = [10, 50, 100].map(count => `| ${count} × 1,000 | ${fixed(result(baseline, `batch-serial-three-${count}`).totalMs.median)} | ${fixed(result(current, `batch-serial-three-${count}`).totalMs.median)} | ${range(result(current, `batch-workflow-three-${count}`).totalMs)} |`).join('\n');
const stageRows = ['decode', 'parse', 'transform', 'serialize', 'encode'].map(stage => `| ${stage} | ${range(result(current, 'serial-three-1000').stagesMs[stage])} | ${range(result(current, 'workflow-three-1000').stagesMs[stage])} |`).join('\n');
const complex = ['workflow-utf16le-1000', 'workflow-gb18030-1000', 'workflow-ass-chinese-1000'].map(id => {
  const item = result(current, id); return `| ${id} | ${item.inputBytes} | ${item.outputBytes} | ${range(item.totalMs)} |`;
}).join('\n');
const browserRows = browser.results.map(item => `| ${item.id} | ${range(item.elapsedMs)} | ${item.retainedHeapDeltaBytes ? fixed(item.retainedHeapDeltaBytes.median / 1024) : 'NOT_MEASURED'} |`).join('\n');
const ioRows = (current.ioMeasurements ?? []).map(item => `| ${item.cueCount.toLocaleString('en-US')} | ${item.inputBytes} | ${range(item.readMs)} | ${range(item.writeAndSyncMs)} |`).join('\n');
const slow = sizes.filter(count => result(current, `single-${count}`).totalMs.median > result(baseline, `single-${count}`).totalMs.median * 1.2);
const memoryRows = sizes.map(count => {
  const item = result(current, `workflow-three-${count}`);
  return `| ${count.toLocaleString('en-US')} | ${mib(item.inputBytes)} | ${mib(item.memory.sampledHeapMaxBytes)} | ${mib(item.memory.rssAfterBytes.median)} |`;
}).join('\n');

const output = await controlledPath(PROJECT_ROOT, benchmarkPath('report'));
const relativeReport = kind => path.relative(path.dirname(output), benchmarkPath(kind)).split(path.sep).join('/');
const markdown = `# v${benchmarkVersion} 性能基线与稳定性报告

此报告由 \`npm run benchmark:report\` 从机器报告生成，不以单次运行或固定倍数承诺性能。全部计时单位为毫秒，表中括号为五次有效运行的最小值–最大值；每组在相同输入上另有一次不计分预热。

## 环境与出处

- 系统：${current.environment.version} ${current.environment.release}，${current.environment.architecture}。
- CPU：${current.environment.cpu}，${current.environment.logicalCpus} 逻辑处理器；物理内存 ${mib(current.environment.totalMemoryBytes)} MiB。
- Node：${current.environment.node}；Rust：${current.environment.rust}。
- 原 v0.3.0 核心基线：\`${baseline.sourceSha}\`，采集时间 ${baseline.measuredAt}；\`sourceCoreModified=${baseline.sourceCoreModified}\`。该提交只增加审阅文档，字幕核心仍为 v0.3.0。
- 当前计算测量：\`${current.sourceSha}\`，采集时间 ${current.measuredAt}，应用版本 ${current.appVersion}，\`sourceCoreModified=${current.sourceCoreModified}\`。脏工作树测量只作开发性能证据，不能冒充干净发布产物。
- 当前 SSR 执行 bundle SHA-256：\`${current.runtimeBundleSha256 ?? 'NOT_RECORDED_IN_INITIAL_SAMPLE'}\`。
- 浏览器：${browser.browserVersion}，采集时间 ${browser.measuredAt}，源码提交 \`${browser.sourceSha}\`；以生产 ES2022 打包的真实调度器和 Web Worker 测量。
- Node 为未压缩 Vite SSR 构建，浏览器为生产压缩构建；两类计时不能横向当作同一运行环境比较。系统处于正常共享开发环境，波动区间原样保留。

完整命令：

\`\`\`powershell
# 首次采集必须在未修改的 v0.3.0 核心上执行；本轮已于修改前完成。
# 复测旧基线时把 scripts/benchmark* 复制到隔离的 v0.3.0 源码副本；legacy runner 不依赖 v0.4 模块。
node --expose-gc scripts/benchmark.mjs --phase=baseline
# 日常完整测量（当前引擎、真实 Worker、生成本报告）
npm run benchmark
# 独立阶段
npm run benchmark:engine
npm run benchmark:browser
npm run benchmark:report
\`\`\`

原始数据见 [baseline](${relativeReport('baseline')})、[优化前](${relativeReport('pre_optimization')})、[当前引擎](${relativeReport('current')}) 和 [真实 Worker](${relativeReport('browser')})。夹具由程序生成，包含简繁中文、emoji、HTML 标签、空白和多行正文。

## 单工具回归

单项为“空格清理”，包括解码、输入解析、变换、序列化及既有最终输出重解析校验、编码。输出哈希已与旧基线逐项比对一致。

| 条目数 | v0.3.0 median (min–max) | 当前 median (min–max) | 中位数变化 |
| --- | ---: | ---: | ---: |
${regression}

${slow.length ? `有 ${slow.join('、')} 条目组超过建议的 20% 分析线。此为非阻断趋势提示；必须结合分阶段数据和同机重复样本分析，不能仅凭这一轮归因某项优化。` : '本轮没有单工具组超过建议的 20% 中位数劣化分析线。几万条输入的 GC 和系统负载仍会带来波动，未以这些变化宣称解析器或编码器变快。'}

## 三步骤一次处理

流程为“删除空白字幕 → 空格清理 → 延后 500 毫秒”。串行基线在每个工具之间重新解码、解析、序列化和编码；新流程仅输入一次、末端一次。每组当前流程与同轮串行输出逐字节 SHA-256 一致。

| 条目数 | v0.3.0 三次往返 median | 同轮当前三次往返 median | 当前内存流程 median (min–max) |
| --- | ---: | ---: | ---: |
${flows}

| 批次（每文件 1,000 条） | v0.3.0 三次往返 median | 同轮三次往返 median | 内存流程 median (min–max) |
| --- | ---: | ---: | ---: |
${batches}

同轮 1,000 条输入的阶段细分如下。Node 引擎表不含系统文件对话框、磁盘或 Worker 启动时间；每个阶段均有内存采样开销。

| 阶段 | 三次往返 median (min–max) | 内存流程 median (min–max) |
| --- | ---: | ---: |
${stageRows}

## 实测瓶颈与限定优化

自动换行原先每生成一行都用 \`splice(0, n)\` 搬移整个剩余数组，极端长行会反复复制。改为在同一字符数组上推进游标并切片，保留 Unicode 计数、附近空格优先断行及所有字符顺序。

- 同一长行夹具（“字幕 😀 long line ”重复 16,384 次），优化前 ${range(beforeWrap.totalMs)}，优化后 ${range(afterWrap.totalMs)}。
- 优化前后完整输出 SHA-256：\`${afterWrap.outputSha256}\`；报告生成器会在哈希不同的情况下失败。
- 已新增超长 Unicode 行、每行字符上限和空格断行回归测试。没有修改字幕语义、时间舍入、严格编码、差异对齐上限或输入容量。

复杂格式与编码样本：

| 样本 | 输入字节 | 输出字节 | median (min–max) |
| --- | ---: | ---: | ---: |
${complex}

ASS 简繁使用完整源布局写回路径，单独测总时长；其细分阶段为 NOT_MEASURED，未用零值冒充耗时。GB18030 使用现有严格往返编码。UTF-16LE 含 BOM。

## 真实浏览器 Worker、取消与资源

${browser.method}

| 样本 | 端到端 median (min–max) | 主页面回收后 heap 差值中位数 KiB |
| --- | ---: | ---: |
${browserRows}

- 共创建 ${browser.workerLifecycle.created} 个实际 Worker，终止 ${browser.workerLifecycle.terminated} 个，最终活动数 ${browser.workerLifecycle.active}，同时活动上限 ${browser.workerLifecycle.maxActive}；失败隔离实际状态为 \`${browser.failureIsolation.map(item => item.status).join(' → ')}\`。
- 长任务取消：10 份 × 50,000 条、合计 ${mib(browser.cancellation.inputBytes)} MiB，等待首个步骤起始进度后取消，5 次有效样本均无成功误报、无输出；取消响应 ${range(browser.cancellation.responseMs)}。接近零的数值受浏览器计时分辨率影响，不表示物理耗时为零。
- Worker 60 秒超时、异常终止、正常终态和取消的计时器/监听清理另有自动化测试；没有为基准专门等待一次 60 秒超时。
- Chromium 页面 heap 数据不包含独立 Worker 堆，不可作为应用进程或 Worker 的真实峰值。该采样未发现明显重复运行累积，仅作为趋势；独立 Worker OS 峰值为 NOT_MEASURED。

Node 流程的阶段边界采样（非真实峰值）：

| 条目数 | 输入 MiB | 采样 heap 最大 MiB | 运行后 RSS 中位数 MiB |
| --- | ---: | ---: | ---: |
${memoryRows}

## 独立文件读取与写入样本

${current.ioMeasurements?.length ? '以下在项目受控临时目录中测量 Node 文件读取、唯一临时文件写入、fsync 与同目录 rename。它们是温缓存样本，与上述纯计算分别测量；不是 Tauri/Rust IPC、原生权限对话框或冷盘延迟，不能直接相加声称一次原生操作的端到端时间。' : '初始样本没有采集磁盘 IO（NOT_MEASURED）；执行最新 benchmark:engine 可生成受控目录下的独立温缓存 IO 样本。'}

| 条目数 | 字节 | 读取 median (min–max) | 写入+sync+rename median (min–max) |
| --- | ---: | ---: | ---: |
${ioRows || '| NOT_MEASURED | — | — | — |'}

## 限额、磁盘与适用边界

- 仍限制单文件 32 MiB、队列 100 个文件 / 128 MiB；基准也显式拒绝超预算夹具。处理服务和 Worker 增加边界复核，既有导入限制没有放宽。
- 合成字幕主要在内存中；编译 bundle 与 IO 夹具只在 \`src-tauri/target/benchmark/run-<uuid>\` 或 \`browser-<uuid>\` 内。结束时重新验证绝对路径后清理该独占目录，保留的夹具字节为 0。
- \`npm run disk:report\` 单列 benchmark、Vite \`dist/\`、Rust \`target/\` 与唯一 \`release-output/\`；基准不把素材或报告拷入发布目录。
- 此测量不证明 Windows 10、其它 DPI、无 WebView2 环境性能或原生权限行为。相应原生 UIA/安装验收应阅读本轮发布测试记录。性能数值不设共享 CI 硬门槛；输出等价、失败隔离、取消和资源释放是功能硬门槛。
`;
await fs.writeFile(output, markdown);
console.log(path.relative(PROJECT_ROOT, output));
