$ws = New-Object -ComObject WScript.Shell
$target = 'C:\Users\op\Desktop\MyAllBright\scripts\AllBright Cockpit.cmd'
$icon = 'C:\Users\op\Desktop\MyAllBright\apps\dashboard\web\allbright-logo.ico'
$dirs = @(
  "$env:USERPROFILE\Desktop",
  "$env:APPDATA\Microsoft\Windows\Start Menu\Programs"
)
foreach ($dir in $dirs) {
  $lnk = Join-Path $dir 'AllBright.lnk'
  $s = $ws.CreateShortcut($lnk)
  $s.TargetPath = $target
  $s.WorkingDirectory = 'C:\Users\op\Desktop\MyAllBright'
  $s.IconLocation = $icon
  $s.Description = 'AllBright - autonomous wealth engine'
  $s.Save()
  Write-Output "created: $lnk"
}
# remove the retired 'AllBright Cockpit' shortcuts
foreach ($dir in $dirs) {
  $old = Join-Path $dir 'AllBright Cockpit.lnk'
  if (Test-Path $old) { Remove-Item $old -Force; Write-Output "removed: $old" }
}
