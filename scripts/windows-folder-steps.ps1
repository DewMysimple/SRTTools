. (Join-Path $PSScriptRoot 'windows-native-controls.ps1')

$folderLinks = [Collections.Generic.List[string]]::new()
$folderLocks = [Collections.Generic.List[IO.FileStream]]::new()
$folderPermissions = [Collections.Generic.Dictionary[string,object]]::new()
$fixtureText = "1`r`n00:00:01,123 --> 00:00:03,456`r`n合成文件夹 字幕 🐱`r`n"

function New-FolderFixture([string] $Directory, [string] $Name, [string] $Text = $fixtureText) {
  [IO.Directory]::CreateDirectory($Directory) | Out-Null
  $path = Join-Path $Directory $Name
  [IO.File]::WriteAllText($path, $Text, $utf8)
  $originalHashes[$path] = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash
  $path
}

function Queue-Buttons {
  @($application.FindAll($scope::Descendants, (Condition $element::ControlTypeProperty $types::Button)) |
    Where-Object { ([string]$_.Current.Name).StartsWith('移除 ') })
}

function Clear-Queue {
  if (Find-Control '清空' $types::Button) { Click-Control '清空' }
  Wait-Condition { @(Queue-Buttons).Count -eq 0 } 'The previous queue was not cleared.' | Out-Null
}

function Set-Recursive([bool] $Enabled) {
  $checkbox = Get-Control '包含子文件夹' $types::CheckBox
  $toggle = $checkbox.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
  if (($toggle.Current.ToggleState -eq [System.Windows.Automation.ToggleState]::On) -ne $Enabled) { $toggle.Toggle() }
}

