"""API + servidor do PWA (FastAPI).

Integracao com o ESP32 (fluxo: ESP32 -> Wi-Fi -> HTTP -> backend -> SQLite -> app):
  POST /api/energy/readings  -> recebe leituras (JSON; uma ou uma lista). Exige X-API-Key.
  GET  /api/energy/current   -> leitura mais recente + se e ATUAL ou HISTORICA
  GET  /api/energy/history   -> serie por hora/dia (?period=day|month)
  GET  /api/energy/status    -> estado da comunicacao com os dispositivos

Conta de energia (usadas pela interface):
  GET  /api/info      -> identificacao da conta e modo de operacao
  GET  /api/bill      -> a "conta de luz" do periodo (?period=day|month)
  GET  /api/months    -> totais por mes
  GET  /api/insights  -> comparacoes com dias/mes anteriores
  GET  /api/latest    -> (compatibilidade) igual a /api/energy/current, formato antigo
  GET  /api/history   -> (compatibilidade) igual a /api/energy/history
  POST /api/ingest    -> (compatibilidade) formato antigo com incrementos de energia

Voz: GET /api/tts, GET /api/tts/vozes

Rodar:
  uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
"""
import asyncio
import calendar
import os
from contextlib import asynccontextmanager
from datetime import date

from fastapi import Body, FastAPI, Header, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import config, db, ingestao, simulator, tts
from .ingestao import ErroLeitura, LeituraESP32

STATIC_DIR = os.path.join(os.path.dirname(__file__), "..", "static")
log = ingestao.log
_ROTAS_RECEBIMENTO = ("/api/energy/readings", "/api/ingest")
MAX_LOTE = 200


@asynccontextmanager
async def lifespan(_app):
    db.init_db(config.DB_REAL)
    log.info("Modo de operacao: %s. Banco exibido: %s", config.MODO, config.DB_LEITURA)
    if not config.API_KEY:
        log.warning("API_KEY nao configurada: o recebimento de leituras do ESP32 esta DESLIGADO.")
    tarefa = None
    if config.DEMONSTRACAO:
        db.init_db(config.DB_DEMO)
        simulator.seed_if_empty()
        tarefa = asyncio.create_task(simulator.loop())
    yield
    if tarefa:
        tarefa.cancel()


app = FastAPI(title="Monitor de Energia", version="2.0", lifespan=lifespan)


# Erros de formato no JSON recebido tambem sao registrados (ajuda a depurar o firmware).
@app.exception_handler(RequestValidationError)
async def _erro_validacao(request: Request, exc: RequestValidationError):
    if request.url.path in _ROTAS_RECEBIMENTO:
        ingestao.estatisticas["recebidas"] += 1
        erros = "; ".join(f"{'.'.join(str(p) for p in e['loc'][1:])}: {e['msg']}" for e in exc.errors()[:5])
        ingestao._falha(request.headers.get("x-dispositivo") or "?", "JSON inválido: " + erros)
    return JSONResponse(status_code=422, content={"detail": exc.errors()})


def _autorizar(x_api_key):
    if not config.API_KEY:
        raise HTTPException(503, "Recebimento desligado: defina API_KEY no servidor (veja .env.exemplo).")
    if not ingestao.chave_valida(x_api_key):
        ingestao.estatisticas["recebidas"] += 1
        ingestao._falha("?", "X-API-Key inválida ou ausente")
        raise HTTPException(401, "X-API-Key inválida ou ausente")


# ---------------------------------------------------------------------------
# Integracao com o ESP32
# ---------------------------------------------------------------------------
@app.post("/api/energy/readings")
def api_receber(
    payload: LeituraESP32 | list[LeituraESP32] = Body(...),
    x_api_key: str | None = Header(default=None),
):
    _autorizar(x_api_key)
    aviso = ("Servidor em modo demonstração: a leitura foi guardada no banco real, "
             "mas a interface está mostrando dados simulados.") if config.DEMONSTRACAO else None

    if isinstance(payload, LeituraESP32):
        try:
            r = ingestao.registrar(payload)
        except ErroLeitura as e:
            raise HTTPException(e.status, e.motivo)
        return {**r, "aviso": aviso} if aviso else r

    # Lote (ex.: leituras guardadas enquanto o Wi-Fi caiu), em ordem cronologica.
    if len(payload) > MAX_LOTE:
        raise HTTPException(413, f"Lote com {len(payload)} leituras; máximo {MAX_LOTE}.")
    ordem = sorted(range(len(payload)), key=lambda i: (payload[i].timestamp is None, payload[i].timestamp or 0))
    res = {"aceitas": 0, "duplicadas": 0, "rejeitadas": []}
    for i in ordem:
        try:
            r = ingestao.registrar(payload[i])
            res["duplicadas" if r["duplicada"] else "aceitas"] += 1
        except ErroLeitura as e:
            res["rejeitadas"].append({"indice": i, "motivo": e.motivo})
    if aviso:
        res["aviso"] = aviso
    return res


