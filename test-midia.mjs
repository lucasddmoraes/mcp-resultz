// Testes da área "midia" sem acesso a nenhuma plataforma: D1 simulado com node:sqlite e Google, Google Ads, GA4,
// GTM, Meta, Cloudflare e um site de exemplo simulados em memória (dados fictícios).
// Rodar com `npm run test:offline` (junto com test-offline.mjs).
import { DatabaseSync } from "node:sqlite";
import { webcrypto } from "node:crypto";
import worker from "./worker.js";

class Stmt {
  constructor(db, sql) { this.db = db; this.sql = sql; this.vals = []; }
  bind(...v) { this.vals = v.map((x) => (x === undefined ? null : typeof x === "boolean" ? (x ? 1 : 0) : x)); return this; }
  _p() { return this.db.prepare(this.sql); }
  async first() { const r = this._p().get(...this.vals); return r ? { ...r } : null; }
  async all() { return { results: this._p().all(...this.vals).map((r) => ({ ...r })) }; }
  async run() { const r = this._p().run(...this.vals); return { meta: { last_row_id: Number(r.lastInsertRowid), changes: r.changes } }; }
}
const sqlite = new DatabaseSync(":memory:");
const DB = { prepare: (s) => new Stmt(sqlite, s), batch: async (st) => Promise.all(st.map((x) => x.run())) };
const ok = (c, msg) => console.log((c ? "OK   " : "FALHA") + "  " + msg);

// ---------- credenciais fictícias (a chave RSA é gerada aqui; o mock confere a assinatura do JWT)
const par = await webcrypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const pkcs8 = Buffer.from(await webcrypto.subtle.exportKey("pkcs8", par.privateKey)).toString("base64");
const PEM = `-----BEGIN PRIVATE KEY-----\n${pkcs8.match(/.{1,64}/g).join("\n")}\n-----END PRIVATE KEY-----\n`;
const SA = { type: "service_account", client_email: "claude-tagueamento@resultz.iam.gserviceaccount.com", private_key: PEM, token_uri: "https://oauth2.googleapis.com/token" };
const META_TOKEN = "EAAtokenFicticioDoMetaParaTeste1234567890";
const ADMIN = "M".repeat(40);
const env = {
  DB, ADMIN_TOKEN: ADMIN, ADMIN_NOME: "Lucas",
  GOOGLE_SA_JSON: JSON.stringify(SA),
  GOOGLE_ADS_CLIENT_ID: "cid", GOOGLE_ADS_CLIENT_SECRET: "csecret", GOOGLE_ADS_REFRESH_TOKEN: "1//refreshficticio",
  GOOGLE_ADS_LOGIN_CUSTOMER_ID: "111-222-3333",
  META_ACCESS_TOKEN: META_TOKEN, CLOUDFLARE_API_TOKEN: "cf-token-ficticio",
};

