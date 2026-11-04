"""Recebimento de leituras: validacao, conversao e gravacao.

Ponto unico de entrada de dados reais. Hoje a unica fonte e o ESP32 via HTTP
(POST /api/energy/readings). Uma fonte futura (assinante MQTT, leitor Modbus,
API de inversor) deve montar um LeituraESP32 e chamar registrar(), reutilizando
as mesmas validacoes — sem criar um segundo caminho ate o banco.

Contrato: o ESP32 envia CONTADORES ACUMULADOS de energia (energy_kwh) e
potencias instantaneas (power_w). O servidor calcula a energia de cada
intervalo pela diferenca entre contadores do mesmo dispositivo. Assim uma
transmissao perdida nao perde energia (a proxima diferenca a inclui) e uma
reenviada e reconhecida como duplicada.
"""
import hmac
import logging
import os
from datetime import datetime, timedelta
from logging.handlers import RotatingFileHandler

from pydantic import BaseModel, ConfigDict, Field

from . import config, db

# ---------------------------------------------------------------------------
# Registro de erros de comunicacao/integracao
# ---------------------------------------------------------------------------
log = logging.getLogger("energia.ingestao")
if not log.handlers:
    log.setLevel(logging.INFO)
    _fmt = logging.Formatter("%(asctime)s %(levelname)s %(message)s")
    _sh = logging.StreamHandler()
    _sh.setFormatter(_fmt)
    log.addHandler(_sh)
    _arq = os.getenv("LOG_ARQUIVO") or os.path.join(os.path.dirname(os.path.abspath(config.DB_REAL)), "ingestao.log")
    try:
        os.makedirs(os.path.dirname(_arq), exist_ok=True)
        _fh = RotatingFileHandler(_arq, maxBytes=1_000_000, backupCount=3, encoding="utf-8")
        _fh.setFormatter(_fmt)
        log.addHandler(_fh)
    except OSError:
        log.warning("Nao foi possivel abrir o arquivo de log %s; registrando so no terminal.", _arq)
    log.propagate = False

# Contadores desde que o servidor iniciou (expostos em /api/energy/status).
estatisticas = {"recebidas": 0, "aceitas": 0, "duplicadas": 0, "rejeitadas": 0, "ultimo_erro": None}


class ErroLeitura(Exception):
    """Leitura recusada. `status` vira o codigo HTTP da resposta."""

    def __init__(self, motivo, status=422):
        super().__init__(motivo)
        self.motivo, self.status = motivo, status


# ---------------------------------------------------------------------------
# Contrato de comunicacao (JSON enviado pelo ESP32)
# ---------------------------------------------------------------------------
class Medicao(BaseModel):
    model_config = ConfigDict(extra="forbid")
    power_w: float | None = Field(None, ge=0, description="Potencia instantanea (W)")
    energy_kwh: float | None = Field(None, ge=0, description="Contador ACUMULADO de energia (kWh)")


class Rede(BaseModel):
    """Opcional: so envie se o ESP32 tiver um medidor no ponto de conexao com a rede."""
    model_config = ConfigDict(extra="forbid")
    import_power_w: float | None = Field(None, ge=0)
    export_power_w: float | None = Field(None, ge=0)
    import_energy_kwh: float | None = Field(None, ge=0, description="Contador acumulado (kWh)")
    export_energy_kwh: float | None = Field(None, ge=0, description="Contador acumulado (kWh)")


class LeituraESP32(BaseModel):
    model_config = ConfigDict(extra="forbid")
    device_id: str = Field(..., pattern=r"^[A-Za-z0-9_.-]{1,64}$")
    timestamp: datetime | None = Field(None, description="ISO 8601 com fuso (ex.: 2026-10-03T13:00:00Z)")
    generation: Medicao | None = None
    consumption: Medicao | None = None
    grid: Rede | None = None


def chave_valida(recebida: str | None) -> bool:
    """Compara a chave em tempo constante. Sem API_KEY configurada, recusa tudo."""
    if not config.API_KEY:
        return False
    return bool(recebida) and hmac.compare_digest(recebida.encode(), config.API_KEY.encode())


