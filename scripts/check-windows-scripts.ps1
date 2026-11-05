param()
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSEdition -eq 'Core') {
  & (Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe') -NoLogo -NoProfile -File $PSCommandPath
  exit $LASTEXITCODE
}
if ($PSVersionTable.PSEdition -ne 'Desktop' -or $PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1) {
  throw 'Windows script parsing requires actual Windows PowerShell 5.1 Desktop.'
}
$scripts = @(Get-ChildItem -LiteralPath $PSScriptRoot -Filter '*.ps1' -File | Sort-Object Name)
foreach ($script in $scripts) {
  $bytes=[IO.File]::ReadAllBytes($script.FullName)
  $hasUtf8Bom=$bytes.Length -ge 3 -and $bytes[0] -eq 239 -and $bytes[1] -eq 187 -and $bytes[2] -eq 191
  if (!$hasUtf8Bom) {
    foreach($octet in $bytes) { if($octet -gt 127) { throw ('Non-ASCII PS5 scripts require UTF-8 BOM: '+$script.Name) } }
  }
  $tokens=$null; $errors=$null
  [void][Management.Automation.Language.Parser]::ParseFile($script.FullName,[ref]$tokens,[ref]$errors)
  if ($errors.Count) {
    $detail = ($errors | ForEach-Object { $script.Name + ':' + $_.Extent.StartLineNumber + ' ' + $_.Message }) -join '; '
    throw ('Windows PowerShell 5.1 parse failed: ' + $detail)
  }
}
Write-Host ('Windows PowerShell 5.1 parser PASS (' + $scripts.Count + ' files; ' + $PSVersionTable.PSVersion + '; Desktop)')
