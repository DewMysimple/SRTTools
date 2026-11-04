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
  if (Test-Path -LiteralPath $Path) { $item=Get-Item -LiteralPath $Path -Force; Assert-Condition (!$item.PSIsContainer -and !($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) 'Store recovery target was not a regular file.' }
  if ($Snapshot.exists) {
    $bytes = [Convert]::FromBase64String($Snapshot.data)
    Write-Synced $Path $bytes
    Assert-Condition ([Convert]::ToBase64String([IO.File]::ReadAllBytes($Path)) -eq $Snapshot.data) 'Store restoration verification failed.'
  } elseif (Test-Path -LiteralPath $Path) {
    Remove-Item -LiteralPath $Path
  }
}

function Get-QAObjectMap($Value) {
  if ($Value -is [Collections.IDictionary]) { return $Value }
  Assert-Condition ($Value -is [Management.Automation.PSCustomObject]) 'Backup object shape was invalid.'
  $map=[ordered]@{}
  foreach($property in $Value.PSObject.Properties) { Assert-Condition ($property.MemberType -eq 'NoteProperty') 'Backup property was not data.'; $map[$property.Name]=$property.Value }
  $map
}
function Get-QADataKind($Value) {
  if($null -eq $Value){return 'null'}
  if($Value -is [string]){return 'string'}
  if($Value -is [bool]){return 'bool'}
  if($Value -is [byte] -or $Value -is [int16] -or $Value -is [int32] -or $Value -is [int64] -or $Value -is [uint16] -or $Value -is [uint32] -or $Value -is [uint64]){return 'integer'}
  if($Value -is [Collections.IDictionary] -or $Value -is [Management.Automation.PSCustomObject]){return 'object'}
  if($Value -is [Array] -or $Value -is [Collections.IList]){return 'array'}
  throw 'Backup contains an unsupported non-data value.'
}
function Assert-QADataBounded($Value,[int]$Depth=0,$Budget=$null) {
  if(!$Budget){$Budget=@{nodes=0;characters=0}}
  $Budget.nodes++; Assert-Condition ($Depth -le 48 -and $Budget.nodes -le 20000) 'Backup depth or item count exceeded its bound.'
  $kind=Get-QADataKind $Value
  if($kind -eq 'string'){$Budget.characters+=$Value.Length;Assert-Condition ($Budget.characters -le 64MB) 'Backup text exceeded its bound.'}
  elseif($kind -eq 'object'){$map=Get-QAObjectMap $Value;foreach($key in $map.get_Keys()){Assert-Condition ($key -is [string]) 'Backup object key was not a string.';Assert-QADataBounded $map[$key] ($Depth+1) $Budget}}
  elseif($kind -eq 'array'){foreach($item in $Value){Assert-QADataBounded $item ($Depth+1) $Budget}}
}
function Assert-QADataEqual($Left,$Right,[int]$Depth=0) {
  Assert-Condition ($Depth -le 48) 'Backup equality depth exceeded its bound.'
  $kind=Get-QADataKind $Left;Assert-Condition ($kind -eq (Get-QADataKind $Right)) 'Backup roundtrip changed a value type.'
  if($kind -eq 'object'){
    $a=Get-QAObjectMap $Left;$b=Get-QAObjectMap $Right
    Assert-Condition ($a.get_Count() -eq $b.get_Count()) 'Backup roundtrip changed object fields.'
    foreach($key in $a.get_Keys()){Assert-Condition (@($b.get_Keys()|Where-Object {$_ -ceq $key}).Count -eq 1) 'Backup roundtrip changed an object key.';Assert-QADataEqual $a[$key] $b[$key] ($Depth+1)}
  }elseif($kind -eq 'array'){
    Assert-Condition ($Left.Count -eq $Right.Count) 'Backup roundtrip changed array length.'
    for($i=0;$i -lt $Left.Count;$i++){Assert-QADataEqual $Left[$i] $Right[$i] ($Depth+1)}
  }elseif($kind -eq 'string'){Assert-Condition ([string]::Equals($Left,$Right,[StringComparison]::Ordinal)) 'Backup roundtrip changed text.'}
  elseif($kind -eq 'integer'){Assert-Condition ([decimal]$Left -eq [decimal]$Right) 'Backup roundtrip changed an integer.'}
  elseif($kind -eq 'bool'){Assert-Condition ($Left -eq $Right) 'Backup roundtrip changed a boolean.'}
}
function ConvertTo-QADataJson($Value) {
  Assert-QADataBounded $Value
  $json=ConvertTo-Json -InputObject $Value -Depth 64 -Compress -WarningAction Stop
  Assert-Condition ([Text.UTF8Encoding]::new($false,$true).GetByteCount($json) -le 64MB) 'Serialized backup exceeded its byte bound.'
  $roundtrip=(ConvertFrom-Json -InputObject ('{"payload":'+$json+'}')).payload
  Assert-QADataBounded $roundtrip;Assert-QADataEqual $Value $roundtrip
  $json
}
function Assert-QAFileSnapshot($Value) {
  $map=Get-QAObjectMap $Value
  Assert-Condition ($map.get_Count() -eq 2 -and $map.Contains('exists') -and $map.Contains('data') -and $map['exists'] -is [bool] -and $map['data'] -is [string]) 'File backup shape was invalid.'
  $bytes=[Convert]::FromBase64String($map['data']);Assert-Condition ($bytes.Length -le 16MB -and ($map['exists'] -or $bytes.Length -eq 0)) 'File backup length was invalid.'
}
function Assert-QARegistrySnapshot($Value,[int]$Depth=0,$Budget=$null) {
  if(!$Budget){$Budget=@{keys=0;values=0}}
  $Budget.keys++;Assert-Condition ($Depth -le 6 -and $Budget.keys -le 128) 'Registry backup depth or key count exceeded its bound.'
  $map=Get-QAObjectMap $Value;Assert-Condition ($map['exists'] -is [bool]) 'Registry backup existence flag was invalid.'
  if(!$map['exists']){Assert-Condition ($map.get_Count() -eq 1) 'Absent registry backup contained unknown fields.';return}
  Assert-Condition ($map.get_Count() -eq 6 -and $map.Contains('values') -and $map.Contains('children') -and $map['security'] -is [string] -and $map['owner'] -is [string] -and $map['group'] -is [string]) 'Registry backup fields were invalid.'
  Assert-Condition ((Get-QADataKind $map['values']) -eq 'array' -and (Get-QADataKind $map['children']) -eq 'array') 'Registry backup children or values were not arrays.'
  $acl=[Security.AccessControl.RegistrySecurity]::new();$acl.SetSecurityDescriptorSddlForm($map['security'])
  Assert-Condition ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ceq $map['owner'] -and $acl.GetGroup([Security.Principal.SecurityIdentifier]).Value -ceq $map['group']) 'Registry owner/group descriptor did not match.'
  $names=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach($entry in $map['values']){
    $row=Get-QAObjectMap $entry;$Budget.values++;Assert-Condition ($Budget.values -le 512 -and $row.get_Count() -eq 3 -and $row['name'] -is [string] -and $row['kind'] -is [string] -and $names.Add($row['name'])) 'Registry value backup was invalid or duplicated.'
    $kind=$row['kind'];$data=$row['value']
    if($kind -in @('String','ExpandString')){Assert-Condition ($data -is [string]) 'Registry string backup was invalid.'}
    elseif($kind -in @('Binary','None')){Assert-Condition ($data -is [string]) 'Registry binary backup was invalid.';[void][Convert]::FromBase64String($data)}
    elseif($kind -eq 'MultiString'){Assert-Condition ((Get-QADataKind $data) -eq 'array') 'Registry string array was invalid.';foreach($text in $data){Assert-Condition ($text -is [string]) 'Registry string array value was invalid.'}}
    elseif($kind -in @('DWord','QWord')){Assert-Condition ((Get-QADataKind $data) -eq 'integer') 'Registry integer backup was invalid.';if($kind -eq 'DWord'){[void][int]$data}else{[void][long]$data}}
    else{throw 'Unsupported registry value type was preserved without mutation.'}
  }
  $names.Clear()
  foreach($child in $map['children']){
    $row=Get-QAObjectMap $child;Assert-Condition ($row.get_Count() -eq 2 -and $row['name'] -is [string] -and $row['name'].Length -gt 0 -and $row['name'].Length -le 255 -and $row['name'].IndexOfAny([char[]]@('\',[char]0)) -lt 0 -and $names.Add($row['name'])) 'Registry child backup was invalid or duplicated.'
    Assert-Condition ($row['snapshot'].exists -eq $true) 'Registry child disappeared or its backup was truncated.'
    Assert-QARegistrySnapshot $row['snapshot'] ($Depth+1) $Budget
  }
  Assert-QADataBounded $Value
}
function Snapshot-Registry([string]$Path,[int]$Depth=0,$Budget=$null) {
  if(!$Budget){$Budget=@{keys=0;values=0}}
  $Budget.keys++;Assert-Condition ($Depth -le 6 -and $Budget.keys -le 128) 'Registry snapshot depth or key count exceeded its bound.'
  $key=$registry.OpenSubKey($Path)
  if(!$key){return @{exists=$false}}
  try{
    $values=@();$children=@()
    $valueNames=[string[]]$key.GetValueNames();[Array]::Sort($valueNames,[StringComparer]::Ordinal)
    foreach($name in $valueNames){
      $Budget.values++;Assert-Condition ($Budget.values -le 512) 'Registry snapshot value count exceeded its bound.'
      $kind=$key.GetValueKind($name).ToString();$value=$key.GetValue($name,$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      if($kind -in @('Binary','None')){$value=[Convert]::ToBase64String([byte[]]$value)}
      $values+=@{name=$name;kind=$kind;value=$value}
    }
    $childNames=[string[]]$key.GetSubKeyNames();[Array]::Sort($childNames,[StringComparer]::Ordinal)
    foreach($name in $childNames){$child=Snapshot-Registry ($Path+'\'+$name) ($Depth+1) $Budget;Assert-Condition $child.exists 'Registry subtree changed during snapshot.';$children+=@{name=$name;snapshot=$child}}
    $sections=[Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Group
    $acl=$key.GetAccessControl($sections)
    $snapshot=@{exists=$true;values=$values;children=$children;security=$acl.GetSecurityDescriptorSddlForm($sections);owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value;group=$acl.GetGroup([Security.Principal.SecurityIdentifier]).Value}
    Assert-QARegistrySnapshot $snapshot
    $snapshot
  }finally{$key.Dispose()}
}

function Test-QARegistryRestorability($Entries) {
  $descriptors=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
  $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
  $owners=@($identity.User.Value,$identity.Owner.Value)
  $groups=@($identity.Groups|ForEach-Object{$_.Value})+$owners
  function Add-QADescriptor($Snapshot){Assert-QARegistrySnapshot $Snapshot;if($Snapshot.exists){Assert-Condition ($owners -contains $Snapshot.owner -and $groups -contains $Snapshot.group) 'Registry owner or group cannot be restored without changing privileges.';[void]$descriptors.Add($Snapshot.security);foreach($child in $Snapshot.children){Add-QADescriptor $child.snapshot}}}
  foreach($entry in $Entries){Add-QADescriptor $entry.snapshot}
  if(!$descriptors.Count){return}
  $path='Software\SRTTools-QA-Security-'+[Guid]::NewGuid().ToString('N')
  Assert-Condition (!$registry.OpenSubKey($path)) 'Registry security probe already existed.'
  $created=$registry.CreateSubKey($path);$created.Dispose()
  $key=$registry.OpenSubKey($path,[Microsoft.Win32.RegistryKeyPermissionCheck]::ReadWriteSubTree,[Security.AccessControl.RegistryRights]::FullControl)
  try{
    $sections=[Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Group
    $original=$key.GetAccessControl($sections).GetSecurityDescriptorSddlForm($sections)
    foreach($descriptor in $descriptors){
      try{
        $acl=[Security.AccessControl.RegistrySecurity]::new();$acl.SetSecurityDescriptorSddlForm($descriptor,$sections);$key.SetAccessControl($acl)
        Assert-Condition ($key.GetAccessControl($sections).GetSecurityDescriptorSddlForm($sections) -ceq $descriptor) 'Registry owner/group/DACL cannot be restored exactly under current permissions.'
        $fresh=$registry.OpenSubKey($path,[Microsoft.Win32.RegistryKeyPermissionCheck]::ReadWriteSubTree,[Security.AccessControl.RegistryRights]::FullControl)
        Assert-Condition ([bool]$fresh) 'Restored registry security does not permit safe recovery.';$fresh.Dispose()
      }finally{$reset=[Security.AccessControl.RegistrySecurity]::new();$reset.SetSecurityDescriptorSddlForm($original,$sections);$key.SetAccessControl($reset)}
    }
  }finally{$key.Dispose();$registry.DeleteSubKeyTree($path)}
}

function Restore-Registry([string]$Path,$Snapshot) {
  Assert-QARegistrySnapshot $Snapshot
  $current=Snapshot-Registry $Path
  if((ConvertTo-QADataJson $current) -ceq (ConvertTo-QADataJson $Snapshot)){return}
  if(!$Snapshot.exists){if($current.exists){$registry.DeleteSubKeyTree($Path)};return}
  # Preserve existing key identity/security. Only missing keys need recreation; preflight
  # already proved every saved owner, group and DACL can be assigned without privilege changes.
  $created=$registry.CreateSubKey($Path);$created.Dispose()
  $key=$registry.OpenSubKey($Path,[Microsoft.Win32.RegistryKeyPermissionCheck]::ReadWriteSubTree,[Security.AccessControl.RegistryRights]::FullControl)
  try{
    $wanted=@($Snapshot.values|ForEach-Object{$_.name})
    foreach($name in $key.GetValueNames()){if($wanted -notcontains $name){$key.DeleteValue($name)}}
    foreach($entry in $Snapshot.values){
      $kind=[Enum]::Parse([Microsoft.Win32.RegistryValueKind],[string]$entry.kind);$value=$entry.value
      if($entry.kind -in @('Binary','None')){$value=[Convert]::FromBase64String($value)}elseif($entry.kind -eq 'DWord'){$value=[int]$value}elseif($entry.kind -eq 'QWord'){$value=[long]$value}elseif($entry.kind -eq 'MultiString'){$value=[string[]]$value}
      $key.SetValue([string]$entry.name,$value,$kind)
    }
    $wanted=@($Snapshot.children|ForEach-Object{$_.name})
    foreach($name in $key.GetSubKeyNames()){if($wanted -notcontains $name){$key.DeleteSubKeyTree($name)}}
    foreach($child in $Snapshot.children){Restore-Registry ($Path+'\'+$child.name) $child.snapshot}
    $sections=[Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Group
    if($key.GetAccessControl($sections).GetSecurityDescriptorSddlForm($sections) -cne $Snapshot.security){$acl=[Security.AccessControl.RegistrySecurity]::new();$acl.SetSecurityDescriptorSddlForm([string]$Snapshot.security,$sections);$key.SetAccessControl($acl)}
  }finally{$key.Dispose()}
  Assert-QADataEqual $Snapshot (Snapshot-Registry $Path)
}
