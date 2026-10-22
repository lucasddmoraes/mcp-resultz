import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import worker from "./worker.js";

// ---------- D1 simulado
class Stmt {
  constructor(db, sql) { this.db = db; this.sql = sql; this.vals = []; }
  bind(...v) { this.vals = v.map((x) => (x === undefined ? null : typeof x === "boolean" ? (x ? 1 : 0) : x)); return this; }
  _p() { return this.db.prepare(this.sql); }
  async first() { const r = this._p().get(...this.vals); return r ? { ...r } : null; }
  async all() { return { results: this._p().all(...this.vals).map((r) => ({ ...r })), success: true }; }
  async run() { const r = this._p().run(...this.vals); return { success: true, meta: { last_row_id: Number(r.lastInsertRowid), changes: r.changes } }; }
}
const sqlite = new DatabaseSync(":memory:");
const DB = { prepare: (s) => new Stmt(sqlite, s), batch: async (st) => Promise.all(st.map((x) => x.run())) };

// ---------- env
// Chaves: variáveis de ambiente WOO_* ou um lojas.json no formato da skill woo-precos-parcelas
const arq = process.env.LOJAS_JSON || "/mnt/skills/plugins/woo-precos-parcelas/lojas.json";
const lojas = fs.existsSync(arq) ? JSON.parse(fs.readFileSync(arq, "utf8"))
  : { gdv: { ck: process.env.WOO_GDV_CK, cs: process.env.WOO_GDV_CS }, sh: { ck: process.env.WOO_SH_CK, cs: process.env.WOO_SH_CS } };
const ADMIN = "A".repeat(10) + "bcdefghijklmnopqrstuvwxyz0123456789";
const env = { DB, ADMIN_TOKEN: ADMIN, ADMIN_NOME: "Lucas", WOO_GDV_CK: lojas.gdv.ck, WOO_GDV_CS: lojas.gdv.cs, WOO_SH_CK: lojas.sh.ck, WOO_SH_CS: lojas.sh.cs };
const ctx = { waitUntil: (p) => p };

// ---------- intercepta escritas na loja
const realFetch = globalThis.fetch;
const escritas = [];
globalThis.fetch = async (url, init = {}) => {
  const m = (init.method || "GET").toUpperCase();
  if (m !== "GET") {
    const body = init.body ? JSON.parse(init.body) : null;
    escritas.push({ url: String(url).replace(/^https:\/\/[^/]+/, ""), m, body });
    let resp = {};
    if (String(url).includes("products/batch")) resp = { update: body.update.map((u) => ({ id: u.id, status: u.status || "publish", ...u })) };
    else if (String(url).includes("/coupons")) resp = { id: 99999, ...body };
    return new Response(JSON.stringify(resp), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  return realFetch(url, init);
};

// ---------- helpers
const base = "https://mcp.resultz.com.br";
async function req(path, { method = "POST", body, accept = "application/json, text/event-stream" } = {}) {
  const r = await worker.fetch(new Request(base + path, { method, headers: { "Content-Type": "application/json", Accept: accept }, body: body ? JSON.stringify(body) : undefined }), env, ctx);
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch {}
  return { status: r.status, text: t, json: j };
}
let n = 0;
const rpc = (token, method, params) => req(`/lojas/${token}`, { body: { jsonrpc: "2.0", id: ++n, method, params } });
async function tool(token, name, args) {
  const r = await rpc(token, "tools/call", { name, arguments: args });
  const res = r.json.result;
  let dados = null; try { dados = JSON.parse(res.content[0].text); } catch { dados = res.content[0].text; }
  return { erro: !!res.isError, dados };
}
const ok = (cond, msg) => console.log((cond ? "OK   " : "FALHA") + "  " + msg);

// ---------- testes
let r = await req("/", { method: "GET" }); ok(r.status === 200, "raiz responde 200");
r = await req("/lojas/tokeninvalido1234567890abcdef", { body: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} } }); ok(r.status === 404, "token inválido -> 404");
r = await req("/.well-known/oauth-protected-resource", { method: "GET" }); ok(r.status === 404, ".well-known -> 404");
r = await req(`/lojas/${ADMIN}`, { method: "GET", accept: "text/event-stream" }); ok(r.status === 405, "GET com SSE -> 405");
r = await req(`/lojas/${ADMIN}`, { method: "GET", accept: "text/html" }); ok(r.status === 200 && r.text.includes("Lucas"), "GET no navegador mostra conector ativo");
r = await rpc(ADMIN, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "teste", version: "1" } });
ok(r.json.result.protocolVersion === "2025-06-18" && r.json.result.instructions.includes("Lucas"), "initialize ok");
r = await req(`/lojas/${ADMIN}`, { body: { jsonrpc: "2.0", method: "notifications/initialized" } }); ok(r.status === 202, "notificação -> 202");
r = await rpc(ADMIN, "tools/list", {}); const nomesAdmin = r.json.result.tools.map((t) => t.name);
ok(nomesAdmin.length === 9, `admin vê 9 ferramentas: ${nomesAdmin.join(", ")}`);
r = await rpc(ADMIN, "metodo/inexistente", {}); ok(r.json.error?.code === -32601, "método desconhecido -> -32601");
r = await req(`/lojas/${ADMIN}`, { body: [{ jsonrpc: "2.0", id: 50, method: "ping" }, { jsonrpc: "2.0", method: "notifications/x" }] }); ok(Array.isArray(r.json) && r.json.length === 1, "lote JSON-RPC");

