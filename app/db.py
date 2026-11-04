"""Camada de dados (SQLite / libSQL).

Tabela readings — uma linha por transmissao de um dispositivo:

  fonte, ts                  dispositivo (device_id) e hora da MEDICAO (local)
  recebido_em                hora em que o servidor recebeu
  dc_power_w / ac_power_w    potencia instantanea de geracao / consumo (W)
  dc_wh / ac_wh              energia gerada / consumida NO INTERVALO desde a
                             leitura anterior do mesmo dispositivo (Wh)
  ger_kwh_total/cons_kwh_total  contadores acumulados enviados pelo ESP32 (kWh)
  rede_imp_w / rede_exp_w    potencia importada/exportada, SE medida (W)
  imp_wh / exp_wh            energia importada/exportada no intervalo, SE medida
  imp_kwh_total/exp_kwh_total contadores de rede, SE medidos
  obs                        "base" (sem leitura anterior: energia do intervalo
                             desconhecida), "reinicio_contador", etc.

NULL significa "nao medido / indisponivel" — nunca zero. A "conta" e a soma
dos incrementos no periodo; potencia (W) nunca e somada como energia (kWh).

Leituras reais e simuladas ficam em bancos diferentes (config.DB_REAL e
config.DB_DEMO); as funcoes de leitura usam config.DB_LEITURA. O alvo pode ser
um arquivo local (SQLite) ou uma URL libsql:// (Turso) — ver o adaptador abaixo.
"""
import os
from contextlib import contextmanager
from datetime import datetime, timedelta

import libsql_experimental as libsql

from . import config

_COLUNAS = (
    "fonte", "ts", "recebido_em", "ac_power_w", "dc_power_w", "ac_wh", "dc_wh",
    "ger_kwh_total", "cons_kwh_total", "rede_imp_w", "rede_exp_w",
    "imp_wh", "exp_wh", "imp_kwh_total", "exp_kwh_total", "obs",
)

_SCHEMA = """
CREATE TABLE IF NOT EXISTS readings (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    fonte          TEXT NOT NULL,
    ts             TEXT NOT NULL,   -- ISO 8601, hora local do servidor
    recebido_em    TEXT,
    ac_power_w     REAL,            -- consumo (W)
    dc_power_w     REAL,            -- geracao (W)
    ac_wh          REAL,            -- consumo no intervalo (Wh)
    dc_wh          REAL,            -- geracao no intervalo (Wh)
    ger_kwh_total  REAL,
    cons_kwh_total REAL,
    rede_imp_w     REAL,
    rede_exp_w     REAL,
    imp_wh         REAL,
    exp_wh         REAL,
    imp_kwh_total  REAL,
    exp_kwh_total  REAL,
    obs            TEXT
)
"""


# --- Adaptador libSQL / Turso ------------------------------------------------
# O cliente libSQL devolve linhas como tupla e nao itera o cursor. Este
# adaptador fino entrega linhas como dict (acesso por nome e dict(row)),
# torna o cursor iteravel e converte parametros em tupla — assim TODO o
# restante desta camada continua identico ao codigo SQLite original.
def _remoto(alvo: str) -> bool:
    return alvo.startswith(("libsql://", "https://", "wss://"))


class _Cur:
    def __init__(self, cur):
        self._cur = cur
        self._cols = [d[0] for d in cur.description] if cur.description else []

    def _linha(self, t):
        return None if t is None else {c: t[i] for i, c in enumerate(self._cols)}

    def fetchone(self):
        return self._linha(self._cur.fetchone())

    def fetchall(self):
        return [self._linha(t) for t in self._cur.fetchall()]

    def __iter__(self):
        return iter(self.fetchall())


class _Con:
    def __init__(self, raw):
        self._raw = raw

    def execute(self, sql, params=None):
        cur = self._raw.execute(sql, tuple(params)) if params else self._raw.execute(sql)
        return _Cur(cur)

    def commit(self):
        self._raw.commit()

    def close(self):
        try:
            self._raw.close()
        except Exception:
            pass


