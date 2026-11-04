"""Sintese de voz no servidor (TTS) com vozes neurais pt-BR.

Por que no servidor?
- No PC (principalmente Linux), o navegador muitas vezes nao tem voz em
  portugues instalada, ou so tem a voz online do Google, que falha em silencio.
- Gerando o audio aqui, qualquer navegador so precisa tocar um MP3.

Motor: edge-tts (vozes neurais da Microsoft; exige internet no servidor).
TODO(produto): para funcionar sem internet, trocar por Piper (offline).
"""
from collections import OrderedDict

from . import config

try:
    import edge_tts
except ImportError:  # dependencia opcional: sem ela, o app usa a voz do navegador
    edge_tts = None

VOZES = {
    "pt-BR-FranciscaNeural": "Francisca (feminina)",
    "pt-BR-AntonioNeural": "Antonio (masculina)",
    "pt-BR-ThalitaMultilingualNeural": "Thalita (feminina)",
}

_CACHE_MAX = 300
_cache: "OrderedDict[tuple, bytes]" = OrderedDict()


def disponivel() -> bool:
    return edge_tts is not None


def _taxa(velocidade: float) -> str:
    """Converte a velocidade do app (1.0 = normal) para o formato do edge-tts."""
    pct = round((velocidade - 1.0) * 100)
    pct = max(-50, min(50, pct))
    return f"{pct:+d}%"


async def sintetizar(texto: str, voz: str | None = None, velocidade: float = 1.0) -> bytes:
    """Gera o MP3 da frase. Frases repetidas (ex.: avisos) saem do cache."""
    if edge_tts is None:
        raise RuntimeError("edge-tts nao instalado (pip install edge-tts)")
    voz = voz if voz in VOZES else config.TTS_VOZ
    chave = (texto, voz, _taxa(velocidade))
    if chave in _cache:
        _cache.move_to_end(chave)
        return _cache[chave]

    audio = bytearray()
    async for parte in edge_tts.Communicate(texto, voz, rate=chave[2]).stream():
        if parte["type"] == "audio":
            audio.extend(parte["data"])
    if not audio:
        raise RuntimeError("servico de voz nao retornou audio")

    _cache[chave] = bytes(audio)
    if len(_cache) > _CACHE_MAX:
        _cache.popitem(last=False)
    return _cache[chave]
