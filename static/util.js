/* Utilitários compartilhados: formatação (tela e fala), preferências e
 * anúncios ao leitor de tela. Tudo fica em window.CS para os outros módulos. */
(() => {
  "use strict";
  const CS = (window.CS = window.CS || {});

  CS.USE_MOCK = !!window.__USE_MOCK__;
  CS.$ = (id) => document.getElementById(id);

  // ---------- números na tela ----------
  CS.nf = (n, d = 2) =>
    Number(n).toLocaleString("pt-BR", { minimumFractionDigits: d, maximumFractionDigits: d });
  CS.money = (n, moeda = "R$") => `${moeda} ${CS.nf(n, 2)}`;
  // Energia: 3 casas abaixo de 1 kWh (0,040 kWh não vira "0,00").
  CS.nfKwh = (n) => CS.nf(n, Math.abs(n) > 0 && Math.abs(n) < 1 ? 3 : 2);
  CS.kwh = (n) => CS.nfKwh(n) + " kWh";
  CS.semAcento = (s) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

  // ---------- números do jeito que se fala em português ----------
  // Sem zeros à direita ("1,5" e não "1,50") e sem ponto de milhar
  // ("1020" é lido "mil e vinte"; "1.020" pode virar "um ponto zero vinte").
  const nfFala = (n, max) =>
    Number(n).toLocaleString("pt-BR",
      { minimumFractionDigits: 0, maximumFractionDigits: max, useGrouping: false });
  // Em pt-BR, singular até menos de 2 ("1,5 quilowatt-hora").
  const plural = (n, sing, plur) => (Math.abs(n) < 2 ? sing : plur);
  CS.nfFala = nfFala;

  CS.falaKwh = (n) => {
    const a = Math.abs(n);
    if (a === 0) return "zero quilowatt-hora";
    if (a < 0.995) return `${nfFala(a * 1000, 0)} watts-hora`;
    const casas = a >= 100 ? 0 : a >= 10 ? 1 : 2;
    return `${nfFala(a, casas)} ${plural(a, "quilowatt-hora", "quilowatts-hora")}`;
  };

  CS.falaWatts = (n) => {
    const a = Math.abs(n);
    if (a >= 10000) return `${nfFala(a / 1000, 1)} quilowatts`;
    const r = Math.round(a);
    return `${r} ${r === 1 ? "watt" : "watts"}`;
  };

  CS.falaReais = (v) => {
    const total = Math.round(Math.abs(v) * 100);
    const reais = Math.floor(total / 100), cent = total % 100;
    if (!reais && !cent) return "zero reais";
    const partes = [];
    if (reais) partes.push(`${reais} ${reais === 1 ? "real" : "reais"}`);
    if (cent) partes.push(`${cent} ${cent === 1 ? "centavo" : "centavos"}`);
    return partes.join(" e ");
  };

  CS.falaPct = (p) => `${Math.round(p)} por cento`;

  // ---------- datas ----------
  const MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho",
    "agosto", "setembro", "outubro", "novembro", "dezembro"];
  CS.mesExtenso = (d = new Date()) => MESES[d.getMonth()];
  CS.dataHoraBR = (ts) => {
    const d = new Date(ts);
    if (isNaN(d)) return "—";
    return d.toLocaleDateString("pt-BR") + " às " +
      d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  };
  CS.dataBR = (iso) => {
    const d = new Date(iso + (iso.length === 10 ? "T12:00:00" : ""));
    return isNaN(d) ? "—" : d.toLocaleDateString("pt-BR");
  };
  CS.minutosDesde = (ts) => {
    const t = new Date(ts).getTime();
    return isNaN(t) ? 0 : Math.floor((Date.now() - t) / 60000);
  };

  // ---------- preferências (salvas no aparelho) ----------
  const PREF_PADRAO = { tema: "", texto: "", rate: 0.9, voz: "", falar: true };
  CS.prefs = (() => {
    try { return { ...PREF_PADRAO, ...JSON.parse(localStorage.getItem("prefs") || "{}") }; }
    catch (_) { return { ...PREF_PADRAO }; }
  })();
  CS.salvarPrefs = () => {
    try { localStorage.setItem("prefs", JSON.stringify(CS.prefs)); } catch (_) {}
  };

  // ---------- anúncios ao leitor de tela ----------
  CS.anunciar = (texto) => {
    const el = CS.$("anuncio");
    if (!el) return;
    // Limpa antes para que o mesmo texto repetido seja anunciado de novo.
    el.textContent = "";
    setTimeout(() => { el.textContent = texto; }, 60);
  };

  // Cria elemento (HTML ou SVG) com atributos e texto.
  CS.h = (tag, attrs = {}, filhos = []) => {
    const e = document.createElement(tag);
    for (const k in attrs) {
      if (k === "texto") e.textContent = attrs[k];
      else if (k === "classe") e.className = attrs[k];
      else e.setAttribute(k, attrs[k]);
    }
    for (const f of [].concat(filhos)) if (f) e.append(f);
    return e;
  };
})();