def _atual():
    st = ingestao.status()
    leitura = db.latest_reading()
    return {
        "estado": st["estado"],
        # Atual = dentro do limite de atraso. Senao, a leitura e HISTORICA.
        "atual": st["estado"] == "conectado",
        "idade_s": st["idade_s"],
        "limite_atraso_s": config.LIMITE_ATRASO_S,
        "leitura": leitura,
    }


@app.get("/api/energy/current")
def api_current():
    return _atual()


@app.get("/api/energy/history")
def api_energy_history(period: str = Query("day", pattern="^(day|month)$")):
    return db.history(period)


@app.get("/api/energy/status")
def api_status():
    return ingestao.status()


# ---------------------------------------------------------------------------
# Conta de energia
# ---------------------------------------------------------------------------
@app.get("/api/latest")
def api_latest():
    a = _atual()
    if a["leitura"] is None:
        return {"vazio": True, "estado": a["estado"]}
    return {**a["leitura"], "estado": a["estado"], "atual": a["atual"], "idade_s": a["idade_s"]}


@app.get("/api/bill")
def api_bill(period: str = Query("day", pattern="^(day|month)$")):
    return db.bill(period)


@app.get("/api/history")
def api_history(period: str = Query("day", pattern="^(day|month)$")):
    return db.history(period)


@app.get("/api/months")
def api_months(n: int = Query(12, ge=1, le=36)):
    return db.months(n)


@app.get("/api/insights")
def api_insights():
    return db.insights()


def _proxima_leitura():
    """Proxima data de leitura da concessionaria, se DIA_LEITURA foi configurado."""
    if not config.DIA_LEITURA:
        return None
    hoje = date.today()
    for meses in (0, 1, 2):
        ano = hoje.year + (hoje.month - 1 + meses) // 12
        mes = (hoje.month - 1 + meses) % 12 + 1
        dia = min(config.DIA_LEITURA, calendar.monthrange(ano, mes)[1])
        d = date(ano, mes, dia)
        if d > hoje:
            return d.isoformat()
    return None


@app.get("/api/info")
def api_info():
    return {
        "unidade": config.UNIDADE_NOME,
        "modo": config.MODO,
        "simulado": config.DEMONSTRACAO,
        "tarifa": config.TARIFA_RS_POR_KWH,
        "moeda": config.MOEDA,
        "proxima_leitura": _proxima_leitura(),
        "limite_atraso_s": config.LIMITE_ATRASO_S,
        "limite_desconexao_s": config.LIMITE_DESCONEXAO_S,
    }


class LeituraLegada(BaseModel):
    """Formato antigo (incrementos de energia calculados no ESP32)."""
    ac_power_w: float | None = Field(None, description="Potencia de consumo (W)")
    dc_power_w: float | None = Field(None, description="Potencia de geracao (W)")
    ac_wh: float | None = Field(None, description="Consumo desde o ultimo envio (Wh)")
    dc_wh: float | None = Field(None, description="Geracao desde o ultimo envio (Wh)")
    ts: str | None = Field(None, description="ISO 8601; sem fuso = hora local do servidor")


@app.post("/api/ingest")
def api_ingest(leitura: LeituraLegada, x_api_key: str | None = Header(default=None),
               x_dispositivo: str | None = Header(default=None)):
    _autorizar(x_api_key)
    fonte = (x_dispositivo or "esp32").strip()[:64] or "esp32"
    try:
        return ingestao.registrar_legado(fonte, leitura.ac_power_w, leitura.dc_power_w,
                                         leitura.ac_wh, leitura.dc_wh, leitura.ts)
    except ErroLeitura as e:
        raise HTTPException(e.status, e.motivo)


# ---------------------------------------------------------------------------
# Voz
# ---------------------------------------------------------------------------
@app.get("/api/tts/vozes")
def api_tts_vozes():
    return {"disponivel": tts.disponivel(), "padrao": config.TTS_VOZ, "vozes": tts.VOZES}


@app.get("/api/tts")
async def api_tts(
    texto: str = Query(..., min_length=1, max_length=600),
    voz: str | None = Query(None),
    velocidade: float = Query(1.0, ge=0.5, le=1.5),
):
    if not tts.disponivel():
        raise HTTPException(status_code=503, detail="Voz do servidor indisponivel (instale edge-tts)")
    try:
        audio = await tts.sintetizar(texto, voz, velocidade)
    except Exception as e:  # sem internet, servico fora do ar etc.
        raise HTTPException(status_code=503, detail=f"Falha ao gerar voz: {e}")
    return Response(content=audio, media_type="audio/mpeg",
                    headers={"Cache-Control": "public, max-age=86400"})


# Servir o PWA (mantido por ultimo para nao capturar as rotas /api/*).
app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