let t = await tool(ADMIN, "buscar_produtos", { loja: "gdv", busca: "petar" });
ok(!t.erro && t.dados.produtos.length === 3 && t.dados.produtos.every((p) => p.status === "private"), `buscar petar: ${t.dados.produtos?.map((p) => p.id + "/" + p.status).join(" ")}`);
t = await tool(ADMIN, "buscar_produtos", { loja: "gdv", categoria: "futsal", status: "publish" });
ok(!t.erro && t.dados.produtos.length === 8, `categoria futsal: ${t.dados.produtos?.length} produtos, parcelas ${[...new Set(t.dados.produtos?.map((p) => p.parcelas))]}`);
t = await tool(ADMIN, "buscar_produtos", { loja: "gdv", categoria: "estudos-do-meio" });
ok(!t.erro, `categoria por slug estudos-do-meio: ${t.erro ? t.dados : t.dados.total + " produtos"}`);
t = await tool(ADMIN, "listar_cupons", { loja: "gdv", busca: "ifux" });
ok(!t.erro && t.dados.cupons[0]?.codigo === "ifuxgiz2", "listar cupons encontra ifuxgiz2");

// acesso de editor
t = await tool(ADMIN, "gerenciar_acessos", { acao: "criar", nome: "Teste Editor", papel: "editor", lojas: ["gdv"] });
const link = t.dados.links?.lojas || ""; const ED = link.split("/").pop();
ok(!t.erro && link.startsWith("https://mcp.resultz.com.br/lojas/") && ED.length === 40, "admin cria editor e recebe link");
r = await rpc(ED, "tools/list", {}); const nomesEd = r.json.result.tools.map((x) => x.name);
ok(!nomesEd.includes("consultar_log") && !nomesEd.includes("gerenciar_acessos") && nomesEd.includes("criar_cupom"), `editor vê: ${nomesEd.join(", ")}`);
t = await tool(ED, "buscar_produtos", { loja: "sh", busca: "x" }); ok(t.erro && t.dados.includes("não tem acesso"), "editor bloqueado na loja sh");
t = await tool(ED, "consultar_log", {}); ok(t.erro, "editor não chama consultar_log");
t = await tool(ED, "criar_cupom", { loja: "gdv", tipo: "percent", valor: 60, produto_ids: [10817], motivo: "teste" }); ok(t.erro && t.dados.includes("50%"), "editor bloqueado em cupom de 60%");
t = await tool(ED, "criar_cupom", { loja: "gdv", tipo: "percent", valor: 50, produto_ids: [10817], limite_uso: 0, motivo: "teste" }); ok(t.erro && t.dados.includes("usos"), "editor bloqueado em cupom ilimitado");
t = await tool(ED, "criar_cupom", { loja: "gdv", tipo: "percent", valor: 50, motivo: "" }); ok(t.erro, "sem motivo -> erro");
const futsal = [10817, 10818, 10819, 10820, 10821, 10822, 10823, 10824];
escritas.length = 0;
t = await tool(ED, "criar_cupom", { loja: "gdv", tipo: "percent", valor: 50, produto_ids: futsal, validade: "2026-12-31", descricao: "Teste", motivo: "crie um de 50% para o futsal com uso único" });
const enviado = escritas.find((e) => e.url.includes("/coupons"))?.body;
ok(!t.erro && enviado?.code?.length === 8 && enviado.usage_limit === 1 && enviado.product_ids.length === 8 && enviado.date_expires === "2027-01-01T00:00:00" && enviado.description.includes("Teste Editor"),
  `criar cupom (interceptado): code=${enviado?.code} usos=${enviado?.usage_limit} validade=${enviado?.date_expires}`);

