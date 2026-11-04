param(
  [ValidateSet('suite','sleep','tree','global-lease','delegated-lease')][string] $Mode = 'suite',
  [string] $FixtureRoot,
  [ValidatePattern('^$|^[a-z-]+\.json$')][string] $MarkerName,
  [string] $Token,
  [string] $ReportPath
)
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSEdition -eq 'Core') {
  $arguments = @('-NoLogo','-NoProfile','-STA','-File',$PSCommandPath,'-Mode',$Mode)
  if ($FixtureRoot) { $arguments+=@('-FixtureRoot',$FixtureRoot) }
  if ($MarkerName) { $arguments+=@('-MarkerName',$MarkerName) }
  if ($Token) { $arguments+=@('-Token',$Token) }
  if ($ReportPath) { $arguments+=@('-ReportPath',$ReportPath) }
  & (Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe') @arguments
  exit $LASTEXITCODE
}
function Assert-Condition($Value,[string] $Message) { if (!$Value) { throw $Message } }
. (Join-Path $PSScriptRoot 'windows-qa-safety.ps1')
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$target = Join-Path $repository 'src-tauri\target'
$powershell = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
$utf8 = [Text.UTF8Encoding]::new($false)

function Write-ProbeMarker([string] $Name) {
  $process = Get-Process -Id $PID
  $data = @{ pid=$PID; startUtcTicks=$process.StartTime.ToUniversalTime().Ticks }
  $path = Join-Path $FixtureRoot $Name
  [IO.File]::WriteAllText(($path+'.tmp'),($data|ConvertTo-Json -Compress),$utf8)
  [IO.File]::Move(($path+'.tmp'),$path)
}

if ($Mode -ne 'suite') {
  [void](Assert-QAWorkspace $FixtureRoot $target $repository 'qa-safety-test-')
  Assert-Condition ($MarkerName -match '^[a-z-]+\.json$') 'A worker marker was required.'
  $lease = $null
  try {
    if ($Mode -eq 'global-lease') { $lease=Enter-QASmokeLease '' { $false } }
    if ($Mode -eq 'delegated-lease') { $lease=Enter-QASmokeLease $Token { $true } }
    if ($Mode -eq 'tree') {
      $info = [Diagnostics.ProcessStartInfo]::new()
      $info.FileName=$powershell; $info.UseShellExecute=$false; $info.CreateNoWindow=$true
      $info.WorkingDirectory=$repository
      $childArguments=@('-NoLogo','-NoProfile','-NonInteractive','-STA','-File',$PSCommandPath,'-Mode','sleep','-FixtureRoot',$FixtureRoot,'-MarkerName','grandchild-ready.json')
      $info.Arguments=(@($childArguments|ForEach-Object {[SubtitleQaJob]::Quote($_)}) -join ' ')
      $child=[Diagnostics.Process]::Start($info)
      $child.Dispose()
    }
    Write-ProbeMarker $MarkerName
    $deadline=[DateTime]::UtcNow.AddSeconds(120)
    while (!(Test-Path -LiteralPath (Join-Path $FixtureRoot ($MarkerName+'.stop'))) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 40 }
  } finally { if ($lease) { $lease.ReleaseMutex(); $lease.Dispose() } }
  exit 0
}

if (!$ReportPath) { $ReportPath=Join-Path $target 'windows-qa-safety-test.json' }
Assert-Condition ([IO.Path]::IsPathRooted($ReportPath)) 'The test report path must be absolute.'
$ReportPath=[IO.Path]::GetFullPath($ReportPath)
$reportParent=Assert-QANoReparse ([IO.Path]::GetDirectoryName($ReportPath))
Assert-Condition (($reportParent -eq $target -or $reportParent.StartsWith($target+'\',[StringComparison]::OrdinalIgnoreCase)) -and [IO.Path]::GetExtension($ReportPath) -eq '.json') 'The test report must remain in the project target.'
if (Test-Path -LiteralPath $ReportPath) {
  $reportItem=Get-Item -LiteralPath $ReportPath -Force
  Assert-Condition (!$reportItem.PSIsContainer -and !($reportItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -and $reportItem.Length -le 1MB) 'An unknown report path was preserved.'
  Assert-Condition (([IO.File]::ReadAllText($ReportPath)|ConvertFrom-Json).producer -eq 'srttools-qa-safety-tests-v1') 'An unknown report was preserved.'
}
[void](Assert-QANoReparse $repository); [void](Assert-QANoReparse $target)
$FixtureRoot=Join-Path $target ('qa-safety-test-'+[Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($FixtureRoot)|Out-Null
[void](Assert-QAWorkspace $FixtureRoot $target $repository 'qa-safety-test-')
$ownedJobs=[Collections.Generic.List[object]]::new()
$results=[Collections.Generic.List[object]]::new()
$report=[ordered]@{schemaVersion=1;producer='srttools-qa-safety-tests-v1';status='FAIL';checkedAt=[DateTime]::UtcNow.ToString('o');powershell=$PSVersionTable.PSVersion.ToString();checks=$results;cleanupComplete=$false;fixturePreserved=$null}

function Invoke-Case([string] $Name,[scriptblock] $Body) {
  $timer=[Diagnostics.Stopwatch]::StartNew()
  try { & $Body; $results.Add(@{name=$Name;status='PASS';elapsedMs=$timer.ElapsedMilliseconds}); Write-Host ('PASS '+$Name) }
  catch { $results.Add(@{name=$Name;status='FAIL';elapsedMs=$timer.ElapsedMilliseconds;reason=$_.Exception.Message}); throw }
}
function Assert-Throws([scriptblock] $Body,[string] $Message) {
  $rejected=$false
  try { & $Body|Out-Null } catch { $rejected=$true }
  Assert-Condition $rejected $Message
}
function Wait-Marker([string] $Name) {
  $path=Join-Path $FixtureRoot $Name
  $timer=[Diagnostics.Stopwatch]::StartNew()
  while (!(Test-Path -LiteralPath $path) -and $timer.ElapsedMilliseconds -lt 20000) { Start-Sleep -Milliseconds 40 }
  Assert-Condition (Test-Path -LiteralPath $path) ('Worker did not become ready: '+$Name)
  [IO.File]::ReadAllText($path)|ConvertFrom-Json
}
function Test-ProbeAlive($Identity) {
  $process=Get-Process -Id $Identity.pid -ErrorAction SilentlyContinue
  [bool]($process -and !$process.HasExited -and $process.StartTime.ToUniversalTime().Ticks -eq [long]$Identity.startUtcTicks)
}
function Start-ProbeJob([string] $WorkerMode,[string] $Marker,[string] $WorkerToken='') {
  $arguments=@('-NoLogo','-NoProfile','-NonInteractive','-STA','-File',$PSCommandPath,'-Mode',$WorkerMode,'-FixtureRoot',$FixtureRoot,'-MarkerName',$Marker)
  if ($WorkerToken) { $arguments+=@('-Token',$WorkerToken) }
  $name='Local\SRTToolsQaSafety-'+[Guid]::NewGuid().ToString('N')
  $job=[SubtitleQaJob]::StartSuspended($name,$powershell,[string[]]$arguments,$repository)
  $ownedJobs.Add(@{job=$job;stop=(Join-Path $FixtureRoot ($Marker+'.stop'))})
  $job
}
function New-CaseRepository {
  $root=Join-Path $FixtureRoot ('repository-'+[Guid]::NewGuid().ToString('N'))
  $caseTarget=Join-Path $root 'src-tauri\target'
  [IO.Directory]::CreateDirectory($caseTarget)|Out-Null
  @{repository=$root;target=$caseTarget;root=(Join-Path $caseTarget ('setup-acceptance-'+[Guid]::NewGuid().ToString('N')))}
}
function Remove-ProbeJunction([string] $Path) {
  $item=Get-Item -LiteralPath $Path -Force
  Assert-Condition ($Path.StartsWith($FixtureRoot+'\',[StringComparison]::OrdinalIgnoreCase) -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) 'Only a fixture junction may be detached.'
  [IO.Directory]::Delete($Path,$false)
}

try {
  Invoke-Case 'suspended process cannot write before resume and duplicate job names preserve the owner' {
    $nsis=[SubtitleQaJob]::CommandLine('C:\QA App\setup.exe',[string[]]@('/S','/D=C:\QA Destination\installed'),$true)
    Assert-Condition ($nsis -ceq '"C:\QA App\setup.exe" /S /D=C:\QA Destination\installed') 'NSIS destination quoting did not preserve its final unquoted argument.'
    Assert-Throws { [SubtitleQaJob]::CommandLine('C:\QA App\setup.exe',[string[]]@('/S','/D=C:\QA"unsafe'),$true) } 'An NSIS destination containing quotes was accepted.'
    Assert-Throws { [SubtitleQaJob]::CommandLine('C:\QA App\setup.exe',[string[]]@('/UPDATE','/S'),$true) } 'Unexpected NSIS QA flags were accepted.'
    $job=Start-ProbeJob 'sleep' 'suspended-ready.json'
    Assert-Condition ($job.Active -eq 1 -and !(Test-Path -LiteralPath (Join-Path $FixtureRoot 'suspended-ready.json'))) 'The worker ran before Resume.'
    Assert-Condition (!(($job.WaitEmpty(80)))) 'A suspended process was falsely reported stopped.'
    Assert-Throws { [SubtitleQaJob]::StartSuspended($job.Name,$powershell,[string[]]@('-NoProfile','-Command','exit 0'),$repository) } 'A duplicate job name was adopted.'
    Assert-Condition ($job.Active -eq 1) 'A failed name collision stopped the original owner.'
    $job.Resume(); $identity=Wait-Marker 'suspended-ready.json'
    Assert-Condition ($identity.pid -eq $job.Pid -and [long]$identity.startUtcTicks -eq $job.StartUtcTicks) 'The process identity did not match the created handle.'
    Assert-Condition ($job.StopAndWait(5000) -and $job.Active -eq 0 -and !(Test-ProbeAlive $identity)) 'The suspended/resumed owner did not stop.'
  }
  Invoke-Case 'timeout stops an owned child and grandchild while an unrelated owned job survives' {
    $other=Start-ProbeJob 'sleep' 'unrelated-ready.json'; $other.Resume(); $otherIdentity=Wait-Marker 'unrelated-ready.json'
    $tree=Start-ProbeJob 'tree' 'tree-ready.json'; $tree.Resume(); $treeIdentity=Wait-Marker 'tree-ready.json'; $grandchild=Wait-Marker 'grandchild-ready.json'
    Assert-Condition ($tree.Active -ge 2 -and !(($tree.WaitEmpty(100)))) 'The real child/grandchild tree did not reach a timeout.'
    $reopened=[SubtitleQaJob]::OpenOwned($tree.Name)
    try { Assert-Condition ($reopened -and $reopened.StopAndWait(5000) -and $reopened.Active -eq 0) 'Recovery could not stop the same owned job.' }
    finally { if ($reopened) { $reopened.Dispose() } }
    Assert-Condition ($tree.Active -eq 0 -and !(Test-ProbeAlive $treeIdentity) -and !(Test-ProbeAlive $grandchild)) 'A late child/grandchild writer survived.'
    $otherProcess=Get-Process -Id $otherIdentity.pid -ErrorAction SilentlyContinue
    $identityAlive=Test-ProbeAlive $otherIdentity
    Assert-Condition ($other.Active -ge 1 -and $identityAlive) ('Unrelated process check: active='+$other.Active+', alive='+$identityAlive+', exited='+$otherProcess.HasExited+', expectedTicks='+$otherIdentity.startUtcTicks+', actualTicks='+$otherProcess.StartTime.ToUniversalTime().Ticks)
    Assert-Condition ($null -eq [SubtitleQaJob]::OpenOwned('Local\SRTToolsQaSafety-Missing-'+[Guid]::NewGuid().ToString('N'))) 'A nonexistent recovery job was adopted.'
  }
  Invoke-Case 'normal owned Unicode workspace is removed without touching its sibling sentinel' {
    $case=New-CaseRepository
    [IO.Directory]::CreateDirectory((Join-Path $case.root '字幕 空格\deeper'))|Out-Null
    [IO.File]::WriteAllText((Join-Path $case.root '字幕 空格\deeper\fixture.txt'),'synthetic',$utf8)
    $sentinel=Join-Path $case.target 'external-sentinel.txt'; [IO.File]::WriteAllText($sentinel,'preserved',$utf8)
    Remove-QAWorkspace $case.root $case.target $case.repository
    Assert-Condition (!(Test-Path -LiteralPath $case.root) -and [IO.File]::ReadAllText($sentinel) -ceq 'preserved') 'Workspace cleanup escaped its root.'
  }
  Invoke-Case 'a GUID root junction cannot expose or delete an external sentinel' {
    $case=New-CaseRepository
    $external=Join-Path $FixtureRoot ('external-'+[Guid]::NewGuid().ToString('N')); [IO.Directory]::CreateDirectory($external)|Out-Null
    $sentinel=Join-Path $external 'sentinel.txt'; [IO.File]::WriteAllText($sentinel,'external-root-sentinel',$utf8)
    New-Item -ItemType Junction -Path $case.root -Target $external|Out-Null
    Assert-Throws { Assert-QAWorkspace $case.root $case.target $case.repository } 'A root junction passed validation.'
    Assert-Throws { Remove-QAWorkspace $case.root $case.target $case.repository } 'A root junction was traversed for cleanup.'
    Assert-Condition ([IO.File]::ReadAllText($sentinel) -ceq 'external-root-sentinel') 'The external root sentinel changed.'
    Remove-ProbeJunction $case.root
  }
  Invoke-Case 'repository and target ancestor junctions are refused before any deletion' {
    $case=New-CaseRepository; [IO.Directory]::CreateDirectory($case.root)|Out-Null
    $sentinel=Join-Path $case.root 'sentinel.txt'; [IO.File]::WriteAllText($sentinel,'ancestor-sentinel',$utf8)
    $alias=Join-Path $FixtureRoot ('alias-'+[Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Junction -Path $alias -Target $case.repository|Out-Null
    $aliasTarget=Join-Path $alias 'src-tauri\target'; $aliasRoot=Join-Path $aliasTarget ([IO.Path]::GetFileName($case.root))
    Assert-Throws { Remove-QAWorkspace $aliasRoot $aliasTarget $alias } 'A repository ancestor junction was followed.'
    Remove-ProbeJunction $alias
    $other=New-CaseRepository; [IO.Directory]::Delete($other.target,$false)
    New-Item -ItemType Junction -Path $other.target -Target $case.target|Out-Null
    $linkedRoot=Join-Path $other.target ([IO.Path]::GetFileName($case.root))
    Assert-Throws { Remove-QAWorkspace $linkedRoot $other.target $other.repository } 'A target ancestor junction was followed.'
    Assert-Condition ([IO.File]::ReadAllText($sentinel) -ceq 'ancestor-sentinel') 'The ancestor sentinel changed.'
    Remove-ProbeJunction $other.target
  }
  Invoke-Case 'workspace names and repository-target mismatches are fail closed' {
    $case=New-CaseRepository; [IO.Directory]::CreateDirectory($case.root)|Out-Null
    $wrong=Join-Path $case.target 'setup-acceptance-manual'; [IO.Directory]::CreateDirectory($wrong)|Out-Null
    Assert-Throws { Remove-QAWorkspace $wrong $case.target $case.repository } 'A manual directory was accepted.'
    Assert-Throws { Assert-QAWorkspace $case.root $target $case.repository } 'A different repository target was accepted.'
  }
  Invoke-Case 'parent delegation requires the exact token, paths, process starts and actual ancestry' {
    $case=New-CaseRepository; [IO.Directory]::CreateDirectory((Join-Path $case.root 'installed'))|Out-Null
    $profile=Join-Path $FixtureRoot 'synthetic-profile'; [IO.Directory]::CreateDirectory($profile)|Out-Null
    $sentinel=Join-Path $profile 'sentinel.txt'; [IO.File]::WriteAllText($sentinel,'profile-sentinel',$utf8)
    $exe=Join-Path $case.root 'installed\subtitle-tools.exe'
    $self=Get-Process -Id $PID; $processInfo=Get-CimInstance Win32_Process -Filter ('ProcessId='+$PID); $parent=Get-Process -Id $processInfo.ParentProcessId
    $token=[Guid]::NewGuid().ToString('N')+[Guid]::NewGuid().ToString('N')
    $lease=@{producer='srttools-setup-lease-v1';token=$token;root=$case.root;exe=$exe;backup=(Join-Path $profile 'subtitle-tools-setup-qa-backup.json');parentPid=$parent.Id;parentStartUtcTicks=$parent.StartTime.ToUniversalTime().Ticks;childPid=$PID;childStartUtcTicks=$self.StartTime.ToUniversalTime().Ticks}
    Assert-QAParentLease $lease $token $exe $profile $case.target $case.repository
    foreach ($change in @(@{producer='unknown'},@{token=('a'*64)},@{exe=(Join-Path $case.root 'other.exe')},@{backup=(Join-Path $profile 'other.json')},@{parentStartUtcTicks=($lease.parentStartUtcTicks+1)},@{childPid=0},@{childStartUtcTicks=($lease.childStartUtcTicks+1)},@{parentPid=$PID;parentStartUtcTicks=$lease.childStartUtcTicks})) {
      $bad=$lease.Clone(); foreach ($key in $change.Keys) { $bad[$key]=$change[$key] }
      Assert-Throws { Assert-QAParentLease $bad $token $exe $profile $case.target $case.repository } 'A forged parent lease was accepted.'
    }
    Assert-Throws { Assert-QAParentLease $lease 'invalid' $exe $profile $case.target $case.repository } 'An invalid token was accepted.'
    Assert-Condition ([IO.File]::ReadAllText($sentinel) -ceq 'profile-sentinel') 'Rejected delegation modified synthetic profile data.'
  }
  Invoke-Case 'ordinary smoke rejects an outer backup and releases its failed lease' {
    Assert-Throws { Enter-QASmokeLease '' { $true } } 'An outer setup backup was ignored.'
    $guard=Enter-QASmokeLease '' { $false }
    try { Assert-Condition ($null -ne $guard) 'A failed backup check leaked the ordinary lease.' }
    finally { if ($guard) { $guard.ReleaseMutex(); $guard.Dispose() } }
    Assert-Throws { Enter-QASmokeLease ('g'*64) { $true } } 'An invalid delegated token was accepted.'
    Assert-Throws { Enter-QASmokeLease ('a'*64) { $true } } 'Delegation succeeded without an exclusive outer lease.'
  }
  Invoke-Case 'cross-process leases reject ordinary overlap, absent backups and duplicate delegated children' {
    $outer=Start-ProbeJob 'global-lease' 'global-ready.json'; $outer.Resume(); [void](Wait-Marker 'global-ready.json')
    Assert-Throws { Enter-QASmokeLease '' { $false } } 'An ordinary smoke overlapped an outer setup lease.'
    $token=[Guid]::NewGuid().ToString('N')+[Guid]::NewGuid().ToString('N')
    Assert-Throws { Enter-QASmokeLease $token { $false } } 'A delegated smoke ignored a missing backup.'
    $delegated=Start-ProbeJob 'delegated-lease' 'delegated-ready.json' $token; $delegated.Resume(); [void](Wait-Marker 'delegated-ready.json')
    Assert-Throws { Enter-QASmokeLease $token { $true } } 'A second child reused an active delegation.'
    [IO.File]::WriteAllText((Join-Path $FixtureRoot 'delegated-ready.json.stop'),'stop',$utf8)
    Assert-Condition ($delegated.WaitEmpty(5000)) 'The delegated child did not release its lease.'
    $guard=Enter-QASmokeLease $token { $true }
    try { Assert-Condition ($null -ne $guard -and $outer.Active -ge 1) 'The outer lease was lost or the delegated lease leaked.' }
    finally { if ($guard) { $guard.ReleaseMutex(); $guard.Dispose() } }
  }
  Invoke-Case 'unconfirmed writer termination prevents actual setup restoration and cleanup' {
    # Load only trusted function definitions and the actual finally block, never
    # the installer's main try body or any real profile/registry configuration.
    . (Join-Path $PSScriptRoot 'windows-state-protection.ps1')
    $tokens=$null; $errors=$null
    $ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'windows-setup-acceptance.ps1'),[ref]$tokens,[ref]$errors)
    Assert-Condition (!$errors) 'The setup driver could not be parsed.'
    foreach ($name in @('Assert-SetupState','Assert-SetupWritersStopped')) {
      $definition=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$true)
      Assert-Condition ([bool]$definition) 'A required setup guard definition was missing.'
      . ([scriptblock]::Create($definition.Extent.Text))
    }
    $mainTry=@($ast.EndBlock.Statements|Where-Object {$_ -is [Management.Automation.Language.TryStatementAst] -and $_.Finally})
    Assert-Condition ($mainTry.Count -eq 1) 'The setup finally block was not uniquely identified.'
    $finallyBody=[scriptblock]::Create(($mainTry[0].Finally.Statements|ForEach-Object {$_.Extent.Text}) -join "`n")
    $case=New-CaseRepository; [IO.Directory]::CreateDirectory($case.root)|Out-Null
    $repository=$case.repository; $target=$case.target
    $registryKeys=@('srt','vtt','ass','ssa','txt','csv'|ForEach-Object {'Software\Classes\SystemFileAssociations\.'+$_+'\shell\SRTTools.Import'})+@('Software\subtitletools\Subtitle Tools')
    $state=@{producer='srttools-setup-acceptance-v1';schemaVersion=2;token=('a'*64);parentPid=$PID;parentStartUtcTicks=(Get-Process -Id $PID).StartTime.ToUniversalTime().Ticks;root=$case.root;entries=@($registryKeys|ForEach-Object {@{path=$_;snapshot=@{exists=$false}}});store=@{exists=$false;data=''};recovery=@{exists=$false;data=''}}
    $backupPath=Join-Path $case.root 'synthetic-backup.json'; $sentinel=Join-Path $case.root 'sentinel.txt'
    [IO.File]::WriteAllText($backupPath,(ConvertTo-QADataJson $state),$utf8)
    [IO.File]::WriteAllText($sentinel,'do-not-restore-or-clean',$utf8)
    $backupHash=(Get-FileHash -LiteralPath $backupPath).Hash
    $faulty=[pscustomobject]@{stopCalls=0;disposed=$false}
    $faulty|Add-Member ScriptMethod StopAndWait {param($timeout) $this.stopCalls++; return $false}
    $faulty|Add-Member ScriptMethod Dispose {$this.disposed=$true}
    $ownedJobs=@($faulty)
    $effects=@{uninstall=$false;restore=$false;cleanup=$false}
    function Uninstall-OwnedSetup {$effects.uninstall=$true}
    function Restore-SetupState($Snapshot) {$effects.restore=$true}
    function Remove-SetupWorkspace {$effects.cleanup=$true}
    $canReport=$false; $hasProfileMutex=$false; $hasMutex=$false
    $profileMutex=[pscustomobject]@{}; $profileMutex|Add-Member ScriptMethod Dispose {}
    $mutex=[pscustomobject]@{}; $mutex|Add-Member ScriptMethod Dispose {}
    $report=@{status='FAIL';checks=@{};failureStage=$null}
    & $finallyBody
    Assert-Condition ($faulty.stopCalls -eq 1 -and $faulty.disposed -and $report.failureStage -eq 'restoration') 'The real setup finally did not fail at the writer guard.'
    Assert-Condition (!$effects.uninstall -and !$effects.restore -and !$effects.cleanup) 'Setup mutated state after failing to confirm writer termination.'
    Assert-Condition ((Get-FileHash -LiteralPath $backupPath).Hash -ceq $backupHash -and [IO.File]::ReadAllText($sentinel) -ceq 'do-not-restore-or-clean') 'The retained recovery data changed.'
  }
  $report.status='PASS'
} catch { $report.failure=$_.Exception.Message }
finally {
  foreach ($entry in $ownedJobs) {
    try {
      if ($entry.job.Active -gt 0) {
        [IO.File]::WriteAllText($entry.stop,'stop',$utf8)
        if (!$entry.job.WaitEmpty(3000)) { Assert-Condition ($entry.job.StopAndWait(5000)) 'An owned test process could not be confirmed stopped.' }
      }
      Assert-Condition ($entry.job.Active -eq 0) 'A test job retained active processes.'
    } catch { $report.status='FAIL'; $report.failure=$_.Exception.Message }
    finally { $entry.job.Dispose() }
  }
  if ($report.status -eq 'PASS') {
    try { Remove-QAWorkspace $FixtureRoot $target $repository 'qa-safety-test-'; $report.cleanupComplete=$true }
    catch { $report.status='FAIL'; $report.failure=$_.Exception.Message }
  }
  if (Test-Path -LiteralPath $FixtureRoot) { $report.fixturePreserved=$FixtureRoot }
  $report.checkCount=$results.Count
  [IO.File]::WriteAllText($ReportPath,($report|ConvertTo-Json -Depth 8),$utf8)
}
Write-Host ('Windows QA safety tests '+$report.status+' ('+$results.Count+' checks)')
if ($report.status -ne 'PASS') { throw $report.failure }
