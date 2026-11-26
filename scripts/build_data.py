"""
Gera os arquivos JSON que o site lê, a partir dos insumos do projeto.

Uso (na raiz do repositório):
    pip install pandas geopandas shapely
    python scripts/build_data.py GO

Entradas (pasta insumos/):
    insumos/municipios_brasileiros.csv          coordenadas das sedes (base aberta kelvins/municipios-brasileiros)
    insumos/sif_pescado_brasil.json             estabelecimentos de pescado com SIF ativo (MAPA/SIGSIF, extraído em 24/11/2026)
    insumos/<UF>/municipios_geodata_br.json     malha municipal (geodata-br, a partir do IBGE)
    insumos/<UF>/matriz_tempos_carro.csv        matriz de tempos (OSRM/OpenStreetMap), saída do notebook do artigo
    insumos/<UF>/base_municipal_2025.csv        base municipal (PPM 2025 etc.), saída do notebook do artigo
    insumos/<UF>/ppm_peixes_2015_2024.csv       série da PPM (peixes, t) por município
    insumos/<UF>/sie_pescado_agrodefesa.csv     estabelecimentos de pescado com inspeção estadual (consulta LAI da Agrodefesa)

Saídas (pasta data/<UF>/): municipios.geojson, municipios.json, estabelecimentos.json, matriz.json, meta.json
Para outro estado, crie insumos/<UF>/ com os mesmos arquivos e rode o script com a sigla.
"""
import json
import re
import sys
import unicodedata
from pathlib import Path

import numpy as np
import pandas as pd

UF = (sys.argv[1] if len(sys.argv) > 1 else "GO").upper()
RAIZ = Path(__file__).resolve().parent.parent
INS, INS_UF, OUT = RAIZ / "insumos", RAIZ / "insumos" / UF, RAIZ / "data" / UF
OUT.mkdir(parents=True, exist_ok=True)

COD_UF = {"RO": 11, "AC": 12, "AM": 13, "RR": 14, "PA": 15, "AP": 16, "TO": 17, "MA": 21, "PI": 22, "CE": 23, "RN": 24,
          "PB": 25, "PE": 26, "AL": 27, "SE": 28, "BA": 29, "MG": 31, "ES": 32, "RJ": 33, "SP": 35, "PR": 41, "SC": 42,
          "RS": 43, "MS": 50, "MT": 51, "GO": 52, "DF": 53}
SIGLA = {v: k for k, v in COD_UF.items()}

# Cessões em águas da União (MPA), tabulação da equipe (notebook v4, 21/11/2026). Só Goiás por enquanto.
CESSOES = {"GO": {"Inaciolândia": (11, "São Simão"), "Minaçu": (9, "Cana Brava"), "Niquelândia": (9, "Serra da Mesa"),
                  "Quirinópolis": (4, "São Simão"), "Corumbaíba": (3, "Itumbiara"), "Gouvelândia": (3, "São Simão"),
                  "Itumbiara": (3, "Cachoeira Dourada, Itumbiara"), "Paranaiguara": (3, "São Simão"),
                  "Buriti Alegre": (2, "Itumbiara"), "Uruaçu": (2, "Serra da Mesa"), "Cavalcante": (1, "Cana Brava"),
                  "Cristalina": (1, "Queimado"), "Três Ranchos": (1, "Emborcação")}}


def norm(v):
    t = unicodedata.normalize("NFKD", str(v))
    t = "".join(c for c in t if not unicodedata.combining(c))
    return re.sub(r"[^a-zA-Z0-9]+", "_", t).strip("_").lower()


# ---------------------------------------------------------------------------
# Coordenadas
# ---------------------------------------------------------------------------
kel = pd.read_csv(INS / "municipios_brasileiros.csv")
kel["cod"] = kel["codigo_ibge"].astype(str)
kel["uf"] = kel["codigo_uf"].map(SIGLA)
kel["n"] = kel["nome"].map(norm)
pos = kel.set_index("cod")[["nome", "uf", "latitude", "longitude"]]
cod_por_nome = {(r.uf, r.n): r.cod for r in kel.itertuples()}

# ---------------------------------------------------------------------------
# Matriz de tempos (nós = municípios do estado + municípios de fora com SIF)
# ---------------------------------------------------------------------------
m = pd.read_csv(INS_UF / "matriz_tempos_carro.csv", dtype={"origem": str, "destino": str})
nos = sorted(set(m.origem))
nos = [c for c in nos if c.startswith(str(COD_UF[UF]))] + [c for c in nos if not c.startswith(str(COD_UF[UF]))]
piv = lambda col: m.pivot(index="origem", columns="destino", values=col).reindex(index=nos, columns=nos)
minutos = np.rint(piv("minutos_carro").values).astype(int)
km = np.rint(piv("km").values).astype(int)
metodo = piv("metodo").values
pct_osrm = float((metodo[metodo != "mesmo_municipio"] == "estrada_osrm").mean() * 100)
json.dump({"nos": nos, "minutos_carro": minutos.ravel().tolist(), "km": km.ravel().tolist()},
          open(OUT / "matriz.json", "w"), separators=(",", ":"))

