# Executed on the real ZIP and installed payload, inside the existing isolated lease.
if (!('SubtitleDesktopInteraction' -as [type])) { . (Join-Path $PSScriptRoot 'windows-desktop-interaction.ps1') }
$report.precisionChecks = [ordered]@{}
function Precision-Pass([string] $Name) {
  $report.precisionChecks[$Name] = $true
  Write-Host ('PASS native precision ' + $Name)
}
function Wait-PrecisionTiming([string] $Start, [string] $End) {
  Wait-Condition {
    (Recovery-Field '开始时间').Current.Value -ceq $Start -and (Recovery-Field '结束时间').Current.Value -ceq $End
  } ('Expected subtitle timing was not available: ' + $Start + ' – ' + $End) | Out-Null
}
function Expand-PrecisionDisclosure([string] $Name) {
  $control = Get-Control $Name
  $pattern = $null
  if ($control.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$pattern)) {
    $pattern.Expand()
  } else { $control.GetCurrentPattern($invoke).Invoke() }
}

$stage = 'precision-window-and-input'
[void][SubtitleDesktopInteraction]::ShowWindow($applicationHandle, 9)
$screen = [Windows.Forms.Screen]::FromHandle($applicationHandle).WorkingArea
Assert-Condition ($screen.Width -ge 920 -and $screen.Height -ge 640) 'Desktop could not host the minimum window fixture.'
Assert-Condition ([SubtitleDesktopInteraction]::MoveWindow($applicationHandle, $screen.Left + 8, $screen.Top + 8, 900, 620, $true)) 'Could not size the owned native window.'
Wait-Condition {
  $bounds = $application.Current.BoundingRectangle
  [Math]::Abs($bounds.Width - 900) -le 4 -and [Math]::Abs($bounds.Height - 620) -le 4
} 'The native application did not reach its 900 × 620 fixture.' | Out-Null
$precisionSource = Join-Path $testRoot '精准 校时 🐱.srt'
$precisionOutput = Join-Path $testRoot '精准 校时结果.srt'
$combinedBody = "前段 🐱`n后段 e$([char]0x0301)"
$precisionText = "1`r`n00:00:01,000 --> 00:00:03,000`r`n" + $combinedBody.Replace("`n", "`r`n") + "`r`n`r`n2`r`n00:00:04,000 --> 00:00:06,500`r`n保持正文`r`n"
[IO.File]::WriteAllText($precisionSource, $precisionText, $utf8)
$report.precisionSourceSha256 = (Get-FileHash -LiteralPath $precisionSource -Algorithm SHA256).Hash
Recovery-Open $precisionSource
Wait-PrecisionTiming '00:00:01.000' '00:00:03.000'
Click-Control '下一条'
Wait-PrecisionTiming '00:00:04.000' '00:00:06.500'
Click-Control '上一条'
Wait-PrecisionTiming '00:00:01.000' '00:00:03.000'
Precision-Pass 'minimumWindowNavigation'

$stage = 'precision-video-endpoints'
Click-Control '关联视频'
Select-DialogPath '选择本地视频' $mediaSource
Wait-Condition { (Find-Text '^视频就绪$') -and !(Media-FileWritable $mediaSource) } 'Precision timing video did not load.' | Out-Null
Jump-Media '00:00:01.125' 1125
Click-Control '将当前时间设为开始'
Wait-PrecisionTiming '00:00:01.125' '00:00:03.000'
Jump-Media '00:00:02.750' 2750
Click-Control '将当前时间设为结束'
Wait-PrecisionTiming '00:00:01.125' '00:00:02.750'
Click-Control '下一条'
Wait-PrecisionTiming '00:00:04.000' '00:00:06.500'
Assert-Condition ((Read-MediaPosition) -eq 2750) 'Subtitle navigation unexpectedly sought the video.'
Click-Control '定位当前或最近字幕'
Wait-PrecisionTiming '00:00:01.125' '00:00:02.750'
[void](Recovery-Protected 2)
Precision-Pass 'liveMediaEndpointsAndNearest'

