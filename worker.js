/*
 * MCP Resultz
 * Servidor MCP remoto (Streamable HTTP, respostas JSON) em um único Cloudflare Worker, sem dependências.
 *
 * Endereço de cada conector:  https://mcp.resultz.com.br/<area>/<token>
 * Áreas disponíveis:          lojas (WooCommerce dos colégios GDV e Super Humanos)
 *                              sumare (Dash de Captação da Sumaré, API Softsy)
 *                              midia (tagueamento e mídia paga: Meta, Google Ads, GA4, GTM; código em midia.js)
 *
 * Binding exigido:
 *   DB   banco D1 (as tabelas são criadas sozinhas na primeira chamada)
 * Secrets exigidos:
 *   ADMIN_TOKEN                       token do dono, mínimo 32 caracteres, só letras e números
 *   WOO_GDV_CK, WOO_GDV_CS            chave da API REST da loja GDV (Leitura/Escrita)
 *   WOO_SH_CK,  WOO_SH_CS             chave da API REST da loja Super Humanos (Leitura/Escrita)
 *   SUMARE_API_USER, SUMARE_API_PASS  usuário e senha (Basic) da API do Dash de Captação da Sumaré
 *   GOOGLE_SA_JSON, GOOGLE_ADS_*, META_ACCESS_TOKEN, CLOUDFLARE_API_TOKEN   área midia (ver midia.js)
 * Variáveis opcionais:
 *   ADMIN_NOME (Lucas), BASE_URL (https://mcp.resultz.com.br),
 *   CUPOM_MAX_PCT_EDITOR (50), CUPOM_MAX_FIXO_EDITOR (300), CUPOM_MAX_USOS_EDITOR (20),
 *   EXCLUIR_EMAILS (login@resultzads.com)
 */

import { criarAreaMidia } from "./midia.js";

const VERSAO = "1.3.0";
const PROTOCOLOS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const PAPEIS = { leitor: 1, editor: 2, admin: 3 };
const ALFA62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const ALFA36 = "abcdefghijklmnopqrstuvwxyz0123456789";
const NOMES_AREAS = ["lojas", "sumare", "midia"]; // ao criar uma área nova em AREAS, inclua o nome aqui

const LOJAS = {
  gdv: { nome: "Colégio Guilherme Dumont Villares", host: "loja.gdv.com.br", ck: "WOO_GDV_CK", cs: "WOO_GDV_CS" },
  sh: { nome: "Colégio Super Humanos", host: "loja.colegiosuperhumanos.com.br", ck: "WOO_SH_CK", cs: "WOO_SH_CS" },
};

/* ------------------------------------------------------------------ utilidades */

class ErroUso extends Error {}
function falha(msg) {
  throw new ErroUso(msg);
}

const naoEncontrado = () => new Response("Not found", { status: 404 });
const texto = (t, status = 200) =>
  new Response(t, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
const respostaJson = (obj) =>
  new Response(JSON.stringify(obj), { headers: { "Content-Type": "application/json; charset=utf-8" } });

const norm = (s) =>
  String(s ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const lista = (s) =>
  String(s || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
const centavos = (v) => Math.round(parseFloat(v || 0) * 100);
const dinheiro = (c) => (c % 100 === 0 ? String(c / 100) : (c / 100).toFixed(2));
const cfgNum = (env, nome, padrao) => {
  const n = parseFloat(env[nome]);
  return Number.isFinite(n) ? n : padrao;
};
const corta = (v, n = 4000) => {
  if (v === undefined || v === null) return null;
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > n ? s.slice(0, n) + "…" : s;
};
const dataValida = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || "")) && !isNaN(Date.parse(s + "T00:00:00Z"));
const baseUrl = (env) => (env.BASE_URL || "https://mcp.resultz.com.br").replace(/\/+$/, "");
const horaBrasilia = (ts) =>
  ts ? new Date(ts.replace(" ", "T") + "Z").toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }) : null;

async function sha256(t) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function aleatorio(n, alfabeto) {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return [...bytes].map((b) => alfabeto[b % alfabeto.length]).join("");
}

/* ------------------------------------------------------------------ banco */

