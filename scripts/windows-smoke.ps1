param(
  [Parameter(Mandatory)][string] $ExePath,
  [Parameter(Mandatory)][string] $ReportPath,
  [string] $ExpectedVersion,
  [ValidateSet('smoke', 'features', 'folder', 'explorer', 'workflow', 'closure', 'timeline')][string] $Scenario = 'smoke',
  [string] $NsisPath,
  [switch] $AllowUnavailableContextMenu,
  [switch] $PreserveExistingStore,
  [string] $ParentLeasePath,
  [string] $ParentLeaseToken
)

$ErrorActionPreference = 'Stop'

# UIAutomationClient is provided by the Windows .NET Framework desktop runtime.
if ($PSVersionTable.PSEdition -eq 'Core') {
  $arguments = @('-NoLogo', '-NoProfile', '-STA', '-File', $PSCommandPath,
    '-ExePath', $ExePath, '-ReportPath', $ReportPath)
  if ($ExpectedVersion) { $arguments += @('-ExpectedVersion', $ExpectedVersion) }
  $arguments += @('-Scenario', $Scenario)
  if ($NsisPath) { $arguments += @('-NsisPath', $NsisPath) }
  if ($AllowUnavailableContextMenu) { $arguments += '-AllowUnavailableContextMenu' }
  if ($PreserveExistingStore) { $arguments += '-PreserveExistingStore' }
  if ($ParentLeasePath) { $arguments += @('-ParentLeasePath',$ParentLeasePath) }
  if ($ParentLeaseToken) { $arguments += @('-ParentLeaseToken',$ParentLeaseToken) }
  & (Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe') @arguments
  exit $LASTEXITCODE
}

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -ReferencedAssemblies Accessibility -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class SubtitleSmokeNative {
 public delegate bool EnumChildProc(IntPtr handle, IntPtr parameter);
 [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr root, EnumChildProc callback, IntPtr parameter);
 [DllImport("user32.dll")] private static extern int GetDlgCtrlID(IntPtr handle);
 [DllImport("user32.dll")] private static extern IntPtr GetParent(IntPtr handle);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetClassName(IntPtr handle, System.Text.StringBuilder name, int max);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern IntPtr SendMessage(IntPtr handle, uint message, IntPtr wparam, string lparam);
 [DllImport("user32.dll")] private static extern bool PostMessage(IntPtr handle, uint message, IntPtr wparam, IntPtr lparam);
 [DllImport("user32.dll")] private static extern IntPtr GetDlgItem(IntPtr handle, int id);
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr handle, int command);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr handle);
 [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr handle);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr handle);
 [DllImport("user32.dll")] private static extern bool EnumWindows(EnumChildProc callback, IntPtr parameter);
 [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);
 [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr handle, uint command);
 [DllImport("oleacc.dll")] private static extern int AccessibleObjectFromWindow(IntPtr handle, uint objectId, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out Accessibility.IAccessible accessible);
 public static void ActivateAccessibility(IntPtr root) {
  EnumChildWindows(root, delegate(IntPtr child, IntPtr parameter) {
   Accessibility.IAccessible accessible = null;
   Guid iid = new Guid("618736e0-3c3d-11cf-810c-00aa00389b71");
   try {
    if (AccessibleObjectFromWindow(child, 0xFFFFFFFC, ref iid, out accessible) == 0 && accessible != null) {
     int count = accessible.accChildCount;
     object role = accessible.get_accRole(0);
    }
   } catch (COMException) {
   } catch (InvalidCastException) {
   } finally {
    if (accessible != null && Marshal.IsComObject(accessible)) Marshal.ReleaseComObject(accessible);
   }
   return true;
  }, IntPtr.Zero);
 }
 public static void DialogCommand(IntPtr dialog, int id) {
  if (!PostMessage(dialog, 0x0111, new IntPtr(id), GetDlgItem(dialog, id)))
   throw new InvalidOperationException("Native dialog command was rejected.");
 }
 public static bool SelectPath(IntPtr dialog, string path) {
  IntPtr editor = IntPtr.Zero;
  EnumChildWindows(dialog, delegate(IntPtr handle, IntPtr parameter) {
   var name = new System.Text.StringBuilder(256);
   GetClassName(handle, name, name.Capacity);
   if (name.ToString() == "Edit") {
    for (IntPtr ancestor = handle; ancestor != IntPtr.Zero && ancestor != dialog; ancestor = GetParent(ancestor)) {
     int id = GetDlgCtrlID(ancestor);
     if (id == 1148 || id == 1001 || id == 1152) { editor = handle; return false; }
    }
   }
   return true;
  }, IntPtr.Zero);
  if (editor == IntPtr.Zero) return false;
  SendMessage(editor, 0x000C, IntPtr.Zero, path);
  DialogCommand(dialog, 1);
  return true;
 }
 public static bool ConfirmCurrentFolder(IntPtr dialog) {
  IntPtr editor = IntPtr.Zero;
  EnumChildWindows(dialog, delegate(IntPtr handle, IntPtr parameter) {
   var name = new System.Text.StringBuilder(256);
   GetClassName(handle, name, name.Capacity);
   if (name.ToString() == "Edit") {
    for (IntPtr ancestor = handle; ancestor != IntPtr.Zero && ancestor != dialog; ancestor = GetParent(ancestor)) {
     if (GetDlgCtrlID(ancestor) == 1152) { editor = handle; return false; }
    }
   }
   return true;
  }, IntPtr.Zero);
  if (editor == IntPtr.Zero) return false;
  // The caller verifies the actual native address before selecting this folder.
  SendMessage(editor, 0x000C, IntPtr.Zero, "");
  return PostMessage(dialog, 0x0111, new IntPtr(1), GetDlgItem(dialog, 1));
 }
 public static string[] WindowStates(uint processId) {
  var windows = new System.Collections.Generic.List<string>();
  EnumWindows(delegate(IntPtr handle, IntPtr parameter) {
   uint ownerProcess;
   GetWindowThreadProcessId(handle, out ownerProcess);
   if (ownerProcess == processId) {
    var name = new System.Text.StringBuilder(256);
    GetClassName(handle, name, name.Capacity);
    windows.Add(String.Format("class={0},visible={1},minimized={2},owned={3}",
      name, IsWindowVisible(handle), IsIconic(handle), GetWindow(handle, 4) != IntPtr.Zero));
   }
   return true;
  }, IntPtr.Zero);
  return windows.ToArray();
 }
}
"@

