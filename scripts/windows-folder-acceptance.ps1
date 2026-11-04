param(
  [Parameter(Mandatory)][string] $ExePath,
  [Parameter(Mandatory)][string] $ReportPath,
  [string] $ExpectedVersion,
  [string] $NsisPath
)

$arguments = @{ ExePath = $ExePath; ReportPath = $ReportPath; Scenario = 'folder' }
if ($ExpectedVersion) { $arguments.ExpectedVersion = $ExpectedVersion }
if ($NsisPath) { $arguments.NsisPath = $NsisPath }
& (Join-Path $PSScriptRoot 'windows-smoke.ps1') @arguments
exit $LASTEXITCODE
