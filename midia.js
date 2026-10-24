/*
 * Área "midia" do MCP Resultz: tagueamento e mídia paga (Meta Ads, Google Ads, GA4, GTM).
 * Portada da skill resultzads/skilltagueamento (tagueamento + auditoria-midia).
 *
 * Fase 1: só leitura nas plataformas. A única escrita é a ficha do cliente, no D1 do próprio MCP.
 *
 * Secrets:
 *   GOOGLE_SA_JSON                     JSON da conta de serviço (GA4 e GTM)
 *   GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET, GOOGLE_ADS_REFRESH_TOKEN
 *   GOOGLE_ADS_LOGIN_CUSTOMER_ID       ID da MCC, só números
 *   META_ACCESS_TOKEN                  usuário do sistema da BM da Resultz
 *   CLOUDFLARE_API_TOKEN               leitura de zonas/Pages e SELECT no D1 de leads dos sites
 * Variáveis opcionais: GOOGLE_ADS_API_VERSION (ex.: v22), GOOGLE_ADS_DEVELOPER_TOKEN, META_API_VERSION (v23.0)
 */

const UA = "Mozilla/5.0 (compatible; Resultz-MCP; +https://mcp.resultz.com.br)";
const CREDENCIAIS = {
  google: ["GOOGLE_SA_JSON"],
  google_ads: ["GOOGLE_ADS_CLIENT_ID", "GOOGLE_ADS_CLIENT_SECRET", "GOOGLE_ADS_REFRESH_TOKEN"],
  meta: ["META_ACCESS_TOKEN"],
  cloudflare: ["CLOUDFLARE_API_TOKEN"],
};
// Fase 1 só lê: escopos de leitura. A fase 2 (correções) acrescenta os de edição.
const ESCOPOS_GOOGLE = [
  "https://www.googleapis.com/auth/analytics.readonly",
  "https://www.googleapis.com/auth/tagmanager.readonly",
];
const GA4_ADMIN = "https://analyticsadmin.googleapis.com";
const GA4_DATA = "https://analyticsdata.googleapis.com/v1beta";
const GTM_API = "https://tagmanager.googleapis.com/tagmanager/v2";
const CF_API = "https://api.cloudflare.com/client/v4";
const VERSOES_ADS = ["v26", "v25", "v24", "v23", "v22", "v21", "v20", "v19"];

