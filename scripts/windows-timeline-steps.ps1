# Run in the existing native QA lease. All source and output files are synthetic.
if (!('SubtitleDesktopInteraction' -as [type])) { . (Join-Path $PSScriptRoot 'windows-desktop-interaction.ps1') }
$report.timelineChecks = [ordered]@{}

function Timeline-Pass([string] $Name) {
  $report.timelineChecks[$Name] = $true
  Write-Host ('PASS native timeline ' + $Name)
}

function Get-TimelineField([string] $Name) {
  $field = Get-Control $Name $types::Edit
  $field.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
}

function Read-TimelineField([string] $Name) {
  (Get-TimelineField $Name).Current.Value
}

$stage = 'timeline-import'
$timelineSource = Join-Path $testRoot '时间轴 # 字幕 🐱.srt'
$timelineOutput = Join-Path $testRoot '时间轴校时 🐱.srt'
$timelineCloseOutput = Join-Path $testRoot '时间轴关闭保存 🐱.srt'
$timelineText = "1`r`n00:00:02,000 --> 00:00:04,000`r`n时间轴 🐱`r`n第二行`r`n`r`n2`r`n00:00:06,000 --> 00:00:08,000`r`n保持原样`r`n"
[IO.File]::WriteAllText($timelineSource, $timelineText, [Text.UTF8Encoding]::new($true))
$timelineSourceHash = (Get-FileHash -LiteralPath $timelineSource -Algorithm SHA256).Hash
(Get-Control '字幕时间轴' $types::Hyperlink).GetCurrentPattern($invoke).Invoke()
Click-Control '打开字幕'
Select-DialogPath '选择时间轴字幕' $timelineSource
Wait-Condition { (Read-TimelineField '开始时间') -ceq '00:00:02.000' } 'Timeline did not display the initial SRT timing.' | Out-Null
Click-Control '列表字幕 2'
Wait-Condition { (Read-TimelineField '开始时间') -ceq '00:00:06.000' } 'Subtitle list selection did not update the inspector.' | Out-Null
Click-Control '列表字幕 1'
Wait-Condition { (Read-TimelineField '开始时间') -ceq '00:00:02.000' } 'Initial selection was not restored.' | Out-Null
$report.checks.import = $true
Timeline-Pass 'pickerAndSelection'

$stage = 'timeline-pointer'
[void][SubtitleDesktopInteraction]::ShowWindow($applicationHandle, 9)
$screen = [Windows.Forms.Screen]::FromHandle($applicationHandle).WorkingArea
$width = [Math]::Min(1200, $screen.Width - 16)
$height = [Math]::Min(800, $screen.Height - 16)
[void][SubtitleDesktopInteraction]::MoveWindow($applicationHandle, $screen.Left + 8, $screen.Top + 8, $width, $height, $true)
[void][SubtitleDesktopInteraction]::SetForegroundWindow($applicationHandle)
$point = Wait-Condition {
  $control = Find-Control '字幕 1' $types::Button
  if (!$control -or $control.Current.IsOffscreen) { return $false }
  $box = $control.Current.BoundingRectangle
  $x = [int]($box.Left + $box.Width / 2)
  $y = [int]($box.Top + $box.Height / 2)
  if ($box.Width -ge 35 -and [SubtitleDesktopInteraction]::RootAt($x, $y) -eq $applicationHandle -and
    [SubtitleDesktopInteraction]::RootAt(($x + 44), $y) -eq $applicationHandle) { @{ x = $x; y = $y } }
} 'The owned timeline drag handle did not become visible.'
[SubtitleDesktopInteraction]::Drag($point.x, $point.y, ($point.x + 44), $point.y)
$moved = Wait-Condition {
  $value = Read-TimelineField '开始时间'
  if ($value -gt '00:00:02.100' -and $value -lt '00:00:03.500') { $value }
} 'Physical pointer motion did not move the timeline cue.'
Click-Control '撤销'
Wait-Condition { (Read-TimelineField '开始时间') -ceq '00:00:02.000' } 'One undo did not restore the original timing.' | Out-Null
Assert-Condition (!(Get-Control '撤销' $types::Button).Current.IsEnabled) 'Physical dragging created more than one undo entry.'
Click-Control '重做'
Wait-Condition { (Read-TimelineField '开始时间') -ceq $moved } 'Redo did not restore the complete drag.' | Out-Null
$report.checks.process = $true
Timeline-Pass 'dragAndUndoRedo'

