$ErrorActionPreference = 'Stop'

$repo = $PSScriptRoot
$log = Join-Path $env:TEMP 'cherry-trader-launch.log'

function Write-Log {
  param([string]$Message)
  $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  Add-Content -Path $log -Value "[$stamp] $Message"
}

Write-Log 'Launcher started'

try {
  if (-not (Test-Path $repo)) {
    throw "Repo path not found: $repo"
  }

  Get-Command wsl.exe -ErrorAction Stop | Out-Null
  Write-Log 'wsl.exe found'

  Start-Process -FilePath 'wsl.exe' -ArgumentList @(
    'bash',
    '-lc',
    "cd '$repo' && exec ./scripts/launch-app.sh"
  )
  Write-Log 'WSL launcher started'

  Start-Process 'http://127.0.0.1:3000'
  Write-Log 'Browser launched'
}
catch {
  Write-Log ("Launch failed: " + $_.Exception.Message)
  Write-Host "Launch failed. See $log"
  Start-Process 'notepad.exe' -ArgumentList $log
  throw
}
