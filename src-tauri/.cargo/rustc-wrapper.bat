@echo off
set "MSVC_BIN=C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Tools\MSVC\14.33.31629\bin\HostX64\x64"
set PATH=%MSVC_BIN%;%SystemRoot%\system32;%SystemRoot%;%USERPROFILE%\.cargo\bin;%PATH%
%*