$utf8 = [Text.UTF8Encoding]::new($false)
$element = [System.Windows.Automation.AutomationElement]
$scope = [System.Windows.Automation.TreeScope]
$types = [System.Windows.Automation.ControlType]
$invoke = [System.Windows.Automation.InvokePattern]::Pattern
$desktop = $element::RootElement
$process = $null
$application = $null
$applicationHandle = [IntPtr]::Zero
$state = $null
$testRoot = $null
$stage = 'preflight'
$mutex = [Threading.Mutex]::new($false, 'Local\SubtitleToolsReleaseSmoke')
$hasMutex = $false
$canWriteReport = $false
$originalWebViewFolder = [Environment]::GetEnvironmentVariable('WEBVIEW2_USER_DATA_FOLDER', 'Process')
$report = [ordered]@{
  schemaVersion = 1
  producer = 'srttools-windows-smoke'
  executableSha256 = $null
  status = 'FAIL'
  checkedAt = (Get-Date).ToUniversalTime().ToString('o')
  checks = [ordered]@{ startup = $false; import = $false; process = $false; export = $false }
  originalPreserved = $false
  shutdown = $false
  storeRestored = $false
  cleanupComplete = $false
  failureStage = $null
  failureKind = $null
  failureReason = $null
  failureLocation = $null
  windowStates = @()
  lastControl = $null
  scenario = $Scenario
  sourceSha = $null
  sourceDirty = $null
  executableName = $null
  applicationVersion = $null
  nsisSha256 = $null
  environment = [ordered]@{
    osVersion = [Environment]::OSVersion.Version.ToString()
    architecture = $env:PROCESSOR_ARCHITECTURE
    framework = [Environment]::Version.ToString()
  }
}

function Assert-Condition($Condition, [string] $Message) {
  if (!$Condition) { throw $Message }
}

