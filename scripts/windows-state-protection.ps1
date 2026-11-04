# Native QA state helpers. Callers must hold the QA lease and validate all paths before restoration.

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
