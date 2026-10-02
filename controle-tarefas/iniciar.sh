#!/bin/sh
# Inicia o Controle de Tarefas neste computador (servidor).
cd "$(dirname "$0")"
PORTA="${PORTA:-3000}" exec node server.js