# ---------------------------------------------------------------------------
# Municípios: produção 2015–2025, contexto
# ---------------------------------------------------------------------------
base = pd.read_csv(INS_UF / "base_municipal_2025.csv", dtype={"cod_mun": str})
ano_final = 2025
serie = pd.read_csv(INS_UF / "ppm_peixes_2015_2024.csv", dtype={"cod_mun": str})
serie = serie.pivot(index="cod_mun", columns="ano", values="producao_t")
serie[ano_final] = base.set_index("cod_mun")["producao_t"]
serie = serie.reindex(base.cod_mun).fillna(0)
anos = sorted(int(a) for a in serie.columns)

muns = []
for r in base.itertuples():
    ces = CESSOES.get(UF, {}).get(r.municipio)
    muns.append({
        "cod": r.cod_mun, "nome": r.municipio, "lat": round(r.latitude, 5), "lon": round(r.longitude, 5),
        "regiao": r.regiao_imediata if isinstance(r.regiao_imediata, str) else "",
        "reservatorio": ces[1] if ces else "", "cessoes": ces[0] if ces else 0,
        "tilapia": round(float(r.participacao_tilapia), 3) if pd.notna(r.participacao_tilapia) else 0,
        "valor_mil_reais": round(float(r.valor_mil_reais), 1),
        "pescadores": int(r.pescadores_registrados),
        "area_km2": round(float(r.area_km2), 1) if pd.notna(r.area_km2) else None,
        "prod": [round(float(serie.loc[r.cod_mun, a]), 2) for a in anos],
    })
json.dump({"anos": anos, "municipios": muns}, open(OUT / "municipios.json", "w"), ensure_ascii=False, separators=(",", ":"))

# ---------------------------------------------------------------------------
# Produção por espécie (PPM 3940): toneladas e valor por município, espécie e ano
# ---------------------------------------------------------------------------
arq_esp = INS_UF / "ppm_especies_2015_2025.csv"
if arq_esp.exists():
    nomes = dict(json.load(open(INS / "ppm_especies_nomes.json")))
    e = pd.read_csv(arq_esp, dtype={"cod_mun": str})
    q = e[e.variavel == 4146].copy()
    q["t"] = q.valor / 1000
    tot = q[q.ano == anos[-1]].groupby("produto_id").t.sum().sort_values(ascending=False)
    ordem = [int(i) for i in tot.index] + [int(i) for i in nomes if int(i) not in tot.index]
    esp_idx = {pid: k for k, pid in enumerate(ordem)}
    dados = {}
    for (cod, pid), g in q.groupby(["cod_mun", "produto_id"]):
        serie_e = g.set_index("ano").t.reindex(anos).fillna(0)
        if serie_e.sum() > 0:
            dados.setdefault(cod, {})[esp_idx[int(pid)]] = [round(float(x), 3) for x in serie_e]
    json.dump({"anos": anos,
               "especies": [{"id": pid, "nome": nomes[pid] if pid in nomes else nomes[str(pid)],
                             "total_ultimo_ano_t": round(float(tot.get(pid, 0)), 1)} for pid in ordem],
               "dados": dados}, open(OUT / "especies.json", "w"), ensure_ascii=False, separators=(",", ":"))

# ---------------------------------------------------------------------------
# Estabelecimentos: SIF (federal) e SIE (estadual)
# ---------------------------------------------------------------------------
est = []
for s in json.load(open(INS / "sif_pescado_brasil.json")):
    cod = cod_por_nome.get((s["uf"], norm(s["municipio"])))
    if cod not in nos:
        continue
    desde = min(d for d in (s.get("reserva"), s.get("registro")) if d)[:4] if (s.get("reserva") or s.get("registro")) else None
    classes = " | ".join(c.split(" - ", 1)[-1].title() for c in s["classes"])
    avisos = []
    if "RECUPERACAO JUDICIAL" in s["razao"].upper():
        avisos.append("em recuperação judicial")
    if "RANARIO" in norm(s["razao"]) or "RANA" in s.get("fantasia", "").upper()[:4]:
        avisos.append("ranário (abate de rãs, classificado como pescado)")
    est.append({"tipo": "SIF", "numero": s["sif"], "nome": s["razao"].title(), "fantasia": (s.get("fantasia") or "").strip(" -").title(),
                "cod": cod, "municipio": pos.loc[cod, "nome"], "uf": s["uf"], "desde": int(desde) if desde else None,
                "classe": classes, "avisos": avisos})

