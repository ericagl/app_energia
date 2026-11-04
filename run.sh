#!/usr/bin/env bash
# Sobe o servidor Casa Solar.
#   ./run.sh                -> modo REAL (leituras do ESP32), lendo a configuração do .env
#   ./run.sh demonstracao   -> valores fictícios do simulador (aviso em todas as telas)
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Configuração local (chave do ESP32, tarifa...). Veja .env.exemplo.
if [ -f .env ]; then
  set -a; . ./.env; set +a
fi

case "${1:-}" in
  demonstracao|demo) export MODO=demonstracao ;;
  real) export MODO=real ;;
  "") ;;
  *) echo "Uso: ./run.sh [real|demonstracao]" >&2; exit 2 ;;
esac

if [ "${MODO:-real}" = "real" ] && [ -z "${API_KEY:-}" ]; then
  echo "AVISO: API_KEY não definida — o servidor não vai aceitar leituras do ESP32." >&2
  echo "       Crie o .env a partir do .env.exemplo e defina API_KEY." >&2
fi

if [ ! -d ".venv" ]; then
  python3 -m venv .venv
fi

. .venv/bin/activate
python -m pip install --upgrade pip >/dev/null
pip install -r requirements.txt

exec uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
