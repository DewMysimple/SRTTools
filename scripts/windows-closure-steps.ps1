# Reuse physical drag, independent comparison and batch-preset checks without enabling Explorer verbs.
. (Join-Path $PSScriptRoot 'windows-native-controls.ps1')
. (Join-Path $PSScriptRoot 'windows-desktop-interaction.ps1')
function Open-Home {
  (Get-Control '首页' $types::Hyperlink).GetCurrentPattern($invoke).Invoke()
  [void](Get-Control '让字幕处理，简单一点。')
}
function Queue-Count {
  @($application.FindAll($scope::Descendants,(Condition $element::ControlTypeProperty $types::Button)) |
    Where-Object { ([string]$_.Current.Name).StartsWith('移除 ') }).Count
}
function Stop-TestApp {
  Assert-Condition ($process.CloseMainWindow() -and $process.WaitForExit(10000)) 'Owned closure app did not exit normally.'
}
function Start-TestApp([string] $Path) {
  Assert-Condition ($Path -eq $ExePath) 'Closure restart must use the approved executable.'
  $script:process = Start-Process -FilePath $Path -WindowStyle Hidden -PassThru
  $script:application = Get-ApplicationWindow $process
  $script:applicationHandle = [IntPtr]::new($application.Current.NativeWindowHandle)
}
function New-ExternalFixture([string] $Name,[string] $Text) {
  $path=Join-Path $testRoot $Name
  [IO.File]::WriteAllText($path,$Text,$utf8)
  $originalHashes[$path]=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash
  $path
}
$text="1`r`n00:00:01,000 --> 00:00:02,000`r`n原文 🐱`r`n"
$dragDirectory=Join-Path $testRoot 'drag inputs'
[IO.Directory]::CreateDirectory($dragDirectory) | Out-Null
$fixtures=@(@{name='拖放 一.srt';body=$text},@{name='拖放 二 🐱.srt';body=$text.Replace('原文','不变')},@{name='拖放 三.srt';body=$text.Replace('原文','第三份')})
$paths=$fixtures | ForEach-Object {
  $path=Join-Path $dragDirectory $_.name;[IO.File]::WriteAllText($path,$_.body,$utf8)
  $originalHashes[$path]=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash;$path
}
$first=$paths[0];$second=$paths[1];$third=$paths[2]
$shell=New-Object -ComObject Shell.Application
$explorerWindow=$null
try {
  $shell.Explore($dragDirectory)
  $explorerWindow=Wait-Condition {
    foreach($window in $shell.Windows()) {
      try { if($window.Document.Folder.Self.Path -eq $dragDirectory) { return $window } } catch { }
    }
  } 'The owned fixture Explorer window was not available.'
  . (Join-Path $PSScriptRoot 'windows-gate5-feature-steps.ps1')
  $report.checks.import=$true
  foreach($fixture in $originalHashes.Keys) {
    Assert-Condition ((Get-FileHash -LiteralPath $fixture -Algorithm SHA256).Hash -eq $originalHashes[$fixture]) 'A closure source fixture changed.'
  }
  $report.originalPreserved=$true
  $report.preservedSourceCount=$originalHashes.Count
} finally {
  if($explorerWindow) {
    $ownedHandle=$explorerWindow.HWND
    $explorerWindow.Quit()
    Wait-Condition { !(@($shell.Windows() | Where-Object { $_.HWND -eq $ownedHandle }).Count) } 'Owned Explorer window did not close.' | Out-Null
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($explorerWindow)
  }
  [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shell)
}
