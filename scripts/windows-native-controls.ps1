# Shared UIA controls for feature and folder acceptance scenarios.
Add-Type -AssemblyName System.IO.Compression.FileSystem
$report.featureChecks = [ordered]@{}
$originalHashes = [Collections.Generic.Dictionary[string,string]]::new()
$allElements = [System.Windows.Automation.Condition]::TrueCondition

function Feature-Pass([string] $Name) {
  $report.featureChecks[$Name] = 'PASS'
  Write-Host ("PASS native feature " + $Name)
}

function Find-Text([string] $Expression) {
  $nodes = $application.FindAll($scope::Descendants, (Condition $element::ControlTypeProperty $types::Text))
  $match = $nodes | Where-Object { $_.Current.Name -match $Expression } | Select-Object -First 1
  if ($match) { return $match }
  # React text expressions can be separate accessibility nodes around numbers.
  $combined = (($nodes | ForEach-Object { [string]$_.Current.Name }) -join ' ') -replace '\s+', ' '
  if ($combined -match $Expression) { return $true }
}

function Open-Tool([string] $Title) {
  (Get-Control '全部工具' $types::Hyperlink).GetCurrentPattern($invoke).Invoke()
  [void](Get-Control '搜索工具' $types::Edit)
  Wait-Condition {
    $tool = $application.FindAll($scope::Descendants, (Condition $element::ControlTypeProperty $types::Hyperlink)) |
      Where-Object { $_.Current.Name -eq $Title -or ([string]$_.Current.Name).Contains($Title + ' ') } |
      Select-Object -First 1
    if (!$tool) { return $false }
    try { $tool.GetCurrentPattern($invoke).Invoke(); return $true }
    catch {
      if ($_.Exception.GetBaseException() -is [System.Windows.Automation.ElementNotAvailableException]) { return $false }
      throw
    }
  } 'Requested subtitle tool was not available.' | Out-Null
  [void](Get-Control '选择文件' $types::Button)
}

function Import-Fixture([string] $Path) {
  if (Find-Control '清空' $types::Button) { Click-Control '清空' }
  Click-Control '选择文件'
  Select-DialogPath '选择字幕文件' $Path
  [void](Get-Control ('移除 ' + [IO.Path]::GetFileName($Path)) $types::Button)
  $originalHashes[$Path] = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
  $report.checks.import = $true
}

function Expand-ExportOptions {
  if (Find-Control '输出编码' $types::ComboBox) { return }
  $summary = Wait-Condition {
    $application.FindAll($scope::Descendants, $allElements) |
      Where-Object { ([string]$_.Current.Name).StartsWith('输入与导出选项') -and
        ($_.GetSupportedPatterns().Id -contains $invoke.Id -or
          $_.GetSupportedPatterns().Id -contains [System.Windows.Automation.ExpandCollapsePattern]::Pattern.Id) } |
      Select-Object -First 1
  } 'Export option disclosure was not available.'
  $expander = $null
  if ($summary.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$expander)) {
    $expander.Expand()
  } else { $summary.GetCurrentPattern($invoke).Invoke() }
  [void](Get-Control '输出编码' $types::ComboBox)
}

function Select-Option([string] $Field, [string] $Label) {
  $ready = Wait-Condition {
    $candidate = Find-Control $Field $types::ComboBox
    if (!$candidate -or !$candidate.Current.IsEnabled) { return $false }
    $pattern = $null
    if ($candidate.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern,[ref]$pattern)) {
      return @{control=$candidate;pattern=$pattern}
    }
  } 'Native combo box was not ready for selection.'
  $control = $ready.control
  $expanded = $ready.pattern
  $expanded.Expand()
  $option = Wait-Condition {
    $condition = New-Object System.Windows.Automation.AndCondition(
      (Condition $element::NameProperty $Label),
      (Condition $element::ControlTypeProperty $types::ListItem))
    $candidate = $application.FindFirst($scope::Descendants, $condition)
    if ($candidate) { return $candidate }
    foreach ($window in $desktop.FindAll($scope::Children, $allElements)) {
      if ($window.Current.ProcessId -eq $process.Id) {
        $candidate = $window.FindFirst($scope::Descendants, $condition)
        if ($candidate) { return $candidate }
      }
    }
  } 'Requested native combo-box option was not available.'
  $option.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select()
}

function Run-Success {
  Click-Control '预览处理结果'
  [void](Get-Control '另存为' $types::Button)
  $report.checks.process = $true
}

function Save-Single([string] $Name, [string] $Extension = 'srt') {
  $destination = Join-Path $testRoot ($Name + '.' + $Extension)
  Click-Control '另存为'
  Select-DialogPath '导出处理结果（已有文件会自动添加序号）' $destination
  Wait-Condition { Test-Path -LiteralPath $destination } 'Expected native export was not created.' | Out-Null
  $report.checks.export = $true
  $destination
}

function Assert-Bytes([string] $Path, [byte[]] $Expected) {
  Assert-Condition ([Convert]::ToBase64String([IO.File]::ReadAllBytes($Path)) -eq
    [Convert]::ToBase64String($Expected)) 'Native output bytes did not match the independent expected fixture.'
}

function Assert-Zip([string] $Name, [byte[]] $Expected) {
  $destination = Join-Path $testRoot ($Name + '.zip')
  Click-Control '导出 ZIP'
  Select-DialogPath '导出处理结果（已有文件会自动添加序号）' $destination
  Wait-Condition { Test-Path -LiteralPath $destination } 'Expected native ZIP was not created.' | Out-Null
  $archive = [IO.Compression.ZipFile]::OpenRead($destination)
  try {
    Assert-Condition ($archive.Entries.Count -eq 1) 'Native ZIP did not contain exactly the processed file.'
    $entry = $archive.Entries[0].Open()
    $buffer = [IO.MemoryStream]::new()
    try {
      $entry.CopyTo($buffer)
      Assert-Condition ([Convert]::ToBase64String($buffer.ToArray()) -eq [Convert]::ToBase64String($Expected)) 'ZIP entry bytes differed from native single-file export.'
    } finally { $entry.Dispose(); $buffer.Dispose() }
  } finally { $archive.Dispose() }
}
