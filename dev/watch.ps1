# Dev watcher — rebuilds shell on source changes and serves via Docker.
# Usage: cd dev; .\watch.ps1 [generate.py flags]
#   e.g. .\watch.ps1 --password test --tunnel ..\webtun\webtun_servers\tunnel.php
#Requires -Version 5.1

$ErrorActionPreference = 'Stop'

$DevDir = $PSScriptRoot
$Root = (Resolve-Path (Join-Path $DevDir '..')).Path
Set-Location $Root

$ShellName = 'dev.php'
$ExtraFlags = $args
$DistShell = Join-Path $Root "dist\$ShellName"

function Get-PythonCommand {
    foreach ($candidate in @(
        ,@('python3')
        ,@('python')
        ,@('py', '-3')
        ,@('py')
    )) {
        if (-not (Get-Command $candidate[0] -ErrorAction SilentlyContinue)) { continue }
        $prefix = if ($candidate.Length -gt 1) { $candidate[1..($candidate.Length - 1)] } else { @() }
        try {
            $version = & $candidate[0] @($prefix + '--version') 2>&1
            if ($version -match 'Python 3') { return ,$candidate }
        } catch {
            continue
        }
    }
    throw 'Python 3 not found on PATH (tried python3, python, py -3, py).'
}

function Get-WatchFingerprint {
    $parts = @(
        Get-ChildItem -Path (Join-Path $Root 'src'), (Join-Path $Root 'templates') -Recurse -File -ErrorAction SilentlyContinue
        Get-Item (Join-Path $Root 'generate.py') -ErrorAction SilentlyContinue
    ) | ForEach-Object {
        '{0}|{1}' -f $_.FullName, $_.LastWriteTimeUtc.Ticks
    }
    return ($parts -join "`n")
}

function Invoke-Build {
    $python = Get-PythonCommand
    $prefix = if ($python.Length -gt 1) { $python[1..($python.Length - 1)] } else { @() }
    $out = & $python[0] @($prefix + @(
        (Join-Path $Root 'generate.py'),
        '--output', $ShellName
    ) + $ExtraFlags) 2>&1
    if ($out) {
        ($out | Select-Object -Last 1).ToString()
    }
}

function Test-SourceNewerThanShell {
    if (-not (Test-Path $DistShell)) { return $true }
    $shellTime = (Get-Item $DistShell).LastWriteTimeUtc
    return [bool]@(
        Get-ChildItem -Path (Join-Path $Root 'src'), (Join-Path $Root 'templates') -Recurse -File -ErrorAction SilentlyContinue
        Get-Item (Join-Path $Root 'generate.py') -ErrorAction SilentlyContinue
    ) | Where-Object { $_.LastWriteTimeUtc -gt $shellTime } | Select-Object -First 1
}

Write-Host '[dev] Initial build...'
Invoke-Build

Write-Host '[dev] Starting Docker containers...'
docker compose -f dev/docker-compose.yml up -d
if ($LASTEXITCODE -ne 0) {
    throw "docker compose failed (exit $LASTEXITCODE)"
}

Write-Host ''
Write-Host '============================================'
Write-Host "  Shell:  http://localhost:8888/$ShellName"
Write-Host "  Flags:  $($ExtraFlags -join ' ')"
Write-Host '============================================'
Write-Host ''
Write-Host '[dev] Watching src/ templates/ for changes (Ctrl+C to stop)...'
Write-Host '[dev] (2s poll — same fallback as watch.sh without inotifywait)'

$lastFingerprint = Get-WatchFingerprint
while ($true) {
    Start-Sleep -Seconds 2
    $fingerprint = Get-WatchFingerprint
    if ($fingerprint -eq $lastFingerprint) { continue }
    if (-not (Test-SourceNewerThanShell)) {
        $lastFingerprint = $fingerprint
        continue
    }
    $lastFingerprint = $fingerprint
    Write-Host '[dev] Change detected, rebuilding...'
    Invoke-Build
}
