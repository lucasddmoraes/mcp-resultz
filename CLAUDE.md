# MCP Resultz

Servidor MCP remoto da Resultz. Um único Cloudflare Worker, em JavaScript puro e sem dependências, que expõe
"áreas" como conectores personalizados do Claude. Cada pessoa do time adiciona o conector na própria conta do
Claude (usa os próprios tokens); o Worker guarda as credenciais dos sistemas e registra tudo em log.

## Por que existe

O time usa as próprias contas do Claude (cada um gasta os próprios tokens), mas as credenciais dos sistemas não
podem ficar espalhadas em skills. Então: o Claude de cada pessoa raciocina, este Worker executa e registra tudo.
A identificação é por token no caminho da URL porque é o jeito mais simples de funcionar como conector
personalizado do Claude sem OAuth. Se o time crescer, evoluir para login Google restrito a @resultz.com.br.

## Arquivos

- `worker.js`: o servidor (roteamento, MCP, log, acessos e as áreas `lojas` e `sumare`).
- `midia.js`: área `midia` (tagueamento e mídia paga), em módulo próprio por ser grande. Recebe do `worker.js` os
  utilitários (`falha`, `norm`, `P_MOTIVO`, `corta`) em `criarAreaMidia(...)`.
- `test-midia.mjs`: testes da área `midia` com Google, Google Ads, GA4, GTM, Meta, Cloudflare e um site de exemplo
  simulados em memória (inclusive a assinatura do JWT da conta de serviço). Roda junto no `npm run test:offline`.
- `test.mjs`: bateria de testes local (Node 22+, `node test.mjs`). Simula o D1 com `node:sqlite`, lê dados reais
  das lojas e intercepta toda escrita (POST/PUT/DELETE), então não altera nada em produção. Chaves: arquivo
  apontado por `LOJAS_JSON` (formato `{"gdv":{"ck":"","cs":""},"sh":{...}}`) ou variáveis `WOO_*`.
  Rodar os testes depois de qualquer mudança.
- `test-offline.mjs`: testes sem acesso às lojas (`npm run test:offline`), com D1 e WooCommerce simulados em memória.
  Cobre rotas, instruções, descrições, simulação/aplicação de preço e parcelas, a área `sumare` inteira (API Softsy
  simulada com dados fictícios), papéis e log. Roda em qualquer lugar; usar quando não houver chaves para o `test.mjs`.
- `wrangler.jsonc`: configuração lida pela integração Git da Cloudflare no deploy (nome do Worker, D1, domínio).
- `.dev.vars.example`: modelo de segredos para rodar localmente. O arquivo real `.dev.vars` nunca vai para o git.
- `public/`: página da raiz (`index.html`, mostra "MCP Resultz ativo." e anuncia o favicon no `<head>`) e ícones
  (`favicon.png` 96x96, `favicon.ico`, `icon.png`, `apple-touch-icon.png`), servidos como static assets direto pela
  Cloudflare, sem passar pelo `worker.js`. Ícones gerados a partir de `icon.jpg` (original, 1000x1000).
  `public/marca/` tem o logo e o selo da Resultz usados nos relatórios de mídia.
  O `initialize` também anuncia `icon.png` em `serverInfo.icons`. Não colocar nada sensível em `public/`: tudo
  ali fica público.

## Endereço

`https://mcp.resultz.com.br/<area>/<token>` (aceita também `/<area>/<token>/mcp`).
O token identifica a pessoa. Token inválido responde 404. `/.well-known/*` responde 404 (sem OAuth).

## Configuração no Worker

- Binding D1: `DB` (as tabelas `usuarios` e `log` são criadas sozinhas na primeira chamada).
- Secrets: `ADMIN_TOKEN` (dono, mínimo 32 caracteres), `WOO_GDV_CK`, `WOO_GDV_CS`, `WOO_SH_CK`, `WOO_SH_CS`,
  `SUMARE_API_USER`, `SUMARE_API_PASS` (Basic da API do Dash de Captação da Sumaré).
- Secrets da área `midia`: `GOOGLE_SA_JSON` (JSON inteiro da chave da conta de serviço, ou o mesmo em base64),
  `GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET`, `GOOGLE_ADS_REFRESH_TOKEN`, `GOOGLE_ADS_LOGIN_CUSTOMER_ID` (MCC,
  só números), `META_ACCESS_TOKEN` (usuário do sistema da BM da Resultz) e `CLOUDFLARE_API_TOKEN` (leitura de
  zonas/Pages e SELECT no D1 de leads dos sites). Opcionais: `GOOGLE_ADS_API_VERSION`, `GOOGLE_ADS_DEVELOPER_TOKEN`,
  `META_API_VERSION` (v23.0).
