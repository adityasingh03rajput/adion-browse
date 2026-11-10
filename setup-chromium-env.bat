@echo off
:: Chromium Source & Toolchain Environment Configuration (D: Drive Project-Local)
:: Uses workspace .cache to ensure full write permissions without administrative elevation

set "PROJECT_ROOT=%~dp0"
set "CHROMIUM_ROOT=%PROJECT_ROOT%chromium"
set "DEPOT_TOOLS_PATH=%PROJECT_ROOT%chromium\depot_tools"

:: Redirect all build caches and temporary object files to project-local .cache
set "TMP=%PROJECT_ROOT%.cache\tmp"
set "TEMP=%PROJECT_ROOT%.cache\tmp"
set "SCCACHE_DIR=%PROJECT_ROOT%.cache\sccache"
set "NINJA_STATUS=[%%f/%%t - %%e] "
set "DEPOT_TOOLS_WIN_TOOLCHAIN=0"

echo [Adion Engine] Chromium D: Drive environment variables configured.
echo Project Cache: %PROJECT_ROOT%.cache
