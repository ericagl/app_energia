/* VOZ DE SAÍDA — dois motores:
 *  - navegador: Web Speech (speechSynthesis), rápido e funciona offline;
 *  - servidor:  /api/tts gera MP3 com voz neural pt-BR. Resolve o PC
 *    (principalmente Linux), onde o navegador costuma não ter voz em
 *    português ou só tem a voz online do Google, que falha em silêncio.
 * No modo automático, usa o navegador se houver voz pt instalada no
 * aparelho; senão, o servidor. Se um motor falhar, tenta o outro.
 *
 * A fala é uma lista de ITENS (frases): {texto, el?, grupo?, titulo?}.
 *  - el: elemento destacado enquanto a frase é lida (classe "lendo");
 *  - grupo: seção à qual a frase pertence (avançar/voltar pula seções).
 * Pausar guarda a posição; continuar retoma da frase onde parou — funciona
 * igual nos dois motores (o pause() nativo do Chrome não é confiável). */
(() => {
  "use strict";
  const CS = window.CS, { $, prefs } = CS;

  const temNavegador = "speechSynthesis" in window;
  let temServidor = false;       // confirmado em /api/tts/vozes
  let vozesServidor = {};
  let navegadorFalhou = false;   // falhou nesta sessão -> usa o servidor
  let geracao = 0;               // invalida callbacks de falas canceladas
  let vozes = [];
  const audio = new Audio();
  audio.preload = "auto";
  let blobsAtivos = [];

  // Sessão atual de fala
  let itens = [], pos = 0, estado = "parado", elAtivo = null;
  let ultimaSessao = null;       // para "repetir"
  const ouvintes = new Set();    // avisados quando o estado muda

  // ---------- vozes ----------
  function carregarVozes() {
    if (!temNavegador) return;
    vozes = speechSynthesis.getVoices();
    preencherSeletorVozes();
  }

  // Pontua vozes: pt-BR primeiro; vozes "naturais/neurais" soam bem melhor.
  function pontuar(v) {
    let p = 0;
    if (/^pt[-_]br$/i.test(v.lang)) p += 10;
    else if (/^pt([-_]|$)/i.test(v.lang)) p += 5;
    else if (/portug/i.test(v.name)) p += 4;
    else return -1;
    if (/natural|neural|online|premium|enhanced|aprimorad/i.test(v.name)) p += 3;
    if (v.localService) p += 2;  // voz instalada: não depende de internet
    if (/luciana|francisca|thalita|felipe|antonio|maria|daniel/i.test(v.name)) p += 1;
    return p;
  }
  const vozesPt = () =>
    vozes.map((v) => [v, pontuar(v)]).filter(([, p]) => p >= 0)
      .sort((a, b) => b[1] - a[1]).map(([v]) => v);

  function vozNavegador() {
    if (prefs.voz && !prefs.voz.startsWith("srv:")) {
      const v = vozes.find((x) => x.voiceURI === prefs.voz);
      if (v) return v;
    }
    return vozesPt()[0] || null;
  }

  // Qual motor usar agora.
  function motor() {
    if (prefs.voz.startsWith("srv:") && temServidor) return "servidor";
    if (prefs.voz && !prefs.voz.startsWith("srv:") && temNavegador) return "navegador";
    if (!temNavegador) return temServidor ? "servidor" : null;
    if (!temServidor) return "navegador";
    if (navegadorFalhou) return "servidor";
    const v = vozesPt()[0];
    // Só confia no navegador se houver voz pt instalada no aparelho.
    return v && v.localService ? "navegador" : "servidor";
  }

  function preencherSeletorVozes() {
    const sel = $("sel-voz");
    if (!sel) return;
    sel.length = 1; // mantém "Automática"
    [...sel.querySelectorAll("optgroup")].forEach((g) => g.remove());
    const grupo = (rotulo, lista) => {
      if (!lista.length) return;
      const g = document.createElement("optgroup");
      g.label = rotulo;
      for (const [valor, texto] of lista) {
        const o = document.createElement("option");
        o.value = valor; o.textContent = texto;
        g.appendChild(o);
      }
      sel.appendChild(g);
    };
    grupo("Vozes do servidor (alta qualidade, precisa de internet)",
      Object.entries(vozesServidor).map(([id, nome]) => ["srv:" + id, nome]));
    grupo("Vozes deste aparelho",
      vozesPt().map((v) => [v.voiceURI, `${v.name} (${v.lang})${v.localService ? "" : " — online"}`]));
    sel.value = [...sel.options].some((o) => o.value === prefs.voz) ? prefs.voz : "";
  }

  async function carregarServidor() {
    if (CS.USE_MOCK) return;
    try {
      const r = await fetch("api/tts/vozes", { cache: "no-store" });
      const d = await r.json();
      temServidor = !!d.disponivel;
      vozesServidor = temServidor ? d.vozes : {};
    } catch (_) { temServidor = false; }
    preencherSeletorVozes();
    atualizarStatusVoz();
    // Só desativa os ajustes depois de saber se a voz do servidor existe.
    const nenhuma = !temNavegador && !temServidor;
    for (const id of ["chk-falar", "btn-testar-voz"]) if ($(id)) $(id).disabled = nenhuma;
  }

  // Texto curto nos ajustes dizendo qual voz está em uso.
  function atualizarStatusVoz() {
    const el = $("voz-status");
    if (!el) return;
    const m = motor();
    el.textContent = !m ? "Nenhuma voz disponível neste aparelho."
      : m === "servidor" ? "Usando a voz do servidor (alta qualidade)."
      : `Usando a voz do aparelho: ${vozNavegador()?.name || "padrão"}.`;
  }

  // ---------- estado e destaque ----------
  function mudarEstado(novo) {
    estado = novo;
    document.body.classList.toggle("falando", novo !== "parado");
    ouvintes.forEach((fn) => fn(novo, itens[pos]));
  }

  function destacar(i) {
    const el = i >= 0 ? itens[i]?.el : null;
    if (elAtivo && elAtivo !== el) elAtivo.classList.remove("lendo");
    elAtivo = el || null;
    if (el) {
      el.classList.add("lendo");
      if (itens[i].rolar) {
        const r = el.getBoundingClientRect();
        if (r.top < 60 || r.bottom > window.innerHeight - 100) {
          const suave = !matchMedia("(prefers-reduced-motion: reduce)").matches;
          el.scrollIntoView({ block: "center", behavior: suave ? "smooth" : "auto" });
        }
      }
    }
  }

  function aoIniciarItem(minha, i) {
    if (minha !== geracao) return;
    pos = i;
    if (estado !== "falando") mudarEstado("falando");
    destacar(i);
    ouvintes.forEach((fn) => fn(estado, itens[i]));
  }

  function aoTerminar(minha) {
    if (minha !== geracao) return;
    destacar(-1);
    pos = 0;
    mudarEstado("parado");
  }

  // ---------- motor: navegador ----------
  function falarNavegador(minha, inicio, aoFalhar) {
    speechSynthesis.cancel();
    const voz = vozNavegador();
    let comecou = false;
    // Voz que não começa em 3 s (comum na voz online do Google no PC) = falha.
    const vigia = aoFalhar && setTimeout(() => {
      if (!comecou && minha === geracao) { speechSynthesis.cancel(); aoFalhar(); }
    }, 3000);

    for (let i = inicio; i < itens.length; i++) {
      const u = new SpeechSynthesisUtterance(itens[i].texto);
      u.lang = voz ? voz.lang : "pt-BR";
      if (voz) u.voice = voz;
      u.rate = prefs.rate;
      u.onstart = () => { comecou = true; aoIniciarItem(minha, i); };
      u.onerror = (e) => {
        if (minha !== geracao || e.error === "interrupted" || e.error === "canceled") return;
        clearTimeout(vigia);
        speechSynthesis.cancel();
        if (aoFalhar) aoFalhar(); else aoTerminar(minha);
      };
      if (i === itens.length - 1) u.onend = () => { clearTimeout(vigia); aoTerminar(minha); };
      speechSynthesis.speak(u);
    }
    // Chrome às vezes fica "pausado" após cancel(); garante que retome.
    if (speechSynthesis.paused) speechSynthesis.resume();
  }

  // ---------- motor: servidor ----------
  function urlTTS(frase) {
    const voz = prefs.voz.startsWith("srv:") ? prefs.voz.slice(4) : "";
    return "api/tts?" + new URLSearchParams({ texto: frase, voz, velocidade: String(prefs.rate) });
  }

  async function falarServidor(minha, inicio, aoFalhar) {
    liberarBlobs();
    // Pede as frases em paralelo e toca em sequência: enquanto uma toca,
    // as próximas já estão chegando.
    const pedidos = itens.slice(inicio).map((it) =>
      fetch(urlTTS(it.texto)).then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.blob(); }));
    pedidos.forEach((p) => p.catch(() => {})); // evita aviso de promessa não tratada
    try {
      for (let k = 0; k < pedidos.length; k++) {
        const blob = await pedidos[k];
        if (minha !== geracao) return;
        const url = URL.createObjectURL(blob);
        blobsAtivos.push(url);
        audio.src = url;
        aoIniciarItem(minha, inicio + k);
        await audio.play();
        await new Promise((ok, erro) => {
          audio.onended = ok;
          audio.onerror = erro;
          audio.onpause = () => { if (minha !== geracao) ok(); };
        });
        if (minha !== geracao) return;
      }
      aoTerminar(minha);
    } catch (e) {
      if (minha !== geracao) return;
      console.warn("Voz do servidor falhou:", e);
      if (aoFalhar) aoFalhar(); else aoTerminar(minha);
    } finally {
      liberarBlobs();
    }
  }

  function liberarBlobs() {
    blobsAtivos.forEach((u) => URL.revokeObjectURL(u));
    blobsAtivos = [];
  }

  function pararMotores() {
    if (temNavegador) speechSynthesis.cancel();
    audio.pause();
    liberarBlobs();
  }

  // Toca os itens a partir de "inicio", com o motor escolhido.
  function tocarDe(inicio) {
    if (temNavegador && !vozes.length) carregarVozes();
    const m = motor();
    if (!m || !itens.length) return false;
    const minha = ++geracao;
    pararMotores();
    pos = inicio;
    mudarEstado("falando");
    destacar(inicio);

    if (m === "navegador") {
      // Se a voz do navegador falhar, tenta a do servidor.
      const planoB = temServidor && !prefs.voz ? () => {
        navegadorFalhou = true;
        atualizarStatusVoz();
        if (minha === geracao) falarServidor(minha, pos, null);
      } : null;
      falarNavegador(minha, inicio, planoB);
    } else {
      // Se o servidor falhar (sem internet, por ex.), tenta o navegador.
      const planoB = temNavegador ? () => {
        if (minha === geracao) falarNavegador(minha, pos, null);
      } : () => { const t = itens.slice(pos).map((x) => x.texto).join(" "); aoTerminar(minha); CS.anunciar(t); };
      falarServidor(minha, inicio, planoB);
    }
    return true;
  }

  // ---------- API pública ----------
  // Frases curtas: evita o corte de falas longas do Chrome e permite
  // destacar a frase que está sendo lida.
  function dividir(texto) {
    // Só quebra em pontuação seguida de espaço/fim (não em "1.020" ou "2,5").
    return texto.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  }

  // Exibe o texto em <span class="frase"> (uma por frase) dentro de "destino".
  function renderFrases(destino, frases) {
    destino.textContent = "";
    return frases.map((f, i) => {
      const s = CS.h("span", { classe: "frase", texto: (i ? " " : "") + f });
      destino.appendChild(s);
      return s;
    });
  }

  // Toca uma lista de itens. guardar=false: confirmações ("vou falar mais
  // devagar") não substituem o que o comando "repetir" deve repetir.
  function tocar(lista, { guardar = true, inicio = 0 } = {}) {
    itens = lista;
    if (guardar) ultimaSessao = lista;
    return tocarDe(inicio);
  }

  // Atalho: fala um texto; se "destino" for dado, mostra-o com destaque por frase.
  function falar(texto, destino, guardar = true) {
    const frases = dividir(texto);
    const spans = destino ? renderFrases(destino, frases) : [];
    return tocar(frases.map((t, i) => ({ texto: t, el: spans[i], grupo: i })), { guardar });
  }

  function parar() {
    geracao++;
    pararMotores();
    destacar(-1);
    pos = 0;
    mudarEstado("parado");
  }

  function pausar() {
    if (estado !== "falando") return;
    geracao++;
    pararMotores();
    mudarEstado("pausado");
  }

  function continuar() {
    if (estado === "pausado") tocarDe(pos);
  }

  const alternarPausa = () => (estado === "falando" ? pausar() : continuar());

  // Avança/volta para o começo da próxima/anterior seção (grupo).
  function proximo() {
    if (estado === "parado") return;
    const g = itens[pos]?.grupo;
    const i = itens.findIndex((it, k) => k > pos && it.grupo !== g);
    if (i < 0) return parar();
    tocarDe(i);
  }
  function anterior() {
    if (estado === "parado") return;
    const g = itens[pos]?.grupo;
    const inicioAtual = itens.findIndex((it) => it.grupo === g);
    let alvo = inicioAtual;
    if (pos === inicioAtual && inicioAtual > 0) {
      const gAnt = itens[inicioAtual - 1].grupo;
      alvo = itens.findIndex((it) => it.grupo === gAnt);
    }
    tocarDe(Math.max(0, alvo));
  }

  function repetir() {
    if (!ultimaSessao) return false;
    return tocar(ultimaSessao);
  }

  // iOS/Safari só libera a fala se a primeira vez ocorrer num toque do
  // usuário; depois disso, falas após um "await" também funcionam.
  function desbloquear() {
    if (!temNavegador || desbloquear.feito) return;
    desbloquear.feito = true;
    const u = new SpeechSynthesisUtterance(" ");
    u.volume = 0;
    speechSynthesis.speak(u);
  }

  if (temNavegador) {
    carregarVozes();
    // A lista de vozes costuma chegar só depois deste evento (Chrome).
    speechSynthesis.addEventListener("voiceschanged", () => { carregarVozes(); atualizarStatusVoz(); });
  }

  CS.Voz = {
    tocar, falar, parar, pausar, continuar, alternarPausa, proximo, anterior, repetir,
    dividir, renderFrases, desbloquear, carregarServidor, atualizarStatusVoz,
    aoMudar: (fn) => ouvintes.add(fn),
    get estado() { return estado; },
    get temRepeticao() { return !!ultimaSessao; },
    get suportada() { return temNavegador || temServidor; },
  };
})();
