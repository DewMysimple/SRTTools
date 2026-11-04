param(
  [Parameter(Mandatory)][string] $ExePath,
  [Parameter(Mandatory)][string] $ReportPath,
  [string] $ExpectedVersion = '0.4.0',
  [string] $NsisPath
)
$arguments = @{ ExePath = $ExePath; ReportPath = $ReportPath; Scenario = 'workflow'; ExpectedVersion = $ExpectedVersion }
if ($NsisPath) { $arguments.NsisPath = $NsisPath }
& (Join-Path $PSScriptRoot 'windows-smoke.ps1') @arguments
exit $LASTEXITCODE
