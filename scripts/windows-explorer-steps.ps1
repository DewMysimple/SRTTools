. (Join-Path $PSScriptRoot 'windows-native-controls.ps1')

. (Join-Path $PSScriptRoot 'windows-desktop-interaction.ps1')
$extensions = @('srt','vtt','ass','ssa','txt','csv')
$verbRoot = 'Software\Classes\SystemFileAssociations'
$manufacturer = 'Software\subtitletools\Subtitle Tools'
$uninstallKey = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\Subtitle Tools'
$registry = [Microsoft.Win32.Registry]::CurrentUser
$registryBackupPath = Join-Path $storeDirectory 'subtitle-tools-explorer-smoke-backup.json'
$registryKeys = @($extensions | ForEach-Object { "$verbRoot\.$_\shell\SRTTools.Import" }) + @($manufacturer)
$installed = Join-Path $testRoot '安装 A 中文'
$moved = Join-Path $testRoot '安装 B 中文'
$shell = $null; $explorerWindow = $null; $installedUninstaller = $null
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class ExplorerAcceptanceNotify {
 [DllImport("shell32.dll")] public static extern void SHChangeNotify(int id, uint flags, IntPtr item1, IntPtr item2);
 [DllImport("shlwapi.dll",CharSet=CharSet.Unicode)] private static extern uint AssocQueryString(uint flags,uint query,string association,string extra,System.Text.StringBuilder output,ref uint count);
 public static uint VerbLookup() { uint count=4096;var output=new System.Text.StringBuilder(4096);return AssocQueryString(0,1,".srt","SRTTools.Import",output,ref count); }
}
'@