- Variáveis opcionais: `ADMIN_NOME`, `BASE_URL`, `CUPOM_MAX_PCT_EDITOR` (50), `CUPOM_MAX_FIXO_EDITOR` (300),
  `CUPOM_MAX_USOS_EDITOR` (20), `EXCLUIR_EMAILS` (login@resultzads.com).

## Regras que não podem ser quebradas

1. Nada executa sem antes gravar a linha no log (`logAbrir`). Se o log falhar, a ação não acontece.
2. Toda ferramenta de escrita exige `motivo` (o pedido do usuário nas palavras dele).
3. Não existem ferramentas de exclusão. Não criar.
4. Alteração em lote de preço segue simulação + `codigo_confirmacao` (hash do plano). Isso impede aplicar duas
   vezes e garante que o aplicado é o que foi mostrado.
5. Tokens nunca vão para o log nem para o banco em texto puro (só o SHA-256).
6. Credenciais dos sistemas só existem nos secrets do Worker. Nunca em skill, código ou chat.

## Regras de negócio ficam no servidor

As regras de uso (fluxo de preço e parcelas, plugin WooCommerce Parcelas, colunas e formato do relatório, cuidado
com dados de famílias, proibição de outro caminho até as lojas) estão nas `instrucoes` da área e na `descricao` de
cada ferramenta, no `worker.js`. O Claude de cada pessoa recebe isso ao conectar. Não há skill para distribuir: mudou
uma regra, muda aqui, e o merge publica para todo mundo.

## Papéis

`leitor` (consulta e relatório) < `editor` (status, preço/parcelas, cupom dentro dos limites) < `admin` (tudo,
inclusive `consultar_log` e `gerenciar_acessos`). Ferramentas acima do papel nem aparecem para a pessoa.

## Como adicionar uma área nova (ex.: Sumaré)

1. Criar o array de ferramentas da área seguindo o formato de `FERRAMENTAS_LOJAS`
   (`nome`, `titulo`, `tipo` leitura|escrita|admin, `papel`, `descricao`, `entrada` em JSON Schema, `executar`).
2. Registrar em `AREAS` (titulo, ferramentas, instrucoes) e incluir o nome em `NOMES_AREAS`.
3. Credenciais do sistema novo como secrets no Worker.
4. Liberar a área para as pessoas com `gerenciar_acessos` (acao `alterar`, campo `areas`).
5. Cada pessoa adiciona o novo endereço `https://mcp.resultz.com.br/<area>/<token>` como outro conector.

## Detalhes das lojas (WooCommerce)

- Parcelamento vem do plugin WooCommerce Parcelas: meta `fswp_post_meta`, campo `installment_qty`. Ao gravar,
  enviar o objeto inteiro trocando só `installment_qty`. Vazio ou ausente = herda o global.
- Autenticação na API: Basic Auth. Chave na query string falha em POST/PUT nessas lojas.
- Relatório filtra pedidos por produto na API (`product=<id>`) sempre que possível; varrer todos os pedidos é
  lento e estoura o limite de CPU do plano gratuito.
- Pedidos do e-mail login@resultzads.com ficam fora dos relatórios.

## Detalhes da Sumaré (área `sumare`)

- API Softsy: `https://gateway-sumare.softsy.io/dash-captacao/api/integracao/v1`, Basic Auth. `GET /filtros` (códigos
  de cursos, polos, áreas, turnos, concursos, tipos de ingresso, campanhas, etapas) e `GET /candidatos` (um registro
  por inscrição; `tamanho` até 5000, `pagina`; filtros `etapas`, `status`, `cursos`, `polos`, `areas`, `turnos`,
  `concursos`, `tiposIngresso`). Não há filtro de data nem de campanha no servidor: o Worker filtra localmente.
- Volume medido em 22/10/2026: 2.235 registros (2,0 MB, ~11 ms só para ler o JSON); 512 convertidos (0,5 MB, ~2 ms).
  Matrículas pedem só `etapas=CONVERTIDO`. Funil e inscrições leem a base inteira e ficam no limite de 10 ms de CPU
  do plano gratuito; se aparecer erro de limite de CPU, usar o plano Workers Paid (o Lucas já autorizou).
- Ferramentas: `sumare_matriculas` (leitor; matrículas ou inscrições por período, quebra, comparação),
  `sumare_funil` (leitor; retrato por etapa/status), `sumare_opcoes` (leitor; valores de filtro) e
  `sumare_lista_candidatos` (editor; dados pessoais, exige `motivo`, páginas de 250). O log guarda quem puxou,
  motivo, filtros e quantidade, nunca os dados pessoais.
- Registros de teste (parte local do e-mail = `teste`) ficam fora por padrão.

## Detalhes da Mídia (área `midia`)

