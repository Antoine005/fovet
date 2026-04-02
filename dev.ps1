# Ardent — Dev environment launcher
# Usage    : .\dev.ps1
# Options  : -NoBrowser  (skip auto-open)
# Stop     : Ctrl+C in this window — kills all child processes

param([switch]$NoBrowser)

$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot

# ── Helpers ─────────────────────────────────────────────────────────────────
function step([string]$n, [string]$msg) {
    Write-Host "[$n] " -ForegroundColor Cyan -NoNewline; Write-Host $msg
}
function ok([string]$msg)   { Write-Host " OK  " -ForegroundColor Green  -NoNewline; Write-Host $msg }
function warn([string]$msg) { Write-Host "WARN " -ForegroundColor Yellow -NoNewline; Write-Host $msg }
function fail([string]$msg) { Write-Host "FAIL " -ForegroundColor Red    -NoNewline; Write-Host $msg }

# ── Load .env.local ──────────────────────────────────────────────────────────
$envFile = "$Root\.env.local"
if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        if ($_ -match '^([^#=\s][^=]*)=(.*)$') {
            [Environment]::SetEnvironmentVariable($matches[1].Trim(), $matches[2].Trim(), 'Process')
        }
    }
    ok ".env.local chargé"
} else {
    warn ".env.local introuvable"
}

Write-Host ""
Write-Host "══════════════════════════════════════════" -ForegroundColor DarkCyan
Write-Host "   Ardent Watch — environnement de dev   " -ForegroundColor Cyan
Write-Host "══════════════════════════════════════════" -ForegroundColor DarkCyan
Write-Host ""

# ── Process registry ────────────────────────────────────────────────────────
$script:procs = [System.Collections.Generic.List[System.Diagnostics.Process]]::new()

function Kill-All {
    if ($script:procs.Count -eq 0) { return }
    Write-Host "`nArrêt des services..." -ForegroundColor Yellow
    foreach ($p in $script:procs) {
        if ($p -and -not $p.HasExited) {
            try { & taskkill /F /T /PID $p.Id 2>$null | Out-Null } catch {}
        }
    }
    Write-Host "Terminé." -ForegroundColor Green
}

# ── 1. Mosquitto ─────────────────────────────────────────────────────────────
step "1/3" "Mosquitto..."
$mosqRunning = Get-Process mosquitto -ErrorAction SilentlyContinue
if ($mosqRunning) {
    ok "Mosquitto déjà en cours (PID $($mosqRunning.Id))"
} else {
    $mosqExe  = "C:\Program Files\Mosquitto\mosquitto.exe"
    $mosqConf = "$Root\mosquitto\mosquitto.conf"
    if (Test-Path $mosqExe) {
        $p = Start-Process -FilePath $mosqExe `
            -ArgumentList "-c `"$mosqConf`"" `
            -PassThru -WindowStyle Hidden
        $script:procs.Add($p)
        Start-Sleep -Milliseconds 800
        if (-not $p.HasExited) { ok "Mosquitto lancé (PID $($p.Id))" }
        else                   { fail "Mosquitto a crashé — vérifier $mosqConf" }
    } else {
        warn "mosquitto.exe introuvable — ignoré"
    }
}

# ── 2. MQTT Listener ─────────────────────────────────────────────────────────
step "2/3" "MQTT Listener..."
$listenerScript = "$Root\scripts\vigie_mqtt_listener.py"
# Find uv: try common install locations then fall back to PATH
$uvExe = @(
    "$env:LOCALAPPDATA\Programs\Python\Python313\Scripts\uv.exe",
    "$env:LOCALAPPDATA\Programs\Python\Python312\Scripts\uv.exe",
    "$env:USERPROFILE\.local\bin\uv.exe",
    "$env:USERPROFILE\.cargo\bin\uv.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $uvExe) {
    $uvCmd = Get-Command uv -ErrorAction SilentlyContinue
    if ($uvCmd) { $uvExe = $uvCmd.Source }
}
if ((Test-Path $listenerScript) -and $uvExe) {
    $p = Start-Process -FilePath $uvExe `
        -ArgumentList "run --with paho-mqtt `"$listenerScript`"" `
        -PassThru -WindowStyle Normal `
        -WorkingDirectory $Root
    $script:procs.Add($p)
    ok "MQTT Listener lancé (PID $($p.Id))"
} elseif (-not (Test-Path $listenerScript)) {
    warn "scripts\vigie_mqtt_listener.py introuvable — ignoré"
} else {
    warn "uv.exe introuvable — listener ignoré"
}

# ── 3. Next.js ───────────────────────────────────────────────────────────────
step "3/3" "Ardent Watch (Next.js)..."
$dashDir = "$Root\platform-dashboard"
if (Test-Path $dashDir) {
    # Kill only the node process already occupying port 3000 (if any)
    $portPid = (& netstat -ano 2>$null | Select-String ":3000 .*LISTEN" |
        ForEach-Object { ($_ -split '\s+')[-1] } | Select-Object -First 1)
    if ($portPid) {
        try { Stop-Process -Id ([int]$portPid) -Force -ErrorAction SilentlyContinue } catch {}
        Start-Sleep -Milliseconds 300
    }
    $p = Start-Process -FilePath "cmd.exe" `
        -ArgumentList "/k title Ardent Watch && cd /d `"$dashDir`" && pnpm dev" `
        -PassThru -WindowStyle Normal
    $script:procs.Add($p)
    ok "Next.js lancé (PID $($p.Id))"
} else {
    fail "platform-dashboard\ introuvable"
}

# ── Wait for port 3000 ───────────────────────────────────────────────────────
Write-Host ""
if (-not $NoBrowser) {
    Write-Host "Attente du port 3000 " -ForegroundColor DarkCyan -NoNewline
    $ready = $false
    for ($i = 0; $i -lt 30; $i++) {
        try {
            $tcp = [System.Net.Sockets.TcpClient]::new()
            $tcp.Connect("127.0.0.1", 3000)
            $tcp.Close()
            $ready = $true; break
        } catch {
            Write-Host "." -NoNewline -ForegroundColor DarkCyan
            Start-Sleep -Seconds 1
        }
    }
    Write-Host ""
    if ($ready) {
        ok "http://localhost:3000"
        Start-Process "http://localhost:3000"
    } else {
        warn "Port 3000 non disponible après 30s"
    }
}

Write-Host ""
Write-Host "══════════════════════════════════════════" -ForegroundColor DarkCyan
Write-Host "   Ardent Watch démarré !                " -ForegroundColor Green
Write-Host "   Ctrl+C pour tout arrêter              " -ForegroundColor DarkGray
Write-Host "══════════════════════════════════════════" -ForegroundColor DarkCyan
Write-Host ""

# ── Keep alive + cleanup on Ctrl+C ───────────────────────────────────────────
try {
    while ($true) { Start-Sleep -Seconds 5 }
} finally {
    Kill-All
}
