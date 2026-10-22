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
ok(ini.serverInfo.version === "1.1.0", "versão 1.1.0");
ok(ini.instructions.includes("Nunca use outro caminho") && ini.instructions.includes("26/10/2025"), "instruções novas (rota única e aviso do plugin)");
const tl = await call("tools/list", {});
const desc = (nm) => tl.tools.find((t) => t.name === nm).description;
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
