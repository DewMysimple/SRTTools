# This scenario is an opt-in technical probe against a real WebView2 process.
$stage = 'media-spike-devtools'
$fixed = @(
  @{ id='mp4-h264-aac'; name='视频 # 小样 (🐱).mp4'; expected='play' },
  @{ id='large-mp4-h264-aac'; name='large.mp4'; expected='play' },
  @{ id='mp4-h264-no-audio'; name='silent.mp4'; expected='play' },
  @{ id='damaged-mp4'; name='broken.mp4'; expected='error' },
  @{ id='webm-vp8-opus'; name='vp8.webm'; expected='observe' },
  @{ id='mov-h264-aac'; name='quicktime.mov'; expected='observe' },
  @{ id='mkv-h264-aac'; name='matroska.mkv'; expected='observe' },
  @{ id='mp4-hevc-aac'; name='hevc.mp4'; expected='observe' }
)
$fixtureRoot = Join-Path $target 'media-gate-fixtures'
[void](Assert-QANoReparse $fixtureRoot)
$assets = @($fixed | ForEach-Object {
  $fixturePath = Join-Path $fixtureRoot $_.name
  $entry = Get-Item -LiteralPath $fixturePath -Force
  Assert-Condition (!$entry.PSIsContainer -and $entry.Length -gt 0 -and !($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)) 'Media spike fixture must be a nonempty regular file.'
  [ordered]@{
    id=$_.id; file=$entry.FullName; expected=$_.expected; bytes=$entry.Length
    sha256=(Get-FileHash -LiteralPath $entry.FullName -Algorithm SHA256).Hash
  }
})
Wait-Condition {
  $parentId = $process.Id
  $owners = @(Get-CimInstance Win32_Process -Filter "name='msedgewebview2.exe' AND ParentProcessId=$parentId" | ForEach-Object ProcessId)
  $listeners = @(Get-NetTCPConnection -LocalPort $mediaProbePort -State Listen -ErrorAction SilentlyContinue)
  if (!$listeners.Count -or !$owners.Count) { return $false }
  foreach ($listener in $listeners) {
    Assert-Condition ($listener.LocalAddress -in @('127.0.0.1','::1') -and $listener.OwningProcess -in $owners) 'The probe endpoint was not owned by the isolated WebView2 loopback process.'
  }
  $true
} 'The isolated WebView2 DevTools listener did not become available.' 15000 | Out-Null
$probeInput = Join-Path $testRoot 'media-spike-input.json'
$probeOutput = Join-Path $testRoot 'media-spike-receipt.json'
[IO.File]::WriteAllText($probeInput, (@{port=$mediaProbePort;assets=$assets}|ConvertTo-Json -Depth 4), $utf8)
$script = Join-Path $PSScriptRoot 'webview-media-probe.mjs'
$node = (Get-Command node.exe -ErrorAction Stop).Source
$observer = Start-Process -FilePath $node -ArgumentList @(('"' + $script + '"'),('"' + $probeInput + '"')) -WindowStyle Hidden -PassThru `
  -RedirectStandardOutput (Join-Path $testRoot 'media-probe-out.log') -RedirectStandardError (Join-Path $testRoot 'media-probe-error.log')
try {
  $stage = 'media-spike-pickers'
  foreach ($index in @('cancel') + @(0..($assets.Count-1))) {
    Wait-Condition {
      $observer.Refresh()
      if ($observer.HasExited) { throw 'The media observer stopped before the next native picker.' }
      Test-Path -LiteralPath (Join-Path $testRoot ('media-pick-' + $index + '.ready'))
    } 'The media observer did not request the expected native picker.' 90000 | Out-Null
    if ($index -eq 'cancel') {
      [SubtitleSmokeNative]::DialogCommand((Get-Dialog '选择本地视频'), 2)
      Wait-DialogClosed
    } else {
      Select-DialogPath '选择本地视频' $assets[$index].file
    }
  }
  $stage = 'media-spike-proof'
  Assert-Condition ($observer.WaitForExit(90000) -and $observer.ExitCode -eq 0) 'The real WebView2 media observer did not pass.'
  $spike = [IO.File]::ReadAllText($probeOutput) | ConvertFrom-Json
  Assert-Condition ($spike.status -eq 'PASS' -and @($spike.samples).Count -eq $assets.Count) 'The native media receipt was incomplete.'
  foreach ($asset in $assets) {
    Assert-Condition ((Get-FileHash -LiteralPath $asset.file -Algorithm SHA256).Hash -ceq $asset.sha256) 'A synthetic media source changed.'
  }
  $report.checks.import=$true; $report.checks.process=$true
  $report.originalPreserved=$true; $report.preservedSourceCount=$assets.Count
} finally {
  if (!$observer.HasExited) { Stop-Process -Id $observer.Id; $observer.WaitForExit() }
  if (Test-Path -LiteralPath $probeOutput) {
    $report.mediaSpike = [IO.File]::ReadAllText($probeOutput) | ConvertFrom-Json
  }
  if ($observer.ExitCode -ne 0) {
    $log = Join-Path $testRoot 'media-probe-error.log'
    if (Test-Path -LiteralPath $log) { Write-Host (Get-Content -LiteralPath $log -Tail 8 | Out-String) }
  }
}
