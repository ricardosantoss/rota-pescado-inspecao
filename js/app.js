// Rota do Pescado · Acesso à inspeção de pescado
// Site estático: lê data/<UF>/*.json e faz todos os cálculos no navegador.

const ESTADOS_URL = "data/estados.json";
const OSRM_ROTA = "https://router.project-osrm.org/route/v1/driving/";
const FAIXAS = [1, 2, 3, 4];
const CORES_T = ["--t0", "--t1", "--t2", "--t3", "--t4"].map((v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim());
const COR_SEM = getComputedStyle(document.documentElement).getPropertyValue("--tnone").trim();

const fmtInt = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 });
const fmt1 = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------------------------------------------------------------------------
// Estado da página
// ---------------------------------------------------------------------------
const S = {
  uf: "GO", camada: "AMBOS", T: 2, ano: 2025, fator: 1.2,
  esp: "",            // espécie escolhida ("" = todas)
  sim: [],            // códigos de municípios com unidades hipotéticas
  simulando: false,
  sel: null,          // município selecionado
  ordem: { k: "prod", dir: -1 }, busca: "",
};
let D = null;         // dados do estado carregado
let calc = null;      // resultado do último cálculo
let mapa, camadaMun, camadaProd, camadaEst, camadaSim, camadaRota;

// ---------------------------------------------------------------------------
// Carga de dados
// ---------------------------------------------------------------------------
async function carregarEstado(uf) {
  $("#carregando").hidden = false;
  const base = `data/${uf}/`;
  const [meta, muns, est, mat, geo] = await Promise.all(
    ["meta.json", "municipios.json", "estabelecimentos.json", "matriz.json", "municipios.geojson"].map((f) => fetch(base + f).then((r) => {
      if (!r.ok) throw new Error(`${f}: ${r.status}`);
      return r.json();
    })));
  const esp = await fetch(base + "especies.json").then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const N = mat.nos.length;
  const idx = new Map(mat.nos.map((c, i) => [c, i]));
  D = {
    meta, anos: muns.anos, muns: muns.municipios, est, geo, N, idx, nos: mat.nos,
    min: Int32Array.from(mat.minutos_carro), km: Int32Array.from(mat.km),
    porCod: new Map(muns.municipios.map((m) => [m.cod, m])),
    nomeNo: new Map(), // nome de nós de fora do estado
    esp,               // produção por espécie (pode faltar)
  };
  prepararEspecies();
  for (const e of est) if (!D.porCod.has(e.cod)) D.nomeNo.set(e.cod, `${e.municipio} (${e.uf})`);
  D.muns.forEach((m) => { m.i = idx.get(m.cod); });
  const rAno = $("#rng-ano");
  rAno.min = D.anos[0]; rAno.max = D.anos.at(-1);
  if (S.ano < D.anos[0] || S.ano > D.anos.at(-1)) S.ano = D.anos.at(-1);
  $("#carregando").hidden = true;
}

const nomeDe = (cod) => D.porCod.get(cod)?.nome ?? D.nomeNo.get(cod) ?? cod;
const idxEsp = () => (S.esp && D.esp ? D.esp.especies.findIndex((e) => String(e.id) === S.esp) : -1);
const serieEsp = (m, k) => D.esp?.dados[m.cod]?.[k] ?? null;
const serieProd = (m) => { const k = idxEsp(); return k < 0 ? m.prod : (serieEsp(m, k) ?? m.prod.map(() => 0)); };
const prodAno = (m, ano = S.ano) => serieProd(m)[D.anos.indexOf(ano)] ?? 0;
const nomeEspCurto = (nome) => nome.split(",")[0];
const rotProd = () => { const k = idxEsp(); return k < 0 ? "peixe criado" : nomeEspCurto(D.esp.especies[k].nome).toLowerCase(); };

function prepararEspecies() {
  const bloco = $("#bloco-especie"), sel = $("#sel-esp");
  if (!bloco || !sel) return;
  if (!D.esp) { bloco.hidden = true; S.esp = ""; return; }
  const tot = D.esp.especies.reduce((a, e) => a + e.total_ultimo_ano_t, 0);
  sel.innerHTML = `<option value="">Todas as espécies</option>` + D.esp.especies.filter((e) => e.total_ultimo_ano_t > 0 || Object.values(D.esp.dados).some((d) => d[D.esp.especies.indexOf(e)]))
    .map((e) => `<option value="${e.id}">${esc(e.nome)}${e.total_ultimo_ano_t > 0 ? ` · ${fmtPct((e.total_ultimo_ano_t / tot) * 100)}` : " · sem produção em " + D.anos.at(-1)}</option>`).join("");
  if (S.esp && !D.esp.especies.some((e) => String(e.id) === S.esp)) S.esp = "";
  sel.value = S.esp;
  bloco.hidden = false;
}
const tempoH = (i, j) => (D.min[i * D.N + j] * S.fator) / 60;

// ---------------------------------------------------------------------------
// Cálculo: rede ativa, tempo de cada município até a inspeção mais próxima, cobertura
// ---------------------------------------------------------------------------
function estAtivos(tipo = S.camada, ano = S.ano) {
  // Um estabelecimento entra se é do tipo escolhido e já existia no ano (sem data: entra sempre).
  return D.est.filter((e) => (tipo === "AMBOS" || e.tipo === tipo) && (e.desde == null || e.desde <= ano) && D.idx.has(e.cod));
}

