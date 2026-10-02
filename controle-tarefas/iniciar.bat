@echo off
REM Inicia o Controle de Tarefas neste computador (servidor).
REM Para salvar os dados em outra pasta do servidor, ajuste a linha DATA_DIR abaixo.
cd /d "%~dp0"
set PORTA=3000
REM set DATA_DIR=D:\Compartilhado\ControleTarefas
node server.js
pause
