param(
  [Parameter(Mandatory)][string] $SetupPath,
  [Parameter(Mandatory)][string] $ReportPath,
  [Parameter(Mandatory)][string] $ExpectedVersion,
  [ValidateSet('smoke','workflow')][string] $SmokeScenario = 'workflow',
  [ValidatePattern('^$|^[a-fA-F0-9]{64}$')][string] $ExpectedSha256 = '',
  [string] $PortableDirectory
)
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSEdition -eq 'Core') {
  $arguments = @('-NoProfile','-STA','-File',$PSCommandPath,'-SetupPath',$SetupPath,'-ReportPath',$ReportPath,'-ExpectedVersion',$ExpectedVersion,'-SmokeScenario',$SmokeScenario)
  if ($ExpectedSha256) { $arguments += @('-ExpectedSha256',$ExpectedSha256) }
  if ($PortableDirectory) { $arguments += @('-PortableDirectory',$PortableDirectory) }
  & (Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe') @arguments
  exit $LASTEXITCODE
}
function Assert-Condition($Value,[string] $Message) { if (!$Value) { throw $Message } }
. (Join-Path $PSScriptRoot 'windows-state-protection.ps1')
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$target = Join-Path $repository 'src-tauri\target'
$registry = [Microsoft.Win32.Registry]::CurrentUser
$manufacturer = 'Software\subtitletools\Subtitle Tools'
$uninstallKey = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\Subtitle Tools'
$registryKeys = @('srt','vtt','ass','ssa','txt','csv' | ForEach-Object { 'Software\Classes\SystemFileAssociations\.' + $_ + '\shell\SRTTools.Import' }) + @($manufacturer)
$profile = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'com.subtitletools.desktop'
$store = Join-Path $profile 'subtitle-tools.json'; $recovery = Join-Path $profile 'subtitle-tools-recovery.json'
$backupPath = Join-Path $profile 'subtitle-tools-setup-qa-backup.json'
$shortcutFolder = Join-Path ([Environment]::GetFolderPath('Programs')) 'Subtitle Tools'
$desktopShortcut = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Subtitle Tools.lnk'
$utf8 = [Text.UTF8Encoding]::new($false)
$report = [ordered]@{ schemaVersion=1; producer='srttools-setup-acceptance-v1'; checkedAt=[DateTime]::UtcNow.ToString('o'); status='FAIL'; version=$ExpectedVersion; scenario=$SmokeScenario; setupSha256=$null; installedExecutableSha256=$null; checks=[ordered]@{}; failureStage=$null }
$stage = 'preflight'; $qaRoot=$null; $install=$null; $state=$null; $canReport=$false
$mutex = [Threading.Mutex]::new($false,'Local\SubtitleToolsSetupAcceptance'); $hasMutex=$false

function Restore-SetupState($Snapshot) {
  Assert-Condition ($Snapshot.producer -eq 'srttools-setup-acceptance-v1' -and $Snapshot.schemaVersion -eq 1 -and @($Snapshot.entries).Count -eq $registryKeys.Count) 'Unknown setup QA backup was preserved.'
  Assert-Condition ($null -ne $Snapshot.store -and $null -ne $Snapshot.recovery -and $Snapshot.store.exists -is [bool] -and $Snapshot.recovery.exists -is [bool]) 'Setup Store backup format was invalid.'
  foreach ($entry in $Snapshot.entries) { Assert-Condition ($registryKeys -contains $entry.path) 'Setup registry recovery path was not allowlisted.' }
  foreach ($entry in $Snapshot.entries) {
    if (((Snapshot-Registry $entry.path)|ConvertTo-Json -Depth 24 -Compress) -ne ($entry.snapshot|ConvertTo-Json -Depth 24 -Compress)) { Restore-Registry $entry.path $entry.snapshot }
  }
  foreach ($entry in $Snapshot.entries) { Assert-Condition (((Snapshot-Registry $entry.path)|ConvertTo-Json -Depth 24 -Compress) -eq ($entry.snapshot|ConvertTo-Json -Depth 24 -Compress)) 'Setup registry restoration verification failed.' }
  Restore-File $store $Snapshot.store; Restore-File $recovery $Snapshot.recovery
}
function Uninstall-OwnedSetup {
  if (!$install -or !(Test-Path -LiteralPath (Join-Path $install 'subtitle-tools.exe'))) { return }
  $path = Join-Path $install 'uninstall.exe'
  Assert-Condition (Test-Path -LiteralPath $path) 'Owned test uninstaller was missing.'
  $process = Start-Process -FilePath $path -ArgumentList '/S' -WindowStyle Hidden -PassThru
  Assert-Condition ($process.WaitForExit(60000)) 'Owned test uninstaller timed out.'
  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  do {
    $entry=$registry.OpenSubKey($uninstallKey); $registered=[bool]$entry; if ($entry) { $entry.Dispose() }
    if (!(Test-Path -LiteralPath (Join-Path $install 'subtitle-tools.exe')) -and !$registered) { return }
    Start-Sleep -Milliseconds 100
  } while ([DateTime]::UtcNow -lt $deadline)
  throw 'Owned installation registration was not fully removed.'
}
function Remove-SetupWorkspace {
  if (!$qaRoot -or !(Test-Path -LiteralPath $qaRoot)) { return }
  $resolved=(Get-Item -LiteralPath $qaRoot).FullName
  Assert-Condition ($resolved.StartsWith($target+'\',[StringComparison]::OrdinalIgnoreCase) -and (Split-Path -Leaf $resolved) -match '^setup-acceptance-[0-9a-f]{32}$') 'Setup workspace escaped its allowlist.'
  $dirs=[Collections.Generic.List[string]]::new(); $files=[Collections.Generic.List[object]]::new(); $pending=[Collections.Generic.Stack[string]]::new(); $pending.Push($resolved)
  while ($pending.Count) {
    $directory=$pending.Pop(); $dirs.Add($directory)
    foreach ($item in @(Get-ChildItem -LiteralPath $directory -Force)) {
      Assert-Condition (!($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) 'Setup workspace contains an unexpected reparse entry.'
      if ($item.PSIsContainer) { $pending.Push($item.FullName) } else { $files.Add(@{path=$item.FullName;length=$item.Length;modified=$item.LastWriteTimeUtc}) }
    }
  }
  foreach ($file in $files) {
    $current=Get-Item -LiteralPath $file.path -Force
    Assert-Condition ($current.Length -eq $file.length -and $current.LastWriteTimeUtc -eq $file.modified) 'Setup cleanup inventory changed.'
    Remove-Item -LiteralPath $file.path
  }
  foreach ($directory in $dirs | Sort-Object Length -Descending) { [IO.Directory]::Delete($directory,$false) }
}

try {
  Assert-Condition ([Environment]::UserInteractive -and (Get-Process -Id $PID).SessionId -ne 0) 'Interactive Windows desktop is required.'
  Assert-Condition ([IO.Path]::IsPathRooted($SetupPath) -and [IO.Path]::IsPathRooted($ReportPath)) 'Setup and report paths must be absolute.'
  $hasMutex=$mutex.WaitOne(0); Assert-Condition $hasMutex 'Another setup acceptance is active.'
  Assert-Condition (!(Get-Process -Name subtitle-tools -ErrorAction SilentlyContinue)) 'An existing application session must be preserved.'
  Assert-Condition (!($registry.OpenSubKey($uninstallKey)) -and !($registry.OpenSubKey('Software\Wow6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Subtitle Tools'))) 'An existing installation must be preserved.'
  Assert-Condition (!(Test-Path -LiteralPath $shortcutFolder) -and !(Test-Path -LiteralPath $desktopShortcut)) 'Existing application shortcuts must be preserved.'
  if (Test-Path -LiteralPath $ReportPath) { Assert-Condition (([IO.File]::ReadAllText($ReportPath)|ConvertFrom-Json).producer -eq $report.producer) 'An unknown report file was preserved.' }
  $canReport=$true
  foreach ($directory in @($repository,(Join-Path $repository 'src-tauri'),$target)) { Assert-Condition (!((Get-Item -LiteralPath $directory -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) 'Setup workspace ancestry contains a reparse point.' }
  [IO.Directory]::CreateDirectory($profile)|Out-Null
  Assert-Condition (!((Get-Item -LiteralPath $profile -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) 'Store directory must be a regular directory.'
  Assert-Condition (!(Test-Path -LiteralPath (Join-Path $profile 'subtitle-tools-release-smoke-backup.json')) -and !(Test-Path -LiteralPath (Join-Path $profile 'subtitle-tools-explorer-smoke-backup.json'))) 'Earlier smoke recovery must finish before setup acceptance.'
  if (Test-Path -LiteralPath $backupPath) { Restore-SetupState ([IO.File]::ReadAllText($backupPath)|ConvertFrom-Json); Remove-Item -LiteralPath $backupPath }
  $report.setupSha256=(Get-FileHash -LiteralPath $SetupPath -Algorithm SHA256).Hash
  if ($ExpectedSha256) { Assert-Condition ($report.setupSha256 -eq $ExpectedSha256) 'Setup hash did not match the approved artifact.' }
  $report.setupBytes=(Get-Item -LiteralPath $SetupPath).Length
  $manifestPath=Join-Path (Split-Path -Parent $SetupPath) 'build-info.json'
  if (Test-Path -LiteralPath $manifestPath) { $report.sourceSha=([IO.File]::ReadAllText($manifestPath)|ConvertFrom-Json).commit }
  if (!$PortableDirectory) { $PortableDirectory=Join-Path (Split-Path -Parent $SetupPath) 'SRTTools' }
  $portableNotice=Join-Path $PortableDirectory 'THIRD_PARTY_NOTICES.txt'
  Assert-Condition (Test-Path -LiteralPath $portableNotice) 'Fixed portable license resource was missing.'
  $state=@{producer=$report.producer;schemaVersion=1;entries=@($registryKeys|ForEach-Object {@{path=$_;snapshot=(Snapshot-Registry $_)}});store=(Snapshot-File $store);recovery=(Snapshot-File $recovery)}
  Write-Synced $backupPath ($utf8.GetBytes(($state|ConvertTo-Json -Depth 24 -Compress))) ([IO.FileMode]::CreateNew)
  # Seed valid existing preferences and both preset kinds. The child smoke backs this up
  # independently; byte checks before/after install, app execution and uninstall prove preservation.
  $stamp='2026-11-04T00:00:00.000Z'
  $seed=@{
    settings=@{theme='dark';outputDirectory='';fileNamePattern='{name}_processed';outputEncoding='utf-8';lineEnding='CRLF';autoOpenDirectory=$false;showPreview=$true}
    'tool-presets-v1'=@{schemaVersion=1;presets=@(@{schemaVersion=1;id='279dd315-cd4d-44b1-ae0a-c07521cad146';toolId='shift';name='Existing Tool Preserve';parameters=@{offsetMs=123;policy='reject'};createdAt=$stamp;updatedAt=$stamp})}
    'workflow-presets-v1'=@{schemaVersion=1;presets=@(@{schemaVersion=1;id='15b0398e-0a0e-4a87-ae62-330d798366f4';name='Existing Workflow Preserve';description='Retained setup acceptance fixture';steps=@(@{id='a7ad667c-ccde-4c26-9819-373f735e8d51';operation='shift';enabled=$true;params=@{offsetMs=123;policy='reject'}});lossyMode='reject';createdAt=$stamp;updatedAt=$stamp})}
  }
  $seedBytes=$utf8.GetBytes(($seed|ConvertTo-Json -Depth 15 -Compress))
  Write-Synced $store $seedBytes
  if (Test-Path -LiteralPath $recovery) { Remove-Item -LiteralPath $recovery }
  $seedHash=(Get-FileHash -LiteralPath $store -Algorithm SHA256).Hash
  $qaRoot=Join-Path $target ('setup-acceptance-'+[Guid]::NewGuid().ToString('N')); [IO.Directory]::CreateDirectory($qaRoot)|Out-Null
  $install=Join-Path $qaRoot 'installed'
  $stage='install'
  $installer=Start-Process -FilePath $SetupPath -ArgumentList ('/S /D='+$install) -WindowStyle Hidden -PassThru
  Assert-Condition ($installer.WaitForExit(60000) -and $installer.ExitCode -eq 0) 'Final NSIS installation failed.'
  $exe=Join-Path $install 'subtitle-tools.exe'
  $report.installedExecutableSha256=(Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash
  $report.installedVersion=[Diagnostics.FileVersionInfo]::GetVersionInfo($exe).ProductVersion
  Assert-Condition ($report.installedVersion -eq $ExpectedVersion) 'Installed version did not match the expected release.'
  $report.noticeSha256=(Get-FileHash -LiteralPath (Join-Path $install 'THIRD_PARTY_NOTICES.txt') -Algorithm SHA256).Hash
  Assert-Condition ($report.noticeSha256 -eq (Get-FileHash -LiteralPath $portableNotice -Algorithm SHA256).Hash) 'Installed license notice did not match the fixed portable resource.'
  Assert-Condition ((Get-FileHash -LiteralPath $store -Algorithm SHA256).Hash -eq $seedHash) 'Installation modified existing settings or presets.'
  foreach ($entry in $state.entries|Where-Object {$_.path -ne $manufacturer}) { Assert-Condition (((Snapshot-Registry $entry.path)|ConvertTo-Json -Depth 24 -Compress) -eq ($entry.snapshot|ConvertTo-Json -Depth 24 -Compress)) 'Installation changed opt-in Explorer registration.' }
  $report.checks.install=$true; $report.checks.version=$true; $report.checks.licenseResource=$true; $report.checks.explorerDefaultOff=$true
  $stage='installed-native-smoke'
  $childReport=Join-Path $qaRoot 'installed-smoke.json'
  & (Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe') -NoProfile -STA -File (Join-Path $PSScriptRoot 'windows-smoke.ps1') -ExePath $exe -ReportPath $childReport -ExpectedVersion $ExpectedVersion -Scenario $SmokeScenario -NsisPath $SetupPath
  Assert-Condition ($LASTEXITCODE -eq 0) 'Installed application native smoke failed.'
  $smoke=[IO.File]::ReadAllText($childReport)|ConvertFrom-Json
  Assert-Condition ($smoke.status -eq 'PASS' -and $smoke.executableSha256 -eq $report.installedExecutableSha256 -and $smoke.scenario -eq $SmokeScenario) 'Installed native proof did not match the actual payload.'
  foreach ($name in @('startup','import','process','export')) { Assert-Condition ($smoke.checks.$name) 'Required installed native check was missing.'; $report.checks[$name]=$true }
  Assert-Condition ($smoke.originalPreserved -and $smoke.shutdown -and $smoke.storeRestored -and $smoke.cleanupComplete) 'Installed native lifecycle proof was incomplete.'
  $report.checks.sourceUnchanged=[bool]$smoke.originalPreserved; $report.checks.gracefulShutdown=[bool]$smoke.shutdown
  $report.preservedSourceCount=$smoke.preservedSourceCount
  if ($SmokeScenario -eq 'workflow') {
    foreach ($name in @('fourStepWorkflow','previewAndExecutionBytes','presetRestartRoundTrip','nativePresetJsonExchange','invalidPresetPreservesStore','nestedDirectoryWrite','multiRootZipManifest','sourceOverlapRejected','failedWriteRetry','cancelRetry')) {
      Assert-Condition ($smoke.workflowChecks.$name -is [bool] -and $smoke.workflowChecks.$name) 'A required installed workflow proof was missing.'
    }
    $report.workflowChecks=$smoke.workflowChecks
  }
  $report.environment=$smoke.environment
  Assert-Condition ((Get-FileHash -LiteralPath $store -Algorithm SHA256).Hash -eq $seedHash) 'Application acceptance failed to preserve the existing settings and presets.'
  $stage='uninstall'
  Uninstall-OwnedSetup
  Assert-Condition ((Get-FileHash -LiteralPath $store -Algorithm SHA256).Hash -eq $seedHash) 'Uninstall modified existing settings or presets.'
  Assert-Condition (!(Test-Path -LiteralPath $shortcutFolder) -and !(Test-Path -LiteralPath $desktopShortcut)) 'Uninstall left test shortcuts.'
  $report.checks.uninstall=$true; $report.checks.existingSettingsAndPresetsPreserved=$true
} catch {
  $report.failureStage=$stage; $report.failureKind=$_.Exception.GetBaseException().GetType().Name
  $message=$_.Exception.Message
  $report.failureReason=if ($message -match '(?i)([a-z]:[\\/]|\\\\)') { 'A controlled setup acceptance operation failed.' } else { $message.Substring(0,[Math]::Min(200,$message.Length)) }
} finally {
  try {
    Assert-Condition (!(Get-Process -Name subtitle-tools -ErrorAction SilentlyContinue)) 'A test application must close before restoring its profile.'
    Uninstall-OwnedSetup
    if ($state) {
      $childBackup=Join-Path $profile 'subtitle-tools-release-smoke-backup.json'
      if (Test-Path -LiteralPath $childBackup) {
        $pending=[IO.File]::ReadAllText($childBackup)|ConvertFrom-Json
        Assert-Condition ($pending.schemaVersion -eq 1 -and $pending.store.exists -and $pending.store.data -eq [Convert]::ToBase64String($seedBytes) -and !$pending.recovery.exists) 'An unrecognized nested smoke backup was preserved.'
      }
      Restore-SetupState $state
      if (Test-Path -LiteralPath $childBackup) { Remove-Item -LiteralPath $childBackup }
      Remove-Item -LiteralPath $backupPath; $report.checks.registryRestored=$true; $report.checks.storeRestored=$true
    }
    Assert-Condition (!(Get-Process -Name subtitle-tools -ErrorAction SilentlyContinue)) 'A test application process remained active.'
    Assert-Condition (!($registry.OpenSubKey($uninstallKey))) 'Test uninstaller registration remained.'
    $report.checks.noAppProcess=$true; $report.checks.noInstallerRegistration=$true
    Remove-SetupWorkspace
    $report.checks.cleanupComplete=$true
  } catch { $report.failureStage='restoration';$report.failureKind=$_.Exception.GetBaseException().GetType().Name;$report.failureReason='Setup restoration needs inspection of the retained controlled backup.' }
  if (!$report.failureStage -and $report.checks.uninstall -and $report.checks.storeRestored -and $report.checks.registryRestored -and $report.checks.cleanupComplete) { $report.status='PASS' }
  if ($canReport) { [IO.Directory]::CreateDirectory((Split-Path -Parent $ReportPath))|Out-Null; [IO.File]::WriteAllText($ReportPath,($report|ConvertTo-Json -Depth 8),$utf8) }
  if ($hasMutex) { $mutex.ReleaseMutex() }; $mutex.Dispose()
}
Write-Host ('Setup native acceptance '+$report.status)
if ($report.status -ne 'PASS') { exit 1 }