@contextmanager
def _conn(path=None):
    alvo = path or config.DB_LEITURA
    if _remoto(alvo):
        raw = libsql.connect(alvo, auth_token=config.TURSO_AUTH_TOKEN)
    else:
        os.makedirs(os.path.dirname(os.path.abspath(alvo)), exist_ok=True)
        raw = libsql.connect(alvo)
    con = _Con(raw)
    try:
        yield con
        con.commit()
    finally:
        con.close()


def init_db(path=None):
    with _conn(path) as con:
        try:
            cols = {r["name"] for r in con.execute("PRAGMA table_info(readings)")}
        except Exception:
            cols = set()
        if cols and "fonte" not in cols:
            # Banco de versao anterior (colunas NOT NULL, sem dispositivo):
            # recria a tabela preservando as linhas, marcadas como "desconhecida".
            con.execute("ALTER TABLE readings RENAME TO readings_antiga")
            con.execute(_SCHEMA)
            con.execute(
                "INSERT INTO readings (fonte, ts, ac_power_w, dc_power_w, ac_wh, dc_wh) "
                "SELECT 'desconhecida', ts, ac_power_w, dc_power_w, ac_wh, dc_wh FROM readings_antiga"
            )
            con.execute("DROP TABLE readings_antiga")
        con.execute(_SCHEMA)
        con.execute("CREATE INDEX IF NOT EXISTS idx_readings_ts ON readings(ts)")
        # Mesmo dispositivo nao pode ter duas leituras no mesmo instante.
        con.execute("CREATE UNIQUE INDEX IF NOT EXISTS uq_readings_fonte_ts ON readings(fonte, ts)")


def insert_reading(dados: dict, path=None):
    """Insere uma leitura. Retorna False se ja existir (mesmo fonte + ts)."""
    linha = {c: dados.get(c) for c in _COLUNAS}
    linha["recebido_em"] = linha["recebido_em"] or datetime.now().isoformat(timespec="seconds")
    try:
        with _conn(path) as con:
            con.execute(
                f"INSERT INTO readings ({', '.join(_COLUNAS)}) VALUES ({', '.join('?' * len(_COLUNAS))})",
                [linha[c] for c in _COLUNAS],
            )
        return True
    except ValueError as e:
        # libSQL sinaliza violacao de indice unico como ValueError.
        if "UNIQUE constraint" in str(e):
            return False
        raise


def count_readings(path=None):
    with _conn(path) as con:
        return con.execute("SELECT COUNT(*) AS n FROM readings").fetchone()["n"]


def ultima_do_dispositivo(fonte, path=None):
    """Leitura mais recente (por hora de medicao) de um dispositivo."""
    with _conn(path) as con:
        r = con.execute(
            "SELECT * FROM readings WHERE fonte = ? ORDER BY ts DESC LIMIT 1", (fonte,)
        ).fetchone()
    return dict(r) if r else None


def ultimo_total(fonte, coluna, path=None):
    """(ts, valor) do ultimo contador acumulado nao nulo de um dispositivo."""
    if coluna not in ("ger_kwh_total", "cons_kwh_total", "imp_kwh_total", "exp_kwh_total"):
        raise ValueError(coluna)
    with _conn(path) as con:
        r = con.execute(
            f"SELECT ts, {coluna} AS v FROM readings WHERE fonte = ? AND {coluna} IS NOT NULL "
            "ORDER BY ts DESC LIMIT 1", (fonte,)
        ).fetchone()
    return (r["ts"], r["v"]) if r else None


def dispositivos(path=None):
    """Dispositivos que ja transmitiram, com a ultima transmissao de cada um."""
    with _conn(path) as con:
        rows = con.execute(
            "SELECT fonte, MAX(ts) AS ultima_medicao, MAX(recebido_em) AS ultima_recepcao, "
            "COUNT(*) AS leituras FROM readings GROUP BY fonte ORDER BY ultima_medicao DESC"
        ).fetchall()
    return [dict(r) for r in rows]


def _r(v, casas=1):
    return None if v is None else round(v, casas)


