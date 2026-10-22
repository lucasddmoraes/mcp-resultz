---
name: relatorio-gdv
description: >
  Gera relatórios limpos de vendas das lojas WooCommerce dos colégios (GDV e Super Humanos) pelo
  conector Resultz Lojas (ou a partir de um CSV exportado). Filtra por produto, categoria e período,
  remove pedidos cancelados/devolvidos e os de e-mail interno da agência, extrai o nome do aluno a
  partir do e-mail @...g12.br e salva o resultado em .xlsx formatado.
  SEMPRE use esta skill quando o usuário pedir relatório de vendas, planilha de vendas,
  exportar pedidos, limpar planilha do WooCommerce, relatório de produto, relatório por categoria,
  lista de alunos inscritos, lista de vendas, ou qualquer pedido relacionado a extrair e organizar
  dados de vendas da loja. Também acione quando o usuário mencionar "B3", "estudo do meio",
  "eletivas", "loja", "woocommerce", "pedidos", ou nomes de produtos/categorias da loja.
---

# Relatório de Vendas WooCommerce

Gera relatórios limpos de vendas a partir da ferramenta `relatorio_vendas` do conector
**Resultz Lojas**. O conector guarda as credenciais das lojas e registra no log de auditoria quem
puxou cada relatório.

## 0. Pré-requisito

Esta skill não tem chave, script de acesso à loja nem arquivo de credencial.

- Confira se a ferramenta `relatorio_vendas` do conector Resultz Lojas está disponível. Se não
  estiver, pare e oriente a pessoa: Configurações > Conectores > Adicionar conector personalizado,
  com o link pessoal que recebeu do Lucas.
- **Nunca** busque pedidos por outro caminho (API direta, chave colada no chat, navegador). Se o
  conector falhar, informe o erro e pare.
- O relatório traz dados pessoais de famílias (e-mail, nome do aluno). Use só para o fim pedido, não
  repita os dados no chat além do necessário e entregue a lista completa só na planilha.

## 1. Coletar do usuário

- **Loja**: `gdv` (Colégio Guilherme Dumont Villares, padrão desta skill) ou `sh` (Colégio Super
  Humanos).
- **Produto ou categoria**: exemplos "B3, Museu da Bolsa do Brasil", "Florianópolis e Beto Carrero
  World", categoria "Estudos do Meio", categoria "Eletivas". Se houver vários produtos parecidos,
  use `buscar_produtos` e confirme quais entram (pode passar os IDs em `produto_ids`).
- **Ano** ou período: essencial, porque produtos se repetem todo ano. **Se o usuário não informar,
  pergunte antes de continuar.** Ano inteiro = `data_inicio: AAAA-01-01`, `data_fim: AAAA-12-31`.
- **Fonte**: conector (padrão) ou um CSV que o usuário já exportou.

## 2. Obter os dados pelo conector

1. Chame `relatorio_vendas` com `loja`, `data_inicio`, `data_fim` e um filtro: `produto` (trecho
   do nome), `produto_ids` ou `categoria`. Não passe `status`: o padrão já é Concluído, Processando
   e Aguardando.
2. A resposta traz `resumo` (pedidos, itens, receita, por status, por produto), `colunas`,
   `linhas`, `pagina` e `total_paginas`. São até 250 linhas por página: se `total_paginas` > 1,
   chame de novo com `pagina: 2, 3, ...` até a última.
3. Se vier `aviso` de resultado truncado, o período tem pedidos demais: divida (por semestre ou
   trimestre) e junte as partes.
4. Relatórios muito grandes (categoria inteira num ano inteiro) podem estourar o limite do servidor.
   Se a ferramenta der erro de tempo ou limite, reduza o período ou filtre por produto.

O conector já aplica as regras de limpeza:

- Exclui pedidos cancelados, reembolsados e com falha.
- Ignora pedidos de e-mails internos da agência (login@resultzads.com). A quantidade vem em
  `pedidos_internos_ignorados`.
- Cada item de pedido vira uma linha, só com os produtos do filtro.
- Extrai o aluno do e-mail @...g12.br: `primeiro.ultimo@gdv.g12.br` vira `Primeiro Ultimo`. O
  nome de cobrança (coluna Responsável) é do pai/mãe, **não** do aluno.

## 3. Montar a planilha

Salve as respostas do conector num arquivo JSON e rode o script desta skill, que só formata (não
acessa a loja):

- Uma página: salve o objeto da resposta como está.
- Várias páginas: salve uma lista com as respostas, `[resposta_pagina1, resposta_pagina2, ...]`.

```bash
python3 scripts/montar_planilha.py --json vendas.json --output <pasta-de-saida>/relatorio.xlsx
```

**Colunas do relatório final** (nesta ordem, sem Responsável nem ID do produto):

| Coluna | Origem |
|---|---|
| Pedido | número do pedido |
| Data | data do pedido |
| Status | Concluído, Processando ou Aguardando |
| Método de Pagamento | forma de pagamento |
| Email | e-mail de cobrança (o @gdv.g12.br do aluno) |
| Aluno | nome extraído do e-mail |
| Produto | nome do produto |
| Qtde | quantidade do item |
| Valor | total do item, texto com 2 casas decimais (ex.: "180.00") |

Formato: `.xlsx`, aba "Relatório", cabeçalho em negrito, primeira linha congelada, larguras de
coluna ajustadas, ordenado por data.

### Alternativa: CSV exportado

Se o usuário enviar um CSV exportado do WooCommerce, o mesmo script aplica as regras (remove
cancelados/reembolsados/falhos e o e-mail interno, filtra por ano e produto, extrai o aluno):

```bash
python3 scripts/montar_planilha.py --csv pedidos.csv --produto "B3" --ano 2026 \
  --output <pasta-de-saida>/relatorio.xlsx
```

## 4. Entregar

Salve o .xlsx na pasta de saída e forneça o link para download. No chat, informe só o resumo:
pedidos, itens, receita total, quantos por status, quantos por produto e quantos pedidos internos
foram ignorados. Não liste nomes ou e-mails no chat.

## Notas

- Sempre responda em português do Brasil.
- Se o conector disser que a pessoa não tem acesso à loja, ela precisa pedir ao Lucas.