let schemaPronto = false;
async function garantirSchema(env) {
  if (schemaPronto) return;
  if (!env.DB) throw new Error("Configuração incompleta: falta o binding D1 com o nome DB.");
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS usuarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      email TEXT,
      papel TEXT NOT NULL,
      areas TEXT NOT NULL DEFAULT 'lojas',
      lojas TEXT NOT NULL DEFAULT '*',
      token_hash TEXT NOT NULL UNIQUE,
      ativo INTEGER NOT NULL DEFAULT 1,
      criado_em TEXT NOT NULL DEFAULT (datetime('now')),
      criado_por TEXT,
      ultimo_uso TEXT)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL DEFAULT (datetime('now')),
      usuario TEXT NOT NULL,
      usuario_id INTEGER,
      area TEXT,
      ferramenta TEXT NOT NULL,
      tipo TEXT,
      loja TEXT,
      motivo TEXT,
      parametros TEXT,
      alvo TEXT,
      antes TEXT,
      depois TEXT,
      resultado TEXT,
      detalhe TEXT)`),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_log_ts ON log(ts)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_log_usuario ON log(usuario)"),
  ]);
  schemaPronto = true;
}

async function logAbrir(c, f, args) {
  const { motivo, ...resto } = args;
  // O log guarda os parâmetros para auditoria, mas e-mails de famílias
  // (ex.: cupom restrito a e-mails) ficam só na loja, nunca aqui.
  if (Array.isArray(resto.emails)) resto.emails = `[${resto.emails.length} e-mail(s)]`;
  else if (typeof resto.emails === "string" && resto.emails) resto.emails = "[e-mail omitido]";
  const r = await c.env.DB.prepare(
    `INSERT INTO log (usuario, usuario_id, area, ferramenta, tipo, loja, motivo, parametros, resultado)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'iniciado')`
  )
    .bind(
      c.usuario.nome,
      c.usuario.id,
      c.nomeArea,
      f.nome,
      f.tipo,
      args.loja || null,
      motivo ? String(motivo).slice(0, 1000) : null,
      corta(resto, 3000)
    )
    .run();
  return r.meta.last_row_id;
}

async function logFechar(env, id, resultado, l = {}) {
  await env.DB.prepare("UPDATE log SET resultado = ?2, alvo = ?3, antes = ?4, depois = ?5, detalhe = ?6 WHERE id = ?1")
    .bind(id, resultado, corta(l.alvo, 2000), corta(l.antes, 50000), corta(l.depois, 50000), corta(l.detalhe, 2000))
    .run();
}

/* ------------------------------------------------------------------ acesso */

async function autenticar(env, ctx, token) {
  if (!/^[A-Za-z0-9_-]{24,200}$/.test(token || "")) return null;
  const hash = await sha256(token);
  if (env.ADMIN_TOKEN && env.ADMIN_TOKEN.length >= 32 && hash === (await sha256(env.ADMIN_TOKEN))) {
    return { id: 0, nome: env.ADMIN_NOME || "Lucas", email: null, papel: "admin", areas: "*", lojas: "*", dono: true };
  }
  const u = await env.DB.prepare(
    "SELECT id, nome, email, papel, areas, lojas FROM usuarios WHERE token_hash = ?1 AND ativo = 1"
  )
    .bind(hash)
    .first();
  if (!u) return null;
  ctx.waitUntil(
    env.DB.prepare("UPDATE usuarios SET ultimo_uso = datetime('now') WHERE id = ?1")
      .bind(u.id)
      .run()
      .catch(() => {})
  );
  return u;
}
const temArea = (u, a) => u.areas === "*" || lista(u.areas).includes(a);
const temLoja = (u, l) => u.lojas === "*" || lista(u.lojas).includes(l);
const podeUsar = (u, papel) => (PAPEIS[u.papel] || 0) >= PAPEIS[papel];

/* ------------------------------------------------------------------ HTTP + MCP */

export default {
  async fetch(request, env, ctx) {
    try {
      return await rotear(request, env, ctx);
    } catch (e) {
      console.error(e);
      return texto("Erro interno: " + (e?.message || "desconhecido"), 500);
    }
  },
};

async function rotear(request, env, ctx) {
  const url = new URL(request.url);
  const partes = url.pathname.split("/").filter(Boolean);
  if (partes.length === 0) return texto("MCP Resultz ativo.");
  if (partes[0].startsWith(".well-known") || partes.length < 2 || partes.length > 3) return naoEncontrado();
  const [nomeArea, token, sufixo] = partes;
  if (sufixo && sufixo !== "mcp") return naoEncontrado();
  const area = AREAS[nomeArea];
  if (!area) return naoEncontrado();

  await garantirSchema(env);
  const usuario = await autenticar(env, ctx, token);
  if (!usuario || !temArea(usuario, nomeArea)) return naoEncontrado();

  if (request.method === "GET") {
    if ((request.headers.get("Accept") || "").includes("text/event-stream")) {
      return new Response(null, { status: 405, headers: { Allow: "POST" } });
    }
    return texto(
      `Conector "${area.titulo}" ativo para ${usuario.nome} (${usuario.papel}).\n` +
        `Adicione este endereço no Claude em Configurações > Conectores > Adicionar conector personalizado.`
    );
  }
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });

  let corpo;
  try {
    corpo = await request.json();
  } catch {
    return respostaJson(rpcErro(null, -32700, "JSON inválido"));
  }
  const c = { env, ctx, usuario, nomeArea, area };
  if (Array.isArray(corpo)) {
    const rs = [];
    for (const m of corpo) {
      const r = await tratar(m, c);
      if (r) rs.push(r);
    }
    return rs.length ? respostaJson(rs) : new Response(null, { status: 202 });
  }
  const r = await tratar(corpo, c);
  return r ? respostaJson(r) : new Response(null, { status: 202 });
}

const rpcOk = (id, result) => ({ jsonrpc: "2.0", id, result });
const rpcErro = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

async function tratar(msg, c) {
  if (!msg || typeof msg !== "object") return rpcErro(null, -32600, "Requisição inválida");
  const temId = msg.id !== undefined && msg.id !== null;
  if (typeof msg.method !== "string") {
    if ("result" in msg || "error" in msg) return null; // resposta do cliente: ignorar
    return rpcErro(temId ? msg.id : null, -32600, "Requisição inválida");
  }
  if (!temId) return null; // notificações, ex.: notifications/initialized
  const p = msg.params || {};
  switch (msg.method) {
    case "initialize":
      return rpcOk(msg.id, {
        protocolVersion: PROTOCOLOS.includes(p.protocolVersion) ? p.protocolVersion : "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: {
          name: `resultz-${c.nomeArea}`,
          title: c.area.titulo,
          version: VERSAO,
          // arquivo servido pelos static assets (pasta public/)
          icons: [{ src: `${baseUrl(c.env)}/icon.png`, mimeType: "image/png", sizes: ["512x512"] }],
        },
        instructions: c.area.instrucoes(c.usuario, c.env),
      });
    case "ping":
      return rpcOk(msg.id, {});
    case "tools/list":
      return rpcOk(msg.id, { tools: ferramentasDe(c).map(descreverFerramenta) });
    case "tools/call":
      return rpcOk(msg.id, await chamarFerramenta(p, c));
    default:
      return rpcErro(msg.id, -32601, `Método não suportado: ${msg.method}`);
  }
}

function ferramentasDe(c) {
  return [...c.area.ferramentas, ...FERRAMENTAS_COMUNS].filter((f) => podeUsar(c.usuario, f.papel));
}

function descreverFerramenta(f) {
  return {
    name: f.nome,
    title: f.titulo,
    description: f.descricao,
    inputSchema: f.entrada,
    annotations: {
      title: f.titulo,
      readOnlyHint: f.tipo === "leitura",
      destructiveHint: !!f.destrutiva,
      idempotentHint: !!f.idempotente,
      openWorldHint: f.tipo !== "admin",
    },
  };
}

const resultadoErro = (t) => ({ content: [{ type: "text", text: t }], isError: true });

async function chamarFerramenta(p, c) {
  const f = ferramentasDe(c).find((x) => x.nome === p.name);
  if (!f) return resultadoErro(`Ferramenta inexistente ou sem permissão para ${c.usuario.nome}: ${p.name}`);
  const args = p.arguments && typeof p.arguments === "object" ? p.arguments : {};

  // Regra central: nada é executado sem antes existir uma linha no log.
  let logId;
  try {
    logId = await logAbrir(c, f, args);
  } catch (e) {
    console.error(e);
    return resultadoErro("Não foi possível registrar a ação no log, então nada foi executado. Tente de novo.");
  }

  try {
    for (const k of f.entrada.required || []) {
      if (args[k] === undefined || args[k] === null || args[k] === "") falha(`Parâmetro obrigatório ausente: ${k}`);
    }
    if (args.loja !== undefined) {
      if (!LOJAS[args.loja]) falha(`Loja inválida: ${args.loja}. Use: ${Object.keys(LOJAS).join(", ")}`);
      if (!temLoja(c.usuario, args.loja)) falha(`${c.usuario.nome} não tem acesso à loja ${args.loja}.`);
    }
    if ((f.tipo === "escrita" || f.exigeMotivo) && !String(args.motivo || "").trim()) {
      falha("Informe o motivo: o pedido do usuário, nas palavras dele.");
    }
    const r = await f.executar(args, c);
    await logFechar(c.env, logId, r.log?.resultado || "ok", r.log);
    return { content: [{ type: "text", text: JSON.stringify(r.dados) }] };
  } catch (e) {
    const msg = e instanceof ErroUso ? e.message : `Falha inesperada: ${e.message}`;
    if (!(e instanceof ErroUso)) console.error(e);
    await logFechar(c.env, logId, "erro", { detalhe: msg }).catch(() => {});
    return resultadoErro(msg);
  }
}

/* ------------------------------------------------------------------ WooCommerce */

const META_PARCELAS = "fswp_post_meta"; // plugin WooCommerce Parcelas
const CAMPOS_PRODUTO =
  "id,name,slug,status,type,price,regular_price,sale_price,categories,total_sales,permalink,stock_status,meta_data";
const STATUS_PEDIDO = {
  completed: "Concluído",
  processing: "Processando",
  "on-hold": "Aguardando",
  pending: "Pendente",
  cancelled: "Cancelado",
  refunded: "Reembolsado",
  failed: "Falhou",
};

async function woo(env, loja, metodo, caminho, { query, corpo } = {}) {
  const cfg = LOJAS[loja];
  const ck = env[cfg.ck];
  const cs = env[cfg.cs];
  if (!ck || !cs) falha(`As chaves da loja ${loja} não estão configuradas no servidor (${cfg.ck} / ${cfg.cs}).`);
  const url = new URL(`https://${cfg.host}/wp-json/wc/v3/${caminho}`);
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, Array.isArray(v) ? v.join(",") : String(v));
  }
  const resp = await fetch(url.toString(), {
    method: metodo,
    headers: {
      Authorization: "Basic " + btoa(`${ck}:${cs}`),
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "Resultz-MCP/" + VERSAO,
    },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  const bruto = await resp.text();
  let dados = null;
  try {
    dados = JSON.parse(bruto);
  } catch {
    /* tratado abaixo */
  }
  if (!resp.ok) falha(`A loja ${loja} respondeu ${resp.status}: ${dados?.message || bruto.slice(0, 200) || resp.statusText}`);
  if (dados === null) falha(`Resposta inesperada da loja ${loja} (não veio JSON).`);
  return {
    dados,
    total: parseInt(resp.headers.get("X-WP-Total") || "0", 10),
    paginas: parseInt(resp.headers.get("X-WP-TotalPages") || "0", 10),
  };
}

function parcelamento(p) {
  const m = (p?.meta_data || []).find((x) => x.key === META_PARCELAS);
  if (!m || typeof m.value !== "object" || m.value === null) return { meta: null, qtd: null };
  const q = m.value.installment_qty;
  return { meta: m.value, qtd: q === "" || q === null || q === undefined ? null : String(q) };
}

const resumoProduto = (p) => ({
  id: p.id,
  nome: p.name,
  status: p.status,
  tipo: p.type,
  preco: p.regular_price || p.price,
  promocional: p.sale_price || null,
  parcelas: parcelamento(p).qtd || "global",
  categorias: (p.categories || []).map((x) => x.name),
  vendas: p.total_sales,
  estoque: p.stock_status,
  link: p.permalink,
});

async function produtosPorIds(env, loja, ids) {
  const unicos = [...new Set((ids || []).map((x) => parseInt(x, 10)).filter((x) => x > 0))];
  if (!unicos.length) falha("Nenhum ID de produto válido.");
  const saida = [];
  for (let i = 0; i < unicos.length; i += 100) {
    const { dados } = await woo(env, loja, "GET", "products", {
      query: { include: unicos.slice(i, i + 100), per_page: 100, status: "any", _fields: CAMPOS_PRODUTO },
    });
    saida.push(...dados);
  }
  const achados = new Set(saida.map((p) => p.id));
  const faltando = unicos.filter((id) => !achados.has(id));
  if (faltando.length) falha(`Produtos não encontrados na loja ${loja}: ${faltando.join(", ")}`);
  return saida;
}

async function produtosDaCategoria(env, loja, catId, status = "any") {
  const saida = [];
  for (let page = 1; page <= 10; page++) {
    const { dados, paginas } = await woo(env, loja, "GET", "products", {
      query: { category: catId, status, per_page: 100, page, _fields: CAMPOS_PRODUTO },
    });
    saida.push(...dados);
    if (page >= paginas || dados.length < 100) break;
  }
  return saida;
}

async function resolverCategoria(env, loja, ref) {
  const r = String(ref || "").trim();
  if (!r) falha("Categoria vazia.");
  if (/^\d+$/.test(r)) return { id: parseInt(r, 10), nome: `#${r}` };
  const todas = [];
  for (let page = 1; page <= 3; page++) {
    const { dados } = await woo(env, loja, "GET", "products/categories", {
      query: { per_page: 100, page, _fields: "id,name,slug,count" },
    });
    todas.push(...dados);
    if (dados.length < 100) break;
  }
  const alvo = norm(r);
  let achadas = todas.filter((x) => norm(x.name) === alvo || norm(x.slug) === alvo);
  if (!achadas.length) achadas = todas.filter((x) => norm(x.name).includes(alvo) || norm(x.slug).includes(alvo));
  if (achadas.length === 1) return { id: achadas[0].id, nome: achadas[0].name };
  if (!achadas.length) falha(`Categoria "${r}" não encontrada na loja ${loja}.`);
  falha(`Categoria ambígua "${r}". Opções: ${achadas.slice(0, 15).map((x) => `${x.name} (id ${x.id})`).join("; ")}`);
}

function alunoDoEmail(email) {
  if (!/@[^@]*g12\.br$/i.test(email)) return "";
  return email
    .split("@")[0]
    .split(/[._]+/)
    .filter(Boolean)
    .map((x) => x.charAt(0).toUpperCase() + x.slice(1).toLowerCase())
    .join(" ");
}

/* ------------------------------------------------------------------ ferramentas: lojas */

const P_LOJA = { type: "string", enum: Object.keys(LOJAS), description: "gdv = Colégio GDV; sh = Colégio Super Humanos" };
const P_MOTIVO = {
  type: "string",
  description: "O pedido do usuário que originou esta ação, nas palavras dele. Vai para o log de auditoria.",
};

const FERRAMENTAS_LOJAS = [
  {
    nome: "buscar_produtos",
    titulo: "Buscar produtos",
    tipo: "leitura",
    papel: "leitor",
    idempotente: true,
    descricao:
      "Lista produtos de uma loja com preço, status, categorias, vendas e parcelamento. Use antes de qualquer alteração " +
      "para obter os IDs certos. Filtros combináveis: texto do nome, categoria (nome, slug ou ID), status e lista de IDs. " +
      "Retorna até 100 por página.",
    entrada: {
      type: "object",
      properties: {
        loja: P_LOJA,
        busca: { type: "string", description: "Trecho do nome do produto" },
        categoria: { type: "string", description: "Nome, slug ou ID da categoria" },
        status: { type: "string", enum: ["any", "publish", "private", "draft", "pending"], description: "Padrão: any" },
        ids: { type: "array", items: { type: "integer" }, description: "IDs específicos de produto" },
        pagina: { type: "integer", minimum: 1, description: "Padrão: 1" },
      },
      required: ["loja"],
    },
    async executar(a, c) {
      const query = {
        per_page: 100,
        page: a.pagina || 1,
        status: a.status || "any",
        search: a.busca,
        orderby: "title",
        order: "asc",
        _fields: CAMPOS_PRODUTO,
      };
      let cat = null;
      if (a.categoria) {
        cat = await resolverCategoria(c.env, a.loja, a.categoria);
        query.category = cat.id;
      }
      if (Array.isArray(a.ids) && a.ids.length) query.include = a.ids.slice(0, 100);
      const { dados, total, paginas } = await woo(c.env, a.loja, "GET", "products", { query });
      return {
        dados: {
          loja: a.loja,
          categoria: cat?.nome || null,
          pagina: query.page,
          total,
          total_paginas: paginas,
          produtos: dados.map(resumoProduto),
        },
        log: { alvo: `${dados.length} produtos` },
      };
    },
  },

  {
    nome: "alterar_status_produto",
    titulo: "Alterar status de produtos",
    tipo: "escrita",
    papel: "editor",
    destrutiva: true,
    idempotente: true,
    descricao:
      "Muda o status de um ou mais produtos: publish (publicado), private (privado) ou draft (rascunho). Produto privado " +
      "some da loja para o público e não pode ser comprado; pedidos já feitos não mudam. Confirme os IDs com " +
      "buscar_produtos antes e, se o pedido for ambíguo (vários produtos com nome parecido), pergunte ao usuário. " +
      "Máximo de 50 produtos por chamada.",
    entrada: {
      type: "object",
      properties: {
        loja: P_LOJA,
        produto_ids: { type: "array", items: { type: "integer" }, minItems: 1, maxItems: 50 },
        status: { type: "string", enum: ["publish", "private", "draft"] },
        motivo: P_MOTIVO,
      },
      required: ["loja", "produto_ids", "status", "motivo"],
    },
    async executar(a, c) {
      if (!["publish", "private", "draft"].includes(a.status)) falha("Status inválido.");
      if (!Array.isArray(a.produto_ids) || !a.produto_ids.length || a.produto_ids.length > 50) {
        falha("Envie de 1 a 50 IDs de produto.");
      }
      const atuais = await produtosPorIds(c.env, a.loja, a.produto_ids);
      const mudar = atuais.filter((p) => p.status !== a.status);
      const antes = Object.fromEntries(atuais.map((p) => [p.id, p.status]));
      const depois = { ...antes };
      const recusados = [];
      if (mudar.length) {
        const { dados } = await woo(c.env, a.loja, "POST", "products/batch", {
          corpo: { update: mudar.map((p) => ({ id: p.id, status: a.status })) },
        });
        for (const x of dados.update || []) {
          if (x.error) recusados.push({ id: x.id, erro: x.error.message });
          else depois[x.id] = x.status;
        }
      }
      const naoConfirmados = mudar.filter((p) => depois[p.id] !== a.status).map((p) => p.id);
      return {
        dados: {
          loja: a.loja,
          status_novo: a.status,
          alterados: mudar
            .filter((p) => depois[p.id] === a.status)
            .map((p) => ({ id: p.id, nome: p.name, de: p.status, para: a.status })),
          ja_estavam: atuais.filter((p) => p.status === a.status).map((p) => ({ id: p.id, nome: p.name })),
          recusados,
          nao_confirmados: naoConfirmados,
        },
        log: {
          resultado: naoConfirmados.length ? "parcial" : "ok",
          alvo: atuais.map((p) => `${p.id} ${p.name}`).join("; "),
          antes,
          depois,
          detalhe: recusados.length ? JSON.stringify(recusados) : null,
        },
      };
    },
  },

  {
    nome: "listar_cupons",
    titulo: "Listar cupons",
    tipo: "leitura",
    papel: "leitor",
    idempotente: true,
    descricao: "Lista cupons de desconto da loja, do mais recente para o mais antigo, com tipo, valor, usos e restrições.",
    entrada: {
      type: "object",
      properties: {
        loja: P_LOJA,
        busca: { type: "string", description: "Trecho do código do cupom" },
        limite: { type: "integer", minimum: 1, maximum: 100, description: "Padrão: 20" },
      },
      required: ["loja"],
    },
    async executar(a, c) {
      const { dados, total } = await woo(c.env, a.loja, "GET", "coupons", {
        query: {
          search: a.busca,
          per_page: Math.min(Math.max(parseInt(a.limite || 20, 10), 1), 100),
          orderby: "date",
          order: "desc",
          _fields:
            "id,code,discount_type,amount,usage_count,usage_limit,usage_limit_per_user,date_expires,product_ids,product_categories,email_restrictions,description,date_created",
        },
      });
      return {
        dados: {
          loja: a.loja,
          total,
          cupons: dados.map((x) => ({
            id: x.id,
            codigo: x.code,
            tipo: x.discount_type,
            valor: x.amount,
            usos: `${x.usage_count}/${x.usage_limit ?? "ilimitado"}`,
            validade: x.date_expires ? x.date_expires.slice(0, 10) : null,
            produtos: x.product_ids,
            categorias: x.product_categories,
            emails: x.email_restrictions,
            descricao: x.description || null,
            criado: x.date_created?.slice(0, 10),
          })),
        },
        log: { alvo: `${dados.length} cupons` },
      };
    },
  },

  {
    nome: "criar_cupom",
    titulo: "Criar cupom de desconto",
    tipo: "escrita",
    papel: "editor",
    descricao:
      "Cria um cupom de desconto. Padrão da loja: código aleatório de 8 caracteres, uso único, sem validade, restrito " +
      "aos produtos informados. Para restringir a uma modalidade ou viagem, obtenha os IDs com buscar_produtos ou use " +
      "'categoria'. Editores têm limites de valor e de usos; acima disso, só administrador.",
    entrada: {
      type: "object",
      properties: {
        loja: P_LOJA,
        tipo: {
          type: "string",
          enum: ["percent", "fixed_cart", "fixed_product"],
          description: "percent = %; fixed_cart = R$ no carrinho; fixed_product = R$ por produto",
        },
        valor: { type: "number", exclusiveMinimum: 0, description: "Percentual ou valor em reais" },
        produto_ids: { type: "array", items: { type: "integer" }, description: "Produtos em que o cupom vale" },
        categoria: { type: "string", description: "Nome, slug ou ID de categoria em que o cupom vale" },
        codigo: { type: "string", description: "Código personalizado (opcional). Sem isso, gera um aleatório." },
        limite_uso: { type: "integer", minimum: 0, description: "Usos totais. Padrão 1. 0 = ilimitado (só admin)." },
        limite_por_usuario: { type: "integer", minimum: 0, description: "Padrão 1. 0 = ilimitado." },
        limitar_itens: { type: "integer", minimum: 1, description: "Aplica o desconto a no máximo N itens do carrinho" },
        validade: { type: "string", description: "Último dia válido, AAAA-MM-DD (opcional)" },
        emails: { type: "array", items: { type: "string" }, description: "Restringe a estes e-mails (opcional)" },
        descricao: { type: "string", description: "Para quem é o cupom (aparece só no painel)" },
        motivo: P_MOTIVO,
      },
      required: ["loja", "tipo", "valor", "motivo"],
    },
    async executar(a, c) {
      const admin = podeUsar(c.usuario, "admin");
      const valor = parseFloat(a.valor);
      if (!["percent", "fixed_cart", "fixed_product"].includes(a.tipo)) falha("Tipo de cupom inválido.");
      if (!(valor > 0)) falha("O valor do desconto precisa ser maior que zero.");
      if (a.tipo === "percent" && valor > 100) falha("Percentual acima de 100%.");
      const maxPct = cfgNum(c.env, "CUPOM_MAX_PCT_EDITOR", 50);
      const maxFixo = cfgNum(c.env, "CUPOM_MAX_FIXO_EDITOR", 300);
      const maxUsos = cfgNum(c.env, "CUPOM_MAX_USOS_EDITOR", 20);
      const limiteUso = a.limite_uso === undefined ? 1 : parseInt(a.limite_uso, 10);
      const limitePorUsuario = a.limite_por_usuario === undefined ? 1 : parseInt(a.limite_por_usuario, 10);
      if (!admin) {
        if (a.tipo === "percent" && valor > maxPct) falha(`Editores podem criar cupom de até ${maxPct}%. Peça a um administrador.`);
        if (a.tipo !== "percent" && valor > maxFixo) falha(`Editores podem criar cupom de até R$ ${maxFixo}. Peça a um administrador.`);
        if (!(limiteUso >= 1 && limiteUso <= maxUsos)) falha(`Editores precisam definir de 1 a ${maxUsos} usos.`);
      }

      let produtos = [];
      if (Array.isArray(a.produto_ids) && a.produto_ids.length) {
        produtos = await produtosPorIds(c.env, a.loja, a.produto_ids);
      }
      let cat = null;
      if (a.categoria) cat = await resolverCategoria(c.env, a.loja, a.categoria);

      let validadeWoo = null;
      if (a.validade) {
        if (!dataValida(a.validade)) falha("Validade no formato AAAA-MM-DD.");
        const d = new Date(a.validade + "T00:00:00Z");
        d.setUTCDate(d.getUTCDate() + 1); // o WooCommerce expira à 00:00 da data informada
        validadeWoo = d.toISOString().slice(0, 10) + "T00:00:00";
      }
      const emails = (a.emails || []).map((e) => String(e).trim().toLowerCase()).filter(Boolean);
      if (emails.some((e) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e))) falha("Há e-mail inválido na restrição.");

      let codigo;
      if (a.codigo) {
        codigo = String(a.codigo).trim().toLowerCase();
        if (!/^[a-z0-9_-]{4,40}$/.test(codigo)) falha("Código deve ter de 4 a 40 caracteres: letras, números, - ou _.");
        const { dados } = await woo(c.env, a.loja, "GET", "coupons", { query: { code: codigo, _fields: "id" } });
        if (dados.length) falha(`Já existe um cupom com o código ${codigo}.`);
      } else {
        for (let i = 0; i < 5 && !codigo; i++) {
          const tentativa = aleatorio(8, ALFA36);
          const { dados } = await woo(c.env, a.loja, "GET", "coupons", { query: { code: tentativa, _fields: "id" } });
          if (!dados.length) codigo = tentativa;
        }
        if (!codigo) falha("Não consegui gerar um código livre. Tente de novo.");
      }

      const corpo = {
        code: codigo,
        discount_type: a.tipo,
        amount: String(valor),
        individual_use: false,
        product_ids: produtos.map((p) => p.id),
        product_categories: cat ? [cat.id] : [],
        usage_limit: limiteUso > 0 ? limiteUso : null,
        usage_limit_per_user: limitePorUsuario > 0 ? limitePorUsuario : null,
        limit_usage_to_x_items: a.limitar_itens ? parseInt(a.limitar_itens, 10) : null,
        date_expires: validadeWoo,
        email_restrictions: emails,
        description: `${a.descricao ? a.descricao + " " : ""}[criado via MCP por ${c.usuario.nome}]`,
      };
      const { dados: cupom } = await woo(c.env, a.loja, "POST", "coupons", { corpo });
      const resumo = {
        id: cupom.id,
        codigo: cupom.code,
        tipo: cupom.discount_type,
        valor: cupom.amount,
        produtos: produtos.map((p) => `${p.id} ${p.name}`),
        categoria: cat?.nome || null,
        vale_para: produtos.length || cat ? "restrito" : "loja inteira",
        limite_uso: cupom.usage_limit ?? "ilimitado",
        limite_por_usuario: cupom.usage_limit_per_user ?? "ilimitado",
        limitar_itens: cupom.limit_usage_to_x_items,
        validade: a.validade || null,
        emails,
        painel: `https://${LOJAS[a.loja].host}/wp-admin/post.php?post=${cupom.id}&action=edit`,
      };
      return { dados: { loja: a.loja, cupom: resumo }, log: { alvo: `cupom ${cupom.code} (#${cupom.id})`, depois: resumo } };
    },
  },

  {
    nome: "alterar_preco_parcelas",
    titulo: "Alterar preço e parcelas",
    tipo: "escrita",
    papel: "editor",
    destrutiva: true,
    descricao:
      "Altera preço regular e/ou número máximo de parcelas (plugin WooCommerce Parcelas) de produtos simples. Funciona " +
      "em duas etapas obrigatórias: 1) chame com aplicar=false para gerar o plano e o codigo_confirmacao; 2) mostre o " +
      "plano ao usuário e, só com confirmação explícita, chame de novo com os mesmos parâmetros, aplicar=true e o " +
      "codigo_confirmacao. Use 'itens' para uma lista explícita, ou 'filtro' + 'regra' para uma categoria inteira. " +
      "Regras: manter_parcela (muda a quantidade mantendo o valor da parcela, ex.: 5x para 4x; use com " +
      "filtro.parcelas_atuais), percentual (pct negativo = desconto), fixo (mesmo preço para todos) e so_parcelas (muda " +
      "só a quantidade). Não altera preço promocional. Parcelas vêm do plugin WooCommerce Parcelas: 'global' = o " +
      "produto herda a configuração global do plugin; número = sobrescrita no próprio produto. Antes de simular, conte " +
      "quantos produtos estão em cada caso e informe ao usuário: se todos herdam o global, mudar a quantidade é uma única " +
      "alteração no wp-admin do plugin (afeta a loja inteira, confirme com o usuário) e não deve ser feita por aqui; " +
      "se é misturado, definir parcelas_para sem parcelas_atuais grava sobrescrita nos que herdavam. O valor mínimo da " +
      "parcela do plugin pode fazer a vitrine mostrar menos parcelas que o configurado. Ao mostrar o plano: produtos, " +
      "faixas 'preço antes -> depois', quem herdava o global, quem tem promoção e quem ficou de fora com o motivo. " +
      "Depois de aplicar, só declare sucesso se 'falhas' vier vazio, e peça para conferir a página pública de um " +
      "produto. Para desfazer, use 'itens' com os valores antigos do plano (passando de novo por simulação).",
    entrada: {
      type: "object",
      properties: {
        loja: P_LOJA,
        itens: {
          type: "array",
          maxItems: 200,
          items: {
            type: "object",
            properties: { id: { type: "integer" }, preco: { type: "number" }, parcelas: { type: "integer" } },
            required: ["id"],
          },
          description: "Lista explícita: novo preço e/ou parcelas por produto",
        },
        filtro: {
          type: "object",
          properties: {
            categoria: { type: "string" },
            status: { type: "string", enum: ["publish", "private", "draft", "any"], description: "Padrão: publish" },
            parcelas_atuais: { type: "integer", description: "Só produtos que hoje estão em N parcelas" },
          },
          required: ["categoria"],
        },
        regra: {
          type: "object",
          properties: {
            tipo: { type: "string", enum: ["manter_parcela", "percentual", "fixo", "so_parcelas"] },
            parcelas_para: { type: "integer", minimum: 1, maximum: 24 },
            pct: { type: "number" },
            valor: { type: "number" },
          },
          required: ["tipo"],
        },
        aplicar: { type: "boolean", description: "false = só simula (padrão). true = grava, exige codigo_confirmacao." },
        codigo_confirmacao: { type: "string" },
        motivo: P_MOTIVO,
      },
      required: ["loja", "motivo"],
    },
    async executar(a, c) {
      const temItens = Array.isArray(a.itens) && a.itens.length > 0;
      const temRegra = !!(a.regra && a.filtro);
      if (!temItens && !temRegra) falha("Informe 'itens' (lista explícita) ou 'filtro' + 'regra'.");
      if (temItens && temRegra) falha("Use 'itens' ou 'filtro' + 'regra', não os dois.");

      let produtos;
      let escopo;
      const pedidoPorId = {};
      const r = a.regra || {};
      if (temItens) {
        if (a.itens.length > 200) falha("Máximo de 200 produtos por chamada.");
        for (const it of a.itens) pedidoPorId[parseInt(it.id, 10)] = it;
        produtos = await produtosPorIds(c.env, a.loja, Object.keys(pedidoPorId));
        escopo = `${produtos.length} produtos por ID`;
      } else {
        if (!["manter_parcela", "percentual", "fixo", "so_parcelas"].includes(r.tipo)) falha("regra.tipo inválido.");
        const cat = await resolverCategoria(c.env, a.loja, a.filtro.categoria);
        const st = a.filtro.status || "publish";
        produtos = await produtosDaCategoria(c.env, a.loja, cat.id, st);
        escopo = `categoria ${cat.nome}, status ${st}` + (a.filtro.parcelas_atuais ? `, hoje em ${a.filtro.parcelas_atuais}x` : "");
      }
      if (produtos.length > 200) falha("Mais de 200 produtos no escopo. Divida em partes menores.");

      const plano = [];
      const fora = [];
      for (const p of produtos) {
        const { meta, qtd } = parcelamento(p);
        const deixar = (m) => fora.push({ id: p.id, nome: p.name, motivo: m });
        if (p.type !== "simple") {
          deixar(`tipo ${p.type}: o preço fica nas variações`);
          continue;
        }
        if (temRegra && a.filtro.parcelas_atuais && qtd !== String(a.filtro.parcelas_atuais)) {
          deixar(`hoje está em ${qtd || "parcelamento global"}`);
          continue;
        }
        const antigo = centavos(p.regular_price);
        let novo = antigo;
        let novaQtd = qtd ? parseInt(qtd, 10) : null;
        if (temItens) {
          const it = pedidoPorId[p.id];
          if (it.preco !== undefined && it.preco !== null && it.preco !== "") novo = centavos(it.preco);
          if (it.parcelas) novaQtd = parseInt(it.parcelas, 10);
        } else if (r.tipo === "manter_parcela") {
          if (!r.parcelas_para) falha("manter_parcela exige regra.parcelas_para.");
          if (!qtd) {
            deixar("herda o parcelamento global: não há parcela própria para manter (use itens ou so_parcelas)");
            continue;
          }
          novo = Math.round((antigo / parseInt(qtd, 10)) * r.parcelas_para);
          novaQtd = parseInt(r.parcelas_para, 10);
        } else if (r.tipo === "percentual") {
          if (typeof r.pct !== "number") falha("percentual exige regra.pct (negativo = desconto).");
          novo = Math.round(antigo * (1 + r.pct / 100));
          if (r.parcelas_para) novaQtd = parseInt(r.parcelas_para, 10);
        } else if (r.tipo === "fixo") {
          if (r.valor === undefined || r.valor === null) falha("fixo exige regra.valor.");
          novo = centavos(r.valor);
          if (r.parcelas_para) novaQtd = parseInt(r.parcelas_para, 10);
        } else if (r.tipo === "so_parcelas") {
          if (!r.parcelas_para) falha("so_parcelas exige regra.parcelas_para.");
          novaQtd = parseInt(r.parcelas_para, 10);
        }
        if (!(novo > 0)) {
          deixar("preço resultante inválido");
          continue;
        }
        if (novaQtd !== null && !(novaQtd >= 1 && novaQtd <= 24)) falha("Parcelas devem ficar entre 1 e 24.");
        const qtdMuda = novaQtd !== null && String(novaQtd) !== qtd;
        if (novo === antigo && !qtdMuda) {
          deixar("já está no valor pedido");
          continue;
        }
        plano.push({
          id: p.id,
          nome: p.name,
          preco_antes: dinheiro(antigo),
          preco_depois: dinheiro(novo),
          parcelas_antes: qtd || "global",
          parcelas_depois: novaQtd ? String(novaQtd) : qtd || "global",
          parcela: novaQtd ? dinheiro(Math.round(novo / novaQtd)) : null,
          promocional: p.sale_price || null,
          _meta: meta,
          _qtdMuda: qtdMuda,
          _precoMuda: novo !== antigo,
        });
      }

      const publico = (x) => {
        const { _meta, _qtdMuda, _precoMuda, ...resto } = x;
        return resto;
      };
      const codigo = (
        await sha256(
          JSON.stringify([a.loja, plano.map((x) => [x.id, x.preco_antes, x.preco_depois, x.parcelas_antes, x.parcelas_depois])])
        )
      ).slice(0, 8);
      const avisos = [];
      if (plano.some((x) => x.promocional)) avisos.push("Há produtos com preço promocional: a vitrine mostra o promocional.");
      if (plano.some((x) => x.parcelas_antes === "global" && x.parcelas_depois !== "global")) {
        avisos.push("Alguns produtos herdavam o parcelamento global; passarão a ter parcelamento próprio.");
      }

      if (!a.aplicar) {
        return {
          dados: {
            simulacao: true,
            loja: a.loja,
            escopo,
            total_alterar: plano.length,
            plano: plano.map(publico),
            fora,
            avisos,
            codigo_confirmacao: plano.length ? codigo : null,
            proximo_passo: plano.length
              ? "Mostre o plano ao usuário. Só com confirmação explícita, chame de novo com aplicar=true e este codigo_confirmacao."
              : "Nada a alterar.",
          },
          log: { resultado: "simulacao", alvo: `${plano.length} produtos (${escopo})` },
        };
      }

      if (!plano.length) falha("Nada a alterar com esses parâmetros.");
      if (a.codigo_confirmacao !== codigo) {
        falha("O plano mudou desde a simulação ou o código não confere. Rode a simulação de novo e confirme com o usuário.");
      }

      const atualizacoes = plano.map((x) => {
        const u = { id: x.id };
        if (x._precoMuda) u.regular_price = x.preco_depois;
        if (x._qtdMuda) {
          const base = x._meta || { disable_installments: "0", disable_in_cash: "0", in_cash_discount: "", in_cash_discount_type: null };
          u.meta_data = [{ key: META_PARCELAS, value: { ...base, installment_qty: x.parcelas_depois } }];
        }
        return u;
      });
      let feitos = 0;
      let erroLote = null;
      for (let i = 0; i < atualizacoes.length && !erroLote; i += 25) {
        try {
          const { dados } = await woo(c.env, a.loja, "POST", "products/batch", { corpo: { update: atualizacoes.slice(i, i + 25) } });
          const erros = (dados.update || []).filter((x) => x.error);
          feitos += (dados.update || []).length - erros.length;
          if (erros.length) erroLote = erros.map((x) => `${x.id}: ${x.error.message}`).join("; ");
        } catch (e) {
          erroLote = e.message;
        }
      }

      const depoisLista = await produtosPorIds(c.env, a.loja, plano.map((x) => x.id));
      const mapa = Object.fromEntries(depoisLista.map((p) => [p.id, p]));
      const falhas = [];
      for (const x of plano) {
        const p = mapa[x.id];
        const q = parcelamento(p).qtd || "global";
        if (dinheiro(centavos(p.regular_price)) !== x.preco_depois || q !== x.parcelas_depois) {
          falhas.push({ id: x.id, nome: x.nome, preco_agora: p.regular_price, parcelas_agora: q });
        }
      }
      const antes = Object.fromEntries(plano.map((x) => [x.id, { preco: x.preco_antes, parcelas: x.parcelas_antes }]));
      const depois = Object.fromEntries(plano.map((x) => [x.id, { preco: x.preco_depois, parcelas: x.parcelas_depois }]));
      return {
        dados: {
          aplicado: true,
          loja: a.loja,
          escopo,
          atualizados: feitos,
          verificados_ok: plano.length - falhas.length,
          falhas,
          erro: erroLote,
          avisos,
          conferir: "Abra a página pública de um produto alterado: cache do site pode segurar o valor antigo.",
        },
        log: {
          resultado: erroLote || falhas.length ? "parcial" : "ok",
          alvo: `${plano.length} produtos (${escopo})`,
          antes,
          depois,
          detalhe: erroLote,
        },
      };
    },
  },

  {
    nome: "relatorio_vendas",
    titulo: "Relatório de vendas",
    tipo: "leitura",
    papel: "leitor",
    idempotente: true,
    descricao:
      "Lista itens vendidos num período, com filtro por produto (texto ou IDs) ou categoria. Por padrão considera só " +
      "pedidos Concluídos, Processando e Aguardando (exclui cancelados, reembolsados e falhos) e ignora pedidos de " +
      "e-mails internos da agência. Extrai o nome do aluno de e-mails @...g12.br; o nome de cobrança é do responsável. " +
      "Devolve resumo completo e as linhas em páginas de 250 (use 'pagina' para as seguintes). Se o usuário não disser " +
      "o ano ou período, pergunte antes: produtos se repetem todo ano. Para planilha, junte todas as páginas e monte " +
      "um .xlsx do seu lado, aba 'Relatório', exatamente com as colunas Pedido, Data, Status, Método de Pagamento, " +
      "Email, Aluno, Produto, Qtde, Valor (nessa ordem; Responsável e ID produto não entram), Valor como texto com 2 " +
      "casas (ex.: '180.00'), cabeçalho em negrito, primeira linha congelada, larguras ajustadas, ordenado por data. " +
      "No chat, mostre só o resumo (pedidos, itens, receita, por status, por produto, internos ignorados); nomes e " +
      "e-mails ficam só na planilha.",
    entrada: {
      type: "object",
      properties: {
        loja: P_LOJA,
        data_inicio: { type: "string", description: "AAAA-MM-DD" },
        data_fim: { type: "string", description: "AAAA-MM-DD" },
        produto: { type: "string", description: "Trecho do nome do produto vendido" },
        produto_ids: { type: "array", items: { type: "integer" } },
        categoria: { type: "string", description: "Nome, slug ou ID da categoria" },
        status: {
          type: "array",
          items: { type: "string", enum: Object.keys(STATUS_PEDIDO) },
          description: "Padrão: completed, processing, on-hold",
        },
        pagina: { type: "integer", minimum: 1, description: "Página de linhas. Padrão: 1" },
      },
      required: ["loja", "data_inicio", "data_fim"],
    },
    async executar(a, c) {
      if (!dataValida(a.data_inicio) || !dataValida(a.data_fim)) falha("Datas no formato AAAA-MM-DD.");
      const status = Array.isArray(a.status) && a.status.length ? a.status : ["completed", "processing", "on-hold"];
      let idsFiltro = null;
      let catNome = null;
      if (a.categoria) {
        const cat = await resolverCategoria(c.env, a.loja, a.categoria);
        catNome = cat.nome;
        idsFiltro = new Set((await produtosDaCategoria(c.env, a.loja, cat.id, "any")).map((p) => p.id));
      }
      if (Array.isArray(a.produto_ids) && a.produto_ids.length) {
        const s = new Set(a.produto_ids.map(Number));
        idsFiltro = idsFiltro ? new Set([...idsFiltro].filter((x) => s.has(x))) : s;
      }
      const termo = a.produto ? norm(a.produto) : null;
      let filtrarNome = !!termo;
      if (termo && !idsFiltro) {
        // Descobre os produtos pelo nome e filtra pedidos por ID (bem mais leve que varrer tudo)
        const achados = [];
        for (let page = 1; page <= 2; page++) {
          const { dados } = await woo(c.env, a.loja, "GET", "products", {
            query: { search: a.produto, status: "any", per_page: 100, page, _fields: "id" },
          });
          achados.push(...dados.map((p) => p.id));
          if (dados.length < 100) break;
        }
        idsFiltro = new Set(achados);
        filtrarNome = false;
      }
      const excluir = new Set(lista(c.env.EXCLUIR_EMAILS || "login@resultzads.com").map((e) => e.toLowerCase()));
      const consultaBase = {
        after: `${a.data_inicio}T00:00:00`,
        before: `${a.data_fim}T23:59:59`,
        status,
        per_page: 100,
        orderby: "date",
        order: "asc",
        _fields: "id,number,status,date_created,payment_method_title,billing,line_items",
      };

      const pedidosMap = new Map();
      let truncado = false;
      const coletar = async (extra, maxPag) => {
        for (let page = 1; page <= maxPag; page++) {
          const { dados, paginas } = await woo(c.env, a.loja, "GET", "orders", { query: { ...consultaBase, ...extra, page } });
          for (const o of dados) pedidosMap.set(o.id, o);
          if (page >= paginas || dados.length < 100) return;
          if (page === maxPag) truncado = true;
        }
      };
      if (idsFiltro && idsFiltro.size === 0) {
        // nenhum produto corresponde ao filtro
      } else if (idsFiltro && idsFiltro.size <= 40) {
        for (const pid of idsFiltro) await coletar({ product: pid }, 10);
      } else {
        await coletar({}, 35);
      }

      const linhas = [];
      let excluidos = 0;
      const ordenados = [...pedidosMap.values()].sort((x, y) => String(x.date_created).localeCompare(String(y.date_created)));
      for (const o of ordenados) {
        const email = String(o.billing?.email || "").toLowerCase();
        if (excluir.has(email)) {
          excluidos++;
          continue;
        }
        for (const it of o.line_items || []) {
          if (idsFiltro && !idsFiltro.has(it.product_id)) continue;
          if (filtrarNome && !norm(it.name).includes(termo)) continue;
          linhas.push([
            String(o.number || o.id),
            o.date_created,
            STATUS_PEDIDO[o.status] || o.status,
            o.payment_method_title || "",
            email,
            alunoDoEmail(email),
            `${o.billing?.first_name || ""} ${o.billing?.last_name || ""}`.trim(),
            it.name,
            it.product_id,
            it.quantity,
            it.total,
          ]);
        }
      }
      const lidos = pedidosMap.size;

      const pedidos = new Set();
      const porStatus = {};
      const porProduto = {};
      let receita = 0;
      for (const l of linhas) {
        pedidos.add(l[0]);
        receita += centavos(l[10]);
        porStatus[l[2]] = (porStatus[l[2]] || 0) + 1;
        const k = l[7];
        porProduto[k] = porProduto[k] || { produto: k, itens: 0, receita: 0 };
        porProduto[k].itens += Number(l[9]) || 0;
        porProduto[k].receita += centavos(l[10]);
      }
      const TAM = 250;
      const totalPaginas = Math.max(1, Math.ceil(linhas.length / TAM));
      const pagina = Math.min(Math.max(parseInt(a.pagina || 1, 10), 1), totalPaginas);
      return {
        dados: {
          loja: a.loja,
          periodo: `${a.data_inicio} a ${a.data_fim}`,
          filtros: { produto: a.produto || null, produto_ids: a.produto_ids || null, categoria: catNome, status },
          resumo: {
            pedidos: pedidos.size,
            itens: linhas.length,
            receita: dinheiro(receita),
            por_status: porStatus,
            por_produto: Object.values(porProduto)
              .sort((x, y) => y.receita - x.receita)
              .map((x) => ({ ...x, receita: dinheiro(x.receita) })),
          },
          pedidos_lidos: lidos,
          pedidos_internos_ignorados: excluidos,
          aviso: truncado ? "Período com pedidos demais: resultado truncado. Reduza o período." : null,
          colunas: ["Pedido", "Data", "Status", "Pagamento", "Email", "Aluno", "Responsável", "Produto", "ID produto", "Qtde", "Valor"],
          pagina,
          total_paginas: totalPaginas,
          linhas: linhas.slice((pagina - 1) * TAM, pagina * TAM),
        },
        log: { alvo: `${linhas.length} itens de ${pedidos.size} pedidos`, detalhe: `página ${pagina}/${totalPaginas}` },
      };
    },
  },
];