function Select-FolderFixture([string] $Directory) {
  $full = [IO.Path]::GetFullPath($Directory)
  Assert-Condition ($full.StartsWith($testRoot + '\', [StringComparison]::OrdinalIgnoreCase)) 'Folder fixture escaped the owned test workspace.'
  Click-Control '添加文件夹'
  $handle = Get-Dialog '选择字幕文件夹'
  Wait-Condition { [SubtitleSmokeNative]::SelectPath($handle, $full) } 'Folder dialog editor was not ready.' | Out-Null
  $selection = Wait-Condition {
    $dialog = Find-Dialog
    if (!$dialog) { return 'closed' }
    Assert-Condition ($dialog.Current.NativeWindowHandle -eq $handle.ToInt64()) 'An unexpected folder dialog interrupted selection.'
    $address = $dialog.FindAll($scope::Descendants, $allElements) |
      Where-Object { $_.Current.AutomationId -eq '1001' -and
        ([string]$_.Current.Name).IndexOf($full, [StringComparison]::OrdinalIgnoreCase) -ge 0 } |
      Select-Object -First 1
    if ($address) { return 'navigated' }
  } 'Folder picker did not navigate to the isolated fixture.'
  if ($selection -eq 'navigated') {
    $confirmed = [SubtitleSmokeNative]::ConfirmCurrentFolder($handle)
    Assert-Condition ($confirmed -or !(Find-Dialog)) 'Folder picker could not select the verified current directory.'
  }
  Wait-DialogClosed
}

function Wait-FolderDone {
  Wait-Condition {
    $button = Find-Control '添加文件夹' $types::Button
    $button -and $button.Current.IsEnabled -and
      !(Find-Control '取消扫描' $types::Button) -and !(Find-Control '正在取消…' $types::Button)
  } 'Folder scanning did not finish.' 45000 | Out-Null
}

try {
  $stage = 'folder-defaults-and-empty'
  [void](Get-Control '添加文件夹' $types::Button)
  $recursive = (Get-Control '包含子文件夹' $types::CheckBox).GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
  Assert-Condition ($recursive.Current.ToggleState -eq [System.Windows.Automation.ToggleState]::Off) 'Folder recursion was enabled by default.'
  $empty = Join-Path $testRoot '空 文件夹'
  [IO.Directory]::CreateDirectory($empty) | Out-Null
  Select-FolderFixture $empty
  Wait-FolderDone
  Assert-Condition (@(Queue-Buttons).Count -eq 0) 'Empty folder unexpectedly added files.'
  Wait-Condition { Find-Text '扫描完成' } 'Empty folder scan lacked a final status.' | Out-Null
  Feature-Pass 'Folder_empty_and_nonrecursive_default'

  $stage = 'folder-unicode-default'
  $rootFolder = Join-Path $testRoot '中文 文件夹 (🐱)'
  $top = New-FolderFixture $rootFolder '00-顶层.srt'
  $sameRoot = New-FolderFixture $rootFolder '同名.srt'
  $nested = Join-Path $rootFolder '子 文件夹'
  $sameNested = New-FolderFixture $nested '同名.srt'
  $secondNested = New-FolderFixture $nested '20-子集.srt'
  [IO.File]::WriteAllBytes((Join-Path $rootFolder '不支持.bin'), [byte[]]@())
  $outside = Join-Path $testRoot '目录外合成'
  [void](New-FolderFixture $outside '不应导入.srt')
  foreach ($entry in @(@{name='外部链接';target=$outside}, @{name='循环链接';target=$rootFolder})) {
    $junction = Join-Path $rootFolder $entry.name
    New-Item -ItemType Junction -Path $junction -Target $entry.target | Out-Null
    $folderLinks.Add($junction)
  }
  Select-FolderFixture $rootFolder
  Wait-FolderDone
  Assert-Condition (@(Queue-Buttons).Count -eq 2) 'Default folder import recursed or dropped supported top-level files.'
  [void](Get-Control '移除 00-顶层.srt' $types::Button)
  Assert-Condition (!(Find-Control '移除 20-子集.srt' $types::Button)) 'Default scan imported a nested file.'
  Feature-Pass 'Folder_unicode_shallow_and_extension_filtering'

  $stage = 'folder-recursive-duplicates-links'
  Set-Recursive $true
  Select-FolderFixture $rootFolder
  Wait-FolderDone
  Assert-Condition (@(Queue-Buttons).Count -eq 4) 'Recursive scan did not retain exactly the four unique supported paths.'
  Assert-Condition (@($application.FindAll($scope::Descendants, (Condition $element::NameProperty '移除 同名.srt'))).Count -eq 2) 'Different directories with the same filename were incorrectly deduplicated.'
  Assert-Condition (!(Find-Control '移除 不应导入.srt' $types::Button)) 'Folder scan followed an external junction.'
  Wait-Condition { Find-Text '已跳过链接 2 项' } 'Folder scan did not report both skipped reparse points.' | Out-Null
  Select-FolderFixture ($rootFolder.ToUpperInvariant())
  Wait-FolderDone
  Assert-Condition (@(Queue-Buttons).Count -eq 4) 'Case-variant folder import duplicated existing paths.'
  Wait-Condition { Find-Text '重复 4' } 'Repeated recursive scan did not report existing paths.' | Out-Null
  Feature-Pass 'Folder_recursive_case_dedup_same_names_junctions_and_loop'
  $report.checks.import = $true

  $stage = 'folder-process-and-export'
  Open-Tool '删除空白字幕'
  Click-Control '预览处理结果'
  [void](Get-Control '导出全部文件' $types::Button)
  $report.checks.process = $true
  $folderZip = Join-Path $testRoot 'folder-processed.zip'
  Click-Control '导出 ZIP'
  Select-DialogPath '导出处理结果（已有文件会自动添加序号）' $folderZip
  Wait-Condition { Test-Path -LiteralPath $folderZip } 'Folder result ZIP was not saved.' | Out-Null
  $archive = [IO.Compression.ZipFile]::OpenRead($folderZip)
  try {
    Assert-Condition ($archive.Entries.Count -eq 4) 'Folder result ZIP lost or duplicated a queued input.'
    foreach ($entry in $archive.Entries) {
      $reader = [IO.StreamReader]::new($entry.Open(), $utf8)
      try { Assert-Condition ($reader.ReadToEnd() -eq $fixtureText) 'Folder ZIP changed an unaffected subtitle.' }
      finally { $reader.Dispose() }
    }
  } finally { $archive.Dispose() }
  $report.checks.export = $true
  Feature-Pass 'Folder_queue_uses_existing_processing_and_safe_ZIP'

  $stage = 'folder-distinct-unicode-paths'
  Clear-Queue
  $unicodeFolder = Join-Path $testRoot 'Unicode独立路径'
  $dottedCapital = [string][char]0x0130 + '.srt'
  $dottedLower = 'i' + [char]0x0307 + '.srt'
  [void](New-FolderFixture $unicodeFolder $dottedCapital)
  [void](New-FolderFixture $unicodeFolder $dottedLower)
  [void](New-FolderFixture $unicodeFolder ([string][char]0x00DF + '.srt'))
  [void](New-FolderFixture $unicodeFolder 'SS.srt')
  [void](New-FolderFixture $unicodeFolder ([string][char]0x03C3 + '.srt'))
  Select-FolderFixture $unicodeFolder
  Wait-FolderDone
  Assert-Condition (@(Queue-Buttons).Count -eq 5) 'Distinct Windows Unicode paths were folded into one queue entry.'
  [void](Get-Control ('移除 ' + $dottedCapital) $types::Button)
  [void](Get-Control ('移除 ' + $dottedLower) $types::Button)
  Click-Control '选择文件'
  Select-DialogPath '选择字幕文件' (Join-Path $unicodeFolder ([string][char]0x03A3 + '.srt'))
  Assert-Condition (@(Queue-Buttons).Count -eq 5) 'A real Unicode case alias bypassed canonical path deduplication.'
  Feature-Pass 'Folder_distinct_dotted_I_sharp_S_and_real_Unicode_case_alias'
  Clear-Queue
  Select-FolderFixture $rootFolder
  Wait-FolderDone

  $stage = 'folder-unreadable-and-oversized'
  $errors = Join-Path $testRoot '读取边界'
  [void](New-FolderFixture $errors '正常.srt')
  $locked = New-FolderFixture $errors '占用.srt'
  $lock = [IO.File]::Open($locked, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
  $folderLocks.Add($lock)
  $oversized = Join-Path $errors '过大.srt'
  $large = [IO.File]::Open($oversized, [IO.FileMode]::CreateNew)
  try { $large.SetLength(32MB + 1) } finally { $large.Dispose() }
  Select-FolderFixture $errors
  Wait-FolderDone
  [void](Get-Control '移除 正常.srt' $types::Button)
  [void](Get-Control '移除 00-顶层.srt' $types::Button)
  Wait-Condition { Find-Text '超限 1.*读取失败 1' } 'Native scan did not isolate locked and oversized files.' | Out-Null
  $lock.Dispose()
  $folderLocks.Clear()
  Feature-Pass 'Folder_locked_and_32MiB_limit_preserve_previous_queue'

  $stage = 'folder-format-filter'
  Clear-Queue
  $formats = Join-Path $testRoot '格式筛选'
  [void](New-FolderFixture $formats '唯一SRT.srt')
  [void](New-FolderFixture $formats '只读VTT.vtt' "WEBVTT`n`n00:01.123 --> 00:03.456`n字幕`n")
  Select-Option '文件夹文件类型' 'SRT'
  Select-FolderFixture $formats
  Wait-FolderDone
  Assert-Condition (@(Queue-Buttons).Count -eq 1 -and !(Find-Control '移除 只读VTT.vtt' $types::Button)) 'Selected folder extension filter was not respected.'
  Select-Option '文件夹文件类型' '全部支持格式'
  Feature-Pass 'Folder_explicit_format_filter'

  $stage = 'folder-depth-limit'
  Clear-Queue
  Set-Recursive $true
  $depthRoot = Join-Path $testRoot '深度限制'
  $deep = $depthRoot
  foreach ($depth in 1..6) {
    $deep = Join-Path $deep ('层-' + $depth)
    [IO.Directory]::CreateDirectory($deep) | Out-Null
    if ($depth -eq 5) { [void](New-FolderFixture $deep '允许深度.srt') }
    if ($depth -eq 6) { [void](New-FolderFixture $deep '超深度.srt') }
  }
  Select-FolderFixture $depthRoot
  Wait-FolderDone
  [void](Get-Control '移除 允许深度.srt' $types::Button)
  Assert-Condition (!(Find-Control '移除 超深度.srt' $types::Button)) 'Native recursion exceeded the depth limit.'
  Feature-Pass 'Folder_recursion_depth_is_bounded'

  $stage = 'folder-queue-limit'
  Clear-Queue
  Set-Recursive $false
  $capacity = Join-Path $testRoot '数量上限'
  foreach ($index in 0..104) { [void](New-FolderFixture $capacity ('cap-{0:D3}.srt' -f $index)) }
  Select-FolderFixture $capacity
  Wait-FolderDone
  Assert-Condition (@(Queue-Buttons).Count -eq 100) 'Native folder import bypassed the 100-file queue limit.'
  Wait-Condition { Find-Text '已达到扫描或队列上限' } 'Queue limit stopped without an explicit summary.' | Out-Null
  Feature-Pass 'Folder_100_file_queue_limit'

  $stage = 'folder-entry-limit'
  Clear-Queue
  $entries = Join-Path $testRoot '扫描项目上限'
  [IO.Directory]::CreateDirectory($entries) | Out-Null
  foreach ($index in 0..2004) { [IO.File]::WriteAllBytes((Join-Path $entries ('entry-{0:D4}.bin' -f $index)), [byte[]]@()) }
  Select-FolderFixture $entries
  Wait-FolderDone
  Assert-Condition (@(Queue-Buttons).Count -eq 0) 'Unsupported files entered the queue.'
  Wait-Condition { Find-Text '已检查 2000 项' } 'Native scan did not expose its filesystem-entry limit.' | Out-Null
  Feature-Pass 'Folder_all_filesystem_entries_are_bounded'

  $stage = 'folder-directory-permission'
  $permissions = Join-Path $testRoot '目录权限'
  [void](New-FolderFixture $permissions '可以读取.srt')
  $denied = Join-Path $permissions '拒绝枚举'
  [void](New-FolderFixture $denied '不能读取.srt')
  $originalAcl = Get-Acl -LiteralPath $denied
  $folderPermissions[$denied] = $originalAcl
  $restricted = Get-Acl -LiteralPath $denied
  $rule = New-Object Security.AccessControl.FileSystemAccessRule([Security.Principal.WindowsIdentity]::GetCurrent().User, 'ListDirectory', 'Deny')
  $restricted.AddAccessRule($rule)
  Set-Acl -LiteralPath $denied -AclObject $restricted
  Set-Recursive $true
  Select-FolderFixture $permissions
  Wait-FolderDone
  [void](Get-Control '移除 可以读取.srt' $types::Button)
  Wait-Condition { Find-Text '目录失败 1' } 'Unreadable child directory did not receive a scan diagnostic.' | Out-Null
  Set-Acl -LiteralPath $denied -AclObject $originalAcl
  $folderPermissions.Clear()
  Feature-Pass 'Folder_directory_permission_failure_is_isolated'

  $stage = 'folder-cancel-and-retry'
  $cancelRoot = Join-Path $testRoot '取消扫描'
  [IO.Directory]::CreateDirectory($cancelRoot) | Out-Null
  foreach ($index in 0..2) {
    $cancelFile = Join-Path $cancelRoot ('cancel-{0:D3}.srt' -f $index)
    $stream = [IO.File]::Open($cancelFile, [IO.FileMode]::CreateNew)
    try { $stream.SetLength(32MB) } finally { $stream.Dispose() }
    $originalHashes[$cancelFile] = (Get-FileHash -LiteralPath $cancelFile -Algorithm SHA256).Hash
  }
  $beforeCancellation = @(Queue-Buttons).Count
  Select-FolderFixture $cancelRoot
  $cancelButton = $null
  $timer = [Diagnostics.Stopwatch]::StartNew()
  do {
    $cancelButton = Find-Control '取消扫描' $types::Button
    if ($cancelButton) { break }
    Start-Sleep -Milliseconds 10
  } while ($timer.ElapsedMilliseconds -lt 2000)
  if ($cancelButton -and $cancelButton.Current.IsEnabled) {
    $report.cancellationPhaseObserved = if (Find-Text '正在读取') { 'reading' } else { 'scanning' }
    $cancelButton.GetCurrentPattern($invoke).Invoke()
    Wait-FolderDone
    Wait-Condition { Find-Text '已取消扫描' } 'Folder cancellation did not present a final cancelled status.' | Out-Null
    [void](Get-Control '移除 可以读取.srt' $types::Button)
    $report.cancellationCompletedFiles = @(Queue-Buttons).Count - $beforeCancellation
    Assert-Condition ($report.cancellationCompletedFiles -lt 3) 'The scan completed every input before cancellation.'
    Feature-Pass 'Folder_cancel_keeps_previous_and_completed_inputs'
  } else {
    $report.featureChecks.Folder_cancel_keeps_previous_and_completed_inputs = 'NOT_RUN'
    $report.cancellationLimit = 'The real scan completed before the native cancel action could be invoked.'
  }
  Clear-Queue
  Set-Recursive $false
  Select-FolderFixture $formats
  Wait-FolderDone
  Assert-Condition (@(Queue-Buttons).Count -eq 2) 'A new folder scan did not work after the cancellation attempt.'
  Feature-Pass 'Folder_retry_after_cancel'

  foreach ($fixture in $originalHashes.Keys) {
    Assert-Condition ((Get-FileHash -LiteralPath $fixture -Algorithm SHA256).Hash -eq $originalHashes[$fixture]) 'A native folder source fixture changed.'
  }
  $report.originalPreserved = $true
  $report.preservedSourceCount = $originalHashes.Count
} finally {
  foreach ($stream in $folderLocks) { $stream.Dispose() }
  foreach ($directory in $folderPermissions.Keys) {
    Set-Acl -LiteralPath $directory -AclObject $folderPermissions[$directory]
  }
  foreach ($junction in $folderLinks) {
    if (Test-Path -LiteralPath $junction) {
      Assert-Condition ((Get-Item -LiteralPath $junction -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) 'Fixture cleanup encountered an unexpected regular directory.'
      [IO.Directory]::Delete($junction)
    }
  }
}
