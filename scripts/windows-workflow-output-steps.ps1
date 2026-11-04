# Native directory output and cancellation checks, in the same protected workflow lifecycle.
$stage = 'workflow-multiroot-deep-import'
Clear-WorkflowQueue
Set-WorkflowCheckbox '包含子文件夹' $true
$rootA = Join-Path $testRoot 'roots-a\字幕项目'
$rootB = Join-Path $testRoot 'roots-b\字幕项目'
[void](New-WorkflowFixture $rootA '第一份.srt')
[void](New-WorkflowFixture (Join-Path $rootA '层一\层二\层三\层四\层五') '同名.srt')
[void](New-WorkflowFixture $rootB '第二份.srt')
[void](New-WorkflowFixture (Join-Path $rootB '另集') '同名.srt')
Import-WorkflowFolder $rootA; Import-WorkflowFolder $rootB
Wait-Condition { (Workflow-QueueCount) -eq 4 } 'The two native Unicode roots did not preserve all four paths, including depth five.' | Out-Null
Click-Control '预览影响'; Wait-WorkflowFinished
$relativeEntries = @{
  '字幕项目/第一份_processed.srt'=$expectedBytes
  '字幕项目/层一/层二/层三/层四/层五/同名_processed.srt'=$expectedBytes
  '字幕项目 (2)/第二份_processed.srt'=$expectedBytes
  '字幕项目 (2)/另集/同名_processed.srt'=$expectedBytes
}
foreach ($path in $relativeEntries.Keys) { Wait-Condition { Find-Text ([regex]::Escape($path)) } 'Multi-root output preview did not preserve the reviewed path.' | Out-Null }

$stage = 'workflow-native-flat-output'
Select-Option '输出目录结构' '全部平铺输出'
$flatDestination = Join-Path $testRoot '平铺 输出 🐱'
[IO.Directory]::CreateDirectory($flatDestination) | Out-Null
Prepare-WorkflowDirectory $flatDestination
Click-Control '确认导出到目录'
Wait-Condition { Find-Text '目录导出结束：4 成功、0 失败' } 'Native flat directory export did not complete all four files.' 60000 | Out-Null
$flatNames = @('第一份_processed.srt','第二份_processed.srt','同名_processed.srt','同名_processed (2).srt')
Assert-Condition (@(Get-ChildItem -LiteralPath $flatDestination -Directory).Count -eq 0 -and @(Get-ChildItem -LiteralPath $flatDestination -File).Count -eq 4) 'Flat export created subdirectories or lost an input.'
foreach ($name in $flatNames) { Assert-Bytes (Join-Path $flatDestination $name) $expectedBytes }
Feature-Pass 'Workflow_native_flat_directory_collision_and_exact_bytes'
# A new preview starts a fresh export session; successful files from the flat session stay intact.
Click-Control '预览影响'; Wait-WorkflowFinished
Select-Option '输出目录结构' '保持输入目录层级'
foreach ($path in $relativeEntries.Keys) { Wait-Condition { Find-Text ([regex]::Escape($path)) } 'Preserved directory preview did not return after a new run.' | Out-Null }

$stage = 'workflow-source-overlap-rejected'
Prepare-WorkflowDirectory $rootA
Wait-Condition { Find-Text '输出目录与源目录重叠' } 'Native output did not reject a root overlapping a source directory.' | Out-Null
Assert-Condition (!(Find-Control '确认导出到目录' $types::Button)) 'An overlapping output root remained exportable.'
Workflow-Pass 'sourceOverlapRejected'

$stage = 'workflow-output-picker-cancel-and-retry'
Click-Control '选择输出目录并预览'
$cancelDialog = Get-Dialog '选择独立输出文件夹（不覆盖源文件）'
[SubtitleSmokeNative]::DialogCommand($cancelDialog,2); Wait-DialogClosed
Assert-Condition (!(Find-Control '确认导出到目录' $types::Button)) 'A cancelled native destination picker created an export session.'
$destination = Join-Path $testRoot '独立 输出 🐱'
[IO.Directory]::CreateDirectory((Join-Path $destination '字幕项目')) | Out-Null
[IO.Directory]::CreateDirectory((Join-Path $destination '字幕项目 (2)\另集')) | Out-Null
$sentinel = Join-Path $destination '字幕项目\第一份_processed.srt'
[IO.File]::WriteAllText($sentinel,'EXISTING OUTPUT MUST STAY UNCHANGED',$utf8)
$originalHashes[$sentinel] = (Get-FileHash -LiteralPath $sentinel -Algorithm SHA256).Hash
Prepare-WorkflowDirectory $destination
[void](Get-Control '确认导出到目录' $types::Button)
$relativeEntries.Remove('字幕项目/第一份_processed.srt')
$relativeEntries['字幕项目/第一份_processed (1).srt'] = $expectedBytes
Wait-Condition { Find-Text ([regex]::Escape('字幕项目/第一份_processed (1).srt')) } 'Native collision planning did not preserve the existing file and reveal its replacement name.' | Out-Null

