@echo off
set "MSVC_BIN=C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Tools\MSVC\14.33.31629\bin\HostX64\x64"
set "SDK_LIB=C:\Program Files (x86)\Windows Kits\10\lib\10.0.26100.0"
set PATH=%MSVC_BIN%;%PATH%
"%MSVC_BIN%\link.exe" %*
