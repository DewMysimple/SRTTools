# Runs only inside the native smoke lease with a fresh app-local draft namespace.
if (!(Get-Command Find-Text -ErrorAction SilentlyContinue)) { . (Join-Path $PSScriptRoot 'windows-native-controls.ps1') }
$report.recoveryChecks = [ordered]@{}
function Recovery-Pass([string] $Name) {
  $report.recoveryChecks[$Name] = $true
  Write-Host ('PASS native recovery ' + $Name)
}
function Recovery-Field([string] $Name) {
  (Get-Control $Name $types::Edit).GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
}
function Recovery-Open([string] $Path) {
  Click-Control '打开字幕'
  Select-DialogPath '选择时间轴字幕' $Path
}
function Recovery-Edit([string] $Value) {
  (Recovery-Field '字幕正文').SetValue($Value)
  Click-Control '应用编辑'
  Wait-Condition { (Read-RecoveryText) -ceq $Value } 'Inspector edit was not applied.' | Out-Null
}
function Read-RecoveryText {
  (Recovery-Field '字幕正文').Current.Value -replace '\r\n?', [string][char]10
}
function Recovery-Latest([int] $Revision = 0) {
  Get-ChildItem -LiteralPath $draftProfilePath -File -Filter '*.draft' -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^[a-f0-9]{32}\.([0-9]+)\.[a-f0-9]{32}\.draft$' -and [int]$Matches[1] -ge $Revision } |
    Sort-Object { [int]($_.Name.Split('.')[1]) } -Descending | Select-Object -First 1
}
function Recovery-Protected([int] $Revision) {
  Wait-Condition {
    $failure = Find-Text '^草稿保护失败'
    if ($failure -and $failure.Current) {
      $texts = @($application.FindAll($scope::Descendants, (Condition $element::ControlTypeProperty $types::Text)) |
        ForEach-Object { [string]$_.Current.Name })
      $index = [Array]::IndexOf($texts, [string]$failure.Current.Name)
      $detail = ($texts | Select-Object -Skip ([Math]::Max(0, $index)) -First 3) -join ' '
      throw ('Draft protection reported: ' + $detail)
    }
    $item = Recovery-Latest $Revision
    if ($item -and (Find-Text '^草稿已保护')) { $item }
  } 'Draft protection did not acknowledge the on-disk revision.'
}
function Recovery-Payload($Item) {
  Assert-Condition ((Assert-QANoReparse $Item.DirectoryName) -eq $draftProfilePath -and
    !$Item.PSIsContainer -and !($Item.Attributes -band [IO.FileAttributes]::ReparsePoint)) 'Draft snapshot escaped the fixture profile.'
  Assert-Condition ($Item.Length -ge 48 -and $Item.Length -le 16MB) 'Draft snapshot size was invalid.'
  $raw = [IO.File]::ReadAllBytes($Item.FullName)
  Assert-Condition ([Text.Encoding]::ASCII.GetString($raw, 0, 8) -ceq 'SRTDRFT1' -and
    [BitConverter]::ToUInt64($raw, 8) -eq $raw.Length) 'Draft snapshot length header was invalid.'
  $hash = [Security.Cryptography.SHA256]::Create()
  try { $actual = [BitConverter]::ToString($hash.ComputeHash($raw, 48, $raw.Length - 48)) } finally { $hash.Dispose() }
  Assert-Condition ($actual -ceq [BitConverter]::ToString($raw, 16, 32)) 'Draft payload did not match SHA-256.'
  [Text.Encoding]::UTF8.GetString($raw, 48, $raw.Length - 48) | ConvertFrom-Json
}