function tempos(nosAbertos) {
  // Para cada município do estado: menor tempo (h) até um nó aberto e qual nó.
  const lista = [...nosAbertos].map((c) => D.idx.get(c));
  return D.muns.map((m) => {
    let best = Infinity, j = -1;
    for (const k of lista) {
      const t = tempoH(m.i, k);
      if (t < best) { best = t; j = k; }
    }
    return { t: best, j };
  });
}

function cobertura(ts, pesos, T) {
  let tot = 0, cob = 0;
  ts.forEach((x, k) => { tot += pesos[k]; if (x.t <= T) cob += pesos[k]; });
  return tot > 0 ? (cob / tot) * 100 : 0;
}

function tempoMedio(ts, pesos) {
  let tot = 0, s = 0;
  ts.forEach((x, k) => { if (isFinite(x.t)) { tot += pesos[k]; s += pesos[k] * x.t; } });
  return tot > 0 ? s / tot : NaN;
}

function calcular() {
  const ativos = estAtivos();
  const nosBase = new Set(ativos.map((e) => e.cod));
  const nos = new Set([...nosBase, ...S.sim]);
  const pesos = D.muns.map((m) => prodAno(m));
  const ts = tempos(nos);
  const tsBase = S.sim.length ? tempos(nosBase) : ts;
  const tsSIF = tempos(new Set(estAtivos("SIF").map((e) => e.cod)));
  const tsSIE = tempos(new Set(estAtivos("SIE").map((e) => e.cod)));
  calc = { ativos, nos, pesos, ts, tsBase, tsSIF, tsSIE };
  return calc;
}

// Sugestão gulosa: o município que, sozinho, mais aumenta a produção coberta a T horas.
function melhorProxima() {
  const { ts, pesos } = calc;
  let melhor = null, ganho = -1, desempate = Infinity;
  for (const cand of D.muns) {
    if (calc.nos.has(cand.cod)) continue;
    let g = 0, soma = 0;
    D.muns.forEach((m, k) => {
      const tNovo = tempoH(m.i, cand.i);
      if (ts[k].t > S.T && tNovo <= S.T) g += pesos[k];
      soma += pesos[k] * Math.min(ts[k].t, tNovo);
    });
    if (g > ganho + 1e-9 || (Math.abs(g - ganho) <= 1e-9 && soma < desempate)) { melhor = cand; ganho = g; desempate = soma; }
  }
  return ganho > 0 ? melhor : null;
}

// ---------------------------------------------------------------------------
// Cores e formatação
// ---------------------------------------------------------------------------
const corTempo = (t) => (!isFinite(t) ? COR_SEM : CORES_T[FAIXAS.findIndex((f) => t <= f) === -1 ? 4 : FAIXAS.findIndex((f) => t <= f)]);
const fmtH = (t) => {
  if (!isFinite(t)) return "sem rota";
  if (t < 0.02) return "no município";
  const h = Math.floor(t), min = Math.round((t - h) * 60);
  return h ? `${h} h ${String(min).padStart(2, "0")}` : `${min} min`;
};
const fmtT = (v) => {
  if (v <= 0) return "0 t";
  if (v < 1) return `${fmtInt.format(v * 1000)} kg`;
  if (v < 10) return `${fmt1.format(v)} t`;
  if (v >= 1000) return `${fmt1.format(v / 1000)} mil t`;
  return `${fmtInt.format(v)} t`;
};
const fmtPct = (x) => (x <= 0 ? "0%" : x < 0.1 ? "menos de 0,1%" : `${fmt1.format(x)}%`);
const rotCamada = { SIF: "federal (SIF)", SIE: "estadual (SIE)", AMBOS: "federal ou estadual" };

// ---------------------------------------------------------------------------
// Mapa
// ---------------------------------------------------------------------------
function iniciarMapa() {
  mapa = L.map("mapa", { zoomControl: true, preferCanvas: false, attributionControl: true });
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 12, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(mapa);
  camadaMun = L.geoJSON(null, {
    style: () => ({ weight: 0.6, color: "#ffffff", fillOpacity: 0.78 }),
    onEachFeature: (f, lyr) => {
      lyr.on("click", () => clicarMunicipio(f.properties.cod));
      lyr.on("mouseover", () => lyr.setStyle({ weight: 2, color: "#1d2422" }));
      lyr.on("mouseout", () => lyr.setStyle({ weight: S.sel === f.properties.cod ? 2.5 : 0.6, color: S.sel === f.properties.cod ? "#1d2422" : "#ffffff" }));
    },
  }).addTo(mapa);
  camadaProd = L.layerGroup().addTo(mapa);
  camadaEst = L.layerGroup().addTo(mapa);
  camadaSim = L.layerGroup().addTo(mapa);
  camadaRota = L.layerGroup().addTo(mapa);
}

function desenharMalha() {
  camadaMun.clearLayers();
  camadaMun.addData(D.geo);
  mapa.fitBounds(camadaMun.getBounds(), { padding: [10, 10] });
}