$stage = 'precision-preview-range'
Expand-PrecisionDisclosure 'A/B 区间循环'
(Media-Field 'A 点').SetValue('00:00:04.000')
(Media-Field 'B 点').SetValue('00:00:06.000')
Click-Control '应用循环'
Click-Control '预览选中字幕'
Wait-Condition { Find-Text '正在预览选中字幕' } 'Selected preview did not begin.' | Out-Null
Wait-Condition { !(Find-Control '停止区间预览' $types::Button) -and
  (Find-Text '^视频已暂停$') -and [Math]::Abs((Read-MediaPosition) - 3150) -le 25 } 'One-time preview did not pause at the padded end.' | Out-Null
Assert-Condition ((Media-Field 'A 点').Current.Value -ceq '00:00:04.000' -and
  (Media-Field 'B 点').Current.Value -ceq '00:00:06.000') 'Selected preview replaced user A/B values.'
Click-Control '播放视频'
Wait-Condition { (Read-MediaPosition) -ge 4000 -and (Read-MediaPosition) -lt 5000 } 'Playback did not resume from the saved A point.' | Out-Null
Click-Control '暂停视频'
Expand-PrecisionDisclosure '选中字幕预览设置'
$repeat = (Get-Control '循环预览' $types::CheckBox).GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
$repeat.Toggle()
Click-Control '预览选中字幕'
Wait-Condition { (Read-MediaPosition) -ge 2600 -and (Find-Control '停止区间预览' $types::Button) } 'Loop preview did not approach the end.' | Out-Null
Wait-Condition { (Read-MediaPosition) -ge 700 -and (Read-MediaPosition) -lt 1400 } 'Loop preview did not return to the selected range start.' | Out-Null
Click-Control '停止区间预览'
Wait-Condition { Find-Text '^视频已暂停$' } 'Stopping selected preview did not pause the actual video.' | Out-Null
Precision-Pass 'selectedPlaybackAndSavedAB'

$stage = 'precision-split'
Jump-Media '00:00:01.875' 1875
Click-Control '拆分字幕'
[void](Get-Control '拆分字幕预览')
Click-Control '取消拆分'
Wait-Condition { (Read-RecoveryText) -ceq $combinedBody } 'Cancelling split modified the original body.' | Out-Null
Click-Control '拆分字幕'
(Recovery-Field '前半段正文').SetValue('前段 🐱')
(Recovery-Field '后半段正文').SetValue("后段 e$([char]0x0301)")
Click-Control '确认拆分'
Wait-PrecisionTiming '00:00:01.875' '00:00:02.750'
Assert-Condition ((Read-RecoveryText) -ceq "后段 e$([char]0x0301)") 'Split did not select the second Unicode cue.'
Click-Control '撤销'
Click-Control '列表字幕 1'
Wait-PrecisionTiming '00:00:01.125' '00:00:02.750'
Assert-Condition ((Read-RecoveryText) -ceq $combinedBody -and !(Find-Control '列表字幕 3' $types::Button)) 'One undo did not reverse the entire split.'
Click-Control '重做'
[void](Get-Control '列表字幕 3' $types::Button)
Precision-Pass 'unicodeSplitAndUndo'

