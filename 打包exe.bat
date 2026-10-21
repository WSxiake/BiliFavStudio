@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title 构建 BiliFav Studio
echo 请先安装 Python 3.12，并按 README 安装 requirements-dev.txt 中的依赖。
echo 正在生成桌面程序和发布包……
powershell -NoProfile -ExecutionPolicy Bypass -File "tools\build_windows.ps1"
if errorlevel 1 (
  echo 构建失败，请查看上方错误信息。
  pause
  exit /b 1
)
echo 完成。发布包在 release\v1.0.0 文件夹。
pause
endlocal
