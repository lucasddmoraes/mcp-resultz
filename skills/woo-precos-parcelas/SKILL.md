---
name: woo-precos-parcelas
description: "Altera preços e número de parcelas em lote nas lojas WooCommerce dos colégios (loja.gdv.com.br e loja.colegiosuperhumanos.com.br, ambas com o plugin WooCommerce Parcelas) usando o conector Resultz Lojas. Use quando o usuário pedir para mudar parcelamento (ex.: passar de 5x para 4x mantendo o valor da parcela), aplicar desconto ou reajuste percentual, definir preço fixo, ou alterar preço/parcelas de uma categoria inteira (eletivas, esportes, estudos do meio, cursos de férias). Também acione em pedidos como \"mudar as eletivas para 4x\", \"reajustar em 10%\", \"alterar preço em lote\", \"bulk edit WooCommerce\", ou quando mencionar parcelamento, installment, preço de produto e loja de colégio."
---

# Alteração em lote de preços e parcelamento (WooCommerce)

Altera preço e/ou número de parcelas de vários produtos de uma vez pelo conector **Resultz Lojas**
(ferramenta `alterar_preco_parcelas`). O conector guarda as credenciais das lojas e registra cada
chamada no log de auditoria com o nome de quem pediu.

**Regra de ouro: nunca aplique antes de mostrar o plano e receber confirmação explícita.**
São preços de venda em produção.

## 0. Pré-requisito

Esta skill não tem chave, script de acesso nem arquivo de credencial. Tudo passa pelo conector.

- Confira se as ferramentas do conector Resultz Lojas estão disponíveis (`buscar_produtos`,
  `alterar_preco_parcelas`). Se não estiverem, pare e oriente a pessoa: Configurações > Conectores >
  Adicionar conector personalizado, com o link pessoal que recebeu do Lucas.
- `alterar_preco_parcelas` só aparece para papel **editor** ou **admin**. Se a pessoa for leitora,
  diga que precisa pedir ao Lucas a mudança de papel. Use `meu_acesso` em caso de dúvida.
- **Nunca** use outro caminho para escrever na loja: API direta, chave colada no chat, navegador
  logado no wp-admin com script ou planilha importada. Isso tira a alteração do log. Se o conector
  falhar, informe o erro e pare.

## Lojas

| `loja` | Host | Colégio |
|---|---|---|
| `gdv` | loja.gdv.com.br | Colégio Guilherme Dumont Villares |
| `sh` | loja.colegiosuperhumanos.com.br | Colégio Super Humanos |

Quando o usuário disser "Super Humanos", "SH" ou "CSH", use `sh`. "GDV", "Guilherme Dumont" ou
"Dumont Villares" é `gdv`.

## 1. Plugin WooCommerce Parcelas

As duas lojas usam o plugin **WooCommerce Parcelas** (autor Filipe Seabra, prefixo `fswp`). Ele tem
uma configuração global (quantidade de parcelas, valor mínimo da parcela, desconto à vista) e uma
**sobrescrita por produto** (meta `fswp_post_meta`, campo `installment_qty`). O conector já lê e
grava essa meta do jeito certo: envia o objeto inteiro e troca só a quantidade.

> O plugin foi fechado no repositório do WordPress em 26/10/2025 por violação de licença/marca e
> está sem atualização há anos (última 1.3.5, testada até o WP 6.4). Ele continua funcionando, mas
> não recebe correções e não pode ser reinstalado pelo painel. Se o assunto vier à tona, vale
> lembrar o usuário disso; não transforme toda tarefa de preço em conversa sobre trocar de plugin.

## 2. Global x sobrescrita por produto

Este é o ponto que mais gera erro. Nas respostas do conector, `parcelas: "global"` (ou
`parcelas_antes: "global"`) significa que o produto **herda** a configuração global do plugin; um
número significa sobrescrita gravada no próprio produto.

Antes de planejar, use `buscar_produtos` com a categoria e mostre quantos produtos estão em cada
grupo. Decida junto com o usuário:

- **Todos com sobrescrita**: segue o fluxo normal.
- **Todos herdando o global**: mudar de 5x para 4x é **uma única alteração** na configuração do
  plugin no wp-admin, feita por uma pessoa, não dezenas de edições. Os preços continuam podendo ir
  pelo conector. Atenção: mexer no global afeta a loja inteira, inclusive categorias fora do
  pedido. Confirme isso explicitamente.