/* ------------------------------------------------------------------ Sumaré (Dash de Captação, API Softsy) */

const SUMARE_API = "https://gateway-sumare.softsy.io/dash-captacao/api/integracao/v1";
// argumento da ferramenta -> [lista em /filtros, parâmetro de /candidatos]
const SUMARE_FILTROS = {
  polo: ["polos", "polos"],
  curso: ["cursos", "cursos"],
  area: ["areas", "areas"],
  tipo_ingresso: ["tiposIngresso", "tiposIngresso"],
  turno: ["turnos", "turnos"],
  concurso: ["concursos", "concursos"],
  etapa: ["etapas", "etapas"],
};
const SUMARE_CHAVES = {
  curso: (x) => x.nomeCurso,
  curso_codigo: (x) => x.curso,
  polo: (x) => x.nomePolo,
  area: (x) => x.area,
  tipo_ingresso: (x) => x.tipoIngresso,
  turno: (x) => x.descricaoTurno,
  concurso: (x) => x.concurso,
  campanha: (x) => x.campanha,
  status: (x) => x.statusDescricao,
  etapa: (x) => x.etapa,
};
const SUMARE_COLUNAS = [
  "candidato", "nome", "email", "whatsapp", "cpf", "nomeCurso", "descricaoTurno", "nomePolo", "area", "tipoIngresso",
  "concurso", "campanha", "etapa", "statusDescricao", "diasParado", "dtInscricao", "dtAssinaturaContrato", "dtMatricula",
  "qtdTentativas", "ultimaTentativaTipo", "ultimaTentativaData", "ultimaTentativaVencimento", "aluno",
];

