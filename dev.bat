@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
title QSerial - Dev Mode

echo ============================================
echo   QSerial Dev Mode (esbuild + Hot Reload)
echo ============================================
echo.

REM ==========================================
REM  Phase 1: Environment Checks
REM ==========================================
echo [1/4] Checking environment...

REM 1.1 Kill related processes to avoid file locks
echo   - Closing running QSerial/Electron processes...
taskkill /f /im QSerial.exe >nul 2>&1
taskkill /f /im electron.exe >nul 2>&1
timeout /t 1 /nobreak >nul

REM 1.2 Check Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    set "NODE_FOUND="
    for /d %%d in ("%USERPROFILE%\.workbuddy\binaries\node\versions\*") do (
        if exist "%%d\node.exe" (
            set "PATH=%%d;%PATH%"
            set "NODE_FOUND=%%d"
        )
    )
    if defined NODE_FOUND (
        echo   - Node.js: found at !NODE_FOUND!
    ) else if exist "%ProgramFiles%\nodejs\node.exe" (
        set "PATH=%ProgramFiles%\nodejs;%PATH%"
        echo   - Node.js: found at ProgramFiles\nodejs
    ) else if exist "%LOCALAPPDATA%\fnm_multishells" (
        for /f "tokens=*" %%v in ('dir /b /s "%LOCALAPPDATA%\fnm_multishells\node.exe" 2^>nul ^| findstr /v "fnm_multishells\\[0-9]"') do (
            for %%p in ("%%v\..") do set "PATH=%%~fp;%PATH%"
        )
        echo   - Node.js: found via fnm
    ) else (
        echo   [FAIL] Node.js not found! Install from https://nodejs.org
        pause
        exit /b 1
    )
)
for /f "tokens=*" %%v in ('node -v') do echo   - Node.js: %%v

REM 1.3 Check pnpm
where pnpm >nul 2>&1
if %errorlevel% neq 0 (
    if exist "%LOCALAPPDATA%\pnpm\pnpm.exe" (
        set "PATH=%LOCALAPPDATA%\pnpm;%PATH%"
        echo   - pnpm: found at LOCALAPPDATA\pnpm
    ) else if exist "%APPDATA%\npm\pnpm.cmd" (
        set "PATH=%APPDATA%\npm;%PATH%"
        echo   - pnpm: found at APPDATA\npm
    ) else (
        echo   [FAIL] pnpm not found! Install: npm i -g pnpm
        pause
        exit /b 1
    )
)
for /f "tokens=*" %%v in ('pnpm -v') do echo   - pnpm: %%v

REM 1.4 Check working directory
cd /d "%~dp0"
if not exist "package.json" (
    echo   [FAIL] package.json not found - wrong directory?
    echo   Current dir: %cd%
    pause
    exit /b 1
)
echo   - Project root: %cd%

REM 1.5 Check node_modules
if not exist "node_modules\" (
    echo   [WARN] node_modules not found, running pnpm install...
    call pnpm install --prefer-offline
)

REM 1.6 修复 @qserial/shared workspace 链接
REM     (某些环境下 pnpm 的 junction 损坏，改用真实目录复制)
if not exist "node_modules\@qserial\shared\package.json" (
    echo   - Fixing @qserial/shared workspace link (copying real dir)...
    if not exist "node_modules\@qserial" mkdir "node_modules\@qserial"
    xcopy /E /I /Y /Q "packages\shared" "node_modules\@qserial\shared" >nul 2>&1
)
if not exist "packages\main\node_modules\@qserial\shared\package.json" (
    if not exist "packages\main\node_modules\@qserial" mkdir "packages\main\node_modules\@qserial"
    xcopy /E /I /Y /Q "packages\shared" "packages\main\node_modules\@qserial\shared" >nul 2>&1
)
if not exist "packages\renderer\node_modules\@qserial\shared\package.json" (
    if not exist "packages\renderer\node_modules\@qserial" mkdir "packages\renderer\node_modules\@qserial"
    xcopy /E /I /Y /Q "packages\shared" "packages\renderer\node_modules\@qserial\shared" >nul 2>&1
)

echo   [OK] Environment check passed.
echo.

REM ==========================================
REM  Phase 2: Clean stale Vite port (5173)
REM ==========================================
echo [2/4] Cleaning stale port 5173...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":5173" ^| findstr "LISTENING" 2^>nul') do (
    if not "%%p"=="0" (
        taskkill /f /pid %%p >nul 2>&1
        echo   - Killed PID %%p on port 5173
    )
)
echo   [OK] Port check done.
echo.

REM ==========================================
REM  Phase 3: Build + Start Dev (via scripts/dev.mjs)
REM ==========================================
echo [3/4] Starting dev mode (esbuild build + Vite + Electron)...
echo.

set NODE_ENV=development
node scripts/dev.mjs
set DEV_EXIT=%errorlevel%

echo.
echo [4/4] Dev session ended (exit code !DEV_EXIT!).
if !DEV_EXIT! neq 0 pause
endlocal