function atualizarMapa() {
  const tPorCod = new Map(D.muns.map((m, k) => [m.cod, calc.ts[k].t]));
  camadaMun.eachLayer((lyr) => {
    const cod = lyr.feature.properties.cod;
    const t = tPorCod.get(cod);
    const m = D.porCod.get(cod);
    lyr.setStyle({ fillColor: corTempo(t), weight: S.sel === cod ? 2.5 : 0.6, color: S.sel === cod ? "#1d2422" : "#ffffff" });
    lyr.unbindTooltip();
    if (m) lyr.bindTooltip(`<b>${esc(m.nome)}</b><br>${fmtT(prodAno(m))} de ${rotProd()} em ${S.ano}<br>${fmtH(t)} até a inspeção ${rotCamada[S.camada]}`, { sticky: true, className: "tt" });
  });

  // círculos de produção
  camadaProd.clearLayers();
  const pmax = Math.max(...D.muns.map((m) => prodAno(m)), 1);
  D.muns.filter((m) => prodAno(m) > 0).sort((a, b) => prodAno(b) - prodAno(a)).forEach((m) => {
    L.circleMarker([m.lat, m.lon], { radius: 2 + 22 * Math.sqrt(prodAno(m) / pmax), color: "#1d2422", weight: 1.2, fill: false, interactive: false }).addTo(camadaProd);
  });

  // estabelecimentos (um marcador por município e tipo)
  camadaEst.clearLayers();
  const grupos = new Map();
  for (const e of calc.ativos) {
    const k = `${e.tipo}|${e.cod}`;
    if (!grupos.has(k)) grupos.set(k, []);
    grupos.get(k).push(e);
  }
  for (const [k, lista] of grupos) {
    const [tipo, cod] = k.split("|");
    const p = posicao(cod);
    if (!p) continue;
    const off = tipo === "SIE" && grupos.has(`SIF|${cod}`) ? 0.06 : 0;
    const ic = L.divIcon({ className: "", html: `<div class="icone-est ${tipo.toLowerCase()}" style="width:${tipo === "SIF" ? 16 : 18}px;height:${tipo === "SIF" ? 16 : 18}px"><span>${lista.length > 1 ? lista.length : ""}</span></div>`, iconSize: [18, 18], iconAnchor: [9, 9] });
    const linhas = lista.map((e) => `<div style="margin-top:4px"><b>${tipo} ${esc(e.numero)}</b> · ${esc(e.nome)}${e.avisos.length ? `<br><i style="color:#a1461a">${esc(e.avisos.join("; "))}</i>` : ""}</div>`).join("");
    L.marker([p[0], p[1] + off], { icon: ic, keyboard: false, zIndexOffset: tipo === "SIF" ? 600 : 500 })
      .bindTooltip(`<b>${esc(nomeDe(cod))}</b> · ${lista.length} com ${tipo}${linhas}`, { className: "tt", direction: "top" })
      .on("click", () => D.porCod.has(cod) && clicarMunicipio(cod))
      .addTo(camadaEst);
  }

  // unidades hipotéticas
  camadaSim.clearLayers();
  S.sim.forEach((cod, n) => {
    const p = posicao(cod);
    const ic = L.divIcon({ className: "", html: `<div class="icone-est sim" style="width:22px;height:22px">${n + 1}</div>`, iconSize: [22, 22], iconAnchor: [11, 11] });
    L.marker(p, { icon: ic, zIndexOffset: 900 }).bindTooltip(`Unidade hipotética ${n + 1}: ${esc(nomeDe(cod))}`, { className: "tt" })
      .on("click", () => clicarMunicipio(cod)).addTo(camadaSim);
  });
}

function posicao(cod) {
  const m = D.porCod.get(cod);
  if (m) return [m.lat, m.lon];
  const e = D.extPos?.get(cod);
  return e ?? null;
}