async function sumare(env, caminho, query = {}) {
  if (!env.SUMARE_API_USER || !env.SUMARE_API_PASS) {
    falha("A credencial da API da Sumaré não está configurada no servidor (SUMARE_API_USER / SUMARE_API_PASS).");
  }
  const url = new URL(`${SUMARE_API}/${caminho}`);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const resp = await fetch(url.toString(), {
    headers: {
      Authorization: "Basic " + btoa(`${env.SUMARE_API_USER}:${env.SUMARE_API_PASS}`),
      Accept: "application/json",
      "User-Agent": "Resultz-MCP/" + VERSAO,
    },
  });
  const bruto = await resp.text();
  if (resp.status === 401) falha("A API da Sumaré recusou a credencial (401). Ela pode ter sido trocada: avise o Lucas.");
  if (!resp.ok) falha(`A API da Sumaré respondeu ${resp.status}: ${bruto.slice(0, 200)}`);
  try {
    return JSON.parse(bruto);
  } catch {
    falha("Resposta inesperada da API da Sumaré (não veio JSON).");
  }
}

let sumareFiltrosCache = null;
async function sumareFiltros(env) {
  if (sumareFiltrosCache && Date.now() - sumareFiltrosCache.em < 10 * 60 * 1000) return sumareFiltrosCache.dados;
  const dados = await sumare(env, "filtros");
  sumareFiltrosCache = { em: Date.now(), dados };
  return dados;
}