function Snapshot-Registry([string] $Path) {
  $key = $registry.OpenSubKey($Path)
  if (!$key) { return @{ exists = $false } }
  try {
    $values = @(); $children = @()
    foreach ($name in $key.GetValueNames()) {
      $kind = $key.GetValueKind($name).ToString()
      $value = $key.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      if ($kind -eq 'Binary' -or $kind -eq 'None') { $value = [Convert]::ToBase64String([byte[]]$value) }
      $values += @{ name = $name; kind = $kind; value = $value }
    }
    foreach ($name in $key.GetSubKeyNames()) { $children += @{ name = $name; snapshot = (Snapshot-Registry ($Path + '\' + $name)) } }
    # Windows recomputes the auto-inherited marker when a DACL is restored. Preserve
    # every ACE, inheritance flag and protection flag; exclude only that derived marker.
    $security = $key.GetAccessControl().GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access).Replace('D:AI','D:').Replace('D:PAI','D:P')
    @{ exists = $true; values = $values; children = $children; security = $security }
  } finally { $key.Dispose() }
}
function Restore-Registry([string] $Path, $Snapshot) {
  $existingKey = $registry.OpenSubKey($Path)
  if ($existingKey) { $existingKey.Dispose(); $registry.DeleteSubKeyTree($Path, $false) }
  if (!$Snapshot.exists) { return }
  $key = $registry.CreateSubKey($Path)
  try {
    foreach ($entry in $Snapshot.values) {
      $kind = [Enum]::Parse([Microsoft.Win32.RegistryValueKind], [string]$entry.kind)
      $value = $entry.value
      if ($entry.kind -eq 'Binary' -or $entry.kind -eq 'None') { $value = [Convert]::FromBase64String($value) }
      elseif ($entry.kind -eq 'DWord') { $value = [int]$value }
      elseif ($entry.kind -eq 'QWord') { $value = [long]$value }
      elseif ($entry.kind -eq 'MultiString') { $value = [string[]]$value }
      $key.SetValue([string]$entry.name, $value, $kind)
    }
  } finally { $key.Dispose() }
  foreach ($child in $Snapshot.children) { Restore-Registry ($Path + '\' + $child.name) $child.snapshot }
  if ($Snapshot.security) {
    $aclKey = $registry.OpenSubKey($Path, [Microsoft.Win32.RegistryKeyPermissionCheck]::ReadWriteSubTree, [Security.AccessControl.RegistryRights]::ChangePermissions)
    try {
      $acl = [Security.AccessControl.RegistrySecurity]::new()
      $acl.SetSecurityDescriptorSddlForm([string]$Snapshot.security)
      $aclKey.SetAccessControl($acl)
    } finally { $aclKey.Dispose() }
  }
}
function Verb-Key([string] $Extension = 'srt') { "$verbRoot\.$Extension\shell\SRTTools.Import" }
function Registry-Value([string] $Path, [string] $Name) {
  $key = $registry.OpenSubKey($Path)
  if (!$key) { return $null }
  try { $key.GetValue($Name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) } finally { $key.Dispose() }
}
function Set-RegistryValue([string] $Path, [string] $Name, [string] $Value) {
  $key = $registry.CreateSubKey($Path)
  try { $key.SetValue($Name, $Value, [Microsoft.Win32.RegistryValueKind]::String) } finally { $key.Dispose() }
}
function Stop-TestApp {
  if ($process -and !$process.HasExited) {
    Assert-Condition ($process.CloseMainWindow() -and $process.WaitForExit(10000)) 'Test application did not close normally.'
  }
}
function Start-TestApp([string] $Path) {
  $script:ExePath = $Path
  $script:process = Start-Process -FilePath $Path -WindowStyle Hidden -PassThru
  $script:application = Get-ApplicationWindow $process
  $script:applicationHandle = [IntPtr]::new($application.Current.NativeWindowHandle)
}
function Open-Settings {
  (Get-Control '设置' $types::Hyperlink).GetCurrentPattern($invoke).Invoke()
  [void](Get-Control 'Explorer 右键菜单（实验性）')
}
function Queue-Count {
  @($application.FindAll($scope::Descendants, (Condition $element::ControlTypeProperty $types::Button)) |
    Where-Object { ([string]$_.Current.Name).StartsWith('移除 ') }).Count
}
function Open-Home {
  (Get-Control '首页' $types::Hyperlink).GetCurrentPattern($invoke).Invoke()
  [void](Get-Control '让字幕处理，简单一点。')
}
function Native-Args([string[]] $Paths) {
  # Start-Process on Windows takes one command string; these are controlled fixture paths.
  Assert-Condition (!($Paths | Where-Object { $_.Contains('"') -or $_.Contains("`n") })) 'Unsafe QA command argument.'
  '--import ' + (($Paths | ForEach-Object { '"' + $_ + '"' }) -join ' ')
}
function Send-External([string[]] $Paths) {
  $forwarder = Start-Process -FilePath $ExePath -ArgumentList (Native-Args $Paths) -WindowStyle Hidden -PassThru
  Assert-Condition ($forwarder.WaitForExit(10000) -and $forwarder.ExitCode -eq 0) 'Single-instance forwarding process did not exit successfully.'
}
function Install-Test([string] $Directory) {
  $installer = Start-Process -FilePath $NsisPath -ArgumentList ('/S /D=' + $Directory) -WindowStyle Hidden -PassThru
  Assert-Condition ($installer.WaitForExit(60000) -and $installer.ExitCode -eq 0) 'NSIS test installation failed.'
  Assert-Condition (Test-Path -LiteralPath (Join-Path $Directory 'subtitle-tools.exe')) 'NSIS did not install the executable.'
  $script:installedUninstaller = Join-Path $Directory 'uninstall.exe'
}
function Uninstall-Test([string] $Directory, [bool] $Update = $false) {
  $path = Join-Path $Directory 'uninstall.exe'
  Assert-Condition (Test-Path -LiteralPath $path) 'Test uninstaller was missing.'
  $args = '/S'; if ($Update) { $args += ' /UPDATE' }
  $uninstaller = Start-Process -FilePath $path -ArgumentList $args -WindowStyle Hidden -PassThru
  Assert-Condition ($uninstaller.WaitForExit(60000)) 'NSIS uninstallation did not finish.'
  Wait-Condition { !(Test-Path -LiteralPath (Join-Path $Directory 'subtitle-tools.exe')) } 'NSIS did not remove its test executable.' 15000 | Out-Null
}
function New-ExternalFixture([string] $Name, [string] $Text) {
  $path = Join-Path $testRoot $Name
  [IO.File]::WriteAllText($path, $Text, $utf8)
  $originalHashes[$path] = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash
  $path
}
function Assert-OwnedMenu([string] $ExpectedPath) {
  foreach ($extension in $extensions) {
    Assert-Condition ((Registry-Value (Verb-Key $extension) 'Owner') -eq 'com.subtitletools.desktop') 'Menu owner marker was missing.'
    Assert-Condition ((Registry-Value (Verb-Key $extension) 'Executable') -eq $ExpectedPath) 'Menu executable path did not match.'
    Assert-Condition ((Registry-Value ((Verb-Key $extension) + '\command') '') -ceq ('"' + $ExpectedPath + '" --import "%1"')) 'Shell command did not preserve direct quoted arguments.'
  }
}
function Select-ExternalFolder([string] $Directory) {
  Click-Control '添加文件夹'
  $handle = Get-Dialog '选择字幕文件夹'
  Wait-Condition { [SubtitleSmokeNative]::SelectPath($handle, $Directory) } 'Folder dialog editor was not ready.' | Out-Null
  $selection = Wait-Condition {
    $dialog = Find-Dialog
    if (!$dialog) { return 'closed' }
    $address = $dialog.FindAll($scope::Descendants, $allElements) | Where-Object { $_.Current.AutomationId -eq '1001' -and ([string]$_.Current.Name).IndexOf($Directory, [StringComparison]::OrdinalIgnoreCase) -ge 0 } | Select-Object -First 1
    if ($address) { return 'navigated' }
  } 'Folder picker did not navigate to its owned fixture.'
  if ($selection -eq 'navigated') { [void][SubtitleSmokeNative]::ConfirmCurrentFolder($handle) }
  Wait-DialogClosed
}

try {
  $stage = 'explorer-registry-backup'
  Assert-Condition ([IO.Path]::IsPathRooted($NsisPath) -and (Test-Path -LiteralPath $NsisPath)) 'Explorer acceptance requires an NSIS installer.'
  Assert-Condition (!($registry.OpenSubKey($uninstallKey)) -and !($registry.OpenSubKey('Software\Wow6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Subtitle Tools'))) 'An existing installation must be preserved; uninstall tests require no installed app.'
  $shortcutFolder = Join-Path ([Environment]::GetFolderPath('Programs')) 'Subtitle Tools'
  $desktopShortcut = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Subtitle Tools.lnk'
  Assert-Condition (!(Test-Path -LiteralPath $shortcutFolder) -and !(Test-Path -LiteralPath $desktopShortcut)) 'Existing application shortcuts must be preserved.'
  if (Test-Path -LiteralPath $registryBackupPath) {
    $pendingRegistry = [IO.File]::ReadAllText($registryBackupPath) | ConvertFrom-Json
    Assert-Condition ($pendingRegistry.producer -eq 'subtitle-tools-explorer-acceptance-v1') 'Unknown registry backup was preserved.'
    foreach ($entry in $pendingRegistry.entries) { Assert-Condition ($registryKeys -contains $entry.path) 'Registry recovery path was not allowlisted.'; Restore-Registry $entry.path $entry.snapshot }
    Remove-Item -LiteralPath $registryBackupPath
  }
  $registryState = @{ producer = 'subtitle-tools-explorer-acceptance-v1'; entries = @($registryKeys | ForEach-Object { @{ path = $_; snapshot = (Snapshot-Registry $_) } }) }
  Write-Synced $registryBackupPath ($utf8.GetBytes(($registryState | ConvertTo-Json -Depth 20 -Compress))) ([IO.FileMode]::CreateNew)
  foreach ($key in $registryKeys[0..5]) { $registry.DeleteSubKeyTree($key, $false) }
  Stop-TestApp
  Install-Test $installed
  $installedExe = Join-Path $installed 'subtitle-tools.exe'
  $report.installedExecutableSha256 = (Get-FileHash -LiteralPath $installedExe -Algorithm SHA256).Hash.ToLowerInvariant()
  $report.installedApplicationVersion = [Diagnostics.FileVersionInfo]::GetVersionInfo($installedExe).ProductVersion
  Assert-Condition ($report.installedApplicationVersion -eq $report.applicationVersion) 'Installed application version did not match the tested build.'
  foreach ($key in $registryKeys[0..5]) { Assert-Condition (!($registry.OpenSubKey($key))) 'Fresh install unexpectedly registered Explorer integration.' }
  Start-TestApp $installedExe
  Open-Settings
  Wait-Condition { Find-Text '菜单未登记（默认关闭）' } 'Explorer integration was not off by default.' | Out-Null
  Click-Control '启用右键菜单'
  Wait-Condition { Find-Text '菜单已登记，请在 Explorer 中验证' } 'Explorer opt-in did not finish.' | Out-Null
  Assert-OwnedMenu $installedExe
  $report.shellAssociationLookupHresult = [ExplorerAcceptanceNotify]::VerbLookup().ToString('X8')
  Feature-Pass 'Explorer_fresh_install_off_explicit_opt_in_direct_command'

  $stage = 'explorer-denied-command-read-preflight'
  $beforeMenu = @($registryKeys[0..5] | ForEach-Object { Snapshot-Registry $_ })
  $commandPath = (Verb-Key 'ass') + '\command'
  $aclKey = $registry.OpenSubKey($commandPath, [Microsoft.Win32.RegistryKeyPermissionCheck]::ReadWriteSubTree,
    [Security.AccessControl.RegistryRights]::ChangePermissions -bor [Security.AccessControl.RegistryRights]::ReadPermissions)
  $originalAcl = $aclKey.GetAccessControl()
  try {
    $deniedAcl = $aclKey.GetAccessControl()
    $testDenyRule = [Security.AccessControl.RegistryAccessRule]::new(
      [Security.Principal.WindowsIdentity]::GetCurrent().User,
      ([Security.AccessControl.RegistryRights]::QueryValues -bor [Security.AccessControl.RegistryRights]::EnumerateSubKeys),
      [Security.AccessControl.AccessControlType]::Deny)
    $deniedAcl.AddAccessRule($testDenyRule)
    $aclKey.SetAccessControl($deniedAcl)
    Click-Control '禁用右键菜单'
    Wait-Condition { Find-Text '无法读取菜单命令，未作修改' } 'Denied command-key reads did not abort the entire menu update.' | Out-Null
  } finally {
    $restoredAcl = $aclKey.GetAccessControl()
    $restoredAcl.RemoveAccessRuleSpecific($testDenyRule)
    $aclKey.SetAccessControl($restoredAcl); $aclKey.Dispose()
  }
  for ($index = 0; $index -lt 6; $index++) {
    Assert-Condition (((Snapshot-Registry $registryKeys[$index]) | ConvertTo-Json -Depth 20 -Compress) -eq ($beforeMenu[$index] | ConvertTo-Json -Depth 20 -Compress)) 'Menu preflight failure modified a registry key.'
  }
  Feature-Pass 'Explorer_denied_command_read_aborts_before_any_registry_write'

  $stage = 'explorer-shell-cold-multi-unicode'
  $text = "1`r`n00:00:01,000 --> 00:00:02,000`r`n原文`r`n"
  $first = New-ExternalFixture '第一份 中文 & literal.srt' $text
  $second = New-ExternalFixture '第二份 (🐱).srt' ($text.Replace('原文', '第二份'))
  $third = New-ExternalFixture 'warm Unicode é.srt' ($text.Replace('原文', '第三份'))
  Stop-TestApp
  $shell = New-Object -ComObject Shell.Application
  $shell.Explore($testRoot)
  $explorerWindow = Wait-Condition {
    @($shell.Windows()) | Where-Object { try { $_.Document.Folder.Self.Path -eq $testRoot } catch { $false } } | Select-Object -First 1
  } 'Isolated Explorer fixture window was not available.'
  $folderView = $explorerWindow.Document
  [ExplorerAcceptanceNotify]::SHChangeNotify(0x08000000, 0x1000, [IntPtr]::Zero, [IntPtr]::Zero)
  $explorerWindow.Refresh()
  Start-Sleep -Milliseconds 1500
  $folderView.SelectItem($folderView.Folder.ParseName([IO.Path]::GetFileName($first)), 1 + 4 + 8 + 16)
  $folderView.SelectItem($folderView.Folder.ParseName([IO.Path]::GetFileName($second)), 1)
  Assert-Condition ($folderView.SelectedItems().Count -eq 2) 'Actual Explorer multi-selection did not contain two fixture files.'
  $verbs = @($folderView.SelectedItems().Verbs() | ForEach-Object { ([string]$_.Name).Replace('&','') })
  $report.shellVerbCount = $folderView.SelectedItems().Verbs().Count
  $report.shellMenuFound = [bool]($verbs | Where-Object { $_.Contains('Subtitle Tools') })
  $merged = [Microsoft.Win32.Registry]::ClassesRoot.OpenSubKey('SystemFileAssociations\.srt\shell\SRTTools.Import')
  $report.shellMergedOwnerFound = [bool]($merged -and $merged.GetValue('Owner') -eq 'com.subtitletools.desktop')
  if ($merged) { $merged.Dispose() }
  $singleVerbs = @($folderView.Folder.ParseName([IO.Path]::GetFileName($first)).Verbs() | ForEach-Object { ([string]$_.Name).Replace('&','') })
  Write-Host ('Single menu found=' + [bool]($singleVerbs | Where-Object { $_.Contains('Subtitle Tools') }) + '; mergedOwner=' + $report.shellMergedOwnerFound)
  Write-Host ('Shell selection verb count=' + $report.shellVerbCount + '; app entry=' + $report.shellMenuFound)
  $explorerHandle = [IntPtr]$explorerWindow.HWND
  [void][SubtitleDesktopInteraction]::ShowWindow($explorerHandle,9)
  [void][SubtitleDesktopInteraction]::MoveWindow($explorerHandle,10,10,760,700,$true)
  [SubtitleDesktopInteraction]::Topmost($explorerHandle,$true)
  try {
    $explorerElement = $element::FromHandle($explorerHandle)
    $selectedNode = Wait-Condition {
      $explorerElement.FindAll($scope::Descendants,(Condition $element::ControlTypeProperty $types::ListItem)) |
        Where-Object { $_.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Current.IsSelected } | Select-Object -First 1
    } 'Actual Explorer selection was not available for the physical context menu.'
    $bounds = $selectedNode.Current.BoundingRectangle
    $x = [int]($bounds.Left + $bounds.Width / 2); $y = [int]($bounds.Top + $bounds.Height / 2)
    Assert-Condition ([SubtitleDesktopInteraction]::RootAt($x,$y) -eq $explorerHandle) 'Owned Explorer selection was covered.'
    [SubtitleDesktopInteraction]::LegacyRightClick($x,$y)
    Start-Sleep -Milliseconds 350
    $report.nativeLegacyPopupCount = [SubtitleDesktopInteraction]::PopupMenuCount()
    $report.nativeLegacyItemCount = [SubtitleDesktopInteraction]::PopupTexts().Length
    $report.nativeLegacyMenuInvoked = [SubtitleDesktopInteraction]::ClickPopupItem('Subtitle Tools')
    Write-Host ('Native popup count=' + $report.nativeLegacyPopupCount + '; app entry=' + $report.nativeLegacyMenuInvoked + '; association HRESULT=' + $report.shellAssociationLookupHresult)
    if (!$report.nativeLegacyMenuInvoked) {
      $report.contextMenuStatus = 'BLOCKED'
      $report.featureChecks.Explorer_actual_native_context_menu = 'BLOCKED: registered HKCU verb absent from the actual legacy Explorer menu on this host'
      Assert-Condition $AllowUnavailableContextMenu 'Registered verb was absent from the actual native Explorer popup menu.'
    }
  } finally { [SubtitleDesktopInteraction]::CancelMenu($explorerHandle); [SubtitleDesktopInteraction]::Topmost($explorerHandle,$false) }
  if (!$report.nativeLegacyMenuInvoked) {
    $script:process = Start-Process -FilePath $ExePath -ArgumentList (Native-Args @($first,$second)) -WindowStyle Hidden -PassThru
  }
  $script:process = Wait-Condition { Get-Process -Name 'subtitle-tools' -ErrorAction SilentlyContinue | Select-Object -First 1 } 'Explorer did not cold-start the registered executable.'
  $script:application = Get-ApplicationWindow $process
  $script:applicationHandle = [IntPtr]::new($application.Current.NativeWindowHandle)
  Wait-Condition { (Queue-Count) -eq 2 } 'Explorer cold multi-selection was not fully imported.' | Out-Null
  [void](Get-Control ('移除 ' + [IO.Path]::GetFileName($first)) $types::Button)
  [void](Get-Control ('移除 ' + [IO.Path]::GetFileName($second)) $types::Button)
  Assert-Condition (@(Get-Process -Name 'subtitle-tools').Count -eq 1) 'Explorer multi-selection created more than one main process.'
  if ($report.nativeLegacyMenuInvoked) { Feature-Pass 'Explorer_actual_selection_cold_multi_unicode_single_instance' }
  else { Feature-Pass 'External_CLI_cold_multi_unicode_single_instance' }
  $report.checks.import = $true

  $stage = 'explorer-shell-warm'
  $folderView.SelectItem($folderView.Folder.ParseName([IO.Path]::GetFileName($third)), 1 + 4 + 8 + 16)
  if ($report.nativeLegacyMenuInvoked) { $folderView.SelectedItems().InvokeVerbEx('SRTTools.Import') }
  else { Send-External @($third) }
  Wait-Condition { (Queue-Count) -eq 3 } 'Warm Explorer forwarding replaced or lost the existing queue.' | Out-Null
  if ($report.nativeLegacyMenuInvoked) { Feature-Pass 'Explorer_warm_selection_preserves_queue' }
  else { Feature-Pass 'External_CLI_warm_forwarding_preserves_queue' }

  $stage = 'explorer-busy-deferred'
  $busyDirectory = Join-Path $testRoot 'busy read fixtures'; [IO.Directory]::CreateDirectory($busyDirectory) | Out-Null
  for ($i = 0; $i -lt 3; $i++) {
    $path = Join-Path $busyDirectory ("large-$i.srt")
    $stream = [IO.File]::Create($path); $stream.SetLength(32MB); $stream.Dispose()
    $originalHashes[$path] = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash
  }
  $deferred = New-ExternalFixture 'deferred.srt' $text
  Select-ExternalFolder $busyDirectory
  Wait-Condition { Find-Text '正在读取' } 'A real busy read interval was not observed.' | Out-Null
  Send-External @($deferred)
  Assert-Condition ((Find-Control '取消扫描' $types::Button) -and !(Find-Control '移除 deferred.srt' $types::Button)) 'External import was not deferred during the observed native read interval.'
  Wait-Condition { Find-Control '移除 deferred.srt' $types::Button } 'Deferred file was lost after the native scan completed.' 60000 | Out-Null
  Assert-Condition ((Queue-Count) -eq 7) 'Busy forwarding lost the previous queue, scanned files, or deferred file.'
  Feature-Pass 'Explorer_busy_native_read_defers_and_then_consumes_pending_file'
  Click-Control '清空'
  Send-External @($first, $second, $third)
  Wait-Condition { (Queue-Count) -eq 3 } 'Queue did not recover after the busy import scenario.' | Out-Null

  $stage = 'explorer-invalid-inputs'
  $invalid = Join-Path $testRoot 'moved-away.srt'
  [IO.File]::WriteAllText($invalid, $text, $utf8); Remove-Item -LiteralPath $invalid
  $large = Join-Path $testRoot 'over32MiB.srt'; $stream = [IO.File]::Create($large); $stream.SetLength(32MB + 1); $stream.Dispose()
  $unsupported = Join-Path $testRoot 'unsupported.exe'; [IO.File]::WriteAllText($unsupported, 'synthetic', $utf8)
  Send-External @($testRoot, $invalid, $large, $unsupported)
  Wait-Condition { Find-Text '4 个外部文件未导入' } 'Invalid external files lacked a clear rejection.' | Out-Null
  Assert-Condition ((Queue-Count) -eq 3) 'Invalid external inputs changed the existing valid queue.'
  Feature-Pass 'Explorer_directories_moved_oversize_unsupported_rejected'

  $stage = 'explorer-output'
  Open-Tool '删除空白字幕'
  Click-Control '预览处理结果'
  [void](Get-Control '导出 ZIP' $types::Button)
  $report.checks.process = $true
  Click-Control '导出 ZIP'
  $zipPath = Join-Path $testRoot 'explorer-output.zip'
  Select-DialogPath '导出处理结果（已有文件会自动添加序号）' $zipPath
  Wait-Condition { Test-Path -LiteralPath $zipPath } 'Explorer-imported inputs did not export.' | Out-Null
  $archive = [IO.Compression.ZipFile]::OpenRead($zipPath)
  try {
    Assert-Condition ($archive.Entries.Count -eq 3) 'Explorer ZIP lost imported files.'
    foreach ($fixture in @($first,$second,$third)) {
      $entryName = [IO.Path]::GetFileNameWithoutExtension($fixture) + '_processed.srt'
      $entry = $archive.GetEntry($entryName)
      Assert-Condition ([bool]$entry) 'Native ZIP entry name did not match its input.'
      $stream = $entry.Open(); $buffer = [IO.MemoryStream]::new()
      try { $stream.CopyTo($buffer); Assert-Condition ([Convert]::ToBase64String($buffer.ToArray()) -eq [Convert]::ToBase64String([IO.File]::ReadAllBytes($fixture))) 'Native ZIP bytes changed the valid single-cue fixture.' }
      finally { $stream.Dispose(); $buffer.Dispose() }
    }
  } finally { $archive.Dispose() }
  $report.checks.export = $true
  Feature-Pass 'Explorer_imported_files_process_and_real_zip_export'

  $stage = 'explorer-disable-unknown'
  Open-Settings; Click-Control '禁用右键菜单'
  Wait-Condition { Find-Text '菜单未登记（默认关闭）' } 'Menu disable did not finish.' | Out-Null
  foreach ($key in $registryKeys[0..5]) { Assert-Condition (!($registry.OpenSubKey($key))) 'Disable left a registered menu key.' }
  Set-RegistryValue (Verb-Key) 'Owner' 'synthetic.other.owner'
  Set-RegistryValue (Verb-Key) '' 'Synthetic untouched menu'
  Open-Home; Open-Settings
  $enable = Get-Control '启用右键菜单' $types::Button
  Assert-Condition (!$enable.Current.IsEnabled) 'Unknown menu owner was overwritten or offered for replacement.'
  Assert-Condition ((Registry-Value (Verb-Key) '') -eq 'Synthetic untouched menu') 'Unknown menu content changed.'
  Feature-Pass 'Explorer_disable_and_unknown_owner_preserved'
  $registry.DeleteSubKeyTree((Verb-Key), $false)
  Open-Home; Open-Settings; Click-Control '启用右键菜单'
  Wait-Condition { Find-Text '菜单已登记，请在 Explorer 中验证' } 'Re-enable failed.' | Out-Null

  $stage = 'explorer-same-path-update'
  Stop-TestApp
  Uninstall-Test $installed $true
  Assert-OwnedMenu $installedExe
  Install-Test $installed
  Assert-OwnedMenu $installedExe
  Feature-Pass 'Explorer_same_path_update_retains_opt_in'

  $stage = 'explorer-path-repair-other-uninstall'
  # A second portable copy never auto-registers. The Settings action explicitly repairs a move.
  [IO.Directory]::CreateDirectory($moved) | Out-Null
  $movedExe = Join-Path $moved 'subtitle-tools.exe'
  Copy-Item -LiteralPath $installedExe -Destination $movedExe
  Start-TestApp $movedExe; Open-Settings
  [void](Get-Control '修复到当前程序路径' $types::Button)
  Assert-OwnedMenu $installedExe
  Click-Control '修复到当前程序路径'
  Wait-Condition { Find-Text '菜单已登记，请在 Explorer 中验证' } 'Explicit moved-path repair failed.' | Out-Null
  Assert-OwnedMenu $movedExe
  Stop-TestApp
  Uninstall-Test $installed
  Assert-OwnedMenu $movedExe
  Feature-Pass 'Explorer_path_change_explicit_repair_and_other_install_uninstall_protection'

  $stage = 'explorer-own-uninstall'
  # Register the installed copy again, then test its genuine uninstall cleanup.
  Install-Test $installed
  Start-TestApp $installedExe; Open-Settings; Click-Control '修复到当前程序路径'
  Wait-Condition { Find-Text '菜单已登记，请在 Explorer 中验证' } 'Current install reactivation failed.' | Out-Null
  Set-RegistryValue (Verb-Key 'csv') 'Owner' 'synthetic.other.owner'
  Set-RegistryValue (Verb-Key 'csv') '' 'Synthetic uninstall preservation'
  Stop-TestApp
  Uninstall-Test $installed
  foreach ($key in $registryKeys[0..4]) { Assert-Condition (!($registry.OpenSubKey($key))) 'Owned-path uninstall did not remove its menu.' }
  Assert-Condition ((Registry-Value (Verb-Key 'csv') '') -eq 'Synthetic uninstall preservation') 'Uninstall modified another menu owner.'
  Feature-Pass 'Explorer_owned_path_uninstall_and_unknown_owner_protection'
  Start-TestApp $movedExe
  . (Join-Path $PSScriptRoot 'windows-gate5-feature-steps.ps1')
  foreach ($fixture in $originalHashes.Keys) { Assert-Condition ((Get-FileHash -LiteralPath $fixture -Algorithm SHA256).Hash -eq $originalHashes[$fixture]) 'An Explorer fixture was modified.' }
  $report.originalPreserved = $true
  $report.preservedSourceCount = $originalHashes.Count
} catch {
  $report.explorerFailureKind = $_.Exception.GetBaseException().GetType().Name
  $report.explorerFailureReason = if ($_.Exception.Message -match '(?i)([a-z]:[\\/]|\\\\)') { 'A controlled native scenario failed.' } else { $_.Exception.Message }
  throw
} finally {
  if ($explorerWindow) { try { $explorerWindow.Quit() } catch {} }
  # Ensure the installer never remains registered after either a success or a failure.
  if (Test-Path -LiteralPath (Join-Path $installed 'subtitle-tools.exe')) {
    if ($process -and !$process.HasExited) { Stop-TestApp }
    try { Uninstall-Test $installed } catch { $report.installerCleanupFailed = $true }
  }
  if ($registryState) {
    foreach ($entry in $registryState.entries) { Restore-Registry $entry.path $entry.snapshot }
    foreach ($entry in $registryState.entries) {
      $actual = Snapshot-Registry $entry.path
      Assert-Condition (($actual | ConvertTo-Json -Depth 20 -Compress) -eq ($entry.snapshot | ConvertTo-Json -Depth 20 -Compress)) 'Registry restoration verification failed.'
    }
    Remove-Item -LiteralPath $registryBackupPath
    $report.registryRestored = $true
  }
  Assert-Condition (!$report.installerCleanupFailed -and !($registry.OpenSubKey($uninstallKey))) 'Test installation registration could not be fully cleaned.'
}
