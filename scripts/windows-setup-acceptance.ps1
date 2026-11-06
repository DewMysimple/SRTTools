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
. (Join-Path $PSScriptRoot 'windows-qa-safety.ps1')
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
$profileMutex=[Threading.Mutex]::new($false,'Local\SubtitleToolsReleaseSmoke');$hasProfileMutex=$false
$ownedJobs=[Collections.Generic.List[object]]::new();$setupJobCounter=0
$token=[Guid]::NewGuid().ToString('N')+[Guid]::NewGuid().ToString('N')
$parentStartUtcTicks=(Get-Process -Id $PID).StartTime.ToUniversalTime().Ticks

function Assert-SetupState($Snapshot) {
  Assert-QADataBounded $Snapshot
  $fields=Get-QAObjectMap $Snapshot
  Assert-Condition ($fields.get_Count() -eq 9 -and $Snapshot.producer -ceq 'srttools-setup-acceptance-v1' -and (Get-QADataKind $Snapshot.schemaVersion) -eq 'integer' -and $Snapshot.schemaVersion -eq 2 -and (Get-QADataKind $Snapshot.entries) -eq 'array' -and @($Snapshot.entries).Count -eq $registryKeys.Count -and $Snapshot.token -match '^[0-9a-f]{64}$') 'Unknown setup QA backup was preserved.'
  Assert-QAFileSnapshot $Snapshot.store;Assert-QAFileSnapshot $Snapshot.recovery
  $paths=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach($entry in $Snapshot.entries){$row=Get-QAObjectMap $entry;Assert-Condition ($row.get_Count() -eq 2 -and $entry.path -is [string] -and $registryKeys -contains $entry.path -and $paths.Add($entry.path)) 'Setup registry recovery paths were unknown or duplicated.';Assert-QARegistrySnapshot $entry.snapshot}
  Assert-Condition ((Get-QADataKind $Snapshot.parentPid) -eq 'integer' -and (Get-QADataKind $Snapshot.parentStartUtcTicks) -eq 'integer' -and $Snapshot.parentPid -gt 0 -and $Snapshot.parentStartUtcTicks -gt 0) 'Setup backup owner identity was invalid.'
  [void](Assert-QAWorkspace $Snapshot.root $target $repository)
  [void](ConvertTo-QADataJson $Snapshot)
}
function Assert-SetupWritersStopped($Snapshot) {
  Assert-SetupState $Snapshot
  foreach($job in $ownedJobs){Assert-Condition ($job.StopAndWait(5000)) 'An owned QA job could not be confirmed stopped.'}
  foreach($file in @(Get-ChildItem -LiteralPath $Snapshot.root -Filter 'job-*.json' -File)){
    [void](Assert-QAWorkspace $Snapshot.root $target $repository)
    Assert-Condition (!($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -and $file.Length -le 64KB -and $file.Name -match '^job-([1-9][0-9]?)\.json$') 'Owned job evidence was invalid.'
    $number=$Matches[1];$record=[IO.File]::ReadAllText($file.FullName)|ConvertFrom-Json
    Assert-QADataBounded $record
    Assert-Condition ($record.producer -eq 'srttools-setup-job-v1' -and $record.token -ceq $Snapshot.token -and $record.name -ceq ('Local\SRTToolsSetup-'+$Snapshot.token+'-'+$number) -and $record.pid -gt 0 -and $record.startUtcTicks -gt 0) 'Unrecognized process ownership evidence was preserved.'
    $job=[SubtitleQaJob]::OpenOwned($record.name)
    if($job){try{Assert-Condition ($job.StopAndWait(5000)) 'An owned job still has a possible late writer.'}finally{$job.Dispose()}}
    else{$process=Get-Process -Id $record.pid -ErrorAction SilentlyContinue;Assert-Condition (!$process -or $process.StartTime.ToUniversalTime().Ticks -ne [long]$record.startUtcTicks) 'An owned process exists without its required job guard.'}
  }
  Assert-Condition (!(Get-Process -Name subtitle-tools -ErrorAction SilentlyContinue)) 'An unowned application session prevents profile restoration.'
}
function Restore-SetupState($Snapshot) {
  Assert-SetupState $Snapshot
  Test-QARegistryRestorability $Snapshot.entries
  foreach ($entry in $Snapshot.entries) {
    Restore-Registry $entry.path $entry.snapshot
  }
  foreach($entry in $Snapshot.entries){Assert-QADataEqual $entry.snapshot (Snapshot-Registry $entry.path)}
  Restore-File $store $Snapshot.store; Restore-File $recovery $Snapshot.recovery
}
function Start-SetupJob([string]$Exe,[string[]]$Arguments,[string]$Kind,[int]$Timeout) {
  [void](Assert-QAWorkspace $qaRoot $target $repository)
  $script:setupJobCounter++;Assert-Condition ($setupJobCounter -le 16) 'QA process count exceeded its bound.'
  $name='Local\SRTToolsSetup-'+$token+'-'+$setupJobCounter
  # NSIS /D= must be the final, unquoted tail even with spaces. lpApplicationName
  # remains explicit; no shell is involved. https://nsis.sourceforge.io/Docs/Chapter3.html
  $nativeNsis=$Kind -in @('installer','uninstaller')
  if($Kind -eq 'installer'){Assert-Condition ($Arguments.Count -eq 2 -and $Arguments[1] -ceq ('/D='+$install)) 'NSIS destination was not the owned installation.'}
  $job=[SubtitleQaJob]::StartSuspended($name,$Exe,$Arguments,$repository,$nativeNsis);$ownedJobs.Add($job)
  $record=@{producer='srttools-setup-job-v1';token=$token;name=$name;pid=$job.Pid;startUtcTicks=$job.StartUtcTicks;kind=$Kind}
  Write-Synced (Join-Path $qaRoot ('job-'+$setupJobCounter+'.json')) ($utf8.GetBytes((ConvertTo-QADataJson $record))) ([IO.FileMode]::CreateNew)
  if($Kind -eq 'smoke'){
    $lease=@{producer='srttools-setup-lease-v1';token=$token;parentPid=$PID;parentStartUtcTicks=$parentStartUtcTicks;childPid=$job.Pid;childStartUtcTicks=$job.StartUtcTicks;root=$qaRoot;exe=(Join-Path $install 'subtitle-tools.exe');backup=$backupPath;backupHash=(Get-FileHash -LiteralPath $backupPath -Algorithm SHA256).Hash}
    Write-Synced (Join-Path $qaRoot 'lease.json') ($utf8.GetBytes((ConvertTo-QADataJson $lease))) ([IO.FileMode]::CreateNew)
  }
  $job.Resume()
  if(!$job.WaitEmpty($Timeout)){
    $report.lastTimedOutJobStopped=$job.StopAndWait(5000)
    throw 'Owned QA process exceeded its deadline; restoration requires confirmed job quiescence.'
  }
  Assert-Condition ($job.ExitCode -eq 0) 'Owned QA process exited unsuccessfully.'
}
function Uninstall-OwnedSetup {
  if (!$install -or !(Test-Path -LiteralPath (Join-Path $install 'subtitle-tools.exe'))) { return }
  $path = Join-Path $install 'uninstall.exe'
  Assert-Condition (Test-Path -LiteralPath $path) 'Owned test uninstaller was missing.'
  Start-SetupJob $path @('/S') 'uninstaller' 60000
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
  Remove-QAWorkspace $qaRoot $target $repository
}

try {
  Assert-Condition ([Environment]::UserInteractive -and (Get-Process -Id $PID).SessionId -ne 0) 'Interactive Windows desktop is required.'
  Assert-Condition ([IO.Path]::IsPathRooted($SetupPath) -and [IO.Path]::IsPathRooted($ReportPath)) 'Setup and report paths must be absolute.'
  $hasMutex=$mutex.WaitOne(0); Assert-Condition $hasMutex 'Another setup acceptance is active.'
  $hasProfileMutex=$profileMutex.WaitOne(0);Assert-Condition $hasProfileMutex 'Another native QA profile lease is active.'
  if (Test-Path -LiteralPath $ReportPath) { Assert-Condition (([IO.File]::ReadAllText($ReportPath)|ConvertFrom-Json).producer -eq $report.producer) 'An unknown report file was preserved.' }
  $canReport=$true
  [void](Assert-QANoReparse $target)
  [IO.Directory]::CreateDirectory($profile)|Out-Null
  Assert-Condition (!((Get-Item -LiteralPath $profile -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) 'Store directory must be a regular directory.'
  Assert-Condition (!(Test-Path -LiteralPath (Join-Path $profile 'subtitle-tools-explorer-smoke-backup.json'))) 'Earlier Explorer QA recovery must finish before setup acceptance.'
  if(Test-Path -LiteralPath $backupPath){
    $backupItem=Get-Item -LiteralPath $backupPath -Force;Assert-Condition (!($backupItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -and $backupItem.Length -le 64MB) 'Setup backup file was invalid.'
    $previous=[IO.File]::ReadAllText($backupPath)|ConvertFrom-Json;Assert-SetupState $previous
    $owner=Get-Process -Id $previous.parentPid -ErrorAction SilentlyContinue
    Assert-Condition (!$owner -or $owner.StartTime.ToUniversalTime().Ticks -ne [long]$previous.parentStartUtcTicks) 'Previous setup QA owner is still active.'
    Assert-SetupWritersStopped $previous
    $previousChild=Join-Path $profile 'subtitle-tools-release-smoke-backup.json'
    if(Test-Path -LiteralPath $previousChild){
      $item=Get-Item -LiteralPath $previousChild -Force;Assert-Condition (!$item.PSIsContainer -and !($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -and $item.Length -le 64MB) 'Previous nested backup file was invalid.'
      $pending=[IO.File]::ReadAllText($previousChild)|ConvertFrom-Json;Assert-QADataBounded $pending
      Assert-Condition ($pending.schemaVersion -eq 1 -and $pending.ownerToken -ceq $previous.token -and $pending.ownerParentPid -eq $previous.parentPid -and $pending.ownerParentStartUtcTicks -eq $previous.parentStartUtcTicks) 'Unknown nested backup was preserved.'
      Assert-QAFileSnapshot $pending.store;Assert-QAFileSnapshot $pending.recovery
    }
    $previousInstall=$false
    foreach($keyPath in @($uninstallKey,'Software\Wow6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Subtitle Tools')){
      $registered=$registry.OpenSubKey($keyPath)
      if($registered){try{Assert-Condition ($registered.GetValue('InstallLocation','').Trim('"') -eq (Join-Path $previous.root 'installed')) 'Another installation prevents automatic setup recovery.';$previousInstall=$true}finally{$registered.Dispose()}}
    }
    Restore-SetupState $previous
    if(Test-Path -LiteralPath $previousChild){Remove-Item -LiteralPath $previousChild}
    $report.previousProfileRecovered=$true
    # Do not execute an interrupted installation's unverified binary. The user's real
    # profile is restored, while the durable backup/root stay available for owned cleanup.
    Assert-Condition (!$previousInstall) 'Previous user profile recovered; controlled interrupted installation still requires verified uninstall.'
    Remove-Item -LiteralPath $backupPath
    Remove-QAWorkspace $previous.root $target $repository
  }
  Assert-Condition (!(Get-Process -Name subtitle-tools -ErrorAction SilentlyContinue)) 'An existing application session must be preserved.'
  Assert-Condition (!($registry.OpenSubKey($uninstallKey)) -and !($registry.OpenSubKey('Software\Wow6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Subtitle Tools'))) 'An existing installation must be preserved.'
  Assert-Condition (!(Test-Path -LiteralPath $shortcutFolder) -and !(Test-Path -LiteralPath $desktopShortcut)) 'Existing application shortcuts must be preserved.'
  Assert-Condition (!(Test-Path -LiteralPath (Join-Path $profile 'subtitle-tools-release-smoke-backup.json'))) 'Earlier ordinary smoke recovery must finish before setup acceptance.'
  $report.setupSha256=(Get-FileHash -LiteralPath $SetupPath -Algorithm SHA256).Hash
  if ($ExpectedSha256) { Assert-Condition ($report.setupSha256 -eq $ExpectedSha256) 'Setup hash did not match the approved artifact.' }
  $report.setupBytes=(Get-Item -LiteralPath $SetupPath).Length
  $manifestPath=Join-Path (Split-Path -Parent $SetupPath) 'build-info.json'
  if (Test-Path -LiteralPath $manifestPath) { $report.sourceSha=([IO.File]::ReadAllText($manifestPath)|ConvertFrom-Json).commit }
  if (!$PortableDirectory) { $PortableDirectory=Join-Path (Split-Path -Parent $SetupPath) 'SRTTools' }
  $portableNotice=Join-Path $PortableDirectory 'THIRD_PARTY_NOTICES.txt'
  Assert-Condition (Test-Path -LiteralPath $portableNotice) 'Fixed portable license resource was missing.'
  $qaRoot=Join-Path $target ('setup-acceptance-'+[Guid]::NewGuid().ToString('N'));[IO.Directory]::CreateDirectory($qaRoot)|Out-Null
  [void](Assert-QAWorkspace $qaRoot $target $repository)
  $install=Join-Path $qaRoot 'installed'
  $candidate=@{producer=$report.producer;schemaVersion=2;token=$token;parentPid=$PID;parentStartUtcTicks=$parentStartUtcTicks;root=$qaRoot;entries=@($registryKeys|ForEach-Object {@{path=$_;snapshot=(Snapshot-Registry $_)}});store=(Snapshot-File $store);recovery=(Snapshot-File $recovery)}
  Assert-SetupState $candidate;Test-QARegistryRestorability $candidate.entries
  Write-Synced $backupPath ($utf8.GetBytes((ConvertTo-QADataJson $candidate))) ([IO.FileMode]::CreateNew)
  $state=$candidate
  # The delegated child keeps this valid seeded Store visible to the app, verifies both
  # preset kinds/settings before AND after its own workflow edits, then restores its backup.
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
  $stage='install'
  Start-SetupJob $SetupPath @('/S',('/D='+$install)) 'installer' 60000
  $exe=Join-Path $install 'subtitle-tools.exe'
  $report.installedExecutableSha256=(Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash
  $report.installedVersion=[Diagnostics.FileVersionInfo]::GetVersionInfo($exe).ProductVersion
  Assert-Condition ($report.installedVersion -eq $ExpectedVersion) 'Installed version did not match the expected release.'
  $report.noticeSha256=(Get-FileHash -LiteralPath (Join-Path $install 'THIRD_PARTY_NOTICES.txt') -Algorithm SHA256).Hash
  Assert-Condition ($report.noticeSha256 -eq (Get-FileHash -LiteralPath $portableNotice -Algorithm SHA256).Hash) 'Installed license notice did not match the fixed portable resource.'
  Assert-Condition ((Get-FileHash -LiteralPath $store -Algorithm SHA256).Hash -eq $seedHash) 'Installation modified existing settings or presets.'
  foreach($entry in $state.entries|Where-Object {$_.path -ne $manufacturer}){Assert-QADataEqual $entry.snapshot (Snapshot-Registry $entry.path)}
  $report.checks.install=$true; $report.checks.version=$true; $report.checks.licenseResource=$true; $report.checks.explorerDefaultOff=$true
  $stage='installed-native-smoke'
  $childReport=Join-Path $qaRoot 'installed-smoke.json'
  $childArgs=@('-NoProfile','-STA','-File',(Join-Path $PSScriptRoot 'windows-smoke.ps1'),'-ExePath',$exe,'-ReportPath',$childReport,'-ExpectedVersion',$ExpectedVersion,'-Scenario',$SmokeScenario,'-NsisPath',$SetupPath,'-PreserveExistingStore','-ParentLeasePath',(Join-Path $qaRoot 'lease.json'),'-ParentLeaseToken',$token)
  Start-SetupJob (Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe') $childArgs 'smoke' 900000
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
    if ([version]$ExpectedVersion -ge [version]'0.5.0') {
      foreach ($name in @('pickerAndSelection','dragAndUndoRedo','switchCancelRetainsDraft','closeCancelRetainsDraft','exactEditAndBytes','closeSaveAndExit','sourceUnchanged')) {
        Assert-Condition ($smoke.timelineChecks.$name -is [bool] -and $smoke.timelineChecks.$name) 'A required installed timeline proof was missing.'
      }
      $report.timelineChecks=$smoke.timelineChecks
    }
    Assert-Condition ($smoke.existingSettingsAndPresetsReadBefore -eq $true -and $smoke.existingSettingsAndPresetsReadAfter -eq $true) 'The installed app did not actually preserve/read existing settings and both preset kinds.'
    $report.checks.existingSettingsAndPresetsReadByApp=$true
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
    if($state){Assert-SetupWritersStopped $state}
    Uninstall-OwnedSetup
    if ($state) {
      Assert-SetupWritersStopped $state
      $report.checks.ownedWritersStopped=$true
      $childBackup=Join-Path $profile 'subtitle-tools-release-smoke-backup.json'
      if (Test-Path -LiteralPath $childBackup) {
        $pending=[IO.File]::ReadAllText($childBackup)|ConvertFrom-Json
        Assert-Condition ($pending.schemaVersion -eq 1 -and $pending.ownerToken -ceq $state.token -and $pending.ownerParentPid -eq $state.parentPid -and $pending.ownerParentStartUtcTicks -eq $state.parentStartUtcTicks) 'An unrecognized nested smoke backup was preserved.'
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
  foreach($job in $ownedJobs){$job.Dispose()}
  if($hasProfileMutex){$profileMutex.ReleaseMutex()};$profileMutex.Dispose()
  if ($hasMutex) { $mutex.ReleaseMutex() }; $mutex.Dispose()
}
Write-Host ('Setup native acceptance '+$report.status)
if ($report.status -ne 'PASS') { exit 1 }