const valores = (v) => (Array.isArray(v) ? v.map(String).filter(Boolean) : lista(v));
const opcaoSumare = (o) =>
  typeof o === "string"
    ? { codigo: o, descricao: o }
    : { codigo: String(o.codigo ?? o.id ?? ""), descricao: String(o.descricao ?? o.nome ?? o.codigo ?? "") };

function sumareResolver(valor, opcoes, rotulo) {
  const out = new Set();
  for (const v of valores(valor)) {
    const exatos = opcoes.filter((o) => norm(o.codigo) === norm(v) || norm(o.descricao) === norm(v));
    const achados = exatos.length ? exatos : opcoes.filter((o) => norm(o.descricao).includes(norm(v)));
    if (!achados.length) {
      const nomes = [...new Set(opcoes.map((o) => o.descricao))].sort();
      falha(`"${v}" não encontrado em ${rotulo}. Opções: ${nomes.slice(0, 80).join("; ")}`);
    }
    for (const o of achados) out.add(o.codigo);
  }
  return [...out];
}

const ehTesteSumare = (x) => String(x.email || "").toLowerCase().split("@")[0] === "teste";

// Busca candidatos com os filtros da ferramenta. 'fixos' sobrescreve parâmetros (ex.: etapas=CONVERTIDO).
async function sumareCandidatos(c, a, fixos = {}) {
  const filtros = await sumareFiltros(c.env);
  const query = { tamanho: 5000 };
  for (const [arg, [chave, param]] of Object.entries(SUMARE_FILTROS)) {
    if (valores(a[arg]).length) {
      query[param] = sumareResolver(a[arg], (filtros[chave] || []).map(opcaoSumare), chave).join(",");
    }
  }
  if (valores(a.status).length) query.status = valores(a.status).map((x) => x.toUpperCase()).join(",");
  Object.assign(query, fixos);

  const itens = [];
  let meta = {};
  for (let pagina = 1; pagina <= 10; pagina++) {
    meta = await sumare(c.env, "candidatos", { ...query, pagina });
    itens.push(...(meta.itens || []));
    if (pagina >= (meta.totalPaginas || 1)) break;
  }
  const testes = itens.filter(ehTesteSumare).length;
  let lst = a.incluir_testes ? itens : itens.filter((x) => !ehTesteSumare(x));
  if (valores(a.campanha).length) {
    const alvo = valores(a.campanha).map(norm);
    lst = lst.filter((x) => alvo.some((v) => norm(x.campanha).includes(v)));
  }
  if (a.dias_parado_min !== undefined && a.dias_parado_min !== null) {
    lst = lst.filter((x) => (x.diasParado || 0) >= Number(a.dias_parado_min));
  }
  const { tamanho, ...aplicados } = query;
  if (valores(a.campanha).length) aplicados.campanha = valores(a.campanha).join(",");
  return {
    itens: lst,
    testes: a.incluir_testes ? 0 : testes,
    base: String(meta.dadosDe || "").slice(0, 16).replace("T", " "),
    filtros: aplicados,
  };
}

