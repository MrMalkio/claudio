# Puts a "Claudio" shortcut on the desktop and in the Start menu.
# Run once after `npm install`:  right-click this file > Run with PowerShell.
# The shortcut starts Claudio directly (no terminal window).
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$electron = Join-Path $here 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path $electron)) { Write-Host 'Run "npm install" in this folder first.'; exit 1 }
$shell = New-Object -ComObject WScript.Shell
$places = @([Environment]::GetFolderPath('Desktop'), (Join-Path ([Environment]::GetFolderPath('Programs')) ''))
foreach ($dir in $places) {
  $s = $shell.CreateShortcut((Join-Path $dir 'Claudio.lnk'))
  $s.TargetPath = $electron
  $s.Arguments = '"' + $here + '"'
  $s.WorkingDirectory = $here
  $s.IconLocation = (Join-Path $here 'icon.ico') + ',0'
  $s.Description = 'Record, scrub and save Claude''s Read aloud audio'
  $s.Save()
  Write-Host "Created $(Join-Path $dir 'Claudio.lnk')"
}
