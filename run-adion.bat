@echo off
title Launching Adion Browse (D: Drive Workspace Cache)...
cd /d "%~dp0"

:: Redirect all caches and temp files to project .cache directory on D: drive (Full User Permissions)
set "CACHE_DIR=%~dp0.cache"
set "ELECTRON_CACHE=%CACHE_DIR%\electron"
set "HF_HOME=%CACHE_DIR%\huggingface"
set "TORCH_HOME=%CACHE_DIR%\torch"
set "NPM_CONFIG_CACHE=%CACHE_DIR%\npm"
set "TMP=%CACHE_DIR%\tmp"
set "TEMP=%CACHE_DIR%\tmp"

:: Ensure directories exist with full user permission
if not exist "%CACHE_DIR%\electron" mkdir "%CACHE_DIR%\electron"
if not exist "%CACHE_DIR%\tmp" mkdir "%CACHE_DIR%\tmp"
if not exist "%CACHE_DIR%\context" mkdir "%CACHE_DIR%\context"

set ELECTRON_RUN_AS_NODE=
start "" "node_modules\electron\dist\electron.exe" .
exit