// ---------- respostas simuladas
const hoje = new Date(Date.now() - 3 * 3600 * 1000);
const dia = (n) => { const d = new Date(hoje); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
const gtmData = {
  resource: {
    version: "42",
    macros: [{ function: "__e" }, { function: "__u", vtp_component: "PATH" }, { function: "__v", vtp_name: "lead_id" }],
    predicates: [
      { function: "_eq", arg0: ["macro", 0], arg1: "lead" },
      { function: "_cn", arg0: ["macro", 1], arg1: "/lead.html" },
      { function: "_eq", arg0: ["macro", 0], arg1: "gtm.js" },
    ],
    tags: [
      { function: "__googtag", tag_id: 1, vtp_tagId: "G-TESTE12345" },
      { function: "__awct", tag_id: 2, vtp_conversionId: "123456789", vtp_conversionLabel: "abc", vtp_orderId: ["macro", 2] },
      { function: "__html", tag_id: 3, vtp_html: "<script>fbq('init','998877665544332');fbq('track','Lead');</script>" },
    ],
    rules: [[["if", 2], ["add", 0, 2]], [["if", 0], ["add", 1]], [["if", 1], ["add", 2]]],
  },
};
const gtagData = {
  resource: {
    version: "7",
    tags: [
      { function: "__dest_ga", vtp_destinationId: "G-TESTE12345" },
      { function: "__ogt_event_create", vtp_eventName: "generate_lead", vtp_precompiledRule: ["regra"] },
      { function: "__ccd_conversion_marking", vtp_conversionRules: [["x"], [1, 2, JSON.stringify({ args: [{ stringValue: "generate_lead" }] })]] },
      { function: "__ogt_auto_events", vtp_enableScroll: true, vtp_enableForm: false },
    ],
  },
};
const jsDe = (data) => `(function(){var data = ${JSON.stringify(data)};\nvar x = "}";})();`;
const HOME = `<html><head><script src="https://www.googletagmanager.com/gtm.js?id=GTM-TESTE01"></script>
<script>window.dataLayer=[];</script><script src="/app.js"></script></head><body>
<form action="/api/lead" method="post" id="f1"></form><a href="https://wa.me/5511999999999">WhatsApp</a></body></html>`;
const PAGINA_SEM_GTM = `<html><body><script>fbq('init', '998877665544332');</script><form action="https://rdstation.com/x"></form></body></html>`;
const SITEMAP = `<?xml version="1.0"?><urlset><url><loc>https://exemplo.com.br/</loc></url><url><loc>https://exemplo.com.br/contato</loc></url></urlset>`;
const APPJS = `function enviar(){ dataLayer.push({ event: 'lead', lead_id: 1 }); dataLayer.push({event:"whatsapp_lead"}); }`;

const visto = { jwtValido: null, versoes: [], loginCustomer: null, cfSql: [], urls: [] };

function adsResposta(q) {
  if (/FROM customer_client/.test(q)) return [{ customerClient: { id: "5550001111", descriptiveName: "Exemplo Escola", manager: false, status: "ENABLED" } }, { customerClient: { id: "1112223333", manager: true } }];
  if (/conversion_tracking_id FROM customer/.test(q)) return [{ customer: { conversionTrackingSetting: { conversionTrackingId: "123456789" } } }];
  if (/FROM customer$/.test(q.trim()) || /customer\.auto_tagging_enabled/.test(q)) return [{ customer: { id: "5550001111", descriptiveName: "Exemplo Escola", autoTaggingEnabled: true, finalUrlSuffix: "", currencyCode: "BRL" } }];
  if (/FROM conversion_action/.test(q)) return [{ conversionAction: { id: "1", name: "Lead site", primaryForGoal: true, status: "ENABLED" } }, { conversionAction: { id: "2", name: "Clique WhatsApp", primaryForGoal: true, status: "ENABLED" } }];
  if (/segments\.conversion_action_name/.test(q)) return [{ segments: { conversionActionName: "Clique WhatsApp", conversionActionCategory: "CONTACT" }, metrics: { conversions: 40, allConversions: 41 } }];
  if (/FROM campaign WHERE campaign.status/.test(q) || (/FROM campaign/.test(q) && /campaign_budget/.test(q))) {
    const ant = q.includes(dia(60));
    return [
      { campaign: { id: "10", name: "Pesquisa Matrículas", status: "ENABLED", advertisingChannelType: "SEARCH", biddingStrategyType: "MAXIMIZE_CONVERSIONS", finalUrlSuffix: "" }, campaignBudget: { amountMicros: "50000000" }, metrics: { costMicros: ant ? "900000000" : "1500000000", clicks: "300", impressions: "6000", conversions: 30, allConversions: 31, searchImpressionShare: 0.42, searchBudgetLostImpressionShare: 0.3 } },
      { campaign: { id: "11", name: "PMax", status: "ENABLED", advertisingChannelType: "PERFORMANCE_MAX", biddingStrategyType: "MAXIMIZE_CONVERSIONS" }, campaignBudget: { amountMicros: "30000000" }, metrics: { costMicros: "2500000000", clicks: "100", impressions: "50000", conversions: 10, allConversions: 12 } },
    ];
  }
  if (/FROM campaign WHERE campaign.advertising_channel_type = 'PERFORMANCE_MAX'/.test(q)) return [{ campaign: { name: "PMax" }, segments: { adNetworkType: "YOUTUBE" }, metrics: { costMicros: "800000000", clicks: "10", impressions: "30000", conversions: 0 } }];
  if (/FROM customer WHERE segments.date BETWEEN/.test(q) && /segments.date,/.test(q)) return [{ segments: { date: dia(2) }, metrics: { costMicros: "100000000", clicks: "20", impressions: "800", conversions: 2 } }, { segments: { date: dia(5) }, metrics: { costMicros: "90000000", clicks: "18", impressions: "700", conversions: 1 } }];
  if (/segments.hour/.test(q)) return [{ segments: { hour: 3 }, metrics: { costMicros: "50000000", clicks: "5", impressions: "100", conversions: 0 } }];
  if (/segments.day_of_week/.test(q)) return [{ segments: { dayOfWeek: "SUNDAY" }, metrics: { costMicros: "10000000", clicks: "2", impressions: "50", conversions: 0 } }];
  if (/FROM customer WHERE segments.date BETWEEN/.test(q)) return [{ metrics: { costMicros: q.includes(dia(60)) ? "3000000000" : "4000000000", clicks: "400", impressions: "56000", conversions: 40, allConversions: 43 } }];
  if (/FROM keyword_view/.test(q)) return [{ campaign: { name: "Pesquisa Matrículas" }, adGroupCriterion: { keyword: { text: "escola particular", matchType: "BROAD" }, qualityInfo: { qualityScore: 4 } }, metrics: { costMicros: "300000000", clicks: "40", impressions: "900", conversions: 3 } }];
  if (/FROM ad_group_criterion/.test(q)) return [{ adGroupCriterion: { keyword: { matchType: "BROAD" }, qualityInfo: { qualityScore: 4 } } }, { adGroupCriterion: { keyword: { matchType: "PHRASE" } } }];
  if (/FROM search_term_view/.test(q)) return [{ searchTermView: { searchTerm: "escola publica gratuita" }, campaign: { name: "Pesquisa Matrículas" }, metrics: { costMicros: "120000000", clicks: "15", impressions: "200", conversions: 0 } }];
  if (/FROM ad_group_ad WHERE ad_group_ad.status = 'ENABLED' AND campaign.status = 'ENABLED' AND ad_group.status/.test(q)) return [{ campaign: { name: "Pesquisa Matrículas" }, adGroup: { name: "Geral" }, adGroupAd: { ad: { type: "RESPONSIVE_SEARCH_AD" }, adStrength: "POOR", policySummary: { approvalStatus: "APPROVED" } } }];
  if (/FROM ad_group_ad/.test(q)) return [{ campaign: { name: "Pesquisa Matrículas" }, adGroupAd: { ad: { finalUrls: ["https://exemplo.com.br/"] } } }];
  if (/FROM user_location_view/.test(q)) return [{ segments: { geoTargetCity: "geoTargetConstants/1001773" }, metrics: { costMicros: "700000000", clicks: "90", impressions: "3000", conversions: 9 } }];
  if (/FROM geo_target_constant/.test(q)) return [{ geoTargetConstant: { resourceName: "geoTargetConstants/1001773", name: "Guarulhos" } }];
  if (/FROM change_event/.test(q)) return [{ changeEvent: { changeDateTime: `${dia(3)} 10:00:00`, changeResourceType: "CAMPAIGN_BUDGET" } }];
  return [];
}

const ACT = "act_528562687958126";
function graphResposta(caminho, q) {
  if (caminho === "me/accounts") return { data: [{ id: "pg1", name: "Página Exemplo", access_token: "EAApaginaTokenSecreto123", tasks: ["ADVERTISE"] }] };
  if (caminho === "erro_com_token") return { error: { message: `Falhou em https://graph.facebook.com/x?access_token=${META_TOKEN}&a=1`, code: 1 } };
  if (caminho === "me/adaccounts") return { data: [{ account_id: "528562687958126", name: "Exemplo", account_status: 1, business: { id: "305", name: "Resultz" }, adspixels: { data: [{ id: "998877665544332" }] } }] };
  if (caminho === ACT) return { name: "Exemplo", currency: "BRL", account_status: 1, spend_cap: "1000000", amount_spent: "950000" };
  if (caminho === `${ACT}/insights`) {
    const lvl = q.get("level");
    const ant = q.get("time_range")?.includes(dia(60));
    const base = { spend: ant ? "800" : "1200.5", impressions: "50000", reach: "20000", frequency: "3.4", inline_link_clicks: "900", inline_link_click_ctr: "1.8", cost_per_inline_link_click: "1.33", cpm: "24", actions: [{ action_type: "landing_page_view", value: "600" }, { action_type: "offsite_conversion.fb_pixel_lead", value: "0" }, { action_type: "onsite_conversion.lead_grouped", value: "12" }] };
    if (q.get("time_increment")) return { data: [{ ...base, date_start: dia(1) }, { ...base, date_start: dia(2) }] };
    if (q.get("breakdowns")) return { data: [{ ...base, publisher_platform: "instagram", platform_position: "story", age: "35-44", gender: "female" }] };
    if (lvl === "campaign") return { data: [{ ...base, campaign_id: "c1" }] };
    if (lvl === "ad") return { data: [{ ...base, ad_id: "ad1", conversion_rate_ranking: "BELOW_AVERAGE_10" }] };
    return { data: [base] };
  }
  if (caminho === `${ACT}/campaigns`) return { data: [{ id: "c1", name: "Leads Matrículas", objective: "OUTCOME_LEADS", effective_status: "ACTIVE", daily_budget: "8000" }, { id: "c2", name: "Antiga", effective_status: "PAUSED" }] };
  if (caminho === `${ACT}/adsets`) return { data: [{ id: "s1", name: "Conjunto 1", effective_status: "ACTIVE", optimization_goal: "OFFSITE_CONVERSIONS", promoted_object: { pixel_id: "998877665544332", custom_event_type: "LEAD" } }] };
  if (caminho === `${ACT}/ads`) {
    if (!q.get("after")) {
      return {
        data: [
          { id: "ad1", name: "Vídeo tour", effective_status: "ACTIVE", campaign: { name: "Leads Matrículas" }, adset: { name: "Conjunto 1" }, creative: { url_tags: "utm_source=meta&utm_campaign={{campaign.name}}", object_story_spec: { link_data: { link: "https://exemplo.com.br/" } } } },
          { id: "ad2", name: "Carrossel", effective_status: "ACTIVE", campaign: { name: "Leads Matrículas" }, creative: { object_story_spec: { link_data: { link: "https://exemplo.com.br/?utm_source=instagram" } } } },
        ],
        paging: { next: `https://graph.facebook.com/v23.0/${ACT}/ads?after=PAG2&access_token=${META_TOKEN}` },
      };
    }
    return { data: [{ id: "ad3", name: "Foto", effective_status: "ACTIVE", creative: { object_story_spec: { link_data: { link: "https://exemplo.com.br/" } } } }] };
  }
  if (caminho === `${ACT}/customconversions`) return { data: [] };
  if (caminho === "998877665544332/stats") {
    const ag = q.get("aggregation");
    if (ag === "event") return { data: [{ data: [{ value: "PageView", count: 5000 }, { value: "Lead", count: 0 }] }, { data: [{ value: "PageView", count: 1000 }] }] };
    if (ag === "event_source") return { data: [{ data: [{ value: "browser", count: 6000 }] }] };
    if (ag === "host") return { data: [{ data: [{ value: "exemplo.com.br", count: 5500 }, { value: "exemplo.pages.dev", count: 500 }] }] };
  }
  if (caminho === "998877665544332") return { id: "998877665544332", name: "Pixel Exemplo", last_fired_time: "2026-10-21T10:00:00+0000" };
  return { error: { message: `caminho não simulado: ${caminho}`, code: 100 } };
}

const resp = (status, corpo, headers = {}) => new Response(typeof corpo === "string" ? corpo : JSON.stringify(corpo), { status, headers });
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  const m = (init.method || "GET").toUpperCase();
  visto.urls.push(u.toString());
  const h = init.headers || {};
  if (u.host === "oauth2.googleapis.com") {
    const f = new URLSearchParams(init.body);
    if (f.get("grant_type") === "refresh_token") return resp(f.get("refresh_token") === env.GOOGLE_ADS_REFRESH_TOKEN ? 200 : 400, { access_token: "ya29.ads", expires_in: 3600 });
    const [a, b, c] = f.get("assertion").split(".");
    const reiv = JSON.parse(Buffer.from(b, "base64url").toString());
    visto.jwtValido = await webcrypto.subtle.verify("RSASSA-PKCS1-v1_5", par.publicKey, Buffer.from(c, "base64url"), new TextEncoder().encode(`${a}.${b}`));
    visto.escopos = reiv.scope;
    return visto.jwtValido && reiv.iss === SA.client_email ? resp(200, { access_token: "ya29.sa", expires_in: 3600 }) : resp(400, { error: "invalid_grant" });
  }
  if (u.host === "analyticsadmin.googleapis.com") {
    if (h.Authorization !== "Bearer ya29.sa") return resp(401, { error: { message: "sem token" } });
    const p = u.pathname;
    if (p.includes("/properties/9999")) return resp(403, { error: { message: "User does not have sufficient permissions" } });
    if (p.endsWith("/accountSummaries")) return resp(200, { accountSummaries: [{ displayName: "Exemplo", propertySummaries: [{ property: "properties/4242", displayName: "Exemplo GA4" }] }] });
    if (p.endsWith("/dataStreams")) return resp(200, { dataStreams: [{ name: "properties/4242/dataStreams/1", webStreamData: { measurementId: "G-TESTE12345" } }] });
    if (p.endsWith("/eventCreateRules")) return resp(200, { eventCreateRules: [{ destinationEvent: "generate_lead", eventConditions: [{ field: "page_location", comparisonType: "CONTAINS", value: "lead.html" }] }] });
    if (p.endsWith("/enhancedMeasurementSettings")) return resp(200, { streamEnabled: true });
    if (p.endsWith("/keyEvents")) return resp(200, { keyEvents: [{ eventName: "generate_lead" }] });
    if (p.endsWith("/googleAdsLinks")) return resp(200, {});
    if (p.endsWith("/customDimensions")) return resp(200, {});
    if (p.endsWith("/dataRetentionSettings")) return resp(200, { eventDataRetention: "TWO_MONTHS" });
    if (p.endsWith("/properties/4242")) return resp(200, { displayName: "Exemplo GA4", timeZone: "America/Sao_Paulo" });
  }
  if (u.host === "analyticsdata.googleapis.com") {
    const corpo = JSON.parse(init.body);
    const dims = corpo.dimensions.map((d) => d.name);
    if (dims[0] === "eventName" && corpo.dimensionFilter) return resp(200, { rows: [{ dimensionValues: [{ value: "generate_lead" }, { value: "google / cpc" }, { value: "matriculas" }], metricValues: [{ value: "3" }] }] });
    if (dims[0] === "eventName") return resp(200, { rows: [{ dimensionValues: [{ value: "page_view" }], metricValues: [{ value: "9000" }, { value: "3000" }] }] });
    return resp(200, { rows: [] });
  }
  if (u.host === "tagmanager.googleapis.com") {
    if (u.pathname.endsWith("/accounts")) return resp(200, { account: [{ accountId: "77", name: "Exemplo", path: "accounts/77" }] });
    if (u.pathname.endsWith("/containers")) return resp(200, { container: [{ publicId: "GTM-TESTE01", name: "exemplo.com.br" }] });
  }
  if (u.host === "googleads.googleapis.com") {
    const v = u.pathname.split("/")[1];
    visto.versoes.push(v);
    if (["v26", "v25"].includes(v)) return resp(404, "<html>Not Found</html>");
    visto.loginCustomer = h["login-customer-id"];
    if (h.Authorization !== "Bearer ya29.ads") return resp(401, { error: { message: "sem token" } });
    if (u.pathname.includes("/customers/4040404040/")) return resp(403, [{ error: { message: "User doesn't have permission to access customer." } }]);
    const q = JSON.parse(init.body).query;
    return resp(200, [{ results: adsResposta(q) }]);
  }
  if (u.host === "graph.facebook.com") {
    if (u.searchParams.get("access_token") !== META_TOKEN) return resp(400, { error: { message: "Invalid OAuth access token", code: 190 } });
    const caminho = u.pathname.replace(/^\/v\d+\.\d+\//, "");
    const r = graphResposta(caminho, u.searchParams);
    return resp(r.error ? 400 : 200, r);
  }
  if (u.host === "api.cloudflare.com") {
    if (h.Authorization !== "Bearer cf-token-ficticio") return resp(403, { success: false, errors: [{ message: "auth" }] });
    const p = u.pathname.replace("/client/v4/", "");
    if (p.endsWith("/query")) {
      const sql = JSON.parse(init.body).sql;
      visto.cfSql.push(sql);
      return resp(200, { success: true, result: [{ results: [
        { origem: "Meta Ads", midia: "paid_social", campanha: "leads", n: 7, email: "nao-deveria@sair.com" },
        { origem: "google", midia: "cpc", campanha: "matriculas", n: 5 },
        { origem: "direto", midia: "", campanha: "", n: 9 },
        { origem: "Instagram", midia: "", campanha: "", n: 2 },
      ] }] });
    }
    if (p === "accounts") return resp(200, { success: true, result: [{ id: "181aaa", name: "Resultz" }] });
    if (p === "zones") return resp(200, { success: true, result: [{ id: "z1", account: { id: "181aaa" } }] });
    if (p.endsWith("/pages/projects")) return resp(200, { success: true, result: [{ name: "appexemplo", domains: ["exemplo.com.br"], source: { config: { owner: "resultz", repo_name: "site-exemplo" } }, deployment_configs: { production: { d1_databases: { DB: { id: "d1-exemplo" } } } } }] });
  }
  if (u.host === "www.googletagmanager.com") {
    const id = u.searchParams.get("id");
    if (id === "GTM-TESTE01") return resp(200, jsDe(gtmData));
    if (id === "G-TESTE12345") return resp(200, jsDe(gtagData));
    if (id === "AW-123456789") return resp(200, jsDe({ resource: { version: "1", tags: [{ function: "__dest_aw", vtp_destinationId: "AW-123456789" }] } }));
    return resp(404, "not found");
  }
  if (u.hostname === "exemplo.com.br" || u.hostname === "www.exemplo.com.br") {
    if (u.hostname === "www.exemplo.com.br") return resp(301, "", { Location: "https://exemplo.com.br/" });
    if (u.protocol === "http:") return resp(301, "", { Location: "https://exemplo.com.br/" });
    if (u.pathname === "/") return resp(200, HOME);
    if (u.pathname === "/contato") return resp(200, PAGINA_SEM_GTM);
    if (u.pathname === "/sitemap.xml") return resp(200, SITEMAP);
    if (u.pathname === "/app.js") return resp(200, APPJS);
    return resp(200, "<html>soft 404</html>");
  }
  return resp(599, `fetch não simulado: ${u}`);
};

// ---------- helpers MCP
let n = 0;
async function rpc(area, token, method, params) {
  const r = await worker.fetch(new Request(`https://mcp.resultz.com.br/${area}/${token}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method, params }) }), env, { waitUntil: (p) => p });
  return { status: r.status, json: r.status === 200 ? await r.json() : null };
}
async function tool(name, args, token = ADMIN) {
  const r = (await rpc("midia", token, "tools/call", { name, arguments: args })).json.result;
  let d; try { d = JSON.parse(r.content[0].text); } catch { d = r.content[0].text; }
  return { erro: !!r.isError, d, bruto: r.content[0].text };
}
const saidas = [];
const t = async (name, args, token) => { const r = await tool(name, args, token); saidas.push(r.bruto); return r; };

// ---------- área e ferramentas
let r = await rpc("midia", ADMIN, "initialize", { protocolVersion: "2025-06-18" });
ok(r.json.result.serverInfo.name === "resultz-midia" && r.json.result.instructions.includes("só leitura") && r.json.result.instructions.includes("#ffca00"), "midia: initialize com instruções (fase só leitura, identidade)");
r = await rpc("midia", ADMIN, "tools/list", {});
const nomes = r.json.result.tools.map((x) => x.name);
ok(nomes.length === 17, `midia: admin vê ${nomes.length} ferramentas`);
ok(r.json.result.tools.filter((x) => x.name.startsWith("tag_") || x.name === "midia_meta").every((x) => x.annotations.readOnlyHint), "midia: ferramentas de coleta marcadas como só leitura");

// fichas
let x = await t("midia_salvar_cliente", { slug: "exemplo", nome: "Escola Exemplo", ficha: { site: { url: "https://exemplo.com.br" }, google: { gtm: "GTM-TESTE01", ga4: "G-TESTE12345", ga4_propriedade: "4242", ads_tag: "AW-123456789", ads_cliente: "555-000-1111" }, meta: { pixel: "998877665544332", conta: "528562687958126" }, cloudflare: { conta: "181aaa", d1_banco: "d1-exemplo" }, leads: { consulta_periodo: "SELECT origem, midia, campanha, COUNT(*) n FROM leads WHERE criado_em BETWEEN '{inicio}' AND '{fim}' GROUP BY 1,2,3" } }, motivo: "cadastrar a escola exemplo" });
ok(!x.erro && x.d.criado && x.d.ficha.google.gtm === "GTM-TESTE01", "fichas: cria a ficha");
x = await t("midia_salvar_cliente", { slug: "exemplo", ficha: { meta: { business: "305" } }, historico: "auditoria de teste", motivo: "complementar" });
ok(!x.erro && !x.d.criado && x.d.ficha.meta.pixel === "998877665544332" && x.d.ficha.meta.business === "305" && x.d.ficha.historico[0].includes("Lucas"), "fichas: atualiza mesclando a seção e grava histórico com autor");
x = await t("midia_salvar_cliente", { slug: "exemplo", ficha: { meta: { token: META_TOKEN } }, motivo: "teste" });
ok(x.erro && x.d.includes("token"), "fichas: recusa ficha com token");
x = await t("midia_salvar_cliente", { slug: "exemplo", ficha: { leads: { consulta_periodo: "WITH x AS (SELECT 1) DELETE FROM leads" } }, motivo: "teste" });
ok(x.erro && x.d.includes("SELECT"), "fichas: recusa consulta de leads que altera dados");
x = await t("midia_salvar_cliente", { slug: "Exemplo X", nome: "a", motivo: "teste" });
ok(x.erro && x.d.includes("slug"), "fichas: recusa slug inválido");
x = await t("midia_salvar_cliente", { slug: "exemplo", ficha: { google: { gtm: "GTM-X" } } });
ok(x.erro && x.d.includes("motivo"), "fichas: escrita sem motivo bloqueada");
x = await t("midia_clientes", {});
ok(!x.erro && x.d.clientes.length === 1 && x.d.clientes[0].slug === "exemplo", "fichas: lista");
x = await t("midia_clientes", { slug: "inexistente" });
ok(x.erro && x.d.includes("exemplo"), "fichas: cliente sem ficha lista as existentes");

// site e contêiner publicado
x = await t("tag_site", { cliente: "exemplo" });
ok(!x.erro && x.d.ids_encontrados.gtm?.[0] === "GTM-TESTE01" && x.d.ids_encontrados.meta_pixel?.[0] === "998877665544332", "tag_site: IDs encontrados");
ok(x.d.paginas_sem_gtm?.[0] === "https://exemplo.com.br/contato" && Object.keys(x.d.eventos_datalayer_no_codigo || {}).sort().join() === "lead,whatsapp_lead", "tag_site: página sem GTM e eventos do dataLayer no .js");
ok(x.d.infra?.status_url_inexistente === 200 && x.d.infra.https_www[0][1] === 301 && x.d.infra.https_www[1][0] === "https://exemplo.com.br/", "tag_site: URL inexistente devolve 200 (achado) e www redireciona");
ok(x.d.destinos_de_formulario?.includes("/api/lead"), "tag_site: destinos de formulário");
x = await t("tag_publicado", { cliente: "exemplo" });
const gtm = x.d["GTM-TESTE01"];
const conv = gtm?.tags.find((tg) => tg.funcao === "__awct");
const html = gtm?.tags.find((tg) => tg.funcao === "__html");
ok(!x.erro && conv?.acionadores[0].se_todas[0] === '{{Evento}} igual a "lead"' && conv.parametros.orderId === '{{Variável da camada de dados "lead_id"}}', "tag_publicado: acionador e ID de transação legíveis");
ok(html?.detectado.meta_pixel_init?.[0] === "998877665544332" && html.acionadores[1].se_todas[0].includes("/lead.html") && gtm.eventos_escutados.includes("lead"), "tag_publicado: pixel no HTML e eventos escutados");
ok(x.d["G-TESTE12345"]?.eventos_chave[0] === "generate_lead" && x.d["AW-123456789"]?.destinos[0] === "AW-123456789", "tag_publicado: Google tag do GA4 e do Ads");
x = await t("tag_publicado", { id: "XYZ-1" });
ok(x.erro, "tag_publicado: ID inválido");

// GA4
x = await t("tag_ga4", { cliente: "exemplo" });
ok(visto.jwtValido === true && visto.escopos === "https://www.googleapis.com/auth/analytics.readonly https://www.googleapis.com/auth/tagmanager.readonly", "google: JWT da conta de serviço assinado e com escopos só de leitura");
ok(!x.erro && x.d.config.eventos_chave[0].eventName === "generate_lead" && x.d.config.fluxos[0].regras_criacao_evento[0].destinationEvent === "generate_lead", "tag_ga4: configuração");
ok(x.d.relatorio.leads_por_origem[0].sessionSourceMedium === "google / cpc" && x.d.relatorio.eventos[0].eventCount === "9000", "tag_ga4: relatório");
x = await t("tag_ga4", { propriedade: "9999", partes: ["config"] });
ok(!x.erro && x.d.config.falhas.fluxos?.includes("claude-tagueamento@resultz.iam.gserviceaccount.com"), "tag_ga4: sem acesso vira falha explicando o que pedir ao cliente");

// Google Ads
x = await t("tag_google_ads", { cliente: "exemplo" });
ok(!x.erro && x.d.versao_api === "v24" && visto.versoes.slice(0, 3).join() === "v26,v25,v24" && visto.loginCustomer === "1112223333", "google ads: descobre a versão da API e usa a MCC");
ok(x.d.conta.autoTaggingEnabled === true && x.d.acoes_conversao.length === 2 && x.d.campanhas[0].lance === "MAXIMIZE_CONVERSIONS", "tag_google_ads: conta, ações de conversão e lances");
x = await t("midia_google", { cliente: "exemplo" });
const pesq = x.d.campanhas?.find((c) => c.id === "10");
ok(!x.erro && x.d.resumo.p30.investimento === 4000 && x.d.resumo.ant30.investimento === 3000, "midia_google: resumo por período");
ok(pesq?.metricas.p30.investimento === 1500 && pesq.metricas.ant30.investimento === 900 && pesq.metricas.p30.perda_orcamento === 0.3 && x.d.campanhas[0].id === "11", "midia_google: campanhas por período, perdas e ordenação por investimento");
ok(x.d.cidades_p30[0].cidade === "Guarulhos" && x.d.termos_p30[0].termo === "escola publica gratuita" && x.d.palavras_ativas.por_correspondencia.BROAD === 1, "midia_google: cidades com nome, termos e correspondência");
ok(x.d.alteracoes_p30.total === 1 && x.d.redes_pmax_p30[0].rede === "YOUTUBE" && Object.keys(x.d.falhas).length === 0, "midia_google: alterações, PMax e nenhuma falha");
x = await t("midia_google", { conta: "4040404040", partes: ["conta"] });
ok(!x.erro && x.d.falhas.conta?.includes("permission"), "midia_google: conta sem acesso vira falha, não erro");
x = await t("midia_consulta_google_ads", { cliente: "exemplo", consulta: "SELECT campaign.id FROM campaign WHERE segments.date BETWEEN '2026-01-01' AND '2026-01-02' AND campaign_budget.amount_micros > 0" });
ok(!x.erro && x.d.total === 2, "consulta GAQL livre");
x = await t("midia_consulta_google_ads", { cliente: "exemplo", consulta: "UPDATE campaign SET x" });
ok(x.erro, "consulta GAQL recusa o que não é SELECT");

// Meta
x = await t("tag_meta", { cliente: "exemplo" });
ok(!x.erro && x.d.pixel.eventos.PageView === 6000 && x.d.pixel.eventos.Lead === 0 && x.d.pixel.hosts["exemplo.pages.dev"] === 500, "tag_meta: eventos do pixel somados, Lead zerado e host de teste");
ok(x.d.utm_anuncios.length === 3 && x.d.utm_anuncios.map((a) => a.diagnostico).join("|") === "ok|UTM fixa (sem macros)|SEM UTM", "tag_meta: UTMs dos anúncios com paginação");
ok(x.d.conjuntos_ativos[0].promoted_object.custom_event_type === "LEAD", "tag_meta: conjunto otimizando para Lead");
x = await t("midia_meta", { cliente: "exemplo" });
ok(!x.erro && x.d.conta.restante_limite === 500 && x.d.resumo.p30.investimento === 1200.5 && x.d.resumo.p30.leads_formulario_meta === 12 && x.d.resumo.p30.lpv === 600, "midia_meta: conta (limite) e resumo");
ok(x.d.campanhas.length === 1 && x.d.campanhas[0].metricas.ant30.investimento === 800 && x.d.anuncios.find((a) => a.id === "ad1").ranking_conversao === "BELOW_AVERAGE_10", "midia_meta: campanhas sem a antiga parada, anúncios com ranking");
ok(x.d.quebras_p30.posicionamento[0].rotulo === "instagram / story" && x.d.diario_p90.length === 2 && Object.keys(x.d.falhas).length === 0, "midia_meta: quebras, série diária e nenhuma falha");
x = await t("midia_meta", { cliente: "exemplo", partes: ["resumo"] });
ok(!x.erro && x.d.resumo && !x.d.campanhas && !x.d.anuncios, "midia_meta: 'partes' limita a coleta");
x = await t("midia_consulta_meta", { caminho: `${ACT}/campaigns`, params: { fields: "id,name" } });
ok(!x.erro && x.d.data.length === 2, "consulta Graph livre");
x = await t("midia_consulta_meta", { caminho: `${ACT}/campaigns?access_token=x` });
ok(x.erro, "consulta Graph recusa token ou query no caminho");

// leads reais
x = await t("midia_leads", { cliente: "exemplo" });
const p30 = x.d.por_periodo?.p30;
ok(!x.erro && p30.total === 23 && p30.por_canal.meta === 9 && p30.por_canal.google === 5 && p30.por_canal.direto === 9, `midia_leads: canais ${JSON.stringify(p30?.por_canal)}`);
ok(!JSON.stringify(x.d).includes("nao-deveria@sair.com") && visto.cfSql.every((s) => !s.includes("{inicio}") && /23:59:59/.test(s)), "midia_leads: só contagens (coluna extra descartada) e datas substituídas");

// acessos e descoberta
x = await t("midia_acessos", {});
ok(!x.erro && Object.values(x.d.credenciais).every(Boolean) && x.d.ga4[0].propriedades[0].id === "4242" && x.d.gtm[0].conteineres[0].id === "GTM-TESTE01" && x.d.meta[0].conta === "528562687958126" && x.d.google_ads.contas.length === 2 && x.d.cloudflare[0].nome === "Resultz", "midia_acessos: o que a agência enxerga em cada plataforma");
x = await t("midia_descobrir", { site: "exemplo.com.br" });
const fs = x.d.ficha_sugerida;
ok(!x.erro && fs.google.gtm === "GTM-TESTE01" && fs.google.ga4_propriedade === "4242" && fs.google.ads_cliente === "5550001111" && fs.meta.conta === "528562687958126" && fs.cloudflare.d1_banco === "d1-exemplo", "midia_descobrir: ficha sugerida com contas achadas nas APIs");

// papéis e credenciais
var ac = await rpc("lojas", ADMIN, "tools/call", { name: "gerenciar_acessos", arguments: { acao: "criar", nome: "Leitor Midia", papel: "leitor", areas: ["midia"] } });
const LEI = JSON.parse(ac.json.result.content[0].text).links.midia.split("/").pop();
r = await rpc("midia", LEI, "tools/list", {});
const nomesLei = r.json.result.tools.map((y) => y.name);
ok(!nomesLei.includes("midia_salvar_cliente") && !nomesLei.includes("midia_consulta_meta") && nomesLei.includes("midia_meta"), "papéis: leitor vê coletas, não vê salvar ficha nem consultas livres");
const metaTok = env.META_ACCESS_TOKEN; delete env.META_ACCESS_TOKEN;
x = await t("tag_meta", { pixel: "998877665544332" });
ok(!x.erro && x.d.falhas.pixel?.includes("META_ACCESS_TOKEN"), "credencial ausente vira falha clara");
env.META_ACCESS_TOKEN = metaTok;

// proteções: tokens do Meta e banco consultado pelos leads
x = await t("midia_consulta_meta", { caminho: "me/accounts", params: { fields: "id,name,access_token" } });
ok(!x.erro && x.d.data[0].name === "Página Exemplo" && !JSON.stringify(x.d).includes("EAApagina") && !("access_token" in x.d.data[0]), "consulta Graph remove tokens de páginas da resposta");
x = await t("midia_consulta_meta", { caminho: "erro_com_token" });
ok(x.erro && x.d.includes("access_token=***") && !x.d.includes(META_TOKEN), "erro do Meta não expõe o token");
ac = await rpc("lojas", ADMIN, "tools/call", { name: "gerenciar_acessos", arguments: { acao: "criar", nome: "Editor Midia", papel: "editor", areas: ["midia"] } });
const EDM = JSON.parse(ac.json.result.content[0].text).links.midia.split("/").pop();
x = await t("midia_salvar_cliente", { slug: "exemplo", ficha: { cloudflare: { d1_banco: "05e8705f-banco-do-mcp" } }, motivo: "teste" }, EDM);
ok(x.erro && x.d.includes("administrador"), "editor não muda o banco consultado pelos leads (cloudflare/leads só admin)");
x = await t("midia_salvar_cliente", { slug: "exemplo", ficha: { site: { plataforma: "cloudflare-pages" } }, motivo: "complementar plataforma" }, EDM);
ok(!x.erro && x.d.ficha.site.plataforma === "cloudflare-pages" && x.d.ficha.cloudflare.d1_banco === "d1-exemplo", "editor altera as outras seções da ficha");

// nenhum segredo nas respostas nem no log
const lg = await t("consultar_log", { limite: 500 });
const tudo = saidas.join("\n") + JSON.stringify(lg.d);
const segredos = ["EAApagina", META_TOKEN, "ya29.sa", "ya29.ads", "csecret", "1//refreshficticio", "cf-token-ficticio", pkcs8.slice(10, 50)];
ok(segredos.every((s) => !tudo.includes(s)), "nenhum token, chave ou segredo aparece nas respostas nem no log");
ok(lg.d.registros.some((y) => y.ferramenta === "midia_salvar_cliente" && y.resultado === "ok" && y.depois?.includes("GTM-TESTE01")), "log: ficha salva com antes/depois");
