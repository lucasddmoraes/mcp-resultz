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
- `wrangler.jsonc`: configuração para o deploy pelo Claude Code.
- `.dev.vars.example`: modelo de segredos para rodar localmente. O arquivo real `.dev.vars` nunca vai para o git.

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

Dois caminhos, escolher um e manter:

- Painel web: colar `worker.js` no editor do Worker e clicar em Deploy.
- Claude Code: `npx wrangler deploy` usando o `wrangler.jsonc` (o próprio Claude Code executa; o Lucas só autoriza
  o login da Cloudflare no navegador na primeira vez). Antes do primeiro deploy, preencher `database_id` com o ID
  do banco D1 `mcp-resultz` (`npx wrangler d1 list`). `keep_vars` está ligado para não apagar variáveis criadas
  pelo painel.

Segredos (`ADMIN_TOKEN`, `WOO_*`) são sempre cadastrados pelo Lucas no painel da Cloudflare. Nunca pedir que ele
cole valores de segredo no chat nem gravar em arquivo versionado.

## Estado atual

- Versão 1.0.0: testada localmente (38 verificações) contra a loja real do GDV, com escritas interceptadas.
- Pendente: publicar e fazer o primeiro teste real de escrita (criar um cupom pelo conector e consultar o log).

## Próximos passos

1. Reescrever as skills `woo-precos-parcelas` e `relatorio-gdv` para usar este conector, sem nenhuma chave dentro;
   depois revogar nas lojas as chaves antigas que estavam no `lojas.json` dessas skills.
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
