@echo off
setlocal
node "%~dp0aeg-mcp.js" %*
exit /b %errorlevel%
