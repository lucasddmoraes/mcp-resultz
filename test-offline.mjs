// Testes sem acesso às lojas: D1 simulado com node:sqlite e WooCommerce simulado em memória.
// Rodar com `npm run test:offline`. Complementa o test.mjs, que usa dados reais das lojas.
import { DatabaseSync } from "node:sqlite";
import worker from "./worker.js";
class Stmt { constructor(db, sql) { this.db = db; this.sql = sql; this.vals = []; }
  bind(...v) { this.vals = v.map((x) => (x === undefined ? null : typeof x === "boolean" ? (x ? 1 : 0) : x)); return this; }
  _p() { return this.db.prepare(this.sql); }
  async first() { const r = this._p().get(...this.vals); return r ? { ...r } : null; }
  async all() { return { results: this._p().all(...this.vals).map((r) => ({ ...r })) }; }
  async run() { const r = this._p().run(...this.vals); return { meta: { last_row_id: Number(r.lastInsertRowid), changes: r.changes } }; } }
const sqlite = new DatabaseSync(":memory:");
const DB = { prepare: (s) => new Stmt(sqlite, s), batch: async (st) => Promise.all(st.map((x) => x.run())) };
const ADMIN = "A".repeat(40);
const env = { DB, ADMIN_TOKEN: ADMIN, ADMIN_NOME: "Lucas", WOO_GDV_CK: "x", WOO_GDV_CS: "y" };
const meta = (q) => [{ key: "fswp_post_meta", value: { disable_installments: "0", installment_qty: q, disable_in_cash: "0", in_cash_discount: "", in_cash_discount_type: null } }];
let catalogo = [
  { id: 1, name: "Eletiva A", type: "simple", status: "publish", regular_price: "500", sale_price: "", meta_data: meta("5") },
  { id: 2, name: "Eletiva B", type: "simple", status: "publish", regular_price: "1000", sale_price: "", meta_data: meta("5") },
  { id: 3, name: "Eletiva C (global)", type: "simple", status: "publish", regular_price: "800", sale_price: "", meta_data: [] },
  { id: 4, name: "Eletiva D (variável)", type: "variable", status: "publish", regular_price: "", sale_price: "", meta_data: meta("5") },
];
const escritas = [];
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url); const m = (init.method || "GET").toUpperCase();
  const json = (d) => new Response(JSON.stringify(d), { status: 200, headers: { "X-WP-Total": String(d.length ?? 0), "X-WP-TotalPages": "1" } });
  if (m !== "GET") {
    const b = JSON.parse(init.body); escritas.push(b);
    for (const up of b.update) { const p = catalogo.find((x) => x.id === up.id); if (up.regular_price) p.regular_price = up.regular_price; if (up.meta_data) p.meta_data = up.meta_data; }
    return json({ update: b.update.map((x) => ({ id: x.id })) });
  }
  if (u.pathname.endsWith("/products/categories")) return json([{ id: 9, name: "Eletivas", slug: "eletivas", count: 4 }]);
  if (u.pathname.endsWith("/products")) {
    const inc = u.searchParams.get("include");
    return json(inc ? catalogo.filter((p) => inc.split(",").map(Number).includes(p.id)) : catalogo);
  }
  return new Response("{}", { status: 404 });
};
const ok = (c, msg) => console.log((c ? "OK   " : "FALHA") + "  " + msg);
let n = 0;
async function call(method, params) {
  const r = await worker.fetch(new Request(`https://mcp.resultz.com.br/lojas/${ADMIN}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method, params }) }), env, { waitUntil: (p) => p });
  return (await r.json()).result;
}
async function tool(name, args) { const r = await call("tools/call", { name, arguments: args }); let d; try { d = JSON.parse(r.content[0].text); } catch { d = r.content[0].text; } return { erro: !!r.isError, d }; }

const ini = await call("initialize", { protocolVersion: "2025-06-18" });
ok(ini.serverInfo.version === "1.5.0", "versão 1.5.0");
ok(ini.instructions.includes("Nunca use outro caminho") && ini.instructions.includes("26/10/2025"), "instruções novas (rota única e aviso do plugin)");
const tl = await call("tools/list", {});
const desc = (nm) => tl.tools.find((t) => t.name === nm).description;
const pLoja = tl.tools.find((t) => t.name === "buscar_produtos").inputSchema.properties.loja;
ok(pLoja.enum.includes("didatica") && pLoja.description.includes("didatica = Didática Educacional") && ini.instructions.includes("didatica = Didática Educacional (didaticaeducacional.com.br)"), "loja didatica no schema e nas instruções");
const semChave = await tool("buscar_produtos", { loja: "didatica", busca: "x" });
ok(semChave.erro && String(semChave.d).includes("WOO_DIDATICA_CK"), "loja didatica sem chave cadastrada: erro claro");
ok(desc("relatorio_vendas").includes("Método de Pagamento, Email, Aluno, Produto, Qtde, Valor") && desc("relatorio_vendas").includes("Responsável e ID produto não entram"), "relatorio_vendas descreve as 9 colunas");
ok(desc("alterar_preco_parcelas").includes("herda a configuração global") && desc("alterar_preco_parcelas").includes("filtro.parcelas_atuais"), "alterar_preco_parcelas descreve global x sobrescrita");

const base = { loja: "gdv", filtro: { categoria: "Eletivas" }, regra: { tipo: "manter_parcela", parcelas_para: 4 }, motivo: "teste: eletivas para 4x" };
let t = await tool("alterar_preco_parcelas", base);
ok(!t.erro, `manter_parcela sem parcelas_atuais com produto global não derruba a simulação${t.erro ? ": " + t.d : ""}`);
if (!t.erro) {
  ok(t.d.total_alterar === 2 && t.d.plano.map((x) => x.preco_depois).join() === "400,800", `plano: ${t.d.plano.map((x) => x.id + ":" + x.preco_antes + "->" + x.preco_depois).join(" ")}`);
  ok(t.d.fora.some((x) => x.id === 3 && x.motivo.includes("global")) && t.d.fora.some((x) => x.id === 4), `fora: ${t.d.fora.map((x) => x.id + " (" + x.motivo + ")").join("; ")}`);
  const ap = await tool("alterar_preco_parcelas", { ...base, aplicar: true, codigo_confirmacao: t.d.codigo_confirmacao });
  ok(!ap.erro && ap.d.verificados_ok === 2 && ap.d.falhas.length === 0, `aplicar: ${ap.erro ? ap.d : ap.d.atualizados + " atualizados, " + ap.d.verificados_ok + " verificados, falhas " + ap.d.falhas.length}`);
  const up = escritas.at(-1)?.update || [];
  ok(up.length === 2 && up.every((u) => u.meta_data[0].value.installment_qty === "4" && u.meta_data[0].value.disable_in_cash === "0"), "grava o objeto inteiro do plugin trocando só installment_qty");
}
t = await tool("alterar_preco_parcelas", { ...base, regra: { tipo: "manter_parcela" } });
ok(t.erro && t.d.includes("parcelas_para"), "manter_parcela sem parcelas_para continua bloqueado");
t = await tool("alterar_preco_parcelas", { ...base, filtro: { categoria: "Eletivas", parcelas_atuais: 4 }, regra: { tipo: "so_parcelas", parcelas_para: 5 } });
ok(!t.erro && t.d.total_alterar === 2 && t.d.fora.some((x) => x.id === 3), "filtro parcelas_atuais segue excluindo o global");
const lg = await tool("consultar_log", {});
ok(!lg.erro && lg.d.registros.some((r) => r.ferramenta === "alterar_preco_parcelas" && r.resultado === "ok"), "aplicação registrada no log como ok");

// rotas básicas
const raw = (path, init) => worker.fetch(new Request("https://mcp.resultz.com.br" + path, init), env, { waitUntil: (p) => p });
let r = await raw("/"); ok(r.status === 200 && (await r.text()) === "MCP Resultz ativo.", "raiz responde 200");
r = await raw("/lojas/tokeninvalido1234567890abcdef", { method: "POST", body: "{}" }); ok(r.status === 404, "token inválido -> 404");
r = await raw("/.well-known/oauth-protected-resource"); ok(r.status === 404, ".well-known -> 404");
ok(ini.serverInfo.icons?.[0]?.src === "https://mcp.resultz.com.br/icon.png", "initialize anuncia o ícone");

// ---------- área sumare (API Softsy simulada; dados fictícios)
env.SUMARE_API_USER = "usr"; env.SUMARE_API_PASS = "pwd";
const cand = (id, etapa, status, extra) => ({
  candidato: id, nome: `Pessoa ${id}`, email: `p${id}@exemplo.com`, whatsapp: `1190000${id}`, cpf: `000${id}`,
  curso: "DIR", nomeCurso: "Direito", turno: "N", descricaoTurno: "Noite", polo: "P1", nomePolo: "Guarulhos",
  area: "Humanas", tipoIngresso: "Vestibular", concurso: "2027.1", campanha: "Black Friday", etapa, status,
  statusDescricao: status, diasParado: 0, dtInscricao: "2026-10-01T09:00:00", dtAssinaturaContrato: null, dtMatricula: null, aluno: null,
  ...extra,
});
const candidatos = [
  cand(1, "CONVERTIDO", "MATRICULADO", { dtMatricula: "2026-10-05T10:00:00", aluno: "A1" }),
  cand(2, "CONVERTIDO", "MATRICULADO", { dtMatricula: "2026-10-06T11:00:00", polo: "P2", nomePolo: "Tatuapé", curso: "ADM_EAD", nomeCurso: "Administração EAD", cpf: "000222" }),
  cand(3, "CONVERTIDO", "MATRICULADO", { dtMatricula: "2026-10-06T15:00:00", polo: "P2", nomePolo: "Tatuapé", curso: "ADM_1_EAD", nomeCurso: "Administração EAD", cpf: "000222" }),
  cand(4, "CONVERTIDO", "MATRICULADO", { dtMatricula: "2026-09-03T10:00:00", dtInscricao: "2026-09-01T10:00:00" }),
  cand(5, "CONVERTIDO", "MATRICULADO", { dtMatricula: "2026-09-25T10:00:00", dtInscricao: "2026-09-20T10:00:00" }),
  cand(6, "CONVERTIDO", "MATRICULADO", { dtMatricula: "2026-10-07T10:00:00", email: "teste@exemplo.com" }),
  cand(7, "PAGAMENTO", "BOLETO_VENCIDO", { diasParado: 9, dtInscricao: "2026-10-02T09:00:00", nome: "Joao Ficticio", cpf: "55555555555" }),
  cand(8, "PAGAMENTO", "PIX_VENCIDO", { diasParado: 3, polo: "P2", nomePolo: "Tatuapé", campanha: "Volta às aulas" }),
  cand(9, "CONTRATO", "PARADO_CONTRATO", { diasParado: 15, polo: "P2", nomePolo: "Tatuapé", dtInscricao: "2026-09-28T09:00:00" }),
];
const sumareFiltrosMock = {
  cursos: [{ codigo: "DIR", descricao: "Direito" }, { codigo: "ADM_EAD", descricao: "Administração EAD" }, { codigo: "ADM_1_EAD", descricao: "Administração EAD" }],
  polos: [{ codigo: "P1", descricao: "Guarulhos" }, { codigo: "P2", descricao: "Tatuapé" }],
  areas: [{ codigo: "Humanas", descricao: "Humanas" }], turnos: [{ codigo: "N", descricao: "Noite" }],
  tiposIngresso: [{ codigo: "Vestibular", descricao: "Vestibular" }], concursos: [{ codigo: "2027.1", descricao: "2027.1" }],
  campanhas: [{ codigo: "BF", descricao: "Black Friday" }],
  etapas: [{ codigo: "CONTRATO", descricao: "Contrato" }, { codigo: "PAGAMENTO", descricao: "Pagamento" }, { codigo: "CONVERTIDO", descricao: "Convertido" }],
};
const sumareConsultas = [];
let ultimaUrlSumare = "";
const fetchLojas = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  if (u.host !== "painel.sumare.edu.br" && u.host !== "api-nova.exemplo.com") return fetchLojas(url, init);
  ultimaUrlSumare = u.origin + u.pathname;
  if (init.headers?.Authorization !== "Basic " + btoa("usr:pwd")) return new Response("Unauthorized", { status: 401 });
  const j = (d) => new Response(JSON.stringify(d), { status: 200 });
  if (u.pathname.endsWith("/filtros")) return j(sumareFiltrosMock);
  const q = Object.fromEntries(u.searchParams); sumareConsultas.push(q);
  const em = (campo, chave) => !q[chave] || q[chave].split(",").includes(campo);
  const fil = candidatos.filter((x) => em(x.etapa, "etapas") && em(x.polo, "polos") && em(x.curso, "cursos") && em(x.status, "status"));
  const tam = Number(q.tamanho), pag = Number(q.pagina || 1);
  return j({ geradoEm: "2026-10-22T14:00:00", dadosDe: "2026-10-22T13:58:00", pagina: pag, tamanho: tam, total: fil.length,
    totalPaginas: Math.max(1, Math.ceil(fil.length / tam)), itens: fil.slice((pag - 1) * tam, pag * tam) });
};
async function rpcArea(area, token, method, params) {
  const r = await worker.fetch(new Request(`https://mcp.resultz.com.br/${area}/${token}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method, params }) }), env, { waitUntil: (p) => p });
  return { status: r.status, json: r.status === 200 ? await r.json() : null };
}
async function toolArea(area, token, name, args) {
  const r = (await rpcArea(area, token, "tools/call", { name, arguments: args })).json.result;
  let d; try { d = JSON.parse(r.content[0].text); } catch { d = r.content[0].text; }
  return { erro: !!r.isError, d };
}
const su = (name, args, token = ADMIN) => toolArea("sumare", token, name, args);

let s = await rpcArea("sumare", ADMIN, "initialize", { protocolVersion: "2025-06-18" });
ok(s.json.result.instructions.includes("Dash de Captação") && s.json.result.serverInfo.name === "resultz-sumare", "sumare: initialize com instruções da área");
s = await rpcArea("sumare", ADMIN, "tools/list", {});
ok(s.json.result.tools.map((t) => t.name).sort().join() === "consultar_log,gerenciar_acessos,meu_acesso,sumare_funil,sumare_lista_candidatos,sumare_matriculas,sumare_opcoes", "sumare: admin vê as 4 ferramentas da área + 3 comuns");

let m = await su("sumare_matriculas", { mes: "2026-10" });
ok(!m.erro && m.d.total === 3 && m.d.cpfs_unicos === 2 && m.d.registros_teste_excluidos === 1 && m.d.base_atualizada_em === "2026-10-22 13:58",
  `sumare: matrículas out/2026 = ${m.d.total} (cpfs ${m.d.cpfs_unicos}, testes excluídos ${m.d.registros_teste_excluidos})`);
ok(sumareConsultas.at(-1).etapas === "CONVERTIDO" && sumareConsultas.at(-1).tamanho === "5000", "sumare: matrículas pede só CONVERTIDO à API");
m = await su("sumare_matriculas", { data_inicio: "2026-10-06", data_fim: "2026-10-06", detalhe: "polo" });
ok(!m.erro && m.d.total === 2 && m.d.detalhe[0].polo === "Tatuapé", "sumare: período de um dia com quebra por polo");
m = await su("sumare_matriculas", { mes: "2026-10", polo: "tatuape" });
ok(!m.erro && m.d.total === 2 && m.d.filtros.polos === "P2", "sumare: filtro por nome sem acento resolve o código");
m = await su("sumare_matriculas", { mes: "2026-10", curso: "administracao" });
ok(!m.erro && m.d.filtros.cursos.split(",").sort().join() === "ADM_1_EAD,ADM_EAD", "sumare: curso por nome pega todos os códigos");
m = await su("sumare_matriculas", { mes: "2026-10", comparar: true });
// "até o mesmo dia" depende de hoje: outubro em andamento vai até hoje; depois disso, até o dia 30 de setembro
const hojeBR = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
const ateDiaEsperado = Math.min(hojeBR.startsWith("2026-10") ? Number(hojeBR.slice(8, 10)) : 31, 30);
const esperadoAteDia = [3, 25].filter((d) => d <= ateDiaEsperado).length; // matrículas fictícias de 03/09 e 25/09
ok(!m.erro && m.d.mes_anterior.total === 2 && m.d.mes_anterior.ate_mesmo_dia.total === esperadoAteDia && m.d.mes_anterior.periodo === "2026-09-01 a 2026-09-30",
  `sumare: comparar com setembro = ${m.d.mes_anterior?.total}, até o mesmo dia = ${m.d.mes_anterior?.ate_mesmo_dia?.total}`);
m = await su("sumare_matriculas", { metrica: "inscricoes", data_inicio: "2026-10-01", data_fim: "2026-10-31", detalhe: "dia" });
ok(!m.erro && m.d.total === 5 && !sumareConsultas.at(-1).etapas && m.d.detalhe[0].dia === "2026-10-01", `sumare: inscrições outubro = ${m.d.total}, por dia`);
m = await su("sumare_matriculas", { polo: "Inexistente" });
ok(m.erro && m.d.includes("não encontrado") && m.d.includes("Guarulhos"), "sumare: filtro inválido lista as opções");

let f = await su("sumare_funil", {});
ok(!f.erro && f.d.total_candidatos === 8 && f.d.por_etapa.CONVERTIDO === 5 && f.d.por_etapa.PAGAMENTO === 2 && f.d.por_etapa.CONTRATO === 1, `sumare: funil ${JSON.stringify(f.d.por_etapa)}`);
f = await su("sumare_funil", { etapa: "PAGAMENTO", detalhe: "polo" });
ok(!f.erro && f.d.total_candidatos === 2 && f.d.detalhe.length === 2 && sumareConsultas.at(-1).etapas === "PAGAMENTO", "sumare: funil filtrado por etapa e aberto por polo");
f = await su("sumare_funil", { dias_parado_min: 5, campanha: "black" });
ok(!f.erro && f.d.total_candidatos === 2, "sumare: funil com dias parados e campanha");

// acesso e lista com dados pessoais
let ac = await toolArea("lojas", ADMIN, "gerenciar_acessos", { acao: "criar", nome: "Leitora Sumare", papel: "leitor", areas: ["sumare"] });
const LEI = ac.d.links?.sumare?.split("/").pop();
ac = await toolArea("lojas", ADMIN, "gerenciar_acessos", { acao: "criar", nome: "Editor Sumare", papel: "editor", areas: ["sumare"] });
const EDS = ac.d.links?.sumare?.split("/").pop();
ok(LEI?.length === 40 && EDS?.length === 40, "sumare: admin cria acessos só para a área sumare");
ok((await rpcArea("lojas", EDS, "tools/list", {})).status === 404, "sumare: acesso só da sumare não abre as lojas (404)");
s = await rpcArea("sumare", LEI, "tools/list", {});
ok(!s.json.result.tools.some((t) => t.name === "sumare_lista_candidatos") && s.json.result.tools.some((t) => t.name === "sumare_funil"), "sumare: leitor vê contagens, não vê a lista");
let l = await su("sumare_lista_candidatos", { status: "BOLETO_VENCIDO" }, LEI);
ok(l.erro, "sumare: leitor não consegue chamar a lista");
l = await su("sumare_lista_candidatos", { etapa: "PAGAMENTO" }, EDS);
ok(l.erro && l.d.includes("motivo"), "sumare: lista sem motivo é bloqueada");
l = await su("sumare_lista_candidatos", { etapa: "PAGAMENTO,CONTRATO", motivo: "lista para a equipe ligar para quem parou" }, EDS);
ok(!l.erro && l.d.total === 3 && l.d.linhas[0][0] === 9 && l.d.colunas.includes("cpf") && l.d.linhas.length === 3, `sumare: lista ordenada por dias parado (${l.d.linhas?.map((x) => x[0]).join(",")})`);
const lg2 = await su("consultar_log", { ferramenta: "sumare_lista_candidatos" });
const reg = lg2.d.registros.find((x) => x.resultado === "ok");
const textoLog = JSON.stringify(lg2.d.registros);
ok(reg && reg.usuario === "Editor Sumare" && reg.motivo.includes("equipe ligar") && reg.alvo === "3 candidatos", "sumare: log registra quem puxou a lista, motivo e quantidade");
ok(!textoLog.includes("55555555555") && !textoLog.includes("Joao Ficticio") && !textoLog.includes("@exemplo.com"), "sumare: log não guarda dados pessoais");
const ma = await su("meu_acesso", {}, EDS);
ok(!ma.erro && !("lojas" in ma.d) && ma.d.areas.join() === "sumare", "sumare: meu_acesso sem dados das lojas");

// endereço da API
ok(ultimaUrlSumare === "https://painel.sumare.edu.br/captacao/api/integracao/v1/candidatos", "sumare: usa o endereço novo da API por padrão");
env.SUMARE_API_URL = "https://api-nova.exemplo.com/v2/";
f = await su("sumare_funil", {});
ok(!f.erro && ultimaUrlSumare === "https://api-nova.exemplo.com/v2/candidatos", "sumare: SUMARE_API_URL troca o endereço sem mexer no código");
delete env.SUMARE_API_URL;

// credencial
env.SUMARE_API_PASS = "errada"; sumareConsultas.length = 0;
let e = await su("sumare_funil", {});
ok(e.erro && e.d.includes("401"), "sumare: credencial recusada vira erro claro");
delete env.SUMARE_API_PASS;
e = await su("sumare_funil", {});
ok(e.erro && e.d.includes("não está configurada"), "sumare: sem secret, erro claro");

// ---------- clientes da loja: grupos do B2BKing (250 clientes fictícios em 3 páginas)
const clientesLoja = [];
for (let i = 1; i <= 250; i++) {
  const grupo = i <= 120 ? "101" : i <= 200 ? "102" : i <= 230 ? "103" : null; // 7º Ano, 8º Ano, 3ª Série, sem grupo
  const meta = [{ id: i * 10, key: "_ultimo_login", value: "x" }];
  if (grupo) meta.push({ id: i * 10 + 1, key: "b2bking_customergroup", value: grupo }, { id: i * 10 + 2, key: "b2bking_b2buser", value: "yes" });
  clientesLoja.push({ id: i, first_name: `Familia`, last_name: `${i}`, email: `familia${i}@exemplo.com`, meta_data: meta });
}
const consultasClientes = [];
const fetchAntesClientes = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  if (!u.pathname.includes("/wc/v3/customers")) return fetchAntesClientes(url, init);
  const m = (init.method || "GET").toUpperCase();
  const json = (d, total = d.length, paginas = 1) => new Response(JSON.stringify(d), { status: 200, headers: { "X-WP-Total": String(total), "X-WP-TotalPages": String(paginas) } });
  if (m === "POST" && u.pathname.endsWith("/customers/batch")) {
    const b = JSON.parse(init.body);
    const update = b.update.map((up) => {
      if (up.id === 5) return { id: 5, error: { code: "x", message: "falha simulada" } };
      const cli = clientesLoja.find((x) => x.id === up.id);
      for (const md of up.meta_data) {
        const ex = cli.meta_data.find((x) => x.key === md.key);
        if (ex) ex.value = md.value; else cli.meta_data.push({ key: md.key, value: md.value });
      }
      return { id: up.id };
    });
    return json({ update });
  }
  consultasClientes.push(Object.fromEntries(u.searchParams));
  const q = u.searchParams;
  let lista = clientesLoja;
  if (q.get("include")) { const ids = q.get("include").split(",").map(Number); lista = lista.filter((x) => ids.includes(x.id)); }
  if (q.get("search")) lista = lista.filter((x) => `${x.first_name} ${x.last_name} ${x.email}`.includes(q.get("search")));
  const per = Number(q.get("per_page") || 10), pag = Number(q.get("page") || 1);
  return json(structuredClone(lista.slice((pag - 1) * per, pag * per)), lista.length, Math.max(1, Math.ceil(lista.length / per)));
};
const cl = (name, args, token = ADMIN) => toolArea("lojas", token, name, args);

ac = await toolArea("lojas", ADMIN, "gerenciar_acessos", { acao: "criar", nome: "Leitor Lojas", papel: "leitor", lojas: ["gdv"] });
const LEIL = ac.d.links.lojas.split("/").pop();
ac = await toolArea("lojas", ADMIN, "gerenciar_acessos", { acao: "criar", nome: "Editor Lojas", papel: "editor", lojas: ["gdv"] });
const EDL = ac.d.links.lojas.split("/").pop();
s = await rpcArea("lojas", LEIL, "tools/list", {});
ok(!s.json.result.tools.some((x) => ["grupos_clientes", "buscar_clientes", "virada_grupos", "nomear_grupos"].includes(x.name)), "clientes: leitor não vê as ferramentas de clientes");
s = await rpcArea("lojas", EDL, "tools/list", {});
const nomesEd = s.json.result.tools.map((x) => x.name);
ok(nomesEd.includes("virada_grupos") && nomesEd.includes("grupos_clientes") && !nomesEd.includes("nomear_grupos"), "clientes: editor vê virada e grupos, não vê nomear_grupos");

let g = await cl("grupos_clientes", { loja: "gdv" }, EDL);
ok(!g.erro && g.d.total_clientes === 250 && g.d.sem_grupo === 20 && g.d.sem_nome.join() === "101,102,103" && consultasClientes.every((q) => q.role === "all"), `clientes: grupos em uso ${g.d.grupos?.map((x) => `${x.grupo_id}:${x.clientes}`).join(" ")} (3 páginas lidas)`);
g = await cl("virada_grupos", { loja: "gdv", mudancas: [{ de: "101", para: "102" }], motivo: "teste" }, EDL);
ok(g.erro && g.d.includes("não está nomeado"), "clientes: destino sem nome é recusado");
g = await cl("nomear_grupos", { loja: "gdv", grupos: [{ grupo_id: "101", nome: "7º Ano EF" }], motivo: "teste" }, EDL);
ok(g.erro, "clientes: editor não nomeia grupos");
g = await cl("nomear_grupos", { loja: "gdv", grupos: [{ grupo_id: "101", nome: "7º Ano EF" }, { grupo_id: "102", nome: "8º Ano EF" }, { grupo_id: "103", nome: "3ª Série EM" }, { grupo_id: "104", nome: "9º Ano EF" }], motivo: "mapear as turmas do GDV" });
ok(!g.erro && g.d.gravados === 4 && g.d.mapa["104"] === "9º Ano EF", "clientes: admin nomeia os grupos");
g = await cl("nomear_grupos", { loja: "gdv", grupos: [{ grupo_id: "105", nome: "7º ano ef" }], motivo: "teste" });
ok(g.erro && g.d.includes("mesmo nome"), "clientes: recusa dois grupos com o mesmo nome");

const mudancas = [{ de: "8º Ano EF", para: "9º Ano EF" }, { de: "7º Ano EF", para: "8º Ano EF" }];
let sim = await cl("virada_grupos", { loja: "gdv", mudancas, motivo: "virada de ano 2027" }, EDL);
ok(!sim.erro && sim.d.simulacao && sim.d.total_alterar === 200 && sim.d.resumo.map((r) => `${r.de}->${r.para}:${r.clientes}`).join("|") === "8º Ano EF->9º Ano EF:80|7º Ano EF->8º Ano EF:120", `clientes: simulação ${JSON.stringify(sim.d.resumo?.map((r) => r.clientes))}, código ${sim.d.codigo_confirmacao}`);
ok(clientesLoja.filter((x) => x.meta_data.some((m) => m.key === "b2bking_customergroup" && m.value === "104")).length === 0, "clientes: simulação não grava nada");
g = await cl("virada_grupos", { loja: "gdv", mudancas, aplicar: true, codigo_confirmacao: "errado", motivo: "virada" }, EDL);
ok(g.erro && g.d.includes("não confere"), "clientes: código errado bloqueia a aplicação");
g = await cl("virada_grupos", { loja: "gdv", mudancas: [{ de: "7º Ano EF", para: "7º Ano EF" }], motivo: "x" }, EDL);
ok(g.erro && g.d.includes("iguais"), "clientes: origem igual ao destino é recusada");
let ap = await cl("virada_grupos", { loja: "gdv", mudancas, aplicar: true, codigo_confirmacao: sim.d.codigo_confirmacao, motivo: "virada de ano 2027" }, EDL);
const grupoDe = (id) => clientesLoja.find((x) => x.id === id).meta_data.find((m) => m.key === "b2bking_customergroup")?.value;
ok(!ap.erro && ap.d.movidos === 199 && ap.d.falhas.length === 1 && ap.d.falhas[0].id === 5 && ap.d.recusados[0].erro === "falha simulada", "clientes: aplica em lote, relê e aponta o cliente que a loja recusou");
ok(grupoDe(1) === "102" && grupoDe(121) === "104" && grupoDe(5) === "101" && grupoDe(201) === "103", "clientes: cada cliente se move uma vez só (7º vai para 8º, 8º vai para 9º, sem efeito cascata)");
g = await cl("grupos_clientes", { loja: "gdv" }, EDL);
const cont = Object.fromEntries(g.d.grupos.map((x) => [x.grupo_id, x.clientes]));
ok(cont["101"] === 1 && cont["102"] === 119 && cont["104"] === 80 && cont["103"] === 30, `clientes: contagem depois ${JSON.stringify(cont)}`);
g = await cl("buscar_clientes", { loja: "gdv", grupo: "9º Ano EF" }, EDL);
ok(g.erro && g.d.includes("motivo"), "clientes: busca sem motivo é bloqueada");
g = await cl("buscar_clientes", { loja: "gdv", grupo: "9º Ano EF", motivo: "conferir a virada" }, EDL);
ok(!g.erro && g.d.total === 80 && g.d.linhas[0][4] === "9º Ano EF", "clientes: busca por grupo depois da virada");
g = await cl("buscar_clientes", { loja: "gdv", grupo: "sem grupo", motivo: "conferir" }, EDL);
ok(!g.erro && g.d.total === 20, "clientes: busca de quem está sem grupo");
const lgc = await toolArea("lojas", ADMIN, "consultar_log", { ferramenta: "virada_grupos" });
const regAp = lgc.d.registros.find((x) => x.resultado === "parcial");
ok(regAp && regAp.usuario === "Editor Lojas" && regAp.motivo === "virada de ano 2027" && regAp.antes.includes('"1":"101"') && !JSON.stringify(lgc.d).includes("@exemplo.com"), "clientes: log com quem, motivo e antes/depois por ID, sem e-mails");
