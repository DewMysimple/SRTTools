# Real native workflow acceptance. All fixtures and output roots belong to the runner's GUID directory.
. (Join-Path $PSScriptRoot 'windows-native-controls.ps1')
$report.workflowChecks = [ordered]@{}
foreach ($check in @('fourStepWorkflow','previewAndExecutionBytes','presetRestartRoundTrip','nativePresetJsonExchange','invalidPresetPreservesStore','nestedDirectoryWrite','multiRootZipManifest','sourceOverlapRejected','failedWriteRetry','cancelRetry')) { $report.workflowChecks[$check] = $false }
$workflowPermissions = [Collections.Generic.List[object]]::new()
$fixtureText = "9`n00:00:01,000 --> 00:00:02,000`n  错词   中文 😀  `n`n12`n00:00:03,000 --> 00:00:04,000`n$([char]0x200b)`n`n14`n00:00:05,000 --> 00:00:06,000`n  另一行  `n"
$expectedBytes = $utf8.GetBytes("1`r`n00:00:01,500 --> 00:00:02,500`r`n正确 中文 😀`r`n`r`n2`r`n00:00:05,500 --> 00:00:06,500`r`n另一行`r`n")

function Workflow-Pass([string] $Name) { $report.workflowChecks[$Name] = $true; Feature-Pass ('Workflow_' + $Name) }
function Set-WorkflowField([string] $Name, [string] $Value) {
  $control = Wait-Condition {
    $application.FindAll($scope::Descendants,(Condition $element::NameProperty $Name)) | Where-Object {
      $patterns = $_.GetSupportedPatterns().Id
      $patterns -contains [System.Windows.Automation.ValuePattern]::Pattern.Id -or $patterns -contains [System.Windows.Automation.RangeValuePattern]::Pattern.Id
    } | Select-Object -First 1
  } ('Editable workflow field was not ready: ' + $Name)
  $pattern = $null
  if ($control.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) { $pattern.SetValue($Value) }
  elseif ($control.TryGetCurrentPattern([System.Windows.Automation.RangeValuePattern]::Pattern, [ref]$pattern)) { $pattern.SetValue([double]::Parse($Value,[Globalization.CultureInfo]::InvariantCulture)) }
  else { throw ('Editable native field did not expose a supported pattern: ' + $Name) }
}
function Invoke-WorkflowChild($Parent, [string] $Name) {
  $control = Wait-Condition {
    $candidate = $Parent.FindFirst($scope::Descendants, (New-Object System.Windows.Automation.AndCondition((Condition $element::NameProperty $Name), (Condition $element::ControlTypeProperty $types::Button))))
    if ($candidate -and $candidate.Current.IsEnabled) { $candidate }
  } ('Scoped workflow action was not ready: ' + $Name)
  $control.GetCurrentPattern($invoke).Invoke()
}
function Open-Workflow {
  $link = Wait-Condition {
    $application.FindAll($scope::Descendants,(Condition $element::ControlTypeProperty $types::Hyperlink)) | Where-Object { ([string]$_.Current.Name).StartsWith('批量处理') } | Select-Object -First 1
  } 'Batch navigation was not available.'
  $link.GetCurrentPattern($invoke).Invoke(); Click-Control '处理流程'
  [void](Get-Control '添加处理步骤' $types::Button)
}
function Restart-WorkflowApp {
  Assert-Condition ($process.CloseMainWindow() -and $process.WaitForExit(10000)) 'Workflow restart did not exit normally.'
  $script:process = Start-Process -FilePath $ExePath -WindowStyle Hidden -PassThru
  $script:application = Get-ApplicationWindow $process
  $script:applicationHandle = [IntPtr]::new($application.Current.NativeWindowHandle)
  Open-Workflow
}
function New-WorkflowFixture([string] $Directory, [string] $Name, [string] $Text = $fixtureText) {
  [IO.Directory]::CreateDirectory($Directory) | Out-Null
  $path = Join-Path $Directory $Name
  [IO.File]::WriteAllText($path,$Text,$utf8)
  $originalHashes[$path] = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash
  $path
}
function Workflow-QueueCount {
  @($application.FindAll($scope::Descendants,(Condition $element::ControlTypeProperty $types::Button)) | Where-Object { ([string]$_.Current.Name).StartsWith('移除 ') -and !([string]$_.Current.Name).StartsWith('移除步骤 ') }).Count
}
function Clear-WorkflowQueue {
  if (Find-Control '清空' $types::Button) { Click-Control '清空' }
  Wait-Condition { (Workflow-QueueCount) -eq 0 } 'Workflow input queue was not cleared.' | Out-Null
}
function Set-WorkflowCheckbox([string] $Name, [bool] $Enabled) {
  $pattern = (Get-Control $Name $types::CheckBox).GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
  if (($pattern.Current.ToggleState -eq [System.Windows.Automation.ToggleState]::On) -ne $Enabled) { $pattern.Toggle() }
}
function Choose-WorkflowFolder([string] $Title, [string] $Directory) {
  $full = [IO.Path]::GetFullPath($Directory)
  Assert-Condition ($full.StartsWith($testRoot + '\',[StringComparison]::OrdinalIgnoreCase)) 'Workflow directory escaped the owned fixture root.'
  $handle = Get-Dialog $Title
  Wait-Condition { [SubtitleSmokeNative]::SelectPath($handle,$full) } 'Workflow folder editor was not ready.' | Out-Null
  $selection = Wait-Condition {
    $dialog = Find-Dialog
    if (!$dialog) { return 'closed' }
    Assert-Condition ($dialog.Current.NativeWindowHandle -eq $handle.ToInt64()) 'Unexpected dialog interrupted workflow directory selection.'
    $address = $dialog.FindAll($scope::Descendants,$allElements) | Where-Object { $_.Current.AutomationId -eq '1001' -and ([string]$_.Current.Name).IndexOf($full,[StringComparison]::OrdinalIgnoreCase) -ge 0 } | Select-Object -First 1
    if ($address) { return 'navigated' }
  } 'Workflow folder picker did not navigate to the owned fixture.'
  if ($selection -eq 'navigated') { Assert-Condition ([SubtitleSmokeNative]::ConfirmCurrentFolder($handle) -or !(Find-Dialog)) 'Workflow folder could not be confirmed.' }
  Wait-DialogClosed
}
function Import-WorkflowFolder([string] $Directory) {
  Click-Control '添加文件夹'; Choose-WorkflowFolder '选择字幕文件夹' $Directory
  Wait-Condition { $button = Find-Control '添加文件夹' $types::Button; $button -and $button.Current.IsEnabled -and !(Find-Control '取消扫描' $types::Button) } 'Workflow native folder import did not finish.' 60000 | Out-Null
}
function Wait-WorkflowFinished {
  Wait-Condition { $button = Find-Control '开始处理' $types::Button; $button -and $button.Current.IsEnabled -and !(Find-Control '取消处理' $types::Button) } 'Workflow computation did not finish.' 120000 | Out-Null
}
function Save-WorkflowZip([string] $Name) {
  $path = Join-Path $testRoot ($Name + '.zip')
  Click-Control '导出 ZIP'; Select-DialogPath '导出处理结果（已有文件会自动添加序号）' $path
  Wait-Condition { Test-Path -LiteralPath $path } 'Native workflow ZIP was not written.' 60000 | Out-Null
  $report.checks.export = $true
  $path
}
function Assert-WorkflowZip([string] $Path, [hashtable] $Entries) {
  $archive = [IO.Compression.ZipFile]::OpenRead($Path)
  try {
    Assert-Condition ($archive.Entries.Count -eq $Entries.Count) 'Workflow ZIP file count did not match the reviewed plan.'
    foreach ($name in $Entries.Keys) {
      $entry = $archive.GetEntry($name); Assert-Condition ([bool]$entry) 'A reviewed workflow ZIP path was missing.'
      $stream = $entry.Open(); $buffer = [IO.MemoryStream]::new()
      try { $stream.CopyTo($buffer); Assert-Condition ([Convert]::ToBase64String($buffer.ToArray()) -eq [Convert]::ToBase64String([byte[]]$Entries[$name])) 'Native workflow ZIP bytes did not match the independent expected output.' }
      finally { $stream.Dispose(); $buffer.Dispose() }
    }
  } finally { $archive.Dispose() }
}
function Prepare-WorkflowDirectory([string] $Directory, [bool] $Retry = $false) {
  if ($Retry) { Click-Control '重试未导出项：选择目录' } else { Click-Control '选择输出目录并预览' }
  Choose-WorkflowFolder '选择独立输出文件夹（不覆盖源文件）' $Directory
}
function Read-WorkflowPresets {
  $storeData = [IO.File]::ReadAllText($storePath) | ConvertFrom-Json
  @{ tools=$storeData.'tool-presets-v1'; workflows=$storeData.'workflow-presets-v1' } | ConvertTo-Json -Depth 30 -Compress
}

try {
  $stage = 'workflow-four-step-native-input'
  Open-Workflow
  foreach ($label in @('删除空白字幕','空格清理','查找和替换','整体时间偏移')) { Select-Option '添加步骤类型' $label; Click-Control '添加处理步骤' }
  Set-WorkflowField '查找内容' '错词'; Set-WorkflowField '替换为' '正确'; Set-WorkflowField '偏移量（毫秒）' '500'
  $inputA = New-WorkflowFixture (Join-Path $testRoot 'input-files') '第一份.srt'
  $inputB = New-WorkflowFixture (Join-Path $testRoot 'input-files') '第二份 (🐱).srt'
  Click-Control '选择文件'; Select-DialogPath '选择字幕文件' ('"' + $inputA + '" "' + $inputB + '"')
  Wait-Condition { (Workflow-QueueCount) -eq 2 } 'The two real SRT files were not imported.' | Out-Null
  $report.checks.import = $true
  Click-Control '预览影响'; Wait-WorkflowFinished
  [void](Get-Control '每一步实际变化摘要'); [void](Get-Control '字幕差异预览')
  $report.checks.process = $true
  $flatEntries = @{ '第一份_processed.srt'=$expectedBytes; '第二份 (🐱)_processed.srt'=$expectedBytes }
  $previewZip = Save-WorkflowZip 'workflow-preview'; Assert-WorkflowZip $previewZip $flatEntries
  Workflow-Pass 'fourStepWorkflow'
  Click-Control '开始处理'; Wait-WorkflowFinished
  $executedZip = Save-WorkflowZip 'workflow-executed'; Assert-WorkflowZip $executedZip $flatEntries
  Workflow-Pass 'previewAndExecutionBytes'

  $stage = 'workflow-presets-and-restart'
  $step = Get-Control '步骤 4 整体时间偏移'
  Invoke-WorkflowChild $step '保存为新预设'
  Set-WorkflowField '预设名称' 'Native Shift 500'; Click-Control '确认保存'
  Wait-Condition { !(Find-Control '确认保存' $types::Button) } 'Native tool preset did not save.' | Out-Null
  Set-WorkflowField '流程名称' 'Native Four Step'; Click-Control '保存流程'
  Click-Control '确认保存流程'
  Wait-Condition { !(Find-Control '确认保存流程' $types::Button) } 'Native workflow preset did not save.' | Out-Null
  Restart-WorkflowApp
  Assert-Condition (!(Find-Control '步骤 4 整体时间偏移')) 'A saved workflow was applied implicitly on restart.'
  Select-Option '已保存流程' 'Native Four Step'; Click-Control '应用流程'
  [void](Get-Control '步骤 4 整体时间偏移')
  $step = Get-Control '步骤 4 整体时间偏移'
  $combo = $step.FindFirst($scope::Descendants,(Condition $element::ControlTypeProperty $types::ComboBox))
  Assert-Condition ([bool]$combo) 'Restored workflow tool preset selector was missing.'
  # The shift preset is the sole preset of its tool; select it in the scoped native combo.
  $combo.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern).Expand()
  $option = Wait-Condition { $application.FindFirst($scope::Descendants,(New-Object System.Windows.Automation.AndCondition((Condition $element::NameProperty 'Native Shift 500'),(Condition $element::ControlTypeProperty $types::ListItem)))) } 'Native tool preset was not restored.'
  $option.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select()
  Invoke-WorkflowChild $step '应用预设'
  $stored = Read-WorkflowPresets
  Assert-Condition ($stored.Contains('Native Four Step') -and $stored.Contains('Native Shift 500')) 'Both native preset kinds were not persisted.'
  Workflow-Pass 'presetRestartRoundTrip'

  $stage = 'workflow-native-preset-json'
  Click-Control '导出预设 JSON'; Click-Control '全选工具预设'; Click-Control '全选流程预设'
  Set-WorkflowCheckbox '我已了解个人输入参数会随 JSON 分享' $true
  Click-Control '确认导出所选预设'
  $presetJson = Join-Path $testRoot 'native-presets.json'
  Select-DialogPath '导出处理结果（已有文件会自动添加序号）' $presetJson
  Wait-Condition { Test-Path -LiteralPath $presetJson } 'Native preset JSON was not exported.' | Out-Null
  $envelope = [IO.File]::ReadAllText($presetJson,$utf8) | ConvertFrom-Json
  Assert-Condition ($envelope.format -eq 'srttools-presets' -and @($envelope.items).Count -eq 2) 'Exported preset JSON did not contain both explicitly selected preset kinds.'
  Assert-Condition (!([IO.File]::ReadAllText($presetJson).Contains($testRoot))) 'Preset JSON contained an absolute fixture path.'
  $beforeConflict = (Get-FileHash -LiteralPath $storePath -Algorithm SHA256).Hash
  Click-Control '导入预设 JSON'; Select-DialogPath '导入 SRTTools 预设 JSON' $presetJson
  Wait-Condition { Find-Text '冲突 2 项' } 'Native JSON import did not display both conflicts.' | Out-Null
  Click-Control '取消'
  Assert-Condition ((Get-FileHash -LiteralPath $storePath -Algorithm SHA256).Hash -eq $beforeConflict) 'Cancelling a preset preview changed the old Store.'
  Click-Control '导入预设 JSON'; Select-DialogPath '导入 SRTTools 预设 JSON' $presetJson
  Select-Option '同名冲突策略' '自动改名后导入'; Click-Control '确认导入预设'
  Wait-Condition { !(Find-Control '确认导入预设' $types::Button) } 'Confirmed preset import did not complete.' | Out-Null
  Assert-Condition ((Read-WorkflowPresets).Contains('Native Four Step (2)')) 'Native conflict rename did not preserve and import the workflow.'
  Workflow-Pass 'nativePresetJsonExchange'
  $beforeBad = (Get-FileHash -LiteralPath $storePath -Algorithm SHA256).Hash
  $bad = Join-Path $testRoot 'bad-presets.json'; [IO.File]::WriteAllBytes($bad,[byte[]]@(255,254,0))
  Click-Control '导入预设 JSON'; Select-DialogPath '导入 SRTTools 预设 JSON' $bad
  Wait-Condition { Find-Text '文件不是有效的 UTF-8 JSON' } 'Malformed preset JSON lacked its native UI diagnostic.' | Out-Null
  Assert-Condition ((Get-FileHash -LiteralPath $storePath -Algorithm SHA256).Hash -eq $beforeBad) 'Malformed preset JSON changed the old Store.'
  $future = Join-Path $testRoot 'future-presets.json'; $envelope.schemaVersion = 999
  [IO.File]::WriteAllText($future,($envelope | ConvertTo-Json -Depth 25 -Compress),$utf8)
  Click-Control '导入预设 JSON'; Select-DialogPath '导入 SRTTools 预设 JSON' $future
  Wait-Condition { Find-Text '未来或不支持的版本' } 'Future preset envelope was not rejected.' | Out-Null
  Assert-Condition ((Get-FileHash -LiteralPath $storePath -Algorithm SHA256).Hash -eq $beforeBad) 'Future preset JSON changed the old Store.'
  Workflow-Pass 'invalidPresetPreservesStore'

  . (Join-Path $PSScriptRoot 'windows-workflow-output-steps.ps1')
  foreach ($fixture in $originalHashes.Keys) { Assert-Condition ((Get-FileHash -LiteralPath $fixture -Algorithm SHA256).Hash -eq $originalHashes[$fixture]) 'A workflow source fixture changed.' }
  Assert-Condition (!($report.workflowChecks.Values -contains $false)) 'A required native workflow check did not complete.'
  $report.originalPreserved = $true; $report.preservedSourceCount = $originalHashes.Count
} finally {
  foreach ($entry in $workflowPermissions) {
    $acl = [IO.Directory]::GetAccessControl($entry.path); $acl.RemoveAccessRuleSpecific($entry.rule); [IO.Directory]::SetAccessControl($entry.path,$acl)
  }
}