$stage = 'timeline-exact-edit'
(Get-TimelineField '开始时间').SetValue('00:00:02.375')
(Get-TimelineField '结束时间').SetValue('00:00:04.750')
Click-Control '应用编辑'
Wait-Condition {
  (Read-TimelineField '开始时间') -ceq '00:00:02.375' -and (Read-TimelineField '结束时间') -ceq '00:00:04.750'
} 'Exact input did not retain millisecond precision.' | Out-Null
Click-Control '打开字幕'
Click-Control '取消'
Wait-Condition { (Read-TimelineField '开始时间') -ceq '00:00:02.375' } 'Cancelling the file switch lost the edit.' | Out-Null
Timeline-Pass 'switchCancelRetainsDraft'

$stage = 'timeline-close-cancel'
Assert-Condition ($process.CloseMainWindow()) 'Could not request a Windows close for the owned application.'
Click-Control '取消'
Wait-Condition { (Read-TimelineField '开始时间') -ceq '00:00:02.375' } 'Cancelling the Windows close lost the edit.' | Out-Null
Timeline-Pass 'closeCancelRetainsDraft'

$stage = 'timeline-export'
Click-Control '另存为'
$cancelDialog = Get-Dialog '导出处理结果（已有文件会自动添加序号）'
[SubtitleSmokeNative]::DialogCommand($cancelDialog, 2)
Wait-DialogClosed
Wait-Condition { (Read-TimelineField '开始时间') -ceq '00:00:02.375' } 'Cancelling the native Save As lost the edit.' | Out-Null
Click-Control '另存为'
Select-DialogPath '导出处理结果（已有文件会自动添加序号）' $timelineOutput
Wait-Condition { Test-Path -LiteralPath $timelineOutput } 'Native timeline output was not created.' | Out-Null
$expected = $timelineText.Replace('00:00:02,000 --> 00:00:04,000', '00:00:02,375 --> 00:00:04,750')
$bom = [Text.UTF8Encoding]::new($true)
$expectedBytes = [byte[]]($bom.GetPreamble() + $bom.GetBytes($expected))
Assert-Condition ([Convert]::ToBase64String([IO.File]::ReadAllBytes($timelineOutput)) -ceq [Convert]::ToBase64String($expectedBytes)) 'Timeline output did not preserve BOM, CRLF, Unicode, lines and edited times.'
$report.checks.export = $true
Timeline-Pass 'exactEditAndBytes'

$stage = 'timeline-close-save'
(Get-TimelineField '开始时间').SetValue('00:00:02.500')
Assert-Condition ($process.CloseMainWindow()) 'Could not request close with a pending inspector edit.'
Click-Control '保存并继续'
Select-DialogPath '导出处理结果（已有文件会自动添加序号）' $timelineCloseOutput
Assert-Condition ($process.WaitForExit(10000) -and $process.ExitCode -eq 0) 'Save and continue did not close the real window normally.'
$report.shutdown = $true
Assert-Condition ([IO.File]::ReadAllText($timelineCloseOutput, $utf8) -ceq $expected.Replace('00:00:02,375', '00:00:02,500')) 'Close and save did not include the pending inspector value.'
Timeline-Pass 'closeSaveAndExit'
Assert-Condition ((Get-FileHash -LiteralPath $timelineSource -Algorithm SHA256).Hash -ceq $timelineSourceHash) 'The native timeline modified the source SRT.'
$report.originalPreserved = $true
$report.preservedSourceCount = 1 + [int]$report.preservedSourceCount
Timeline-Pass 'sourceUnchanged'
