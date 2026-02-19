# PetGPT Windows Build Script
# Builds the release installer (.msi and .exe) for Windows
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-windows.ps1

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ── Colors ────────────────────────────────────────────────────────────────────
function Write-Ok   { param($msg) Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Info { param($msg) Write-Host "  [..] $msg" -ForegroundColor Cyan }
function Write-Fail { param($msg) Write-Host "  [!!] $msg" -ForegroundColor Red }

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "   PetGPT Windows Release Build" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# ── Paths ─────────────────────────────────────────────────────────────────────
$MSVC_BIN  = "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Tools\MSVC\14.33.31629\bin\HostX64\x64"
$MSVC_LIB  = "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Tools\MSVC\14.33.31629\lib\x64"
$SDK_UCRT  = "C:\Program Files (x86)\Windows Kits\10\lib\10.0.26100.0\ucrt\x64"
$SDK_UM    = "C:\Program Files (x86)\Windows Kits\10\lib\10.0.26100.0\um\x64"
$SDK_BIN   = "C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64"
$CARGO_BIN = "$env:USERPROFILE\.cargo\bin"

# ── Verify prerequisites ───────────────────────────────────────────────────────
Write-Info "Checking prerequisites..."

if (-not (Test-Path $MSVC_BIN\link.exe)) {
    Write-Fail "MSVC link.exe not found at: $MSVC_BIN"
    Write-Fail "Please install Visual Studio 2022 with C++ workload."
    exit 1
}
if (-not (Test-Path "$SDK_UM")) {
    Write-Fail "Windows SDK not found at: $SDK_UM"
    Write-Fail "Please install Windows SDK 10.0.26100."
    exit 1
}
if (-not (Test-Path "$CARGO_BIN\cargo.exe")) {
    Write-Fail "Cargo not found. Please install Rust from https://rustup.rs"
    exit 1
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Fail "Node.js not found. Please install Node.js."
    exit 1
}
Write-Ok "Prerequisites OK"

# ── Setup clean environment ────────────────────────────────────────────────────
Write-Info "Setting up MSVC environment..."

$cleanPaths = $env:PATH -split ";" | Where-Object {
    $_ -and
    $_ -notlike "*anaconda*\Library\usr\bin*" -and
    $_ -notlike "*anaconda*\Library\mingw*" -and
    $_ -notlike "*\msys*\usr\bin*"
}
$env:PATH    = ($CARGO_BIN, $MSVC_BIN, $SDK_BIN) + $cleanPaths -join ";"
$env:LIB     = "$MSVC_LIB;$SDK_UCRT;$SDK_UM"
$env:INCLUDE = "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Tools\MSVC\14.33.31629\include;C:\Program Files (x86)\Windows Kits\10\include\10.0.26100.0\ucrt;C:\Program Files (x86)\Windows Kits\10\include\10.0.26100.0\um;C:\Program Files (x86)\Windows Kits\10\include\10.0.26100.0\shared"

# Serial compilation to avoid OOM
$env:CARGO_BUILD_JOBS = "1"

Write-Ok "Environment ready (Anaconda DLL conflict removed)"

# ── Install npm dependencies if needed ────────────────────────────────────────
$ROOT = Split-Path $PSScriptRoot -Parent
Set-Location $ROOT

if (-not (Test-Path "node_modules")) {
    Write-Info "Installing npm dependencies..."
    npm install
    if ($LASTEXITCODE -ne 0) { Write-Fail "npm install failed"; exit 1 }
    Write-Ok "npm install done"
}

# ── Build ─────────────────────────────────────────────────────────────────────
Write-Info "Building release (this takes a while on first run)..."
Write-Host ""

npx tauri build

if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Fail "Build failed!"
    exit 1
}

# ── Show output ───────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Ok  "Build succeeded!"
Write-Host "========================================" -ForegroundColor Green
Write-Host ""
Write-Info "Output files:"

$bundleDir = "src-tauri\target\release\bundle"
if (Test-Path $bundleDir) {
    Get-ChildItem $bundleDir -Recurse -Include "*.msi","*.exe","*.nsis" |
        Select-Object -ExpandProperty FullName |
        ForEach-Object { Write-Host "  $_" -ForegroundColor Yellow }
} else {
    Write-Host "  $bundleDir" -ForegroundColor Yellow
}
Write-Host ""
