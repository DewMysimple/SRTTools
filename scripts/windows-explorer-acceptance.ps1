param(
  [Parameter(Mandatory)][string] $ExePath,
  [Parameter(Mandatory)][string] $ReportPath,
  [Parameter(Mandatory)][string] $NsisPath,
  [string] $ExpectedVersion,
  [switch] $AllowUnavailableContextMenu
)
$arguments = @{ ExePath = $ExePath; ReportPath = $ReportPath; Scenario = 'explorer'; NsisPath = $NsisPath }
if ($ExpectedVersion) { $arguments.ExpectedVersion = $ExpectedVersion }
if ($AllowUnavailableContextMenu) { $arguments.AllowUnavailableContextMenu = $true }
& (Join-Path $PSScriptRoot 'windows-smoke.ps1') @arguments
exit $LASTEXITCODE