export function criarAreaMidia(h) {
  const { falha, norm, P_MOTIVO, corta } = h;

  /* ---------------------------------------------------------------- utilidades */

  const num = (v, padrao = 0) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : padrao;
  };
  const div = (a, b) => (b ? Math.round((a / b) * 10000) / 10000 : null);
  const r2 = (v) => Math.round(num(v) * 100) / 100;
  const r1 = (v) => Math.round(num(v) * 10) / 10;

  // Uma parte da coleta que falha não derruba as outras: vira item em "falhas".
  async function secao(falhas, nome, fn) {
    try {
      return await fn();
    } catch (e) {
      falhas[nome] = String(e?.message || e).slice(0, 400);
      return null;
    }
  }

  function exige(env, grupo) {
    const faltando = CREDENCIAIS[grupo].filter((v) => !env[v]);
    if (faltando.length) falha(`Credencial ausente no servidor: ${faltando.join(", ")}. O Lucas cadastra no painel da Cloudflare.`);
  }
  const temCredencial = (env, grupo) => CREDENCIAIS[grupo].every((v) => env[v]);

  async function pedir(url, { metodo = "GET", headers = {}, corpo, form, redirect = "follow", timeout = 30000 } = {}) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    const cab = { "User-Agent": UA, ...headers };
    let body;
    if (corpo !== undefined) {
      cab["Content-Type"] = "application/json";
      body = JSON.stringify(corpo);
    } else if (form !== undefined) {
      cab["Content-Type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(form).toString();
    }
    try {
      const r = await fetch(url, { method: metodo, headers: cab, body, redirect, signal: ctrl.signal });
      const texto = metodo === "HEAD" ? "" : await r.text();
      let json = null;
      try {
        json = JSON.parse(texto);
      } catch {
        /* não é JSON */
      }
      return { status: r.status, ok: r.ok, texto, json, headers: r.headers };
    } catch (e) {
      return { status: 0, ok: false, texto: e?.name === "AbortError" ? "tempo esgotado" : String(e?.message || e), json: null, headers: new Headers() };
    } finally {
      clearTimeout(t);
    }
  }

  const b64url = (bytes) => {
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };
  const b64urlTexto = (t) => b64url(new TextEncoder().encode(t));

  /* ---------------------------------------------------------------- Google (conta de serviço e OAuth do Ads) */

  const cacheTokens = new Map();

  function contaServico(env) {
    exige(env, "google");
    const bruto = String(env.GOOGLE_SA_JSON).trim();
    try {
      // aceita o JSON da chave como está ou codificado em base64
      return JSON.parse(bruto.startsWith("{") ? bruto : atob(bruto));
    } catch {
      falha("GOOGLE_SA_JSON não é um JSON válido (cole o arquivo inteiro da chave).");
    }
  }

  async function tokenGoogle(env) {
    const c = cacheTokens.get("sa");
    if (c && c.expira > Date.now() + 60000) return c.token;
    const sa = contaServico(env);
    if (!sa.private_key || !sa.client_email) falha("GOOGLE_SA_JSON sem private_key ou client_email.");
    const aud = sa.token_uri || "https://oauth2.googleapis.com/token";
    const agora = Math.floor(Date.now() / 1000);
    const cab = b64urlTexto(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const reivind = b64urlTexto(JSON.stringify({ iss: sa.client_email, scope: ESCOPOS_GOOGLE.join(" "), aud, iat: agora, exp: agora + 3600 }));
    const pem = sa.private_key.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
    const der = Uint8Array.from(atob(pem), (ch) => ch.charCodeAt(0));
    const chave = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
    const assinatura = new Uint8Array(
      await crypto.subtle.sign("RSASSA-PKCS1-v1_5", chave, new TextEncoder().encode(`${cab}.${reivind}`))
    );
    const r = await pedir(aud, {
      metodo: "POST",
      form: { grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${cab}.${reivind}.${b64url(assinatura)}` },
    });
    if (!r.ok || !r.json?.access_token) {
      falha(`O Google recusou a conta de serviço (${r.status}): ${r.json?.error_description || r.json?.error || r.texto.slice(0, 200)}`);
    }
    cacheTokens.set("sa", { token: r.json.access_token, expira: Date.now() + (r.json.expires_in || 3600) * 1000 });
    return r.json.access_token;
  }

  async function tokenAds(env) {
    exige(env, "google_ads");
    const c = cacheTokens.get("ads");
    if (c && c.expira > Date.now() + 60000) return c.token;
    const r = await pedir("https://oauth2.googleapis.com/token", {
      metodo: "POST",
      form: {
        grant_type: "refresh_token",
        refresh_token: env.GOOGLE_ADS_REFRESH_TOKEN,
        client_id: env.GOOGLE_ADS_CLIENT_ID,
        client_secret: env.GOOGLE_ADS_CLIENT_SECRET,
      },
    });
    if (!r.ok || !r.json?.access_token) {
      falha(
        `O Google recusou o OAuth do Google Ads (${r.status}): ${r.json?.error_description || r.json?.error || r.texto.slice(0, 200)}. ` +
          "Se o refresh token expirou, gere outro no OAuth Playground."
      );
    }
    cacheTokens.set("ads", { token: r.json.access_token, expira: Date.now() + (r.json.expires_in || 3600) * 1000 });
    return r.json.access_token;
  }

  const msgGoogle = (r) => r.json?.error?.message || r.json?.[0]?.error?.message || r.texto.slice(0, 300);

  async function google(env, metodo, url, corpo) {
    const token = await tokenGoogle(env);
    const r = await pedir(url, { metodo, headers: { Authorization: `Bearer ${token}` }, corpo });
    if (r.ok) return r.json || {};
    if (r.status === 403) {
      falha(
        `403 no Google: confira se ${contaServico(env).client_email} tem acesso (GA4: Leitor ou Editor na propriedade; ` +
          `GTM: Leitura no contêiner) e se a API está ativa no projeto. ${msgGoogle(r)}`
      );
    }
    falha(`Google ${r.status}: ${msgGoogle(r)}`);
  }

  async function googleLista(env, url, chave, extra = "") {
    const itens = [];
    let pagina = null;
    for (let i = 0; i < 20; i++) {
      const u = url + (url.includes("?") ? "&" : "?") + (pagina ? `pageToken=${encodeURIComponent(pagina)}` : "") + extra;
      const r = await google(env, "GET", u);
      itens.push(...(r[chave] || []));
      pagina = r.nextPageToken;
      if (!pagina) break;
    }
    return itens;
  }

  let versaoAds = null;
  let sondagemAds = null; // descoberta da versão: uma só por vez, as outras chamadas esperam
  async function ads(env, metodo, caminho, corpo) {
    const token = await tokenAds(env);
    const cab = { Authorization: `Bearer ${token}` };
    if (env.GOOGLE_ADS_LOGIN_CUSTOMER_ID) cab["login-customer-id"] = String(env.GOOGLE_ADS_LOGIN_CUSTOMER_ID).replace(/\D/g, "");
    if (env.GOOGLE_ADS_DEVELOPER_TOKEN) cab["developer-token"] = env.GOOGLE_ADS_DEVELOPER_TOKEN;
    if (env.GOOGLE_ADS_API_VERSION) versaoAds = env.GOOGLE_ADS_API_VERSION;
    if (!versaoAds) {
      const minha = !sondagemAds;
      if (minha) sondagemAds = sondarVersaoAds(metodo, caminho, cab, corpo);
      const r = await sondagemAds;
      if (minha) {
        if (!r.ok) sondagemAds = null;
        return respostaAds(r);
      }
    }
    return respostaAds(await pedir(`https://googleads.googleapis.com/${versaoAds || VERSOES_ADS[0]}/${caminho}`, { metodo, headers: cab, corpo, timeout: 60000 }));
  }
  async function sondarVersaoAds(metodo, caminho, cab, corpo) {
    let r = null;
    for (const v of VERSOES_ADS) {
      r = await pedir(`https://googleads.googleapis.com/${v}/${caminho}`, { metodo, headers: cab, corpo, timeout: 60000 });
      if (r.status === 404 || /UNSUPPORTED_VERSION|deprecated|sunset/i.test(r.texto)) continue;
      versaoAds = v; // qualquer resposta que não seja "versão inexistente" confirma a versão
      break;
    }
    return r;
  }
  function respostaAds(ultimo) {
    if (ultimo?.ok) return ultimo.json;
    if (ultimo?.texto.includes("CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION")) {
      falha(
        "O projeto do Google Cloud do OAuth está no nível de teste e não acessa contas reais. " +
          "Peça o nível Explorer em console.cloud.google.com/google/ads-apis/overview."
      );
    }
    falha(`Google Ads ${ultimo?.status}: ${msgGoogle(ultimo)}`);
  }

  const idConta = (v) => String(v || "").replace(/\D/g, "");

  async function gaql(env, conta, consulta) {
    const c = idConta(conta);
    if (!c) falha("Conta do Google Ads ausente (só números).");
    const r = await ads(env, "POST", `customers/${c}/googleAds:searchStream`, { query: consulta });
    const linhas = [];
    for (const bloco of Array.isArray(r) ? r : [r]) linhas.push(...(bloco?.results || []));
    return linhas;
  }

  /* ---------------------------------------------------------------- Meta (Graph API) */

  const graphBase = (env) => `https://graph.facebook.com/${env.META_API_VERSION || "v23.0"}`;
  const act = (x) => (String(x).startsWith("act_") ? String(x) : `act_${idConta(x)}`);

  async function graph(env, caminho, params = {}) {
    exige(env, "meta");
    const u = new URL(`${graphBase(env)}/${String(caminho).replace(/^\/+/, "")}`);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, String(v));
    u.searchParams.set("access_token", env.META_ACCESS_TOKEN);
    return graphUrl(u.toString());
  }
  // Tira de qualquer resposta do Meta os campos de token (ex.: tokens de páginas em me/accounts).
  function semTokens(v) {
    if (Array.isArray(v)) return v.map(semTokens);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v).filter(([k]) => !/token/i.test(k)).map(([k, x]) => [k, semTokens(x)]));
    }
    return v;
  }
  const semTokenNaUrl = (t) => String(t).replace(/access_token=[^&\s"']+/gi, "access_token=***");
  async function graphUrl(url) {
    const r = await pedir(url, { timeout: 60000 });
    if (r.ok) {
      const j = r.json || {};
      return { ...semTokens(j), ...(j.paging ? { paging: j.paging } : {}) }; // paging.next é usado aqui e não sai
    }
    const e = r.json?.error || {};
    falha(semTokenNaUrl(`Meta ${r.status}: ${e.message || r.texto.slice(0, 200)} (código ${e.code ?? "?"}, subcódigo ${e.error_subcode ?? "?"})`));
  }
  async function graphPaginas(env, caminho, params = {}, maxPaginas = 20) {
    const itens = [];
    let r = await graph(env, caminho, params);
    for (let i = 0; i < maxPaginas; i++) {
      itens.push(...(r.data || []));
      const prox = r.paging?.next;
      if (!prox) break;
      r = await graphUrl(prox);
    }
    return itens;
  }
  const somaStats = (dados) => {
    const total = {};
    for (const bloco of dados || []) for (const d of bloco.data || []) total[d.value] = (total[d.value] || 0) + num(d.count);
    return Object.fromEntries(Object.entries(total).sort((a, b) => b[1] - a[1]));
  };
  function linksDoCriativo(c = {}) {
    const links = new Set();
    const oss = c.object_story_spec || {};
    const ld = oss.link_data || {};
    if (ld.link) links.add(ld.link);
    for (const ch of ld.child_attachments || []) if (ch.link) links.add(ch.link);
    const cta = oss.video_data?.call_to_action?.value || {};
    if (cta.link) links.add(cta.link);
    for (const u of c.asset_feed_spec?.link_urls || []) if (u.website_url) links.add(u.website_url);
    if (c.link_url) links.add(c.link_url);
    return [...links].sort();
  }

  /* ---------------------------------------------------------------- Cloudflare */

  async function cf(env, metodo, caminho, corpo) {
    exige(env, "cloudflare");
    const r = await pedir(`${CF_API}/${caminho.replace(/^\/+/, "")}`, {
      metodo,
      headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` },
      corpo,
    });
    if (!r.ok || r.json?.success === false) falha(`Cloudflare ${r.status}: ${JSON.stringify(r.json?.errors || r.texto.slice(0, 200))}`);
    return r.json?.result ?? r.json;
  }
  // Só uma consulta de leitura: começa com SELECT/WITH, sem segunda instrução e sem comando que altere dados.
  const ehSelect = (sql) => {
    const s = String(sql || "").trim().replace(/;\s*$/, "");
    return (
      /^(SELECT|WITH)\b/i.test(s) &&
      !s.includes(";") &&
      !/\b(INSERT|UPDATE|DELETE|UPSERT|DROP|ALTER|CREATE|ATTACH|DETACH|PRAGMA|VACUUM|REINDEX)\b|\bREPLACE\s+INTO\b/i.test(s)
    );
  };

  /* ---------------------------------------------------------------- períodos */

  // Últimos 30 dias, 30 anteriores e últimos 90, terminando ontem (horário de Brasília).
  function periodos() {
    const ontem = new Date(Date.now() - 3 * 3600 * 1000);
    ontem.setUTCDate(ontem.getUTCDate() - 1);
    const d = (n) => {
      const x = new Date(ontem);
      x.setUTCDate(x.getUTCDate() - n);
      return x.toISOString().slice(0, 10);
    };
    return {
      p30: { inicio: d(29), fim: d(0), rotulo: "Últimos 30d" },
      ant30: { inicio: d(59), fim: d(30), rotulo: "30d anteriores" },
      p90: { inicio: d(89), fim: d(0), rotulo: "Últimos 90d" },
    };
  }

  /* ---------------------------------------------------------------- fichas de clientes (D1 do MCP) */

  let tabelaPronta = false;
  async function garantirTabela(env) {
    if (tabelaPronta) return;
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS midia_clientes (
        slug TEXT PRIMARY KEY,
        nome TEXT NOT NULL,
        ficha TEXT NOT NULL,
        criado_em TEXT NOT NULL DEFAULT (datetime('now')),
        atualizado_em TEXT NOT NULL DEFAULT (datetime('now')),
        atualizado_por TEXT)`
    ).run();
    tabelaPronta = true;
  }

  async function lerFicha(env, slug) {
    await garantirTabela(env);
    const r = await env.DB.prepare("SELECT slug, nome, ficha, atualizado_em, atualizado_por FROM midia_clientes WHERE slug = ?1")
      .bind(String(slug || "").trim().toLowerCase())
      .first();
    if (!r) {
      const { results } = await env.DB.prepare("SELECT slug FROM midia_clientes ORDER BY slug").all();
      falha(`Cliente "${slug}" sem ficha. Fichas existentes: ${results.map((x) => x.slug).join(", ") || "nenhuma"}. Use midia_salvar_cliente.`);
    }
    return { ...JSON.parse(r.ficha), _meta: { atualizado_em: r.atualizado_em, atualizado_por: r.atualizado_por } };
  }

  // Resolve um ID: o argumento explícito vence; senão vem da ficha do cliente.
  async function resolver(c, a, caminhos) {
    const ficha = a.cliente ? await lerFicha(c.env, a.cliente) : null;
    const out = { ficha };
    for (const [nome, [arg, secaoFicha, campo]] of Object.entries(caminhos)) {
      out[nome] = a[arg] || (ficha && ficha[secaoFicha]?.[campo]) || null;
    }
    return out;
  }

  /* ---------------------------------------------------------------- site e contêiner publicado */

  const PADROES_SITE = {
    gtm: /\bGTM-[A-Z0-9]{5,9}\b/g,
    ga4: /\bG-[A-Z0-9]{8,12}\b/g,
    google_ads: /\bAW-\d{8,12}\b/g,
    meta_pixel: /fbq\(\s*['"]init['"]\s*,\s*['"](\d{10,20})/g,
    tiktok: /ttq\.load\(\s*['"]([A-Z0-9]{15,25})/g,
    clarity: /clarity\.ms\/tag\/([a-z0-9]+)/g,
    hotjar: /hjid\s*:\s*(\d+)/g,
    rdstation: /d335luupugsy2\.cloudfront\.net\/js\/loader-scripts\/([\w-]+)/g,
    linkedin: /_linkedin_partner_id\s*=\s*['"]?(\d+)/g,
  };
  const RX_PUSH = /dataLayer\.push\(\s*\{[^}]*?event\s*:\s*['"]([\w.-]+)['"]/gs;
  const RX_FORM = /<form\b([^>]*)>/gi;
  const RX_ATTR = /(\w[\w-]*)\s*=\s*["']([^"']*)["']/g;
  const RX_SCRIPT = /<script[^>]+src=["']([^"']+)["']/gi;
  const RX_WA = /https?:\/\/(?:wa\.me|api\.whatsapp\.com)\/[^"'\s<>]+/g;

  function idsNoTexto(texto) {
    const out = {};
    for (const [nome, rx] of Object.entries(PADROES_SITE)) {
      const v = [...texto.matchAll(rx)].map((m) => m[1] || m[0]);
      if (v.length) out[nome] = [...new Set(v)].sort();
    }
    if (texto.includes("/cdn-cgi/zaraz/")) out.zaraz = true;
    if (texto.includes("challenges.cloudflare.com/turnstile")) out.turnstile = true;
    return out;
  }

  async function urlsSitemap(base, limite) {
    for (const caminho of ["/sitemap.xml", "/sitemap_index.xml"]) {
      const r = await pedir(new URL(caminho, base).toString(), { timeout: 15000 });
      if (r.status !== 200 || !r.texto.includes("<loc")) continue;
      let urls = [...r.texto.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
      const filhos = urls.filter((u) => u.endsWith(".xml")).slice(0, 3);
      urls = urls.filter((u) => !u.endsWith(".xml"));
      for (const f of filhos) {
        if (urls.length >= limite) break;
        const rf = await pedir(f, { timeout: 15000 });
        urls.push(...[...rf.texto.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]).filter((u) => !u.endsWith(".xml")));
      }
      if (urls.length) return [...new Set(urls)].slice(0, limite);
    }
    return [];
  }

  async function cadeiaRedirecionamento(url) {
    const cadeia = [];
    let atual = url;
    for (let i = 0; i < 6; i++) {
      const r = await pedir(atual, { metodo: "GET", redirect: "manual", timeout: 15000 });
      cadeia.push([atual, r.status || `falha: ${r.texto}`]);
      const loc = r.headers.get("location");
      if ([301, 302, 303, 307, 308].includes(r.status) && loc) {
        atual = new URL(loc, atual).toString();
        continue;
      }
      break;
    }
    return cadeia;
  }

  async function emLotes(itens, tamanho, fn) {
    const out = [];
    for (let i = 0; i < itens.length; i += tamanho) out.push(...(await Promise.all(itens.slice(i, i + tamanho).map(fn))));
    return out;
  }

  async function varrerSite(url, max = 25) {
    let base;
    try {
      base = new URL(/^https?:\/\//.test(url) ? url : `https://${url}`);
    } catch {
      falha(`Endereço inválido: ${url}`);
    }
    base.pathname = base.pathname.replace(/\/?$/, "/");
    const host = base.hostname;
    const raiz = host.replace(/^www\./, "");
    const proprios = new Set([host, raiz, `www.${raiz}`]);
    const paginas = [base.toString(), ...(await urlsSitemap(base.toString(), max)).filter((u) => u.replace(/\/?$/, "/") !== base.toString())].slice(
      0,
      max
    );

    const scripts = new Set();
    const eventos = {};
    const addEvento = (ev, onde) => (eventos[ev] = eventos[ev] || new Set()).add(onde);
    const resultado = await emLotes(paginas, 6, async (u) => {
      const r = await pedir(u, { timeout: 20000 });
      const html = r.texto || "";
      const forms = [...html.matchAll(RX_FORM)].map((m) => {
        const d = Object.fromEntries([...m[1].matchAll(RX_ATTR)].map((x) => [x[1], x[2]]));
        return Object.fromEntries(["action", "method", "id", "class"].filter((k) => d[k]).map((k) => [k, d[k]]));
      });
      for (const m of html.matchAll(RX_SCRIPT)) {
        try {
          const su = new URL(m[1], u);
          if (proprios.has(su.hostname)) scripts.add(su.toString().split("#")[0]);
        } catch {
          /* src inválido */
        }
      }
      for (const m of html.matchAll(RX_PUSH)) addEvento(m[1], new URL(u).pathname);
      return { url: u, status: r.status, ids: idsNoTexto(html), formularios: forms, whatsapp: [...new Set(html.match(RX_WA) || [])].slice(0, 5) };
    });
    await emLotes([...scripts].slice(0, 30), 6, async (s) => {
      const r = await pedir(s, { timeout: 15000 });
      if (r.status === 200) for (const m of r.texto.matchAll(RX_PUSH)) addEvento(m[1], new URL(s).pathname);
    });

    const todos = {};
    for (const p of resultado) {
      for (const [k, v] of Object.entries(p.ids)) {
        if (!Array.isArray(v)) todos[k] = true;
        else {
          todos[k] = todos[k] instanceof Set ? todos[k] : new Set();
          for (const x of v) todos[k].add(x);
        }
      }
    }
    const [httpsRaiz, httpsWww, httpRaiz, inexistente] = await Promise.all([
      cadeiaRedirecionamento(`https://${raiz}/`),
      cadeiaRedirecionamento(`https://www.${raiz}/`),
      cadeiaRedirecionamento(`http://${raiz}/`),
      pedir(new URL("/pagina-inexistente-teste-tagueamento", base).toString(), { timeout: 15000 }),
    ]);
    return {
      site: base.toString(),
      paginas_lidas: resultado.length,
      ids_encontrados: Object.fromEntries(Object.entries(todos).map(([k, v]) => [k, v instanceof Set ? [...v].sort() : v])),
      paginas_sem_gtm: resultado.filter((p) => !p.ids.gtm && p.status === 200).map((p) => p.url),
      eventos_datalayer_no_codigo: Object.fromEntries(Object.entries(eventos).map(([k, v]) => [k, [...v].sort()])),
      destinos_de_formulario: [...new Set(resultado.flatMap((p) => p.formularios.map((f) => f.action || "(sem action)")))].sort(),
      infra: { https_raiz: httpsRaiz, https_www: httpsWww, http_raiz: httpRaiz, status_url_inexistente: inexistente.status },
      paginas: resultado,
    };
  }

  const NOMES_TAG = {
    __googtag: "Google tag (GA4/Ads config)",
    __gaawe: "Evento GA4",
    __awct: "Conversão Google Ads",
    __sp: "Remarketing Google Ads",
    __gclidw: "Vinculador de conversões",
    __html: "HTML personalizado",
    __img: "Imagem personalizada",
    __cl: "Ouvinte de clique (interno)",
    __lcl: "Ouvinte de clique em link (interno)",
    __fsl: "Ouvinte de envio de formulário (interno)",
    __sdl: "Ouvinte de rolagem (interno)",
    __ytl: "Ouvinte de YouTube (interno)",
    __evl: "Ouvinte de visibilidade (interno)",
    __tl: "Ouvinte de timer (interno)",
    __hl: "Ouvinte de histórico (interno)",
    __jel: "Ouvinte de erro JS (interno)",
    __flc: "Floodlight contador",
    __fls: "Floodlight vendas",
    __bzi: "LinkedIn Insight",
    __baut: "Microsoft UET",
    __hjtc: "Hotjar",
    __ua: "Universal Analytics (descontinuado)",
  };
  const NOMES_MACRO = {
    __e: "Evento",
    __u: "URL",
    __f: "Referrer",
    __v: "Variável da camada de dados",
    __aev: "Variável de elemento automática",
    __c: "Constante",
    __jsm: "JavaScript personalizado",
    __j: "Variável JavaScript",
    __k: "Cookie",
    __d: "Elemento DOM",
    __cid: "ID do contêiner",
    __ctv: "Versão do contêiner",
    __dbg: "Modo depuração",
    __r: "Número aleatório",
    __remm: "Tabela RegEx",
    __smm: "Tabela de consulta",
    __gas: "Config GA (UA)",
    __t: "Timestamp",
    __awec: "Dados fornecidos pelo usuário",
  };
  const OPERADORES = {
    _eq: "igual a",
    _cn: "contém",
    _sw: "começa com",
    _ew: "termina com",
    _re: "corresponde à regex",
    _css: "corresponde ao seletor CSS",
    _lt: "menor que",
    _le: "menor ou igual a",
    _gt: "maior que",
    _ge: "maior ou igual a",
  };

  // Recorta o objeto `var data = {...}` do JavaScript compilado do contêiner.
  function extrairData(js) {
    const i = js.indexOf("var data = {");
    if (i < 0) falha('Não achei "var data" no contêiner: formato mudou ou ID inválido.');
    const inicio = js.indexOf("{", i);
    let prof = 0;
    let emStr = false;
    let esc = false;
    let k = inicio;
    for (; k < js.length; k++) {
      const ch = js[k];
      if (emStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') emStr = false;
      } else if (ch === '"') emStr = true;
      else if (ch === "{") prof++;
      else if (ch === "}" && --prof === 0) break;
    }
    return JSON.parse(js.slice(inicio, k + 1));
  }

  function descreveMacro(m = {}) {
    const nome = NOMES_MACRO[m.function] || m.function;
    if (m.vtp_name) return `${nome} "${m.vtp_name}"`;
    if (m.vtp_component) return `${nome} (${m.vtp_component})`;
    if (m.function === "__c") return `${nome} "${m.vtp_value}"`;
    if (m.function === "__jsm") return `${nome} (código)`;
    return nome;
  }
  const valorMacro = (v, macros) => (Array.isArray(v) && v[0] === "macro" ? `{{${descreveMacro(macros[v[1]])}}}` : v);
  const descrevePredicado = (p, macros) =>
    `${valorMacro(p.arg0, macros)}${p.negate ? " NÃO" : ""} ${OPERADORES[p.function] || p.function} "${p.arg1}"`;

  function detectaNoHtml(html) {
    const achados = {};
    const rx = {
      meta_pixel_init: /fbq\(\s*['"]init['"]\s*,\s*['"](\d+)/g,
      meta_pixel_track: /fbq\(\s*['"]track(?:Custom)?['"]\s*,\s*['"]([\w ]+)/g,
      tiktok: /ttq\.load\(\s*['"]([A-Z0-9]+)/g,
      linkedin: /_linkedin_partner_id\s*=\s*['"]?(\d+)/g,
      gtag_config: /gtag\(\s*['"]config['"]\s*,\s*['"]([\w-]+)/g,
      hotjar: /hjid\s*:\s*(\d+)/g,
      clarity: /clarity['"]\s*,\s*['"]script['"]\s*,\s*['"](\w+)/g,
    };
    for (const [k, r] of Object.entries(rx)) {
      const v = [...String(html).matchAll(r)].map((m) => m[1]);
      if (v.length) achados[k] = [...new Set(v)].sort();
    }
    return achados;
  }

  function resumeGtm(data) {
    const r = data.resource || {};
    const macros = r.macros || [];
    const tags = r.tags || [];
    const preds = r.predicates || [];
    const acion = tags.map(() => []);
    const bloq = tags.map(() => []);
    for (const regra of r.rules || []) {
      const se = regra.filter((p) => p[0] === "if").flatMap((p) => p.slice(1).map((x) => descrevePredicado(preds[x], macros)));
      const exceto = regra.filter((p) => p[0] === "unless").flatMap((p) => p.slice(1).map((x) => descrevePredicado(preds[x], macros)));
      for (const parte of regra) {
        if (parte[0] === "add") for (const t of parte.slice(1)) acion[t]?.push({ se_todas: se, exceto });
        if (parte[0] === "block") for (const t of parte.slice(1)) bloq[t]?.push({ se_todas: se });
      }
    }
    const saida = tags.map((t, i) => {
      const params = Object.fromEntries(
        Object.entries(t)
          .filter(([k]) => k.startsWith("vtp_"))
          .map(([k, v]) => [k.slice(4), valorMacro(v, macros)])
      );
      const item = { tag_id: t.tag_id, tipo: NOMES_TAG[t.function] || t.function, funcao: t.function, pausada: !!t.paused, acionadores: acion[i] };
      if (bloq[i].length) item.bloqueios = bloq[i];
      if (t.function === "__html") {
        item.html = corta(params.html || "", 1500);
        item.detectado = detectaNoHtml(params.html || "");
        delete params.html;
      }
      item.parametros = params;
      return item;
    });
    const idxEvento = macros.findIndex((m) => m.function === "__e");
    return {
      versao: r.version,
      tags: saida,
      eventos_escutados: [
        ...new Set(preds.filter((p) => Array.isArray(p.arg0) && p.arg0[0] === "macro" && p.arg0[1] === idxEvento).map((p) => p.arg1)),
      ].sort(),
      variaveis_camada_dados: [...new Set(macros.filter((m) => m.function === "__v").map((m) => m.vtp_name))].sort(),
      variaveis: macros.map(descreveMacro),
    };
  }

  function resumeGtag(data) {
    const r = data.resource || {};
    const out = { versao: r.version, destinos: [], eventos_criados: [], eventos_chave: [], medicao_otimizada: {}, dados_fornecidos_auto: null, outras: [] };
    for (const t of r.tags || []) {
      const fn = t.function;
      if (fn === "__dest_ga" || fn === "__dest_aw") out.destinos.push(t.vtp_destinationId);
      else if (fn === "__ogt_event_create") out.eventos_criados.push({ novo_evento: t.vtp_eventName, regra: t.vtp_precompiledRule });
      else if (fn === "__ccd_conversion_marking") {
        for (const regra of (t.vtp_conversionRules || []).slice(1)) {
          try {
            out.eventos_chave.push(JSON.parse(regra[2]).args[0].stringValue);
          } catch {
            out.eventos_chave.push(regra);
          }
        }
      } else if (fn === "__ogt_auto_events") {
        out.medicao_otimizada = Object.fromEntries(Object.entries(t).filter(([k]) => k.startsWith("vtp_enable")).map(([k, v]) => [k.slice(4), v]));
      } else if (fn === "__ogt_1p_data_v2") {
        out.dados_fornecidos_auto = Object.fromEntries(Object.entries(t).filter(([k]) => k.startsWith("vtp_")).map(([k, v]) => [k.slice(4), v]));
      } else if (fn === "__ogt_referral_exclusion") out.exclusao_referencia = t.vtp_includeConditions;
      else if (fn === "__ogt_ip_mark") out.trafego_interno = "regra definida";
      else out.outras.push(fn);
    }
    out.ids_mencionados = [...new Set(JSON.stringify(data).match(/\b(?:G|AW|GT|DC)-[A-Z0-9]{6,}\b/g) || [])].sort();
    return out;
  }

  async function lerPublicado(id) {
    const ident = String(id || "").trim().toUpperCase();
    let url;
    if (ident.startsWith("GTM-")) url = `https://www.googletagmanager.com/gtm.js?id=${ident}`;
    else if (/^(G|AW|GT|DC)-/.test(ident)) url = `https://www.googletagmanager.com/gtag/js?id=${ident}`;
    else falha("ID deve começar com GTM-, G-, AW-, GT- ou DC-.");
    const r = await pedir(url, { timeout: 30000 });
    if (r.status !== 200) falha(`${ident}: o Google respondeu ${r.status} (ID inexistente ou não publicado).`);
    const data = extrairData(r.texto);
    return { id: ident, ...(ident.startsWith("GTM-") ? resumeGtm(data) : resumeGtag(data)) };
  }

  /* ---------------------------------------------------------------- GA4 */

  async function ga4Config(env, prop) {
    const p = `properties/${idConta(prop)}`;
    const falhas = {};
    const fluxos = (await secao(falhas, "fluxos", () => googleLista(env, `${GA4_ADMIN}/v1beta/${p}/dataStreams`, "dataStreams"))) || [];
    for (const f of fluxos) {
      f.regras_criacao_evento = await secao(falhas, `regras_${f.name}`, () => googleLista(env, `${GA4_ADMIN}/v1alpha/${f.name}/eventCreateRules`, "eventCreateRules"));
      f.medicao_otimizada = await secao(falhas, `medicao_${f.name}`, () => google(env, "GET", `${GA4_ADMIN}/v1alpha/${f.name}/enhancedMeasurementSettings`));
    }
    const [propriedade, eventosChave, vinculos, dimensoes, retencao] = await Promise.all([
      secao(falhas, "propriedade", () => google(env, "GET", `${GA4_ADMIN}/v1beta/${p}`)),
      secao(falhas, "eventos_chave", () => googleLista(env, `${GA4_ADMIN}/v1beta/${p}/keyEvents`, "keyEvents")),
      secao(falhas, "vinculos_google_ads", () => googleLista(env, `${GA4_ADMIN}/v1beta/${p}/googleAdsLinks`, "googleAdsLinks")),
      secao(falhas, "dimensoes", () => googleLista(env, `${GA4_ADMIN}/v1beta/${p}/customDimensions`, "customDimensions")),
      secao(falhas, "retencao", () => google(env, "GET", `${GA4_ADMIN}/v1beta/${p}/dataRetentionSettings`)),
    ]);
    return { propriedade, fluxos, eventos_chave: eventosChave, vinculos_google_ads: vinculos, dimensoes_personalizadas: dimensoes, retencao, falhas };
  }

  async function ga4Relatorio(env, prop, dias = 28) {
    const p = idConta(prop);
    const rel = async (dims, mets, filtro, limite = 200) => {
      const corpo = {
        dateRanges: [{ startDate: `${dias}daysAgo`, endDate: "today" }],
        dimensions: dims.map((name) => ({ name })),
        metrics: mets.map((name) => ({ name })),
        limit: limite,
        orderBys: [{ metric: { metricName: mets[0] }, desc: true }],
      };
      if (filtro) corpo.dimensionFilter = filtro;
      const r = await google(env, "POST", `${GA4_DATA}/properties/${p}:runReport`, corpo);
      return (r.rows || []).map((l) =>
        Object.fromEntries([...dims, ...mets].map((n, i) => [n, [...(l.dimensionValues || []), ...(l.metricValues || [])][i]?.value]))
      );
    };
    const soLeads = { filter: { fieldName: "eventName", inListFilter: { values: ["generate_lead", "form_submit", "whatsapp_lead", "lead_site", "contact", "Lead", "lead"] } } };
    const falhas = {};
    const [eventos, eventosChave, leads, sessoes, hosts, obrigado] = await Promise.all([
      secao(falhas, "eventos", () => rel(["eventName"], ["eventCount", "totalUsers"])),
      secao(falhas, "eventos_chave", () => rel(["eventName"], ["keyEvents"])),
      secao(falhas, "leads_por_origem", () => rel(["eventName", "sessionSourceMedium", "sessionCampaignName"], ["eventCount"], soLeads)),
      secao(falhas, "sessoes_por_origem", () => rel(["sessionSourceMedium"], ["sessions", "keyEvents"], null, 40)),
      secao(falhas, "hosts", () => rel(["hostName"], ["screenPageViews"], null, 30)),
      secao(falhas, "paginas_obrigado", () =>
        rel(["pagePath"], ["screenPageViews"], { filter: { fieldName: "pagePath", stringFilter: { matchType: "PARTIAL_REGEXP", value: "sucesso|obrigad|thank|lead" } } }, 30)
      ),
    ]);
    return { periodo_dias: dias, eventos, eventos_chave: eventosChave, leads_por_origem: leads, sessoes_por_origem: sessoes, hosts, paginas_obrigado: obrigado, falhas };
  }

  /* ---------------------------------------------------------------- Google Ads: tagueamento */

  async function adsTagueamento(env, conta, dias = 30) {
    const periodo = [7, 14, 30].includes(dias) ? `segments.date DURING LAST_${dias}_DAYS` : "segments.date DURING LAST_30_DAYS";
    const falhas = {};
    const q = (nome, consulta) => secao(falhas, nome, () => gaql(env, conta, consulta));
    const [contaInfo, acoes, porAcao, campanhas, urls] = await Promise.all([
      q(
        "conta",
        "SELECT customer.id, customer.descriptive_name, customer.auto_tagging_enabled, customer.tracking_url_template, " +
          "customer.final_url_suffix, customer.currency_code, customer.conversion_tracking_setting.conversion_tracking_id, " +
          "customer.conversion_tracking_setting.google_ads_conversion_customer, " +
          "customer.conversion_tracking_setting.enhanced_conversions_for_leads_enabled FROM customer"
      ),
      q(
        "acoes_conversao",
        "SELECT conversion_action.id, conversion_action.name, conversion_action.status, conversion_action.type, " +
          "conversion_action.category, conversion_action.origin, conversion_action.primary_for_goal, conversion_action.counting_type, " +
          "conversion_action.include_in_conversions_metric FROM conversion_action WHERE conversion_action.status != 'REMOVED'"
      ),
      q("conversoes_por_acao", `SELECT segments.conversion_action_name, metrics.all_conversions, metrics.conversions FROM customer WHERE ${periodo}`),
      q(
        "campanhas",
        "SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign.bidding_strategy_type, " +
          "campaign.final_url_suffix, campaign.tracking_url_template, metrics.cost_micros, metrics.clicks, metrics.conversions, " +
          `metrics.all_conversions FROM campaign WHERE campaign.status != 'REMOVED' AND ${periodo} ORDER BY metrics.cost_micros DESC`
      ),
      q(
        "urls_finais",
        "SELECT ad_group_ad.ad.final_urls, ad_group_ad.ad.final_url_suffix, campaign.name FROM ad_group_ad " +
          "WHERE ad_group_ad.status = 'ENABLED' AND campaign.status = 'ENABLED' LIMIT 200"
      ),
    ]);
    return {
      versao_api: versaoAds,
      conta: contaInfo?.[0]?.customer || null,
      acoes_conversao: (acoes || []).map((l) => l.conversionAction),
      conversoes_por_acao: (porAcao || []).map((l) => ({
        acao: l.segments?.conversionActionName,
        conversoes: r1(l.metrics?.conversions),
        todas: r1(l.metrics?.allConversions),
      })),
      campanhas: (campanhas || []).map((l) => ({
        id: l.campaign.id,
        nome: l.campaign.name,
        status: l.campaign.status,
        tipo: l.campaign.advertisingChannelType,
        lance: l.campaign.biddingStrategyType,
        sufixo_url: l.campaign.finalUrlSuffix || null,
        modelo_acompanhamento: l.campaign.trackingUrlTemplate || null,
        investimento: r2(num(l.metrics?.costMicros) / 1e6),
        cliques: num(l.metrics?.clicks),
        conversoes: r1(l.metrics?.conversions),
      })),
      urls_finais: (urls || []).map((l) => ({ campanha: l.campaign?.name, urls: l.adGroupAd?.ad?.finalUrls, sufixo: l.adGroupAd?.ad?.finalUrlSuffix || null })),
      falhas,
    };
  }

  /* ---------------------------------------------------------------- Meta: tagueamento */

  async function metaTagueamento(env, { pixel, conta, dias = 28 }) {
    const falhas = {};
    const out = { falhas };
    if (pixel) {
      const inicio = Math.floor(Date.now() / 1000) - Math.min(dias, 28) * 86400 + 3600;
      const [det, ev, orig, host] = await Promise.all([
        secao(falhas, "pixel", () => graph(env, pixel, { fields: "id,name,is_unavailable,last_fired_time,creation_time,data_use_setting,first_party_cookie_status,owner_business" })),
        secao(falhas, "pixel_eventos", () => graph(env, `${pixel}/stats`, { aggregation: "event", start_time: inicio })),
        secao(falhas, "pixel_origem", () => graph(env, `${pixel}/stats`, { aggregation: "event_source", start_time: inicio })),
        secao(falhas, "pixel_hosts", () => graph(env, `${pixel}/stats`, { aggregation: "host", start_time: inicio })),
      ]);
      out.pixel = { detalhes: det, dias: Math.min(dias, 28), eventos: somaStats(ev?.data), origem: somaStats(orig?.data), hosts: somaStats(host?.data) };
    }
    if (conta) {
      const ativos = JSON.stringify([{ field: "effective_status", operator: "IN", value: ["ACTIVE"] }]);
      const [anuncios, conjuntos] = await Promise.all([
        secao(falhas, "utm", () =>
          graphPaginas(env, `${act(conta)}/ads`, {
            fields: "id,name,effective_status,campaign{name},adset{name},creative{id,url_tags,link_url,object_story_spec,asset_feed_spec}",
            filtering: ativos,
            limit: 100,
          })
        ),
        secao(falhas, "otimizacao", () =>
          graphPaginas(env, `${act(conta)}/adsets`, {
            fields: "id,name,effective_status,optimization_goal,promoted_object,destination_type,attribution_spec,campaign{name,objective}",
            filtering: ativos,
            limit: 100,
          })
        ),
      ]);
      out.utm_anuncios = (anuncios || []).map((ad) => {
        const c = ad.creative || {};
        const tags = c.url_tags || "";
        const destinos = linksDoCriativo(c);
        const temUtm = tags.includes("utm_") || destinos.some((l) => l.includes("utm_"));
        return {
          anuncio: ad.name,
          id: ad.id,
          campanha: ad.campaign?.name,
          conjunto: ad.adset?.name,
          destinos,
          url_tags: tags || null,
          diagnostico: temUtm && tags.includes("{{") ? "ok" : temUtm ? "UTM fixa (sem macros)" : "SEM UTM",
        };
      });
      out.conjuntos_ativos = conjuntos;
    }
    return out;
  }

  /* ---------------------------------------------------------------- coleta de mídia: Meta */

  const CAMPOS_INSIGHT = "spend,impressions,reach,frequency,inline_link_clicks,inline_link_click_ctr,cost_per_inline_link_click,cpm,actions";

  function resumoMeta(l = {}) {
    const a = Object.fromEntries((l.actions || []).map((x) => [x.action_type, num(x.value)]));
    const invest = num(l.spend);
    const lpv = a.landing_page_view || 0;
    return {
      investimento: r2(invest),
      impressoes: Math.round(num(l.impressions)),
      alcance: Math.round(num(l.reach)),
      frequencia: r2(l.frequency),
      cliques_link: Math.round(num(l.inline_link_clicks)),
      ctr_link: r2(l.inline_link_click_ctr),
      cpc_link: r2(l.cost_per_inline_link_click),
      cpm: r2(l.cpm),
      lpv: Math.round(lpv),
      custo_lpv: div(invest, lpv),
      conversas: Math.round(a["onsite_conversion.messaging_conversation_started_7d"] || 0),
      leads_pixel: Math.round(a.lead ?? a["offsite_conversion.fb_pixel_lead"] ?? 0),
      leads_formulario_meta: Math.round(a["onsite_conversion.lead_grouped"] || 0),
      conversoes_personalizadas: Object.fromEntries(
        Object.entries(a)
          .filter(([k]) => k.startsWith("offsite_conversion.custom."))
          .map(([k, v]) => [k.split(".").slice(2).join("."), v])
      ),
    };
  }

  const PARTES_META = ["conta", "resumo", "campanhas", "conjuntos", "anuncios", "quebras", "diario", "pixel", "conversoes_personalizadas"];

  async function coletaMeta(env, conta, pixel, partes = PARTES_META) {
    const per = periodos();
    const falhas = {};
    const out = { conta_id: idConta(conta), periodos: per, falhas };
    const quer = (p) => partes.includes(p);
    const faixa = (p) => JSON.stringify({ since: p.inicio, until: p.fim });
    const insights = (p, nivel = "account", extra = {}, campos = CAMPOS_INSIGHT) =>
      graphPaginas(env, `${act(conta)}/insights`, { level: nivel, fields: campos, time_range: faixa(p), limit: 500, ...extra });
    const tarefas = [];

    if (quer("conta")) {
      tarefas.push(
        secao(falhas, "conta", () => graph(env, act(conta), { fields: "name,currency,timezone_name,account_status,disable_reason,spend_cap,amount_spent" })).then((c) => {
          if (c) {
            const cap = num(c.spend_cap) / 100;
            const gasto = num(c.amount_spent) / 100;
            Object.assign(c, { limite_gastos: cap || null, gasto_acumulado: r2(gasto), restante_limite: cap ? r2(cap - gasto) : null });
          }
          out.conta = c;
        })
      );
    }
    if (quer("resumo")) {
      out.resumo = {};
      for (const [k, p] of Object.entries(per)) {
        tarefas.push(secao(falhas, `resumo_${k}`, () => insights(p)).then((l) => (out.resumo[k] = l?.length ? resumoMeta(l[0]) : null)));
      }
    }
    if (quer("campanhas")) {
      tarefas.push(
        (async () => {
          const camp = (await secao(falhas, "campanhas", () =>
            graphPaginas(env, `${act(conta)}/campaigns`, { fields: "id,name,objective,effective_status,daily_budget,lifetime_budget,bid_strategy,created_time", limit: 200 })
          )) || [];
          const porPeriodo = {};
          await Promise.all(
            ["p30", "ant30", "p90"].map(async (k) => {
              const l = (await secao(falhas, `campanhas_${k}`, () => insights(per[k], "campaign", {}, CAMPOS_INSIGHT + ",campaign_id"))) || [];
              porPeriodo[k] = Object.fromEntries(l.map((x) => [x.campaign_id, resumoMeta(x)]));
            })
          );
          out.campanhas = camp
            .map((c) => ({
              id: c.id,
              nome: c.name,
              objetivo: c.objective,
              status: c.effective_status,
              orcamento_diario: num(c.daily_budget) / 100 || null,
              lance: c.bid_strategy,
              metricas: Object.fromEntries(Object.keys(porPeriodo).map((k) => [k, porPeriodo[k][c.id] || null])),
            }))
            .filter((c) => Object.values(c.metricas).some(Boolean) || c.status === "ACTIVE")
            .sort((a, b) => (b.metricas.p30?.investimento || 0) - (a.metricas.p30?.investimento || 0));
        })()
      );
    }
    if (quer("conjuntos")) {
      tarefas.push(
        secao(falhas, "conjuntos", () =>
          graphPaginas(env, `${act(conta)}/adsets`, {
            fields:
              "id,name,campaign{name},effective_status,optimization_goal,promoted_object,attribution_spec,daily_budget,bid_strategy,learning_stage_info," +
              "targeting{geo_locations,age_min,age_max,genders,publisher_platforms,targeting_automation}",
            filtering: JSON.stringify([{ field: "effective_status", operator: "IN", value: ["ACTIVE"] }]),
            limit: 200,
          })
        ).then((c) => (out.conjuntos = c))
      );
    }
    if (quer("anuncios")) {
      tarefas.push(
        (async () => {
          const [lista, rank] = await Promise.all([
            secao(falhas, "anuncios", () =>
              graphPaginas(env, `${act(conta)}/ads`, {
                fields: "id,name,effective_status,issues_info,campaign{name},adset{name},creative{id,url_tags,link_url,object_story_spec,asset_feed_spec}",
                filtering: JSON.stringify([{ field: "effective_status", operator: "IN", value: ["ACTIVE", "WITH_ISSUES", "DISAPPROVED", "PENDING_REVIEW"] }]),
                limit: 200,
              })
            ),
            secao(falhas, "anuncios_p30", () =>
              insights(per.p30, "ad", {}, CAMPOS_INSIGHT + ",ad_id,quality_ranking,engagement_rate_ranking,conversion_rate_ranking")
            ),
          ]);
          const porId = Object.fromEntries((rank || []).map((r) => [r.ad_id, r]));
          out.anuncios = (lista || [])
            .map((a) => {
              const r = porId[a.id];
              const cr = a.creative || {};
              return {
                id: a.id,
                nome: a.name,
                status: a.effective_status,
                campanha: a.campaign?.name,
                conjunto: a.adset?.name,
                problemas: (a.issues_info || []).map((i) => i.error_summary || i.error_message),
                destinos: linksDoCriativo(cr),
                url_tags: cr.url_tags || null,
                ranking_qualidade: r?.quality_ranking,
                ranking_engajamento: r?.engagement_rate_ranking,
                ranking_conversao: r?.conversion_rate_ranking,
                p30: r ? resumoMeta(r) : null,
              };
            })
            .sort((a, b) => (b.p30?.investimento || 0) - (a.p30?.investimento || 0));
        })()
      );
    }
    if (quer("quebras")) {
      out.quebras_p30 = {};
      for (const [nome, quebra] of [["posicionamento", "publisher_platform,platform_position"], ["idade", "age"], ["genero", "gender"]]) {
        tarefas.push(
          secao(falhas, `quebra_${nome}`, () => insights(per.p30, "account", { breakdowns: quebra })).then(
            (l) => (out.quebras_p30[nome] = (l || []).map((x) => ({ rotulo: quebra.split(",").map((c) => x[c] ?? "").join(" / "), ...resumoMeta(x) })))
          )
        );
      }
    }
    if (quer("diario")) {
      tarefas.push(
        secao(falhas, "diario", () => insights(per.p90, "account", { time_increment: 1 })).then(
          (l) => (out.diario_p90 = (l || []).map((x) => ({ dia: x.date_start, ...resumoMeta(x) })))
        )
      );
    }
    if (quer("pixel") && pixel) {
      tarefas.push(
        (async () => {
          const inicio = Math.floor(Date.now() / 1000) - 27 * 86400;
          const [ev, orig, det] = await Promise.all([
            secao(falhas, "pixel_eventos", () => graph(env, `${pixel}/stats`, { aggregation: "event", start_time: inicio })),
            secao(falhas, "pixel_origem", () => graph(env, `${pixel}/stats`, { aggregation: "event_source", start_time: inicio })),
            secao(falhas, "pixel", () => graph(env, pixel, { fields: "name,last_fired_time,is_unavailable" })),
          ]);
          out.pixel = { id: pixel, detalhes: det, dias: 28, eventos: somaStats(ev?.data), origem: somaStats(orig?.data) };
        })()
      );
    }
    if (quer("conversoes_personalizadas")) {
      tarefas.push(
        secao(falhas, "conversoes_personalizadas", () =>
          graphPaginas(env, `${act(conta)}/customconversions`, { fields: "id,name,custom_event_type,rule,last_fired_time,is_archived" })
        ).then((c) => (out.conversoes_personalizadas = c))
      );
    }
    await Promise.all(tarefas);
    return out;
  }

  /* ---------------------------------------------------------------- coleta de mídia: Google Ads */

  const PARTES_GOOGLE = ["conta", "resumo", "campanhas", "conversoes", "palavras", "termos", "anuncios", "pmax", "diario", "hora", "dia_semana", "cidades", "alteracoes"];

  function metricasAds(l = {}) {
    const x = l.metrics || {};
    const custo = r2(num(x.costMicros) / 1e6);
    const conv = r1(x.conversions);
    const cliques = Math.round(num(x.clicks));
    const impr = Math.round(num(x.impressions));
    return {
      investimento: custo,
      impressoes: impr,
      cliques,
      ctr: impr ? r2((100 * cliques) / impr) : null,
      cpc: div(custo, cliques),
      conversoes: conv,
      todas_conversoes: r1(x.allConversions),
      custo_conversao: div(custo, conv),
    };
  }

  async function coletaGoogle(env, conta, partes = PARTES_GOOGLE) {
    const per = periodos();
    const entre = (p) => `segments.date BETWEEN '${p.inicio}' AND '${p.fim}'`;
    const falhas = {};
    const out = { cliente_id: idConta(conta), periodos: per, falhas };
    const g = async (nome, q) => (await secao(falhas, nome, () => gaql(env, conta, q))) || [];
    const quer = (p) => partes.includes(p);
    const tarefas = [];
    const M = "metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.all_conversions";

    if (quer("conta")) {
      tarefas.push(
        g(
          "conta",
          "SELECT customer.descriptive_name, customer.currency_code, customer.time_zone, customer.optimization_score, " +
            "customer.auto_tagging_enabled, customer.final_url_suffix FROM customer"
        ).then((c) => (out.conta = c[0]?.customer || null))
      );
    }
    if (quer("resumo")) {
      out.resumo = {};
      for (const [k, p] of Object.entries(per)) {
        tarefas.push(g(`resumo_${k}`, `SELECT ${M} FROM customer WHERE ${entre(p)}`).then((r) => (out.resumo[k] = r.length ? metricasAds(r[0]) : null)));
      }
    }
    if (quer("campanhas")) {
      const campos =
        "campaign.id, campaign.name, campaign.status, campaign.primary_status, campaign.advertising_channel_type, " +
        "campaign.bidding_strategy_type, campaign.maximize_conversions.target_cpa_micros, campaign.target_cpa.target_cpa_micros, " +
        `campaign_budget.amount_micros, ${M}, metrics.search_impression_share, metrics.search_budget_lost_impression_share, ` +
        "metrics.search_rank_lost_impression_share, metrics.search_top_impression_share";
      tarefas.push(
        (async () => {
          const camp = {};
          await Promise.all(
            ["p30", "ant30", "p90"].map(async (k) => {
              for (const l of await g(`campanhas_${k}`, `SELECT ${campos} FROM campaign WHERE ${entre(per[k])} AND campaign.status != 'REMOVED'`)) {
                const cp = l.campaign;
                const x = l.metrics || {};
                const item = (camp[cp.id] = camp[cp.id] || {
                  id: cp.id,
                  nome: cp.name,
                  status: cp.status,
                  status_primario: cp.primaryStatus,
                  tipo: cp.advertisingChannelType,
                  lance: cp.biddingStrategyType,
                  cpa_desejado: r2(num(cp.maximizeConversions?.targetCpaMicros || cp.targetCpa?.targetCpaMicros) / 1e6) || null,
                  orcamento_diario: r2(num(l.campaignBudget?.amountMicros) / 1e6),
                  metricas: {},
                });
                const m = metricasAds(l);
                if (k === "p30") {
                  Object.assign(m, {
                    parcela_impressoes: x.searchImpressionShare,
                    perda_orcamento: x.searchBudgetLostImpressionShare,
                    perda_classificacao: x.searchRankLostImpressionShare,
                    parcela_topo: x.searchTopImpressionShare,
                  });
                }
                item.metricas[k] = m;
              }
            })
          );
          out.campanhas = Object.values(camp).sort((a, b) => (b.metricas.p30?.investimento || 0) - (a.metricas.p30?.investimento || 0));
        })()
      );
    }
    if (quer("conversoes")) {
      tarefas.push(
        g(
          "acoes_conversao",
          "SELECT conversion_action.id, conversion_action.name, conversion_action.status, conversion_action.category, " +
            "conversion_action.type, conversion_action.origin, conversion_action.primary_for_goal, conversion_action.counting_type " +
            "FROM conversion_action WHERE conversion_action.status != 'REMOVED'"
        ).then((r) => (out.acoes_conversao = r.map((l) => l.conversionAction)))
      );
      tarefas.push(
        g(
          "conversoes_por_acao",
          "SELECT segments.conversion_action_name, segments.conversion_action_category, metrics.conversions, metrics.all_conversions " +
            `FROM customer WHERE ${entre(per.p30)}`
        ).then(
          (r) =>
            (out.conversoes_por_acao_p30 = r.map((l) => ({
              acao: l.segments?.conversionActionName,
              categoria: l.segments?.conversionActionCategory,
              conversoes: r1(l.metrics?.conversions),
              todas: r1(l.metrics?.allConversions),
            })))
        )
      );
    }
    if (quer("palavras")) {
      tarefas.push(
        g(
          "palavras",
          "SELECT campaign.name, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, " +
            "ad_group_criterion.quality_info.quality_score, ad_group_criterion.quality_info.post_click_quality_score, " +
            `ad_group_criterion.quality_info.search_predicted_ctr, ${M} FROM keyword_view WHERE ${entre(per.p30)} ` +
            "ORDER BY metrics.cost_micros DESC LIMIT 60"
        ).then(
          (r) =>
            (out.palavras_p30 = r.map((l) => ({
              texto: l.adGroupCriterion?.keyword?.text,
              correspondencia: l.adGroupCriterion?.keyword?.matchType,
              campanha: l.campaign?.name,
              iq: l.adGroupCriterion?.qualityInfo?.qualityScore,
              lp: l.adGroupCriterion?.qualityInfo?.postClickQualityScore,
              ctr_esperado: l.adGroupCriterion?.qualityInfo?.searchPredictedCtr,
              ...metricasAds(l),
            })))
        )
      );
      tarefas.push(
        g(
          "palavras_ativas",
          "SELECT ad_group_criterion.keyword.match_type, ad_group_criterion.quality_info.quality_score FROM ad_group_criterion " +
            "WHERE ad_group_criterion.type = 'KEYWORD' AND ad_group_criterion.status = 'ENABLED' AND ad_group.status = 'ENABLED' " +
            "AND campaign.status = 'ENABLED'"
        ).then((ativas) => {
          const dist = {};
          for (const l of ativas) {
            const t = l.adGroupCriterion?.keyword?.matchType;
            dist[t] = (dist[t] || 0) + 1;
          }
          out.palavras_ativas = { total: ativas.length, por_correspondencia: dist, sem_iq: ativas.filter((l) => !l.adGroupCriterion?.qualityInfo?.qualityScore).length };
        })
      );
    }
    if (quer("termos")) {
      tarefas.push(
        g(
          "termos",
          `SELECT search_term_view.search_term, campaign.name, ${M} FROM search_term_view WHERE ${entre(per.p30)} ` +
            "ORDER BY metrics.cost_micros DESC LIMIT 300"
        ).then((r) => (out.termos_p30 = r.map((l) => ({ termo: l.searchTermView?.searchTerm, campanha: l.campaign?.name, ...metricasAds(l) }))))
      );
    }
    if (quer("anuncios")) {
      tarefas.push(
        g(
          "anuncios",
          "SELECT campaign.name, ad_group.name, ad_group_ad.ad.type, ad_group_ad.ad_strength, ad_group_ad.policy_summary.approval_status " +
            "FROM ad_group_ad WHERE ad_group_ad.status = 'ENABLED' AND campaign.status = 'ENABLED' AND ad_group.status = 'ENABLED'"
        ).then(
          (r) =>
            (out.anuncios = r.map((l) => ({
              campanha: l.campaign?.name,
              grupo: l.adGroup?.name,
              tipo: l.adGroupAd?.ad?.type,
              forca: l.adGroupAd?.adStrength,
              politica: l.adGroupAd?.policySummary?.approvalStatus,
            })))
        )
      );
    }
    if (quer("pmax")) {
      tarefas.push(
        g(
          "redes_pmax",
          `SELECT campaign.name, segments.ad_network_type, ${M} FROM campaign WHERE campaign.advertising_channel_type = 'PERFORMANCE_MAX' AND ${entre(per.p30)}`
        ).then((r) => (out.redes_pmax_p30 = r.map((l) => ({ campanha: l.campaign?.name, rede: l.segments?.adNetworkType, ...metricasAds(l) }))))
      );
    }
    if (quer("diario")) {
      tarefas.push(
        g("diario", `SELECT segments.date, ${M} FROM customer WHERE ${entre(per.p90)}`).then(
          (r) => (out.diario_p90 = r.map((l) => ({ dia: l.segments?.date, ...metricasAds(l) })).sort((a, b) => String(a.dia).localeCompare(String(b.dia))))
        )
      );
    }
    if (quer("hora")) {
      tarefas.push(
        g("hora", `SELECT segments.hour, ${M} FROM customer WHERE ${entre(per.p30)}`).then(
          (r) => (out.hora_p30 = r.map((l) => ({ hora: l.segments?.hour, ...metricasAds(l) })))
        )
      );
    }
    if (quer("dia_semana")) {
      tarefas.push(
        g("dia_semana", `SELECT segments.day_of_week, ${M} FROM customer WHERE ${entre(per.p30)}`).then(
          (r) => (out.dia_semana_p30 = r.map((l) => ({ dia: l.segments?.dayOfWeek, ...metricasAds(l) })))
        )
      );
    }
    if (quer("cidades")) {
      tarefas.push(
        (async () => {
          const cidades = await g(
            "cidades",
            `SELECT segments.geo_target_city, ${M} FROM user_location_view WHERE ${entre(per.p30)} ORDER BY metrics.cost_micros DESC LIMIT 15`
          );
          const recursos = [...new Set(cidades.map((l) => l.segments?.geoTargetCity).filter(Boolean))];
          const nomes = {};
          if (recursos.length) {
            for (const l of await g(
              "cidades_nomes",
              `SELECT geo_target_constant.resource_name, geo_target_constant.name FROM geo_target_constant WHERE geo_target_constant.resource_name IN (${recursos
                .map((x) => `'${x}'`)
                .join(", ")})`
            )) {
              nomes[l.geoTargetConstant.resourceName] = l.geoTargetConstant.name;
            }
          }
          out.cidades_p30 = cidades.map((l) => ({ cidade: nomes[l.segments?.geoTargetCity] || l.segments?.geoTargetCity, ...metricasAds(l) }));
        })()
      );
    }
    if (quer("alteracoes")) {
      tarefas.push(
        g(
          "alteracoes",
          "SELECT change_event.change_date_time, change_event.change_resource_type, change_event.user_email, change_event.client_type " +
            `FROM change_event WHERE change_event.change_date_time >= '${per.p30.inicio}' ORDER BY change_event.change_date_time DESC LIMIT 200`
        ).then((alt) => {
          const porTipo = {};
          for (const l of alt) porTipo[l.changeEvent?.changeResourceType] = (porTipo[l.changeEvent?.changeResourceType] || 0) + 1;
          out.alteracoes_p30 = { total: alt.length, ultima: alt[0]?.changeEvent?.changeDateTime || null, por_tipo: porTipo };
        })
      );
    }
    await Promise.all(tarefas);
    out.versao_api = versaoAds;
    return out;
  }

  /* ---------------------------------------------------------------- leads reais (banco do site do cliente) */

  function canal(origem, midia) {
    const o = String(origem || "").toLowerCase();
    const md = String(midia || "").toLowerCase();
    const pago = ["cpc", "paid", "paid_social", "lead", "ppc", "ads"].includes(md) || md.includes("paid");
    if (/google ads|adwords|gclid/.test(o) || (o.includes("google") && pago)) return "google";
    if (/meta|instagram|facebook|\bfb\b|\big\b/.test(o) && (pago || md === "" || md === "social")) return "meta";
    if (md === "organic" || md === "organico" || o.includes("busca")) return "organico";
    if (o === "direto" || o === "" || md === "direto") return "direto";
    return "outros";
  }

  async function coletaLeads(env, ficha) {
    const sql = ficha.leads?.consulta_periodo;
    const cfx = ficha.cloudflare || {};
    if (!sql) falha("A ficha não tem leads.consulta_periodo (SELECT com origem, midia, campanha, n e {inicio}/{fim}).");
    if (!ehSelect(sql)) falha("leads.consulta_periodo precisa ser uma única consulta de leitura (SELECT).");
    if (!cfx.conta || !cfx.d1_banco) falha("A ficha não tem cloudflare.conta e cloudflare.d1_banco.");
    const per = periodos();
    const falhas = {};
    const out = { periodos: per, falhas, por_periodo: {} };
    await Promise.all(
      Object.entries(per).map(async ([k, p]) => {
        const consulta = sql.replaceAll("{inicio}", p.inicio).replaceAll("{fim}", `${p.fim} 23:59:59`);
        const r = await secao(falhas, k, () => cf(env, "POST", `accounts/${cfx.conta}/d1/database/${cfx.d1_banco}/query`, { sql: consulta }));
        const linhas = (Array.isArray(r) ? r[0]?.results : null) || [];
        let total = 0;
        const canais = {};
        for (const l of linhas) {
          const n = Math.round(num(l.n));
          total += n;
          const c = canal(l.origem, l.midia);
          canais[c] = (canais[c] || 0) + n;
        }
        // Só contagens agregadas por origem/mídia/campanha: nenhum dado pessoal sai daqui.
        out.por_periodo[k] = { total, por_canal: canais, linhas: linhas.map((l) => ({ origem: l.origem, midia: l.midia, campanha: l.campanha, n: num(l.n) })) };
      })
    );
    return out;
  }

  /* ---------------------------------------------------------------- acessos e descoberta */

  async function acessos(env) {
    const falhas = {};
    const out = { credenciais: Object.fromEntries(Object.keys(CREDENCIAIS).map((g) => [g, temCredencial(env, g)])), falhas };
    const t = [];
    if (temCredencial(env, "google")) {
      out.conta_servico = contaServico(env).client_email;
      t.push(
        secao(falhas, "ga4", () => googleLista(env, `${GA4_ADMIN}/v1beta/accountSummaries`, "accountSummaries")).then(
          (c) =>
            (out.ga4 = (c || []).map((x) => ({
              conta: x.displayName,
              propriedades: (x.propertySummaries || []).map((p) => ({ id: p.property.split("/")[1], nome: p.displayName })),
            })))
        )
      );
      t.push(
        (async () => {
          const contas = (await secao(falhas, "gtm", () => googleLista(env, `${GTM_API}/accounts`, "account"))) || [];
          out.gtm = await Promise.all(
            contas.map(async (conta) => ({
              conta: conta.name,
              conteineres: ((await secao(falhas, `gtm_${conta.accountId}`, () => googleLista(env, `${GTM_API}/${conta.path}/containers`, "container"))) || []).map(
                (c) => ({ id: c.publicId, nome: c.name })
              ),
            }))
          );
        })()
      );
    }
    if (temCredencial(env, "google_ads")) {
      const mcc = idConta(env.GOOGLE_ADS_LOGIN_CUSTOMER_ID);
      t.push(
        (mcc
          ? secao(falhas, "google_ads", () =>
              gaql(env, mcc, "SELECT customer_client.id, customer_client.descriptive_name, customer_client.manager, customer_client.status FROM customer_client WHERE customer_client.level <= 1")
            ).then((r) => (r || []).map((l) => l.customerClient))
          : secao(falhas, "google_ads", () => ads(env, "GET", "customers:listAccessibleCustomers")).then((r) => r?.resourceNames)
        ).then((r) => (out.google_ads = { mcc: mcc || null, contas: r, versao_api: versaoAds }))
      );
    }
    if (temCredencial(env, "meta")) {
      t.push(
        secao(falhas, "meta", () => graphPaginas(env, "me/adaccounts", { fields: "account_id,name,account_status,business{id,name}", limit: 100 }, 5)).then(
          (r) => (out.meta = (r || []).map((c) => ({ conta: c.account_id, nome: c.name, status: c.account_status, business: c.business?.name })))
        )
      );
    }
    if (temCredencial(env, "cloudflare")) {
      t.push(secao(falhas, "cloudflare", () => cf(env, "GET", "accounts?per_page=50")).then((r) => (out.cloudflare = (r || []).map((c) => ({ id: c.id, nome: c.name })))));
    }
    await Promise.all(t);
    return out;
  }

  async function descobrir(env, url) {
    const site = await varrerSite(url, 8);
    const ids = { gtm: new Set(site.ids_encontrados.gtm || []), ga4: new Set(site.ids_encontrados.ga4 || []), ads: new Set(), pixel: new Set(site.ids_encontrados.meta_pixel || []) };
    for (const aw of site.ids_encontrados.google_ads || []) ids.ads.add(aw.replace("AW-", ""));
    const falhas = {};
    for (const gtm of ids.gtm) {
      const r = await secao(falhas, `publicado_${gtm}`, () => lerPublicado(gtm));
      for (const t of r?.tags || []) {
        const p = t.parametros || {};
        for (const v of [p.tagId, p.measurementId, p.measurementIdOverride]) if (typeof v === "string" && v.startsWith("G-")) ids.ga4.add(v);
        if (t.funcao === "__awct" && p.conversionId) ids.ads.add(String(p.conversionId));
        for (const px of t.detectado?.meta_pixel_init || []) ids.pixel.add(px);
      }
    }
    const achou = { ga4: {}, google_ads: {}, meta: {}, cloudflare: null };
    const t = [];
    if (ids.ga4.size && temCredencial(env, "google")) {
      t.push(
        secao(falhas, "ga4", async () => {
          for (const c of await googleLista(env, `${GA4_ADMIN}/v1beta/accountSummaries`, "accountSummaries")) {
            for (const p of c.propertySummaries || []) {
              for (const f of await googleLista(env, `${GA4_ADMIN}/v1beta/${p.property}/dataStreams`, "dataStreams")) {
                const mid = f.webStreamData?.measurementId;
                if (ids.ga4.has(mid)) achou.ga4[mid] = { propriedade: p.property.split("/")[1], nome: p.displayName };
              }
            }
          }
        })
      );
    }
    if (ids.ads.size && temCredencial(env, "google_ads") && env.GOOGLE_ADS_LOGIN_CUSTOMER_ID) {
      t.push(
        secao(falhas, "google_ads", async () => {
          const mcc = idConta(env.GOOGLE_ADS_LOGIN_CUSTOMER_ID);
          const clientes = await gaql(env, mcc, "SELECT customer_client.id, customer_client.descriptive_name, customer_client.manager FROM customer_client WHERE customer_client.level <= 1");
          for (const l of clientes) {
            const cc = l.customerClient || {};
            if (cc.manager) continue;
            const r = await secao({}, "x", () => gaql(env, cc.id, "SELECT customer.conversion_tracking_setting.conversion_tracking_id FROM customer"));
            const tid = String(r?.[0]?.customer?.conversionTrackingSetting?.conversionTrackingId || "");
            if (ids.ads.has(tid)) achou.google_ads[tid] = { cliente: cc.id, nome: cc.descriptiveName };
          }
        })
      );
    }
    if (ids.pixel.size && temCredencial(env, "meta")) {
      t.push(
        secao(falhas, "meta", async () => {
          for (const c of await graphPaginas(env, "me/adaccounts", { fields: "account_id,name,business{id},adspixels{id}", limit: 100 }, 5)) {
            for (const px of c.adspixels?.data || []) {
              if (ids.pixel.has(px.id)) (achou.meta[px.id] = achou.meta[px.id] || []).push({ conta: c.account_id, nome: c.name, business: c.business?.id });
            }
          }
        })
      );
    }
    if (temCredencial(env, "cloudflare")) {
      t.push(
        secao(falhas, "cloudflare", async () => {
          const dominio = new URL(site.site).hostname.replace(/^www\./, "");
          const zonas = (await cf(env, "GET", `zones?name=${encodeURIComponent(dominio)}`)) || [];
          if (!zonas.length) return;
          const conta = zonas[0].account.id;
          achou.cloudflare = { conta, zona: zonas[0].id };
          for (const p of (await cf(env, "GET", `accounts/${conta}/pages/projects`)) || []) {
            if ((p.domains || []).some((d) => d.replace(/^www\./, "") === dominio)) {
              const fonte = p.source?.config || {};
              const bancos = Object.values(p.deployment_configs?.production?.d1_databases || {});
              Object.assign(achou.cloudflare, {
                projeto_pages: p.name,
                repositorio: fonte.repo_name ? `${fonte.owner}/${fonte.repo_name}` : "",
                d1_banco: bancos[0]?.id || "",
              });
              break;
            }
          }
        })
      );
    }
    await Promise.all(t);
    const host = new URL(site.site).hostname.replace(/^www\./, "");
    const ga4 = [...ids.ga4][0] || "";
    const aw = [...ids.ads][0] || "";
    const px = [...ids.pixel][0] || "";
    return {
      ids_encontrados: Object.fromEntries(Object.entries(ids).map(([k, v]) => [k, [...v].sort()])),
      contas_encontradas: achou,
      ficha_sugerida: {
        cliente: { nome: "", slug: norm(host.split(".")[0]).replace(/[^a-z0-9]+/g, "-") },
        site: { url: site.site, eventos_datalayer: Object.keys(site.eventos_datalayer_no_codigo) },
        google: { gtm: [...ids.gtm][0] || "", ga4, ga4_propriedade: achou.ga4[ga4]?.propriedade || "", ads_tag: aw ? `AW-${aw}` : "", ads_cliente: achou.google_ads[aw]?.cliente || "" },
        meta: { pixel: px, conta: achou.meta[px]?.[0]?.conta || "", business: achou.meta[px]?.[0]?.business || "" },
        cloudflare: achou.cloudflare || {},
      },
      perguntar_ao_analista: [
        "Nome do cliente, segmento e o que conta como lead (visita, matrícula, orçamento...).",
        "Quem mantém o código do site e quem aprova mudanças.",
        ...(Object.keys(falhas).length ? ["Pedir acesso ao cliente onde a descoberta falhou (veja falhas)."] : []),
      ],
      falhas,
    };
  }

  /* ---------------------------------------------------------------- ferramentas */

  const P_CLIENTE = { type: "string", description: "Slug da ficha do cliente (midia_clientes). Os IDs vêm da ficha." };
  const P_PARTES = (lista) => ({
    type: "array",
    items: { type: "string", enum: lista },
    description: `Partes da coleta. Padrão: todas (${lista.join(", ")}). Peça menos partes para respostas menores.`,
  });
  const exigeId = (v, msg) => v || falha(msg);
  const SLUG = /^[a-z0-9][a-z0-9-]{1,60}$/;
  const SECOES_FICHA = ["cliente", "site", "google", "meta", "cloudflare", "leads"];

  const ferramentas = [
    {
      nome: "midia_clientes",
      titulo: "Clientes de mídia (fichas)",
      tipo: "leitura",
      papel: "leitor",
      idempotente: true,
      descricao:
        "Sem 'slug': lista os clientes com ficha. Com 'slug': devolve a ficha completa (IDs de GTM, GA4, Google Ads, Meta, " +
        "Cloudflare, consulta de leads e histórico). Fichas guardam só IDs, nunca credenciais. Comece por aqui para saber os IDs " +
        "de um cliente; se ele não tiver ficha, use midia_descobrir com o site.",
      entrada: { type: "object", properties: { slug: { type: "string" } } },
      async executar(a, c) {
        await garantirTabela(c.env);
        if (a.slug) return { dados: await lerFicha(c.env, a.slug), log: { alvo: `ficha ${a.slug}` } };
        const { results } = await c.env.DB.prepare("SELECT slug, nome, atualizado_em, atualizado_por FROM midia_clientes ORDER BY nome").all();
        return { dados: { clientes: results }, log: { alvo: `${results.length} fichas` } };
      },
    },

    {
      nome: "midia_salvar_cliente",
      titulo: "Salvar ficha de cliente",
      tipo: "escrita",
      papel: "editor",
      descricao:
        "Cria ou atualiza a ficha de um cliente no MCP (não mexe em nenhuma plataforma). 'ficha' é mesclada por seção: " +
        "cliente{nome,segmento,lead_principal}, site{url,repositorio,plataforma,pagina_obrigado,eventos_datalayer[]}, " +
        "google{gtm,ga4,ga4_propriedade,ads_tag,ads_cliente,ads_conversoes{}}, meta{pixel,conta,business}, " +
        "cloudflare{conta,projeto_pages,d1_banco}, leads{consulta_periodo}. leads.consulta_periodo é um único SELECT que devolve " +
        "origem, midia, campanha e n, com {inicio} e {fim} no lugar das datas. 'historico' acrescenta uma linha datada " +
        "(auditoria feita, correção aplicada, link do relatório). Nunca grave token, senha ou chave na ficha. As seções " +
        "cloudflare e leads só podem ser alteradas por administrador.",
      entrada: {
        type: "object",
        properties: {
          slug: { type: "string", description: "minúsculas, números e hífen (ex.: colegio-super-humanos)" },
          nome: { type: "string" },
          ficha: { type: "object", description: "Seções a criar ou atualizar" },
          historico: { type: "string", description: "Linha a acrescentar no histórico" },
          motivo: P_MOTIVO,
        },
        required: ["slug", "motivo"],
      },
      async executar(a, c) {
        await garantirTabela(c.env);
        const slug = String(a.slug).trim().toLowerCase();
        if (!SLUG.test(slug)) falha("slug inválido: use minúsculas, números e hífen.");
        const atual = await c.env.DB.prepare("SELECT nome, ficha FROM midia_clientes WHERE slug = ?1").bind(slug).first();
        const antes = atual ? JSON.parse(atual.ficha) : null;
        const ficha = antes ? structuredClone(antes) : { cliente: { slug }, historico: [] };
        const novo = a.ficha && typeof a.ficha === "object" ? a.ficha : {};
        // cloudflare/leads definem qual banco é consultado com o token da agência: só administrador altera.
        if ((novo.cloudflare || novo.leads) && c.usuario.papel !== "admin") {
          falha("Só administrador altera as seções cloudflare e leads da ficha (definem qual banco é consultado).");
        }
        for (const k of Object.keys(novo)) {
          if (!SECOES_FICHA.includes(k)) falha(`Seção desconhecida na ficha: ${k}. Use: ${SECOES_FICHA.join(", ")}.`);
          if (typeof novo[k] !== "object" || Array.isArray(novo[k])) falha(`A seção ${k} precisa ser um objeto.`);
          ficha[k] = { ...(ficha[k] || {}), ...novo[k] };
        }
        // Os IDs da Cloudflare entram no caminho da API chamada com o token da agência:
        // só formatos exatos, para nada além de um ID chegar lá.
        if (ficha.cloudflare?.conta && !/^[a-f0-9]{32}$/.test(String(ficha.cloudflare.conta))) falha("cloudflare.conta precisa ser o ID da conta (32 caracteres hexadecimais).");
        if (ficha.cloudflare?.d1_banco && !/^[a-f0-9-]{36}$/.test(String(ficha.cloudflare.d1_banco))) falha("cloudflare.d1_banco precisa ser o UUID do banco D1.");
        if (ficha.cloudflare?.zona && !/^[a-f0-9]{32}$/.test(String(ficha.cloudflare.zona))) falha("cloudflare.zona precisa ser o ID da zona (32 caracteres hexadecimais).");
        ficha.cliente = { ...(ficha.cliente || {}), slug, ...(a.nome ? { nome: a.nome } : {}) };
        const nome = ficha.cliente.nome || atual?.nome;
        if (!nome) falha("Informe o nome do cliente (campo 'nome').");
        if (ficha.leads?.consulta_periodo && !ehSelect(ficha.leads.consulta_periodo)) falha("leads.consulta_periodo precisa ser uma única consulta SELECT.");
        if (/(EAA[A-Za-z0-9]{20,}|ya29\.|1\/\/0|-----BEGIN|AIza[0-9A-Za-z_-]{30,})/.test(JSON.stringify(ficha))) {
          falha("A ficha parece conter um token ou chave. Fichas guardam só IDs; credenciais ficam nos secrets do Worker.");
        }
        if (a.historico) ficha.historico = [`${new Date().toISOString().slice(0, 10)} (${c.usuario.nome}): ${String(a.historico).slice(0, 1000)}`, ...(ficha.historico || [])];
        const texto = JSON.stringify(ficha);
        await c.env.DB.prepare(
          `INSERT INTO midia_clientes (slug, nome, ficha, atualizado_por) VALUES (?1, ?2, ?3, ?4)
           ON CONFLICT(slug) DO UPDATE SET nome = ?2, ficha = ?3, atualizado_em = datetime('now'), atualizado_por = ?4`
        )
          .bind(slug, nome, texto, c.usuario.nome)
          .run();
        return {
          dados: { slug, nome, criado: !antes, ficha },
          log: { alvo: `ficha ${slug}`, antes, depois: ficha },
        };
      },
    },

    {
      nome: "midia_acessos",
      titulo: "Acessos da agência",
      tipo: "leitura",
      papel: "leitor",
      idempotente: true,
      descricao:
        "Mostra o que as credenciais da agência enxergam: propriedades do GA4, contêineres do GTM, contas do Google Ads na MCC, " +
        "contas de anúncios do Meta e contas da Cloudflare, e quais credenciais faltam no servidor. Use para conferir se um " +
        "cliente já concedeu acesso; o que faltar vira pedido de acesso ao cliente.",
      entrada: { type: "object", properties: {} },
      async executar(a, c) {
        return { dados: await acessos(c.env), log: {} };
      },
    },

    {
      nome: "midia_descobrir",
      titulo: "Descobrir IDs de um site",
      tipo: "leitura",
      papel: "leitor",
      idempotente: true,
      descricao:
        "A partir só do endereço do site: acha GTM, GA4, Google Ads e pixel do Meta instalados (no HTML e dentro do GTM " +
        "publicado) e, com as credenciais da agência, a propriedade do GA4, a conta do Google Ads, a conta do Meta e o " +
        "projeto/banco da Cloudflare. Devolve uma ficha sugerida: confirme com o analista e grave com midia_salvar_cliente.",
      entrada: { type: "object", properties: { site: { type: "string", description: "Endereço do site" } }, required: ["site"] },
      async executar(a, c) {
        return { dados: await descobrir(c.env, a.site), log: { alvo: a.site } };
      },
    },

    {
      nome: "tag_site",
      titulo: "Varredura do site",
      tipo: "leitura",
      papel: "leitor",
      idempotente: true,
      descricao:
        "Lê a home, o sitemap e os .js do próprio domínio: IDs instalados (GTM, GA4, Ads, pixel e outros), páginas sem GTM, " +
        "formulários e para onde enviam, eventos de dataLayer.push no código, links de WhatsApp, www x sem www, http x https " +
        "e o status de uma URL inexistente. Checklist: 1.1 (GTM em todas as páginas), 1.2 (tag duplicada fora do GTM), " +
        "1.4 (www redireciona), 1.5 (404 de verdade), 2.1 (como o lead acontece), 2.3 (eventos do dataLayer).",
      entrada: {
        type: "object",
        properties: { cliente: P_CLIENTE, url: { type: "string" }, max_paginas: { type: "integer", minimum: 1, maximum: 40, description: "Padrão: 25" } },
      },
      async executar(a, c) {
        const r = await resolver(c, a, { url: ["url", "site", "url"] });
        const dados = await varrerSite(exigeId(r.url, "Informe 'url' ou um cliente com site.url na ficha."), a.max_paginas || 25);
        return { dados, log: { alvo: dados.site } };
      },
    },

    {
      nome: "tag_publicado",
      titulo: "Contêiner publicado (GTM, GA4, Ads)",
      tipo: "leitura",
      papel: "leitor",
      idempotente: true,
      descricao:
        "Lê a versão PUBLICADA de um contêiner GTM ou de uma Google tag (G-, AW-) sem login: tags, acionadores em condições " +
        "legíveis, eventos escutados, variáveis; no G-, eventos criados, eventos-chave e medição otimizada. Com 'cliente', lê " +
        "GTM, GA4 e tag do Ads da ficha. Checklist: 1.2, 2.2 (acionadores apontam para algo que existe no site), 2.3, 2.4 " +
        "(conversão por clique em vez de envio), 3.1, 3.2, 3.5, 3.6, 4.5 (conversões otimizadas), 4.6 (ID de transação), 5.5.",
      entrada: { type: "object", properties: { cliente: P_CLIENTE, id: { type: "string", description: "GTM-XXXX, G-XXXX ou AW-XXXX" } } },
      async executar(a, c) {
        if (a.id) return { dados: await lerPublicado(a.id), log: { alvo: a.id } };
        const f = exigeId(a.cliente && (await lerFicha(c.env, a.cliente)), "Informe 'id' ou 'cliente'.");
        const ids = [f.google?.gtm, f.google?.ga4, f.google?.ads_tag].filter(Boolean);
        if (!ids.length) falha("A ficha não tem google.gtm, google.ga4 nem google.ads_tag.");
        const falhas = {};
        const dados = { falhas };
        await Promise.all(ids.map(async (id) => (dados[id] = await secao(falhas, id, () => lerPublicado(id)))));
        return { dados, log: { alvo: ids.join(", ") } };
      },
    },

    {
      nome: "tag_ga4",
      titulo: "GA4: configuração e relatório",
      tipo: "leitura",
      papel: "leitor",
      idempotente: true,
      descricao:
        "GA4 pela conta de serviço: fluxos, regras de criação de evento, medição otimizada, eventos-chave, vínculos com o " +
        "Google Ads, dimensões e retenção; e relatório dos últimos N dias: eventos, eventos-chave, leads por origem/mídia/" +
        "campanha, sessões por origem, hosts e páginas de obrigado. Checklist: 1.3 (ambientes de teste), 3.1 a 3.5. " +
        "403 = o cliente ainda não deu acesso à conta de serviço (Leitor na propriedade).",
      entrada: {
        type: "object",
        properties: {
          cliente: P_CLIENTE,
          propriedade: { type: "string", description: "Número da propriedade" },
          dias: { type: "integer", minimum: 1, maximum: 365, description: "Padrão: 28" },
          partes: { type: "array", items: { type: "string", enum: ["config", "relatorio"] }, description: "Padrão: as duas" },
        },
      },
      async executar(a, c) {
        const r = await resolver(c, a, { prop: ["propriedade", "google", "ga4_propriedade"] });
        const prop = exigeId(r.prop, "Informe 'propriedade' ou um cliente com google.ga4_propriedade na ficha.");
        const partes = a.partes?.length ? a.partes : ["config", "relatorio"];
        const [config, relatorio] = await Promise.all([
          partes.includes("config") ? ga4Config(c.env, prop) : null,
          partes.includes("relatorio") ? ga4Relatorio(c.env, prop, a.dias || 28) : null,
        ]);
        return { dados: { propriedade: idConta(prop), config, relatorio }, log: { alvo: `GA4 ${prop}` } };
      },
    },

    {
      nome: "tag_google_ads",
      titulo: "Google Ads: conversões e URLs",
      tipo: "leitura",
      papel: "leitor",
      idempotente: true,
      descricao:
        "Tagueamento no Google Ads: auto-tagging, sufixo de URL final, modelo de acompanhamento, ações de conversão (principal " +
        "ou secundária, origem, contagem), conversões por ação, campanhas com estratégia de lance e conversões, URLs finais. " +
        "Checklist: 4.1 (principais = as que disparam), 4.2 (lance por conversão com conversão zerada: crítico), 4.3, 4.4.",
      entrada: {
        type: "object",
        properties: { cliente: P_CLIENTE, conta: { type: "string", description: "ID da conta, só números" }, dias: { type: "integer", enum: [7, 14, 30] } },
      },
      async executar(a, c) {
        const r = await resolver(c, a, { conta: ["conta", "google", "ads_cliente"] });
        const conta = exigeId(r.conta, "Informe 'conta' ou um cliente com google.ads_cliente na ficha.");
        return { dados: await adsTagueamento(c.env, conta, a.dias || 30), log: { alvo: `Google Ads ${idConta(conta)}` } };
      },
    },

    {
      nome: "tag_meta",
      titulo: "Meta: pixel, UTMs e otimização",
      tipo: "leitura",
      papel: "leitor",
      idempotente: true,
      descricao:
        "Tagueamento no Meta: eventos do pixel por nome, por origem (navegador x servidor) e por host nos últimos 28 dias; " +
        "UTMs de cada anúncio ativo (ok, UTM fixa ou SEM UTM); conjuntos ativos com meta de desempenho e evento do pixel " +
        "(promoted_object). Checklist: 1.3, 5.1 (conjunto otimizando para evento sem volume: crítico), 5.2, 5.6.",
      entrada: {
        type: "object",
        properties: { cliente: P_CLIENTE, pixel: { type: "string" }, conta: { type: "string", description: "Conta de anúncios, sem act_" }, dias: { type: "integer", minimum: 1, maximum: 28 } },
      },
      async executar(a, c) {
        const r = await resolver(c, a, { pixel: ["pixel", "meta", "pixel"], conta: ["conta", "meta", "conta"] });
        if (!r.pixel && !r.conta) falha("Informe 'pixel' e/ou 'conta', ou um cliente com meta.pixel/meta.conta na ficha.");
        return { dados: await metaTagueamento(c.env, { pixel: r.pixel, conta: r.conta, dias: a.dias || 28 }), log: { alvo: `Meta ${r.conta || ""} ${r.pixel || ""}`.trim() } };
      },
    },

    {
      nome: "midia_meta",
      titulo: "Coleta de mídia: Meta Ads",
      tipo: "leitura",
      papel: "leitor",
      idempotente: true,
      descricao:
        "Desempenho do Meta Ads para auditoria: conta (limite de gastos), resumo dos últimos 30d, 30d anteriores e 90d, " +
        "campanhas com métricas por período, conjuntos ativos (otimização, aprendizado, atribuição, segmentação), anúncios " +
        "(problemas, UTMs, rankings), quebras por posicionamento/idade/gênero, série diária de 90d, pixel e conversões " +
        "personalizadas. Períodos terminam ontem. Use 'partes' para pedir só o necessário.",
      entrada: { type: "object", properties: { cliente: P_CLIENTE, conta: { type: "string" }, pixel: { type: "string" }, partes: P_PARTES(PARTES_META) } },
      async executar(a, c) {
        const r = await resolver(c, a, { conta: ["conta", "meta", "conta"], pixel: ["pixel", "meta", "pixel"] });
        const conta = exigeId(r.conta, "Informe 'conta' ou um cliente com meta.conta na ficha.");
        return { dados: await coletaMeta(c.env, conta, r.pixel, a.partes?.length ? a.partes : PARTES_META), log: { alvo: `Meta ${idConta(conta)}` } };
      },
    },

    {
      nome: "midia_google",
      titulo: "Coleta de mídia: Google Ads",
      tipo: "leitura",
      papel: "leitor",
      idempotente: true,
      descricao:
        "Desempenho do Google Ads para auditoria: conta, resumo por período (30d, 30d anteriores, 90d), campanhas com parcela " +
        "de impressões e perdas, ações de conversão e conversões por ação, palavras-chave com Índice de Qualidade, termos de " +
        "pesquisa, força dos anúncios, redes do PMax, série diária, hora, dia da semana, cidades e alterações recentes. " +
        "Períodos terminam ontem. Use 'partes' para pedir só o necessário.",
      entrada: { type: "object", properties: { cliente: P_CLIENTE, conta: { type: "string" }, partes: P_PARTES(PARTES_GOOGLE) } },
      async executar(a, c) {
        const r = await resolver(c, a, { conta: ["conta", "google", "ads_cliente"] });
        const conta = exigeId(r.conta, "Informe 'conta' ou um cliente com google.ads_cliente na ficha.");
        return { dados: await coletaGoogle(c.env, conta, a.partes?.length ? a.partes : PARTES_GOOGLE), log: { alvo: `Google Ads ${idConta(conta)}` } };
      },
    },

    {
      nome: "midia_leads",
      titulo: "Leads reais do site",
      tipo: "leitura",
      papel: "leitor",
      idempotente: true,
      descricao:
        "Leads gravados no banco do site do cliente (D1 da Cloudflare), por origem/mídia/campanha e por canal (meta, google, " +
        "organico, direto, outros), nos mesmos períodos da coleta de mídia. Só contagens, sem dados pessoais. É o que vira o " +
        "custo por lead real (investimento do canal / leads reais do canal). Exige leads.consulta_periodo na ficha.",
      entrada: { type: "object", properties: { cliente: P_CLIENTE }, required: ["cliente"] },
      async executar(a, c) {
        return { dados: await coletaLeads(c.env, await lerFicha(c.env, a.cliente)), log: { alvo: `leads ${a.cliente}` } };
      },
    },

    {
      nome: "midia_consulta_google_ads",
      titulo: "Consulta livre no Google Ads (GAQL)",
      tipo: "leitura",
      papel: "editor",
      idempotente: true,
      descricao:
        "Roda uma consulta GAQL de leitura (SELECT ... FROM ...) numa conta do Google Ads, para análises que as coletas " +
        "prontas não cobrem. Só leitura: a API de pesquisa não altera nada. Limite de 1000 linhas na resposta.",
      entrada: {
        type: "object",
        properties: { cliente: P_CLIENTE, conta: { type: "string" }, consulta: { type: "string", description: "GAQL começando com SELECT" } },
        required: ["consulta"],
      },
      async executar(a, c) {
        if (!/^\s*SELECT\b/i.test(a.consulta || "")) falha("A consulta precisa começar com SELECT.");
        const r = await resolver(c, a, { conta: ["conta", "google", "ads_cliente"] });
        const conta = exigeId(r.conta, "Informe 'conta' ou um cliente com google.ads_cliente na ficha.");
        const linhas = await gaql(c.env, conta, a.consulta);
        return { dados: { conta: idConta(conta), total: linhas.length, linhas: linhas.slice(0, 1000) }, log: { alvo: `GAQL ${idConta(conta)}: ${linhas.length} linhas` } };
      },
    },

    {
      nome: "midia_consulta_meta",
      titulo: "Consulta livre no Meta (Graph API)",
      tipo: "leitura",
      papel: "editor",
      idempotente: true,
      descricao:
        "Faz um GET na Graph API do Meta (ex.: caminho 'act_123/insights' com params {fields, time_range, level, breakdowns}), " +
        "para análises que as coletas prontas não cobrem. Só leitura (GET). Até 10 páginas.",
      entrada: {
        type: "object",
        properties: { caminho: { type: "string", description: "Sem a versão: act_123/campaigns, 123456/insights..." }, params: { type: "object" } },
        required: ["caminho"],
      },
      async executar(a, c) {
        const caminho = String(a.caminho).replace(/^\/+/, "").replace(/^v\d+\.\d+\//, "");
        if (/access_token|[?#]/i.test(caminho)) falha("Passe os parâmetros em 'params', sem ? no caminho e sem access_token.");
        // A Graph API aceita trocar o verbo HTTP pelo parâmetro "method" (e
        // executar lotes por "batch"); sem este filtro um editor faria uma
        // escrita (pausar campanha, apagar) por uma ferramenta de leitura.
        const PARAMS_PROIBIDOS = /^(method|batch|access_token|appsecret_proof|_method)$/i;
        const params = Object.fromEntries(Object.entries(a.params || {}).filter(([k]) => !PARAMS_PROIBIDOS.test(k)).map(([k, v]) => [k, typeof v === "object" ? JSON.stringify(v) : v]));
        if (Object.keys(a.params || {}).some((k) => PARAMS_PROIBIDOS.test(k))) falha("Parâmetros method, batch e access_token não são aceitos nesta ferramenta (só leitura).");
        const primeira = await graph(c.env, caminho, params);
        const { paging, ...semPaginacao } = primeira;
        const dados = Array.isArray(primeira.data) ? { data: await graphPaginas(c.env, caminho, params, 10) } : semPaginacao;
        return { dados, log: { alvo: `Graph ${caminho}` } };
      },
    },
  ];

  /* ---------------------------------------------------------------- instruções da área */

  const instrucoes = (u) =>
    [
      "Conector de mídia paga e tagueamento da Resultz: Meta Ads, Google Ads, GA4, GTM e leads reais dos sites dos clientes.",
      `Conectado como ${u.nome}, papel ${u.papel}. Toda chamada fica no log de auditoria com esse nome.`,
      "FASE ATUAL: só leitura nas plataformas. Correções e alterações em campanhas ainda não são feitas por aqui: entram no " +
        "plano do relatório como recomendação, com o passo a passo para quem vai executar.",
      "",
      "Método:",
      "1. Cliente: midia_clientes. Sem ficha: midia_descobrir com o site, confirme com o analista e grave com midia_salvar_cliente.",
      "2. Auditoria de tagueamento: tag_site, tag_publicado, tag_ga4, tag_google_ads, tag_meta e midia_leads. Pergunta central: " +
        "o evento que a plataforma usa para otimizar dispara quando um lead real acontece? Compare no mesmo período: leads no " +
        "banco, conversões no GA4, eventos Lead no pixel e conversões no Google Ads (até 20% de diferença é normal).",
      "3. Auditoria de mídia: midia_meta, midia_google e midia_leads. Custo por lead real = investimento do canal / leads " +
        "reais do canal. Plataforma muito abaixo dos leads reais = falha de tagueamento; muito acima = conversões falsas ou " +
        "duplicadas. 'Direto' acima de 30% = links sem UTM.",
      "4. Severidade dos achados: Crítico (dinheiro gasto sem sinal ou conversão perdida), Importante (atribuição errada ou " +
        "incompleta), Melhoria. IDs curtos: META-01, GADS-01, GA4-01, GTM-01, UTM-01, INFRA-01.",
      "5. Saúde por plataforma: crítica (otimização para evento sem volume, conversões principais zeradas ou falsas, conta " +
        "parando por limite de gastos, custo por lead real mais que o dobro do histórico), atenção (sinal contaminado, perda " +
        "grande por orçamento, queda forte de investimento) ou boa.",
      "6. Plano: P0 em 48 horas (bloqueios e desperdício), P1 em 7 dias (estrutura e otimização), P2 em 30 dias (crescimento).",
      "",
      "Padrões da Resultz:",
      "- Evento de lead único no dataLayer: event 'lead', com lead_id (vira eventID no Meta e ID de transação no Ads) e " +
        "form_type (visita, contato, orcamento, whatsapp...). form_type evento_presencial nunca vai para anúncio.",
      "- UTM do Meta (Parâmetros de URL do anúncio): utm_source=meta&utm_medium=paid_social&utm_campaign={{campaign.name}}" +
        "&utm_term={{adset.name}}&utm_content={{ad.name}}&utm_id={{campaign.id}}",
      "- Sufixo de URL final do Google Ads: utm_source=google&utm_medium=cpc&utm_campaign={campaignid}&utm_content={adgroupid}" +
        "&utm_term={keyword}, com auto-tagging ligado.",
      "- Nomes no GTM: '<Plataforma> - <o que faz>' (GA4 - generate_lead, Meta - Lead); acionadores 'CE - <evento>'; variáveis 'DLV - <nome>'.",
      "",
      "Relatório:",
      "- Estrutura: cabeçalho (cliente, data, IDs auditados), veredito em 2 ou 3 frases, 3 ou 4 números com a fonte, como o " +
        "lead acontece e onde quebra, inventário do GTM, achados por severidade (evidência, impacto, correção), pontos " +
        "positivos, plano por prioridade e limites (o que ficou de fora e por quê).",
      "- Identidade da Resultz: preto #0a0a0a, amarelo #ffca00, laranja #ff8b00, vermelho #c62828; fontes Syne (títulos) e " +
        "Outfit (texto), do Google Fonts; logo em https://mcp.resultz.com.br/marca/logo-resultz.png e selo em " +
        "https://mcp.resultz.com.br/marca/selo-ovelha.png.",
      "- Português do Brasil, sem travessão, frases curtas. Cada afirmação com o número e a fonte (ferramenta e campo). " +
        "Nunca estime: o que não veio (falhas, sem acesso) vai para os limites.",
      "- Depois da auditoria, registre uma linha no histórico da ficha (midia_salvar_cliente com 'historico').",
      "",
      "Cuidados: 403 ou 'sem acesso' = o cliente precisa dar acesso à conta da agência (use midia_acessos e diga exatamente " +
        "o que pedir). Leads e dados de clientes só vão para o relatório entregue ao próprio cliente. Nunca peça token ou " +
        "senha no chat.",
    ].join("\n");

  return { titulo: "Mídia: tagueamento e mídia paga", ferramentas, instrucoes };
}