function desenharLegenda() {
  const esc4 = CORES_T.map((c) => `<span style="background:${c}"></span>`).join("");
  $("#legenda").innerHTML = `
    <b>Tempo até a inspeção ${rotCamada[S.camada]}</b>
    <div class="esc">${esc4}</div>
    <div class="esc-rot"><span>0</span><span>1 h</span><span>2 h</span><span>3 h</span><span>4 h+</span></div>
    <div class="itens">
      ${S.camada !== "SIE" ? '<div class="item"><span class="marc-leg sif"></span> estabelecimento com SIF (federal)</div>' : ""}
      ${S.camada !== "SIF" ? '<div class="item"><span class="marc-leg sie"></span> estabelecimento com SIE (estadual)</div>' : ""}
      ${S.sim.length ? '<div class="item"><span class="marc-leg sim"></span> unidade hipotética</div>' : ""}
      <div class="item"><span class="marc-leg prod"></span> produção de ${rotProd()} em ${S.ano}</div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Painel lateral: KPIs e curva
// ---------------------------------------------------------------------------
function atualizarKPIs() {
  const { ts, tsBase, pesos } = calc;
  const cob = cobertura(ts, pesos, S.T);
  $("#kpi-cob").textContent = `${fmt1.format(cob)}%`;
  $("#kpi-cob-rot").textContent = `da produção de ${rotProd()} de ${S.ano} a até ${fmtH(S.T).replace(" 00", "")} de uma inspeção ${rotCamada[S.camada]}`;
  if (S.sim.length) {
    const d = cob - cobertura(tsBase, pesos, S.T);
    $("#kpi-cob-delta").textContent = `${d >= 0 ? "+" : ""}${fmt1.format(d)} pontos com ${S.sim.length} unidade${S.sim.length > 1 ? "s" : ""} hipotética${S.sim.length > 1 ? "s" : ""}`;
  } else $("#kpi-cob-delta").textContent = "";
  $("#kpi-tmed").textContent = fmtH(tempoMedio(ts, pesos));
  let desc = 0;
  ts.forEach((x, k) => { if (x.t > S.T) desc += pesos[k]; });
  $("#kpi-desc").textContent = fmtT(desc);
  $("#kpi-desc-rot").textContent = `de ${rotProd()} a mais de ${fmtH(S.T).replace(" 00", "")} da inspeção`;
  const nSIF = calc.ativos.filter((e) => e.tipo === "SIF").length, nSIE = calc.ativos.filter((e) => e.tipo === "SIE").length;
  $("#kpi-est").textContent = fmtInt.format(calc.ativos.length);
  $("#kpi-est").title = `${nSIF} com SIF, ${nSIE} com SIE`;
  const ajuda = {
    SIF: "Inspeção federal: permite vender para todo o Brasil e exportar. Inclui SIF de estados vizinhos.",
    SIE: "Inspeção estadual (Agrodefesa): permite vender só dentro do estado.",
    AMBOS: "Qualquer inspeção, federal ou estadual: o acesso a algum frigorífico inspecionado.",
  };
  $("#ajuda-camada").textContent = ajuda[S.camada];
}

function desenharCurva() {
  const W = 290, H = 150, x0 = 30, y0 = 10, x1 = W - 8, y1 = H - 22, Tmax = 8;
  const X = (t) => x0 + (t / Tmax) * (x1 - x0), Y = (p) => y1 - (p / 100) * (y1 - y0);
  const serie = (ts) => Array.from({ length: 81 }, (_, k) => { const t = (k / 80) * Tmax; return [t, cobertura(ts, calc.pesos, t)]; });
  const caminho = (pts) => pts.map(([t, p], k) => `${k ? "L" : "M"}${X(t).toFixed(1)},${Y(p).toFixed(1)}`).join("");
  const linhas = [];
  if (S.camada === "AMBOS") linhas.push({ pts: serie(calc.tsSIF), cor: "#9aa6a2", tr: "4 3", rot: "só SIF" });
  if (S.sim.length) linhas.push({ pts: serie(calc.tsBase), cor: "#9aa6a2", tr: "2 2", rot: "sem simulação" });
  linhas.push({ pts: serie(calc.ts), cor: getComputedStyle(document.documentElement).getPropertyValue("--primaria"), tr: "", rot: "" });
  const cobT = cobertura(calc.ts, calc.pesos, S.T);
  let g = "";
  for (const p of [0, 50, 100]) g += `<line x1="${x0}" x2="${x1}" y1="${Y(p)}" y2="${Y(p)}" stroke="#e3e6e1"/><text x="${x0 - 4}" y="${Y(p) + 3}" text-anchor="end">${p}%</text>`;
  for (const t of [0, 2, 4, 6, 8]) g += `<text x="${X(t)}" y="${H - 6}" text-anchor="middle">${t} h</text>`;
  g += `<line x1="${X(S.T)}" x2="${X(S.T)}" y1="${y0}" y2="${y1}" stroke="#1d2422" stroke-dasharray="3 3"/>`;
  for (const l of linhas) g += `<path d="${caminho(l.pts)}" fill="none" stroke="${l.cor}" stroke-width="${l.tr ? 1.4 : 2.2}" stroke-dasharray="${l.tr}"/>`;
  g += `<circle cx="${X(S.T)}" cy="${Y(cobT)}" r="3.5" fill="${linhas.at(-1).cor}"/><text x="${X(S.T) + 6}" y="${Math.max(Y(cobT) - 6, 12)}" style="font-weight:600;fill:#1d2422">${fmt1.format(cobT)}%</text>`;
  const legs = linhas.filter((l) => l.rot).map((l, k) => `<text x="${x1}" y="${y1 - 6 - k * 12}" text-anchor="end">— ${l.rot}</text>`).join("");
  $("#curva").innerHTML = `<svg viewBox="0 0 ${W} ${H}">${g}${legs}</svg>`;
}

// ---------------------------------------------------------------------------
// Ficha do município
// ---------------------------------------------------------------------------
function clicarMunicipio(cod) {
  if (S.simulando && D.porCod.has(cod)) {
    const k = S.sim.indexOf(cod);
    if (k >= 0) S.sim.splice(k, 1); else S.sim.push(cod);
  }
  S.sel = cod;
  tudo();
}

function sparkline(m) {
  const W = 320, H = 70, x0 = 4, x1 = W - 4, y0 = 8, y1 = H - 16;
  const v = serieProd(m), vmax = Math.max(...v, 0.001);
  const X = (k) => x0 + (k / (v.length - 1)) * (x1 - x0), Y = (p) => y1 - (p / vmax) * (y1 - y0);
  const d = v.map((p, k) => `${k ? "L" : "M"}${X(k).toFixed(1)},${Y(p).toFixed(1)}`).join("");
  const ks = D.anos.indexOf(S.ano);
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Produção de ${esc(m.nome)}, ${D.anos[0]} a ${D.anos.at(-1)}">
    <path d="${d}" fill="none" stroke="var(--primaria)" stroke-width="2"/>
    <circle cx="${X(ks)}" cy="${Y(v[ks])}" r="4" fill="var(--primaria)"/>
    <text x="${x0}" y="${H - 2}" font-size="10" fill="#5e6b67">${D.anos[0]}: ${fmtT(v[0])}</text>
    <text x="${x1}" y="${H - 2}" font-size="10" fill="#5e6b67" text-anchor="end">${D.anos.at(-1)}: ${fmtT(v.at(-1))}</text></svg>`;
}

function especiesDoAno(m) {
  if (!D.esp || !D.esp.dados[m.cod]) return [];
  const a = D.anos.indexOf(S.ano);
  return Object.entries(D.esp.dados[m.cod]).map(([k, serie]) => ({ k: +k, e: D.esp.especies[+k], t: serie[a] }))
    .filter((x) => x.t > 0).sort((x, y) => y.t - x.t);
}