# ---------------------------------------------------------------------------
# Regras
# ---------------------------------------------------------------------------
def _hora_local(ts: datetime | None) -> datetime:
    agora = datetime.now()
    if ts is None:
        return agora.replace(microsecond=0)
    if ts.tzinfo is None:
        raise ErroLeitura("timestamp sem fuso horário. Envie em UTC com 'Z' (ex.: 2026-10-03T13:00:00Z) ou omita o campo.")
    local = ts.astimezone().replace(tzinfo=None, microsecond=0)
    if local.year < 2020:
        raise ErroLeitura("timestamp anterior a 2020: o relógio do ESP32 não está sincronizado (configure NTP) — ou omita o campo.")
    if local > agora + timedelta(seconds=config.TOLERANCIA_FUTURO_S):
        raise ErroLeitura("timestamp no futuro: verifique o relógio/fuso do ESP32.")
    return local


def _delta(fonte, coluna, atual_kwh, ts, obs):
    """Energia (Wh) do intervalo a partir do contador acumulado."""
    if atual_kwh is None:
        return None
    ant = db.ultimo_total(fonte, coluna, path=config.DB_REAL)
    if ant is None:
        obs.append("base")  # primeira leitura do contador: sem intervalo anterior
        return None
    ts_ant, valor_ant = ant
    delta_wh = (atual_kwh - valor_ant) * 1000.0
    if delta_wh < -0.5:
        obs.append(f"reinicio_contador:{coluna}")  # ESP32 reiniciou ou zerou o medidor
        log.warning("Dispositivo %s: contador %s voltou de %.3f para %.3f kWh (reinicio).",
                    fonte, coluna, valor_ant, atual_kwh)
        return None
    horas = max((ts - datetime.fromisoformat(ts_ant)).total_seconds(), 1) / 3600.0
    limite_wh = config.MAX_POTENCIA_W * horas * 1.1 + 1
    if delta_wh > limite_wh:
        raise ErroLeitura(
            f"{coluna}: aumento de {delta_wh:.0f} Wh em {horas * 60:.1f} min é impossível "
            f"(limite {limite_wh:.0f} Wh com MAX_POTENCIA_W={config.MAX_POTENCIA_W})."
        )
    return round(max(delta_wh, 0.0), 4)  # 0,1 mWh: bem abaixo da resolucao dos sensores


def _validar_potencias(*valores):
    for nome, v in valores:
        if v is not None and v > config.MAX_POTENCIA_W:
            raise ErroLeitura(f"{nome} = {v:.0f} W acima do limite plausível (MAX_POTENCIA_W={config.MAX_POTENCIA_W}).")


def registrar(leitura: LeituraESP32) -> dict:
    """Valida e grava uma leitura do contrato atual. Levanta ErroLeitura."""
    estatisticas["recebidas"] += 1
    fonte = leitura.device_id
    try:
        if config.DISPOSITIVOS_PERMITIDOS and fonte not in config.DISPOSITIVOS_PERMITIDOS:
            raise ErroLeitura(f"dispositivo '{fonte}' não autorizado (veja DISPOSITIVOS_PERMITIDOS).", 403)
        g = leitura.generation or Medicao()
        c = leitura.consumption or Medicao()
        r = leitura.grid or Rede()
        if all(v is None for v in (g.power_w, g.energy_kwh, c.power_w, c.energy_kwh)):
            raise ErroLeitura("leitura sem nenhuma medição de geração ou consumo.")
        _validar_potencias(("generation.power_w", g.power_w), ("consumption.power_w", c.power_w),
                           ("grid.import_power_w", r.import_power_w), ("grid.export_power_w", r.export_power_w))
        ts = _hora_local(leitura.timestamp)

        ultima = db.ultima_do_dispositivo(fonte, path=config.DB_REAL)
        if ultima:
            ts_ult = datetime.fromisoformat(ultima["ts"])
            if ts == ts_ult:
                estatisticas["duplicadas"] += 1
                log.info("Dispositivo %s: leitura de %s repetida, ignorada.", fonte, ts.isoformat())
                return {"ok": True, "duplicada": True, "ts": ts.isoformat()}
            if ts < ts_ult:
                raise ErroLeitura(f"leitura fora de ordem: {ts.isoformat()} é anterior à última recebida ({ultima['ts']}).", 409)

        obs = []
        dados = {
            "fonte": fonte, "ts": ts.isoformat(timespec="seconds"),
            "dc_power_w": g.power_w, "ac_power_w": c.power_w,
            "ger_kwh_total": g.energy_kwh, "cons_kwh_total": c.energy_kwh,
            "rede_imp_w": r.import_power_w, "rede_exp_w": r.export_power_w,
            "imp_kwh_total": r.import_energy_kwh, "exp_kwh_total": r.export_energy_kwh,
            "dc_wh": _delta(fonte, "ger_kwh_total", g.energy_kwh, ts, obs),
            "ac_wh": _delta(fonte, "cons_kwh_total", c.energy_kwh, ts, obs),
            "imp_wh": _delta(fonte, "imp_kwh_total", r.import_energy_kwh, ts, obs),
            "exp_wh": _delta(fonte, "exp_kwh_total", r.export_energy_kwh, ts, obs),
        }
        dados["obs"] = ";".join(dict.fromkeys(obs)) or None
        if not db.insert_reading(dados, path=config.DB_REAL):
            estatisticas["duplicadas"] += 1
            return {"ok": True, "duplicada": True, "ts": dados["ts"]}
        estatisticas["aceitas"] += 1
        return {"ok": True, "duplicada": False, "ts": dados["ts"], "obs": dados["obs"]}
    except ErroLeitura as e:
        _falha(fonte, e.motivo)
        raise


