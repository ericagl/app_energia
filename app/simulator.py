"""Simulador de dados de energia.

Objetivo: deixar o app vivo e demonstravel HOJE, sem depender do ESP32 montado.
Modela uma casa solar simples:
- Geracao (DC/solar): curva senoidal com pico ao meio-dia, zero a noite.
- Consumo (AC): base residencial + picos aleatorios (chuveiro, eletrodomesticos).

So roda com MODO=demonstracao e grava em config.DB_DEMO (dispositivo
"simulador"), nunca no banco das leituras reais.
"""
import asyncio
import math
import random
from datetime import datetime, timedelta

from . import config, db


def _fator_solar(dt: datetime) -> float:
    """0.0 a 1.0 conforme a hora do dia (nascer ~6h, pico 12h, por do sol ~18h)."""
    h = dt.hour + dt.minute / 60.0
    if h < 6 or h > 18:
        return 0.0
    return math.sin(math.pi * (h - 6) / 12.0)  # meia onda entre 6h e 18h


def _amostra(dt: datetime):
    """Retorna (ac_power_w, dc_power_w) plausiveis para o instante dt."""
    # Geracao: arranjo de ~1200 Wp, com nuvens aleatorias.
    solar = _fator_solar(dt)
    dc_w = 1200.0 * solar * random.uniform(0.75, 1.0)

    # Consumo: base ~150 W + picos ocasionais (eletrodomesticos).
    ac_w = 150.0 + random.uniform(-30, 30)
    if random.random() < 0.08:
        ac_w += random.uniform(400, 2200)  # chuveiro/eletrodomestico ligado
    return max(ac_w, 0.0), max(dc_w, 0.0)


def seed_if_empty(dias=35):
    """Semeia leituras horarias dos ultimos `dias` para as contas ja terem historico."""
    if db.count_readings(path=config.DB_DEMO) > 0:
        return
    agora = datetime.now().replace(minute=0, second=0, microsecond=0)
    inicio = agora - timedelta(days=dias)
    t = inicio
    while t <= agora:
        ac_w, dc_w = _amostra(t)
        # Energia da hora (Wh) = potencia media (W) * 1 h.
        db.insert_reading({"fonte": "simulador", "ts": t.isoformat(timespec="seconds"),
                           "ac_power_w": ac_w, "dc_power_w": dc_w, "ac_wh": ac_w, "dc_wh": dc_w},
                          path=config.DB_DEMO)
        t += timedelta(hours=1)


async def loop():
    """Gera uma leitura a cada INTERVALO_SIMULACAO_S segundos."""
    intervalo = config.INTERVALO_SIMULACAO_S
    while True:
        agora = datetime.now()
        ac_w, dc_w = _amostra(agora)
        # Energia do intervalo (Wh) = potencia (W) * (intervalo em horas).
        wh_fator = intervalo / 3600.0
        db.insert_reading({"fonte": "simulador", "ts": agora.isoformat(timespec="seconds"),
                           "ac_power_w": ac_w, "dc_power_w": dc_w,
                           "ac_wh": ac_w * wh_fator, "dc_wh": dc_w * wh_fator},
                          path=config.DB_DEMO)
        await asyncio.sleep(intervalo)