$stage = 'draft-atomic-protection'
$recoverySource = Join-Path $testRoot '恢复 草稿 (🐱).srt'
$recoveryOutput = Join-Path $testRoot '已恢复的独立字幕.srt'
$recoveryText = "7`r`n00:00:02,000 --> 00:00:04,000`r`n恢复原文 🐱`r`n第二行`r`n"
[IO.File]::WriteAllText($recoverySource, $recoveryText, $utf8)
$report.recoverySourceSha256 = (Get-FileHash -LiteralPath $recoverySource -Algorithm SHA256).Hash
$timelineLink = Get-Control '字幕时间轴' $types::Hyperlink
$timelineLink.GetCurrentPattern($invoke).Invoke()
Recovery-Open $recoverySource
Wait-Condition { (Recovery-Field '开始时间').Current.Value -ceq '00:00:02.000' } 'Synthetic recovery source did not open.' | Out-Null
$report.checks.import = $true
if ($Scenario -eq 'workflow') {
  Click-Control '关联视频'
  Select-DialogPath '选择本地视频' $mediaSource
  Wait-Condition { (Find-Text '^视频就绪$') -and !(Media-FileWritable $mediaSource) } 'A real recovery media session was not attached.' | Out-Null
}
Recovery-Edit "已保护正文 🐱`n第二行"
$protected = Recovery-Protected 1
$firstSnapshot = Recovery-Payload $protected
Assert-Condition ($firstSnapshot.draft.cues[0].text -ceq "已保护正文 🐱`n第二行" -and
  $firstSnapshot.source.sha256 -eq $report.recoverySourceSha256 -and !$firstSnapshot.draft.PSObject.Properties['video']) 'Persisted draft content or source proof was incorrect.'
(Recovery-Field '字幕正文').SetValue('仅表单输入，不应写入')
Start-Sleep -Milliseconds 1450
Assert-Condition (!(Recovery-Latest 2)) 'Uncommitted inspector input reached disk.'
Click-Control '取消编辑'
Recovery-Pass 'committedOnlyAndVerified'
$report.checks.process = $true