function principal(m) {
  const l = especiesDoAno(m);
  if (!l.length) return D.esp ? "—" : (m.tilapia ? `Tilápia ${fmtInt.format(m.tilapia * 100)}%` : "—");
  const tot = l.reduce((s, x) => s + x.t, 0);
  return `${esc(nomeEspCurto(l[0].e.nome))} <span style="font-weight:500;color:var(--suave)">${fmtInt.format((l[0].t / tot) * 100)}%</span>`;
}

function listaEspecies(m) {
  if (!D.esp) return "";
  const l = especiesDoAno(m);
  if (!l.length) return `<h4>Espécies criadas (${S.ano})</h4><p class="especies zero">A PPM não registra produção de peixe criado aqui em ${S.ano}.</p>`;
  const tot = l.reduce((s, x) => s + x.t, 0), max = l[0].t, kSel = idxEsp();
  return `<h4>Espécies criadas (${S.ano})</h4><ul class="especies">${l.map((x) => `
    <li class="${x.k === kSel ? "atual" : ""}" title="${esc(x.e.nome)}"><span>${esc(x.e.nome)}</span><span class="q">${fmtT(x.t)} · ${fmtPct((x.t / tot) * 100)}</span>
      <span class="barra"><span style="width:${Math.max(2, (x.t / max) * 100).toFixed(1)}%"></span></span></li>`).join("")}</ul>`;
}

function maisProximo(m, tipo) {
  const ests = estAtivos(tipo);
  let best = null;
  for (const e of ests) {
    const t = tempoH(m.i, D.idx.get(e.cod));
    if (!best || t < best.t) best = { t, km: D.km[m.i * D.N + D.idx.get(e.cod)], cod: e.cod, est: ests.filter((x) => x.cod === e.cod) };
  }
  return best;
}

function cartao(tipo, x) {
  if (!x) return `<div class="cartao"><div class="tipo ${tipo.toLowerCase()}">${tipo}</div><div class="tempo">—</div><div class="onde">nenhum em ${S.ano}</div></div>`;
  return `<div class="cartao"><div class="tipo ${tipo.toLowerCase()}">${tipo} MAIS PRÓXIMO</div>
    <div class="tempo${x.t < 0.02 ? " aqui" : ""}">${x.t < 0.02 ? "no próprio município" : fmtH(x.t)}</div>
    <div class="onde">${esc(nomeDe(x.cod))}${x.km ? ` · ${fmtInt.format(x.km)} km` : ""}</div></div>`;
}

function desenharFicha() {
  const ficha = $("#ficha");
  if (!S.sel || !D.porCod.has(S.sel)) { ficha.hidden = true; return; }
  const m = D.porCod.get(S.sel);
  const k = D.muns.indexOf(m);
  const p = prodAno(m), tot = calc.pesos.reduce((a, b) => a + b, 0);
  const sif = maisProximo(m, "SIF"), sie = maisProximo(m, "SIE");

  // 6 estabelecimentos mais próximos (qualquer tipo ativo) + hipotéticos
  const cands = [...calc.ativos.map((e) => ({ ...e, sim: false })), ...S.sim.map((c) => ({ tipo: "SIM", cod: c, nome: "Unidade hipotética", numero: "", avisos: [], sim: true }))]
    .map((e) => ({ ...e, t: tempoH(m.i, D.idx.get(e.cod)), km: D.km[m.i * D.N + D.idx.get(e.cod)] }))
    .sort((a, b) => a.t - b.t).slice(0, 6);
  const lista = cands.map((e, n) => `<li>
      <span class="selo ${e.tipo.toLowerCase()}">${e.tipo === "SIM" ? "HIP." : e.tipo}</span>
      <div><div class="nome">${esc(e.nome)}</div>
        <div class="det">${e.numero ? `${e.tipo} ${esc(e.numero)} · ` : ""}${esc(nomeDe(e.cod))}${e.desde ? ` · desde ${e.desde}` : ""}</div>
        ${e.avisos?.length ? `<div class="aviso">${esc(e.avisos.join("; "))}</div>` : ""}</div>
      <div class="dir"><b>${fmtH(e.t)}</b><div class="det">${e.km ? `${fmtInt.format(e.km)} km` : ""}</div>
        ${e.cod !== m.cod ? `<button class="btn-texto" data-rota="${e.cod}">ver rota</button>` : ""}</div></li>`).join("");

  const t = calc.ts[k].t;
  const classe = t <= S.T ? `dentro do limite de ${fmtH(S.T).replace(" 00", "")}` : `fora do limite de ${fmtH(S.T).replace(" 00", "")}`;
  $("#ficha-conteudo").innerHTML = `
    <h3>${esc(m.nome)}</h3>
    <div class="sub">${esc(m.regiao)}${m.reservatorio ? ` · reservatório ${esc(m.reservatorio)} (${m.cessoes} cess${m.cessoes > 1 ? "ões" : "ão"} em águas da União)` : ""}</div>
    <div class="grade">
      <div><span>${S.esp ? esc(nomeEspCurto(D.esp.especies[idxEsp()].nome)) : "Peixe criado"} em ${S.ano}</span><b>${fmtT(p)}</b></div>
      <div><span>Parte do estado</span><b>${tot ? fmtPct((p / tot) * 100) : "0%"}</b></div>
      <div><span>Espécie principal (${S.ano})</span><b>${principal(m)}</b></div>
      <div><span>Pescadores registrados</span><b>${fmtInt.format(m.pescadores)}</b></div>
    </div>
    <div class="spark">${sparkline(m)}</div>
    ${listaEspecies(m)}
    <h4>Inspeção mais próxima (${S.ano})</h4>
    <div class="mais-prox">${cartao("SIF", sif)}${cartao("SIE", sie)}</div>
    <p class="nota">Na camada escolhida (${rotCamada[S.camada]}${S.sim.length ? " + hipotéticas" : ""}): <b>${fmtH(t)}</b>, ${classe}.</p>
    <h4>Estabelecimentos mais perto</h4>
    <ul class="lista-est">${lista}</ul>
    <p class="nota">Tempos de caminhão (carro do OSRM × ${fmt1.format(S.fator)}) entre as sedes municipais. "Ver rota" desenha o caminho pela estrada no mapa.</p>
    ${S.simulando ? `<p class="nota"><b>Simulador ativo:</b> clicar de novo neste município ${S.sim.includes(m.cod) ? "remove" : "coloca"} uma unidade hipotética.</p>` : ""}`;
  ficha.hidden = false;
  ficha.querySelectorAll("[data-rota]").forEach((b) => b.addEventListener("click", () => tracarRota(m.cod, b.dataset.rota)));
}