Portada da skill `resultzads/skilltagueamento` (tagueamento + auditoria-midia), que rodava em Python pelo GitHub
Actions. Aqui o método (checklist, padrões de UTM e de evento de lead, severidades, saúde, prioridades P0 a P2,
estrutura e identidade do relatório) está nas instruções da área e nas descrições das ferramentas.

- Fase 1 (atual): só leitura nas plataformas. Escopos do Google só de leitura (`analytics.readonly`,
  `tagmanager.readonly`). A única escrita é a ficha do cliente no D1 do MCP (`midia_salvar_cliente`).
- Fichas de clientes: tabela `midia_clientes` (criada sozinha), uma linha por slug com a ficha em JSON (seções
  cliente, site, google, meta, cloudflare, leads e histórico). Só IDs; a ferramenta recusa ficha com cara de token.
  As seções `cloudflare` e `leads` só o admin altera: elas definem qual banco é consultado com o token da agência
  (um editor poderia apontar para outro D1 da conta, inclusive o do próprio MCP).
- Respostas do Meta passam por um filtro que remove qualquer campo de token (ex.: tokens de páginas em `me/accounts`)
  e erros têm `access_token` mascarado.
- Ferramentas (leitor): `midia_clientes`, `midia_acessos`, `midia_descobrir`, `tag_site`, `tag_publicado`, `tag_ga4`,
  `tag_google_ads`, `tag_meta`, `midia_meta`, `midia_google`, `midia_leads`. Editor: `midia_salvar_cliente`,
  `midia_consulta_google_ads` (GAQL, só SELECT) e `midia_consulta_meta` (Graph, só GET).
- Coletas: períodos de 30d, 30d anteriores e 90d, terminando ontem (Brasília). Uma parte que falha (sem acesso,
  API recusou) vira item em `falhas` e não derruba o resto. `partes` limita o que é coletado.
- Leads reais: `leads.consulta_periodo` da ficha (um único SELECT com origem, midia, campanha, n e `{inicio}`/`{fim}`)
  rodado pela API da Cloudflare no D1 do site do cliente. Só contagens saem; colunas extras são descartadas.
- Google Ads: a versão da API é descoberta sozinha (v26 para trás, uma sondagem por vez) e fica em cache.
- PDF: o Worker não gera. O Claude de cada pessoa monta o relatório (Artifact ou arquivo) com a identidade descrita
  nas instruções e o logo de `https://mcp.resultz.com.br/marca/`.
- Fase 2 (correções de tagueamento: GTM em espaço novo sem publicar sem confirmação, eventos-chave do GA4, conversão
  principal do Ads) e fase 3 (alterações em campanhas com limites por papel e acesso por cliente) ainda não existem.

## Deploy

Caminho oficial: integração Git da Cloudflare (Workers Builds). O Worker `mcp-resultz` fica conectado ao
repositório `lucasddmoraes/mcp-resultz` e cada push na branch `main` faz build e deploy automáticos com
`npx wrangler deploy`, lendo o `wrangler.jsonc`. Cada versão no ar corresponde a um commit.

- Não usar `wrangler deploy` local nem fazer login na Cloudflare pelo Claude Code. A conta da Resultz concentra
  outros domínios e Workers; o Claude Code só precisa enxergar o repositório.
- Não colar código no editor do painel: a próxima build sobrescreve.
- Mudanças entram por branch + pull request. Merge na `main` = deploy em produção.
- O nome do Worker no painel precisa ser igual ao `name` do `wrangler.jsonc` (`mcp-resultz`), senão a build falha.
- `database_id` no `wrangler.jsonc` é o ID do banco D1 `mcp-resultz` (não é segredo).
- `keep_vars` está ligado para não apagar variáveis criadas pelo painel.
- Builds de branches que não são a `main` (Previews) ficam desligadas, para não existir outro endereço servindo o
  conector.

Segredos (`ADMIN_TOKEN`, `WOO_*`) são sempre cadastrados pelo Lucas no painel da Cloudflare (Worker > Settings >
Variables and Secrets). Nunca pedir que ele cole valores de segredo no chat nem gravar em arquivo versionado.

## Estado atual

- Versão 1.0.0: testada localmente (38 verificações) contra a loja real do GDV, com escritas interceptadas.
- Versão 1.1.0: regras das antigas skills `woo-precos-parcelas` e `relatorio-gdv` levadas para instruções e
  descrições; `manter_parcela` deixa de falhar quando um produto herda o parcelamento global (vai para `fora`).
  Testada com `test-offline.mjs`; o `test.mjs` não rodou por falta de chaves.
- No ar desde 22/10/2026: Worker `mcp-resultz` criado pela importação do repositório `lucasddmoraes/mcp-resultz`
  (Workers Builds, branch `main`), banco D1 `mcp-resultz` (região ENAM), domínio `mcp.resultz.com.br`.