$stage = 'precision-two-point'
Expand-PrecisionDisclosure '两点校准'
(Recovery-Field '字幕锚点 1').SetValue('0')
(Recovery-Field '目标锚点 1').SetValue('0')
(Recovery-Field '字幕锚点 2').SetValue('10000')
(Recovery-Field '目标锚点 2').SetValue('10500')
Click-Control '计算校准预览'
[void](Get-Control '应用两点校准' $types::Button)
Click-Control '撤销'
Wait-Condition { !(Find-Control '应用两点校准' $types::Button) -and (Find-Text '请重新计算校准预览') } 'An older calibration preview remained usable after editing.' | Out-Null
Click-Control '重做'
Click-Control '计算校准预览'
Click-Control '应用两点校准'
Click-Control '列表字幕 1'
Wait-PrecisionTiming '00:00:01.181' '00:00:01.969'
Click-Control '列表字幕 2'
Wait-PrecisionTiming '00:00:01.969' '00:00:02.888'
Click-Control '列表字幕 3'
Wait-PrecisionTiming '00:00:04.200' '00:00:06.825'
Click-Control '撤销'
Wait-PrecisionTiming '00:00:04.000' '00:00:06.500'
Click-Control '列表字幕 1'
Wait-PrecisionTiming '00:00:01.125' '00:00:01.875'
Click-Control '重做'
Wait-PrecisionTiming '00:00:01.181' '00:00:01.969'
Assert-Condition (!(Media-FileWritable $mediaSource) -and
  (Media-Field 'A 点').Current.Value -ceq '00:00:04.000' -and
  (Media-Field 'B 点').Current.Value -ceq '00:00:06.000') 'Calibration interrupted the original media session or A/B.'
Precision-Pass 'stalePreviewAndCalibration'

$stage = 'precision-crash-recovery'
$latest = Recovery-Payload (Recovery-Protected 10)
Assert-Condition ($latest.draft.revision -eq 10 -and @($latest.draft.cues).Count -eq 3 -and
  $latest.draft.cues[0].startMs -eq 1181 -and $latest.draft.cues[0].endMs -eq 1969 -and
  $latest.draft.cues[1].startMs -eq 1969 -and $latest.draft.cues[2].startMs -eq 4200) 'The full calibration was not protected as one committed revision.'
Restart-RecoveryHost
Assert-Condition (Media-FileWritable $mediaSource) 'Forced exit after calibration retained the media handle.'
(Get-Control '管理本地草稿' $types::Hyperlink).GetCurrentPattern($invoke).Invoke()
Click-Control '恢复草稿'
Click-Control '确认恢复到时间轴'
Wait-PrecisionTiming '00:00:01.181' '00:00:01.969'
Click-Control '列表字幕 3'
Wait-PrecisionTiming '00:00:04.200' '00:00:06.825'
Precision-Pass 'calibratedDraftAfterForceExit'

$stage = 'precision-exact-export'
Click-Control '另存为'
Select-DialogPath '导出处理结果（已有文件会自动添加序号）' $precisionOutput
Wait-Condition { (Test-Path -LiteralPath $precisionOutput) -and !(Recovery-Latest) } 'Calibrated export did not retire the draft.' | Out-Null
$expected = "1`r`n00:00:01,181 --> 00:00:01,969`r`n前段 🐱`r`n`r`n2`r`n00:00:01,969 --> 00:00:02,888`r`n后段 e$([char]0x0301)`r`n`r`n3`r`n00:00:04,200 --> 00:00:06,825`r`n保持正文`r`n"
Assert-Condition ([Convert]::ToBase64String([IO.File]::ReadAllBytes($precisionOutput)) -ceq
  [Convert]::ToBase64String($utf8.GetBytes($expected))) 'Calibrated output bytes did not match both rounded endpoints and exact Unicode CRLF.'
Assert-Condition ((Get-FileHash -LiteralPath $precisionSource -Algorithm SHA256).Hash -ceq $report.precisionSourceSha256 -and
  (Get-FileHash -LiteralPath $mediaSource -Algorithm SHA256).Hash -ceq $mediaSampleHash) 'A precision source SRT or video changed.'
$report.precisionOutputSha256 = (Get-FileHash -LiteralPath $precisionOutput -Algorithm SHA256).Hash
$report.preservedSourceCount = 1 + [int]$report.preservedSourceCount
Precision-Pass 'exactExportAndSourceHashes'