def latest_reading(path=None):
    with _conn(path) as con:
        row = con.execute("SELECT * FROM readings ORDER BY ts DESC, id DESC LIMIT 1").fetchone()
    if not row:
        return None
    g, c = row["dc_power_w"], row["ac_power_w"]
    return {
        "ts": row["ts"],
        "recebido_em": row["recebido_em"],
        "dispositivo": row["fonte"],
        "geracao_w": _r(g),
        "consumo_w": _r(c),
        # Saldo instantaneo so existe se os dois sensores mediram.
        "saldo_w": _r(g - c) if g is not None and c is not None else None,
        "rede_importando_w": _r(row["rede_imp_w"]),
        "rede_exportando_w": _r(row["rede_exp_w"]),
        "rede_medida": row["rede_imp_w"] is not None or row["rede_exp_w"] is not None,
    }


def _period_bounds(period):
    now = datetime.now()
    if period == "day":
        inicio = now.replace(hour=0, minute=0, second=0, microsecond=0)
        rotulo = inicio.strftime("%d/%m/%Y")
    elif period == "month":
        inicio = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        rotulo = inicio.strftime("%m/%Y")
    else:
        raise ValueError("period deve ser 'day' ou 'month'")
    return inicio, rotulo


# Fluxos de energia por leitura. Se o ESP32 MEDE a rede (imp_wh/exp_wh), usa a
# medicao; senao, CALCULA a partir de geracao e consumo do mesmo intervalo:
#   autoconsumo = geracao - exportada        (medido)  | min(geracao, consumo)
#   injetada    = exportada                  (medido)  | max(geracao - consumo, 0)
#   importada   = importada                  (medido)  | max(consumo - geracao, 0)
# Calculados nao incluem perdas do inversor e nao vem da concessionaria.
_EXP_AUTO = ("CASE WHEN exp_wh IS NOT NULL AND dc_wh IS NOT NULL THEN MAX(dc_wh - exp_wh, 0) "
             "ELSE MIN(ac_wh, dc_wh) END")
_EXP_INJ = "COALESCE(exp_wh, MAX(dc_wh - ac_wh, 0))"
_EXP_IMP = "COALESCE(imp_wh, MAX(ac_wh - dc_wh, 0))"

_SQL_FLUXOS = (
    "COALESCE(SUM(ac_wh),0) AS ac, COALESCE(SUM(dc_wh),0) AS dc, "
    f"COALESCE(SUM({_EXP_AUTO}),0) AS auto, "
    f"COALESCE(SUM({_EXP_INJ}),0) AS inj, "
    f"COALESCE(SUM({_EXP_IMP}),0) AS imp, "
    "COUNT(*) AS n, MIN(ts) AS primeira, MAX(ts) AS ultima, "
    "SUM(ac_wh IS NULL AND COALESCE(obs, '') NOT LIKE '%base%') AS sem_consumo, "
    "SUM(dc_wh IS NULL AND COALESCE(obs, '') NOT LIKE '%base%') AS sem_geracao, "
    "SUM(imp_wh IS NOT NULL OR exp_wh IS NOT NULL OR imp_kwh_total IS NOT NULL "
    "OR exp_kwh_total IS NOT NULL OR rede_imp_w IS NOT NULL OR rede_exp_w IS NOT NULL) AS rede_medida"
)


def _fluxos(inicio, fim=None, path=None):
    sql = f"SELECT {_SQL_FLUXOS} FROM readings WHERE ts >= ?"
    args = [inicio.isoformat(timespec="seconds")]
    if fim is not None:
        sql += " AND ts < ?"
        args.append(fim.isoformat(timespec="seconds"))
    with _conn(path) as con:
        r = con.execute(sql, args).fetchone()
    n = r["n"]
    return {
        "consumo": r["ac"] / 1000.0, "geracao": r["dc"] / 1000.0,
        "autoconsumo": r["auto"] / 1000.0, "injetada": r["inj"] / 1000.0,
        "importada": r["imp"] / 1000.0, "n": n,
        "primeira": r["primeira"], "ultima": r["ultima"],
        "sem_consumo": r["sem_consumo"] or 0, "sem_geracao": r["sem_geracao"] or 0,
        "fluxo_origem": ("sem_dados" if not n else
                         "medido" if r["rede_medida"] == n else
                         "calculado" if not r["rede_medida"] else "misto"),
    }