const hojeBrasilia = () => new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);

function sumarePeriodo(a) {
  const hoje = hojeBrasilia();
  if (a.mes) {
    if (!/^\d{4}-\d{2}$/.test(String(a.mes))) falha("mes no formato AAAA-MM.");
    const [y, m] = a.mes.split("-").map(Number);
    const ini = `${a.mes}-01`;
    const fim = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    return [ini, ini <= hoje && hoje < fim ? hoje : fim];
  }
  if (a.data_inicio) {
    if (!dataValida(a.data_inicio) || (a.data_fim && !dataValida(a.data_fim))) falha("Datas no formato AAAA-MM-DD.");
    return [a.data_inicio, a.data_fim || hoje];
  }
  return [hoje.slice(0, 8) + "01", hoje];
}

function sumareQuebra(itens, detalhe, campo) {
  let chave;
  if (detalhe === "dia") chave = (x) => String(x[campo] || "").slice(0, 10);
  else if (detalhe === "semana") {
    chave = (x) => {
      const d = new Date(String(x[campo] || "").slice(0, 10) + "T00:00:00Z");
      d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); // segunda-feira da semana
      return d.toISOString().slice(0, 10);
    };
  } else chave = (x) => SUMARE_CHAVES[detalhe](x) || "(sem informação)";
  const cont = {};
  for (const x of itens) {
    const k = chave(x);
    cont[k] = (cont[k] || 0) + 1;
  }
  const pares = Object.entries(cont);
  pares.sort(detalhe === "dia" || detalhe === "semana" ? (p, q) => p[0].localeCompare(q[0]) : (p, q) => q[1] - p[1]);
  return pares.map(([valor, total]) => ({ [detalhe]: valor, total }));
}

const P_TEXTO_FILTRO = (rotulo) => ({
  type: "string",
  description: `${rotulo}: nome (ou parte, sem acento) ou código; vários separados por vírgula`,
});
const SUMARE_FILTROS_ENTRADA = {
  polo: P_TEXTO_FILTRO("Polo"),
  curso: P_TEXTO_FILTRO("Curso (um curso pode ter vários códigos; o nome pega todos)"),
  area: P_TEXTO_FILTRO("Área"),
  tipo_ingresso: P_TEXTO_FILTRO("Tipo de ingresso (ex.: Vestibular)"),
  turno: P_TEXTO_FILTRO("Turno"),
  concurso: P_TEXTO_FILTRO("Concurso"),
  campanha: P_TEXTO_FILTRO("Campanha"),
  incluir_testes: { type: "boolean", description: "Inclui registros de teste (e-mail teste@). Padrão: false" },
};
const DETALHES_SUMARE = ["curso", "curso_codigo", "polo", "area", "tipo_ingresso", "turno", "concurso", "campanha"];

