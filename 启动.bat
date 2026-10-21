@echo off
setlocal
cd /d "%~dp0"
title BiliFav Studio

set "PY="
set "LAUNCH="

rem ---- 找一个"带控制台"的 Python，用来检查和处理依赖 ----
py -3 -c "import sys" >nul 2>&1
if not errorlevel 1 set "PY=py -3"
if defined PY goto findpyw

python -c "import sys" >nul 2>&1
if not errorlevel 1 set "PY=python"
if defined PY goto findpyw

if exist "%LOCALAPPDATA%\Programs\Python\Python312\python.exe" set "PY=%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
if defined PY goto findpyw

goto nopython

:findpyw
rem ---- 再找一个"不弹黑框"的解释器 ----
pyw -3 -c "import sys" >nul 2>&1
if not errorlevel 1 set "LAUNCH=pyw -3"
if defined LAUNCH goto checkdeps

pythonw -c "import sys" >nul 2>&1
if not errorlevel 1 set "LAUNCH=pythonw"

:checkdeps
%PY% -c "import requests" >nul 2>&1
if errorlevel 1 goto installreq

%PY% -c "import webview" >nul 2>&1
if errorlevel 1 goto installweb

goto launch

:installreq
echo.
echo   第一次运行，正在安装依赖 requests ...
echo.
%PY% -m pip install requests -i https://pypi.tuna.tsinghua.edu.cn/simple
if errorlevel 1 goto pipfail
%PY% -c "import webview" >nul 2>&1
if errorlevel 1 goto installweb
goto launch

:installweb
echo.
echo   正在安装界面组件 pywebview ...
echo.
%PY% -m pip install pywebview -i https://pypi.tuna.tsinghua.edu.cn/simple
if errorlevel 1 goto pipfail
goto launch

:launch
rem ---- 用无窗口解释器启动，不会出现黑框框 ----
if not defined LAUNCH goto launchplain
start "" %LAUNCH% "%~dp0app.py"
exit /b 0

:launchplain
echo   提示：没找到 pythonw，这次会带一个命令行窗口，用的时候别关它。
echo.
%PY% "%~dp0app.py"
exit /b %errorlevel%

:nopython
echo   [X] 没找到 Python。
echo.
echo       这个软件需要 Python 3.8 以上版本。
echo       去 https://www.python.org/downloads/ 下载安装，
echo       安装时记得勾上 "Add Python to PATH"。
echo.
pause
exit /b 1

:pipfail
echo.
echo   [X] 依赖没装上，检查一下网络。
echo       也可以手动跑这一句：
echo       %PY% -m pip install requests pywebview
echo.
pause
exit /b 1