- Segredos `ADMIN_TOKEN` e `WOO_*` cadastrados pelo Lucas no painel, com chaves novas geradas nas duas lojas.
- Verificado de fora: raiz responde 200 "MCP Resultz ativo."; token inválido, `/.well-known/*` e área inexistente
  respondem 404. O token inválido passa pelo D1, então o binding está funcionando.
- Conector do Lucas adicionado no claude.ai como "Resultz Lojas".
- Ícone: o claude.ai não usa `serverInfo.icons` de forma confiável; pelos relatos, usa o serviço de favicons do
  Google (`https://www.google.com/s2/favicons?domain=<host>&sz=64`). Em 22/10/2026 esse serviço já devolvia a ovelha
  para `resultz.com.br` e 404 (globo) para `mcp.resultz.com.br`. Por isso a raiz passou a ser uma página HTML com
  `<link rel="icon">`, que o Google precisa rastrear; a atualização do serviço pode levar dias.
- Versão 1.2.0: área `sumare` (Dash de Captação). Testada com `test-offline.mjs` (40 verificações) e, em 22/10/2026,
  em produção pelo conector "Resultz Sumaré" do Lucas: matrículas com comparação, funil, inscrições por semana e
  filtro de curso por nome funcionaram no plano gratuito, sem erro de CPU (base com ~2.200 candidatos). Lista de
  candidatos ainda não usada em produção.
- Pendente: primeiro teste real de escrita (criar um cupom pelo conector e consultar o log).
- Secrets `SUMARE_API_USER` e `SUMARE_API_PASS` cadastrados pelo Lucas; conector "Resultz Sumaré" adicionado.
- Versão 1.3.0: área `midia`, fase 1 (só leitura). Testada com `test-midia.mjs` (53 verificações, APIs simuladas) e no
  motor da Cloudflare (`wrangler dev`): ferramentas, ficha no D1, logo e assinatura do JWT da conta de serviço aceita
  pelo Google. Ainda não testada com as credenciais reais da agência.
- Versão 1.3.1 (24/10/2026, verificação de segurança): `midia_consulta_meta` recusa `params.method`, `batch` e
  `access_token` (o Graph aceita trocar o verbo HTTP pelo parâmetro `method`, o que transformaria a ferramenta de
  leitura em escrita); o log mascara a lista de e-mails de `criar_cupom`; `midia_salvar_cliente` valida o formato
  dos IDs de conta, zona e banco D1 da Cloudflare antes de aceitá-los no caminho da API.
- Pendente: liberar a área `sumare` para quem precisa (`gerenciar_acessos`, acao `alterar`, informando todas as
  áreas da pessoa, porque a lista é substituída).

## Próximos passos

1. Remover da conta do Lucas as skills antigas `woo-precos-parcelas` e `relatorio-gdv` (têm chaves dentro). Depois
   revogar nas lojas as três chaves antigas: GDV `...53e4` (woo-precos-parcelas), GDV `...a8d8` (relatorio-gdv) e
   Super Humanos `...1f44` (woo-precos-parcelas). Antes, conferir o último acesso de cada uma, porque outro sistema
   pode usar a mesma chave.
2. Remover a skill `sumare-dash-captacao` da conta do Lucas: a credencial da API está gravada no script dela. Se
   possível, pedir à Softsy uma credencial nova para o Worker e desativar a antiga.
3. Mídia, fase 1: Lucas cadastrar os secrets da área `midia`, adicionar o conector `/midia/<token>`, cadastrar as fichas
   (a do Colégio Super Humanos está em `resultzads/skilltagueamento/clientes/`) e validar cada ferramenta contra as
   contas reais.
4. Mídia, fase 2 (correções de tagueamento) e fase 3 (alterações em campanhas), nessa ordem, depois da fase 1 validada.
5. O repositório `resultzads/skilltagueamento` pode ser apagado quando a fase 1 estiver validada com as contas reais e
   as fichas e auditorias que valem guardar (pastas `clientes/` e `auditorias/`) estiverem migradas. Antes, revogar
   as credenciais guardadas nos segredos dele, se não forem as mesmas cadastradas no Worker.
6. Avaliar área `postiz` (agendamento de redes sociais) com trava de só rascunho para quem não é admin, ou usar o
   servidor MCP do próprio Postiz se cada pessoa tiver usuário lá.

## Limites da Cloudflare

Plano Workers Paid ativo (confirmado pelo Lucas em 22/10/2026): bem mais CPU e subrequests por chamada que o
gratuito (10 ms e 50). A área `midia` depende dele.

## Convenções

- Textos para o usuário em português do Brasil, sem travessão.
- Quando algo precisar ser feito pelo Lucas, explicar o passo a passo pelo painel web, nunca pedir que ele digite
  comandos no terminal. Comandos, o próprio Claude Code executa.
