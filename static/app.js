/* Casa Solar — conta de energia inteligente (PWA).
 * Telas: Minha conta · Histórico · Detalhes · Assistente.
 * Fontes de dados:
 *   - Backend (/api/*): dados reais do ESP32 ou do simulador do servidor
 *     (o servidor informa em /api/info se está simulando);
 *   - MockSource (mock.js): só na prévia autônoma, sem servidor.
 * Regra: nada de números inventados. O que é medido, calculado ou estimado
 * é dito como tal, e o que não existe (ex.: créditos da concessionária)
 * aparece como "não disponível". */
(() => {
  "use strict";
  const CS = window.CS;
  const { $, nf, money, kwh, falaKwh, falaReais, falaWatts, prefs, salvarPrefs, anunciar, h, Voz, Graficos } = CS;

  // =====================================================================
  //  DADOS
  // =====================================================================
  async function getJSON(url) {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }
  const Backend = {
    info: () => getJSON("api/info"),
    current: () => getJSON("api/energy/current"),
    status: () => getJSON("api/energy/status"),
    bill: (p) => getJSON("api/bill?period=" + p),
    history: (p) => getJSON("api/history?period=" + p),
    months: (n = 12) => getJSON("api/months?n=" + n),
    insights: () => getJSON("api/insights"),
  };
  const source = CS.USE_MOCK ? CS.MockSource : Backend;

  const estado = { periodo: "month", tela: "conta" };

  // Cache curto: evita pedir o mesmo dado várias vezes; se a rede falhar,
  // continua mostrando o último valor recebido.
  const cache = new Map();
  async function obter(chave, ttl, fn) {
    const c = cache.get(chave);
    if (c && Date.now() - c.t < ttl) return c.valor;
    try {
      const valor = await fn();
      cache.set(chave, { t: Date.now(), valor });
      marcarConexao(true);
      return valor;
    } catch (e) {
      console.error(e);
      marcarConexao(false);
      if (c) return c.valor;
      throw e;
    }
  }
  const dados = {
    info: () => obter("info", 600000, () => source.info()),
    current: () => obter("current", 4000, () => source.current()),
    status: () => obter("status", 4000, () => source.status()),
    bill: (p) => obter("bill:" + p, 20000, () => source.bill(p)),
    history: (p) => obter("hist:" + p, 30000, () => source.history(p)),
    months: () => obter("months", 120000, () => source.months(12)),
    insights: () => obter("insights", 120000, () => source.insights()),
  };

  let falhas = 0;
  function marcarConexao(ok) {
    const el = $("status-conexao");
    if (ok) {
      if (falhas > 0) { el.hidden = true; anunciar("Conexão com o servidor restabelecida."); }
      falhas = 0;
      return;
    }
    falhas++;
    if (falhas === 1) {
      el.hidden = false;
      el.textContent = "Sem conexão com o servidor. Mostrando os últimos dados recebidos; tentando de novo a cada poucos segundos.";
    }
  }

  // ---------- textos de período ----------
  const per = (p) => (p === "day"
    ? { quando: "hoje", de: "de hoje", ate: "hoje, até agora" }
    : { quando: "neste mês", de: "deste mês", ate: "neste mês, até agora" });
  const semDados = (b) => !b || !b.n_leituras;
  const tarifaFalada = (b) => `${falaReais(b.tarifa)} por quilowatt-hora`;

  const MESES_ABREV = { jan: "janeiro", fev: "fevereiro", mar: "março", abr: "abril", mai: "maio", jun: "junho",
    jul: "julho", ago: "agosto", set: "setembro", out: "outubro", nov: "novembro", dez: "dezembro" };
  const mesFalado = (rot) => {
    const [m, a] = rot.split("/");
    return (MESES_ABREV[m] || m) + (a ? " de " + (a.length === 2 ? "20" + a : a) : "");
  };
  const minuscula = (t) => t.charAt(0).toLowerCase() + t.slice(1);

  function referencia(p) {
    const d = new Date();
    if (p === "day") return "Hoje, " + d.toLocaleDateString("pt-BR");
    const mes = CS.mesExtenso(d);
    return mes[0].toUpperCase() + mes.slice(1) + " de " + d.getFullYear() + " (até agora)";
  }

  function fraseSaldo(b, falado) {
    const v = falado ? falaKwh(b.saldo_kwh) : kwh(Math.abs(b.saldo_kwh));
    if (b.saldo_kwh > 0) return `Sobraram ${v}: você gerou mais do que consumiu.`;
    if (b.saldo_kwh < 0) return `Faltaram ${v}, que vieram da rede elétrica.`;
    return "Geração e consumo empataram.";
  }

  // =====================================================================
  //  TELA: MINHA CONTA
  // =====================================================================
  async function renderConta() {
    let info, b;
    try { [info, b] = await Promise.all([dados.info(), dados.bill(estado.periodo)]); }
    catch (_) { return; }
    aplicarInfo(info);
    $("id-referencia").textContent = referencia(estado.periodo);

    // Status energético: ícone + texto + cor (nunca só cor)
    const st = $("status-energia");
    const [cls, ico, txt] = semDados(b) ? ["neutro", "i-alerta", "Sem leituras no período"]
      : b.saldo_kwh > 0 ? ["pos", "i-ok", "Excedente: gerou mais do que consumiu"]
      : b.saldo_kwh < 0 ? ["neg", "i-alerta", "Déficit: consumiu mais do que gerou"]
      : ["neutro", "i-ok", "Equilíbrio entre geração e consumo"];
    st.className = "status-energia " + cls;
    st.querySelector("use").setAttribute("href", "#" + ico);
    st.querySelector("span").textContent = txt;

    // Indicadores principais (sem leituras: "—", nunca zero)
    const vazio = semDados(b);
    $("v-geracao").textContent = vazio ? "—" : CS.nfKwh(b.geracao_kwh);
    $("v-consumo").textContent = vazio ? "—" : CS.nfKwh(b.consumo_kwh);
    const maior = Math.max(b.geracao_kwh, b.consumo_kwh, 0.001);
    $("m-geracao").style.width = (b.geracao_kwh / maior) * 100 + "%";
    $("m-consumo").style.width = (b.consumo_kwh / maior) * 100 + "%";
    const vs = $("v-saldo");
    vs.textContent = vazio ? "—" : (b.saldo_kwh > 0 ? "+" : "") + kwh(b.saldo_kwh);
    vs.className = "kpi-valor " + (b.saldo_kwh >= 0 ? "pos-txt" : "neg-txt");
    $("card-saldo").classList.toggle("negativo", b.saldo_kwh < 0);
    $("v-saldo-txt").textContent = semDados(b) ? "sem leituras" : b.saldo_kwh > 0 ? "▲ sobrou energia"
      : b.saldo_kwh < 0 ? "▼ faltou energia (veio da rede)" : "empate";
    const parcial = avisoParcial(b);
    $("aviso-parcial").hidden = !parcial;
    $("aviso-parcial").textContent = parcial;

    // De onde veio a energia da casa
    $("atend-frase").textContent = vazio ? "Sem leituras no período."
      : b.atendimento_pct === null ? "Ainda não houve consumo no período."
      : `O sol atendeu ${b.atendimento_pct}% do consumo da casa ${per(estado.periodo).quando}.`;
    $("comp-consumo").replaceChildren(vazio ? "" : Graficos.composicao([
      { rotulo: "Direto do sol", valor: b.autoconsumo_kwh, classe: "gen" },
      { rotulo: "Da rede elétrica", valor: b.importada_kwh, classe: "neg" },
    ], { titulo: "Do que a casa consumiu:" }));
    $("nota-fluxo").textContent = vazio ? "" : notaFluxo(b);

    // Valor estimado
    $("v-custo").textContent = vazio ? "—" : money(b.custo_liquido, b.moeda);
    $("v-economia").textContent = vazio ? "—" : money(b.economia_solar, b.moeda);
    $("valor-explica").textContent =
      `A pagar = (energia importada − energia injetada) × tarifa de ${money(b.tarifa, b.moeda)}/kWh, ` +
      "considerando que a energia injetada na rede compensa a energia comprada. " +
      "Economia = energia gerada × tarifa. Não inclui impostos, taxa mínima (custo de disponibilidade), " +
      "bandeiras tarifárias nem a cobrança do Fio B. O valor oficial vem na conta da concessionária.";
  }

  // Identificação e modo (o aviso de demonstração vale para todas as telas)
  function aplicarInfo(info) {
    estado.info = info;
    $("id-unidade").textContent = info.unidade;
    $("id-proxima").textContent = info.proxima_leitura ? CS.dataBR(info.proxima_leitura) : "Não informada";
    $("aviso-simulado").hidden = !info.simulado;
    $("fonte-dados").textContent = CS.USE_MOCK ? "modo demonstração (simulado no navegador)"
      : info.simulado ? "modo demonstração (dados simulados)" : "dados do medidor";
  }

  // Origem dos fluxos (injetada/importada/usada direto): medida ou calculada
  function origemFluxo(b, falado) {
    if (b.fluxo_origem === "medido") return falado ? "medidos pelo medidor da rede" : "Medidos pelo ESP32 no ponto de conexão com a rede.";
    if (b.fluxo_origem === "misto") return falado ? "em parte medidos e em parte calculados" : "Parte medidos pelo ESP32, parte calculados a partir da geração e do consumo.";
    return falado ? "calculados a partir da geração e do consumo"
      : "Calculados a partir das medições de geração e consumo (não é a medição da concessionária).";
  }
  const notaFluxo = (b) => "Energia injetada, importada e usada direto: " + origemFluxo(b, false).charAt(0).toLowerCase() + origemFluxo(b, false).slice(1);

  function avisoParcial(b) {
    if (semDados(b) || (!b.n_sem_consumo && !b.n_sem_geracao)) return "";
    const partes = [];
    if (b.n_sem_consumo) partes.push(`${b.n_sem_consumo} ${b.n_sem_consumo === 1 ? "leitura" : "leituras"} sem consumo medido`);
    if (b.n_sem_geracao) partes.push(`${b.n_sem_geracao} ${b.n_sem_geracao === 1 ? "leitura" : "leituras"} sem geração medida`);
    return `Atenção: ${partes.join(" e ")} neste período (sensor indisponível ou contador reiniciado). Os totais podem estar incompletos.`;
  }

  const w = (v) => (v === null || v === undefined ? "—" : nf(v, 0));

  async function renderAoVivo() {
    let c;
    try { c = await dados.current(); } catch (_) { return; }
    const l = c.leitura;
    const hist = $("vivo-historico"), at = $("v-atualizado"), rede = $("v-rede");
    if (!l) {
      for (const id of ["v-consumo-w", "v-geracao-w", "v-saldo-w"]) $(id).textContent = "—";
      $("v-saldo-w-rotulo").textContent = "Saldo";
      at.textContent = "Nenhuma transmissão recebida do medidor ainda.";
      at.classList.remove("aviso");
      hist.hidden = true; rede.hidden = true;
      $("id-leitura").textContent = "Nenhuma leitura ainda";
      return;
    }
    if (c.atual) {
      $("v-consumo-w").textContent = w(l.consumo_w);
      $("v-geracao-w").textContent = w(l.geracao_w);
      const s = $("v-saldo-w");
      s.textContent = l.saldo_w === null ? "—" : (l.saldo_w > 0 ? "+" : "") + nf(l.saldo_w, 0);
      s.className = "valor " + (l.saldo_w === null ? "" : l.saldo_w >= 0 ? "pos-txt" : "neg-txt");
      $("v-saldo-w-rotulo").textContent = l.saldo_w === null ? "Saldo" : l.saldo_w >= 0 ? "▲ Sobrando" : "▼ Faltando";
      at.textContent = "Medição das " + new Date(l.ts).toLocaleTimeString("pt-BR") +
        (l.consumo_w === null || l.geracao_w === null ? " — um dos sensores não enviou valor." : "");
      at.classList.remove("aviso");
      hist.hidden = true;
      rede.hidden = !l.rede_medida;
      if (l.rede_medida) rede.textContent = `Rede (medido): importando ${w(l.rede_importando_w)} W · exportando ${w(l.rede_exportando_w)} W`;
    } else {
      // Sem comunicação: a última leitura vira HISTÓRICA — não é mostrada como atual.
      for (const id of ["v-consumo-w", "v-geracao-w", "v-saldo-w"]) { $(id).textContent = "—"; $(id).className = $(id).className.replace(/ ?(pos|neg)-txt/, ""); }
      $("v-saldo-w-rotulo").textContent = "Saldo";
      rede.hidden = true;
      at.textContent = "Sem medição atual: o medidor não transmite há " + tempoDesde(c.idade_s) + ".";
      at.classList.add("aviso");
      hist.hidden = false;
      hist.textContent = `Última leitura válida (histórica), de ${CS.dataHoraBR(l.ts)}: geração ${w(l.geracao_w)} W, consumo ${w(l.consumo_w)} W.`;
    }
    $("id-leitura").textContent = CS.dataHoraBR(l.ts) + (c.atual ? "" : " (histórica)");
  }

  function tempoDesde(seg) {
    if (seg === null || seg === undefined) return "—";
    if (seg < 90) return `${seg} segundos`;
    const min = Math.round(seg / 60);
    if (min < 90) return `${min} ${min === 1 ? "minuto" : "minutos"}`;
    const hrs = Math.round(min / 60);
    return hrs < 48 ? `${hrs} ${hrs === 1 ? "hora" : "horas"}` : `${Math.round(hrs / 24)} dias`;
  }

  // Indicador de comunicação com o medidor (ESP32). Atualiza a cada 5 s e,
  // quando chega uma transmissão nova, recarrega os cards e gráficos.
  let ultimaTransmissao, ultimoEstado = null, ultimoRecarregar = 0, recargaPendente = false;  // undefined = ainda não verificado
  async function monitorarConexao() {
    let st;
    try { st = await dados.status(); } catch (_) { return; }
    const caixa = $("conexao"), eTxt = $("conexao-estado"), dTxt = $("conexao-detalhe");
    const disp = st.dispositivos[0];
    const quando = st.ultima_transmissao ? CS.dataHoraBR(st.ultima_transmissao) : "";
    const nome = disp ? (disp.fonte === "simulador" ? "Simulador" : `Medidor ${disp.fonte}`) : "Medidor";
    const textos = {
      conectado: [`${nome} conectado.`, `Última transmissão: ${quando}.`, "ok"],
      sem_comunicacao_recente: ["Sem comunicação recente com o medidor.", `Última transmissão há ${tempoDesde(st.idade_s)} (${quando}). Os valores ao vivo ficam indisponíveis.`, "atraso"],
      desconectado: ["Medidor desconectado.", `Última transmissão: ${quando}. Mostrando apenas o histórico registrado.`, "off"],
      aguardando_primeira_transmissao: ["Aguardando a primeira transmissão do medidor.",
        st.modo === "real" && !st.recebimento_habilitado ? "O recebimento está desligado no servidor (falta configurar a API_KEY)." : "Assim que o ESP32 enviar leituras, os valores aparecem aqui.", "aguardando"],
    };
    const [e, d, cls] = textos[st.estado] || textos.aguardando_primeira_transmissao;
    eTxt.textContent = e;
    dTxt.textContent = d;
    caixa.className = "conexao " + cls;
    $("id-origem").textContent = !disp ? "Nenhum medidor transmitiu ainda"
      : disp.fonte === "simulador" ? "Simulador (modo demonstração)" : `Medidor ${disp.fonte}, via Wi-Fi`;

    if (ultimoEstado && ultimoEstado !== st.estado) anunciar(e);   // só avisa quando muda
    ultimoEstado = st.estado;
    estado.conexao = st;

    // Transmissão nova: atualiza cards e gráficos sem recarregar a página
    // (no máximo a cada 10 s; uma mudança nesse meio-tempo fica pendente).
    if (st.ultima_transmissao !== ultimaTransmissao) {
      if (ultimaTransmissao !== undefined) recargaPendente = true;
      ultimaTransmissao = st.ultima_transmissao;
    }
    if (recargaPendente && Date.now() - ultimoRecarregar > 10000) {
      recargaPendente = false;
      ultimoRecarregar = Date.now();
      for (const k of ["bill:day", "bill:month", "hist:day", "hist:month", "months", "insights", "current"]) cache.delete(k);
      if (estado.tela !== "assistente") RENDER[estado.tela]();
    }
  }

  // Texto falado sobre o momento atual, respeitando o estado da comunicação.
  function resumoAoVivo(c) {
    if (!c || !c.leitura) return "O medidor ainda não enviou nenhuma leitura.";
    const l = c.leitura;
    if (!c.atual) {
      return `Não há medição atual: o medidor não transmite há ${tempoDesde(c.idade_s)}. ` +
        `A última leitura válida, de ${CS.dataHoraBR(l.ts)}, indicava ` +
        `geração de ${l.geracao_w === null ? "valor desconhecido" : falaWatts(l.geracao_w)} ` +
        `e consumo de ${l.consumo_w === null ? "valor desconhecido" : falaWatts(l.consumo_w)}.`;
    }
    let t = l.consumo_w === null ? "Neste momento o consumo não está sendo medido"
      : `Neste momento a casa está consumindo ${falaWatts(l.consumo_w)}`;
    t += l.geracao_w === null ? ", e a geração não está sendo medida."
      : l.geracao_w >= 1 ? `, e as placas estão gerando ${falaWatts(l.geracao_w)}.` : ", e as placas não estão gerando.";
    if (l.rede_medida) {
      if (l.rede_exportando_w > 0) t += ` O medidor da rede indica que você está exportando ${falaWatts(l.rede_exportando_w)}.`;
      else if (l.rede_importando_w > 0) t += ` O medidor da rede indica que você está importando ${falaWatts(l.rede_importando_w)}.`;
    } else if (l.saldo_w !== null) {
      if (l.saldo_w > 0) t += ` Pela diferença, sobram cerca de ${falaWatts(l.saldo_w)}, que vão para a rede.`;
      else if (l.saldo_w < 0) t += ` Pela diferença, faltam cerca de ${falaWatts(l.saldo_w)}, que vêm da rede.`;
    }
    return t;
  }

  // =====================================================================
  //  TELA: HISTÓRICO
  // =====================================================================
  // Todas as horas do dia ou todos os dias do mês, com ou sem dados.
  function montarSlots(h, periodo) {
    const porRotulo = new Map(h.map((x) => [x.rotulo, x]));
    const agora = new Date();
    const slots = [];
    if (periodo === "day") {
      for (let i = 0; i < 24; i++) {
        const rotulo = String(i).padStart(2, "0") + "h";
        slots.push({ rotulo, eixo: rotulo, futuro: i > agora.getHours(), dado: porRotulo.get(rotulo) });
      }
    } else {
      const dias = new Date(agora.getFullYear(), agora.getMonth() + 1, 0).getDate();
      const mes = String(agora.getMonth() + 1).padStart(2, "0");
      for (let d = 1; d <= dias; d++) {
        const rotulo = String(d).padStart(2, "0") + "/" + mes;
        slots.push({ rotulo, eixo: String(d), futuro: d > agora.getDate(), dado: porRotulo.get(rotulo) });
      }
    }
    for (const s of slots) {
      s.cima = s.dado?.geracao_kwh || 0;
      s.baixo = s.dado?.consumo_kwh || 0;
    }
    return slots;
  }
  const indiceAtual = (p) => (p === "day" ? new Date().getHours() : new Date().getDate() - 1);
  const marcarEixo = (p) => (i, n, banda) => (p === "day"
    ? i % (banda * 3 >= 30 ? 3 : 6) === 0
    : i === 0 || (i + 1) % (banda * 2 >= 22 ? 2 : 5) === 0);

  function textoSlot(p) {
    return (s) => {
      const quando = p === "day" ? "Às " + s.rotulo : "Dia " + s.rotulo;
      if (s.futuro) return `${quando}: ainda não chegou.`;
      if (!s.dado) return `${quando}: sem leituras.`;
      const saldo = s.cima - s.baixo;
      return `${quando}: ☀ gerou ${nf(s.cima)} kWh · 🏠 consumiu ${nf(s.baixo)} kWh · ` +
        (saldo >= 0 ? `▲ sobrou ${nf(saldo)} kWh` : `▼ faltou ${nf(-saldo)} kWh`);
    };
  }

  function picoDe(lista, k) {
    return lista.reduce((p, x) => (x[k] > (p ? p[k] : 0) ? x : p), null);
  }
  const temSelecao = (id) => ($(id)._estado?.sel ?? -1) >= 0;

  async function renderHistorico() {
    const p = estado.periodo;
    let h;
    try { h = await dados.history(p); } catch (_) { return; }
    const slots = montarSlots(h, p);
    const vazioMsg = p === "day" ? "Ainda não há leituras hoje." : "Ainda não há leituras neste mês.";

    $("hist-sub").textContent = p === "day" ? "Hora a hora, hoje." : "Dia a dia, neste mês.";
    const totG = h.reduce((a, x) => a + x.geracao_kwh, 0);
    const totC = h.reduce((a, x) => a + x.consumo_kwh, 0);
    const pG = picoDe(h, "geracao_kwh"), pC = picoDe(h, "consumo_kwh");
    const em = (x) => (p === "day" ? "às " : "no dia ") + x.rotulo;
    $("tot-gen").textContent = kwh(totG);
    $("tot-use").textContent = kwh(totC);
    $("tot-gen-pico").textContent = pG ? `Maior geração ${em(pG)} (${kwh(pG.geracao_kwh)})` : "Ainda sem geração";
    $("tot-use-pico").textContent = pC ? `Maior consumo ${em(pC)} (${kwh(pC.consumo_kwh)})` : "Ainda sem consumo";

    Graficos.barras($("graf-periodo"), {
      chave: "periodo:" + p, slots, atual: indiceAtual(p), marcarEixo: marcarEixo(p),
      leitura: $("leitura-periodo"), textoSlot: textoSlot(p), vazio: vazioMsg,
    });
    if (!temSelecao("graf-periodo")) {
      $("leitura-periodo").textContent = h.length
        ? "Toque numa barra (ou use as setas do teclado) para ver os valores de cada " + (p === "day" ? "hora." : "dia.") : "";
    }
    $("graf-periodo").setAttribute("aria-label",
      `Gráfico ${p === "day" ? "hora a hora" : "dia a dia"}: o sol gerou ${kwh(totG)} e a casa consumiu ${kwh(totC)}.` +
      (pG ? ` Maior geração ${em(pG)}.` : "") + (pC ? ` Maior consumo ${em(pC)}.` : "") +
      " Use as setas para percorrer as barras. Tabela equivalente logo abaixo.");

    preencherTabela($("tabela-periodo"), h.map((x) => [x.rotulo, nf(x.geracao_kwh), nf(x.consumo_kwh),
      (x.geracao_kwh - x.consumo_kwh > 0 ? "+" : "") + nf(x.geracao_kwh - x.consumo_kwh)]));

    // Evolução do saldo: soma acumulada; horas/dias futuros sem valor
    let acc = 0;
    const slotsSaldo = slots.map((s) => {
      if (s.futuro || !h.length) return { ...s, valor: null };
      acc += s.cima - s.baixo;
      return { ...s, valor: acc };
    });
    Graficos.linha($("graf-saldo"), {
      chave: "saldo:" + p, slots: slotsSaldo, atual: indiceAtual(p), marcarEixo: marcarEixo(p),
      leitura: $("leitura-saldo"), vazio: vazioMsg,
      textoSlot: (s) => {
        const quando = p === "day" ? "Até as " + s.rotulo : "Até o dia " + s.rotulo;
        if (s.valor === null) return `${quando}: ainda não chegou.`;
        return `${quando}: saldo acumulado de ${(s.valor > 0 ? "+" : "") + nf(s.valor)} kWh ` +
          (s.valor >= 0 ? "(▲ sobrando)" : "(▼ faltando, veio da rede)");
      },
    });
    if (!temSelecao("graf-saldo")) {
      $("leitura-saldo").textContent = h.length ? "Toque no gráfico para ver o saldo acumulado em cada ponto." : "";
    }
    $("graf-saldo").setAttribute("aria-label",
      `Evolução do saldo: termina em ${(acc > 0 ? "+" : "") + nf(acc)} kWh ` +
      (acc >= 0 ? "(sobrou energia)." : "(faltou energia, que veio da rede).") + " Use as setas para percorrer.");

    renderMeses();
  }

  async function renderMeses() {
    let ms;
    try { ms = await dados.months(); } catch (_) { return; }
    const slots = ms.map((m) => ({ rotulo: m.rotulo, eixo: m.rotulo.split("/")[0], cima: m.geracao_kwh, baixo: m.consumo_kwh, dado: m }));
    Graficos.barras($("graf-meses"), {
      chave: "meses", slots, altura: 240, larguraMax: 34, leitura: $("leitura-meses"),
      vazio: "Ainda não há meses com leituras.", atual: slots.length - 1,
      textoSlot: (s) => {
        const m = s.dado, saldo = m.geracao_kwh - m.consumo_kwh;
        return `${m.rotulo}: ☀ gerou ${kwh(m.geracao_kwh)} · 🏠 consumiu ${kwh(m.consumo_kwh)} · ` +
          (saldo >= 0 ? `▲ sobrou ${kwh(saldo)}` : `▼ faltou ${kwh(-saldo)}`) +
          ` · ${m.dias_com_dados} ${m.dias_com_dados === 1 ? "dia" : "dias"} com leitura`;
      },
    });
    if (!temSelecao("graf-meses")) $("leitura-meses").textContent = ms.length ? "Toque num mês para ver os valores." : "";
    const incompletos = ms.filter((m) => m.dias_com_dados < 28).map((m) => m.rotulo);
    $("meses-sub").textContent = "Geração e consumo de cada mês com leituras." +
      (incompletos.length ? ` Meses com poucos dias de leitura (${incompletos.join(", ")}) aparecem menores por estarem incompletos.` : "");
    $("graf-meses").setAttribute("aria-label", "Histórico mensal: " +
      ms.map((m) => `${m.rotulo}, gerou ${kwh(m.geracao_kwh)} e consumiu ${kwh(m.consumo_kwh)}`).join("; ") + ".");
    preencherTabela($("tabela-meses"), ms.map((m) => [m.rotulo, nf(m.geracao_kwh), nf(m.consumo_kwh),
      nf(m.injetada_kwh), nf(m.importada_kwh), String(m.dias_com_dados)]));
  }

  function preencherTabela(tabela, linhas) {
    const tb = tabela.querySelector("tbody");
    tb.textContent = "";
    if (!linhas.length) {
      const td = tb.insertRow().insertCell();
      td.colSpan = tabela.querySelectorAll("thead th").length;
      td.textContent = "Sem leituras no período.";
      return;
    }
    for (const [primeira, ...resto] of linhas) {
      const tr = tb.insertRow();
      tr.appendChild(h("th", { scope: "row", texto: primeira }));
      for (const v of resto) tr.insertCell().textContent = v;
    }
  }

  // =====================================================================
  //  TELA: DETALHAMENTO
  // =====================================================================
  function icone(id) {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("class", "icone");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    const use = document.createElementNS(NS, "use");
    use.setAttribute("href", "#" + id);
    svg.appendChild(use);
    return svg;
  }

  async function renderDetalhe() {
    let b;
    try { b = await dados.bill(estado.periodo); } catch (_) { return; }
    if (semDados(b)) {
      $("fluxo-sub").textContent = "Sem leituras no período.";
    } else {
      $("fluxo-sub").textContent = "Para onde foi a energia " + per(estado.periodo).ate + ". " + origemFluxo(b, false);
    }

    const no = (ico, txt, cls) => h("span", { classe: "no " + cls }, [icone(ico), h("span", { texto: txt })]);
    const fluxo = (de, para, valor, rotulo, cls) => h("li", { classe: "fluxo " + cls }, [
      de, h("span", { classe: "seta", "aria-hidden": "true" }), para,
      h("p", { classe: "fluxo-texto" }, [h("strong", { texto: kwh(valor) }), " " + rotulo]),
    ]);
    $("fluxos").replaceChildren(
      fluxo(no("i-sol", "Placas", "gen"), no("i-casa", "Casa", "use"), b.autoconsumo_kwh, "usados direto pela casa", "f-auto"),
      fluxo(no("i-sol", "Placas", "gen"), no("i-rede", "Rede", "rede"), b.injetada_kwh, "injetados na rede (sobra)", "f-inj"),
      fluxo(no("i-rede", "Rede", "rede"), no("i-casa", "Casa", "use"), b.importada_kwh, "importados da concessionária", "f-imp"),
    );

    const origem = (tipo, txt) => h("span", { classe: "origem " + tipo, texto: txt });
    const origemRede = () => b.fluxo_origem === "medido" ? origem("medido", "Medido — medidor da rede")
      : b.fluxo_origem === "misto" ? origem("calculado", "Parte medido, parte calculado") : origem("calculado", "Calculado");
    const linhas = [
      ["Energia gerada pelo sistema fotovoltaico", kwh(b.geracao_kwh), origem("medido", "Medido — sensor de geração")],
      ["Energia consumida pela residência", kwh(b.consumo_kwh), origem("medido", "Medido — sensor de consumo")],
      ["Consumida diretamente da geração solar", kwh(b.autoconsumo_kwh), origemRede()],
      ["Injetada na rede elétrica", kwh(b.injetada_kwh), origemRede()],
      ["Importada da concessionária", kwh(b.importada_kwh), origemRede()],
      ["Créditos energéticos acumulados", "—", origem("indisponivel", "Não disponível — registrado pela concessionária")],
      ["Saldo (gerada − consumida)", (b.saldo_kwh > 0 ? "+" : "") + kwh(b.saldo_kwh), origem("calculado", "Calculado")],
    ];
    const tb = $("demonstrativo").querySelector("tbody");
    tb.textContent = "";
    linhas.forEach(([item, valor, orig], i) => {
      const tr = tb.insertRow();
      if (i === linhas.length - 1) tr.className = "total-linha";
      tr.appendChild(h("th", { scope: "row" }, [h("span", { classe: "item-nome", texto: item }), orig]));
      const td = tr.insertCell(); td.className = "num"; td.textContent = valor;
    });

    $("comp-geracao").replaceChildren(Graficos.composicao([
      { rotulo: "Usada direto pela casa", valor: b.autoconsumo_kwh, classe: "gen" },
      { rotulo: "Injetada na rede", valor: b.injetada_kwh, classe: "pos" },
    ], { titulo: "Do que o sol gerou:" }));
    $("comp-consumo-det").replaceChildren(Graficos.composicao([
      { rotulo: "Direto do sol", valor: b.autoconsumo_kwh, classe: "gen" },
      { rotulo: "Da rede elétrica", valor: b.importada_kwh, classe: "neg" },
    ], { titulo: "Do que a casa consumiu:" }));

    $("como-obtido-texto").replaceChildren(
      h("p", { texto: "Energia gerada e energia consumida são medidas por dois sensores: um nas placas solares e outro no quadro de energia da casa." }),
      h("p", { texto: "A cada leitura, o aplicativo compara os dois: se o sol gera mais do que a casa usa, a sobra é contada como injetada na rede; se gera menos, a falta é contada como importada da concessionária. A parte que a casa usou ao mesmo tempo em que o sol gerou é a energia consumida diretamente." }),
      h("p", { texto: "Esses valores calculados podem diferir um pouco da conta oficial: não incluem as perdas do inversor e não vêm do medidor da concessionária. Os créditos de energia só a concessionária registra, por isso aparecem como não disponíveis." }),
      h("p", { texto: `Relação consumo ÷ geração (indicador usado nas versões anteriores): ${b.geracao_kwh > 0 ? b.eficiencia_pct + "%" : "sem geração no período"}. Acima de 100% significa que a casa consumiu mais do que gerou.` }),
    );
  }

  // =====================================================================
  //  LEITURA DA CONTA EM VOZ ALTA (por seções)
  // =====================================================================
  async function ouvirConta() {
    if (estado.tela !== "conta") mostrarTela("conta", { foco: false });
    let info, b;
    try { [info, b] = await Promise.all([dados.info(), dados.bill(estado.periodo)]); }
    catch (_) { return falarOuAnunciar("Não consegui carregar os dados da conta. Verifique a conexão e tente de novo."); }
    await renderConta();
    const p = estado.periodo;
    const secoes = [];
    const sec = (el, titulo, frases) => secoes.push({ el: $(el), titulo, frases: frases.filter(Boolean) });

    const ref = p === "day" ? "a hoje" : `ao mês de ${CS.mesExtenso()}`;
    sec("card-ident", "Identificação", [
      `Olá! Vamos conferir o resumo energético da sua residência referente ${ref}, até agora.`,
      info.simulado ? "Atenção: o aplicativo está em modo demonstração; estes dados são simulados." : "",
      semDados(b) ? "Ainda não há leituras neste período." : "",
      estado.conexao && ["sem_comunicacao_recente", "desconectado"].includes(estado.conexao.estado)
        ? `Atenção: o medidor não transmite há ${tempoDesde(estado.conexao.idade_s)}; os valores vão até a última leitura recebida.` : "",
      avisoParcial(b) ? "Alguns intervalos ficaram sem medição, então os totais podem estar incompletos." : "",
    ]);
    if (!semDados(b)) {
      sec("card-gerada", "Energia gerada", [`Seu sistema solar gerou ${falaKwh(b.geracao_kwh)}.`]);
      sec("card-consumida", "Energia consumida", [`Sua residência consumiu ${falaKwh(b.consumo_kwh)}.`]);
      sec("card-saldo", "Saldo", [fraseSaldo(b, true)]);
      sec("card-atendimento", "De onde veio a energia", [
        `Do total gerado, ${falaKwh(b.autoconsumo_kwh)} foram usados diretamente pela casa, e ${falaKwh(b.injetada_kwh)} foram injetados na rede elétrica.`,
        `Da concessionária, vieram ${falaKwh(b.importada_kwh)}.`,
        b.atendimento_pct !== null ? `Ou seja, o sol atendeu ${b.atendimento_pct} por cento do consumo da casa.` : "",
        `Esses valores são ${origemFluxo(b, true)}.`,
      ]);
      sec("card-valor", "Valor estimado", [
        b.custo_liquido > 0
          ? `O valor estimado da energia a pagar é de ${falaReais(b.custo_liquido)}, com a tarifa de ${tarifaFalada(b)}.`
          : "Pela estimativa, não há valor de energia a pagar, porque a energia injetada compensou a comprada.",
        `A economia com o sol foi de ${falaReais(b.economia_solar)}.`,
        "Impostos e taxas da concessionária não estão incluídos.",
      ]);
    }
    sec("btn-ouvir-conta", "Encerramento", ["Para mais detalhes, use as abas Histórico e Detalhes, ou faça perguntas no Assistente."]);

    const itens = [];
    secoes.forEach((s, g) => s.frases.forEach((texto) => itens.push({ texto, el: s.el, grupo: g, titulo: s.titulo, rolar: true })));
    if (!Voz.tocar(itens)) anunciar(itens.map((i) => i.texto).join(" "));
  }

  function falarOuAnunciar(texto) {
    if (!Voz.falar(texto)) anunciar(texto);
  }

  // Barra de controles da leitura
  function setupBarraFala() {
    Voz.aoMudar((est, item) => {
      $("barra-fala").hidden = est === "parado";
      const pausado = est === "pausado";
      $("barra-fala-titulo").textContent = (pausado ? "Pausado" : "Lendo") + (item?.titulo ? ": " + item.titulo : " em voz alta…");
      $("btn-pausa").setAttribute("aria-label", pausado ? "Continuar" : "Pausar");
      $("ico-pausa").setAttribute("d", pausado ? "M7 5l12 7-12 7Z" : "M7 5h3v14H7zM14 5h3v14h-3z");
      $("btn-repetir").disabled = !Voz.temRepeticao;
    });
    $("btn-pausa").addEventListener("click", () => Voz.alternarPausa());
    $("btn-proximo").addEventListener("click", () => Voz.proximo());
    $("btn-anterior").addEventListener("click", () => Voz.anterior());
    $("btn-parar").addEventListener("click", () => Voz.parar());
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && Voz.estado !== "parado") Voz.parar();
    });
  }

  // =====================================================================
  //  ASSISTENTE: perguntas prontas respondidas com os dados reais
  // =====================================================================
  // Cada intenção devolve { texto, visual?, nota? }. "texto" é exibido e
  // falado; "visual" é um gráfico/indicador; "nota" explica a origem.
  const SEM_LEITURAS = { texto: "Ainda não há leituras neste período. Assim que os sensores enviarem dados, eu respondo com os números da sua casa." };
  const NOTA_ESTIM = "Estimativa com a tarifa configurada; não inclui impostos, taxa mínima nem Fio B.";
  const comp = (a, b) => Graficos.comparativo([a, b]);
  const diasComLeitura = (h) => h.filter((x) => x.consumo_kwh > 0 || x.geracao_kwh > 0).length;

  const INTENCOES = {
    // ---- Geração ----
    async g_mes() {
      const [b, hm] = await Promise.all([dados.bill("month"), dados.history("month")]);
      if (semDados(b)) return SEM_LEITURAS;
      const dias = diasComLeitura(hm) || 1;
      return {
        texto: `Neste mês, até agora, seu sistema solar gerou ${falaKwh(b.geracao_kwh)}, ` +
          `uma média de ${falaKwh(b.geracao_kwh / dias)} por dia, em ${dias} ${dias === 1 ? "dia" : "dias"} com leitura. ` +
          `Isso equivale a uma economia estimada de ${falaReais(b.economia_solar)}.`,
        visual: comp({ rotulo: "Gerado", valor: b.geracao_kwh, classe: "gen" }, { rotulo: "Consumido", valor: b.consumo_kwh, classe: "use" }),
        nota: NOTA_ESTIM,
      };
    },
    async g_hoje() {
      const b = await dados.bill("day");
      if (semDados(b)) return SEM_LEITURAS;
      return {
        texto: `Hoje, até agora, seu sistema solar gerou ${falaKwh(b.geracao_kwh)}, e a casa consumiu ${falaKwh(b.consumo_kwh)}.`,
        visual: comp({ rotulo: "Gerado", valor: b.geracao_kwh, classe: "gen" }, { rotulo: "Consumido", valor: b.consumo_kwh, classe: "use" }),
      };
    },
    async g_esperado() {
      const ins = (await dados.insights()).geracao_hoje;
      const hoje = ins.hoje_kwh, media = ins.media_7d_mesmo_horario_kwh;
      if (!ins.dias_base || media === null) {
        return { texto: "Ainda não há dias anteriores com leituras para comparar. Depois de alguns dias de uso, consigo dizer se a geração está dentro do normal para a sua casa." };
      }
      if (media < 0.01 && hoje < 0.01) {
        return { texto: "Ainda não houve sol hoje, então não dá para comparar. Pergunte de novo durante o dia." };
      }
      const r = media > 0 ? hoje / media : 2;
      const pct = Math.round(Math.abs(r - 1) * 100);
      const veredito = r >= 0.9 && r <= 1.1 ? "Está dentro do esperado."
        : r > 1.1 ? `Está ${pct} por cento acima da média. Ótimo dia de sol!`
        : r >= 0.7 ? `Está um pouco abaixo da média, ${pct} por cento a menos. Pode ser um dia com nuvens.`
        : `Está bem abaixo da média, ${pct} por cento a menos. Pode ser um dia nublado; se acontecer vários dias seguidos com sol, vale verificar sujeira ou sombra nas placas.`;
      return {
        texto: `Hoje, até agora, o sistema gerou ${falaKwh(hoje)}. Nos últimos ${ins.dias_base} dias, até este mesmo horário, a média foi de ${falaKwh(media)}. ${veredito}`,
        visual: comp({ rotulo: "Hoje", valor: hoje, classe: "gen" }, { rotulo: `Média de ${ins.dias_base} dias`, valor: media, classe: "neutro" }),
        nota: "Comparação com o histórico da própria casa até o mesmo horário; não há uma meta de geração cadastrada.",
      };
    },
    async g_pico() {
      const hm = await dados.history("month");
      const pico = picoDe(hm, "geracao_kwh");
      if (!pico) return { texto: "Ainda não houve geração solar neste mês." };
      const dias = diasComLeitura(hm) || 1;
      const total = hm.reduce((a, x) => a + x.geracao_kwh, 0);
      const slots = montarSlots(hm, "month");
      return {
        texto: `O dia de maior geração neste mês foi ${pico.rotulo}, com ${falaKwh(pico.geracao_kwh)}. A média por dia foi de ${falaKwh(total / dias)}.`,
        visual: miniGrafico(slots, slots.findIndex((s) => s.rotulo === pico.rotulo), "month"),
      };
    },
    async g_aproveito() {
      const b = await dados.bill("month");
      if (semDados(b)) return SEM_LEITURAS;
      if (!b.geracao_kwh) return { texto: "Ainda não houve geração solar neste mês." };
      return {
        texto: `Do que o sol gerou neste mês, ${b.aproveitamento_pct} por cento foi usado direto pela casa, ${falaKwh(b.autoconsumo_kwh)}. ` +
          `O restante, ${falaKwh(b.injetada_kwh)}, foi injetado na rede. ` +
          "A energia injetada não é perdida: ela vira crédito com a concessionária e abate a energia que você compra. " +
          "Para usar mais o sol diretamente, ligue aparelhos de maior consumo entre 10 e 15 horas.",
        visual: Graficos.composicao([
          { rotulo: "Usada direto pela casa", valor: b.autoconsumo_kwh, classe: "gen" },
          { rotulo: "Injetada na rede", valor: b.injetada_kwh, classe: "pos" },
        ], { titulo: "Do que o sol gerou:" }),
        nota: notaFluxo(b),
      };
    },

    // ---- Consumo ----
    async c_mes() {
      const [b, d] = await Promise.all([dados.bill("month"), dados.bill("day")]);
      if (semDados(b)) return SEM_LEITURAS;
      return {
        texto: `Neste mês, até agora, sua residência consumiu ${falaKwh(b.consumo_kwh)}. ` +
          `Desse total, ${falaKwh(b.autoconsumo_kwh)} vieram direto do sol e ${falaKwh(b.importada_kwh)} da rede elétrica.` +
          (semDados(d) ? "" : ` Só hoje, foram ${falaKwh(d.consumo_kwh)}.`),
        visual: Graficos.composicao([
          { rotulo: "Direto do sol", valor: b.autoconsumo_kwh, classe: "gen" },
          { rotulo: "Da rede elétrica", valor: b.importada_kwh, classe: "neg" },
        ], { titulo: "Do que a casa consumiu:" }),
        nota: notaFluxo(b),
      };
    },
    async c_hoje() {
      const b = await dados.bill("day");
      if (semDados(b)) return SEM_LEITURAS;
      return {
        texto: `Hoje, até agora, sua residência consumiu ${falaKwh(b.consumo_kwh)}, que custariam ${falaReais(b.custo_consumo)} sem a energia solar.`,
        visual: comp({ rotulo: "Consumido", valor: b.consumo_kwh, classe: "use" }, { rotulo: "Gerado", valor: b.geracao_kwh, classe: "gen" }),
      };
    },
    async c_pico() {
      const hd = await dados.history("day");
      const pico = picoDe(hd, "consumo_kwh");
      if (!pico) return { texto: "Ainda não há leituras de consumo hoje." };
      const slots = montarSlots(hd, "day");
      return {
        texto: `Hoje, o horário de maior consumo foi às ${pico.rotulo}, com ${falaKwh(pico.consumo_kwh)}. ` +
          (pico.geracao_kwh > 0 ? `Nesse horário, o sol gerou ${falaKwh(pico.geracao_kwh)}.` : "Nesse horário não havia sol, então a energia veio da rede."),
        visual: miniGrafico(slots, slots.findIndex((s) => s.rotulo === pico.rotulo), "day"),
      };
    },
    async c_vs_mes() {
      const [b, ins] = await Promise.all([dados.bill("month"), dados.insights()]);
      const ant = ins.mes_anterior, mp = ant.mesmo_periodo;
      if (semDados(b)) return SEM_LEITURAS;
      if (!ant.dados_completos || !mp.n_leituras) {
        return { texto: `Não há leituras suficientes de ${mesFalado(ant.rotulo)} para comparar. A comparação fica disponível quando houver um mês anterior completo.` };
      }
      const dia = new Date().getDate();
      const varPct = mp.consumo_kwh > 0 ? ((b.consumo_kwh - mp.consumo_kwh) / mp.consumo_kwh) * 100 : 0;
      const veredito = Math.abs(varPct) < 5 ? "Seu consumo ficou praticamente igual."
        : varPct > 0 ? `Seu consumo aumentou ${Math.round(varPct)} por cento.`
        : `Seu consumo diminuiu ${Math.round(-varPct)} por cento.`;
      return {
        texto: `Do dia 1 ao dia ${dia} deste mês, a casa consumiu ${falaKwh(b.consumo_kwh)}. ` +
          `No mesmo período de ${mesFalado(ant.rotulo)}, consumiu ${falaKwh(mp.consumo_kwh)}. ${veredito}`,
        visual: comp({ rotulo: "Este mês", valor: b.consumo_kwh, classe: "use" }, { rotulo: ant.rotulo, valor: mp.consumo_kwh, classe: "neutro" }),
        nota: "Compara os mesmos dias dos dois meses, para ser justo com o mês em andamento.",
      };
    },
    async c_maior() {
      const [b, d] = await Promise.all([dados.bill("month"), dados.bill("day")]);
      if (semDados(b)) return SEM_LEITURAS;
      const frase = (x) => x.saldo_kwh > 0 ? `gerou mais do que consumiu, sobrando ${falaKwh(x.saldo_kwh)}`
        : x.saldo_kwh < 0 ? `consumiu mais do que gerou, faltando ${falaKwh(x.saldo_kwh)}` : "geração e consumo empataram";
      return {
        texto: (b.saldo_kwh < 0 ? "Sim. " : "Não. ") +
          `Neste mês, até agora, você gerou ${falaKwh(b.geracao_kwh)} e consumiu ${falaKwh(b.consumo_kwh)}: ${frase(b)}.` +
          (semDados(d) ? "" : ` Hoje, você ${frase(d)}.`),
        visual: comp({ rotulo: "Gerado", valor: b.geracao_kwh, classe: "gen" }, { rotulo: "Consumido", valor: b.consumo_kwh, classe: "use" }),
      };
    },

    // ---- Economia ----
    async e_economia() {
      const b = await dados.bill("month");
      if (semDados(b)) return SEM_LEITURAS;
      return {
        texto: `Neste mês, até agora, a energia solar gerou ${falaKwh(b.geracao_kwh)}, o que equivale a cerca de ${falaReais(b.economia_solar)} ` +
          `que você deixa de pagar, com a tarifa de ${tarifaFalada(b)}. ` +
          `Sem o sol, a energia consumida custaria ${falaReais(b.custo_consumo)}; com o sol, a estimativa é de ${falaReais(b.custo_liquido)}.`,
        visual: Graficos.comparativo([
          { rotulo: "Sem o sol", valor: b.custo_consumo, classe: "neg", texto: money(b.custo_consumo, b.moeda) },
          { rotulo: "Com o sol", valor: b.custo_liquido, classe: "pos", texto: money(b.custo_liquido, b.moeda) },
        ]),
        nota: NOTA_ESTIM,
      };
    },
    async e_comprando() {
      const b = await dados.bill("month");
      if (semDados(b)) return SEM_LEITURAS;
      return {
        texto: `Neste mês, até agora, a casa precisou de ${falaKwh(b.importada_kwh)} da rede elétrica, nos momentos em que o sol não era suficiente, como à noite. ` +
          `No mesmo período, você injetou ${falaKwh(b.injetada_kwh)} na rede. ` +
          (b.custo_liquido > 0
            ? `Como a energia injetada compensa a comprada, a estimativa a pagar pela energia é de ${falaReais(b.custo_liquido)}.`
            : "Como você injetou mais do que comprou, pela estimativa não há energia a pagar."),
        visual: comp({ rotulo: "Comprada (importada)", valor: b.importada_kwh, classe: "neg" }, { rotulo: "Injetada na rede", valor: b.injetada_kwh, classe: "pos" }),
        nota: notaFluxo(b),
      };
    },
    async e_creditos() {
      const b = await dados.bill("month");
      if (semDados(b)) return SEM_LEITURAS;
      const dif = b.injetada_kwh - b.importada_kwh;
      return {
        texto: "O saldo oficial de créditos só aparece na conta da concessionária; este aplicativo não tem acesso a ele. " +
          `Pelos sensores, neste mês você injetou ${falaKwh(b.injetada_kwh)} na rede e comprou ${falaKwh(b.importada_kwh)}. ` +
          (dif > 0
            ? `Como injetou mais do que comprou, a tendência é sobrar cerca de ${falaKwh(dif)} em créditos, que podem abater contas futuras.`
            : `Como comprou mais do que injetou, a tendência é não sobrar créditos neste mês: a diferença, ${falaKwh(dif)}, deve ser cobrada.`),
        visual: comp({ rotulo: "Injetada (gera crédito)", valor: b.injetada_kwh, classe: "pos" }, { rotulo: "Comprada (usa crédito)", valor: b.importada_kwh, classe: "neg" }),
        nota: notaFluxo(b),
      };
    },
    async e_reduzir() {
      const hd = await dados.history("day");
      const comLeitura = hd.filter((x) => x.consumo_kwh > 0);
      if (!comLeitura.length) {
        return { texto: "Ainda não há leituras de consumo hoje. Uma dica geral: use aparelhos de maior consumo entre 10 e 15 horas, quando as placas geram mais, e evite deixar aparelhos em modo de espera." };
      }
      const total = comLeitura.reduce((a, x) => a + x.consumo_kwh, 0);
      const semSol = comLeitura.filter((x) => x.geracao_kwh <= 0).reduce((a, x) => a + x.consumo_kwh, 0);
      const pico = picoDe(hd, "consumo_kwh");
      const slots = montarSlots(hd, "day");
      return {
        texto: `Hoje, o maior consumo foi às ${pico.rotulo}, com ${falaKwh(pico.consumo_kwh)}. ` +
          `${Math.round((semSol / total) * 100)} por cento do consumo de hoje aconteceu sem sol, com energia comprada da rede. ` +
          "Três dicas: use máquina de lavar, ferro de passar e bomba d'água entre 10 e 15 horas, quando as placas geram mais. " +
          "Banhos mais curtos, ou o chuveiro na posição verão, reduzem bastante o consumo. " +
          "E desligue da tomada aparelhos que ficam em modo de espera.",
        visual: miniGrafico(slots, slots.findIndex((s) => s.rotulo === pico.rotulo), "day"),
      };
    },

    // ---- Conta ----
    async x_explica() {
      const b = await dados.bill("month");
      if (semDados(b)) return SEM_LEITURAS;
      return {
        texto: "Sua conta tem três números principais. " +
          `Energia gerada: ${falaKwh(b.geracao_kwh)}, o que as placas produziram. ` +
          `Energia consumida: ${falaKwh(b.consumo_kwh)}, o que a casa usou. ` +
          `Saldo: ${minuscula(fraseSaldo(b, true))} ` +
          "Quando o sol gera mais do que a casa usa, a sobra vai para a rede e vira crédito. Quando falta, a casa usa energia da rede. " +
          (b.custo_liquido > 0 ? `A estimativa a pagar pela energia, neste mês, é de ${falaReais(b.custo_liquido)}.`
            : "Pela estimativa, neste mês não há energia a pagar."),
        visual: comp({ rotulo: "Gerado", valor: b.geracao_kwh, classe: "gen" }, { rotulo: "Consumido", valor: b.consumo_kwh, classe: "use" }),
        nota: NOTA_ESTIM,
      };
    },
    async x_injetada() {
      const b = await dados.bill("month");
      return {
        texto: "Energia injetada é a sobra da geração solar que a casa não usou na hora e que vai para a rede elétrica da concessionária. " +
          "Ela não é perdida: vira crédito, que abate a energia que você compra depois, por exemplo à noite. " +
          (semDados(b) ? "" : `Neste mês, pelos sensores, foram injetados ${falaKwh(b.injetada_kwh)}.`),
        visual: semDados(b) ? null : Graficos.composicao([
          { rotulo: "Usada direto pela casa", valor: b.autoconsumo_kwh, classe: "gen" },
          { rotulo: "Injetada na rede", valor: b.injetada_kwh, classe: "pos" },
        ], { titulo: "Do que o sol gerou:" }),
        nota: semDados(b) ? null : notaFluxo(b),
      };
    },
    async x_compensada() {
      const b = await dados.bill("month");
      const base = "Energia gerada é tudo o que as placas produziram. " +
        "Energia compensada é só a parte injetada na rede que é usada para abater a energia comprada da concessionária. " +
        "A energia que a casa usa no mesmo momento em que é gerada nem passa pelo medidor da concessionária, por isso não aparece como compensação. ";
      if (semDados(b)) return { texto: base };
      const compensavel = Math.min(b.injetada_kwh, b.importada_kwh);
      return {
        texto: base + `Neste mês, você gerou ${falaKwh(b.geracao_kwh)}, injetou ${falaKwh(b.injetada_kwh)} e comprou ${falaKwh(b.importada_kwh)}. ` +
          `Pela estimativa, até ${falaKwh(compensavel)} podem ser compensados. O valor oficial aparece na conta da concessionária.`,
        visual: Graficos.comparativo([
          { rotulo: "Gerada", valor: b.geracao_kwh, classe: "gen" },
          { rotulo: "Injetada", valor: b.injetada_kwh, classe: "pos" },
          { rotulo: "Compensável (estim.)", valor: compensavel, classe: "neutro" },
        ]),
        nota: notaFluxo(b),
      };
    },
    async x_saldo() {
      const b = await dados.bill("month");
      const base = "O saldo energético é a energia gerada menos a consumida. Saldo positivo, com seta para cima e em verde, quer dizer que sobrou energia. " +
        "Saldo negativo, com seta para baixo e em vermelho, quer dizer que faltou, e a diferença veio da rede elétrica. ";
      if (semDados(b)) return { texto: base };
      return {
        texto: base + `Neste mês, até agora, ${minuscula(fraseSaldo(b, true))}`,
        visual: comp({ rotulo: "Gerado", valor: b.geracao_kwh, classe: "gen" }, { rotulo: "Consumido", valor: b.consumo_kwh, classe: "use" }),
      };
    },

    // ---- Atalhos e perguntas faladas/digitadas ----
    async pagar() {
      const b = await dados.bill("month");
      if (semDados(b)) return SEM_LEITURAS;
      return {
        texto: (b.custo_liquido > 0
          ? `Pela estimativa, neste mês, até agora, a energia a pagar é de ${falaReais(b.custo_liquido)}. `
          : "Pela estimativa, neste mês, até agora, não há energia a pagar. ") +
          `Você comprou ${falaKwh(b.importada_kwh)} da rede e injetou ${falaKwh(b.injetada_kwh)}, que compensam a compra. ` +
          "A conta oficial pode ter ainda a taxa mínima e impostos.",
        visual: comp({ rotulo: "Comprada (importada)", valor: b.importada_kwh, classe: "neg" }, { rotulo: "Injetada na rede", valor: b.injetada_kwh, classe: "pos" }),
        nota: NOTA_ESTIM,
      };
    },
    async agora() {
      return { texto: resumoAoVivo(await atualOuNulo()) };
    },

    // ---- Agora (medição atual do ESP32; nunca mostra leitura antiga como atual) ----
    async agora_gerando() {
      const c = await atualOuNulo();
      const l = c?.leitura;
      if (!c || !c.atual || !l || l.geracao_w === null) return { texto: semMedicaoAtual(c, "da geração") };
      return {
        texto: l.geracao_w >= 1 ? `Neste momento as placas estão gerando ${falaWatts(l.geracao_w)}.`
          : "Neste momento as placas não estão gerando energia.",
        visual: comp({ rotulo: "Gerando", valor: l.geracao_w, classe: "gen", texto: nf(l.geracao_w, 0) + " W" },
          { rotulo: "Consumindo", valor: l.consumo_w || 0, classe: "use", texto: w(l.consumo_w) + " W" }),
        nota: `Medição das ${new Date(l.ts).toLocaleTimeString("pt-BR")}.`,
      };
    },
    async agora_consumindo() {
      const c = await atualOuNulo();
      const l = c?.leitura;
      if (!c || !c.atual || !l || l.consumo_w === null) return { texto: semMedicaoAtual(c, "do consumo") };
      return {
        texto: `Neste momento sua residência está consumindo ${falaWatts(l.consumo_w)}.`,
        visual: comp({ rotulo: "Consumindo", valor: l.consumo_w, classe: "use", texto: nf(l.consumo_w, 0) + " W" },
          { rotulo: "Gerando", valor: l.geracao_w || 0, classe: "gen", texto: w(l.geracao_w) + " W" }),
        nota: `Medição das ${new Date(l.ts).toLocaleTimeString("pt-BR")}.`,
      };
    },
    async agora_rede() {
      const c = await atualOuNulo();
      const l = c?.leitura;
      if (!c || !c.atual || !l) return { texto: semMedicaoAtual(c, "da troca de energia com a rede") };
      if (l.rede_medida) {
        const imp = l.rede_importando_w || 0, exp = l.rede_exportando_w || 0;
        return {
          texto: exp > 0 ? `Você está exportando ${falaWatts(exp)} para a rede, segundo o medidor da rede.`
            : imp > 0 ? `Você está importando ${falaWatts(imp)} da rede, segundo o medidor da rede.`
            : "Neste momento não há troca de energia com a rede.",
          visual: comp({ rotulo: "Importando", valor: imp, classe: "neg", texto: nf(imp, 0) + " W" },
            { rotulo: "Exportando", valor: exp, classe: "pos", texto: nf(exp, 0) + " W" }),
          nota: "Medido pelo ESP32 no ponto de conexão com a rede.",
        };
      }
      if (l.saldo_w === null) return { texto: "O medidor não mede a rede diretamente, e um dos sensores não enviou valor agora; não dá para estimar." };
      return {
        texto: "O medidor não mede a rede diretamente. " + (l.saldo_w > 0
          ? `Pela diferença entre geração e consumo, você está exportando cerca de ${falaWatts(l.saldo_w)}.`
          : l.saldo_w < 0 ? `Pela diferença entre geração e consumo, você está importando cerca de ${falaWatts(l.saldo_w)}.`
          : "Geração e consumo estão praticamente iguais."),
        nota: "Estimativa: diferença entre geração e consumo (não é a medição da concessionária).",
      };
    },
    async e_exportando() {
      const b = await dados.bill("month");
      if (semDados(b)) return SEM_LEITURAS;
      return {
        texto: `Neste mês, até agora, você exportou ${falaKwh(b.injetada_kwh)} para a rede, valores ${origemFluxo(b, true)}. ` +
          `Isso corresponde a ${b.aproveitamento_pct === null ? "parte" : (100 - b.aproveitamento_pct) + " por cento"} do que o sol gerou.`,
        visual: Graficos.composicao([
          { rotulo: "Usada direto pela casa", valor: b.autoconsumo_kwh, classe: "gen" },
          { rotulo: "Exportada (injetada)", valor: b.injetada_kwh, classe: "pos" },
        ], { titulo: "Do que o sol gerou:" }),
        nota: notaFluxo(b),
      };
    },
  };

  async function atualOuNulo() {
    try { return await dados.current(); } catch (_) { return null; }
  }
  // de: "da geração", "do consumo"...
  function semMedicaoAtual(c, de) {
    if (!c) return "Não consegui falar com o servidor agora. Tente de novo em instantes.";
    if (!c.leitura) return "O medidor ainda não enviou nenhuma leitura, então não há medição atual.";
    if (c.atual) return `A última transmissão do medidor não trouxe a medição ${de}.`;
    return `Não há medição atual ${de}: o medidor não transmite há ${tempoDesde(c.idade_s)}. ` +
      `A última leitura válida é de ${CS.dataHoraBR(c.leitura.ts)} e está disponível no histórico.`;
  }

  // Texto da pergunta exibido na conversa
  function textoPergunta(chave) {
    const b = document.querySelector(`#tela-assistente .pergunta[data-intencao="${chave}"]`) ||
      document.querySelector(`.pergunta[data-intencao="${chave}"]`);
    return b ? b.textContent.trim() : chave;
  }

  // Mini gráfico para respostas (sem interação, com um ponto destacado)
  function miniGrafico(slots, sel, p) {
    const div = h("div", { classe: "grafico mini", role: "img",
      "aria-label": `Gráfico ${p === "day" ? "hora a hora de hoje" : "dia a dia deste mês"}, com destaque em ${slots[sel]?.rotulo || ""}.` });
    Graficos.barras(div, { slots, sel, atual: -1, marcarEixo: marcarEixo(p), altura: 190, interativo: false });
    return div;
  }

  // ---------- conversa ----------
  async function perguntar(chave, rotulo) {
    if (estado.tela !== "assistente") mostrarTela("assistente", { foco: false });
    const msg = adicionarMensagem(rotulo || textoPergunta(chave));
    let r;
    try { r = await INTENCOES[chave](); }
    catch (e) { console.error(e); r = { texto: "Não consegui buscar os dados agora. Verifique a conexão e tente de novo." }; }
    preencherResposta(msg, r);
  }

  function rolarAte(el) {
    const suave = !matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ block: "nearest", behavior: suave ? "smooth" : "auto" });
  }

  function adicionarMensagem(pergunta) {
    $("conversa-vazia")?.remove();
    const art = h("article", { classe: "msg" }, [
      h("p", { classe: "msg-pergunta" }, [h("span", { classe: "sr-only", texto: "Você perguntou: " }), pergunta]),
      h("div", { classe: "msg-resposta" }, h("p", { classe: "msg-texto", texto: "Buscando os dados…" })),
    ]);
    $("conversa").appendChild(art);
    rolarAte(art);
    return art;
  }

  function preencherResposta(art, r, { guardar = true } = {}) {
    const corpo = art.querySelector(".msg-resposta");
    const p = h("p", { classe: "msg-texto" });
    corpo.replaceChildren(p);
    Voz.renderFrases(p, Voz.dividir(r.texto));
    if (r.visual) corpo.appendChild(h("div", { classe: "msg-visual" }, r.visual));
    if (r.nota) corpo.appendChild(h("p", { classe: "sub msg-nota", texto: r.nota }));
    const ouvir = h("button", { classe: "botao secundario pequeno", type: "button" }, [icone("i-som"), "Ouvir"]);
    const parar = h("button", { classe: "botao secundario pequeno", type: "button", texto: "Parar" });
    ouvir.addEventListener("click", () => falarMsg(r.texto, p, true));
    parar.addEventListener("click", () => Voz.parar());
    corpo.appendChild(h("div", { classe: "linha-botoes" }, [ouvir, parar]));

    if (prefs.falar && Voz.suportada) falarMsg(r.texto, p, guardar);
    else anunciar(r.texto);
    rolarAte(art);
  }

  function falarMsg(texto, p, guardar) {
    const spans = [...p.querySelectorAll(".frase")];
    const frases = Voz.dividir(texto);
    if (!Voz.tocar(frases.map((t, i) => ({ texto: t, el: spans[i], grupo: i })), { guardar })) anunciar(texto);
  }

  // ---------- perguntas digitadas ou faladas ----------
  const AJUDA = "Você pode perguntar, por exemplo: quanto gerei este mês, quanto consumi hoje, quanto vou pagar, " +
    "estou acumulando créditos, como reduzir o consumo, ou peça para eu explicar a conta. " +
    "Também entendo: repetir, mais devagar e mais rápido.";

  function identificar(texto) {
    const q = CS.semAcento(texto).replace(/[?!.,]/g, " ").replace(/\s+/g, " ").trim();
    const t = (re) => re.test(q);
    const hoje = t(/\bhoje\b/);
    const agora = t(/\bagora\b|neste momento|nesse momento|ao vivo|instant|estou (gerando|consumindo|importando|exportando)|esta (gerando|consumindo)/) && !hoje && !t(/\bmes\b/);
    if (agora && t(/import|export|rede/)) return "agora_rede";
    if (agora && t(/ger|produz/)) return "agora_gerando";
    if (agora && t(/consum|gast|usando/)) return "agora_consumindo";
    if (agora) return "agora";
    if (t(/export/)) return "e_exportando";
    if (t(/credito/)) return "e_creditos";
    if (t(/compens/)) return "x_compensada";
    if (t(/injet/)) return "x_injetada";
    if (t(/esperad|normal|abaixo|acima/)) return "g_esperado";
    if (t(/reduz|diminuir|dica|gastar menos/)) return "e_reduzir";
    if (t(/econom/)) return "e_economia";
    if (t(/compr|import|concession/)) return "e_comprando";
    if (t(/explic|resumo|entender/)) return "x_explica";
    if (t(/pagar|pago|custo|custa|valor|preco|reais|dinheiro|\bconta\b/)) return "pagar";
    if (t(/mais do que (ger|produz)|mais que (ger|produz)/)) return "c_maior";
    if (t(/aument|mes passado|anterior/)) return "c_vs_mes";
    if (t(/(horario|hora).*(consum|gast)|(consum|gast).*(horario|hora)|pico de consumo/)) return "c_pico";
    if (t(/\bdia\b.*(ger|produz)|maior geracao|(ger|produz).*\bdia\b/)) return "g_pico";
    if (t(/aproveit/)) return "g_aproveito";
    if (t(/saldo|sobr|falt/)) return "x_saldo";
    if (t(/consum|gast|usei|usou/)) return hoje ? "c_hoje" : "c_mes";
    if (t(/ger|produz|solar|\bsol\b|placa|painel/)) return hoje ? "g_hoje" : "g_mes";
    return null;
  }

  function perguntaLivre(texto) {
    const q = CS.semAcento(texto);
    const curto = q.trim().split(/\s+/).length <= 3;
    const responderCom = (txt, guardar = true) => preencherResposta(adicionarMensagem(texto), { texto: txt }, { guardar });
    if (curto && /\b(parar|pare|para|silencio|chega|cancelar)\b/.test(q)) { Voz.parar(); return; }
    if (/repet|de novo|outra vez/.test(q)) { if (!Voz.repetir()) responderCom("Ainda não há resposta para repetir.", false); return; }
    if (/devagar|lent/.test(q)) { ajustarVelocidade(-1); return responderCom("Certo, vou falar mais devagar.", false); }
    if (/rapid|depressa/.test(q)) { ajustarVelocidade(+1); return responderCom("Certo, vou falar mais rápido.", false); }
    if (/ajuda|o que (eu )?posso|comandos/.test(q)) return responderCom(AJUDA);
    const chave = identificar(texto);
    if (!chave) return responderCom("Não entendi a pergunta. " + AJUDA);
    perguntar(chave, texto);
  }

  const VELOCIDADES = [0.7, 0.9, 1.15];
  function ajustarVelocidade(delta) {
    let i = VELOCIDADES.findIndex((v) => v >= prefs.rate - 0.01);
    if (i < 0) i = 1;
    prefs.rate = VELOCIDADES[Math.max(0, Math.min(VELOCIDADES.length - 1, i + delta))];
    salvarPrefs();
    sincronizarAjustes();
  }

  // ---------- microfone (reconhecimento de voz) ----------
  function setupReconhecimento() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const btn = $("btn-perguntar"), txt = $("btn-perguntar-txt"), aviso = $("voz-aviso");
    const avisar = (m) => { aviso.hidden = !m; aviso.textContent = m || ""; };
    if (!SR) { $("por-voz").hidden = true; return; } // iPhone/Safari: os botões bastam
    const rec = new SR();
    rec.lang = "pt-BR"; rec.interimResults = true; rec.maxAlternatives = 3; rec.continuous = false;
    let ouvindo = false, respondeu = false;
    const setOuvindo = (on) => {
      ouvindo = on;
      document.body.classList.toggle("gravando", on);
      btn.setAttribute("aria-pressed", String(on));
      txt.textContent = on ? "Ouvindo… toque para cancelar" : "Perguntar falando";
    };
    btn.addEventListener("click", () => {
      if (ouvindo) { rec.abort(); return; }
      Voz.parar();   // o microfone não pode ouvir o próprio app falando
      respondeu = false;
      avisar("Pode falar após o bipe…");
      try { rec.start(); } catch (_) { /* já iniciado */ }
    });
    rec.onstart = () => { setOuvindo(true); bipe(880); };
    rec.onresult = (ev) => {
      const res = ev.results[ev.results.length - 1];
      avisar("Você: " + res[0].transcript);
      if (!res.isFinal) return;
      respondeu = true;
      avisar("");
      bipe(660, 90);
      perguntaLivre(res[0].transcript);
    };
    rec.onerror = (ev) => {
      const msgs = {
        "no-speech": "Não ouvi nada. Toque de novo e fale logo após o bipe.",
        "audio-capture": "Nenhum microfone encontrado neste aparelho.",
        "not-allowed": "O microfone está bloqueado. Libere o acesso ao microfone nas configurações do navegador. Em rede local, o navegador exige HTTPS.",
        "service-not-allowed": "O reconhecimento de voz não está disponível. Use os botões de pergunta.",
        "network": "O reconhecimento de voz precisa de internet. Use os botões de pergunta.",
      };
      if (ev.error === "aborted") { avisar(""); return; }
      respondeu = true;
      const m = msgs[ev.error] || "Não consegui ouvir. Tente novamente.";
      avisar(m);
      if (prefs.falar && Voz.suportada) Voz.falar(m, null, false); else anunciar(m);
    };
    rec.onend = () => { setOuvindo(false); if (!respondeu) avisar(""); };
  }

  // Bipe curto para indicar "pode falar" sem que o microfone capture uma fala.
  function bipe(freq = 880, ms = 140) {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      bipe.ctx = bipe.ctx || new Ctx();
      const ctx = bipe.ctx, o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + ms / 1000);
      o.connect(g).connect(ctx.destination);
      o.start(); o.stop(ctx.currentTime + ms / 1000 + 0.02);
    } catch (_) {}
  }

  // ---------- abas de assuntos (padrão ARIA tabs) ----------
  function setupCategorias() {
    const abas = [...document.querySelectorAll('.categorias [role="tab"]')];
    const ativar = (aba, foco) => {
      abas.forEach((a) => {
        const sel = a === aba;
        a.setAttribute("aria-selected", String(sel));
        a.tabIndex = sel ? 0 : -1;
        $(a.getAttribute("aria-controls")).hidden = !sel;
      });
      if (foco) aba.focus();
    };
    abas.forEach((a, i) => {
      a.addEventListener("click", () => ativar(a));
      a.addEventListener("keydown", (e) => {
        const n = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: abas.length - 1 }[e.key];
        if (n === undefined) return;
        e.preventDefault();
        ativar(abas[(n + abas.length) % abas.length], true);
      });
    });
  }

  // =====================================================================
  //  NAVEGAÇÃO ENTRE TELAS
  // =====================================================================
  const TELAS = ["conta", "historico", "detalhe", "assistente"];
  const RENDER = {
    conta: () => { renderConta(); renderAoVivo(); },
    historico: renderHistorico, detalhe: renderDetalhe, assistente: () => {},
  };

  function mostrarTela(nome, { foco = true } = {}) {
    if (!TELAS.includes(nome)) nome = "conta";
    estado.tela = nome;
    for (const t of TELAS) $("tela-" + t).hidden = t !== nome;
    document.querySelectorAll(".aba").forEach((a) => {
      if (a.dataset.tela === nome) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
    $("periodo-barra").hidden = nome === "assistente";
    if (location.hash !== "#" + nome) history.replaceState(null, "", "#" + nome);
    RENDER[nome]();
    if (foco) $("tela-" + nome).querySelector(".tela-titulo").focus();
  }

  function trocarPeriodo(p) {
    if (p === estado.periodo) return;
    estado.periodo = p;
    document.querySelectorAll(".botao-periodo").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.periodo === p)));
    anunciar("Mostrando " + (p === "day" ? "hoje" : "este mês") + ".");
    RENDER[estado.tela]();
  }

  // =====================================================================
  //  APARÊNCIA E AJUSTES
  // =====================================================================
  function aplicarAparencia() {
    const html = document.documentElement;
    html.setAttribute("data-tema", prefs.tema);
    html.setAttribute("data-texto", prefs.texto);
    $("btn-tema").setAttribute("aria-pressed", String(prefs.tema === "contraste"));
    $("btn-texto").setAttribute("aria-pressed", String(prefs.texto === "grande"));
  }
  function sincronizarAjustes() {
    document.querySelectorAll('input[name="velocidade"]').forEach((r) => {
      r.checked = Math.abs(Number(r.value) - prefs.rate) < 0.01;
    });
    $("chk-falar").checked = prefs.falar;
  }
  function painelVoz(abrir) {
    $("painel-voz").hidden = !abrir;
    $("btn-painel-voz").setAttribute("aria-expanded", String(abrir));
    if (abrir) {
      Voz.atualizarStatusVoz();
      $("tit-painel-voz").setAttribute("tabindex", "-1");
      $("tit-painel-voz").focus();
    } else $("btn-painel-voz").focus();
  }

  // ---------- eventos ----------
  function wire() {
    window.addEventListener("hashchange", () => mostrarTela(location.hash.slice(1)));
    document.querySelectorAll(".aba").forEach((a) => a.addEventListener("click", (e) => {
      e.preventDefault(); mostrarTela(a.dataset.tela);
    }));
    document.querySelectorAll('a.link-botao[href="#assistente"]').forEach((a) =>
      a.addEventListener("click", (e) => { e.preventDefault(); mostrarTela("assistente"); }));
    document.querySelectorAll(".botao-periodo").forEach((b) => b.addEventListener("click", () => trocarPeriodo(b.dataset.periodo)));

    $("btn-ouvir-conta").addEventListener("click", ouvirConta);
    $("btn-ler-status").addEventListener("click", async () => falarOuAnunciar(resumoAoVivo(await atualOuNulo())));
    ["pointerdown", "keydown"].forEach((ev) =>
      document.addEventListener(ev, Voz.desbloquear, { once: true, capture: true }));

    document.querySelectorAll(".pergunta").forEach((b) =>
      b.addEventListener("click", () => perguntar(b.dataset.intencao, b.textContent.trim())));
    $("btn-repetir").addEventListener("click", () => Voz.repetir());
    $("btn-parar-audio").addEventListener("click", () => Voz.parar());
    $("btn-limpar").addEventListener("click", () => {
      Voz.parar();
      $("conversa").replaceChildren(h("p", { classe: "conversa-vazia", id: "conversa-vazia", texto: "As respostas aparecem aqui." }));
    });
    $("form-pergunta").addEventListener("submit", (e) => {
      e.preventDefault();
      const campo = $("campo-pergunta");
      const q = campo.value.trim();
      if (!q) { campo.focus(); return; }
      campo.value = "";
      perguntaLivre(q);
    });

    $("btn-tema").addEventListener("click", () => {
      prefs.tema = prefs.tema === "contraste" ? "" : "contraste"; salvarPrefs(); aplicarAparencia();
    });
    $("btn-texto").addEventListener("click", () => {
      prefs.texto = prefs.texto === "grande" ? "" : "grande"; salvarPrefs(); aplicarAparencia();
    });
    $("btn-painel-voz").addEventListener("click", () => painelVoz($("painel-voz").hidden));
    $("btn-fechar-voz").addEventListener("click", () => painelVoz(false));
    document.querySelectorAll('input[name="velocidade"]').forEach((r) =>
      r.addEventListener("change", () => { prefs.rate = Number(r.value); salvarPrefs(); }));
    $("sel-voz").addEventListener("change", (e) => { prefs.voz = e.target.value; salvarPrefs(); Voz.atualizarStatusVoz(); });
    $("chk-falar").addEventListener("change", (e) => { prefs.falar = e.target.checked; salvarPrefs(); });
    $("btn-testar-voz").addEventListener("click", () =>
      falarOuAnunciar("Olá! Esta é a voz que vai ler a sua conta de energia e as respostas do assistente."));
  }

  // ---------- início ----------
  function start() {
    aplicarAparencia();
    sincronizarAjustes();
    wire();
    setupBarraFala();
    setupCategorias();
    setupReconhecimento();
    Voz.carregarServidor();
    dados.info().then(aplicarInfo).catch(() => {});
    mostrarTela(location.hash.slice(1) || "conta", { foco: false });

    monitorarConexao();
    setInterval(monitorarConexao, 5000);
    setInterval(() => { if (estado.tela === "conta") renderAoVivo(); }, 5000);
    setInterval(() => {
      cache.delete("bill:" + estado.periodo);
      cache.delete("hist:" + estado.periodo);
      if (estado.tela !== "assistente") RENDER[estado.tela]();
    }, 30000);
    if (!CS.USE_MOCK && "serviceWorker" in navigator) {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    }
  }
  if (document.readyState !== "loading") start();
  else document.addEventListener("DOMContentLoaded", start);
})();
