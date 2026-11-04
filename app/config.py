"""Configuracao central do backend.

Todos os valores podem ser sobrescritos por variaveis de ambiente (ou por um
arquivo .env carregado pelo run.sh), o que separa credenciais e tarifa do
codigo. Veja .env.exemplo.
"""
import os

_BASE = os.path.join(os.path.dirname(__file__), "..")


def _env_int(nome, padrao, minimo=None):
    try:
        v = int(os.getenv(nome, str(padrao)))
    except ValueError:
        v = padrao
    return max(v, minimo) if minimo is not None else v


# --- Modo de operacao ---------------------------------------------------------
# "real" (padrao): usa SOMENTE as leituras recebidas do ESP32. Sem leituras, o
#                  app mostra "sem dados" — nunca valores simulados.
# "demonstracao":  liga o simulador, com banco proprio, e o app avisa em todas
#                  as telas que os dados sao simulados. So quando pedido.
# Compatibilidade: SIMULAR=1 (versoes anteriores) equivale a MODO=demonstracao.
_modo = os.getenv("MODO", "").strip().lower()
if not _modo:
    _modo = "demonstracao" if os.getenv("SIMULAR", "0") == "1" else "real"
if _modo in ("demo", "demonstração"):
    _modo = "demonstracao"
if _modo not in ("real", "demonstracao"):
    raise SystemExit(f"MODO invalido: {_modo!r}. Use 'real' ou 'demonstracao'.")
MODO = _modo
DEMONSTRACAO = MODO == "demonstracao"

# --- Bancos de dados (separados por modo) -------------------------------------
# As leituras reais e as simuladas NUNCA ficam no mesmo arquivo.
# O antigo energia.db (raiz do projeto) foi preenchido pelo simulador das
# versoes anteriores e nao e mais lido.
DB_REAL = os.getenv("DB_REAL") or os.getenv("DB_PATH") or os.path.join(_BASE, "dados", "energia_real.db")
DB_DEMO = os.getenv("DB_DEMO") or os.path.join(_BASE, "dados", "energia_demonstracao.db")
# Banco que alimenta a tela. O recebimento do ESP32 grava sempre no DB_REAL.

# --- Turso (libSQL) --------------------------------------------------
TURSO_DATABASE_URL = os.getenv("TURSO_DATABASE_URL", "").strip()
TURSO_AUTH_TOKEN = os.getenv("TURSO_AUTH_TOKEN", "").strip()
if TURSO_DATABASE_URL:
    DB_REAL = TURSO_DATABASE_URL

DB_LEITURA = DB_DEMO if DEMONSTRACAO else DB_REAL

# --- Simulador (somente no modo demonstracao) ---------------------------------
INTERVALO_SIMULACAO_S = float(os.getenv("INTERVALO_SIMULACAO_S", "5"))

# --- Recebimento das leituras do ESP32 ----------------------------------------
# Chave exigida no cabecalho X-API-Key. Sem ela configurada, o recebimento
# fica DESLIGADO (seguro por padrao). Nunca coloque a chave no codigo.
API_KEY = os.getenv("API_KEY", "").strip()
# Lista opcional de device_id aceitos (separados por virgula). Vazio = qualquer.
DISPOSITIVOS_PERMITIDOS = {d.strip() for d in os.getenv("DISPOSITIVOS_PERMITIDOS", "").split(",") if d.strip()}
# Limites de plausibilidade (rejeita leituras fisicamente impossiveis).
MAX_POTENCIA_W = _env_int("MAX_POTENCIA_W", 20000, 100)
# Tolerancia de relogio: leituras "do futuro" alem disso sao rejeitadas.
TOLERANCIA_FUTURO_S = _env_int("TOLERANCIA_FUTURO_S", 300, 0)

# --- Monitoramento da comunicacao ---------------------------------------------
# Sem transmissao ha mais de LIMITE_ATRASO_S  -> "sem comunicacao recente";
# ha mais de LIMITE_DESCONEXAO_S             -> "desconectado".
# Nesses casos a ultima leitura e mostrada como HISTORICA, nao como atual.
LIMITE_ATRASO_S = _env_int("LIMITE_ATRASO_S", 60, 5)
LIMITE_DESCONEXAO_S = max(_env_int("LIMITE_DESCONEXAO_S", 600, 10), LIMITE_ATRASO_S)

# --- Tarifa de energia -------------------------------------------------------
# TODO(edital): confirme a tarifa da sua concessionaria (R$/kWh, com impostos).
# Valor apenas ilustrativo ate voce preencher o real.
TARIFA_RS_POR_KWH = float(os.getenv("TARIFA_RS_POR_KWH", "0.95"))
MOEDA = os.getenv("MOEDA", "R$")

# --- Identificacao da conta ---------------------------------------------------
# Nome exibido como "unidade consumidora" no topo da conta.
UNIDADE_NOME = os.getenv("UNIDADE_NOME", "Minha residência")
# Dia do mes em que a concessionaria faz a leitura (1-31). Vazio = nao informado.
# TODO(edital): preencha com o dia que aparece na sua conta de luz.
_dia = os.getenv("DIA_LEITURA", "").strip()
DIA_LEITURA = int(_dia) if _dia.isdigit() and 1 <= int(_dia) <= 31 else None

# --- Voz do servidor (TTS) --------------------------------------------------
# Voz neural padrao usada quando o navegador nao tem voz pt-BR (comum no PC).
# Opcoes: pt-BR-FranciscaNeural, pt-BR-AntonioNeural, pt-BR-ThalitaMultilingualNeural
TTS_VOZ = os.getenv("TTS_VOZ", "pt-BR-FranciscaNeural")
