# Installs LibreHardwareMonitor (portable) for Desko's temperature/GPU readings,
# and registers an ELEVATED scheduled task so LHM launches at login with admin
# rights (sensor access) but WITHOUT a UAC prompt at each login.
#
# Run once on the Windows PC:
#   pwsh -ExecutionPolicy Bypass -File scripts/setup-lhm.ps1
# The script self-elevates (one UAC prompt at setup time only).

$ErrorActionPreference = 'Stop'

# --- self-elevate so we can register an elevated (RunLevel Highest) task ---
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "Requesting admin (one-time, to create the elevated login task)..." -ForegroundColor Yellow
    $hostExe = (Get-Process -Id $PID).Path
    Start-Process -FilePath $hostExe -Verb RunAs -ArgumentList '-ExecutionPolicy','Bypass','-File',$PSCommandPath
    exit
}

$dest = Join-Path $env:LOCALAPPDATA 'Desko\lhm'
$zip  = Join-Path $env:TEMP 'desko-lhm.zip'

Write-Host "Fetching LibreHardwareMonitor releases from GitHub..." -ForegroundColor Cyan
$api = 'https://api.github.com/repos/LibreHardwareMonitor/LibreHardwareMonitor/releases'
try {
    $rels = Invoke-RestMethod -Uri $api -Headers @{ 'User-Agent' = 'desko' } -TimeoutSec 20
} catch {
    throw "Could not reach GitHub. Check your internet connection. Error: $_"
}

# Prefer a pinned version; fall back to the latest release.
$rel = $rels | Where-Object { $_.tag_name -eq 'v0.9.4' } | Select-Object -First 1
if (-not $rel) { $rel = $rels | Select-Object -First 1 }
if (-not $rel) { throw "No LibreHardwareMonitor releases found." }
Write-Host "Using release: $($rel.tag_name)" -ForegroundColor Green

# Find the Windows x64 portable zip asset.
$asset = $rel.assets | Where-Object {
    $_.name -like '*win*x64*.zip' -or $_.name -like '*LibreHardwareMonitor*.zip'
} | Select-Object -First 1
if (-not $asset) { throw "No Windows x64 zip found in release $($rel.tag_name)." }

Write-Host "Downloading $($asset.name) ($([math]::Round($asset.size/1MB,1)) MB)..." -ForegroundColor Cyan
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zip -UseBasicParsing

if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Expand-Archive -Path $zip -DestinationPath $dest -Force
Remove-Item $zip -Force

$exe = Get-ChildItem -Path $dest -Recurse -Filter 'LibreHardwareMonitor.exe' | Select-Object -First 1
if (-not $exe) { throw "LibreHardwareMonitor.exe not found after extraction (look in $dest)." }
Write-Host "Installed to: $($exe.FullName)" -ForegroundColor Green

# Remove any old Run-key auto-start from a previous Desko version (it prompted UAC every login).
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$oldEntry = 'Desko-LibreHardwareMonitor'
if (Get-ItemProperty -Path $runKey -Name $oldEntry -ErrorAction SilentlyContinue) {
    Remove-ItemProperty -Path $runKey -Name $oldEntry -ErrorAction SilentlyContinue
    Write-Host "Removed old Run-key entry: $oldEntry" -ForegroundColor DarkGray
}

# Register an elevated scheduled task: LHM launches at logon WITH admin rights,
# no UAC prompt at login (elevation is baked into the task principal).
$taskName  = 'Desko-LibreHardwareMonitor'
$action    = New-ScheduledTaskAction   -Execute $exe.FullName
$trigger   = New-ScheduledTaskTrigger  -AtLogOn -User $env:USERNAME
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -RunLevel Highest
$settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Seconds 0)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Write-Host "Registered login task (elevated, no UAC at login): $taskName" -ForegroundColor Green

# Start it RIGHT NOW via the scheduled task (elevated, no UAC prompt). This
# also covers the case where the user wants temps today without logging off.
try { Start-ScheduledTask -TaskName $taskName | Out-Null; Write-Host "Started task now (elevated, no UAC)." -ForegroundColor Green } catch { Write-Host "Could not start task now; LHM will start at next logon." -ForegroundColor DarkYellow }

# Also launch a visible instance so the user can configure options.
Write-Host "Launching LibreHardwareMonitor once to configure options..." -ForegroundColor Cyan
Start-Process -FilePath $exe.FullName

Write-Host ""
Write-Host "==> One-time setup in the LibreHardwareMonitor window:" -ForegroundColor Yellow
Write-Host "    1. Options menu -> check 'Start minimized'"
Write-Host "    2. Options menu -> check 'Minimize on close'"
Write-Host "    3. Close the window (it keeps running in the tray and reading sensors)."
Write-Host ""
Write-Host "Done. From now on LHM starts at login automatically, elevated, no UAC prompt." -ForegroundColor Cyan
Write-Host "Desko will pick up CPU/GPU temps + GPU load automatically."
Write-Host "If temps show 'LHM offline' in the Stats footer, run: pwsh -File scripts\setup-lhm.ps1" -ForegroundColor DarkGray
Write-Host ""
Write-Host "To uninstall:" -ForegroundColor DarkGray
Write-Host "    Unregister-ScheduledTask -TaskName '$taskName' -Confirm:`$false"
Write-Host "    Remove-Item -Recurse -Force '$dest'"