// status
escritas.length = 0;
t = await tool(ED, "alterar_status_produto", { loja: "gdv", produto_ids: [17538], status: "private", motivo: "teste no-op" });
ok(!t.erro && t.dados.ja_estavam.length === 1 && escritas.length === 0, "status: produto já privado, nenhuma escrita");
escritas.length = 0;
t = await tool(ED, "alterar_status_produto", { loja: "gdv", produto_ids: [17538], status: "publish", motivo: "teste" });
ok(!t.erro && t.dados.alterados.length === 1 && escritas[0]?.body.update[0].status === "publish", "status: envia publish (interceptado)");
t = await tool(ED, "alterar_status_produto", { loja: "gdv", produto_ids: [1], status: "private", motivo: "teste" }); ok(t.erro && t.dados.includes("não encontrados"), "status: ID inexistente -> erro");

// preço e parcelas
t = await tool(ED, "alterar_preco_parcelas", { loja: "gdv", filtro: { categoria: "Futsal" }, regra: { tipo: "percentual", pct: 10 }, motivo: "teste" });
const cod = t.dados.codigo_confirmacao;
ok(!t.erro && t.dados.simulacao && t.dados.total_alterar === 8 && t.dados.plano[0].preco_depois === "627", `simulação +10%: ${t.dados.total_alterar} itens, 570 -> ${t.dados.plano?.[0]?.preco_depois}, código ${cod}`);
t = await tool(ED, "alterar_preco_parcelas", { loja: "gdv", filtro: { categoria: "Futsal" }, regra: { tipo: "percentual", pct: 10 }, aplicar: true, codigo_confirmacao: "errado", motivo: "teste" });
ok(t.erro && t.dados.includes("não confere"), "aplicar com código errado -> bloqueado");
escritas.length = 0;
t = await tool(ED, "alterar_preco_parcelas", { loja: "gdv", filtro: { categoria: "Futsal" }, regra: { tipo: "percentual", pct: 10 }, aplicar: true, codigo_confirmacao: cod, motivo: "teste" });
const lote = escritas.find((e) => e.url.includes("products/batch"))?.body.update;
ok(!t.erro && lote?.length === 8 && lote[0].regular_price === "627" && !lote[0].meta_data, `aplicar (interceptado): ${lote?.length} updates; verificação acusa ${t.dados.falhas?.length} falhas porque nada foi gravado de fato`);
t = await tool(ED, "alterar_preco_parcelas", { loja: "gdv", filtro: { categoria: "Futsal", parcelas_atuais: 5 }, regra: { tipo: "manter_parcela", parcelas_para: 4 }, motivo: "teste" });
ok(!t.erro, `simulação manter_parcela 5x->4x: ${t.erro ? t.dados : t.dados.total_alterar + " itens, fora: " + t.dados.fora.length + " (" + (t.dados.fora[0]?.motivo || "") + ")"}`);
t = await tool(ED, "alterar_preco_parcelas", { loja: "gdv", itens: [{ id: 10817, parcelas: 2 }], motivo: "teste" });
ok(!t.erro && t.dados.plano[0].parcelas_depois === "2", `itens explícitos: parcelas ${t.dados.plano?.[0]?.parcelas_antes} -> ${t.dados.plano?.[0]?.parcelas_depois}, parcela R$ ${t.dados.plano?.[0]?.parcela}`);