function Wait-Condition([scriptblock] $Probe, [string] $Failure, [int] $Timeout = 20000) {
  $timer = [Diagnostics.Stopwatch]::StartNew()
  do {
    $result = & $Probe
    if ($result) { return $result }
    Start-Sleep -Milliseconds 120
  } while ($timer.ElapsedMilliseconds -lt $Timeout)
  throw $Failure
}

function Condition($Property, $Value) {
  New-Object System.Windows.Automation.PropertyCondition($Property, $Value)
}

function Find-Control([string] $Name, $Type = $null) {
  $condition = Condition $element::NameProperty $Name
  if ($Type) {
    $condition = New-Object System.Windows.Automation.AndCondition(
      $condition, (Condition $element::ControlTypeProperty $Type))
  }
  $application.FindFirst($scope::Descendants, $condition)
}

function Get-Control([string] $Name, $Type = $null) {
  Wait-Condition { Find-Control $Name $Type } ("Application control was not available: " + $Name)
}

function Click-Control([string] $Name) {
  $control = Wait-Condition {
    $candidate = Find-Control $Name $types::Button
    if ($candidate -and $candidate.Current.IsEnabled) { $candidate }
  } ("Application action did not become ready: " + $Name)
  $report.lastControl = [ordered]@{
    name = $Name
    enabled = $control.Current.IsEnabled
    offscreen = $control.Current.IsOffscreen
  }
  Assert-Condition $control.Current.IsEnabled 'Application action was disabled.'
  $action = $null
  if ($control.TryGetCurrentPattern($invoke, [ref]$action)) { $action.Invoke() }
  elseif ($control.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$action)) { $action.Toggle() }
  else { throw 'Application button did not expose a supported UI Automation action.' }
}

function Find-Dialog {
  $condition = New-Object System.Windows.Automation.AndCondition(
    (Condition $element::ProcessIdProperty $process.Id),
    (Condition $element::ClassNameProperty '#32770'))
  $desktop.FindFirst($scope::Children, $condition)
}

function Get-Dialog([string] $Title) {
  $dialog = Wait-Condition { Find-Dialog } 'Expected native file dialog was not available.'
  Assert-Condition ($dialog.Current.Name -eq $Title) 'Unexpected native dialog.'
  [IntPtr]::new($dialog.Current.NativeWindowHandle)
}

function Wait-DialogClosed {
  Wait-Condition { !(Find-Dialog) } 'Native file dialog did not complete.' | Out-Null
}

function Select-DialogPath([string] $Title, [string] $Path) {
  $dialog = Get-Dialog $Title
  Wait-Condition { [SubtitleSmokeNative]::SelectPath($dialog, $Path) } 'Native filename editor did not become available.' | Out-Null
  Wait-DialogClosed
}

function Get-ApplicationWindow($TestProcess) {
  $window = Wait-Condition {
    $TestProcess.Refresh()
    if ($TestProcess.HasExited) { throw 'Application exited before startup.' }
    $found = $desktop.FindFirst($scope::Children, (New-Object System.Windows.Automation.AndCondition(
      (Condition $element::ProcessIdProperty $TestProcess.Id),
      (Condition $element::ClassNameProperty 'Tauri Window'))))
    if ($found) { $found }
  } 'Application window was not available.'
  $handle = [IntPtr]::new($window.Current.NativeWindowHandle)
  [void][SubtitleSmokeNative]::ShowWindow($handle, 9)
  [void][SubtitleSmokeNative]::ShowWindow($handle, 5)
  Wait-Condition {
    [SubtitleSmokeNative]::IsWindowVisible($handle) -and ![SubtitleSmokeNative]::IsIconic($handle)
  } 'The test application window could not be shown.' | Out-Null
  Wait-Condition {
    [SubtitleSmokeNative]::ActivateAccessibility($handle)
    $window.FindFirst($scope::Descendants, (Condition $element::NameProperty '让字幕处理，简单一点。'))
  } 'Application home was not available.' | Out-Null
  $window
}