- **Misturado**: o conector cria sobrescrita nos que herdavam quando a regra define
  `parcelas_para` e **não** há `filtro.parcelas_atuais`. A simulação avisa ("passarão a ter
  parcelamento próprio"). O global fica intacto. É o caminho mais seguro quando o pedido é só para
  uma categoria.

Outras armadilhas do plugin:

- **Valor mínimo da parcela** (global). Se estiver em R$ 200 e a parcela calculada der R$ 190, a
  vitrine exibe menos parcelas do que o configurado. Sempre confira a página pública depois.
- **Desconto à vista** também mora em `fswp_post_meta`. O conector não mexe nele.

## 3. Coletar do usuário

- **Loja** e **categoria** (nome, slug ou ID; o conector resolve). Para produtos avulsos, use
  `buscar_produtos` e monte a lista de IDs.
- **Status**: por padrão só `publish`. Produtos `private` e `draft` ficam de fora a menos que o
  usuário peça (`filtro.status`).
- **Parcelas atuais**: normalmente só os que estão em N x (`filtro.parcelas_atuais`).
- **Regra** (`regra.tipo`):
  - `manter_parcela`: mantém o valor da parcela e muda a quantidade.
    `novo = preço ÷ parcelas_atuais × parcelas_para`. É o caso de 5x para 4x (queda de 20%).
    **Sempre** informe `filtro.parcelas_atuais` junto: sem ele, um único produto herdando o global
    faz a simulação inteira falhar.
  - `percentual`: `novo = preço × (1 + pct/100)`; `pct` negativo é desconto. Aceita
    `parcelas_para` opcional.
  - `fixo`: mesmo preço (`valor`, em reais) para todos do filtro. Aceita `parcelas_para`.
  - `so_parcelas`: muda só a quantidade (`parcelas_para`), preço intacto (a parcela sobe).
- **Lista explícita**: em vez de `filtro` + `regra`, use `itens: [{id, preco, parcelas}]` quando o
  usuário der valores produto a produto. Não misture os dois na mesma chamada.
- **Arredondamento**: o conector arredonda ao centavo. Na simulação, confira se
  `parcela × parcelas_depois` fecha com `preco_depois`; se muitos ficarem quebrados, pergunte se
  prefere arredondar o preço final para o real ou para a dezena (aí use `itens` com os valores
  arredondados).

Limites do conector: até 200 produtos por chamada (divida por categoria ou status se passar) e
parcelas entre 1 e 24.

## 4. Simulação, confirmação, aplicação

1. **Simule**: `alterar_preco_parcelas` com `aplicar: false` (ou sem `aplicar`) e `motivo` = o
   pedido do usuário nas palavras dele. A resposta traz `plano`, `fora` (com o motivo de cada um),
   `avisos` e `codigo_confirmacao`.
2. **Mostre** ao usuário: quantos produtos, distribuição de preços antes/depois (agrupe por faixa
   `preço antes -> preço depois`), quantos herdavam o global, produtos com preço promocional e a
   lista dos que ficaram **de fora** com o motivo. Peça confirmação explícita (use
   `AskUserQuestion` se disponível).
3. **Aplique** só depois do "sim": chame de novo com **exatamente os mesmos parâmetros**,
   `aplicar: true` e o `codigo_confirmacao` recebido. Se o conector disser que o código não confere,
   o catálogo mudou desde a simulação: simule de novo e mostre o plano novo. Nunca reaproveite
   código de outra simulação.
4. **Verificação**: a resposta da aplicação traz `atualizados`, `verificados_ok` e `falhas` (o
   conector relê os produtos pela API). Só reporte sucesso se `falhas` vier vazio e `erro` for
   nulo. Se vier `parcial`, liste o que não bateu e não tente "corrigir" sem perguntar.
5. **Vitrine**: abra a página pública de um produto alterado (o `link` vem em `buscar_produtos`) e
   confira preço e "Nx de R$". O tema ou um plugin de cache pode segurar o valor antigo.

## 5. Desfazer

O conector não tem botão de desfazer nem ferramenta de exclusão, de propósito. Para reverter:

- Guarde o `plano` da simulação (ele tem `preco_antes` e `parcelas_antes` de cada produto) na
  planilha de entrega.
- Para voltar atrás, faça uma nova chamada com `itens: [{id, preco: preco_antes, parcelas:
  parcelas_antes}]`, passando de novo por simulação e confirmação.
- Produtos que herdavam o global (`parcelas_antes: "global"`) não voltam a herdar pelo conector:
  só dá para gravar um número. Se isso importar, avise que a remoção da sobrescrita é manual no
  wp-admin.
- Administradores podem consultar o antes/depois de qualquer alteração com `consultar_log`.

## 6. Entregar

- Planilha `.xlsx` (skill `xlsx`): ID, Produto, Preço anterior, Parcela, Novo preço, Parcelas
  antes, Parcelas depois, Diferença, link `https://<host>/wp-admin/post.php?post=<id>&action=edit`.
  Aba de resumo por faixa de preço. Loja, regra aplicada, data e `codigo_confirmacao` anotados no
  rodapé.
- No chat: escopo alterado, escopo excluído e por quê, totais antes/depois, resultado da
  verificação.

## Limites

- Não mexa em `sale_price`. Se um produto tiver preço promocional, sinalize: a vitrine mostra o
  promocional, então a conta de parcela muda.
- Produtos variáveis (`type: variable`) têm preço nas variações; o conector os coloca em `fora` e
  não altera. Trate à parte se aparecerem (hoje, só pelo wp-admin).
- Esta skill não altera status, estoque, categoria nem outro campo. Para status existe a ferramenta
  `alterar_status_produto`; para cupons, `criar_cupom`.
- Não crie nem apague produtos.
