/* Simulador em JS: usado SOMENTE na prévia autônoma (window.__USE_MOCK__),
 * quando não há servidor. Espelha os cálculos de app/db.py para a tela se
 * comportar igual. Com o servidor, os dados vêm de /api/* (reais ou do
 * simulador do backend, sinalizado em /api/info). */
(() => {
  "use strict";
  const CS = window.CS;
  if (!CS.USE_MOCK) return;
  const TARIFA = window.__TARIFA__ || 0.95;
  const MESES = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];

  const readings = []; // {t: Date, ac_w, dc_w, ac_wh, dc_wh}
  const fatorSolar = (dt) => {
    const h = dt.getHours() + dt.getMinutes() / 60;
    if (h < 6 || h > 18) return 0;
    return Math.sin((Math.PI * (h - 6)) / 12);
  };
  const amostra = (dt) => {
    const dc = 1200 * fatorSolar(dt) * (0.75 + Math.random() * 0.25);
    let ac = 150 + (Math.random() * 60 - 30);
    if (Math.random() < 0.08) ac += 400 + Math.random() * 1800;
    return [Math.max(ac, 0), Math.max(dc, 0)];
  };
  // semeia 35 dias horários
  const agora = new Date();
  const t0 = new Date(agora); t0.setHours(agora.getHours() - 24 * 35, 0, 0, 0);
  for (let t = new Date(t0); t <= agora; t.setHours(t.getHours() + 1)) {
    const [ac, dc] = amostra(t);
    readings.push({ t: new Date(t), ac_w: ac, dc_w: dc, ac_wh: ac, dc_wh: dc });
  }
  setInterval(() => {
    const dt = new Date();
    const [ac, dc] = amostra(dt);
    const f = 5 / 3600;
    readings.push({ t: dt, ac_w: ac, dc_w: dc, ac_wh: ac * f, dc_wh: dc * f });
  }, 5000);

  const inicioPeriodo = (p) => {
    const d = new Date();
    if (p === "day") d.setHours(0, 0, 0, 0);
    else { d.setDate(1); d.setHours(0, 0, 0, 0); }
    return d;
  };
  const r2 = (n) => +n.toFixed(2), r3 = (n) => +n.toFixed(3);
  const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : null);

  // Mesmo cálculo de fluxos do backend (_SQL_FLUXOS).
  function fluxos(ini, fim) {
    const f = { consumo: 0, geracao: 0, autoconsumo: 0, injetada: 0, importada: 0, n: 0, primeira: null, ultima: null };
    for (const r of readings) {
      if (r.t < ini || (fim && r.t >= fim)) continue;
      const ac = r.ac_wh / 1000, dc = r.dc_wh / 1000;
      f.consumo += ac; f.geracao += dc;
      f.autoconsumo += Math.min(ac, dc);
      f.injetada += Math.max(dc - ac, 0);
      f.importada += Math.max(ac - dc, 0);
      f.n++;
      f.primeira = f.primeira || r.t.toISOString();
      f.ultima = r.t.toISOString();
    }
    return f;
  }
  const resumo = (f) => ({ consumo_kwh: r2(f.consumo), geracao_kwh: r2(f.geracao),
    importada_kwh: r2(f.importada), n_leituras: f.n, primeira_leitura: f.primeira });

  CS.MockSource = {
    async info() {
      return { unidade: "Minha residência", modo: "demonstracao", simulado: true, tarifa: TARIFA, moeda: "R$",
        proxima_leitura: null, limite_atraso_s: 60, limite_desconexao_s: 600 };
    },
    async current() {
      const r = readings[readings.length - 1];
      return { estado: "conectado", atual: true, idade_s: Math.round((Date.now() - r.t) / 1000), limite_atraso_s: 60,
        leitura: { ts: r.t.toISOString(), dispositivo: "simulador", consumo_w: +r.ac_w.toFixed(1),
          geracao_w: +r.dc_w.toFixed(1), saldo_w: +(r.dc_w - r.ac_w).toFixed(1),
          rede_importando_w: null, rede_exportando_w: null, rede_medida: false } };
    },
    async status() {
      const r = readings[readings.length - 1];
      const idade = Math.round((Date.now() - r.t) / 1000);
      return { modo: "demonstracao", estado: "conectado", ultima_transmissao: r.t.toISOString(), idade_s: idade,
        limite_atraso_s: 60, limite_desconexao_s: 600, recebimento_habilitado: false,
        dispositivos: [{ fonte: "simulador", ultima_medicao: r.t.toISOString(), ultima_recepcao: r.t.toISOString(),
          leituras: readings.length, idade_s: idade, estado: "conectado" }] };
    },
    async bill(p) {
      const ini = inicioPeriodo(p);
      const f = fluxos(ini);
      return {
        periodo: p,
        rotulo: p === "day" ? ini.toLocaleDateString("pt-BR")
          : ini.toLocaleDateString("pt-BR", { month: "2-digit", year: "numeric" }),
        inicio: ini.toISOString(),
        consumo_kwh: r2(f.consumo), geracao_kwh: r2(f.geracao), saldo_kwh: r2(f.geracao - f.consumo),
        autoconsumo_kwh: r2(f.autoconsumo), injetada_kwh: r2(f.injetada), importada_kwh: r2(f.importada),
        atendimento_pct: pct(f.autoconsumo, f.consumo), aproveitamento_pct: pct(f.autoconsumo, f.geracao),
        eficiencia_pct: f.geracao > 0 ? Math.round((f.consumo / f.geracao) * 100) : 0,
        moeda: "R$", tarifa: TARIFA,
        custo_consumo: r2(f.consumo * TARIFA), economia_solar: r2(f.geracao * TARIFA),
        custo_liquido: r2(Math.max(f.consumo - f.geracao, 0) * TARIFA),
        n_leituras: f.n, n_sem_consumo: 0, n_sem_geracao: 0, fluxo_origem: f.n ? "calculado" : "sem_dados",
        primeira_leitura: f.primeira, ultima_leitura: f.ultima,
      };
    },
    async history(p) {
      const ini = inicioPeriodo(p);
      const fmt = (d) => p === "day"
        ? String(d.getHours()).padStart(2, "0") + "h"
        : d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
      const buckets = new Map();
      for (const r of readings) {
        if (r.t < ini) continue;
        const k = fmt(r.t);
        const b = buckets.get(k) || { c: 0, g: 0, a: 0, i: 0, m: 0 };
        const ac = r.ac_wh / 1000, dc = r.dc_wh / 1000;
        b.c += ac; b.g += dc; b.a += Math.min(ac, dc); b.i += Math.max(dc - ac, 0); b.m += Math.max(ac - dc, 0);
        buckets.set(k, b);
      }
      return [...buckets.entries()].map(([rotulo, v]) => ({
        rotulo, consumo_kwh: r3(v.c), geracao_kwh: r3(v.g),
        autoconsumo_kwh: r3(v.a), injetada_kwh: r3(v.i), importada_kwh: r3(v.m) }));
    },
    async months(n = 12) {
      const porMes = new Map();
      for (const r of readings) {
        const k = r.t.getFullYear() + "-" + String(r.t.getMonth() + 1).padStart(2, "0");
        const b = porMes.get(k) || { c: 0, g: 0, a: 0, i: 0, m: 0, dias: new Set() };
        const ac = r.ac_wh / 1000, dc = r.dc_wh / 1000;
        b.c += ac; b.g += dc; b.a += Math.min(ac, dc); b.i += Math.max(dc - ac, 0); b.m += Math.max(ac - dc, 0);
        b.dias.add(r.t.toDateString());
        porMes.set(k, b);
      }
      return [...porMes.entries()].sort().slice(-n).map(([mes, v]) => {
        const [ano, m] = mes.split("-");
        return { mes, rotulo: `${MESES[+m - 1]}/${ano.slice(2)}`,
          consumo_kwh: r2(v.c), geracao_kwh: r2(v.g), autoconsumo_kwh: r2(v.a),
          injetada_kwh: r2(v.i), importada_kwh: r2(v.m), dias_com_dados: v.dias.size };
      });
    },
    async insights() {
      const agora = new Date();
      const hoje = new Date(agora); hoje.setHours(0, 0, 0, 0);
      const ateAgora = agora - hoje;
      const ant = [];
      for (let d = 1; d <= 7; d++) {
        const ini = new Date(hoje); ini.setDate(ini.getDate() - d);
        const f = fluxos(ini, new Date(ini.getTime() + ateAgora));
        if (f.n) ant.push(f.geracao);
      }
      const media = ant.length ? ant.reduce((a, b) => a + b, 0) / ant.length : null;
      const iniMes = new Date(hoje); iniMes.setDate(1);
      const iniAnt = new Date(iniMes); iniAnt.setMonth(iniAnt.getMonth() - 1);
      const mesmo = new Date(agora); mesmo.setMonth(mesmo.getMonth() - 1);
      const parcial = fluxos(iniAnt, mesmo < iniMes ? mesmo : iniMes);
      const inteiro = fluxos(iniAnt, iniMes);
      const cobre = !!parcial.primeira && new Date(parcial.primeira) <= new Date(iniAnt.getTime() + 864e5);
      return {
        geracao_hoje: { hoje_kwh: r2(fluxos(hoje).geracao),
          media_7d_mesmo_horario_kwh: media === null ? null : r2(media), dias_base: ant.length },
        mes_anterior: { rotulo: `${MESES[iniAnt.getMonth()]}/${iniAnt.getFullYear()}`,
          mesmo_periodo: resumo(parcial), mes_inteiro: resumo(inteiro), dados_completos: cobre },
      };
    },
  };
})();