function Write-Synced([string] $Path, [byte[]] $Bytes, [IO.FileMode] $Mode = [IO.FileMode]::Create) {
  $stream = [IO.File]::Open($Path, $Mode, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try { $stream.Write($Bytes, 0, $Bytes.Length); $stream.Flush($true) }
  finally { $stream.Dispose() }
}

function Snapshot-File([string] $Path) {
  if (!(Test-Path -LiteralPath $Path)) { return @{ exists = $false; data = '' } }
  $item = Get-Item -LiteralPath $Path -Force
  Assert-Condition (!$item.PSIsContainer -and !($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) 'Store path must be a regular file.'
  Assert-Condition ($item.Length -le 16MB) 'Store backup exceeded the smoke-test limit.'
  @{ exists = $true; data = [Convert]::ToBase64String([IO.File]::ReadAllBytes($Path)) }
}

function Restore-File([string] $Path, $Snapshot) {
  if ($Snapshot.exists) {
    $bytes = [Convert]::FromBase64String($Snapshot.data)
    Write-Synced $Path $bytes
    Assert-Condition ([Convert]::ToBase64String([IO.File]::ReadAllBytes($Path)) -eq $Snapshot.data) 'Store restoration verification failed.'
  } elseif (Test-Path -LiteralPath $Path) {
    Remove-Item -LiteralPath $Path
  }
}

function Restore-Store($Snapshot) {
  Assert-Condition ($Snapshot.schemaVersion -eq 1 -and $null -ne $Snapshot.store -and $null -ne $Snapshot.recovery) 'Smoke backup format was invalid.'
  Assert-QAFileSnapshot $Snapshot.store;Assert-QAFileSnapshot $Snapshot.recovery
  Restore-File $storePath $Snapshot.store
  Restore-File $recoveryPath $Snapshot.recovery
}

. (Join-Path $PSScriptRoot 'windows-state-protection.ps1')
. (Join-Path $PSScriptRoot 'windows-qa-safety.ps1')

try {
  Assert-Condition ([Environment]::UserInteractive -and (Get-Process -Id $PID).SessionId -ne 0) 'An interactive Windows session is required.'
  Assert-Condition ([IO.Path]::IsPathRooted($ExePath) -and [IO.Path]::IsPathRooted($ReportPath)) 'Executable and report paths must be absolute.'
  $ExePath = [IO.Path]::GetFullPath($ExePath)
  $ReportPath = [IO.Path]::GetFullPath($ReportPath)
  $exe = Get-Item -LiteralPath $ExePath
  Assert-Condition (!$exe.PSIsContainer -and $exe.Length -gt 0 -and $exe.Extension -eq '.exe') 'Executable was not valid.'
  $report.executableSha256 = (Get-FileHash -LiteralPath $ExePath -Algorithm SHA256).Hash.ToLowerInvariant()
  $report.executableName = $exe.Name
  $report.applicationVersion = $exe.VersionInfo.ProductVersion
  if ($NsisPath) {
    $report.nsisSha256 = (Get-FileHash -LiteralPath $NsisPath -Algorithm SHA256).Hash.ToLowerInvariant()
  }
  if (Test-Path -LiteralPath $ReportPath) {
    $previousReport = [IO.File]::ReadAllText($ReportPath) | ConvertFrom-Json
    Assert-Condition ($previousReport.producer -eq $report.producer) 'Refusing to overwrite an unknown report file.'
  }
  $canWriteReport = $true
  $repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
  $report.sourceSha = (& git -C $repository rev-parse HEAD).Trim()
  $report.sourceDirty = [bool](& git -C $repository status --porcelain)
  $target = Join-Path $repository 'src-tauri\target'
  $storeDirectory=Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'com.subtitletools.desktop'
  $setupBackup=Join-Path $storeDirectory 'subtitle-tools-setup-qa-backup.json'
  $delegated=[bool]($ParentLeaseToken -or $ParentLeasePath)
  Assert-Condition (!$PreserveExistingStore -or $delegated) 'Keeping an existing Store requires a verified setup delegation.'
  if($delegated){
    Assert-Condition ($ParentLeaseToken -and [IO.Path]::IsPathRooted($ParentLeasePath)) 'Setup delegation was incomplete.'
    [void](Assert-QANoReparse ([IO.Path]::GetDirectoryName($ParentLeasePath)))
    $leaseItem=Get-Item -LiteralPath $ParentLeasePath -Force
    Assert-Condition (!$leaseItem.PSIsContainer -and !($leaseItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -and $leaseItem.Length -le 64KB) 'Setup lease file was invalid.'
    $lease=[IO.File]::ReadAllText($ParentLeasePath)|ConvertFrom-Json
    Assert-QADataBounded $lease
    Assert-QAParentLease $lease $ParentLeaseToken $ExePath $storeDirectory $target $repository
    Assert-Condition ($ParentLeasePath -eq (Join-Path $lease.root 'lease.json')) 'Setup lease filename was not owned.'
    $backupItem=Get-Item -LiteralPath $setupBackup -Force
    Assert-Condition (!$backupItem.PSIsContainer -and !($backupItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -and $backupItem.Length -le 64MB) 'Setup owner backup was invalid.'
    $backupBytes=[IO.File]::ReadAllBytes($setupBackup)
    $hasher=[Security.Cryptography.SHA256]::Create()
    try{$backupHash=[BitConverter]::ToString($hasher.ComputeHash($backupBytes)).Replace('-','')}finally{$hasher.Dispose()}
    Assert-Condition ($backupHash -ceq $lease.backupHash) 'Setup immutable backup did not match its lease.'
    $ownerBackup=[Text.Encoding]::UTF8.GetString($backupBytes)|ConvertFrom-Json
    Assert-QADataBounded $ownerBackup
    Assert-Condition ($ownerBackup.schemaVersion -eq 2 -and $ownerBackup.producer -eq 'srttools-setup-acceptance-v1' -and $ownerBackup.token -ceq $ParentLeaseToken -and $ownerBackup.root -eq $lease.root -and $ownerBackup.parentPid -eq $lease.parentPid -and $ownerBackup.parentStartUtcTicks -eq $lease.parentStartUtcTicks) 'Setup backup ownership did not match the child.'
  }
  $mutex.Dispose();$mutex=$null
  $mutex=Enter-QASmokeLease $ParentLeaseToken {Test-Path -LiteralPath $setupBackup};$hasMutex=$true
  Assert-Condition (!(Get-Process -Name subtitle-tools -ErrorAction SilentlyContinue)) 'Close the existing Subtitle Tools session before native smoke verification.'
  $report.delegatedProfileLease=$delegated
  [void](Assert-QANoReparse $target)
  $testRoot = Join-Path $target ('windows-smoke-' + [Guid]::NewGuid().ToString('N'))
  [IO.Directory]::CreateDirectory($testRoot) | Out-Null
  $testRoot = (Get-Item -LiteralPath $testRoot).FullName
  Assert-Condition ($testRoot.StartsWith($target + '\', [StringComparison]::OrdinalIgnoreCase)) 'Smoke workspace escaped the repository target directory.'
  $storeDirectory = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'com.subtitletools.desktop'
  [IO.Directory]::CreateDirectory($storeDirectory) | Out-Null
  [void](Assert-QANoReparse $storeDirectory)
  $storePath = Join-Path $storeDirectory 'subtitle-tools.json'
  $recoveryPath = Join-Path $storeDirectory 'subtitle-tools-recovery.json'
  $backupPath = Join-Path $storeDirectory 'subtitle-tools-release-smoke-backup.json'
  if (Test-Path -LiteralPath $backupPath) {
    # A previous process interruption retains its durable backup for this recovery.
    $item=Get-Item -LiteralPath $backupPath -Force;Assert-Condition (!$item.PSIsContainer -and !($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -and $item.Length -le 64MB) 'Smoke recovery backup was invalid.'
    $pending = [IO.File]::ReadAllText($backupPath) | ConvertFrom-Json
    Assert-QADataBounded $pending
    if($delegated){Assert-Condition ($pending.ownerToken -ceq $ParentLeaseToken -and $pending.ownerParentPid -eq $lease.parentPid -and $pending.ownerParentStartUtcTicks -eq $lease.parentStartUtcTicks) 'Nested smoke backup did not belong to this setup.'}
    else{Assert-Condition (!$pending.ownerToken) 'An orphaned delegated backup requires setup recovery.'}
    Restore-Store $pending
    Remove-Item -LiteralPath $backupPath
  }
  $candidate = @{ schemaVersion = 1; store = (Snapshot-File $storePath); recovery = (Snapshot-File $recoveryPath) }
  if($delegated){$candidate.ownerToken=$ParentLeaseToken;$candidate.ownerParentPid=$lease.parentPid;$candidate.ownerParentStartUtcTicks=$lease.parentStartUtcTicks}
  Assert-QAFileSnapshot $candidate.store;Assert-QAFileSnapshot $candidate.recovery
  Write-Synced $backupPath ($utf8.GetBytes((ConvertTo-QADataJson $candidate))) ([IO.FileMode]::CreateNew)
  $state=$candidate
  if(!$PreserveExistingStore){Write-Synced $storePath ($utf8.GetBytes('{}'));if(Test-Path -LiteralPath $recoveryPath){Remove-Item -LiteralPath $recoveryPath}}
  [Environment]::SetEnvironmentVariable('WEBVIEW2_USER_DATA_FOLDER', (Join-Path $testRoot 'webview'), 'Process')

  $source = Join-Path $testRoot '合成 字幕 (🐱).srt'
  $output = Join-Path $testRoot '已导出 (🐱).srt'
  $inputText = "1\n00:00:01,123 --> 00:00:03,456\n合成 qa native 🐱\n第二行 e$([char]0x0301)\n\n2\n00:00:04,000 --> 00:00:05,000\n   \n\n3\n00:00:06,789 --> 00:00:08,123\n结束\n"
  $expectedText = "1\r\n00:00:01,123 --> 00:00:03,456\r\n合成 qa native 🐱\r\n第二行 e$([char]0x0301)\r\n\r\n2\r\n00:00:06,789 --> 00:00:08,123\r\n结束\r\n"
  $inputText = $inputText.Replace('\n', "`n")
  $expectedText = $expectedText.Replace('\r', "`r").Replace('\n', "`n")
  [IO.File]::WriteAllText($source, $inputText, $utf8)
  $sourceHash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash

  $stage = 'startup'
  $process = Start-Process -FilePath $ExePath -WindowStyle Hidden -PassThru
  $application = Get-ApplicationWindow $process
  $applicationHandle = [IntPtr]::new($application.Current.NativeWindowHandle)
  $webViewProcess = Get-CimInstance Win32_Process -Filter "name='msedgewebview2.exe'" |
    Where-Object { $_.ParentProcessId -eq $process.Id } | Select-Object -First 1
  if ($webViewProcess -and $webViewProcess.ExecutablePath) {
    $report.environment.webViewVersion = [Diagnostics.FileVersionInfo]::GetVersionInfo($webViewProcess.ExecutablePath).ProductVersion
  }
  $windowsVersion = Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
  $report.environment.windowsBuild = $windowsVersion.CurrentBuildNumber + '.' + $windowsVersion.UBR
  [void](Get-Control '让字幕处理，简单一点。')
  if ($ExpectedVersion) {
    Wait-Condition { (Find-Control $ExpectedVersion $types::Text) -or (Find-Control ("v" + $ExpectedVersion) $types::Text) } 'Application version did not match.' | Out-Null
  }
  $report.checks.startup = $true

  if ($Scenario -eq 'features') {
    . (Join-Path $PSScriptRoot 'windows-feature-steps.ps1')
  } elseif ($Scenario -eq 'folder') {
    . (Join-Path $PSScriptRoot 'windows-folder-steps.ps1')
  } elseif ($Scenario -eq 'explorer') {
    . (Join-Path $PSScriptRoot 'windows-explorer-steps.ps1')
  } elseif ($Scenario -eq 'workflow') {
    . (Join-Path $PSScriptRoot 'windows-workflow-steps.ps1')
    if ($ExpectedVersion -and [version]$ExpectedVersion -ge [version]'0.5.0') {
      . (Join-Path $PSScriptRoot 'windows-timeline-steps.ps1')
    }
  } elseif ($Scenario -eq 'timeline') {
    . (Join-Path $PSScriptRoot 'windows-timeline-steps.ps1')
  } elseif ($Scenario -eq 'closure') {
    . (Join-Path $PSScriptRoot 'windows-closure-steps.ps1')
  } else {
  $stage = 'import'
  Click-Control '选择文件'
  Select-DialogPath '选择字幕文件' $source
  [void](Get-Control '移除 合成 字幕 (🐱).srt' $types::Button)
  $report.checks.import = $true

  $stage = 'process'
  $link = Get-Control '删除空白字幕 清除只包含空格、空行或不可见字符的条目' $types::Hyperlink
  $link.GetCurrentPattern($invoke).Invoke()
  Click-Control '预览处理结果'
  [void](Get-Control '另存为' $types::Button)
  [void](Get-Control '处理前')
  [void](Get-Control '处理后')
  $report.checks.process = $true

  $stage = 'export'
  Click-Control '另存为'
  Select-DialogPath '导出处理结果（已有文件会自动添加序号）' $output
  Wait-Condition { Test-Path -LiteralPath $output } 'Native export file was not created.' | Out-Null
  Assert-Condition ([IO.File]::ReadAllText($output, $utf8) -eq $expectedText) 'Exported content did not match the processed subtitle.'
  Assert-Condition ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -eq $sourceHash) 'Original subtitle changed.'
  $report.originalPreserved = $true
  $report.checks.export = $true
  }
} catch {
  $report.failureStage = $stage
  $report.failureKind = $_.Exception.GetBaseException().GetType().Name
  $report.failureLocation = [ordered]@{
    script = [IO.Path]::GetFileName($_.InvocationInfo.ScriptName)
    line = $_.InvocationInfo.ScriptLineNumber
  }
  $reason = $_.Exception.Message
  if ($reason -match '(?i)([a-z]:[\\/]|\\\\)') {
    $reason = 'A native operation failed. Inspect failureStage and failureKind.'
  }
  $report.failureReason = $reason.Substring(0, [Math]::Min(200, $reason.Length))
  Write-Warning ("Windows smoke failed during " + $stage + ".")
} finally {
  if ($process -and !$process.HasExited) {
    $report.windowStates = @([SubtitleSmokeNative]::WindowStates([uint32]$process.Id))
  }
  if ($process -and !$process.HasExited) {
    if ($dialog = Find-Dialog) {
      [SubtitleSmokeNative]::DialogCommand([IntPtr]::new($dialog.Current.NativeWindowHandle), 2)
      Start-Sleep -Milliseconds 250
    }
    $closed = $process.CloseMainWindow()
    if ($closed -and $process.WaitForExit(8000)) { $report.shutdown = $true }
    else { Stop-Process -Id $process.Id; $process.WaitForExit() }
  }
  if ($state) {
    try {
      Restore-Store $state
      Remove-Item -LiteralPath $backupPath
      $report.storeRestored = $true
    } catch {
      $report.failureStage = 'store-restoration'
      $report.failureKind = $_.Exception.GetBaseException().GetType().Name
      $report.failureReason = 'The durable Store backup was retained for recovery on the next smoke run.'
    }
  }
  [Environment]::SetEnvironmentVariable('WEBVIEW2_USER_DATA_FOLDER', $originalWebViewFolder, 'Process')
  if ($hasMutex) { $mutex.ReleaseMutex() }
  if($mutex){$mutex.Dispose()}

  if ($testRoot -and (Test-Path -LiteralPath $testRoot)) {
    try {
      Remove-QAWorkspace $testRoot $target $repository 'windows-smoke-'
      $report.cleanupComplete = $true
    } catch { $report.cleanupComplete = $false }
  }
  if (!$report.failureStage -and $report.originalPreserved -and $report.shutdown -and $report.storeRestored) {
    if ($report.cleanupComplete) { $report.status = if ($report.contextMenuStatus -eq 'BLOCKED') { 'PARTIAL' } else { 'PASS' } }
    else {
      $report.failureStage = 'cleanup'
      $report.failureReason = 'The owned smoke workspace could not be completely removed.'
    }
  }
  if ($canWriteReport) {
    [IO.Directory]::CreateDirectory((Split-Path -Parent $ReportPath)) | Out-Null
    [IO.File]::WriteAllText($ReportPath, ($report | ConvertTo-Json -Depth 4), $utf8)
  }
}
if ($report.status -ne 'PASS') { exit 1 }