def _pct(parte, total):
    return round(parte / total * 100.0) if total > 0 else None


def bill(period="day"):
    """Agrega a 'conta de luz' do periodo (dia ou mes)."""
    inicio, rotulo = _period_bounds(period)
    f = _fluxos(inicio)
    consumo_kwh, geracao_kwh = f["consumo"], f["geracao"]
    saldo_kwh = geracao_kwh - consumo_kwh

    tarifa = config.TARIFA_RS_POR_KWH
    custo_consumo = consumo_kwh * tarifa           # o que a casa gastou
    economia_solar = geracao_kwh * tarifa          # o que o solar deixou de comprar
    # Estimativa com compensacao integral: (importada - injetada) x tarifa.
    # Sem impostos, taxa minima/disponibilidade e Fio B (Lei 14.300).
    custo_liquido = max(f["importada"] - f["injetada"], 0.0) * tarifa

    # Eficiencia como na imagem de referencia: consumo / geracao (em %).
    eficiencia = (consumo_kwh / geracao_kwh * 100.0) if geracao_kwh > 0 else 0.0

    return {
        "periodo": period,
        "rotulo": rotulo,
        "inicio": inicio.isoformat(timespec="seconds"),
        "consumo_kwh": round(consumo_kwh, 3),
        "geracao_kwh": round(geracao_kwh, 3),
        "saldo_kwh": round(saldo_kwh, 3),
        "autoconsumo_kwh": round(f["autoconsumo"], 3),
        "injetada_kwh": round(f["injetada"], 3),
        "importada_kwh": round(f["importada"], 3),
        # "medido" (ESP32 mede a rede), "calculado" (a partir de geracao e
        # consumo), "misto" ou "sem_dados"
        "fluxo_origem": f["fluxo_origem"],
        "atendimento_pct": _pct(f["autoconsumo"], consumo_kwh),
        "aproveitamento_pct": _pct(f["autoconsumo"], geracao_kwh),
        "eficiencia_pct": round(eficiencia, 0),
        "tarifa": tarifa,
        "moeda": config.MOEDA,
        "custo_consumo": round(custo_consumo, 2),
        "economia_solar": round(economia_solar, 2),
        "custo_liquido": round(custo_liquido, 2),
        "n_leituras": f["n"],
        # Leituras sem energia conhecida no intervalo (sensor indisponivel,
        # contador reiniciado...): os totais podem estar incompletos.
        "n_sem_consumo": f["sem_consumo"],
        "n_sem_geracao": f["sem_geracao"],
        "primeira_leitura": f["primeira"],
        "ultima_leitura": f["ultima"],
    }


def history(period="day"):
    """Serie agregada para o grafico: por hora (dia) ou por dia (mes)."""
    inicio, _ = _period_bounds(period)
    fmt = "%Y-%m-%dT%H" if period == "day" else "%Y-%m-%d"
    # Rotulo legivel para tela e leitor de tela: "14h" (dia) ou "03/10" (mes).
    fmt_rotulo = "%Hh" if period == "day" else "%d/%m"
    tam = 13 if period == "day" else 10  # "AAAA-MM-DDTHH" | "AAAA-MM-DD"
    with _conn() as con:
        rows = con.execute(
            f"SELECT substr(ts,1,{tam}) AS chave, SUM(ac_wh) AS c, SUM(dc_wh) AS g, "
            f"SUM({_EXP_AUTO}) AS auto, SUM({_EXP_INJ}) AS inj, SUM({_EXP_IMP}) AS imp "
            "FROM readings WHERE ts >= ? GROUP BY chave ORDER BY chave",
            (inicio.isoformat(timespec="seconds"),),
        ).fetchall()
    kw = lambda v: round((v or 0) / 1000.0, 3)  # noqa: E731
    return [
        {
            "rotulo": datetime.strptime(r["chave"], fmt).strftime(fmt_rotulo),
            "consumo_kwh": kw(r["c"]),
            "geracao_kwh": kw(r["g"]),
            "autoconsumo_kwh": kw(r["auto"]),
            "injetada_kwh": kw(r["inj"]),
            "importada_kwh": kw(r["imp"]),
        }
        for r in rows
    ]