$stage = 'workflow-native-write-failure-retry'
$deniedDirectory = Join-Path $destination '字幕项目 (2)\另集'
Assert-Condition (Test-Path -LiteralPath $deniedDirectory) 'Controlled failure fixture directory was missing.'
$denyRule = [Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.WindowsIdentity]::GetCurrent().User,[Security.AccessControl.FileSystemRights]::CreateFiles,[Security.AccessControl.AccessControlType]::Deny)
$acl = [IO.Directory]::GetAccessControl($deniedDirectory); $acl.AddAccessRule($denyRule)
$permission = @{path=$deniedDirectory;rule=$denyRule}; $workflowPermissions.Add($permission)
[IO.Directory]::SetAccessControl($deniedDirectory,$acl)
Click-Control '确认导出到目录'
Wait-Condition { Find-Text '目录导出结束：3 成功、1 失败' } 'A real destination write failure was not isolated from the three successful outputs.' 60000 | Out-Null
$successfulBeforeRetry = @{}
foreach ($path in $relativeEntries.Keys | Where-Object { $_ -ne '字幕项目 (2)/另集/同名_processed.srt' }) {
  $file = Join-Path $destination ($path.Replace('/','\')); Assert-Bytes $file $expectedBytes
  $successfulBeforeRetry[$file] = (Get-Item -LiteralPath $file).LastWriteTimeUtc
}
$acl = [IO.Directory]::GetAccessControl($deniedDirectory); $acl.RemoveAccessRuleSpecific($denyRule); [IO.Directory]::SetAccessControl($deniedDirectory,$acl)
$workflowPermissions.Remove($permission) | Out-Null
Prepare-WorkflowDirectory $destination $true
Click-Control '确认导出到目录'
Wait-Condition { Find-Text '目录导出结束：4 成功、0 失败' } 'Native export retry did not complete the failed output.' 60000 | Out-Null
foreach ($file in $successfulBeforeRetry.Keys) { Assert-Condition ((Get-Item -LiteralPath $file).LastWriteTimeUtc -eq $successfulBeforeRetry[$file]) 'Native retry rewrote a previously successful output.' }
foreach ($path in $relativeEntries.Keys) { Assert-Bytes (Join-Path $destination ($path.Replace('/','\'))) $expectedBytes }
Workflow-Pass 'failedWriteRetry'
Workflow-Pass 'nestedDirectoryWrite'
$treeZip = Save-WorkflowZip 'workflow-multiroot-tree'
Assert-WorkflowZip $treeZip $relativeEntries
Workflow-Pass 'multiRootZipManifest'

$stage = 'workflow-real-worker-cancel-retry'
Clear-WorkflowQueue; Set-WorkflowCheckbox '包含子文件夹' $false
$cancelRoot = Join-Path $testRoot 'cancel-retry-input'
[IO.Directory]::CreateDirectory($cancelRoot) | Out-Null
$largeSource = Join-Path $cancelRoot '00-large.srt'
$builder = [Text.StringBuilder]::new(24MB)
for ($cue = 1; $cue -le 180000; $cue++) {
  [void]$builder.Append($cue).Append("`n00:00:01,000 --> 00:00:02,000`n  错词   中文 ").Append([Guid]::NewGuid().ToString('N')).Append("  `n`n")
}
[IO.File]::WriteAllText($largeSource,$builder.ToString(),$utf8); $builder = $null
Assert-Condition ((Get-Item -LiteralPath $largeSource).Length -le 32MB) 'Cancellation fixture exceeded the native single-file limit.'
$originalHashes[$largeSource] = (Get-FileHash -LiteralPath $largeSource -Algorithm SHA256).Hash
[void](New-WorkflowFixture $cancelRoot '99-small.srt')
Import-WorkflowFolder $cancelRoot
Wait-Condition { (Workflow-QueueCount) -eq 2 } 'Cancellation fixtures were not imported.' | Out-Null
Click-Control '开始处理'
Click-Control '取消处理'
function Workflow-CancellationTaskRows {
  @($application.FindAll($scope::Descendants,(Condition $element::ControlTypeProperty $types::Button)) | Where-Object {
    ([string]$_.Current.Name).StartsWith('00-large.srt') -or ([string]$_.Current.Name).StartsWith('99-small.srt')
  })
}
try {
  Wait-Condition {
    (Find-Control '重试未完成项' $types::Button) -and
    @(Workflow-CancellationTaskRows | Where-Object { ([string]$_.Current.Name).EndsWith('已取消') }).Count -gt 0
  } 'A real workflow cancellation was not observed.' 60000 | Out-Null
} catch {
  $report.cancellationDiagnostic = @{ retryVisible=[bool](Find-Control '重试未完成项' $types::Button); rows=@(Workflow-CancellationTaskRows | ForEach-Object { $_.Current.Name }) }
  throw
}
$report.processingCancellationObserved = $true
Click-Control '重试未完成项'; Wait-WorkflowFinished
Wait-Condition {
  $success = @(Workflow-CancellationTaskRows | Where-Object { ([string]$_.Current.Name).EndsWith('已处理') })
  $success.Count -eq 2
} 'Cancelled workflow retry did not process both retained inputs.' 120000 | Out-Null
Assert-Condition (!(Find-Control '重试未完成项' $types::Button)) 'Workflow retry left unfinished inputs.'
$report.destinationPickerCancellationObserved = $true
Workflow-Pass 'cancelRetry'
