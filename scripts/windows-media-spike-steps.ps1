# This opt-in scenario reads the real WebView2 events and native Range receipt.
$stage = 'media-spike-fixtures'
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
function Read-MediaProbe([switch] $RequireClose) {
  $value = Wait-Condition {
    $node = Find-Control '媒体实测记录' $types::Edit
    if ($node) {
      $pattern = $null
      if ($node.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern,[ref]$pattern) -and $pattern.Current.Value) {
        $raw = $pattern.Current.Value
        if (!$RequireClose -or ($raw | ConvertFrom-Json).PSObject.Properties['closedDenied']) { return $raw }
      }
    }
  } 'WebView2 media evidence did not become readable.' 120000
  $value | ConvertFrom-Json
}

$report.mediaSpike = [ordered]@{ status='FAIL'; cancelPreservesIdle=$false; samples=@() }
$stage = 'media-spike-picker-cancel'
(Get-Control '字幕时间轴' $types::Hyperlink).GetCurrentPattern($invoke).Invoke()
Click-Control '选择测试视频'
[SubtitleSmokeNative]::DialogCommand((Get-Dialog '选择本地视频'), 2)
Wait-DialogClosed
Wait-Condition { (Find-Control '选择测试视频' $types::Button).Current.IsEnabled } 'Media picker cancellation did not return to the workspace.' | Out-Null
Assert-Condition (!(Get-Control '运行媒体检查' $types::Button).Current.IsEnabled) 'Cancelling the video picker created an active grant.'
$report.mediaSpike.cancelPreservesIdle=$true

foreach ($asset in $assets) {
  $stage = 'media-spike-open-' + $asset.id
  Click-Control '选择测试视频'
  Select-DialogPath '选择本地视频' $asset.file
  Click-Control '运行媒体检查'
  $sample = [ordered]@{id=$asset.id; bytes=$asset.bytes; sha256=$asset.sha256; webView=(Read-MediaProbe); handleLocked=$false; handleReleased=$false}
  $report.mediaSpike.samples += $sample
  $receipt = $sample.webView
  Assert-Condition (!$receipt.failure) ('Native media checks failed: ' + $receipt.failure)
  Assert-Condition ($receipt.grantBytes -gt 0 -and $receipt.grantBytes -lt 1024) 'The selection IPC returned more than the small grant.'
  try {
    $handle = [IO.File]::Open($asset.file,[IO.FileMode]::Open,[IO.FileAccess]::Write,[IO.FileShare]::ReadWrite)
    $handle.Dispose()
  } catch [IO.IOException] {
    $sample.handleLocked = ($_.Exception.HResult -band 0xFFFF) -in @(32,33)
  }
  Assert-Condition $sample.handleLocked 'The selected file was not protected by a read-only share lock.'
  if ($asset.expected -eq 'error') {
    Assert-Condition ($receipt.metadata.error -gt 0 -and @($receipt.events.event) -contains 'error') 'The damaged MP4 did not produce a WebView2 error.'
  } elseif ($asset.expected -eq 'play' -or !$receipt.metadata.error) {
    Assert-Condition ($receipt.metadata.duration -gt 1 -and $receipt.metadata.width -gt 0 -and !$receipt.metadata.error -and @($receipt.seeks).Count -eq 3) 'Video metadata and all three real seek positions were not confirmed.'
    foreach ($event in @('loadedmetadata','playing','pause','seeking','seeked','ended')) {
      Assert-Condition (@($receipt.events.event) -contains $event) ('Missing WebView2 event: ' + $event)
    }
    Assert-Condition ($receipt.unknownDenied -eq $true -and $receipt.responses[-1].status -eq 404) 'The unknown media token was not rejected.'
    if ($asset.bytes -gt 1MB) {
      $parts = @($receipt.responses | Where-Object { $_.status -eq 206 })
      Assert-Condition ($parts.Count -ge 3) 'The large MP4 did not return several native Range responses.'
      foreach ($part in $parts) {
        Assert-Condition ($part.range -match '^bytes=' -and $part.contentRange -match ('^bytes [0-9]+-[0-9]+/' + $asset.bytes + '$') -and
          $part.bodyBytes -gt 0 -and $part.bodyBytes -le 1MB -and $part.contentLength -eq $part.bodyBytes) 'A large MP4 response exceeded the byte budget or had invalid Range headers.'
      }
    }
  }
  $stage = 'media-spike-close-' + $asset.id
  Click-Control '关闭测试视频'
  $sample.webView = Read-MediaProbe -RequireClose
  Assert-Condition ($sample.webView.closedDenied -eq $true -and $sample.webView.responses[-1].status -eq 404) 'The closed media URL was not revoked.'
  $handle = [IO.File]::Open($asset.file,[IO.FileMode]::Open,[IO.FileAccess]::Write,[IO.FileShare]::ReadWrite)
  $handle.Dispose()
  $sample.handleReleased=$true
  Assert-Condition ((Get-FileHash -LiteralPath $asset.file -Algorithm SHA256).Hash -ceq $asset.sha256) 'A synthetic media source changed.'
  Write-Host ('PASS native media ' + $asset.id)
}
$report.mediaSpike.status='PASS'
$report.checks.import=$true; $report.checks.process=$true
$report.originalPreserved=$true; $report.preservedSourceCount=$assets.Count
