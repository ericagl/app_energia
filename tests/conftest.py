"""Configuracao dos testes.

Os testes usam payloads de EXEMPLO num banco temporario, separado das
medicoes reais (dados/energia_real.db nunca e tocado).
"""
import os
import sys
import tempfile
from datetime import datetime, timedelta, timezone

import pytest

# Ambiente de teste ANTES de importar o app (config le as variaveis no import).
_TMP = tempfile.mkdtemp(prefix="energia_testes_")
os.environ.update({
    "MODO": "real",
    "API_KEY": "chave-de-teste",
    "DB_REAL": os.path.join(_TMP, "real.db"),
    "DB_DEMO": os.path.join(_TMP, "demo.db"),
    "LOG_ARQUIVO": os.path.join(_TMP, "ingestao.log"),
    "LIMITE_ATRASO_S": "60",
    "LIMITE_DESCONEXAO_S": "600",
    "MAX_POTENCIA_W": "20000",
})
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from fastapi.testclient import TestClient  # noqa: E402

from app import config, db, ingestao  # noqa: E402
from app.main import app  # noqa: E402

CHAVE = {"X-API-Key": "chave-de-teste"}


@pytest.fixture()
def cliente(tmp_path, monkeypatch):
    """Cliente HTTP com banco novo e vazio a cada teste."""
    real = str(tmp_path / "real.db")
    monkeypatch.setattr(config, "DB_REAL", real)
    monkeypatch.setattr(config, "DB_LEITURA", real)
    monkeypatch.setattr(config, "DEMONSTRACAO", False)
    monkeypatch.setattr(config, "MODO", "real")
    monkeypatch.setattr(config, "API_KEY", "chave-de-teste")
    monkeypatch.setattr(config, "DISPOSITIVOS_PERMITIDOS", set())
    for k in ("recebidas", "aceitas", "duplicadas", "rejeitadas"):
        ingestao.estatisticas[k] = 0
    ingestao.estatisticas["ultimo_erro"] = None
    db.init_db(real)
    with TestClient(app) as c:
        yield c


def utc(segundos_atras=0):
    """Timestamp ISO em UTC ('Z'), N segundos no passado."""
    t = datetime.now(timezone.utc).replace(microsecond=0) - timedelta(seconds=segundos_atras)
    return t.isoformat().replace("+00:00", "Z")


def payload(device="ESP32_TESTE_001", ts=None, ger_w=850.0, ger_kwh=12.5, cons_w=620.0, cons_kwh=8.3, grid=None):
    p = {"device_id": device, "timestamp": ts or utc()}
    if ger_w is not None or ger_kwh is not None:
        p["generation"] = {k: v for k, v in (("power_w", ger_w), ("energy_kwh", ger_kwh)) if v is not None}
    if cons_w is not None or cons_kwh is not None:
        p["consumption"] = {k: v for k, v in (("power_w", cons_w), ("energy_kwh", cons_kwh)) if v is not None}
    if grid:
        p["grid"] = grid
    return p


def linhas():
    with db._conn(config.DB_REAL) as con:
        return [dict(r) for r in con.execute("SELECT * FROM readings ORDER BY ts")]
