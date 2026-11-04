# Invoked by the Explorer acceptance lifecycle after registry tests; uses only owned fixtures.
$stage = 'gate5-real-explorer-drag'
Open-Home
$explorerHandle = [IntPtr]$explorerWindow.HWND
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$appWidth = [Math]::Min(1200, $screen.Width - 760)
Assert-Condition ($appWidth -ge 900) 'Desktop is too narrow for a verified two-window physical drag.'
[void][SubtitleDesktopInteraction]::MoveWindow($applicationHandle, $screen.Left + 10, $screen.Top + 10, $appWidth, 800, $true)
[void][SubtitleDesktopInteraction]::MoveWindow($explorerHandle, $screen.Left + $appWidth + 30, $screen.Top + 10, 700, 700, $true)
[SubtitleDesktopInteraction]::Topmost($applicationHandle,$true)
[SubtitleDesktopInteraction]::Topmost($explorerHandle,$true)
function Drag-ExternalItems([string[]] $Paths) {
  $view = $explorerWindow.Document
  $view.SelectItem($view.Folder.ParseName([IO.Path]::GetFileName($Paths[0])), 1 + 4 + 8 + 16)
  foreach ($path in $Paths | Select-Object -Skip 1) { $view.SelectItem($view.Folder.ParseName([IO.Path]::GetFileName($path)), 1) }
  Assert-Condition ($view.SelectedItems().Count -eq $Paths.Count) 'Physical drag selection did not match its fixture list.'
  $explorerElement = $element::FromHandle($explorerHandle)
  $sourceItem = Wait-Condition {
    $explorerElement.FindAll($scope::Descendants,(Condition $element::ControlTypeProperty $types::ListItem)) | Where-Object {
      $_.Current.Name -eq [IO.Path]::GetFileName($Paths[0]) -or $_.Current.Name -eq [IO.Path]::GetFileNameWithoutExtension($Paths[0])
    } | Select-Object -First 1
  } 'Physical drag source fixture was not visible in Explorer.'
  $bounds = $sourceItem.Current.BoundingRectangle
  $drop = (Get-Control '把字幕文件拖到这里').Current.BoundingRectangle
  $x1 = [int]($bounds.Left + $bounds.Width / 2); $y1 = [int]($bounds.Top + $bounds.Height / 2)
  $x2 = [int]($drop.Left + $drop.Width / 2); $y2 = [int]($drop.Top + $drop.Height / 2)
  Assert-Condition ([SubtitleDesktopInteraction]::RootAt($x1,$y1) -eq $explorerHandle) 'Owned Explorer drag source was covered.'
  Assert-Condition ([SubtitleDesktopInteraction]::RootAt($x2,$y2) -eq $applicationHandle) 'Owned application drop target was covered.'
  [SubtitleDesktopInteraction]::Drag($x1,$y1,$x2,$y2)
}
try {
  Drag-ExternalItems @($first)
  Wait-Condition { (Queue-Count) -eq 1 } 'Real Explorer single-file drag did not import.' | Out-Null
  Drag-ExternalItems @($second,$third)
  Wait-Condition { (Queue-Count) -eq 3 } 'Real Explorer multiple-file drag did not preserve the first file and add both others.' | Out-Null
  Feature-Pass 'Explorer_real_physical_single_and_multi_drag_into_WebView2'
} finally { [SubtitleDesktopInteraction]::Topmost($applicationHandle,$false); [SubtitleDesktopInteraction]::Topmost($explorerHandle,$false) }

