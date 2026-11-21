@echo off
setlocal
node "%~dp0aeg.js" %*
exit /b %errorlevel%
