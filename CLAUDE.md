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

- `worker.js`: o servidor inteiro.
- `test.mjs`: bateria de testes local (Node 22+, `node test.mjs`). Simula o D1 com `node:sqlite`, lê dados reais
  das lojas e intercepta toda escrita (POST/PUT/DELETE), então não altera nada em produção. Chaves: arquivo
  apontado por `LOJAS_JSON` (formato `{"gdv":{"ck":"","cs":""},"sh":{...}}`) ou variáveis `WOO_*`.
  Rodar os testes depois de qualquer mudança.
- `test-offline.mjs`: testes sem acesso às lojas (`npm run test:offline`), com D1 e WooCommerce simulados em memória.
  Cobre rotas, instruções, descrições, simulação/aplicação de preço e parcelas e log. Roda em qualquer lugar; usar
  quando não houver chaves para o `test.mjs`.
- `wrangler.jsonc`: configuração lida pela integração Git da Cloudflare no deploy (nome do Worker, D1, domínio).
- `.dev.vars.example`: modelo de segredos para rodar localmente. O arquivo real `.dev.vars` nunca vai para o git.
- `public/`: página da raiz (`index.html`, mostra "MCP Resultz ativo." e anuncia o favicon no `<head>`) e ícones
  (`favicon.png` 96x96, `favicon.ico`, `icon.png`, `apple-touch-icon.png`), servidos como static assets direto pela
  Cloudflare, sem passar pelo `worker.js`. Ícones gerados a partir de `icon.jpg` (original, 1000x1000).
  O `initialize` também anuncia `icon.png` em `serverInfo.icons`. Não colocar nada sensível em `public/`: tudo
  ali fica público.

## Endereço

`https://mcp.resultz.com.br/<area>/<token>` (aceita também `/<area>/<token>/mcp`).
O token identifica a pessoa. Token inválido responde 404. `/.well-known/*` responde 404 (sem OAuth).

## Configuração no Worker

- Binding D1: `DB` (as tabelas `usuarios` e `log` são criadas sozinhas na primeira chamada).
- Secrets: `ADMIN_TOKEN` (dono, mínimo 32 caracteres), `WOO_GDV_CK`, `WOO_GDV_CS`, `WOO_SH_CK`, `WOO_SH_CS`.
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
- Pendente: primeiro teste real de escrita (criar um cupom pelo conector e consultar o log).

## Próximos passos

1. Remover da conta do Lucas as skills antigas `woo-precos-parcelas` e `relatorio-gdv` (têm chaves dentro). Depois
   revogar nas lojas as três chaves antigas: GDV `...53e4` (woo-precos-parcelas), GDV `...a8d8` (relatorio-gdv) e
   Super Humanos `...1f44` (woo-precos-parcelas). Antes, conferir o último acesso de cada uma, porque outro sistema
   pode usar a mesma chave.
2. Nova área `sumare` a partir da skill `sumare-dash-captacao` (API do Dash de Captação, gateway Softsy). Listas de
   candidatos têm dados pessoais: registrar quem puxou cada lista.
3. Avaliar área `postiz` (agendamento de redes sociais) com trava de só rascunho para quem não é admin, ou usar o
   servidor MCP do próprio Postiz se cada pessoa tiver usuário lá.

## Limites da Cloudflare

Plano gratuito: 10 ms de CPU e 50 subrequests externos por chamada. Relatórios grandes (categoria inteira, ano
inteiro) passam disso; nesse caso, plano Workers Paid.

## Convenções

- Textos para o usuário em português do Brasil, sem travessão.
- Quando algo precisar ser feito pelo Lucas, explicar o passo a passo pelo painel web, nunca pedir que ele digite
  comandos no terminal. Comandos, o próprio Claude Code executa.
