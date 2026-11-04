"""Testes da integracao ESP32 -> backend -> banco -> API.

Rodar:  .venv/bin/python -m pytest -q
"""
from app import config, db
from conftest import CHAVE, linhas, payload, utc

URL = "/api/energy/readings"


# ---------------------------------------------------------------------------
# Recebimento e persistencia
# ---------------------------------------------------------------------------
def test_recebe_payload_e_persiste(cliente):
    r = cliente.post(URL, json=payload(), headers=CHAVE)
    assert r.status_code == 200, r.text
    assert r.json()["duplicada"] is False
    [l] = linhas()
    assert l["fonte"] == "ESP32_TESTE_001"
    assert l["dc_power_w"] == 850 and l["ac_power_w"] == 620
    assert l["ger_kwh_total"] == 12.5 and l["cons_kwh_total"] == 8.3
    assert l["recebido_em"]
    # Primeira leitura de cada contador: energia do intervalo desconhecida (nao zero).
    assert l["dc_wh"] is None and l["ac_wh"] is None and "base" in l["obs"]


def test_contadores_acumulados_viram_energia_do_intervalo(cliente):
    cliente.post(URL, json=payload(ts=utc(120), ger_kwh=12.500, cons_kwh=8.300), headers=CHAVE)
    cliente.post(URL, json=payload(ts=utc(60), ger_kwh=12.512, cons_kwh=8.309), headers=CHAVE)
    ult = linhas()[-1]
    assert abs(ult["dc_wh"] - 12.0) < 1e-6   # 12 Wh gerados no minuto
    assert abs(ult["ac_wh"] - 9.0) < 1e-6    # 9 Wh consumidos no minuto
    b = cliente.get("/api/bill?period=day").json()
    assert b["geracao_kwh"] == 0.012 and b["consumo_kwh"] == 0.009
    assert b["n_sem_consumo"] == 0 and b["n_sem_geracao"] == 0  # leitura-base nao conta como falha


def test_lote_em_ordem_cronologica_com_rejeicao(cliente):
    lote = [
        payload(ts=utc(60), ger_kwh=1.002, cons_kwh=2.001),
        payload(ts=utc(180), ger_kwh=1.000, cons_kwh=2.000),
        payload(ts=utc(120), ger_kwh=1.001, cons_kwh=2.0005, cons_w=-5),  # potencia negativa
    ]
    r = cliente.post(URL, json=lote, headers=CHAVE)
    # potencia negativa e erro de formato: o lote inteiro e recusado (422)
    assert r.status_code == 422
    lote[2]["consumption"]["power_w"] = 600
    r = cliente.post(URL, json=lote, headers=CHAVE)
    assert r.status_code == 200, r.text
    assert r.json()["aceitas"] == 3 and r.json()["rejeitadas"] == []
    assert [l["ts"] for l in linhas()] == sorted(l["ts"] for l in linhas())


# ---------------------------------------------------------------------------
# Seguranca
# ---------------------------------------------------------------------------
def test_sem_chave_ou_chave_errada_e_recusado(cliente):
    assert cliente.post(URL, json=payload()).status_code == 401
    assert cliente.post(URL, json=payload(), headers={"X-API-Key": "errada"}).status_code == 401
    assert linhas() == []


def test_sem_api_key_configurada_recebimento_desligado(cliente, monkeypatch):
    monkeypatch.setattr(config, "API_KEY", "")
    r = cliente.post(URL, json=payload(), headers=CHAVE)
    assert r.status_code == 503 and "API_KEY" in r.json()["detail"]


def test_dispositivo_nao_autorizado(cliente, monkeypatch):
    monkeypatch.setattr(config, "DISPOSITIVOS_PERMITIDOS", {"ESP32_ENERGIA_001"})
    assert cliente.post(URL, json=payload(device="INTRUSO"), headers=CHAVE).status_code == 403
    assert cliente.post(URL, json=payload(device="ESP32_ENERGIA_001"), headers=CHAVE).status_code == 200


def test_chave_nao_aparece_em_rotas_publicas(cliente):
    for rota in ("/api/info", "/api/energy/status", "/api/energy/current"):
        assert "chave-de-teste" not in cliente.get(rota).text


# ---------------------------------------------------------------------------
# Validacao
# ---------------------------------------------------------------------------
def test_formato_invalido_recusado_e_registrado(cliente):
    casos = [
        {**payload(), "campo_desconhecido": 1},            # campo nao previsto no contrato
        {**payload(), "device_id": "nome com espaço"},      # device_id invalido
        payload(cons_w=-1),                                 # potencia negativa
        {"device_id": "X"},                                 # sem medicoes (ver teste abaixo)
    ]
    for p in casos[:3]:
        assert cliente.post(URL, json=p, headers=CHAVE).status_code == 422
    st = cliente.get("/api/energy/status").json()["estatisticas"]
    assert st["rejeitadas"] == 3 and "JSON inválido" in st["ultimo_erro"]["motivo"]
    assert linhas() == []