def registrar_legado(fonte, ac_power_w, dc_power_w, ac_wh, dc_wh, ts=None) -> dict:
    """Formato antigo (POST /api/ingest): incrementos de energia ja calculados."""
    estatisticas["recebidas"] += 1
    try:
        _validar_potencias(("ac_power_w", ac_power_w), ("dc_power_w", dc_power_w))
        for nome, v in (("ac_power_w", ac_power_w), ("dc_power_w", dc_power_w), ("ac_wh", ac_wh), ("dc_wh", dc_wh)):
            if v is not None and v < 0:
                raise ErroLeitura(f"{nome} não pode ser negativo.")
        quando = datetime.fromisoformat(ts) if ts else None
        if quando is not None and quando.tzinfo is None:
            # Formato antigo: hora sem fuso = hora local do servidor.
            quando = quando.replace(microsecond=0)
            if quando > datetime.now() + timedelta(seconds=config.TOLERANCIA_FUTURO_S):
                raise ErroLeitura("timestamp no futuro: verifique o relógio do ESP32.")
        else:
            quando = _hora_local(quando)
        dados = {"fonte": fonte, "ts": quando.isoformat(timespec="seconds"), "ac_power_w": ac_power_w,
                 "dc_power_w": dc_power_w, "ac_wh": ac_wh, "dc_wh": dc_wh}
        if not db.insert_reading(dados, path=config.DB_REAL):
            estatisticas["duplicadas"] += 1
            return {"ok": True, "duplicada": True, "ts": dados["ts"]}
        estatisticas["aceitas"] += 1
        return {"ok": True, "duplicada": False, "ts": dados["ts"]}
    except ValueError as e:
        _falha(fonte, f"timestamp inválido: {e}")
        raise ErroLeitura(f"timestamp inválido: {e}")
    except ErroLeitura as e:
        _falha(fonte, e.motivo)
        raise


def _falha(fonte, motivo):
    estatisticas["rejeitadas"] += 1
    estatisticas["ultimo_erro"] = {"quando": datetime.now().isoformat(timespec="seconds"),
                                   "dispositivo": fonte, "motivo": motivo}
    log.warning("Leitura recusada (dispositivo %s): %s", fonte, motivo)


# ---------------------------------------------------------------------------
# Estado da comunicacao
# ---------------------------------------------------------------------------
def _estado_por_idade(idade_s):
    if idade_s <= config.LIMITE_ATRASO_S:
        return "conectado"
    if idade_s <= config.LIMITE_DESCONEXAO_S:
        return "sem_comunicacao_recente"
    return "desconectado"


def status() -> dict:
    agora = datetime.now()
    lista = []
    for d in db.dispositivos():
        recep = d["ultima_recepcao"] or d["ultima_medicao"]
        idade = max(int((agora - datetime.fromisoformat(recep)).total_seconds()), 0)
        lista.append({**d, "idade_s": idade, "estado": _estado_por_idade(idade)})
    lista.sort(key=lambda x: x["idade_s"])
    geral = lista[0]["estado"] if lista else "aguardando_primeira_transmissao"
    return {
        "modo": config.MODO,
        "estado": geral,
        "ultima_transmissao": (lista[0]["ultima_recepcao"] or lista[0]["ultima_medicao"]) if lista else None,
        "idade_s": lista[0]["idade_s"] if lista else None,
        "limite_atraso_s": config.LIMITE_ATRASO_S,
        "limite_desconexao_s": config.LIMITE_DESCONEXAO_S,
        "dispositivos": lista,
        # No modo demonstracao quem "transmite" e o simulador.
        "recebimento_habilitado": bool(config.API_KEY),
        "estatisticas": estatisticas,
    }