async function tracarRota(de, para) {
  camadaRota.clearLayers();
  const a = posicao(de), b = posicao(para);
  if (!a || !b) return;
  try {
    const r = await fetch(`${OSRM_ROTA}${a[1]},${a[0]};${b[1]},${b[0]}?overview=full&geometries=geojson`).then((x) => x.json());
    if (r.code !== "Ok") throw new Error(r.code);
    const linha = L.geoJSON(r.routes[0].geometry, { style: { color: "#1f6f8b", weight: 4, opacity: 0.9 } }).addTo(camadaRota);
    mapa.fitBounds(linha.getBounds(), { padding: [40, 40], maxZoom: 9 });
  } catch (e) {
    const linha = L.polyline([a, b], { color: "#1f6f8b", weight: 3, dashArray: "6 6" }).bindTooltip("Rota indisponível agora: linha reta", { className: "tt" }).addTo(camadaRota);
    mapa.fitBounds(linha.getBounds(), { padding: [40, 40], maxZoom: 9 });
  }
}

// ---------------------------------------------------------------------------
// Simulador
// ---------------------------------------------------------------------------
function desenharSim() {
  $("#lista-sim").innerHTML = S.sim.map((c, n) => `<li>${esc(nomeDe(c))}<button aria-label="Remover" data-rm="${n}">×</button></li>`).join("");
  $("#lista-sim").querySelectorAll("[data-rm]").forEach((b) => b.addEventListener("click", () => { S.sim.splice(+b.dataset.rm, 1); tudo(); }));
  document.body.classList.toggle("simulando", S.simulando);
  $("#chk-sim").checked = S.simulando;
}

// ---------------------------------------------------------------------------
// Tabela
// ---------------------------------------------------------------------------
function pilula(t) {
  const c = corTempo(t);
  const claro = c === CORES_T[1] || c === CORES_T[2] || c === COR_SEM;
  return `<span class="pilula" style="background:${c};color:${claro ? "#1d2422" : "#fff"}">${fmtH(t)}</span>`;
}