// relatório (só contagens, sem expor dados pessoais)
const t0 = Date.now();
t = await tool(ADMIN, "relatorio_vendas", { loja: "gdv", data_inicio: "2026-01-01", data_fim: "2026-10-22", produto: "petar" });
ok(!t.erro, `relatório petar 2026: ${t.erro ? t.dados : `${t.dados.resumo.pedidos} pedidos, ${t.dados.resumo.itens} itens, receita ${t.dados.resumo.receita}, status ${JSON.stringify(t.dados.resumo.por_status)}, lidos ${t.dados.pedidos_lidos}, internos ignorados ${t.dados.pedidos_internos_ignorados}, colunas ${t.dados.linhas[0]?.length}, aluno extraído em ${t.dados.linhas.filter((l) => l[5]).length} linhas, ${Date.now() - t0} ms`}`);
if (!t.erro) console.log("      por produto:", JSON.stringify(t.dados.resumo.por_produto));

// log e revogação
t = await tool(ADMIN, "consultar_log", { limite: 100 });
const regs = t.dados.registros;
ok(!t.erro && regs.length > 0 && !regs.some((x) => x.resultado === "iniciado"), `log: ${regs.length} registros, nenhum preso em 'iniciado'`);
console.log("      amostra:", JSON.stringify(regs.find((x) => x.ferramenta === "criar_cupom" && x.resultado === "ok")));
t = await tool(ADMIN, "consultar_log", { usuario: "Teste", so_alteracoes: true });
ok(!t.erro, `log filtrado (Teste, só alterações): ${t.dados.registros.map((x) => x.ferramenta + ":" + x.resultado).join(", ")}`);
t = await tool(ADMIN, "gerenciar_acessos", { acao: "listar" }); const idEd = t.dados.usuarios[0].id;
t = await tool(ADMIN, "gerenciar_acessos", { acao: "revogar", usuario_id: idEd });
r = await rpc(ED, "tools/list", {}); ok(r.status === 404, "editor revogado -> 404");
t = await tool(ADMIN, "gerenciar_acessos", { acao: "novo_link", usuario_id: idEd }); const ED2 = t.dados.links.lojas.split("/").pop();
r = await rpc(ED2, "tools/list", {}); const r2 = await rpc(ED, "tools/list", {});
ok(r.status === 200 && r2.status === 404, "novo_link reativa com link novo e o antigo continua morto");

// relatórios extras após a otimização
for (const [rot, args] of [
  ["categoria Estudos do Meio", { categoria: "Estudos do Meio" }],
  ["produto_ids 12517", { produto_ids: [12517] }],
  ["texto inexistente", { produto: "zzzinexistente" }],
]) {
  const t1 = Date.now();
  const x = await tool(ADMIN, "relatorio_vendas", { loja: "gdv", data_inicio: "2026-01-01", data_fim: "2026-10-22", ...args });
  ok(!x.erro, `relatório ${rot}: ${x.erro ? x.dados : `${x.dados.resumo.pedidos} pedidos, ${x.dados.resumo.itens} itens, receita ${x.dados.resumo.receita}, pedidos lidos ${x.dados.pedidos_lidos}, páginas de linhas ${x.dados.total_paginas}, ${Date.now() - t1} ms`}`);
}