def test_leitura_sem_medicoes(cliente):
    r = cliente.post(URL, json={"device_id": "ESP32_TESTE_001", "timestamp": utc()}, headers=CHAVE)
    assert r.status_code == 422 and "nenhuma medição" in r.json()["detail"]


def test_timestamps_invalidos(cliente):
    sem_fuso = payload(ts="2026-10-03T10:00:00")
    relogio_1970 = payload(ts="1970-01-01T00:00:10Z")
    futuro = payload(ts=utc(-3600))
    for p, trecho in ((sem_fuso, "fuso"), (relogio_1970, "NTP"), (futuro, "futuro")):
        r = cliente.post(URL, json=p, headers=CHAVE)
        assert r.status_code == 422 and trecho in r.json()["detail"], r.text


def test_timestamp_opcional_usa_hora_do_servidor(cliente):
    p = payload()
    del p["timestamp"]
    assert cliente.post(URL, json=p, headers=CHAVE).status_code == 200
    assert linhas()[0]["ts"]


def test_potencia_acima_do_limite(cliente):
    r = cliente.post(URL, json=payload(ger_w=50000), headers=CHAVE)
    assert r.status_code == 422 and "MAX_POTENCIA_W" in r.json()["detail"]


def test_salto_de_energia_impossivel(cliente):
    cliente.post(URL, json=payload(ts=utc(120), cons_kwh=8.0), headers=CHAVE)
    # +5 kWh em 1 minuto exigiria 300 kW
    r = cliente.post(URL, json=payload(ts=utc(60), cons_kwh=13.0), headers=CHAVE)
    assert r.status_code == 422 and "impossível" in r.json()["detail"]


def test_duplicada_e_ignorada(cliente):
    p = payload()
    assert cliente.post(URL, json=p, headers=CHAVE).json()["duplicada"] is False
    assert cliente.post(URL, json=p, headers=CHAVE).json()["duplicada"] is True
    assert len(linhas()) == 1


def test_fora_de_ordem_recusada(cliente):
    cliente.post(URL, json=payload(ts=utc(60)), headers=CHAVE)
    r = cliente.post(URL, json=payload(ts=utc(120)), headers=CHAVE)
    assert r.status_code == 409


def test_reinicio_de_contador_nao_gera_energia_negativa(cliente):
    cliente.post(URL, json=payload(ts=utc(120), ger_kwh=12.5), headers=CHAVE)
    cliente.post(URL, json=payload(ts=utc(60), ger_kwh=0.001), headers=CHAVE)  # ESP32 reiniciou
    ult = linhas()[-1]
    assert ult["dc_wh"] is None and "reinicio_contador" in ult["obs"]
    b = cliente.get("/api/bill?period=day").json()
    assert b["geracao_kwh"] >= 0 and b["n_sem_geracao"] == 1  # avisado como incompleto


def test_sensor_indisponivel_nao_vira_zero(cliente):
    cliente.post(URL, json=payload(ts=utc(120)), headers=CHAVE)
    cliente.post(URL, json=payload(ts=utc(60), cons_w=None, cons_kwh=None), headers=CHAVE)
    cur = cliente.get("/api/energy/current").json()["leitura"]
    assert cur["consumo_w"] is None and cur["saldo_w"] is None and cur["geracao_w"] == 850
    assert cliente.get("/api/bill?period=day").json()["n_sem_consumo"] == 1


# ---------------------------------------------------------------------------
# Fluxos de energia
# ---------------------------------------------------------------------------
def test_fluxos_calculados_sao_consistentes(cliente):
    seq = [(0, 0), (0.010, 0.002), (0.012, 0.010), (0.020, 0.011)]  # (ger, cons) acumulados em kWh
    for i, (g, c) in enumerate(seq):
        cliente.post(URL, json=payload(ts=utc(300 - 60 * i), ger_kwh=g, cons_kwh=c), headers=CHAVE)
    b = cliente.get("/api/bill?period=day").json()
    assert b["fluxo_origem"] == "calculado"
    assert abs(b["autoconsumo_kwh"] + b["injetada_kwh"] - b["geracao_kwh"]) <= 0.01
    assert abs(b["autoconsumo_kwh"] + b["importada_kwh"] - b["consumo_kwh"]) <= 0.01


def test_rede_medida_prevalece_sobre_calculo(cliente):
    def p(seg, g, c, imp, exp):
        return payload(ts=utc(seg), ger_kwh=g, cons_kwh=c,
                       grid={"import_power_w": 0, "export_power_w": 230,
                             "import_energy_kwh": imp, "export_energy_kwh": exp})
    cliente.post(URL, json=p(120, 12.0, 8.0, 1.0, 4.0), headers=CHAVE)
    cliente.post(URL, json=p(60, 12.010, 8.004, 1.0, 4.006), headers=CHAVE)
    b = cliente.get("/api/bill?period=day").json()
    assert b["fluxo_origem"] == "medido"
    assert linhas()[-1]["exp_wh"] == 6.0
    cur = cliente.get("/api/energy/current").json()["leitura"]
    assert cur["rede_medida"] is True and cur["rede_exportando_w"] == 230