function linhasTabela() {
  return D.muns.map((m, k) => ({ m, nome: m.nome, regiao: m.regiao, prod: prodAno(m), tSIF: calc.tsSIF[k].t, tSIE: calc.tsSIE[k].t, t: calc.ts[k].t }))
    .filter((r) => r.prod > 0 || r.m.cod === S.sel)
    .filter((r) => !S.busca || r.nome.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").includes(S.busca));
}

function desenharTabela() {
  const { k, dir } = S.ordem;
  const rows = linhasTabela().sort((a, b) => (typeof a[k] === "string" ? a[k].localeCompare(b[k], "pt") : a[k] - b[k]) * dir);
  $("#tabela tbody").innerHTML = rows.map((r) => `<tr data-cod="${r.m.cod}" class="${r.m.cod === S.sel ? "sel" : ""}">
    <td>${esc(r.nome)}</td><td>${esc(r.regiao)}</td><td class="n">${r.prod < 1 && r.prod > 0 ? fmtT(r.prod) : fmtInt.format(r.prod)}</td>
    <td class="n">${pilula(r.tSIF)}</td><td class="n">${pilula(r.tSIE)}</td><td class="n">${pilula(r.t)}</td></tr>`).join("");
  document.querySelectorAll("#tabela th").forEach((th) => th.classList.toggle("ord-asc", th.dataset.k === k && dir > 0));
  document.querySelectorAll("#tabela th").forEach((th) => th.classList.toggle("ord-desc", th.dataset.k === k && dir < 0));
  $("#tabela").querySelector("thead th[data-k=prod]").textContent = S.esp ? `${nomeEspCurto(D.esp.especies[idxEsp()].nome)} (t)` : "Produção (t)";
  $("#tabela").querySelector("thead th:last-child").textContent = `até a inspeção (${S.camada === "AMBOS" ? "qualquer" : S.camada}${S.sim.length ? " + hip." : ""})`;
}

function baixarCSV() {
  const cab = ["codigo_ibge", "municipio", "regiao_imediata", `producao_t_${S.ano}${S.esp ? "_" + nomeEspCurto(D.esp.especies[idxEsp()].nome).toLowerCase() : ""}`, "horas_ate_SIF", "horas_ate_SIE", "horas_ate_inspecao_camada", "camada", "fator_caminhao"];
  const linhas = D.muns.map((m, k) => [m.cod, m.nome, m.regiao, prodAno(m).toFixed(2), calc.tsSIF[k].t.toFixed(2), calc.tsSIE[k].t.toFixed(2), calc.ts[k].t.toFixed(2), S.camada, S.fator]);
  const csv = [cab, ...linhas].map((l) => l.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(";")).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
  a.download = `acesso_inspecao_${S.uf}_${S.ano}_${S.camada}${S.esp ? "_especie" + S.esp : ""}.csv`;
  a.click();
}

// ---------------------------------------------------------------------------
// "Sobre os dados"
// ---------------------------------------------------------------------------
function desenharSobre() {
  const f = D.meta.fontes.map((x) => `<tr><td>${esc(x.dado)}</td><td>${x.url ? `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.fonte)}</a>` : esc(x.fonte)}</td></tr>`).join("");
  $("#sobre-conteudo").innerHTML = `
    <h3>Sobre os dados e o método</h3>
    <p>O mapa mostra quanto tempo de estrada separa cada município do estabelecimento de pescado inspecionado mais próximo, e quanto da produção de peixe criado (PPM/IBGE) fica a até um limite de horas. Tudo é calculado no seu navegador a partir de dados públicos.</p>
    <h4>Inspeção federal e estadual</h4>
    <p>O <b>SIF</b> (Serviço de Inspeção Federal, MAPA) permite vender para todo o país e exportar. O <b>SIE</b> (Agrodefesa, em Goiás) permite vender só dentro do estado, salvo adesão ao SISBI-POA. A inspeção municipal (SIM) não está incluída.</p>
    <h4>Como o tempo é calculado</h4>
    <ul>
      <li>Cada município é representado pela sua sede. Os tempos entre sedes vêm do OSRM sobre o mapa do OpenStreetMap (${fmt1.format(D.meta.pct_pares_osrm)}% dos pares com rota), multiplicados pelo fator de caminhão escolhido.</li>
      <li>SIF de outros estados a até 250 km entram na conta: para alguns municípios goianos, o SIF mais próximo fica no DF ou no Mato Grosso do Sul.</li>
      <li>"Ver rota" consulta o OSRM na hora só para desenhar o caminho; o tempo mostrado é o da matriz.</li>
    </ul>
    <h4>Linha do tempo</h4>
    <p>A produção é a de cada ano da PPM. Um estabelecimento entra no mapa a partir do ano em que foi registrado: no SIE, o ano vem do número (ex.: 1490/<b>15</b> = 2015); no SIF, da data de reserva do número no SIGSIF, a mais antiga disponível. Estabelecimentos sem data entram em todos os anos. Fechamentos passados não aparecem, porque os cadastros só listam quem está ativo hoje.</p>
    <h4>Espécies</h4>
    <p>A produção por espécie é a da PPM/IBGE (tabela 3940), que agrupa algumas espécies: por exemplo, "Pintado, cachara, cachapira e pintachara, surubim" e "Pacu e patinga" (onde costuma entrar o pacu-caranha). Ao escolher uma espécie, o mapa, os números, a curva e a tabela passam a usar só a produção dela.</p>
    <h4>Simulador</h4>
    <p>As unidades hipotéticas funcionam como um estabelecimento inspecionado na sede do município. "Sugerir" escolhe, entre todos os municípios, o que sozinho mais aumenta a produção coberta no limite escolhido (heurística gulosa do problema de máxima cobertura). É um ponto de partida para discussão, não um estudo de viabilidade.</p>
    <h4>Cuidados</h4>
    <ul>
      <li>Alguns estabelecimentos estão em recuperação judicial e podem não estar operando; aparecem marcados.</li>
      <li>A categoria "pescado" do SIF inclui ranários (abate de rãs), também marcados.</li>
      <li>A PPM mede a produção declarada da aquicultura; não inclui a pesca de captura.</li>
    </ul>
    <h4>Fontes</h4>
    <table>${f}</table>
    <p class="nota">Dados gerados em ${esc(D.meta.gerado_em)}. Código aberto: o repositório traz o script que regenera os dados.</p>`;
}

// ---------------------------------------------------------------------------
// Link compartilhável (#uf=GO&camada=SIE&T=2&ano=2025&mun=...&sim=...)
// ---------------------------------------------------------------------------
function lerHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.get("uf")) S.uf = h.get("uf");
  if (["SIF", "SIE", "AMBOS"].includes(h.get("camada"))) S.camada = h.get("camada");
  if (+h.get("T")) S.T = +h.get("T");
  if (+h.get("ano")) S.ano = +h.get("ano");
  if (+h.get("fator")) S.fator = +h.get("fator");
  if (h.get("mun")) S.sel = h.get("mun");
  if (h.get("sim")) S.sim = h.get("sim").split(",").filter(Boolean);
  if (h.get("esp")) S.esp = h.get("esp");
}
function gravarHash() {
  const h = new URLSearchParams({ uf: S.uf, camada: S.camada, T: S.T, ano: S.ano, fator: S.fator });
  if (S.sel) h.set("mun", S.sel);
  if (S.sim.length) h.set("sim", S.sim.join(","));
  if (S.esp) h.set("esp", S.esp);
  history.replaceState(null, "", `#${h}`);
}