$stage = 'draft-native-file-lock'
$locked = [IO.File]::Open($protected.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
try {
  (Recovery-Field '开始时间').SetValue('00:00:02.125')
  Click-Control '应用编辑'
  Wait-Condition { Find-Text '^草稿保护失败' } 'A real locked snapshot did not surface a protection failure.' | Out-Null
  Assert-Condition (!(Recovery-Latest 2)) 'A write replaced the snapshot under a real exclusive lock.'
} finally { $locked.Dispose() }
Click-Control '重试草稿保护'
$protected = Recovery-Protected 2
$latestSnapshot = Recovery-Payload $protected
Assert-Condition ($latestSnapshot.draft.revision -eq 2 -and $latestSnapshot.draft.cues[0].startMs -eq 2125) 'Retry did not protect the latest edit.'
Recovery-Pass 'exclusiveLockAndRetry'

$stage = 'draft-abrupt-restart'
$oldPid = $process.Id
Stop-Process -Id $oldPid -ErrorAction Stop
Assert-Condition ($process.WaitForExit(10000)) 'Could not terminate the owned application process.'
$profilePath = Join-Path $testRoot 'webview'
Wait-Condition {
  @(Get-CimInstance Win32_Process -Filter "name='msedgewebview2.exe'" | Where-Object {
    $_.CommandLine -and $_.CommandLine.IndexOf($profilePath, [StringComparison]::OrdinalIgnoreCase) -ge 0
  }).Count -eq 0
} 'WebView2 profile writers remained after the forced application exit.' 12000 | Out-Null
$process = Start-Process -FilePath $ExePath -WindowStyle Hidden -PassThru
Assert-Condition ($process.Id -ne $oldPid) 'The acceptance did not start a new application process.'
$application = Get-ApplicationWindow $process
$applicationHandle = [IntPtr]::new($application.Current.NativeWindowHandle)
if ($Scenario -eq 'workflow') {
  Assert-Condition ((Media-FileWritable $mediaSource) -and
    (Get-FileHash -LiteralPath $mediaSource -Algorithm SHA256).Hash -ceq $mediaSampleHash) 'Force exit did not release and preserve the source media.'
}
(Get-Control '管理本地草稿' $types::Hyperlink).GetCurrentPattern($invoke).Invoke()
Click-Control '查看差异'
Wait-Condition { Find-Text '原字幕字节未变化' } 'Recovery did not find the exact original bytes after restart.' | Out-Null
[void](Get-Control '字幕差异预览')
Recovery-Pass 'forceKillAndDiscovery'

$stage = 'draft-source-conflict'
$external = $recoveryText.Replace('恢复原文', '外部更改')
[IO.File]::WriteAllText($recoverySource, $external, $utf8)
$report.recoveryExternalSha256 = (Get-FileHash -LiteralPath $recoverySource -Algorithm SHA256).Hash
Assert-Condition ($report.recoveryExternalSha256 -cne $report.recoverySourceSha256 -and
  (Get-Item -LiteralPath $recoverySource).Length -eq $firstSnapshot.source.bytes) 'The equal-size conflict fixture did not change only its bytes.'
Click-Control '确认恢复到时间轴'
Wait-Condition { Find-Text '草稿或来源状态已变化' } 'The source conflict was not rechecked immediately before restoring.' | Out-Null
Click-Control '独立恢复并另存为'
Wait-Condition {
  (Recovery-Field '开始时间').Current.Value -ceq '00:00:02.125' -and
  (Read-RecoveryText) -ceq "已保护正文 🐱`n第二行"
} 'Recovered inspector did not contain the latest complete revision.' | Out-Null
Assert-Condition (!(Find-Control '关闭视频' $types::Button)) 'A video grant survived the recovery restart.'
Recovery-Pass 'externalConflictIndependent'

$stage = 'draft-export-lifecycle'
Click-Control '另存为'
$picker = Get-Dialog '导出处理结果（已有文件会自动添加序号）'
[SubtitleSmokeNative]::DialogCommand($picker, 2)
Wait-DialogClosed
Assert-Condition ((Recovery-Latest 2) -ne $null) 'Cancelling the native export removed the recovery draft.'
Click-Control '另存为'
Select-DialogPath '导出处理结果（已有文件会自动添加序号）' $recoveryOutput
Wait-Condition { (Test-Path -LiteralPath $recoveryOutput) -and !(Recovery-Latest) } 'Successful export did not retire the exact recovery revision.' | Out-Null
$expectedRecovery = "1`r`n00:00:02,125 --> 00:00:04,000`r`n已保护正文 🐱`r`n第二行`r`n"
Assert-Condition ([IO.File]::ReadAllText($recoveryOutput, $utf8) -ceq $expectedRecovery) 'Recovered export did not preserve edited times, Unicode or CRLF.'
Assert-Condition ((Get-FileHash -LiteralPath $recoverySource -Algorithm SHA256).Hash -ceq $report.recoveryExternalSha256) 'Recovery overwrote the externally changed subtitle.'
Recovery-Pass 'exportAndSourcePreservation'
$report.checks.export = $true
$report.originalPreserved = $true
$report.preservedSourceCount = 1 + [int]$report.preservedSourceCount

$stage = 'draft-missing-source'
$missingSource = Join-Path $testRoot '稍后 删除.srt'
[IO.File]::WriteAllText($missingSource, $recoveryText, $utf8)
Recovery-Open $missingSource
Wait-Condition { (Recovery-Field '开始时间').Current.Value -ceq '00:00:02.000' } 'Missing-source fixture did not open.' | Out-Null
Recovery-Edit '源文件稍后移除'
[void](Recovery-Protected 1)
(Get-Control '首页' $types::Hyperlink).GetCurrentPattern($invoke).Invoke()
Click-Control '保留草稿并继续'
[void](Get-Control '管理本地草稿' $types::Hyperlink)
Remove-Item -LiteralPath $missingSource
(Get-Control '管理本地草稿' $types::Hyperlink).GetCurrentPattern($invoke).Invoke()
Click-Control '查看差异'
Wait-Condition { Find-Text '找不到原字幕' } 'A missing source did not offer an independent recovery.' | Out-Null
Click-Control '稍后处理'
Wait-Condition { !(Find-Control '恢复草稿' $types::Button) } 'A deferred recovery still appeared in the current view.' | Out-Null
Click-Control '显示稍后处理项'
Click-Control '丢弃草稿'
Click-Control '确认丢弃草稿'
Wait-Condition { !(Recovery-Latest) } 'Confirmed discard did not clear only the selected draft.' | Out-Null
Assert-Condition ((Get-FileHash -LiteralPath $recoverySource -Algorithm SHA256).Hash -ceq $report.recoveryExternalSha256) 'Discard modified a different subtitle.'
Recovery-Pass 'missingSourceDeferAndDiscard'

$stage = 'draft-performance'
$report.recoveryMeasurements = @()
foreach ($count in @(500, 5000, 10000)) {
  $srt = Join-Path $testRoot ('草稿基准-' + $count + '.srt')
  $out = Join-Path $testRoot ('草稿基准-导出-' + $count + '.srt')
  $builder = [Text.StringBuilder]::new()
  for ($i = 0; $i -lt $count; $i++) {
    $start = [TimeSpan]::FromMilliseconds($i * 800 + 100).ToString('hh\:mm\:ss\,fff')
    $end = [TimeSpan]::FromMilliseconds($i * 800 + 700).ToString('hh\:mm\:ss\,fff')
    [void]$builder.Append(($i + 1)).Append("`r`n$start --> $end`r`n合成样本 $i · Unicode 🐱`r`n`r`n")
  }
  [IO.File]::WriteAllText($srt, $builder.ToString(), $utf8)
  $sourceBefore = (Get-FileHash -LiteralPath $srt -Algorithm SHA256).Hash
  $timer = [Diagnostics.Stopwatch]::StartNew()
  Recovery-Open $srt
  Wait-Condition { (Recovery-Field '开始时间').Current.Value -ceq '00:00:00.100' } 'Benchmark source did not open.' | Out-Null
  $openMs = $timer.ElapsedMilliseconds
  $saveTimes = @()
  for ($i = 1; $i -le 3; $i++) {
    $timer.Restart()
    Recovery-Edit ('性能测试 ' + $i + ' 🐱')
    $item = Recovery-Protected $i
    $saveTimes += $timer.ElapsedMilliseconds
  }
  $bytes = $item.Length
  $snapshot = Recovery-Payload $item
  Assert-Condition (@($snapshot.draft.cues).Count -eq $count) 'Benchmark snapshot omitted subtitle entries.'
  $process.Refresh()
  $peakWorkingSet = $process.PeakWorkingSet64
  (Get-Control '首页' $types::Hyperlink).GetCurrentPattern($invoke).Invoke()
  Click-Control '保留草稿并继续'
  (Get-Control '管理本地草稿' $types::Hyperlink).GetCurrentPattern($invoke).Invoke()
  $timer.Restart()
  Click-Control '恢复草稿'
  Click-Control '确认恢复到时间轴'
  Wait-Condition { (Recovery-Field '字幕正文').Current.Value -ceq '性能测试 3 🐱' } 'Benchmark recovery did not render the confirmed edit.' | Out-Null
  $restoreMs = $timer.ElapsedMilliseconds
  Click-Control '另存为'
  Select-DialogPath '导出处理结果（已有文件会自动添加序号）' $out
  Wait-Condition { (Test-Path -LiteralPath $out) -and !(Recovery-Latest) } 'Benchmark export did not retire the draft.' | Out-Null
  Assert-Condition ((Get-FileHash -LiteralPath $srt -Algorithm SHA256).Hash -ceq $sourceBefore) 'A benchmark source was modified.'
  $report.recoveryMeasurements += [ordered]@{
    cues = $count; openMs = $openMs; saveMs = $saveTimes; restoreMs = $restoreMs; snapshotBytes = $bytes;
    peakHostWorkingSetBytes = $peakWorkingSet; sourceSha256 = $sourceBefore
  }
}
Recovery-Pass 'boundedDraftMeasurements'