sie = pd.read_csv(INS_UF / "sie_pescado_agrodefesa.csv", dtype=str)
for r in sie.itertuples():
    cod = cod_por_nome.get((UF, norm(r.municipio)))
    mm = re.search(r"/(\d{2})$", r.numero_sie.strip())
    desde = (1900 + int(mm.group(1)) if int(mm.group(1)) > 50 else 2000 + int(mm.group(1))) if mm else None
    avisos = []
    if "RECUPERACAO JUDICIAL" in r.razao_social.upper():
        avisos.append("em recuperação judicial")
    if not mm:
        avisos.append("número do SIE não informado no cadastro")
    est.append({"tipo": "SIE", "numero": r.numero_sie.strip(), "nome": r.razao_social.title(), "fantasia": "",
                "cod": cod, "municipio": r.municipio, "uf": UF, "desde": desde,
                "classe": r.classificacao.replace("SIE - ", "").title(), "avisos": avisos})
json.dump(est, open(OUT / "estabelecimentos.json", "w"), ensure_ascii=False, indent=0)

# ---------------------------------------------------------------------------
# Malha simplificada (menos de 300 KB)
# ---------------------------------------------------------------------------
import geopandas as gpd  # noqa: E402

g = gpd.read_file(INS_UF / "municipios_geodata_br.json")
g["cod"] = g["id"].astype(str)
g["geometry"] = g.geometry.simplify(0.004, preserve_topology=True)
g = g[["cod", "geometry"]]
gj = json.loads(g.to_json(drop_id=True))
def arred(c):
    return [arred(x) for x in c] if isinstance(c[0], (list, tuple)) else [round(c[0], 4), round(c[1], 4)]
for f in gj["features"]:
    f["geometry"]["coordinates"] = arred(f["geometry"]["coordinates"])
json.dump(gj, open(OUT / "municipios.geojson", "w"), separators=(",", ":"))

# ---------------------------------------------------------------------------
# Metadados
# ---------------------------------------------------------------------------
meta = {
    "uf": UF, "ano_final": ano_final, "anos": anos, "gerado_em": pd.Timestamp.now().strftime("%Y-%m-%d"),
    "n_municipios": len(muns), "n_nos": len(nos), "pct_pares_osrm": round(pct_osrm, 1),
    "n_sif": sum(e["tipo"] == "SIF" for e in est), "n_sie": sum(e["tipo"] == "SIE" for e in est),
    "nos_externos": [{"cod": c, "nome": pos.loc[c, "nome"], "uf": pos.loc[c, "uf"], "lat": round(float(pos.loc[c, "latitude"]), 5),
                      "lon": round(float(pos.loc[c, "longitude"]), 5)} for c in nos if not c.startswith(str(COD_UF[UF]))],
    "fontes": [
        {"dado": "Produção de peixe criado por município, 2015–2025", "fonte": "IBGE, Pesquisa da Pecuária Municipal (tabela 3940)", "url": "https://sidra.ibge.gov.br/tabela/3940"},
        {"dado": "Estabelecimentos de pescado com SIF ativo", "fonte": "MAPA, SIGSIF (dados abertos), consulta em 24/11/2026", "url": "https://dados.agricultura.gov.br/dataset/062166e3-b515-4274-8e7d-68aadd64b820"},
        {"dado": "Estabelecimentos de pescado com SIE", "fonte": "Agrodefesa, consulta pública (LAI), em 23/11/2026", "url": "https://sidago.agrodefesa.go.gov.br/site/adicionaisproprios/consultaslai/consultasie.php"},
        {"dado": "Tempos de viagem entre sedes municipais", "fonte": "OSRM sobre o OpenStreetMap, calculado em 22/11/2026", "url": "https://project-osrm.org"},
        {"dado": "Malha municipal", "fonte": "geodata-br, a partir do IBGE", "url": "https://github.com/tbrugz/geodata-br"},
        {"dado": "Coordenadas das sedes", "fonte": "kelvins/municipios-brasileiros", "url": "https://github.com/kelvins/municipios-brasileiros"},
        {"dado": "Cessões em águas da União", "fonte": "MPA, tabulação da equipe do projeto Rota do Pescado", "url": ""},
    ],
}
json.dump(meta, open(OUT / "meta.json", "w"), ensure_ascii=False, indent=1)

for f in sorted(OUT.iterdir()):
    print(f"{f.name:24s} {f.stat().st_size / 1024:8.0f} KB")
print(f"{meta['n_sif']} SIF e {meta['n_sie']} SIE na rede de {UF}; {len(muns)} municípios; anos {anos[0]}–{anos[-1]}")