// ---------------------------------------------------------------------------
// Orquestração
// ---------------------------------------------------------------------------
function sincronizarControles() {
  document.querySelectorAll("#seg-camada button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.v === S.camada)));
  $("#rng-T").value = S.T; $("#out-T").textContent = fmtH(S.T).replace(" 00", "");
  $("#rng-ano").value = S.ano; $("#out-ano").textContent = S.ano;
  $("#sel-fator").value = S.fator.toFixed(1);
  if ($("#sel-esp")) $("#sel-esp").value = S.esp;
  $("#sim-ajuda").textContent = S.simulando
    ? "Clique em municípios do mapa para pôr ou tirar unidades hipotéticas."
    : "Ative e clique em municípios do mapa para instalar unidades de inspeção hipotéticas. A cobertura é recalculada na hora.";
}

function tudo() {
  calcular();
  sincronizarControles();
  atualizarMapa();
  desenharLegenda();
  atualizarKPIs();
  desenharCurva();
  desenharSim();
  desenharFicha();
  desenharTabela();
  gravarHash();
}

let timerPlay = null;
function alternarPlay() {
  if (timerPlay) { clearInterval(timerPlay); timerPlay = null; $("#btn-play").textContent = "▶"; return; }
  $("#btn-play").textContent = "❚❚";
  if (S.ano >= D.anos.at(-1)) S.ano = D.anos[0];
  tudo();
  timerPlay = setInterval(() => {
    if (S.ano >= D.anos.at(-1)) { alternarPlay(); return; }
    S.ano += 1; tudo();
  }, 900);
}

function ligarControles() {
  document.querySelectorAll("#seg-camada button").forEach((b) => b.addEventListener("click", () => { S.camada = b.dataset.v; tudo(); }));
  $("#rng-T").addEventListener("input", (e) => { S.T = +e.target.value; tudo(); });
  $("#rng-ano").addEventListener("input", (e) => { S.ano = +e.target.value; tudo(); });
  $("#sel-fator").addEventListener("change", (e) => { S.fator = +e.target.value; tudo(); });
  $("#btn-play").addEventListener("click", alternarPlay);
  $("#sel-esp")?.addEventListener("change", (e) => { S.esp = e.target.value; tudo(); });
  $("#chk-sim").addEventListener("change", (e) => { S.simulando = e.target.checked; tudo(); });
  $("#btn-sugerir").addEventListener("click", () => {
    const m = melhorProxima();
    if (!m) { $("#sim-ajuda").textContent = "Nenhum município aumenta a cobertura nesse limite: toda a produção alcançável já está coberta."; return; }
    S.sim.push(m.cod); S.sel = m.cod; tudo();
  });
  $("#btn-limpar").addEventListener("click", () => { S.sim = []; camadaRota.clearLayers(); tudo(); });
  $("#btn-fechar").addEventListener("click", () => { S.sel = null; camadaRota.clearLayers(); tudo(); });
  $("#busca").addEventListener("input", (e) => { S.busca = e.target.value.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, ""); desenharTabela(); });
  $("#tabela thead").addEventListener("click", (e) => {
    const k = e.target.closest("th")?.dataset.k;
    if (!k) return;
    S.ordem = { k, dir: S.ordem.k === k ? -S.ordem.dir : (k === "nome" || k === "regiao" ? 1 : -1) };
    desenharTabela();
  });
  $("#tabela tbody").addEventListener("click", (e) => {
    const cod = e.target.closest("tr")?.dataset.cod;
    if (!cod) return;
    S.sel = cod; tudo();
    const m = D.porCod.get(cod);
    mapa.setView([m.lat, m.lon], 8);
    $("#mapa").scrollIntoView({ behavior: "smooth", block: "center" });
  });
  $("#btn-csv").addEventListener("click", baixarCSV);
  const abrirSobre = (e) => { e?.preventDefault(); $("#dlg-sobre").showModal(); };
  $("#btn-sobre").addEventListener("click", abrirSobre);
  $("#link-sobre").addEventListener("click", abrirSobre);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && S.sel && !$("#dlg-sobre").open) { S.sel = null; tudo(); } });
}

async function iniciar() {
  lerHash();
  const estados = await fetch(ESTADOS_URL).then((r) => r.json());
  $("#estado").innerHTML = estados.map((e) => `<option value="${e.uf}" ${e.ativo ? "" : "disabled"}>${esc(e.nome)}${e.ativo ? "" : " (em breve)"}</option>`).join("");
  if (!estados.find((e) => e.uf === S.uf && e.ativo)) S.uf = estados.find((e) => e.ativo).uf;
  $("#estado").value = S.uf;
  $("#estado").addEventListener("change", async (e) => {
    S.uf = e.target.value; S.sim = []; S.sel = null;
    await carregarEstado(S.uf); prepararExternos(); desenharMalha(); desenharSobre(); tudo();
  });
  iniciarMapa();
  ligarControles();
  try {
    await carregarEstado(S.uf);
  } catch (err) {
    $("#carregando").textContent = `Não foi possível carregar os dados (${err.message}).`;
    return;
  }
  prepararExternos();
  desenharMalha();
  desenharSobre();
  tudo();
  if (S.sel && D.porCod.has(S.sel)) { const m = D.porCod.get(S.sel); mapa.setView([m.lat, m.lon], 7); }
}

// posições dos municípios de fora do estado que têm SIF (vêm no arquivo de estabelecimentos via meta)
function prepararExternos() {
  D.extPos = new Map((D.meta.nos_externos || []).map((n) => [n.cod, [n.lat, n.lon]]));
}

iniciar();