# ---------------------------------------------------------------------------
# Comunicacao: perda e recuperacao
# ---------------------------------------------------------------------------
def test_aguardando_primeira_transmissao(cliente):
    st = cliente.get("/api/energy/status").json()
    assert st["estado"] == "aguardando_primeira_transmissao" and st["modo"] == "real"
    cur = cliente.get("/api/energy/current").json()
    assert cur["leitura"] is None and cur["atual"] is False
    assert cliente.get("/api/bill?period=month").json()["n_leituras"] == 0


def _envelhecer(segundos):
    """Simula a passagem do tempo sem transmissao."""
    from datetime import datetime, timedelta
    antigo = (datetime.now() - timedelta(seconds=segundos)).isoformat(timespec="seconds")
    with db._conn(config.DB_REAL) as con:
        con.execute("UPDATE readings SET recebido_em = ?, ts = ?", (antigo, antigo))


def test_perda_e_recuperacao_da_conexao(cliente):
    cliente.post(URL, json=payload(), headers=CHAVE)
    assert cliente.get("/api/energy/status").json()["estado"] == "conectado"
    assert cliente.get("/api/energy/current").json()["atual"] is True

    _envelhecer(120)   # passou do LIMITE_ATRASO_S (60 s)
    cur = cliente.get("/api/energy/current").json()
    assert cur["estado"] == "sem_comunicacao_recente"
    assert cur["atual"] is False and cur["leitura"]["geracao_w"] == 850  # ultima leitura, como historica

    _envelhecer(3600)  # passou do LIMITE_DESCONEXAO_S (600 s)
    assert cliente.get("/api/energy/status").json()["estado"] == "desconectado"

    cliente.post(URL, json=payload(ts=utc(), ger_kwh=12.6), headers=CHAVE)   # voltou
    st = cliente.get("/api/energy/status").json()
    assert st["estado"] == "conectado" and st["dispositivos"][0]["fonte"] == "ESP32_TESTE_001"


# ---------------------------------------------------------------------------
# Historico
# ---------------------------------------------------------------------------
def test_consulta_de_historico(cliente):
    cliente.post(URL, json=payload(ts=utc(180), ger_kwh=1.000, cons_kwh=1.000), headers=CHAVE)
    cliente.post(URL, json=payload(ts=utc(120), ger_kwh=1.050, cons_kwh=1.020), headers=CHAVE)
    cliente.post(URL, json=payload(ts=utc(60), ger_kwh=1.100, cons_kwh=1.030), headers=CHAVE)
    h = cliente.get("/api/energy/history?period=day").json()
    assert round(sum(x["geracao_kwh"] for x in h), 3) == 0.1
    assert round(sum(x["consumo_kwh"] for x in h), 3) == 0.03
    assert h == cliente.get("/api/history?period=day").json()   # rota antiga continua igual
    m = cliente.get("/api/months").json()
    assert m and m[-1]["geracao_kwh"] == 0.1


# ---------------------------------------------------------------------------
# Separacao entre modo real e modo demonstracao
# ---------------------------------------------------------------------------
def test_modo_demonstracao_nao_mistura_com_dados_reais(cliente, tmp_path, monkeypatch):
    demo = str(tmp_path / "demo.db")
    db.init_db(demo)
    db.insert_reading({"fonte": "simulador", "ts": "2026-01-01T12:00:00", "ac_power_w": 100,
                       "dc_power_w": 200, "ac_wh": 100, "dc_wh": 200}, path=demo)
    monkeypatch.setattr(config, "DEMONSTRACAO", True)
    monkeypatch.setattr(config, "MODO", "demonstracao")
    monkeypatch.setattr(config, "DB_LEITURA", demo)

    r = cliente.post(URL, json=payload(), headers=CHAVE)
    assert r.status_code == 200 and "modo demonstração" in r.json()["aviso"]
    assert len(linhas()) == 1                                     # foi para o banco REAL
    assert db.count_readings(path=demo) == 1                      # o demo nao recebeu nada
    assert cliente.get("/api/info").json()["simulado"] is True
    assert cliente.get("/api/energy/status").json()["dispositivos"][0]["fonte"] == "simulador"


def test_modo_real_nao_mostra_simulador(cliente):
    info = cliente.get("/api/info").json()
    assert info["modo"] == "real" and info["simulado"] is False


# ---------------------------------------------------------------------------
# Compatibilidade com o formato antigo
# ---------------------------------------------------------------------------
def test_formato_antigo_continua_funcionando(cliente):
    r = cliente.post("/api/ingest", headers={**CHAVE, "X-Dispositivo": "esp32-antigo"},
                     json={"ac_power_w": 320, "dc_power_w": 180, "ac_wh": 0.45, "dc_wh": 0.25})
    assert r.status_code == 200, r.text
    assert linhas()[0]["fonte"] == "esp32-antigo" and linhas()[0]["ac_wh"] == 0.45
    assert cliente.post("/api/ingest", json={"ac_power_w": 1}).status_code == 401