const FERRAMENTAS_SUMARE = [
  {
    nome: "sumare_matriculas",
    titulo: "Matrículas e inscrições da Sumaré",
    tipo: "leitura",
    papel: "leitor",
    idempotente: true,
    descricao:
      "Conta matrículas (padrão) ou inscrições do Centro Universitário Sumaré num período, com quebra opcional e " +
      "comparação com o mês anterior. Matrícula = candidato CONVERTIDO com dtMatricula no período; inscrição = " +
      "dtInscricao no período. Conta inscrições, não pessoas: cpfs_unicos mostra pessoas distintas (a mesma pessoa pode " +
      "ter duas matrículas, ex.: graduação e pós). Sem período = do dia 1 do mês atual até hoje. Mapeamento: 'hoje', " +
      "'ontem', 'semana passada' -> data_inicio/data_fim; 'mês passado' -> mes; 'por polo' -> detalhe=polo; " +
      "'evolução' ou 'por dia' -> detalhe=dia. Para mês em andamento, o comparativo justo é mes_anterior.ate_mesmo_dia. " +
      "Responda curto: número principal em negrito com o período e o horário de base_atualizada_em (se for de um dia " +
      "anterior, avise que os dias seguintes não entram).",
    entrada: {
      type: "object",
      properties: {
        metrica: { type: "string", enum: ["matriculas", "inscricoes"], description: "Padrão: matriculas" },
        mes: { type: "string", description: "AAAA-MM (mês inteiro; se for o mês atual, vai até hoje)" },
        data_inicio: { type: "string", description: "AAAA-MM-DD" },
        data_fim: { type: "string", description: "AAAA-MM-DD, inclusivo. Padrão: hoje" },
        comparar: { type: "boolean", description: "Inclui o mês anterior fechado e até o mesmo dia" },
        detalhe: { type: "string", enum: [...DETALHES_SUMARE, "dia", "semana"], description: "Quebra do total" },
        ...SUMARE_FILTROS_ENTRADA,
      },
    },
    async executar(a, c) {
      const inscricoes = a.metrica === "inscricoes";
      const campo = inscricoes ? "dtInscricao" : "dtMatricula";
      const [ini, fim] = sumarePeriodo(a);
      const r = await sumareCandidatos(c, { ...a, etapa: undefined, status: undefined }, inscricoes ? {} : { etapas: "CONVERTIDO" });
      const noPeriodo = (x, i, f) => {
        const d = String(x[campo] || "").slice(0, 10);
        return d !== "" && d >= i && d <= f;
      };
      const sel = r.itens.filter((x) => noPeriodo(x, ini, fim));
      const dados = {
        base_atualizada_em: r.base,
        metrica: inscricoes ? "inscricoes" : "matriculas",
        periodo: `${ini} a ${fim}`,
        total: sel.length,
        cpfs_unicos: new Set(sel.map((x) => x.cpf)).size,
        filtros: r.filtros,
        registros_teste_excluidos: r.testes,
      };
      if (a.detalhe) dados.detalhe = sumareQuebra(sel, a.detalhe, campo);
      if (a.comparar) {
        const d = new Date(ini + "T00:00:00Z");
        d.setUTCDate(0); // último dia do mês anterior
        const pf = d.toISOString().slice(0, 10);
        const pi = pf.slice(0, 8) + "01";
        const prev = r.itens.filter((x) => noPeriodo(x, pi, pf));
        const ateDia = Math.min(Number(fim.slice(8, 10)), Number(pf.slice(8, 10)));
        dados.mes_anterior = {
          periodo: `${pi} a ${pf}`,
          total: prev.length,
          ate_mesmo_dia: { ate_dia: ateDia, total: prev.filter((x) => Number(String(x[campo]).slice(8, 10)) <= ateDia).length },
        };
      }
      return { dados, log: { alvo: `${dados.metrica} ${dados.periodo}: ${sel.length}` } };
    },
  },

  {
    nome: "sumare_funil",
    titulo: "Funil de captação da Sumaré",
    tipo: "leitura",
    papel: "leitor",
    idempotente: true,
    descricao:
      "Retrato atual do funil de candidatos da Sumaré (não depende de período): quantos em cada etapa e status, com " +
      "quebra opcional. Etapas: CONTRATO (não assinou; status PARADO_CONTRATO), PAGAMENTO (assinou, não pagou) e " +
      "CONVERTIDO (matriculado). Status em PAGAMENTO: INERTE_PAGAMENTO (assinou sem tentar pagar), PIX_VENCIDO, " +
      "BOLETO_VENCIDO, BOLETO_EM_COMPENSACAO, PIX_A_VENCER, BOLETO_A_VENCER, PAGO_AGUARDANDO_ALUNO (cartão aprovado), " +
      "CARTAO_RECUSADO. diasParado = há quantos dias o candidato não avança. Use para 'quem não pagou', 'boletos " +
      "vencidos', 'parados no contrato'. Devolve só contagens; para nomes e contatos use sumare_lista_candidatos.",
    entrada: {
      type: "object",
      properties: {
        etapa: P_TEXTO_FILTRO("Etapa (CONTRATO, PAGAMENTO, CONVERTIDO)"),
        status: { type: "string", description: "Código(s) de status, vírgula" },
        dias_parado_min: { type: "integer", minimum: 0, description: "Só candidatos parados há N dias ou mais" },
        detalhe: { type: "string", enum: [...DETALHES_SUMARE, "status"], description: "Abre cada valor por etapa" },
        ...SUMARE_FILTROS_ENTRADA,
      },
    },
    async executar(a, c) {
      const r = await sumareCandidatos(c, a);
      const conta = (f) => {
        const o = {};
        for (const x of r.itens) {
          const k = f(x);
          o[k] = (o[k] || 0) + 1;
        }
        return o;
      };
      const porStatus = conta((x) => `${x.etapa}|${x.statusDescricao || x.status}`);
      const dados = {
        base_atualizada_em: r.base,
        total_candidatos: r.itens.length,
        cpfs_unicos: new Set(r.itens.map((x) => x.cpf)).size,
        por_etapa: conta((x) => x.etapa),
        por_status: Object.entries(porStatus)
          .sort((p, q) => q[1] - p[1])
          .map(([k, total]) => ({ etapa: k.split("|")[0], status: k.split("|")[1], total })),
        filtros: r.filtros,
        registros_teste_excluidos: r.testes,
      };
      if (a.detalhe) {
        const grupos = {};
        for (const x of r.itens) {
          const k = SUMARE_CHAVES[a.detalhe](x) || "(sem informação)";
          grupos[k] = grupos[k] || {};
          grupos[k][x.etapa] = (grupos[k][x.etapa] || 0) + 1;
        }
        dados.detalhe = Object.entries(grupos)
          .map(([valor, etapas]) => ({ [a.detalhe]: valor, ...etapas, total: Object.values(etapas).reduce((s, n) => s + n, 0) }))
          .sort((p, q) => q.total - p.total);
      }
      return { dados, log: { alvo: `funil: ${r.itens.length} candidatos` } };
    },
  },

  {
    nome: "sumare_lista_candidatos",
    titulo: "Lista de candidatos da Sumaré (dados pessoais)",
    tipo: "leitura",
    papel: "editor",
    exigeMotivo: true,
    idempotente: true,
    descricao:
      "Lista candidatos com dados pessoais (nome, CPF, e-mail, WhatsApp) para a equipe comercial, ex.: recuperação de " +
      "boletos/PIX vencidos ou parados no contrato. Exige 'motivo' (o pedido do usuário nas palavras dele): fica no log " +
      "quem puxou, por quê, filtros e quantidade. Ordenado por diasParado (maior primeiro), em páginas de 250 (use " +
      "'pagina'). Dados pessoais NÃO vão para o chat: junte todas as páginas e gere uma planilha .xlsx (aba " +
      "'Candidatos', cabeçalho em negrito com fundo #FFCA00, primeira linha congelada, filtro automático, larguras " +
      "ajustadas) e no chat mostre só quantos candidatos e o resumo por etapa/status. Use só para o fim pedido.",
    entrada: {
      type: "object",
      properties: {
        etapa: P_TEXTO_FILTRO("Etapa (CONTRATO, PAGAMENTO, CONVERTIDO)"),
        status: { type: "string", description: "Código(s) de status, vírgula (ex.: BOLETO_VENCIDO,PIX_VENCIDO)" },
        dias_parado_min: { type: "integer", minimum: 0, description: "Só candidatos parados há N dias ou mais" },
        ...SUMARE_FILTROS_ENTRADA,
        pagina: { type: "integer", minimum: 1, description: "Página de linhas. Padrão: 1" },
        motivo: P_MOTIVO,
      },
      required: ["motivo"],
    },
    async executar(a, c) {
      const r = await sumareCandidatos(c, a);
      const base = [...r.itens].sort((p, q) => (q.diasParado || 0) - (p.diasParado || 0));
      const TAM = 250;
      const totalPaginas = Math.max(1, Math.ceil(base.length / TAM));
      const pagina = Math.min(Math.max(parseInt(a.pagina || 1, 10), 1), totalPaginas);
      const resumo = {};
      for (const x of base) {
        const k = `${x.etapa} / ${x.statusDescricao || x.status}`;
        resumo[k] = (resumo[k] || 0) + 1;
      }
      return {
        dados: {
          base_atualizada_em: r.base,
          total: base.length,
          resumo_por_status: resumo,
          filtros: r.filtros,
          colunas: SUMARE_COLUNAS,
          pagina,
          total_paginas: totalPaginas,
          linhas: base.slice((pagina - 1) * TAM, pagina * TAM).map((x) => SUMARE_COLUNAS.map((k) => x[k] ?? null)),
        },
        log: { alvo: `${base.length} candidatos`, detalhe: `página ${pagina}/${totalPaginas}; filtros ${JSON.stringify(r.filtros)}` },
      };
    },
  },

  {
    nome: "sumare_opcoes",
    titulo: "Opções de filtro da Sumaré",
    tipo: "leitura",
    papel: "leitor",
    idempotente: true,
    descricao:
      "Lista os valores aceitos nos filtros (cursos, polos, áreas, tipos de ingresso, turnos, concursos, campanhas, " +
      "etapas), com nome e código. Use quando o usuário citar um curso ou polo ambíguo.",
    entrada: { type: "object", properties: {} },
    async executar(a, c) {
      const f = await sumareFiltros(c.env);
      const dados = {};
      for (const [k, v] of Object.entries(f)) {
        if (Array.isArray(v)) dados[k] = v.map(opcaoSumare).map((o) => (o.codigo === o.descricao ? o.codigo : `${o.descricao} (${o.codigo})`));
      }
      return { dados, log: {} };
    },
  },
];

/* ------------------------------------------------------------------ ferramentas comuns a todas as áreas */

