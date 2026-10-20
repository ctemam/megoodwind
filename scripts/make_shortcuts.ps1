$ws = New-Object -ComObject WScript.Shell
$target = 'C:\Users\op\Desktop\MyAllBright\scripts\AllBright Cockpit.cmd'
$icon = 'C:\Users\op\Desktop\MyAllBright\apps\dashboard\web\favicon.ico'
$dirs = @(
  "$env:USERPROFILE\Desktop",
  "$env:APPDATA\Microsoft\Windows\Start Menu\Programs"
)
foreach ($dir in $dirs) {
  $lnk = Join-Path $dir 'AllBright Cockpit.lnk'
  $s = $ws.CreateShortcut($lnk)
  $s.TargetPath = $target
  $s.WorkingDirectory = 'C:\Users\op\Desktop\MyAllBright'
  $s.IconLocation = $icon
  $s.Description = 'AllBright Banbot Cockpit - obsidian terminal'
  $s.Save()
  Write-Output "created: $lnk"
}
