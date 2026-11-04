/* Gráficos em SVG/HTML, sem bibliotecas. Cores por função (tokens CSS):
 *   âmbar = geração solar · azul = consumo · verde = sobra · vermelho = rede.
 * Identidade nunca só pela cor: nomes das séries escritos no gráfico,
 * posição (geração sobe, consumo desce) e tabela equivalente na página.
 * Interação: tocar/passar o mouse/setas do teclado mostram os valores. */
(() => {
  "use strict";
  const CS = window.CS, { nf } = CS;
  const SVG_NS = "http://www.w3.org/2000/svg";

  function el(tag, attrs, pai) {
    const e = document.createElementNS(SVG_NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (pai) pai.appendChild(e);
    return e;
  }

  // Topo "redondo" da escala (1, 2, 2,5, 5 × 10^n) para marcas legíveis.
  function escalaBonita(v) {
    if (v <= 0) return 0.1;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
    return 10 * p;
  }

  // Barra com cantos arredondados só na ponta (longe da linha de base).
  function caminhoBarra(x, base, w, alt, paraCima) {
    const r = Math.min(4, w / 2, alt);
    const y = paraCima ? base - alt : base + alt;
    const s = paraCima ? 1 : -1;
    return `M${x},${base} V${y + s * r} Q${x},${y} ${x + r},${y} H${x + w - r} ` +
      `Q${x + w},${y} ${x + w},${y + s * r} V${base} Z`;
  }

  function vazio(cont, msg) {
    cont.textContent = "";
    cont.appendChild(CS.h("p", { classe: "grafico-vazio", texto: msg || "Ainda não há leituras para este período." }));
  }

  // ---------- interação comum (ponteiro + teclado) ----------
  function interativo(cont) {
    if (cont._interativo) return;
    cont._interativo = true;
    const indice = (ev) => {
      const g = cont._geo, r = cont.getBoundingClientRect();
      if (!g) return -1;
      const i = Math.floor((ev.clientX - r.left - g.esq) / g.banda);
      return i >= 0 && i < g.n ? i : -1;
    };
    const selecionar = (i) => {
      const st = cont._estado;
      if (!st) return;
      st.sel = Math.max(0, Math.min(st.slots.length - 1, i));
      st.desenhar();
      if (st.leitura && st.textoSlot) st.leitura.textContent = st.textoSlot(st.slots[st.sel], st.sel);
    };
    cont.addEventListener("pointermove", (ev) => {
      if (ev.pointerType !== "mouse") return;
      const i = indice(ev);
      if (i >= 0 && i !== cont._estado?.sel) selecionar(i);
    });
    cont.addEventListener("pointerdown", (ev) => { const i = indice(ev); if (i >= 0) selecionar(i); });
    cont.addEventListener("keydown", (ev) => {
      const st = cont._estado;
      if (!st) return;
      const ultimo = st.slots.length - 1;
      const base = st.sel >= 0 ? st.sel : Math.max(0, Math.min(st.atual ?? ultimo, ultimo));
      const novo = { ArrowRight: base + 1, ArrowLeft: base - 1, Home: 0, End: ultimo }[ev.key];
      if (novo === undefined) return;
      ev.preventDefault();
      selecionar(st.sel < 0 && ev.key.startsWith("Arrow") ? base : novo);
    });
    cont._selecionar = selecionar;
  }

  // Redesenha quando a largura muda (girar o celular, abrir a tela, etc.).
  function acompanharLargura(cont) {
    if (cont._largura !== undefined || !("ResizeObserver" in window)) return;
    cont._largura = 0;
    new ResizeObserver(() => {
      const w = cont.clientWidth;
      if (w && w !== cont._largura && cont._estado) { cont._largura = w; cont._estado.desenhar(); }
    }).observe(cont);
  }

  // ---------- barras espelhadas: geração sobe, consumo desce ----------
  // cfg: { slots:[{rotulo, eixo, cima, baixo, futuro}], marcarEixo(i,n,banda),
  //        nomeCima, nomeBaixo, classeCima, classeBaixo, atual, sel, altura,
  //        leitura (elemento), textoSlot(slot,i), interativo }
  function barras(cont, cfg) {
    const temDados = cfg.slots.some((s) => (s.cima || 0) > 0 || (s.baixo || 0) > 0);
    if (!temDados) { cont._estado = null; return vazio(cont, cfg.vazio); }
    const st = (cont._estado = {
      ...cfg, sel: cfg.sel ?? (cont._estado?.chave === cfg.chave ? cont._estado.sel : -1),
      desenhar: () => desenharBarras(cont, st),
    });
    if (cfg.interativo !== false) interativo(cont);
    acompanharLargura(cont);
    st.desenhar();
    if (st.sel >= 0 && st.leitura && st.textoSlot) st.leitura.textContent = st.textoSlot(st.slots[st.sel], st.sel);
  }

  function desenharBarras(cont, st) {
    const slots = st.slots;
    const W = Math.max(200, cont.clientWidth || 320);
    const H = st.altura || 260;
    const m = { esq: 40, dir: 6, topo: 26, base: 26, faixa: 22 }; // faixa = rótulos do eixo no meio
    const plotW = W - m.esq - m.dir;
    const meia = (H - m.topo - m.base - m.faixa) / 2;
    const baseG = m.topo + meia, baseC = baseG + m.faixa;
    const max = escalaBonita(Math.max(0, ...slots.map((s) => Math.max(s.cima || 0, s.baixo || 0))));
    const n = slots.length, banda = plotW / n;
    const bw = Math.max(2, Math.min(banda - 2, st.larguraMax || 18)); // 2px de respiro entre barras
    const casas = max < 1 ? 2 : max < 10 ? 1 : 0;

    const svg = el("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, "aria-hidden": "true", focusable: "false" });
    for (const [y, v] of [[m.topo, max], [m.topo + meia / 2, max / 2], [baseC + meia / 2, max / 2], [baseC + meia, max]]) {
      el("line", { x1: m.esq, x2: W - m.dir, y1: y, y2: y, class: "g-grade" }, svg);
      el("text", { x: m.esq - 6, y: y + 4, class: "g-escala", "text-anchor": "end" }, svg).textContent = nf(v, casas);
    }
    el("line", { x1: m.esq, x2: W - m.dir, y1: baseG, y2: baseG, class: "g-base" }, svg);
    el("line", { x1: m.esq, x2: W - m.dir, y1: baseC, y2: baseC, class: "g-base" }, svg);

    const colX = (i) => m.esq + i * banda;
    if (st.atual >= 0 && st.atual < n) {
      el("rect", { x: colX(st.atual), y: m.topo, width: banda, height: H - m.topo - m.base, class: "g-agora" }, svg);
    }
    if (st.sel >= 0) {
      el("rect", { x: colX(st.sel), y: m.topo - 4, width: banda, height: H - m.topo - m.base + 8, rx: 4, class: "g-sel" }, svg);
    }
    slots.forEach((s, i) => {
      const x = colX(i) + (banda - bw) / 2;
      if (s.cima > 0) el("path", { d: caminhoBarra(x, baseG, bw, Math.max(1, (s.cima / max) * meia), true), class: st.classeCima || "g-gen" }, svg);
      if (s.baixo > 0) el("path", { d: caminhoBarra(x, baseC, bw, Math.max(1, (s.baixo / max) * meia), false), class: st.classeBaixo || "g-use" }, svg);
    });
    const marcar = st.marcarEixo || (() => true);
    slots.forEach((s, i) => {
      if (!marcar(i, n, banda)) return;
      el("text", { x: colX(i) + banda / 2, y: baseG + m.faixa / 2 + 4, class: "g-eixo", "text-anchor": "middle" }, svg)
        .textContent = s.eixo;
    });
    const rotuloSerie = (y, cls, txt) => {
      el("rect", { x: m.esq, y: y - 10, width: 12, height: 12, rx: 3, class: cls }, svg);
      el("text", { x: m.esq + 18, y, class: "g-serie" }, svg).textContent = txt;
    };
    rotuloSerie(m.topo - 10, st.classeCima || "g-gen", st.nomeCima || "▲ Gerado pelo sol (kWh)");
    rotuloSerie(H - 6, st.classeBaixo || "g-use", st.nomeBaixo || "▼ Consumido pela casa (kWh)");

    cont.textContent = "";
    cont.appendChild(svg);
    cont._geo = { esq: m.esq, banda, n };
  }

  // ---------- linha do saldo acumulado ----------
  // cfg: { slots:[{rotulo, eixo, valor|null}], marcarEixo, atual, leitura, textoSlot }
  function linha(cont, cfg) {
    const pontos = cfg.slots.filter((s) => s.valor !== null && s.valor !== undefined);
    if (!pontos.length) { cont._estado = null; return vazio(cont, cfg.vazio); }
    const st = (cont._estado = {
      ...cfg, sel: cont._estado?.chave === cfg.chave ? cont._estado.sel : -1,
      desenhar: () => desenharLinha(cont, st),
    });
    interativo(cont);
    acompanharLargura(cont);
    st.desenhar();
    if (st.sel >= 0 && st.leitura) st.leitura.textContent = st.textoSlot(st.slots[st.sel], st.sel);
  }

  function desenharLinha(cont, st) {
    const slots = st.slots;
    const W = Math.max(200, cont.clientWidth || 320);
    const H = st.altura || 220;
    const m = { esq: 44, dir: 8, topo: 14, base: 28 };
    const plotW = W - m.esq - m.dir, plotH = H - m.topo - m.base;
    const vals = slots.map((s) => s.valor).filter((v) => v !== null && v !== undefined);
    const lim = escalaBonita(Math.max(0.1, ...vals.map(Math.abs)));
    const y = (v) => m.topo + ((lim - v) / (2 * lim)) * plotH;  // escala simétrica: 0 no meio
    const n = slots.length, banda = plotW / n;
    const x = (i) => m.esq + i * banda + banda / 2;
    const y0 = y(0);
    const casas = lim < 1 ? 2 : lim < 10 ? 1 : 0;

    const svg = el("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, "aria-hidden": "true", focusable: "false" });
    const id = "c" + Math.random().toString(36).slice(2, 8);
    const defs = el("defs", {}, svg);
    el("rect", { x: 0, y: 0, width: W, height: y0 }, el("clipPath", { id: id + "p" }, defs));
    el("rect", { x: 0, y: y0, width: W, height: H - y0 }, el("clipPath", { id: id + "n" }, defs));

    for (const v of [lim, lim / 2, -lim / 2, -lim]) {
      el("line", { x1: m.esq, x2: W - m.dir, y1: y(v), y2: y(v), class: "g-grade" }, svg);
      el("text", { x: m.esq - 6, y: y(v) + 4, class: "g-escala", "text-anchor": "end" }, svg)
        .textContent = (v > 0 ? "+" : "") + nf(v, casas);
    }
    el("text", { x: m.esq - 6, y: y0 + 4, class: "g-escala", "text-anchor": "end" }, svg).textContent = "0";

    if (st.atual >= 0 && st.atual < n) {
      el("rect", { x: m.esq + st.atual * banda, y: m.topo, width: banda, height: plotH, class: "g-agora" }, svg);
    }

    // Caminho da linha e da área até o zero (só pontos com dados)
    const idx = slots.map((s, i) => (s.valor === null || s.valor === undefined ? -1 : i)).filter((i) => i >= 0);
    const d = idx.map((i, k) => `${k ? "L" : "M"}${x(i)},${y(slots[i].valor)}`).join(" ");
    const area = d + ` L${x(idx[idx.length - 1])},${y0} L${x(idx[0])},${y0} Z`;
    for (const [clip, cls] of [["p", "pos"], ["n", "neg"]]) {
      const g = el("g", { "clip-path": `url(#${id}${clip})` }, svg);
      el("path", { d: area, class: "g-area-" + cls }, g);
      el("path", { d, class: "g-linha-" + cls }, g);
    }
    el("line", { x1: m.esq, x2: W - m.dir, y1: y0, y2: y0, class: "g-base" }, svg);

    // Rótulos de eixo e sentido (texto, não só cor)
    const marcar = st.marcarEixo || (() => true);
    slots.forEach((s, i) => {
      if (marcar(i, n, banda)) el("text", { x: x(i), y: H - 8, class: "g-eixo", "text-anchor": "middle" }, svg).textContent = s.eixo;
    });
    el("text", { x: W - m.dir, y: m.topo + 12, class: "g-serie", "text-anchor": "end" }, svg).textContent = "▲ Sobrou energia";
    el("text", { x: W - m.dir, y: H - m.base - 6, class: "g-serie", "text-anchor": "end" }, svg).textContent = "▼ Faltou (veio da rede)";

    if (st.sel >= 0 && slots[st.sel] && slots[st.sel].valor !== null && slots[st.sel].valor !== undefined) {
      const v = slots[st.sel].valor;
      el("line", { x1: x(st.sel), x2: x(st.sel), y1: m.topo, y2: m.topo + plotH, class: "g-cruz" }, svg);
      el("circle", { cx: x(st.sel), cy: y(v), r: 5, class: "g-ponto " + (v >= 0 ? "pos" : "neg") }, svg);
    }
    cont.textContent = "";
    cont.appendChild(svg);
    cont._geo = { esq: m.esq, banda, n };
  }

  // ---------- composição (barra empilhada horizontal + legenda) ----------
  // partes: [{rotulo, valor, classe}] ; total = soma das partes
  function composicao(partes, { titulo } = {}) {
    const total = partes.reduce((a, p) => a + p.valor, 0);
    const wrap = CS.h("div", { classe: "composicao" });
    if (titulo) wrap.appendChild(CS.h("p", { classe: "composicao-titulo", texto: titulo }));
    const barra = CS.h("div", { classe: "composicao-barra", "aria-hidden": "true" });
    const lista = CS.h("ul", { classe: "composicao-legenda" });
    for (const p of partes) {
      const pct = total > 0 ? (p.valor / total) * 100 : 0;
      if (pct > 0) {
        const seg = CS.h("span", { classe: "seg " + p.classe });
        seg.style.width = pct + "%";
        barra.appendChild(seg);
      }
      lista.appendChild(CS.h("li", {}, [
        CS.h("span", { classe: "amostra " + p.classe, "aria-hidden": "true" }),
        CS.h("span", { texto: `${p.rotulo}: ${nf(p.valor)} kWh${total > 0 ? ` (${Math.round(pct)}%)` : ""}` }),
      ]));
    }
    wrap.append(barra, lista);
    return wrap;
  }

  // ---------- comparação simples (barras horizontais rotuladas) ----------
  // linhas: [{rotulo, valor, classe, texto}]
  function comparativo(linhas) {
    const max = Math.max(0.001, ...linhas.map((l) => l.valor));
    const wrap = CS.h("div", { classe: "comparativo" });
    for (const l of linhas) {
      const barra = CS.h("span", { classe: "comp-barra", "aria-hidden": "true" }, CS.h("span", { classe: "seg " + l.classe }));
      barra.firstChild.style.width = (l.valor / max) * 100 + "%";
      wrap.appendChild(CS.h("div", { classe: "comp-linha" }, [
        CS.h("span", { classe: "comp-rotulo", texto: l.rotulo }),
        barra,
        CS.h("span", { classe: "comp-valor", texto: l.texto ?? nf(l.valor) + " kWh" }),
      ]));
    }
    return wrap;
  }

  CS.Graficos = { barras, linha, composicao, comparativo, escalaBonita };
})();
