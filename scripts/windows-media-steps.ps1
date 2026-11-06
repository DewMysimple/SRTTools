if (!(Get-Command Find-Text -ErrorAction SilentlyContinue)) {
  . (Join-Path $PSScriptRoot 'windows-native-controls.ps1')
}
$report.mediaChecks = [ordered]@{}

function Media-Pass([string] $Name) {
  $report.mediaChecks[$Name] = $true
  Write-Host ('PASS native media ' + $Name)
}

function Media-Field([string] $Name) {
  (Get-Control $Name $types::Edit).GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
}

function Read-MediaPosition {
  (Get-Control '视频进度' $types::Slider).GetCurrentPattern([System.Windows.Automation.RangeValuePattern]::Pattern).Current.Value
}

function Jump-Media([string] $Timestamp, [int] $Milliseconds) {
  (Media-Field '跳转视频时间').SetValue($Timestamp)
  Click-Control '跳转视频'
  Wait-Condition {
    (Read-MediaPosition) -eq $Milliseconds -and (Find-Text '^视频已暂停$')
  } ("Paused video did not seek to " + $Timestamp) | Out-Null
}

function Media-OverlayContains([string] $Text) {
  $overlay = Find-Control '视频字幕叠加'
  if (!$overlay) { return $false }
  $name = Condition $element::NameProperty $Text
  [bool]$overlay.FindFirst($scope::Descendants, $name)
}

function Media-FileWritable([string] $Path) {
  try {
    $file = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite)
    $file.Dispose()
    return $true
  } catch {
    if (($_.Exception.GetBaseException().HResult -band 65535) -eq 32) { return $false }
    throw
  }
}

$stage = 'media-picker-metadata'
$mediaSource = Join-Path $testRoot '预览 # 视频 (🐱).mp4'
$mediaAlternate = Join-Path $testRoot '预览 # 更换 (🐱).mp4'
$mediaBroken = Join-Path $testRoot '预览 # 损坏.mp4'
$mediaSrt = Join-Path $testRoot '预览 # 字幕 (🐱).srt'
$sample = Join-Path $testRoot 'synthetic-media.mp4'
& node (Join-Path $PSScriptRoot 'generate-media-fixture.mjs') $sample
Assert-Condition ($LASTEXITCODE -eq 0) 'Could not generate the local H.264/AAC test media.'
$mediaSampleHash = (Get-FileHash -LiteralPath $sample -Algorithm SHA256).Hash
$report.mediaSampleSha256 = $mediaSampleHash
$report.mediaSampleBytes = (Get-Item -LiteralPath $sample).Length
[IO.File]::Copy($sample, $mediaSource)
[IO.File]::Copy($sample, $mediaAlternate)
[IO.File]::WriteAllText($mediaBroken, 'Synthetic damaged MP4 data', $utf8)
[IO.File]::WriteAllText($mediaSrt, "1`n00:00:01,000 --> 00:00:02,500`n甲字幕 🐱`n`n2`n00:00:02,000 --> 00:00:03,500`n<script>乙字幕</script>`n`n3`n00:00:05,000 --> 00:00:07,000`n后段字幕`n`n4`n00:00:08,200 --> 00:00:09,000`n片尾以后`n", $utf8)
$mediaSrtHash = (Get-FileHash -LiteralPath $mediaSrt -Algorithm SHA256).Hash
$mediaBrokenHash = (Get-FileHash -LiteralPath $mediaBroken -Algorithm SHA256).Hash
(Get-Control '字幕时间轴' $types::Hyperlink).GetCurrentPattern($invoke).Invoke()
Click-Control '打开字幕'
Select-DialogPath '选择时间轴字幕' $mediaSrt
Wait-Condition { (Media-Field '开始时间').Current.Value -ceq '00:00:01.000' } 'Media workspace did not load the SRT.' | Out-Null
Click-Control '关联视频'
Select-DialogPath '选择本地视频' $mediaSource
Wait-Condition { Find-Text '^视频就绪$' } 'The selected local MP4 did not load valid video metadata.' | Out-Null
$range = (Get-Control '视频进度' $types::Slider).GetCurrentPattern([System.Windows.Automation.RangeValuePattern]::Pattern)
Assert-Condition ($range.Current.Maximum -eq 8000 -and $range.Current.Value -eq 0) 'Local MP4 metadata did not report the expected eight-second duration.'
Assert-Condition (!(Media-FileWritable $mediaSource)) 'The selected video was not pinned against writes.'
Media-Pass 'unicodePickerAndMetadata'

$stage = 'media-synchronized-seeks'
Jump-Media '00:00:00.400' 400
Assert-Condition (!(Media-OverlayContains '甲字幕 🐱')) 'The video overlay displayed a cue before its start.'
Jump-Media '00:00:02.200' 2200
Wait-Condition { (Media-OverlayContains '甲字幕 🐱') -and (Media-OverlayContains '<script>乙字幕</script>') } 'The actual overlay did not display both overlapping cues as text.' | Out-Null
Jump-Media '00:00:04.000' 4000
Assert-Condition (!(Media-OverlayContains '甲字幕 🐱') -and !(Media-OverlayContains '<script>乙字幕</script>')) 'Overlapping cues remained visible in the next gap.'
Click-Control '列表字幕 3'
Click-Control '定位字幕'
Wait-Condition { (Read-MediaPosition) -eq 5000 -and (Media-OverlayContains '后段字幕') } 'Cue navigation did not seek the actual media and update its overlay.' | Out-Null
Wait-Condition { Find-Text '1 条超出视频时长' } 'A cue outside the video duration was not reported.' | Out-Null
Jump-Media '00:00:07.600' 7600
Assert-Condition (!(Media-OverlayContains '片尾以后')) 'The video displayed a cue outside the media duration.'
Media-Pass 'seekAndOverlay'

