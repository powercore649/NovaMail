@echo off
title NovaMail Web
cd /d "%~dp0"
start "" http://localhost:8787
node web-server.js
pause
