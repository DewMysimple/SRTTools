. (Join-Path $PSScriptRoot 'windows-native-controls.ps1')

$prefix = "1`r`n00:00:01,123 --> 00:00:03,456`r`n"
$suffix = "`r`n"
$chineseInput = Join-Path $testRoot '中文.srt'
$emojiInput = Join-Path $testRoot '补充字符.srt'
[IO.File]::WriteAllText($chineseInput, ($prefix + '中文' + $suffix), $utf8)
[IO.File]::WriteAllText($emojiInput, ($prefix + '😀' + $suffix), $utf8)

$stage = 'feature-gbk'
Open-Tool '编码与换行'
Import-Fixture $chineseInput
Expand-ExportOptions
Select-Option '输出编码' 'GBK（严格无损）'
Run-Success
$gbkExpected = [Text.Encoding]::ASCII.GetBytes($prefix) + [byte[]]@(0xD6, 0xD0, 0xCE, 0xC4) + [Text.Encoding]::ASCII.GetBytes($suffix)
$gbkOutput = Save-Single 'gbk-single'
Assert-Bytes $gbkOutput $gbkExpected
Assert-Zip 'gbk-zip' $gbkExpected
Feature-Pass 'GBK_D6D0CEC4_single_and_zip'

$stage = 'feature-gbk-reject'
Import-Fixture $emojiInput
$beforeRejectedFiles = @(Get-ChildItem -LiteralPath $testRoot -File -Force | Select-Object -ExpandProperty Name)
Click-Control '预览处理结果'
Wait-Condition { Find-Text '第 1 条字幕.*U\+1F600|U\+1F600.*第 1 条字幕' } 'GBK did not identify the unrepresentable cue and code point.' | Out-Null
Assert-Condition (!(Find-Control '另存为' $types::Button) -and !(Find-Control '导出 ZIP' $types::Button)) 'Rejected GBK output remained exportable.'
Assert-Condition (!(Find-Dialog)) 'Rejected GBK processing opened a native output dialog.'
$afterRejectedFiles = @(Get-ChildItem -LiteralPath $testRoot -File -Force | Select-Object -ExpandProperty Name)
Assert-Condition (($beforeRejectedFiles -join '|') -eq ($afterRejectedFiles -join '|')) 'Rejected GBK processing created a partial output.'
Feature-Pass 'GBK_unrepresentable_rejected_without_output'

$stage = 'feature-gb18030'
Select-Option '输出编码' 'GB18030（严格无损）'
Run-Success
$gb18030Expected = [Text.Encoding]::ASCII.GetBytes($prefix) + [byte[]]@(0x94, 0x39, 0xFC, 0x36) + [Text.Encoding]::ASCII.GetBytes($suffix)
$gb18030Output = Save-Single 'gb18030-single'
Assert-Bytes $gb18030Output $gb18030Expected
Assert-Zip 'gb18030-zip' $gb18030Expected
Feature-Pass 'GB18030_9439FC36_single_and_zip'

$stage = 'feature-manual-legacy-input'
$legacyInput = Join-Path $testRoot '旧编码.srt'
[IO.File]::WriteAllBytes($legacyInput, $gbkExpected)
Open-Tool '编码与换行'
Import-Fixture $legacyInput
Click-Control '预览处理结果'
Wait-Condition { Find-Text '编码|UTF-8' } 'Legacy input did not present an encoding diagnostic.' | Out-Null
Assert-Condition (!(Find-Control '另存为' $types::Button)) 'Legacy encoding was implicitly accepted.'
Expand-ExportOptions
Select-Option '输入文件编码' 'GBK（仅手动选择）'
Run-Success
$legacyOutput = Save-Single 'legacy-manual'
Assert-Bytes $legacyOutput ($utf8.GetBytes($prefix + '中文' + $suffix))
Feature-Pass 'GBK_input_requires_manual_selection'

$stage = 'feature-chinese-srt'
$srtText = "8`n00:00:01,123 --> 00:00:03,456`n<i title=`"头发`">头发 理发 发现 干杯 干部 后面 皇后</i> {姓名}`nEnglish 123 😀`n"
$srtExpected = $srtText.Replace('>头发 理发 发现 干杯 干部 后面 皇后<', '>頭髮 理髮 發現 乾杯 幹部 後面 皇后<')
$srtInput = Join-Path $testRoot '原布局.srt'
[IO.File]::WriteAllText($srtInput, $srtText, $utf8)
Open-Tool '简繁转换'
Import-Fixture $srtInput
Run-Success
$srtOutput = Save-Single 'chinese-layout'
Assert-Bytes $srtOutput ($utf8.GetBytes($srtExpected))
Feature-Pass 'Chinese_SRT_body_only_layout_index_markup_preserved'

$stage = 'feature-chinese-ass'
$assText = @'
[Script Info]
Title: 头发
ScriptType: v4.00+

[V4+ Styles]
Format: Name, Fontname
Style: 简体,微软雅黑

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Comment: 0,0:00:00.00,0:00:01.00,简体,,0,0,0,,头发
Dialogue: 2,0:00:01.23,0:00:02.34,简体,说话人,10,20,30,,{\fn微软雅黑\an8}头发\N理发\h发现
'@
$assText = $assText.Replace("`r`n", "`n").Replace("`n", "`r`n") + "`r`n"
$assExpected = $assText.Replace('}头发\N理发\h发现', '}頭髮\N理髮\h發現')
$assInput = Join-Path $testRoot '原样式.ass'
[IO.File]::WriteAllText($assInput, $assText, $utf8)
Import-Fixture $assInput
Run-Success
$assOutput = Save-Single 'chinese-style' 'ass'
Assert-Bytes $assOutput ($utf8.GetBytes($assExpected))
Feature-Pass 'Chinese_ASS_body_only_headers_comments_styles_controls_preserved'

$stage = 'feature-chinese-preset'
Select-Option '转换方向' '繁体 → 简体'
Click-Control '保存为新预设'
$name = Get-Control '预设名称' $types::Edit
$name.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue('Native Reverse')
Click-Control '确认保存'
Wait-Condition { !(Find-Control '确认保存' $types::Button) } 'Chinese direction preset did not save.' | Out-Null
Assert-Condition ($process.CloseMainWindow() -and $process.WaitForExit(8000)) 'Preset restart did not close the application.'
$process = Start-Process -FilePath $ExePath -WindowStyle Hidden -PassThru
$application = Get-ApplicationWindow $process
$applicationHandle = [IntPtr]::new($application.Current.NativeWindowHandle)
Open-Tool '简繁转换'
Import-Fixture $srtOutput
Select-Option '参数预设' 'Native Reverse'
Click-Control '应用预设'
Assert-Condition (!(Find-Control '另存为' $types::Button)) 'Applying the Chinese preset implicitly processed old output.'
Run-Success
$reverseOutput = Save-Single 'chinese-reverse'
Assert-Bytes $reverseOutput ($utf8.GetBytes($srtText))
Feature-Pass 'Chinese_direction_preset_survives_process_restart'

foreach ($fixture in $originalHashes.Keys) {
  Assert-Condition ((Get-FileHash -LiteralPath $fixture -Algorithm SHA256).Hash -eq $originalHashes[$fixture]) 'A source fixture changed during native feature acceptance.'
}
$report.originalPreserved = $true
$report.preservedSourceCount = $originalHashes.Count