$stage = 'media-playback-controls'
Click-Control '静音'
[void](Get-Control '取消静音' $types::Button)
Select-Option '倍速' '1.5×'
$volume = (Get-Control '音量' $types::Slider).GetCurrentPattern([System.Windows.Automation.RangeValuePattern]::Pattern)
$volume.SetValue(72)
Wait-Condition { $volume.Current.Value -eq 72 } 'The video volume slider did not update.' | Out-Null
Click-Control '播放视频'
Wait-Condition { (Find-Text '^播放结束$') -and (Read-MediaPosition) -eq 8000 } 'Playing from the tail did not finish at the actual duration.' | Out-Null
Jump-Media '00:00:01.000' 1000
Click-Control '播放视频'
Wait-Condition { (Find-Text '^正在播放$') -and (Read-MediaPosition) -gt 1050 } 'Playback did not advance from the seeked position.' | Out-Null
Click-Control '暂停视频'
Wait-Condition { Find-Text '^视频已暂停$' } 'The actual video did not pause.' | Out-Null
$pausedPosition = Read-MediaPosition
Start-Sleep -Milliseconds 300
Assert-Condition ((Read-MediaPosition) -eq $pausedPosition) 'The media clock moved after pause.'
Media-Pass 'playPauseRateVolumeAndEnd'

$stage = 'media-loop'
$disclosure = Get-Control 'A/B 区间循环'
$expander = $null
if ($disclosure.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$expander)) {
  $expander.Expand()
} else { $disclosure.GetCurrentPattern($invoke).Invoke() }
(Media-Field 'A 点').SetValue('00:00:01.000')
(Media-Field 'B 点').SetValue('00:00:00.900')
Click-Control '应用循环'
Wait-Condition { Find-Text '循环需满足' } 'Reversed A/B points did not report a validation error.' | Out-Null
(Media-Field 'B 点').SetValue('00:00:02.500')
Click-Control '应用循环'
Jump-Media '00:00:01.000' 1000
Click-Control '播放视频'
Wait-Condition { (Read-MediaPosition) -ge 1850 } 'A/B playback never approached the end of the interval.' | Out-Null
Wait-Condition { (Read-MediaPosition) -ge 1000 -and (Read-MediaPosition) -lt 1600 } 'A/B playback did not return to its start.' | Out-Null
Click-Control '暂停视频'
Click-Control '清除循环'
Jump-Media '00:00:02.400' 2400
Click-Control '播放视频'
Wait-Condition { (Read-MediaPosition) -gt 2550 } 'Cleared A/B loop still moved playback back.' | Out-Null
Click-Control '暂停视频'
Media-Pass 'validatedLoopAndClear'

$stage = 'media-picker-cancel'
Click-Control '列表字幕 1'
(Media-Field '开始时间').SetValue('00:00:01.125')
Click-Control '应用编辑'
Click-Control '更换视频'
$picker = Get-Dialog '选择本地视频'
[SubtitleSmokeNative]::DialogCommand($picker, 2)
Wait-DialogClosed
Wait-Condition { (Find-Text '^视频已暂停$') -and !(Media-FileWritable $mediaSource) } 'Cancelling the video picker lost the active video.' | Out-Null
$stage = 'media-decode-error-draft'
Click-Control '更换视频'
Select-DialogPath '选择本地视频' $mediaBroken
Wait-Condition { Find-Text '无法解码此视频' } 'Damaged video did not show a readable decode error.' | Out-Null
Assert-Condition ((Media-Field '开始时间').Current.Value -ceq '00:00:01.125') 'Decode failure changed the edited subtitle.'
Assert-Condition ((Media-FileWritable $mediaSource) -and (Media-FileWritable $mediaBroken)) 'Decode failure kept the old or broken video pinned.'
Click-Control '撤销'
Wait-Condition { (Media-Field '开始时间').Current.Value -ceq '00:00:01.000' } 'Undo stopped working after a video error.' | Out-Null
Media-Pass 'cancelAndDecodeErrorRetainDraft'

$stage = 'media-switch-release'
Click-Control '更换视频'
Select-DialogPath '选择本地视频' $mediaSource
Wait-Condition { Find-Text '^视频就绪$' } 'A valid video could not be reopened after a decode error.' | Out-Null
Click-Control '更换视频'
Select-DialogPath '选择本地视频' $mediaAlternate
Wait-Condition { (Find-Text '^视频就绪$') -and !(Media-FileWritable $mediaAlternate) } 'The replacement media did not become ready.' | Out-Null
Assert-Condition (Media-FileWritable $mediaSource) 'Switching videos did not release the original.'
Click-Control '关闭视频'
Wait-Condition { !(Find-Control '关闭视频' $types::Button) -and (Media-FileWritable $mediaAlternate) } 'Closing video did not release the current native handle.' | Out-Null
Media-Pass 'switchReopenAndRelease'
foreach ($path in @($mediaSource, $mediaAlternate, $mediaBroken, $mediaSrt)) {
  $expectedHash = if ($path -eq $mediaBroken) { $mediaBrokenHash } elseif ($path -eq $mediaSrt) { $mediaSrtHash } else { $mediaSampleHash }
  Assert-Condition ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ceq $expectedHash) 'A source media or subtitle fixture changed.'
}
$report.originalPreserved = $true
$report.preservedSourceCount = 4 + [int]$report.preservedSourceCount
Media-Pass 'sourcesUnchanged'
