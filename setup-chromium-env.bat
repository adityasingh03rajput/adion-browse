@echo off
:: Chromium Source & Toolchain Environment Configuration (D: Drive Locked)
:: Prevents C: drive exhaustion during git fetch, depot_tools, and gn/ninja builds

set "CHROMIUM_ROOT=D:\chromium"
set "DEPOT_TOOLS_PATH=D:\chromium\depot_tools"

:: Redirect all build caches and temporary object files to D:
set "TMP=D:\build-cache\tmp"
set "TEMP=D:\build-cache\tmp"
set "SCCACHE_DIR=D:\build-cache\sccache"
set "NINJA_STATUS=[%%f/%%t - %%e] "
set "DEPOT_TOOLS_WIN_TOOLCHAIN=0"

echo [Adion Engine] Chromium D: Drive environment variables configured.
echo Target Root: %CHROMIUM_ROOT%
echo Caches:      D:\build-cache\
