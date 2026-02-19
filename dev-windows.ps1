# PetGPT Windows Dev Script
# Strips Anaconda DLL pollution and sets up clean MSVC environment for Tauri dev

$MSVC_BIN = "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Tools\MSVC\14.33.31629\bin\HostX64\x64"
$MSVC_LIB = "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Tools\MSVC\14.33.31629\lib\x64"
$SDK_UCRT = "C:\Program Files (x86)\Windows Kits\10\lib\10.0.26100.0\ucrt\x64"
$SDK_UM   = "C:\Program Files (x86)\Windows Kits\10\lib\10.0.26100.0\um\x64"
$SDK_BIN  = "C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64"
$CARGO_BIN = "$env:USERPROFILE\.cargo\bin"

# Build clean PATH: remove Anaconda problematic entries, keep the rest
$cleanPaths = $env:PATH -split ";" | Where-Object {
    $_ -and
    $_ -notlike "*anaconda*\Library\usr\bin*" -and
    $_ -notlike "*anaconda*\Library\mingw*" -and
    $_ -notlike "*\msys*\usr\bin*"
}

# Prepend required dirs
$env:PATH = ($CARGO_BIN, $MSVC_BIN, $SDK_BIN) + $cleanPaths -join ";"

# Set MSVC lib/include paths
$env:LIB     = "$MSVC_LIB;$SDK_UCRT;$SDK_UM"
$env:INCLUDE = "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Tools\MSVC\14.33.31629\include;C:\Program Files (x86)\Windows Kits\10\include\10.0.26100.0\ucrt;C:\Program Files (x86)\Windows Kits\10\include\10.0.26100.0\um;C:\Program Files (x86)\Windows Kits\10\include\10.0.26100.0\shared"

Write-Host "✓ PATH cleaned - using MSVC linker" -ForegroundColor Green
Write-Host "✓ Starting tauri dev..." -ForegroundColor Green

# Force serial compilation to avoid OOM (Windows only)
$env:CARGO_BUILD_JOBS = "1"

npx tauri dev
