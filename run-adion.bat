@echo off
title Launching Adion Browse (D: Drive Cache Protected)...
cd /d "%~dp0"

:: Enforce D: Drive for all caches, build artifacts, and neural model weights
set ELECTRON_CACHE=D:\build-cache\electron
set HF_HOME=D:\build-cache\huggingface
set TORCH_HOME=D:\build-cache\torch
set NPM_CONFIG_CACHE=D:\build-cache\npm
set TMP=D:\build-cache\tmp
set TEMP=D:\build-cache\tmp

set ELECTRON_RUN_AS_NODE=
start "" "node_modules\electron\dist\electron.exe" .
exit