_MESES = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"]


def months(n=12):
    """Totais por mes (ultimos n meses com dados) para o historico mensal."""
    with _conn() as con:
        rows = con.execute(
            "SELECT substr(ts,1,7) AS mes, SUM(ac_wh) AS ac, SUM(dc_wh) AS dc, "
            f"SUM({_EXP_AUTO}) AS auto, SUM({_EXP_INJ}) AS inj, SUM({_EXP_IMP}) AS imp, "
            "COUNT(DISTINCT substr(ts,1,10)) AS dias "
            "FROM readings GROUP BY mes ORDER BY mes DESC LIMIT ?",
            (n,),
        ).fetchall()
    kw = lambda v: round((v or 0) / 1000.0, 2)  # noqa: E731
    saida = []
    for r in reversed(rows):
        ano, mes = r["mes"].split("-")
        saida.append({
            "mes": r["mes"],
            "rotulo": f"{_MESES[int(mes) - 1]}/{ano[2:]}",
            "consumo_kwh": kw(r["ac"]),
            "geracao_kwh": kw(r["dc"]),
            "autoconsumo_kwh": kw(r["auto"]),
            "injetada_kwh": kw(r["inj"]),
            "importada_kwh": kw(r["imp"]),
            "dias_com_dados": r["dias"],
        })
    return saida


def _resumo(f):
    return {
        "consumo_kwh": round(f["consumo"], 2), "geracao_kwh": round(f["geracao"], 2),
        "importada_kwh": round(f["importada"], 2), "n_leituras": f["n"],
        "primeira_leitura": f["primeira"],
    }


def insights():
    """Comparacoes feitas SOMENTE com dados do banco:

    - geracao_hoje: geracao de hoje ate agora x media dos 7 dias anteriores
      ate o MESMO horario (comparacao justa no meio do dia);
    - mes_anterior: mesmo intervalo de dias do mes passado (1 ate hoje)
      e o mes passado inteiro. Indica se ha dados suficientes.
    """
    agora = datetime.now()
    hoje = agora.replace(hour=0, minute=0, second=0, microsecond=0)
    ate_agora = agora - hoje

    hoje_f = _fluxos(hoje)
    anteriores = []
    for d in range(1, 8):
        ini = hoje - timedelta(days=d)
        f = _fluxos(ini, ini + ate_agora)
        if f["n"] > 0:
            anteriores.append(f["geracao"])
    media = sum(anteriores) / len(anteriores) if anteriores else None

    ini_mes = hoje.replace(day=1)
    fim_ant = ini_mes
    ini_ant = (ini_mes - timedelta(days=1)).replace(day=1)
    try:
        mesmo_ponto = agora.replace(year=ini_ant.year, month=ini_ant.month)
    except ValueError:
        mesmo_ponto = fim_ant
    parcial = _fluxos(ini_ant, min(mesmo_ponto, fim_ant))
    inteiro = _fluxos(ini_ant, fim_ant)
    cobre = bool(parcial["primeira"]) and datetime.fromisoformat(parcial["primeira"]) <= ini_ant + timedelta(days=1)

    return {
        "geracao_hoje": {
            "hoje_kwh": round(hoje_f["geracao"], 2),
            "leituras_hoje": hoje_f["n"],
            "media_7d_mesmo_horario_kwh": round(media, 2) if media is not None else None,
            "dias_base": len(anteriores),
        },
        "mes_anterior": {
            "rotulo": f"{_MESES[ini_ant.month - 1]}/{ini_ant.year}",
            "mesmo_periodo": _resumo(parcial),
            "mes_inteiro": _resumo(inteiro),
            "dados_completos": cobre,
        },
    }
