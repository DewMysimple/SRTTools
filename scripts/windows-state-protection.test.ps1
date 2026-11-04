[CmdletBinding()]
param([string] $ReportPath = '')

$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSEdition -eq 'Core') {
  $legacy = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $forward = @('-NoLogo', '-NoProfile', '-NonInteractive', '-File', $PSCommandPath)
  if ($ReportPath) { $forward += @('-ReportPath', $ReportPath) }
  & $legacy @forward
  exit $LASTEXITCODE
}
Set-StrictMode -Version Latest
function Assert-Condition($Value, [string] $Message) { if (!$Value) { throw $Message } }
. (Join-Path $PSScriptRoot 'windows-state-protection.ps1')

$report = [ordered]@{
  schemaVersion = 1
  producer = 'srttools-windows-state-protection-tests-v1'
  checkedAt = [DateTime]::UtcNow.ToString('o')
  status = 'FAIL'
  platform = [ordered]@{ powershellVersion = $PSVersionTable.PSVersion.ToString(); edition = $PSVersionTable.PSEdition; osVersion = [Environment]::OSVersion.VersionString; process64Bit = [Environment]::Is64BitProcess }
  passed = 0
  failed = 0
  checks = [Collections.Generic.List[object]]::new()
  coverage = [ordered]@{ registryDepth = 12; maximumAllowedDepth = 6; keyLimit = 128; valueLimit = 512; fullOwnerGroupDaclRoundtrip = $false; ownerDifferenceExercised = $false; groupDifferenceExercised = $false; rejectedOwnerWasSystem = $false; allRegistryWritesInOwnedFixture = $true; fixtureCleanup = $false }
}
$hive = $null; $registry = $null; $fixtureCreated = $false
$fixture = 'Software\SRTTools.QA.' + [Guid]::NewGuid().ToString('N')
$owned = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$sections = [Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Group -bor [Security.AccessControl.AccessControlSections]::Access
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$userSid = $identity.User.Value
$stableSddl = 'O:{0}G:{0}D:PAI(A;CI;KA;;;{0})' -f $userSid

function Format-TestFailure($ErrorRecord) {
  $message = [string]$ErrorRecord.Exception.Message
  $message = $message.Replace($fixture, '<owned-registry-fixture>')
  $message = [regex]::Replace($message, 'S-\d-\d+(?:-\d+)+', '<sid>')
  $message
}
function Invoke-Case([string] $Name, [scriptblock] $Test) {
  $timer = [Diagnostics.Stopwatch]::StartNew()
  try {
    & $Test | Out-Null
    $report.passed++
    $report.checks.Add([ordered]@{ name = $Name; status = 'PASS'; elapsedMs = $timer.ElapsedMilliseconds })
  } catch {
    $report.failed++
    $report.checks.Add([ordered]@{ name = $Name; status = 'FAIL'; elapsedMs = $timer.ElapsedMilliseconds; error = (Format-TestFailure $_) })
  }
}
function Assert-Rejected([scriptblock] $Action, [string] $Message) {
  $rejected = $false
  try { & $Action | Out-Null } catch { $rejected = $true }
  Assert-Condition $rejected $Message
}
function New-OwnedKey([string] $Path) {
  Assert-Condition ($Path -match '^[A-Za-z0-9._-]+(?:\\[A-Za-z0-9._-]+)*$') 'Test fixture key escaped its declared scope.'
  $part = ''
  foreach ($name in $Path.Split('\')) {
    $part = if ($part) { $part + '\' + $name } else { $name }
    [void]$owned.Add($part)
    $key = $registry.CreateSubKey($part)
    $key.Dispose()
  }
}
function Open-OwnedKey([string] $Path) {
  Assert-Condition ($owned.Contains($Path)) 'Unowned test registry access was refused.'
  $registry.OpenSubKey($Path, [Microsoft.Win32.RegistryKeyPermissionCheck]::ReadWriteSubTree, [Security.AccessControl.RegistryRights]::FullControl)
}
function New-MemorySnapshot([object[]] $Values = @(), [object[]] $Children = @(), [string] $Descriptor = $stableSddl) {
  $acl = [Security.AccessControl.RegistrySecurity]::new()
  $acl.SetSecurityDescriptorSddlForm($Descriptor)
  @{ exists = $true; values = $Values; children = $Children; security = $Descriptor; owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value; group = $acl.GetGroup([Security.Principal.SecurityIdentifier]).Value }
}
function Copy-TestData($Value) {
  $json = ConvertTo-QADataJson $Value
  (ConvertFrom-Json -InputObject ('{"payload":' + $json + '}')).payload
}
function Assert-FixtureSentinel {
  $key = Open-OwnedKey 'Protected'
  try { Assert-Condition ($key.GetValue('sentinel') -ceq 'keep exact original') 'A rejected backup changed its protected registry sentinel.' }
  finally { $key.Dispose() }
}

try {
  Assert-Condition ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT -and $PSVersionTable.PSVersion.Major -eq 5) 'State safety tests require real Windows PowerShell 5.'
  Assert-Condition ($fixture -match '^Software\\SRTTools\.QA\.[0-9a-f]{32}$') 'Test registry root was not a fresh bounded GUID fixture.'
  $hive = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryView]::Default)
  $existing = $hive.OpenSubKey($fixture)
  if ($existing) { $existing.Dispose(); throw 'A supposedly fresh test registry root already exists.' }
  $created = $hive.CreateSubKey($fixture); $fixtureCreated = $true; $created.Dispose()
  $registry = $hive.OpenSubKey($fixture, [Microsoft.Win32.RegistryKeyPermissionCheck]::ReadWriteSubTree, [Security.AccessControl.RegistryRights]::FullControl)
  $fixtureAcl = [Security.AccessControl.RegistrySecurity]::new(); $fixtureAcl.SetSecurityDescriptorSddlForm($stableSddl, $sections); $registry.SetAccessControl($fixtureAcl)
  # Binding the helper to this handle also confines its randomly named capability probes to our
  # unique fixture. It cannot write the real application's keys or the user's profile.
  New-OwnedKey 'Software'
  New-OwnedKey 'Protected'
  $key = Open-OwnedKey 'Protected'; try { $key.SetValue('sentinel', 'keep exact original', [Microsoft.Win32.RegistryValueKind]::String) } finally { $key.Dispose() }

  Invoke-Case 'JSON_exact_Int64_extremes_empty_singleton_arrays_and_reserved_fields' {
    $data = [ordered]@{ Count = 7; Keys = 'literal field'; Values = @(); min = [long]::MinValue; max = [long]::MaxValue; empty = [string[]]@(); one = [string[]]@('single'); nested = [object[]]@([ordered]@{ text = 'plain'; enabled = $true }) }
    $copy = Copy-TestData $data
    Assert-QADataEqual $data $copy
    Assert-Condition ($copy.empty -is [Array] -and $copy.empty.Count -eq 0 -and $copy.one -is [Array] -and $copy.one.Count -eq 1) 'JSON changed empty or singleton array shape.'
    Assert-Condition ($copy.min -eq [long]::MinValue -and $copy.max -eq [long]::MaxValue) 'JSON rounded an Int64 boundary.'
  }
  Invoke-Case 'JSON_full_deep_roundtrip_and_unsupported_data_rejection' {
    $nested = @{ leaf = 'full exact leaf' }
    for ($level = 0; $level -lt 12; $level++) { $nested = @{ nested = $nested } }
    Assert-QADataEqual $nested (Copy-TestData $nested)
    Assert-Rejected { ConvertTo-QADataJson @{ executable = [scriptblock]::Create('1') } } 'Non-data script blocks were accepted into a backup.'
    $tooDeep = @{ leaf = 'not serializable within bound' }
    for ($level = 0; $level -lt 50; $level++) { $tooDeep = @{ nested = $tooDeep } }
    Assert-Rejected { ConvertTo-QADataJson $tooDeep } 'Backup depth beyond its declared bound was accepted.'
  }
  Invoke-Case 'Registry_snapshot_12_level_memory_tree_rejected_before_restore' {
    $snapshot = New-MemorySnapshot -Values @(@{ name = 'sentinel'; kind = 'String'; value = 'untruncated leaf' })
    for ($level = 12; $level -gt 0; $level--) { $snapshot = New-MemorySnapshot -Children @(@{ name = 'level' + $level; snapshot = $snapshot }) }
    Assert-Rejected { Assert-QARegistrySnapshot $snapshot } 'A 12-level in-memory registry backup was accepted.'
    Assert-Rejected { Restore-Registry 'Protected' $snapshot } 'A deep invalid restore was allowed to mutate a protected key.'
    Assert-FixtureSentinel
  }
  Invoke-Case 'Registry_real_12_level_tree_snapshot_refused_leaf_unchanged' {
    $path = 'Deep'
    New-OwnedKey $path
    for ($level = 1; $level -le 12; $level++) { $path += '\level' + $level; New-OwnedKey $path }
    $leaf = Open-OwnedKey $path
    try { $leaf.SetValue('sentinel', [byte[]]@(0, 255, 13, 10, 64), [Microsoft.Win32.RegistryValueKind]::Binary) } finally { $leaf.Dispose() }
    Assert-Rejected { Snapshot-Registry 'Deep' } 'A real 12-level registry subtree was silently truncated.'
    $leaf = Open-OwnedKey $path
    try { Assert-Condition ([Convert]::ToBase64String([byte[]]$leaf.GetValue('sentinel')) -ceq 'AP8NCkA=') 'Deep snapshot refusal changed its leaf bytes.' } finally { $leaf.Dispose() }
  }
  Invoke-Case 'Registry_strict_child_shape_duplicates_and_truncation_rejected' {
    $good = New-MemorySnapshot
    $bad = New-MemorySnapshot -Children @(@{ name = 'child'; snapshot = '@{exists=True; children=System.Object[]}' })
    Assert-Rejected { Assert-QARegistrySnapshot $bad } 'A string-truncated child backup was accepted.'
    Assert-Rejected { Restore-Registry 'Protected' $bad } 'A string-truncated child restore was allowed.'
    $duplicateChildren = New-MemorySnapshot -Children @(@{ name = 'Same'; snapshot = $good }, @{ name = 'same'; snapshot = $good })
    Assert-Rejected { Assert-QARegistrySnapshot $duplicateChildren } 'Case-insensitive duplicate child names were accepted.'
    $duplicateValues = New-MemorySnapshot -Values @(@{ name = 'Same'; kind = 'String'; value = 'a' }, @{ name = 'same'; kind = 'String'; value = 'b' })
    Assert-Rejected { Assert-QARegistrySnapshot $duplicateValues } 'Case-insensitive duplicate values were accepted.'
    Assert-Rejected { Assert-QARegistrySnapshot @{ exists = $false; children = @() } } 'Absent backup with extra fields was accepted.'
    $extra = New-MemorySnapshot; $extra['unexpected'] = 'not allowed'
    Assert-Rejected { Assert-QARegistrySnapshot $extra } 'Unknown registry snapshot fields were accepted.'
    Assert-FixtureSentinel
  }
  Invoke-Case 'Registry_bad_Base64_integer_overflow_and_scalar_MultiString_rejected' {
    foreach ($kind in @('Binary', 'None')) {
      $bad = New-MemorySnapshot -Values @(@{ name = 'bad'; kind = $kind; value = '! invalid base64 !' })
      Assert-Rejected { Assert-QARegistrySnapshot $bad } 'Malformed binary backup was accepted.'
      Assert-Rejected { Restore-Registry 'Protected' $bad } 'Malformed binary backup was restored.'
    }
    $bad = New-MemorySnapshot -Values @(@{ name = 'bad'; kind = 'MultiString'; value = 'scalar is not an array' })
    Assert-Rejected { Assert-QARegistrySnapshot $bad } 'Scalar MultiString was accepted.'
    $bad = New-MemorySnapshot -Values @(@{ name = 'bad'; kind = 'DWord'; value = [long]2147483648 })
    Assert-Rejected { Assert-QARegistrySnapshot $bad } 'Overflowed DWord backup was accepted.'
    $bad = New-MemorySnapshot -Values @(@{ name = 'bad'; kind = 'QWord'; value = [uint64]::MaxValue })
    Assert-Rejected { Assert-QARegistrySnapshot $bad } 'Overflowed QWord backup was accepted.'
    Assert-Rejected { Assert-QAFileSnapshot @{ exists = $true; data = '! invalid base64 !' } } 'Malformed file backup was accepted.'
    Assert-FixtureSentinel
  }
  Invoke-Case 'Registry_key_and_value_budget_boundaries' {
    $children = @(); for ($number = 1; $number -le 127; $number++) { $children += @{ name = 'key' + $number; snapshot = (New-MemorySnapshot) } }
    Assert-QARegistrySnapshot (New-MemorySnapshot -Children $children)
    $children += @{ name = 'too-many'; snapshot = (New-MemorySnapshot) }
    Assert-Rejected { Assert-QARegistrySnapshot (New-MemorySnapshot -Children $children) } 'The 128-key backup bound was not enforced.'
    $values = @(); for ($number = 1; $number -le 512; $number++) { $values += @{ name = 'value' + $number; kind = 'DWord'; value = [int]$number } }
    Assert-QARegistrySnapshot (New-MemorySnapshot -Values $values)
    $values += @{ name = 'too-many'; kind = 'DWord'; value = 0 }
    Assert-Rejected { Assert-QARegistrySnapshot (New-MemorySnapshot -Values $values) } 'The 512-value backup bound was not enforced.'
  }
  Invoke-Case 'Registry_unrestorable_non_token_owner_refused_before_any_probe_or_mutation' {
    $before = ConvertTo-QADataJson (Snapshot-Registry 'Software')
    $outsideOwner = if (@($identity.User.Value, $identity.Owner.Value) -notcontains 'S-1-5-18') { 'S-1-5-18' } else { 'S-1-5-19' }
    $report.coverage.rejectedOwnerWasSystem = $outsideOwner -ceq 'S-1-5-18'
    $unsupported = New-MemorySnapshot -Descriptor ('O:{0}G:{1}D:PAI(A;;KA;;;{1})' -f $outsideOwner, $userSid)
    Assert-QARegistrySnapshot $unsupported
    Assert-Rejected { Test-QARegistryRestorability @(@{ path = 'Protected'; snapshot = $unsupported }) } 'An unassignable owner outside the current token bypassed capability preflight.'
    Assert-Condition ((ConvertTo-QADataJson (Snapshot-Registry 'Software')) -ceq $before) 'Owner rejection created or changed a security probe.'
    Assert-FixtureSentinel
  }
  Invoke-Case 'Registry_unstable_no_AI_descriptor_conservatively_refused' {
    $unstable = New-MemorySnapshot -Descriptor ('O:{0}G:{0}D:(A;;KA;;;{0})' -f $userSid)
    Assert-QARegistrySnapshot $unstable
    Assert-Rejected { Test-QARegistryRestorability @(@{ path = 'Protected'; snapshot = $unstable }) } 'A descriptor that Windows normalizes with AI was falsely accepted as exactly restorable.'
    Assert-Condition ((Snapshot-Registry 'Software').children.Count -eq 0) 'The rejected descriptor leaked its unique security probe.'
    Assert-FixtureSentinel
  }
  Invoke-Case 'Registry_actual_values_empty_singleton_MultiString_and_Int64_roundtrip' {
    New-OwnedKey 'Values'
    $key = Open-OwnedKey 'Values'
    try {
      $acl = [Security.AccessControl.RegistrySecurity]::new(); $acl.SetSecurityDescriptorSddlForm($stableSddl, $sections); $key.SetAccessControl($acl)
      $key.SetValue('', 'default literal', [Microsoft.Win32.RegistryValueKind]::String)
      $key.SetValue('binary', [byte[]]@(0, 255, 13, 10, 64), [Microsoft.Win32.RegistryValueKind]::Binary)
      $key.SetValue('none', [byte[]]@(1, 0, 255), [Microsoft.Win32.RegistryValueKind]::None)
      $key.SetValue('expand', '%SRTTOOLS_TEST_VARIABLE%', [Microsoft.Win32.RegistryValueKind]::ExpandString)
      $key.SetValue('empty', [string[]]@(), [Microsoft.Win32.RegistryValueKind]::MultiString)
      $key.SetValue('single', [string[]]@('one'), [Microsoft.Win32.RegistryValueKind]::MultiString)
      $key.SetValue('min', [long]::MinValue, [Microsoft.Win32.RegistryValueKind]::QWord)
      $key.SetValue('max', [long]::MaxValue, [Microsoft.Win32.RegistryValueKind]::QWord)
      $key.SetValue('dword-min', [int]::MinValue, [Microsoft.Win32.RegistryValueKind]::DWord)
      $key.SetValue('dword-max', [int]::MaxValue, [Microsoft.Win32.RegistryValueKind]::DWord)
    } finally { $key.Dispose() }
    $snapshot = Snapshot-Registry 'Values'
    $roundtrip = Copy-TestData $snapshot
    Assert-QARegistrySnapshot $roundtrip
    Test-QARegistryRestorability @(@{ path = 'Values'; snapshot = $roundtrip })
    $key = Open-OwnedKey 'Values'; try { $key.SetValue('single', [string[]]@('changed', 'twice'), [Microsoft.Win32.RegistryValueKind]::MultiString); $key.SetValue('extra', 'remove me') } finally { $key.Dispose() }
    Restore-Registry 'Values' $roundtrip
    Assert-QADataEqual $snapshot (Snapshot-Registry 'Values')
    $key = Open-OwnedKey 'Values'
    try { $empty = $key.GetValue('empty'); $single = $key.GetValue('single'); Assert-Condition ($empty -is [string[]] -and $empty.Length -eq 0 -and $single -is [string[]] -and $single.Length -eq 1 -and $single[0] -ceq 'one') 'Real registry roundtrip changed empty or singleton MultiString.' } finally { $key.Dispose() }
  }
  Invoke-Case 'Registry_full_owner_group_DACL_value_and_child_differences_restored_in_place' {
    New-OwnedKey 'Roundtrip'; New-OwnedKey 'Roundtrip\child'
    foreach ($path in @('Roundtrip', 'Roundtrip\child')) {
      $key = Open-OwnedKey $path
      try { $acl = [Security.AccessControl.RegistrySecurity]::new(); $acl.SetSecurityDescriptorSddlForm($stableSddl, $sections); $key.SetAccessControl($acl); $key.SetValue('original', 'preserve exact content') } finally { $key.Dispose() }
    }
    $snapshot = Copy-TestData (Snapshot-Registry 'Roundtrip')
    Assert-Condition ($snapshot.security.Contains('AI')) 'The stable fixture did not have a canonical AI descriptor.'
    Test-QARegistryRestorability @(@{ path = 'Roundtrip'; snapshot = $snapshot })
    $alternateOwner = $identity.Owner.Value
    $alternateGroup = @($identity.Groups | ForEach-Object { $_.Value } | Where-Object { $_ -ne $userSid })[0]
    $mutated = 'O:{0}G:{1}D:PAI(A;CI;KA;;;{2})(A;;KR;;;WD)' -f $alternateOwner, $alternateGroup, $userSid
    $key = Open-OwnedKey 'Roundtrip'
    try {
      $acl = [Security.AccessControl.RegistrySecurity]::new(); $acl.SetSecurityDescriptorSddlForm($mutated, $sections); $key.SetAccessControl($acl)
      $key.SetValue('original', 'mutated'); $key.SetValue('unexpected', 'remove me')
      $currentAcl = $key.GetAccessControl($sections)
      $report.coverage.ownerDifferenceExercised = $currentAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne $snapshot.owner
      $report.coverage.groupDifferenceExercised = $currentAcl.GetGroup([Security.Principal.SecurityIdentifier]).Value -cne $snapshot.group
      Assert-Condition ($currentAcl.GetSecurityDescriptorSddlForm($sections) -cne $snapshot.security) 'The fixture security was not actually changed.'
    } finally { $key.Dispose() }
    $registry.DeleteSubKeyTree('Roundtrip\child')
    New-OwnedKey 'Roundtrip\unexpected'
    $key = Open-OwnedKey 'Roundtrip\unexpected'; try { $key.SetValue('new', 'remove child') } finally { $key.Dispose() }
    Restore-Registry 'Roundtrip' $snapshot
    Assert-QADataEqual $snapshot (Snapshot-Registry 'Roundtrip')
    $report.coverage.fullOwnerGroupDaclRoundtrip = $true
  }
  Invoke-Case 'Registry_absent_snapshot_removes_only_owned_fixture_and_preserves_peer' {
    New-OwnedKey 'AbsentAfterRestore'; $key = Open-OwnedKey 'AbsentAfterRestore'; try { $key.SetValue('new', 'test owned data') } finally { $key.Dispose() }
    Restore-Registry 'AbsentAfterRestore' @{ exists = $false }
    Assert-Condition (!(Snapshot-Registry 'AbsentAfterRestore').exists) 'Absent restore did not remove the owned test key.'
    Assert-FixtureSentinel
  }
} catch {
  $report.failed++
  $report.checks.Add([ordered]@{ name = 'fixture_or_test_harness'; status = 'FAIL'; error = (Format-TestFailure $_) })
} finally {
  if ($registry) {
    try {
      # Nonrecursive deletion of individually recorded keys. Unexpected children stop cleanup;
      # registry links are never followed or recursively traversed by this cleanup path.
      $paths = @($owned | Sort-Object @{ Expression = { $_.Split('\').Length }; Descending = $true }, @{ Expression = { $_.Length }; Descending = $true })
      foreach ($path in $paths) {
        $key = $registry.OpenSubKey($path)
        if (!$key) { continue }
        try { Assert-Condition ($key.GetSubKeyNames().Length -eq 0) 'Unexpected registry children were preserved during exact fixture cleanup.' } finally { $key.Dispose() }
        $registry.DeleteSubKey($path)
      }
      Assert-Condition ($registry.GetSubKeyNames().Length -eq 0 -and $registry.GetValueNames().Length -eq 0) 'Unknown registry fixture content was preserved.'
      $registry.Dispose(); $registry = $null
      Assert-Condition ($fixture -match '^Software\\SRTTools\.QA\.[0-9a-f]{32}$') 'Registry cleanup root did not match its owned GUID.'
      $hive.DeleteSubKey($fixture)
      $remaining = $hive.OpenSubKey($fixture)
      if ($remaining) { $remaining.Dispose(); throw 'Owned registry fixture still exists after cleanup.' }
      $report.coverage.fixtureCleanup = $true
    } catch {
      $report.failed++
      $report.checks.Add([ordered]@{ name = 'exact_owned_fixture_cleanup'; status = 'FAIL'; error = (Format-TestFailure $_) })
    } finally { if ($registry) { $registry.Dispose(); $registry = $null } }
  } elseif (!$fixtureCreated) { $report.coverage.fixtureCleanup = $true }
  if ($hive) { $hive.Dispose() }
  $identity.Dispose()
}

if ($report.failed -eq 0 -and $report.coverage.fixtureCleanup) { $report.status = 'PASS' }
$json = ConvertTo-QADataJson $report
if ($ReportPath) {
  try {
    $absolute = [IO.Path]::GetFullPath($ReportPath)
    $target = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\src-tauri\target'))
    Assert-Condition ($absolute.StartsWith($target + '\', [StringComparison]::OrdinalIgnoreCase)) 'Test report must be inside the project target directory.'
    $parent = [IO.DirectoryInfo]::new([IO.Path]::GetDirectoryName($absolute))
    while ($parent) { Assert-Condition ($parent.Exists -and !($parent.Attributes -band [IO.FileAttributes]::ReparsePoint)) 'Test report parent was missing or a reparse point.'; $parent = $parent.Parent }
    Write-Synced $absolute ([Text.UTF8Encoding]::new($false, $true).GetBytes($json)) ([IO.FileMode]::CreateNew)
  } catch {
    $report.status = 'FAIL'; $report.failed++
    $report.checks.Add([ordered]@{ name = 'new_report_output'; status = 'FAIL'; error = (Format-TestFailure $_) })
    $json = ConvertTo-QADataJson $report
  }
}
Write-Output $json
if ($report.status -ne 'PASS') { exit 1 }
exit 0