$stage = 'gate5-independent-compare'
$compareBefore = "1`r`n00:00:01,000 --> 00:00:02,000`r`nSAME_PRIVATE_SENTINEL`r`n`r`n2`r`n00:00:03,000 --> 00:00:04,000`r`nOLD_PRIVATE_SENTINEL`r`n"
$compareAfter = $compareBefore.Replace('OLD_PRIVATE_SENTINEL', 'NEW_PRIVATE_SENTINEL') + "`r`n3`r`n00:00:05,000 --> 00:00:06,000`r`nADDED_PRIVATE_SENTINEL`r`n"
$beforePath = New-ExternalFixture 'compare-before.srt' $compareBefore
$afterPath = New-ExternalFixture 'compare-after.srt' $compareAfter
Open-Tool '字幕对比'
if (Find-Control '清空' $types::Button) { Click-Control '清空' }
Click-Control '选择文件'
Select-DialogPath '选择字幕文件' ('"' + $beforePath + '" "' + $afterPath + '"')
Run-Success
[void](Get-Control '两份独立字幕的逻辑对比')
[void](Get-Control '第一份 · compare-before.srt')
[void](Get-Control '第二份 · compare-after.srt')
Wait-Condition { Find-Text '显示 3 行' } 'Independent comparison did not display three aligned rows.' | Out-Null
Click-Control '仅变化'
Wait-Condition { Find-Text '显示 2 行' } 'Changes-only comparison did not hide the unchanged row.' | Out-Null
$jsonOutput = Save-Single 'independent-compare' 'json'
$jsonText = [IO.File]::ReadAllText($jsonOutput, $utf8)
$comparison = $jsonText | ConvertFrom-Json
Assert-Condition ($comparison.visualComparison.kind -eq 'aligned') 'Exported comparison did not agree with the aligned UI.'
Assert-Condition ($comparison.visualComparison.summary.affected -eq 2 -and $comparison.visualComparison.summary.unchanged -eq 1 -and
  $comparison.visualComparison.summary.added -eq 1 -and $comparison.visualComparison.summary.textChanged -eq 1) 'Exported logical summary did not match the visible comparison.'
Assert-Condition ($jsonText -notmatch 'PRIVATE_SENTINEL|"cues"|"fullBody"') 'JSON comparison leaked subtitle bodies.'
Feature-Pass 'Independent_compare_WebView2_two_columns_filter_and_real_JSON_without_bodies'

$stage = 'gate5-batch-preset-restart'
Open-Tool '查找和替换'
$find = Get-Control '查找内容' $types::Edit
$find.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue('原文')
(Get-Control '替换为' $types::Edit).GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue('批量新文')
Click-Control '保存为新预设'
(Get-Control '预设名称' $types::Edit).GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue('Native Batch Preset')
Click-Control '确认保存'
Wait-Condition { !(Find-Control '确认保存' $types::Button) } 'Batch preset did not save.' | Out-Null
Stop-TestApp
Start-TestApp $ExePath
Open-Tool '查找和替换'
Assert-Condition ((Get-Control '查找内容' $types::Edit).GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value -eq '') 'Restart implicitly applied a saved preset.'
Select-Option '参数预设' 'Native Batch Preset'; Click-Control '应用预设'
Import-Fixture $first
Run-Success
$single = Save-Single 'batch-reference'
$expected = $utf8.GetBytes($text.Replace('原文','批量新文'))
Assert-Bytes $single $expected
$batchLink = $application.FindAll($scope::Descendants, (Condition $element::ControlTypeProperty $types::Hyperlink)) |
  Where-Object { ([string]$_.Current.Name).StartsWith('批量处理') } | Select-Object -First 1
Assert-Condition ([bool]$batchLink) 'Batch navigation was not available.'
$batchLink.GetCurrentPattern($invoke).Invoke()
Select-Option '参数预设' 'Native Batch Preset'; Click-Control '应用预设'
Assert-Condition (!(Find-Control '另存为' $types::Button)) 'Batch preset application retained stale results.'
Click-Control '选择文件'; Select-DialogPath '选择字幕文件' $second
Click-Control '预览处理结果'; [void](Get-Control '导出 ZIP' $types::Button)
Click-Control '导出 ZIP'; $batchZip = Join-Path $testRoot 'batch-preset.zip'
Select-DialogPath '导出处理结果（已有文件会自动添加序号）' $batchZip
Wait-Condition { Test-Path -LiteralPath $batchZip } 'Batch preset export was not created.' | Out-Null
$archive = [IO.Compression.ZipFile]::OpenRead($batchZip)
try {
  Assert-Condition ($archive.Entries.Count -eq 2) 'Batch preset ZIP did not contain the retained and additional input.'
  foreach ($entry in $archive.Entries) {
    $stream = $entry.Open(); $buffer = [IO.MemoryStream]::new()
    try {
      $stream.CopyTo($buffer)
      $entryExpected = if ($entry.Name -eq ([IO.Path]::GetFileNameWithoutExtension($first) + '_processed.srt')) { $expected } else { [IO.File]::ReadAllBytes($second) }
      Assert-Condition ([Convert]::ToBase64String($buffer.ToArray()) -eq [Convert]::ToBase64String($entryExpected)) 'Batch preset ZIP bytes did not match the independently expected single-file output.'
    }
    finally { $stream.Dispose(); $buffer.Dispose() }
  }
} finally { $archive.Dispose() }
Feature-Pass 'Batch_named_preset_restart_single_and_real_ZIP_export'