const FERRAMENTAS_COMUNS = [
  {
    nome: "meu_acesso",
    titulo: "Meu acesso",
    tipo: "leitura",
    papel: "leitor",
    idempotente: true,
    descricao: "Mostra quem está conectado, o papel, as áreas liberadas e, nas lojas, as lojas e os limites que se aplicam.",
    entrada: { type: "object", properties: {} },
    async executar(a, c) {
      const u = c.usuario;
      return {
        dados: {
          nome: u.nome,
          papel: u.papel,
          areas: u.areas === "*" ? NOMES_AREAS : lista(u.areas),
          ...(c.nomeArea === "lojas" && {
            lojas: u.lojas === "*" ? Object.keys(LOJAS) : lista(u.lojas),
            limites_editor: {
              cupom_max_percentual: cfgNum(c.env, "CUPOM_MAX_PCT_EDITOR", 50),
              cupom_max_reais: cfgNum(c.env, "CUPOM_MAX_FIXO_EDITOR", 300),
              cupom_max_usos: cfgNum(c.env, "CUPOM_MAX_USOS_EDITOR", 20),
            },
          }),
          ferramentas: ferramentasDe(c).map((f) => f.nome),
        },
        log: {},
      };
    },
  },

  {
    nome: "consultar_log",
    titulo: "Consultar log de auditoria",
    tipo: "admin",
    papel: "admin",
    idempotente: true,
    descricao:
      "Mostra o histórico de ações feitas pelos conectores: quem, quando (horário de Brasília), ferramenta, loja, " +
      "motivo, alvo, antes/depois e resultado. Filtros opcionais por pessoa, loja, ferramenta e período.",
    entrada: {
      type: "object",
      properties: {
        usuario: { type: "string", description: "Nome (ou parte do nome) da pessoa" },
        loja: P_LOJA,
        ferramenta: { type: "string" },
        desde: { type: "string", description: "AAAA-MM-DD" },
        ate: { type: "string", description: "AAAA-MM-DD" },
        so_alteracoes: { type: "boolean", description: "Só ações que mudaram algo. Padrão: false" },
        limite: { type: "integer", minimum: 1, maximum: 500, description: "Padrão: 50" },
      },
    },
    async executar(a, c) {
      const onde = ["ferramenta <> 'consultar_log'"];
      const vals = [];
      const add = (cond, v) => {
        vals.push(v);
        onde.push(cond.replace("?", `?${vals.length}`));
      };
      if (a.usuario) add("usuario LIKE ?", `%${a.usuario}%`);
      if (a.loja) add("loja = ?", a.loja);
      if (a.ferramenta) add("ferramenta = ?", a.ferramenta);
      if (a.desde) {
        if (!dataValida(a.desde)) falha("desde no formato AAAA-MM-DD.");
        add("ts >= ?", `${a.desde} 03:00:00`); // 00:00 em Brasília = 03:00 UTC
      }
      if (a.ate) {
        if (!dataValida(a.ate)) falha("ate no formato AAAA-MM-DD.");
        const d = new Date(a.ate + "T00:00:00Z");
        d.setUTCDate(d.getUTCDate() + 1);
        add("ts < ?", `${d.toISOString().slice(0, 10)} 03:00:00`);
      }
      if (a.so_alteracoes) onde.push("tipo IN ('escrita','admin') AND resultado NOT IN ('simulacao','erro')");
      const limite = Math.min(Math.max(parseInt(a.limite || 50, 10), 1), 500);
      vals.push(limite);
      const { results } = await c.env.DB.prepare(
        `SELECT id, ts, usuario, ferramenta, tipo, loja, motivo, alvo, antes, depois, resultado, detalhe
         FROM log WHERE ${onde.join(" AND ")} ORDER BY id DESC LIMIT ?${vals.length}`
      )
        .bind(...vals)
        .all();
      return {
        dados: {
          total: results.length,
          registros: results.map((x) => ({
            id: x.id,
            quando: horaBrasilia(x.ts),
            usuario: x.usuario,
            ferramenta: x.ferramenta,
            loja: x.loja,
            motivo: x.motivo,
            alvo: corta(x.alvo, 600),
            antes: corta(x.antes, 1500),
            depois: corta(x.depois, 1500),
            resultado: x.resultado,
            detalhe: x.detalhe,
          })),
        },
        log: {},
      };
    },
  },

  {
    nome: "gerenciar_acessos",
    titulo: "Gerenciar acessos",
    tipo: "admin",
    papel: "admin",
    descricao:
      "Administra quem usa os conectores. Ações: listar; criar (gera o link pessoal, que aparece só uma vez); alterar " +
      "(papel, lojas, áreas); revogar; reativar; novo_link (troca o link de alguém, o antigo para de funcionar). " +
      "Papéis: leitor (consulta e relatórios), editor (também altera status, preço e cria cupons dentro dos limites), " +
      "admin (tudo, inclusive log e acessos). Entregue o link à pessoa por um canal privado.",
    entrada: {
      type: "object",
      properties: {
        acao: { type: "string", enum: ["listar", "criar", "alterar", "revogar", "reativar", "novo_link"] },
        usuario_id: { type: "integer" },
        nome: { type: "string" },
        email: { type: "string" },
        papel: { type: "string", enum: Object.keys(PAPEIS) },
        lojas: { type: "array", items: { type: "string", enum: Object.keys(LOJAS) }, description: "Padrão: todas" },
        areas: { type: "array", items: { type: "string", enum: NOMES_AREAS }, description: "Padrão: a área deste conector" },
      },
      required: ["acao"],
    },
    async executar(a, c) {
      const db = c.env.DB;
      const base = baseUrl(c.env);
      const validarListas = () => {
        if (a.lojas && a.lojas.some((l) => !LOJAS[l])) falha("Loja inválida na lista.");
        if (a.areas && a.areas.some((x) => !AREAS[x])) falha("Área inválida na lista.");
      };
      const buscar = async () => {
        if (!a.usuario_id) falha("Informe usuario_id (use acao=listar para ver os IDs).");
        const u = await db.prepare("SELECT * FROM usuarios WHERE id = ?1").bind(a.usuario_id).first();
        if (!u) falha(`Usuário ${a.usuario_id} não encontrado.`);
        return u;
      };
      const links = (areas, token) => Object.fromEntries(lista(areas).map((ar) => [ar, `${base}/${ar}/${token}`]));

      if (a.acao === "listar") {
        const { results } = await db
          .prepare("SELECT id, nome, email, papel, areas, lojas, ativo, criado_em, criado_por, ultimo_uso FROM usuarios ORDER BY ativo DESC, nome")
          .all();
        return {
          dados: {
            usuarios: results.map((u) => ({ ...u, ativo: !!u.ativo, criado_em: horaBrasilia(u.criado_em), ultimo_uso: horaBrasilia(u.ultimo_uso) })),
          },
          log: { resultado: "consulta" },
        };
      }

      if (a.acao === "criar") {
        if (!a.nome || !a.papel) falha("Para criar, informe nome e papel.");
        if (!PAPEIS[a.papel]) falha("Papel inválido.");
        validarListas();
        const existe = await db.prepare("SELECT id FROM usuarios WHERE lower(nome) = lower(?1) AND ativo = 1").bind(a.nome.trim()).first();
        if (existe) falha(`Já existe acesso ativo para ${a.nome} (id ${existe.id}). Use novo_link ou alterar.`);
        const token = aleatorio(40, ALFA62);
        const areas = (a.areas && a.areas.length ? a.areas : [c.nomeArea]).join(",");
        const lojas = a.lojas && a.lojas.length ? a.lojas.join(",") : "*";
        const r = await db
          .prepare("INSERT INTO usuarios (nome, email, papel, areas, lojas, token_hash, criado_por) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")
          .bind(a.nome.trim(), a.email || null, a.papel, areas, lojas, await sha256(token), c.usuario.nome)
          .run();
        const info = { id: r.meta.last_row_id, nome: a.nome.trim(), papel: a.papel, areas, lojas };
        return {
          dados: {
            usuario: info,
            links: links(areas, token),
            aviso: "Este link é a credencial pessoal e só aparece agora. Envie por canal privado. Se perder, use novo_link.",
          },
          log: { alvo: `acesso de ${info.nome}`, depois: info },
        };
      }

      if (a.acao === "alterar") {
        const u = await buscar();
        validarListas();
        const novo = {
          papel: a.papel && PAPEIS[a.papel] ? a.papel : u.papel,
          lojas: a.lojas ? (a.lojas.length ? a.lojas.join(",") : "*") : u.lojas,
          areas: a.areas && a.areas.length ? a.areas.join(",") : u.areas,
          email: a.email ?? u.email,
        };
        await db
          .prepare("UPDATE usuarios SET papel = ?2, lojas = ?3, areas = ?4, email = ?5 WHERE id = ?1")
          .bind(u.id, novo.papel, novo.lojas, novo.areas, novo.email)
          .run();
        return {
          dados: { alterado: { id: u.id, nome: u.nome, ...novo }, obs: "A pessoa precisa reconectar o conector para ver a mudança nas ferramentas." },
          log: { alvo: `acesso de ${u.nome}`, antes: { papel: u.papel, lojas: u.lojas, areas: u.areas }, depois: novo },
        };
      }

      if (a.acao === "revogar" || a.acao === "reativar") {
        const u = await buscar();
        const ativo = a.acao === "reativar" ? 1 : 0;
        await db.prepare("UPDATE usuarios SET ativo = ?2 WHERE id = ?1").bind(u.id, ativo).run();
        return {
          dados: { usuario: u.nome, ativo: !!ativo },
          log: { alvo: `acesso de ${u.nome}`, antes: { ativo: !!u.ativo }, depois: { ativo: !!ativo } },
        };
      }

      if (a.acao === "novo_link") {
        const u = await buscar();
        const token = aleatorio(40, ALFA62);
        await db.prepare("UPDATE usuarios SET token_hash = ?2, ativo = 1 WHERE id = ?1").bind(u.id, await sha256(token)).run();
        return {
          dados: { usuario: u.nome, links: links(u.areas, token), aviso: "O link anterior parou de funcionar. Envie o novo por canal privado." },
          log: { alvo: `acesso de ${u.nome}`, detalhe: "link trocado" },
        };
      }

      falha("Ação inválida.");
    },
  },
];

/* ------------------------------------------------------------------ áreas */

const AREAS = {
  lojas: {
    titulo: "Lojas dos colégios (WooCommerce)",
    ferramentas: FERRAMENTAS_LOJAS,
    instrucoes: (u, env) =>
      [
        `Conector das lojas WooCommerce dos colégios atendidos pela Resultz. Lojas: gdv = ${LOJAS.gdv.nome} (${LOJAS.gdv.host}); ` +
          `sh = ${LOJAS.sh.nome} (${LOJAS.sh.host}).`,
        `Conectado como ${u.nome}, papel ${u.papel}. Toda chamada fica registrada em log de auditoria com esse nome.`,
        "Regras:",
        "1. Antes de alterar, localize os itens com buscar_produtos. Se o pedido puder se referir a mais de um produto, pergunte ao usuário qual.",
        "2. Nas ferramentas de alteração, preencha 'motivo' com o pedido do usuário nas palavras dele.",
        "3. Preço e parcelas: sempre simule primeiro (aplicar=false), mostre o plano e só aplique com confirmação explícita.",
        "4. Nunca invente IDs, preços ou códigos: use o que as ferramentas devolverem.",
        "5. Relatórios trazem dados pessoais de famílias: use só para o fim pedido e não repita dados além do necessário.",
        "6. Responda em português do Brasil.",
        "7. Toda leitura e alteração nas lojas passa por este conector, para ficar no log. Nunca use outro caminho (API " +
          "direta, chave colada no chat, script no navegador logado no wp-admin). Se uma ferramenta falhar, informe o " +
          "erro e pare.",
        "8. O plugin WooCommerce Parcelas foi retirado do repositório do WordPress em 26/10/2025 e não recebe mais " +
          "atualizações; continua funcionando. Só mencione se o assunto surgir.",
      ].join("\n"),
  },
  midia: criarAreaMidia({ falha, norm, P_MOTIVO, corta }),
  sumare: {
    titulo: "Sumaré: Dash de Captação",
    ferramentas: FERRAMENTAS_SUMARE,
    instrucoes: (u) =>
      [
        "Conector do Dash de Captação do Centro Universitário Sumaré (API Softsy): matrículas, inscrições, funil de " +
          "candidatos e listas para recuperação.",
        `Conectado como ${u.nome}, papel ${u.papel}. Toda chamada fica registrada em log de auditoria com esse nome.`,
        "Regras:",
        "1. Matrícula = candidato CONVERTIDO com data de matrícula no período. Os números contam inscrições; cite " +
          "cpfs_unicos quando a diferença importar.",
        "2. Responda curto, em português do Brasil, sem travessão: número principal em negrito com o período, depois o " +
          "horário de base_atualizada_em (horário de Brasília). Se a base for de um dia anterior, avise.",
        "3. Comparação ou quebra só se pedida. Para mês em andamento, compare com o mês anterior até o mesmo dia.",
        "4. Dados pessoais (nome, CPF, telefone, e-mail) nunca vão para o chat. Listas só com sumare_lista_candidatos, " +
          "com motivo, e entregues em planilha.",
        "5. Registros de teste (e-mail teste@) já vêm excluídos; só mencione a quantidade se for relevante.",
        "6. Toda consulta passa por este conector, para ficar no log. Nunca use outro caminho até a API da Softsy. Se " +
          "uma ferramenta falhar, informe o erro e pare.",
        "7. Nunca invente números: use só o que as ferramentas devolverem.",
      ].join("\n"),
  },
};
