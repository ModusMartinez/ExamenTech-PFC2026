# Avaliações (019–027)

RF12–RF19 da `Documentacao/FICHA_PFC.docx`: criação, consulta e edição de rascunhos no banco e na API, com formulários para o professor e listagem por turma para professor/admin. Questões têm criação e consulta pela API, formulário de cadastro e listagem por avaliação. Alternativas e gabarito têm banco, API, formulário e consulta por questão objetiva. Publicação tem banco, API, confirmação na interface e listagem das publicadas por turma. Tentativas têm início no banco/API, ordem sorteada persistida e consulta do conteúdo no banco, sem gabarito; tela de execução, respostas e cancelamento ainda pendentes. Não representa os RF12–RF19 completos.

## Dados e regras

`public.avaliacoes`: ID, turma, professor autor, título, tipo, início, fim, duração em minutos, situação e data de criação. A avaliação pertence à turma inteira; não há seleção individual de alunos.

- Tipos: `PROVA` e `ATIVIDADE`. Criação em `RASCUNHO`; a função da `023` altera para `PUBLICADA` e preenche `publicada_em`.
- Título obrigatório, de 3 a 150 caracteres, sem espaços nas pontas. A função remove esses espaços; texto só de espaços em branco é recusado.
- Datas obrigatórias, finitas e com fim posterior ao início, em `TIMESTAMPTZ`. Enviar fuso explícito, por exemplo `2026-11-09T19:00:00-03:00`.
- Duração obrigatória, em minutos inteiros positivos. A janela não precisa estar no futuro para salvar um rascunho. A publicação exige janela ainda não encerrada e duração que caiba no intervalo. A query `025` calcula o prazo da tentativa.
- Autor, ID, situação e data de criação vêm do banco. Organização é obtida pela turma, sem coluna duplicada na avaliação.
- Títulos iguais são permitidos: duas chamadas válidas criam dois rascunhos distintos. Ainda não há idempotência de criação por requisição.

## Acesso

`public.criar_avaliacao_rascunho` → função privada → `avaliacoes` e `eventos_seguranca`, na mesma transação.

```sql
-- Contrato da função; exige sessão autenticada com MFA.
SELECT public.criar_avaliacao_rascunho(
    p_turma_id => 'UUID_DA_TURMA',
    p_titulo => 'Primeira prova',
    p_tipo => 'PROVA',
    p_inicio_em => '2026-11-09T19:00:00-03:00',
    p_fim_em => '2026-11-09T21:00:00-03:00',
    p_duracao_minutos => 60
);
```

- Criação: somente professor responsável, com perfil e organização ativos, sessão existente pertencente ao usuário e MFA `aal2`. Turma precisa estar ativa e na organização atual do professor.
- Consulta: professor autor que continua responsável pela turma, ou ADMIN. Reutiliza RLS de turmas e `pode_consultar_turma`, incluindo sessão/MFA e situação da conta. Aluno não lê rascunhos, mesmo matriculado.
- Turma inativa continua consultável, mas não recebe novos rascunhos nem permite edição. Professor perde a consulta se a organização ficar inativa ou se deixar de ser responsável; ADMIN mantém a consulta institucional.
- Escrita direta e exclusão estão bloqueadas para os perfis da aplicação, inclusive ADMIN. Criação, edição e publicação usam funções controladas. As funções públicas usam `SECURITY INVOKER`; as privadas usam `SECURITY DEFINER`, `search_path` vazio e permissões explícitas.
- `ON DELETE RESTRICT` impede apagar turma/autor referenciados. Não modifica matrículas, contas ou avaliações já existentes ao aplicar a query.
- `AVALIACAO_CRIADA` registra autor, ID da avaliação e horário, sem título, código ou dados dos alunos. Falha na auditoria desfaz o rascunho. O filtro/rótulo desse evento na tela de auditoria ainda está pendente.
- Locks mantêm perfil, organização, sessão e turma estáveis durante a criação. Não há alteração nos helpers ou nas permissões dos módulos anteriores.

Erros SQL: `42501` para perfil/sessão/MFA/permissão; `P0002` para turma inexistente ou fora do acesso; `55000` para turma inativa; `23502` para campo obrigatório e `23514` para regra de campo. UUID, data ou inteiro malformado é recusado pelo PostgreSQL antes da gravação.

## Base 019: aplicação e teste

1. No Supabase de testes com `018` aplicada, executar somente `database/019_avaliacoes_rascunho.sql`. Não reaplicar migrações anteriores. A query cria a estrutura, mas não cria avaliações automaticamente.
2. No terminal, dentro do repositório, executar:

```bash
node --test tests/avaliacoes-sql.test.ts
npm test
npm run lint
npm run build
```

3. Conferir a estrutura pelo SQL Editor:

```sql
SELECT relrowsecurity AS rls_ativa
FROM pg_class WHERE oid = 'public.avaliacoes'::regclass;

SELECT
    has_table_privilege('authenticated', 'public.avaliacoes', 'SELECT') AS consulta,
    has_table_privilege('authenticated', 'public.avaliacoes', 'INSERT') AS escrita_direta,
    has_table_privilege('authenticated', 'public.avaliacoes', 'UPDATE') AS alteracao,
    has_table_privilege('authenticated', 'public.avaliacoes', 'DELETE') AS exclusao;
```

Esperado: RLS e consulta `true`; escrita direta, alteração e exclusão `false`. A consulta continua limitada pela RLS, não é acesso geral aos rascunhos.

O SQL Editor executa como administrador do banco, normalmente sem a sessão do aplicativo. Chamar a função por lá sem contexto autenticado deve falhar; não remover MFA/RLS para fazê-la funcionar. A API e o formulário permitem testar com a sessão do aplicativo.

Os testes executam as funções e políticas reais no PostgreSQL local via PGlite, com Auth e sessões simulados. Cobrem campos, perfis, isolamento, aluno já matriculado, sessão de outro usuário, MFA, bloqueio de escrita, preservação dos eventos e rollback. Não acessam Supabase remoto nem substituem teste com Auth real ou concorrência entre conexões reais.

Referências: [funções e permissões no Supabase](https://supabase.com/docs/guides/database/functions), [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security), [constraints do PostgreSQL](https://www.postgresql.org/docs/current/ddl-constraints.html).

## Edição no banco (020)

Com a `019` já aplicada, executar somente `database/020_editar_avaliacao_rascunho.sql` no SQL Editor. A aplicação da query preserva avaliações e eventos existentes. Não reaplicar as queries anteriores.

`public.editar_avaliacao_rascunho` → função privada → atualização de `avaliacoes` e inserção em `eventos_seguranca`, na mesma transação.

- Recebe ID da avaliação e os cinco campos completos: título, tipo, início, fim e duração. Reutiliza as constraints da criação. Não altera ID, turma, autor, situação ou data de criação.
- Exige professor autor ainda responsável pela turma, perfil/organização/turma ativos, sessão do próprio usuário e MFA `aal2`. ADMIN continua apenas consultando; aluno e outro professor não editam.
- Somente `RASCUNHO` pode ser editado. A função confere a situação após bloquear a linha. Turma inativa permite consulta, mas impede edição.
- Uma alteração efetiva gera `AVALIACAO_EDITADA`, com usuário, avaliação e horário. Não registra o título nem os valores anteriores/novos. Falha no evento desfaz a edição; reenviar os mesmos valores não altera a linha nem duplica o evento. O filtro/rótulo na tela de auditoria ainda está pendente.
- Locks mantêm perfil, organização, sessão e turma estáveis. Edições simultâneas da mesma avaliação aguardam a liberação da linha; a última gravação válida prevalece. Ainda não há controle de versão para detectar formulário desatualizado.

Erros: `42501` para perfil/sessão/MFA; `P0002` para avaliação inexistente ou fora do acesso; `55000` para turma inativa ou avaliação fora de rascunho. Campos continuam usando os erros de constraints da `019`.

### Teste manual da edição

1. Aplicar a `020`, rodar `npm run dev:full` e entrar como professor com MFA.
2. Escolher um rascunho de teste de uma turma ativa própria. Copiar seu ID da tabela `avaliacoes` no Supabase.
3. No console do navegador, no ambiente local, executar o exemplo abaixo com esse ID. A chamada altera o rascunho escolhido usando a sessão atual:

```js
const { supabase: supabaseEdicao } = await import('/src/lib/supabase.ts');
const camposEdicao = {
  p_avaliacao_id: 'UUID_DA_AVALIACAO',
  p_titulo: 'Prova revisada',
  p_tipo: 'PROVA',
  p_inicio_em: '2026-11-09T19:00:00-03:00',
  p_fim_em: '2026-11-09T21:00:00-03:00',
  p_duracao_minutos: 60,
};
const resultadoEdicao = await supabaseEdicao.rpc('editar_avaliacao_rascunho', camposEdicao);
console.log(resultadoEdicao);
```

4. Esperado: `error: null` e os dados atualizados. Em **Turmas → Rascunhos → Atualizar rascunhos**, conferir os novos valores. ID, turma, autor e data de criação permanecem iguais.
5. Conferir `AVALIACAO_EDITADA` em `eventos_seguranca`, com `recurso_id` igual ao ID escolhido. Repetir a chamada com os mesmos valores: nenhum evento adicional. Testar uma duração zero: erro e nenhuma alteração.
6. Recarregar a página ao trocar de conta e repetir como admin, aluno e outro professor: acesso recusado.

Teste automatizado: `node --test tests/avaliacoes-sql.test.ts`. Inclui edição válida, permissões, MFA/sessão, conta/organização/turma inativas, troca de responsável, campos inválidos, preservação do histórico, situação diferente de rascunho, rollback da auditoria e reaplicação da `020`. Usa banco local e Auth simulado; não testa Supabase remoto nem concorrência entre conexões reais.

Referências da edição: [funções e permissões no Supabase](https://supabase.com/docs/guides/database/functions), [bloqueios de linha no PostgreSQL](https://www.postgresql.org/docs/current/explicit-locking.html).

## Questões no banco (021)

Com a `020` já aplicada, executar somente `database/021_questoes_rascunho.sql` no SQL Editor do Supabase de testes. A query preserva avaliações e eventos existentes; não cria questões automaticamente. Não reaplicar as queries anteriores.

`public.questoes` pertence à avaliação, sem banco reutilizável de questões:

| Campo | Regra |
| --- | --- |
| `id` | UUID gerado pelo banco |
| `avaliacao_id` | Avaliação existente; impede excluir a avaliação enquanto houver questões |
| `tipo` | `OBJETIVA` ou `DISSERTATIVA` |
| `enunciado` | Obrigatório, de 3 a 10.000 caracteres; remove espaços nas pontas |
| `pontuacao` | De 0,01 a 9.999,99, com até duas casas decimais |
| `ordem` | Inteiro positivo, automático e único dentro da avaliação |
| `criado_em` | Data e hora geradas pelo banco |

Os limites de texto e pontuação são escolhas desta implementação. A pontuação usa `NUMERIC` sem escala fixa para recusar casas excedentes antes de qualquer arredondamento. A ordem representa a posição no rascunho; a query `026` salva separadamente o sorteio de cada tentativa.

`public.criar_questao_rascunho` → função privada → `questoes` e `eventos_seguranca`, na mesma transação.

- Recebe somente avaliação, tipo, enunciado e pontuação. Professor e organização são verificados pela avaliação e turma, sem colunas duplicadas na questão.
- Criação exige professor autor ainda responsável pela turma, perfil/organização/turma ativos, sessão do próprio usuário e MFA `aal2`. Funciona para Prova e Atividade, somente em `RASCUNHO`.
- Consulta herda a RLS da avaliação: professor autor ainda responsável ou ADMIN, ambos com sessão e MFA. Aluno não lê questões em rascunho, mesmo matriculado. Turma inativa permite consulta, mas impede criação.
- Escrita direta, edição e exclusão ficam bloqueadas para os perfis da aplicação. ADMIN apenas consulta. A `022` acrescenta alternativas e gabarito; uma questão objetiva pode ficar sem alternativas enquanto rascunho.
- A função bloqueia a linha da avaliação antes de conferir sua situação e calcular a próxima ordem. Criações na mesma avaliação são serializadas; a constraint também impede ordem repetida.
- `QUESTAO_CRIADA` registra usuário, ID da questão (`recurso_id`) e horário, sem enunciado ou pontuação. Falha no evento desfaz a questão. O filtro/rótulo desse evento na tela de auditoria fica pendente.
- Repetir uma chamada válida cria outra questão. Em falha de conexão, consultar os registros antes de reenviar.

Erros: `42501` para perfil/sessão/MFA; `P0002` para avaliação inexistente ou fora do acesso; `55000` para turma inativa ou avaliação fora de rascunho; `23502` para campos obrigatórios e `23514` para regras de campos.

### Teste manual das questões

1. Aplicar a `021`, rodar `npm run dev:full` e entrar como professor com MFA.
2. Copiar o ID de uma avaliação em rascunho da própria turma ativa, na tabela `avaliacoes` do Supabase.
3. No console do navegador, no ambiente local, executar uma vez com esse ID. A chamada cria uma questão real no ambiente de testes, usando a sessão atual:

```js
const { supabase: supabaseQuestoes } = await import('/src/lib/supabase.ts');
const avaliacaoQuestoesId = 'UUID_DA_AVALIACAO';
const resultadoQuestao = await supabaseQuestoes.rpc('criar_questao_rascunho', {
  p_avaliacao_id: avaliacaoQuestoesId,
  p_tipo: 'DISSERTATIVA',
  p_enunciado: 'Explique a finalidade de um teste de integração.',
  p_pontuacao: 2.5,
});
console.log(resultadoQuestao);
```

4. Esperado: `error: null`, questão com ID e próxima `ordem`. Conferir `QUESTAO_CRIADA` em `eventos_seguranca`, com `recurso_id` igual ao ID da questão. O cadastro também está disponível em **Turmas → Rascunhos → Nova questão**. Para consultar pela sessão atual:

```js
const consultaQuestoes = await supabaseQuestoes
  .from('questoes')
  .select('id, avaliacao_id, tipo, enunciado, pontuacao, ordem, criado_em')
  .eq('avaliacao_id', avaliacaoQuestoesId)
  .order('ordem');
console.log(consultaQuestoes);
```

5. Repetir a criação com `OBJETIVA`: próximo número de ordem e um novo evento. Pontuação `0`, `2.555` ou enunciado vazio devem falhar sem criar questão nem evento.
6. Recarregar a página ao trocar de conta e executar novamente os trechos com o mesmo ID: ADMIN consulta, mas não cria; aluno e outro professor não criam e recebem lista vazia na consulta.

O SQL Editor não fornece a sessão do professor; chamar a função por ele sem contexto autenticado deve falhar. Não remover MFA/RLS para realizar o teste.

Teste automatizado: `node --test tests/avaliacoes-sql.test.ts`. Cobre tipos, limites, ordem por avaliação, permissões, MFA/sessão, conta/organização/turma inativas, troca de responsável, bloqueio fora de rascunho, escrita direta, rollback da auditoria e reaplicação da query. Executa no PGlite com Auth simulado; não acessa Supabase remoto nem testa concorrência entre conexões reais.

Referências: [funções e permissões no Supabase](https://supabase.com/docs/guides/database/functions), [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security), [tipos numéricos do PostgreSQL](https://www.postgresql.org/docs/current/datatype-numeric.html).

## Alternativas e gabarito no banco (022)

Com a `021` aplicada, executar somente `database/022_alternativas_rascunho.sql` no SQL Editor do Supabase de testes. Preserva questões, avaliações e eventos; não cadastra alternativas automaticamente. Não reaplicar as queries anteriores.

`public.alternativas`: ID, questão, texto, ordem, `correta` e data de criação. O gabarito é a alternativa marcada com `correta = true`; não há tabela adicional ou cópia da pontuação da questão.

- Cadastro em conjunto: de 2 a 5 alternativas, com exatamente uma correta. Ordem definida pela posição na lista, começando em 1.
- Textos distintos após remover espaços nas pontas, de 1 a 2.000 caracteres. Nulos, vazios e textos só de espaços em branco são recusados. Quantidade, limite de texto e resposta única são escolhas deste bloco; a ficha não detalha esses limites.
- Somente questão `OBJETIVA` de avaliação `RASCUNHO`, ainda sem alternativas. Professor autor deve continuar responsável, com perfil/organização/turma ativos, sessão própria e MFA `aal2`.
- Consulta por professor autor e ADMIN, seguindo a RLS da questão/avaliação e limitada a rascunhos. Aluno não consulta alternativas nem gabarito, mesmo matriculado. Turma inativa mantém a consulta, mas impede cadastro.
- A função grava o conjunto e um evento `ALTERNATIVAS_CRIADAS` na mesma transação. `recurso_id` identifica a questão; não registra textos nem resposta correta no evento. Erro em qualquer alternativa ou na auditoria desfaz todo o conjunto.
- Índices impedem ordem repetida e mais de uma correta na mesma questão. A função garante a quantidade mínima e a presença de uma correta. Escrita direta, edição e exclusão estão bloqueadas para os perfis da aplicação.
- Avaliação e questão são bloqueadas durante a gravação. Repetir a chamada, inclusive com os mesmos dados, retorna “A questão já possui alternativas”, sem substituir registros ou gerar outro evento. Em falha de conexão, consultar antes de reenviar.

`public.criar_alternativas_rascunho(p_questao_id, p_alternativas, p_ordem_correta)` → função privada → `alternativas` e `eventos_seguranca`. Retorna a lista gravada, ordenada por `ordem`. Não recebe usuário, IDs das alternativas ou datas.

A edição do conjunto e o filtro/rótulo do evento na tela de auditoria ficam para outros blocos. A validação para publicação está na `023`. Quando houver tentativa do aluno, o servidor deverá fornecer apenas os campos permitidos, sem `correta`; não liberar a tabela inteira nem ocultar o gabarito somente na interface.

Erros: `42501` para perfil/sessão/MFA; `P0002` para questão inexistente ou fora do acesso; `55000` para turma inativa, avaliação fora de rascunho ou questão já preenchida; `23514` para tipo da questão, lista, textos ou posição correta inválidos.

### Teste manual das alternativas

1. Aplicar a `022`, rodar `npm run dev:full` e entrar como professor com MFA.
2. Escolher uma questão objetiva da própria turma ativa, em rascunho e sem alternativas. Copiar o ID da tabela `questoes`. Se necessário, criar uma questão pelo procedimento da `021` acima.
3. Executar no console do navegador local, substituindo o ID. Cria três alternativas reais no ambiente de testes; a segunda será a correta:

```js
const { supabase: supabaseAlternativas } = await import('/src/lib/supabase.ts');
const questaoAlternativasId = 'UUID_DA_QUESTAO';
const resultadoAlternativas = await supabaseAlternativas.rpc('criar_alternativas_rascunho', {
  p_questao_id: questaoAlternativasId,
  p_alternativas: [
    'Verificar somente a aparência da tela.',
    'Verificar a interação entre componentes do sistema.',
    'Substituir todos os testes unitários.',
  ],
  p_ordem_correta: 2,
});
console.log(resultadoAlternativas);
```

4. Esperado: `error: null`, três registros com ordens 1, 2 e 3; apenas a ordem 2 com `correta: true`. Conferir um evento `ALTERNATIVAS_CRIADAS` com `recurso_id` igual ao ID da questão. Consulta pela sessão atual:

```js
const consultaAlternativas = await supabaseAlternativas
  .from('alternativas')
  .select('id, questao_id, texto, ordem, correta, criado_em')
  .eq('questao_id', questaoAlternativasId)
  .order('ordem');
console.log(consultaAlternativas);
```

5. Repetir o cadastro nessa questão: erro, sem outro evento ou alteração. Para testar texto vazio, alternativas repetidas ou posição correta `0`, usar outra questão objetiva ainda sem alternativas. Nenhuma alternativa deve ser gravada nessas tentativas.
6. Recarregar a página ao trocar de conta. Com o mesmo ID, ADMIN consulta mas não cadastra; aluno e outro professor recebem lista vazia na consulta SQL e erro no cadastro. Na interface, abrir **Turmas → Rascunhos → Questões → Alternativas**.

Teste automatizado: `node --test tests/avaliacoes-sql.test.ts`. Cobre limites, gabarito, ordem, perfis, MFA/sessões, organização/turma, autoria, estados fora de rascunho, escrita direta, rollback e reaplicação. PGlite e Auth simulado, sem acesso ao Supabase remoto ou teste de concorrência entre conexões reais.

Referências: [funções e permissões no Supabase](https://supabase.com/docs/guides/database/functions), [índices únicos parciais](https://www.postgresql.org/docs/current/indexes-partial.html), [bloqueios de linha](https://www.postgresql.org/docs/current/explicit-locking.html).

## API de criação e consulta de questões

Requer a `021` já aplicada; nenhuma query nova neste bloco. Rota `api/questoes.ts`, registrada no servidor local e disponível como função da Vercel. Alternativas/gabarito usam a rota própria descrita abaixo; edição de questões fica para outro bloco.

- `POST /api/questoes`: recebe somente `avaliacao_id`, `tipo`, `enunciado` e `pontuacao`. Chama `criar_questao_rascunho` e retorna `201` com `{ questao }`. ID, ordem e data de criação vêm do banco; o evento `QUESTAO_CRIADA` é gravado pela mesma função SQL.
- `GET /api/questoes?avaliacao_id=UUID`: retorna `200` com `{ questoes, limite: 50 }`, nas primeiras 50 posições da avaliação. Sem paginação neste bloco. Avaliação acessível sem questões retorna lista vazia; inexistente, fora do acesso ou fora de rascunho retorna `404`.
- Professor autor cria e consulta; ADMIN apenas consulta. Aluno não acessa, mesmo matriculado. A consulta da avaliação e das questões respeita a RLS. A criação confere novamente autoria, situação da turma/avaliação, organização, sessão e MFA na função SQL.
- Usa chave pública e JWT do usuário. `server/acessoAvaliacoes.ts` compartilha a consulta de identidade por `getUser` e a verificação de perfil ativo entre as APIs de avaliações e questões. As permissões de gravação permanecem em cada rota e no banco.
- `src/services/questaoValidation.ts` valida entrada e resposta: enunciado de 3 a 10.000 caracteres após remover espaços nas pontas; pontuação numérica de 0,01 a 9.999,99, com até duas casas decimais, sem arredondamento. Número em texto é recusado. Datas da resposta são normalizadas para UTC.
- Resposta contém somente `id`, `avaliacao_id`, `tipo`, `enunciado`, `pontuacao`, `ordem` e `criado_em`. Não consulta nem devolve alternativas ou gabarito. Campos extras no POST e parâmetros desconhecidos/repetidos na URL são recusados.
- Respostas usam `Cache-Control: no-store`. Falha ou resposta inválida não confirma gravação nem vira lista vazia. Não repete o POST automaticamente: consultar antes de reenviar, pois a criação pode ter sido concluída. Acima de 50 questões, conferir também a tabela no Supabase.
- O servidor local aceita até 128 KiB no corpo desta rota, para comportar enunciados longos e Unicode escapado em JSON. As demais rotas mantêm o limite local de 16 KiB.

Erros HTTP: `400` campos/consulta inválidos; `401` sessão ausente ou recusada; `403` perfil/MFA não permitido; `404` avaliação inacessível; `405` método não permitido; `409` turma inativa ou avaliação fora de rascunho na criação; `415` conteúdo diferente de JSON; `503` indisponibilidade/resposta inválida. O servidor local retorna `413` quando o corpo excede seu limite. Sessão encerrada ou organização sem acesso também podem resultar em `404` no GET, pela RLS.

### Teste manual da API de questões

1. Rodar `npm run dev:full` com o Supabase de testes e entrar como professor com MFA.
2. Escolher uma avaliação em rascunho da própria turma ativa. Copiar o ID da tabela `avaliacoes`.
3. No console do navegador local, executar uma vez com esse ID. O POST cria uma questão real no ambiente de testes:

```js
const { supabase: supabaseApiQuestoes } = await import('/src/lib/supabase.ts');
const sessaoApiQuestoes = await supabaseApiQuestoes.auth.getSession();
if (sessaoApiQuestoes.error || !sessaoApiQuestoes.data.session) {
  throw new Error('Entre novamente e conclua o MFA.');
}
const headersQuestoes = {
  Authorization: `Bearer ${sessaoApiQuestoes.data.session.access_token}`,
  'Content-Type': 'application/json',
};
const avaliacaoApiQuestoesId = 'UUID_DA_AVALIACAO';
const criacaoQuestao = await fetch('/api/questoes', {
  method: 'POST', headers: headersQuestoes,
  body: JSON.stringify({
    avaliacao_id: avaliacaoApiQuestoesId,
    tipo: 'DISSERTATIVA',
    enunciado: 'Explique a finalidade de um teste de integração.',
    pontuacao: 2.5,
  }),
});
console.log(criacaoQuestao.status, await criacaoQuestao.json());
```

4. Esperado: `201` com a questão gravada. Conferir `QUESTAO_CRIADA` em `eventos_seguranca`. Consultar separadamente, sem repetir o POST:

```js
const consultaApiQuestoes = await fetch(`/api/questoes?avaliacao_id=${avaliacaoApiQuestoesId}`, {
  headers: headersQuestoes,
});
console.log(consultaApiQuestoes.status, await consultaApiQuestoes.json());
```

5. Esperado: `200`, questões ordenadas e nenhum novo evento. Repetir a criação com tipo `OBJETIVA`: novo registro, sem alternativas automáticas. Pontuação `0`, `2.555` ou `"2.5"`, enunciado vazio e campo extra devem retornar `400`, sem gravação.
6. Ao trocar de conta, recarregar a página e obter os cabeçalhos da nova sessão. ADMIN consulta e recebe `403` ao criar; aluno recebe `403` nas duas operações; outro professor recebe `404`. Não compartilhar tokens ou cabeçalhos.

Testes: `node --test tests/questoes-api.test.ts tests/avaliacoes-sql.test.ts`. Executam SQL/RLS no PGlite com Auth/HTTP simulados, cobrindo criação/consulta, isolamento, auditoria, decimais, Unicode, limite/ordem e falhas de resposta/transporte. Não acessam o Supabase remoto. A API de avaliações também é verificada após compartilhar a conferência de acesso.

Referências: [identidade no servidor](https://supabase.com/docs/reference/javascript/auth-getuser), [RPC](https://supabase.com/docs/reference/javascript/rpc), [consulta](https://supabase.com/docs/reference/javascript/select), [Vercel Functions](https://vercel.com/docs/functions/runtimes/node-js).

## API de criação, consulta e edição de avaliações

Requer a `019` para criação/consulta e a `020` para edição, sem nova query neste bloco. Rota registrada no servidor local e no diretório `api` da Vercel. Usa chave pública e `Authorization: Bearer <access_token>` do usuário, nunca chave administrativa. `getUser` valida a identidade; perfil e RLS/função conferem as permissões.

- `POST /api/avaliacoes`: cria pela função `criar_avaliacao_rascunho`. Recebe somente `turma_id`, `titulo`, `tipo`, `inicio_em`, `fim_em`, `duracao_minutos`. Retorna `201` com `{ avaliacao }`, incluindo ID, autor, situação e data de criação definidos pelo banco.
- `GET /api/avaliacoes?turma_id=UUID`: consulta os rascunhos visíveis da turma, por data de criação decrescente e ID decrescente. Retorna `200` com `{ avaliacoes, limite: 50 }`. Ainda sem paginação; não é uma lista completa quando há mais de 50 rascunhos.
- O parâmetro opcional `situacao=PUBLICADA` consulta as publicadas, por data de publicação decrescente e ID decrescente, incluindo `publicada_em`. Aceita somente `RASCUNHO` ou `PUBLICADA`; sem parâmetro mantém a consulta anterior. Mesmas permissões, limite de 50 e validação da resposta.
- `PATCH /api/avaliacoes`: edita pela função `editar_avaliacao_rascunho`. Recebe somente `avaliacao_id`, `titulo`, `tipo`, `inicio_em`, `fim_em`, `duracao_minutos`, todos obrigatórios. Retorna `200` com `{ avaliacao }`, inclusive ao salvar os mesmos valores. Não recebe `turma_id`; turma e autor permanecem os da avaliação.
- Edição exige professor autor ainda responsável pela turma e as regras da `020`. ADMIN e aluno recebem `403`; avaliação inexistente ou de outro professor recebem a mesma resposta `404`. Turma inativa ou avaliação fora de rascunho retornam `409`. Não repete o PATCH automaticamente: em falha, consultar os valores atuais antes de reenviar.
- Professor cria apenas nas próprias turmas. ADMIN consulta, mas não cria. Aluno é recusado mesmo matriculado. Consulta de turma inexistente ou fora do acesso retorna a mesma resposta `404`; turma acessível sem rascunhos retorna lista vazia. Turma inativa permite consulta, mas criação retorna `409`.
- Não recebe professor, organização, situação, data de criação ou aluno no corpo. Campos extras, parâmetros de URL extras/repetidos e JSON inválido são recusados.
- Datas na API usam ISO com segundos e fuso (`Z` ou `±HH:MM`); calendário inválido e fim anterior/igual ao início são recusados. Respostas normalizam datas em UTC com precisão de milissegundos. Minutos devem ser número inteiro positivo dentro do tipo INTEGER do PostgreSQL, não texto.
- O contrato em `src/services/avaliacaoValidation.ts` compartilha a validação de título, tipo, datas e duração entre criação e edição. Resposta inválida não confirma gravação nem vira lista vazia; campos extras do banco não são devolvidos. Todos os retornos usam `Cache-Control: no-store`.
- Não repete o POST automaticamente. Em falha de conexão/resposta, consultar antes de reenviar: a transação pode ter sido concluída, e duas criações válidas geram registros diferentes.
- Erros HTTP: `400` dados/consulta inválidos, `401` token ausente/recusado, `403` perfil/MFA não permitido, `404` turma inacessível, `405` método, `409` turma inativa, `415` conteúdo diferente de JSON e `503` indisponibilidade/resposta inválida. Sessão encerrada recusada pela RLS pode retornar `404` na consulta, sem expor a turma.

### Teste manual da API

Rodar `npm run dev:full` com o Supabase de testes. Entrar como professor e concluir MFA. Para testar a API diretamente, no console do navegador, apenas no ambiente local:

```js
const { supabase } = await import('/src/lib/supabase.ts');
const { data, error } = await supabase.auth.getSession();
if (error || !data.session) throw new Error('Entre novamente e conclua o MFA.');
const headers = {
  Authorization: `Bearer ${data.session.access_token}`,
  'Content-Type': 'application/json',
};
const turmasResponse = await fetch('/api/turmas', { headers });
const { turmas } = await turmasResponse.json();
console.table(turmas.map(({ id, nome }) => ({ id, nome })));
```

Escolher uma turma ativa própria e preencher seu UUID abaixo. O POST cria um rascunho real no ambiente de testes; executar uma vez:

```js
const turmaId = 'UUID_DA_TURMA';
const criacao = await fetch('/api/avaliacoes', {
  method: 'POST', headers,
  body: JSON.stringify({
    turma_id: turmaId, titulo: 'Prova demonstrativa', tipo: 'PROVA',
    inicio_em: '2026-11-09T19:00:00-03:00', fim_em: '2026-11-09T21:00:00-03:00',
    duracao_minutos: 60,
  }),
});
console.log(criacao.status, await criacao.json());
const consulta = await fetch(`/api/avaliacoes?turma_id=${turmaId}`, { headers });
console.log(consulta.status, await consulta.json());
```

Esperado: `201` com `RASCUNHO`, depois `200` contendo o mesmo ID. Conferir `AVALIACAO_CRIADA` no banco; GET não gera evento. Não compartilhar token, sessão, cabeçalhos ou capturas deles. Ao trocar de conta, recarregar a página e obter os cabeçalhos da nova sessão; ADMIN deve consultar e receber `403` ao criar, aluno deve receber `403` nas duas operações e outro professor deve receber `404` para a turma alheia.

`tests/avaliacoes-sql.test.ts` agora também cobre API integrada ao banco local, limite/ordem, métodos, validação, isolamento, auditoria e falhas de Auth/transporte/contrato. Auth e HTTP são simulados; nenhum registro é criado no Supabase remoto pelos testes. Executar `node --test tests/avaliacoes-sql.test.ts`, `npm test`, `npm run lint` e `npm run build`.

Referências da API: [identidade no servidor](https://supabase.com/docs/reference/javascript/auth-getuser), [RPC](https://supabase.com/docs/reference/javascript/rpc), [consulta](https://supabase.com/docs/reference/javascript/select), [Vercel Functions](https://vercel.com/docs/functions/runtimes/node-js).

### Teste manual da API de edição

Com a `020` aplicada, rodar `npm run dev:full` e entrar como professor com MFA. Escolher uma avaliação de teste da própria turma ativa e substituir o ID abaixo. Executar no console do navegador; a chamada altera esse rascunho:

```js
await (async () => {
  const { supabase } = await import('/src/lib/supabase.ts');
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session) throw new Error('Entre novamente e conclua o MFA.');
  const resposta = await fetch('/api/avaliacoes', {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${data.session.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      avaliacao_id: 'UUID_DA_AVALIACAO',
      titulo: 'Atividade revisada pela API', tipo: 'ATIVIDADE',
      inicio_em: '2026-11-09T19:00:00-03:00', fim_em: '2026-11-09T21:00:00-03:00',
      duracao_minutos: 45,
    }),
  });
  console.log(resposta.status, await resposta.json());
})();
```

1. Esperado: `200` com a avaliação atualizada. Conferir em **Turmas → Rascunhos → Atualizar rascunhos** e na tabela `avaliacoes`. ID, turma, autor e data de criação permanecem iguais.
2. Conferir um novo `AVALIACAO_EDITADA` em `eventos_seguranca` quando houver mudança. Repetir os mesmos valores: `200`, sem outro evento.
3. Trocar duração por `0`, remover um campo ou acrescentar `turma_id`: `400`, sem alteração nem evento.
4. Recarregar a página ao trocar de conta e repetir com o mesmo ID: admin/aluno recebem `403`; outro professor recebe `404`. Sem MFA, `403`.

Teste automatizado: `node --test tests/avaliacoes-sql.test.ts`. Cobre o PATCH integrado ao banco local, permissões, normalização, auditoria, repetição sem mudanças, rollback e falhas de Auth/RPC/resposta. Auth e HTTP são simulados; não acessa Supabase remoto.

## Formulário do professor

Painel → **Nova avaliação**. Campos: turma ativa, título, tipo (Prova/Atividade), início, fim e duração em minutos. A consulta existente de turmas já limita o professor às próprias turmas. API e banco continuam responsáveis pela autorização; esconder o botão não substitui essas regras.

`NovaAvaliacaoPanel` → `criarAvaliacaoRascunho` em `src/services/avaliacoes.ts` → `POST /api/avaliacoes` → função SQL da `019`. Sem nova query ou dependência.

- Datas usam o fuso do navegador, informado junto aos campos, e são convertidas para ISO/UTC antes do envio.
- Validação indica e foca o campo inválido. Reutiliza o contrato `lerDadosAvaliacao` antes de enviar.
- Durante o envio, campos e atualização de turmas ficam bloqueados. Um segundo envio simultâneo é ignorado.
- Sucesso somente após `201` com rascunho válido e correspondente aos dados enviados. Limpa o formulário; erros preservam os campos.
- Falha de rede/resposta não repete o POST. Conferir a criação em **Turmas → Rascunhos** antes de reenviar. A tela mostra até 50 registros; a consulta direta ao banco permite conferir registros anteriores a esse limite.

### Teste manual do formulário

1. `npm run dev:full`; entrar como professor e concluir MFA.
2. Abrir **Nova avaliação**, selecionar uma turma ativa própria e criar uma Prova. Repetir com Atividade.
3. Conferir `RASCUNHO` em `avaliacoes` e `AVALIACAO_CRIADA` em `eventos_seguranca`. A avaliação pertence à turma inteira.
4. Tentar título vazio/curto, fim igual ou anterior ao início e duração zero/fracionada. Nenhum registro deve ser criado.
5. Conferir que turma inativa não aparece, professor sem turma ativa não consegue enviar e aluno/administrador não têm esse botão.

Teste automatizado do formulário e serviço: `npm run test:ui -- tests/nova-avaliacao.test.tsx tests/app-cadastro.test.tsx`. Usa respostas simuladas; não grava no Supabase.

Referências do formulário: [inputs no React](https://react.dev/reference/react-dom/components/input), [datas locais e fuso horário](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/input/datetime-local).

## Listagem por turma

Em **Turmas → Rascunhos**, professor consulta as próprias turmas e admin consulta as turmas disponíveis pela RLS. Turmas inativas continuam consultáveis. Aluno não tem acesso à tela nem à API.

`TurmasPanel` → `RascunhosTurmaPanel` → `listarAvaliacoesRascunho` → `GET /api/avaliacoes?turma_id=UUID` → consultas protegidas pela RLS. Sem nova query, dependência ou alteração no backend.

- Tabela com título, tipo, início, fim, duração e situação. Datas no fuso do navegador. No celular, a rolagem horizontal fica dentro da tabela, também acessível por teclado.
- Até 50 rascunhos, na ordem recebida da API (criação mais recente primeiro). Ainda sem paginação.
- Consulta somente ao abrir a turma ou clicar em **Atualizar rascunhos**. Trocar de turma ou fechar o painel ignora respostas atrasadas.
- Resposta inválida ou erro não aparece como lista vazia. Uma falha ao atualizar oculta o resultado anterior.
- A consulta não gera eventos. Professor pode abrir a edição nas turmas ativas; admin e turmas inativas permanecem somente para consulta.

Teste manual: executar `npm run dev:full`, entrar como professor com MFA, abrir **Turmas → Rascunhos** e conferir os registros criados no bloco anterior. Testar **Atualizar rascunhos**, outra turma sem avaliações e uma turma inativa. Repetir como admin e confirmar que aluno não acessa Turmas. Conferir datas/duração e, no celular, rolar a tabela para ler as últimas colunas.

Teste automatizado: `npm run test:ui -- tests/rascunhos-turma.test.tsx`. Cobre consulta por perfil, turma inativa, campos/ordem, lista vazia, atualização, respostas atrasadas, sessão, falhas e validação do contrato. HTTP/Auth simulados, sem acesso ao Supabase remoto.

Referências da listagem: [consultas em efeitos React](https://react.dev/reference/react/useEffect#fetching-data-with-effects), [tabelas HTML acessíveis](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/table).

## Formulário de edição

**Turmas → Rascunhos → Editar**. Disponível ao professor nas turmas ativas retornadas pela API. As regras de autoria, sessão e MFA continuam sendo conferidas no servidor e no banco.

`RascunhosTurmaPanel` → `EditarAvaliacaoForm` → `editarAvaliacaoRascunho` → `PATCH /api/avaliacoes` → função SQL da `020`. Sem nova query ou dependência.

- Campos preenchidos: título, tipo, início, fim e duração. Turma e autor não são editáveis.
- `CamposAvaliacao` e `avaliacaoForm.ts` concentram os campos, mensagens e conversão de datas usados também na criação. Cada formulário mantém sua operação de envio.
- Datas aparecem no fuso do navegador. Se o horário não mudar, o envio preserva o instante original, inclusive segundos existentes no banco.
- Erro de validação foca o campo; erro da API mantém os valores e foca a mensagem. Enquanto salva, campos, cancelamento e outros botões de edição ficam bloqueados. Não há repetição automática da gravação.
- Sucesso atualiza somente a linha correspondente, mantém a ordem e foca a confirmação. Cancelar descarta os valores locais e devolve o foco ao botão Editar.
- Fechar ou trocar de turma ignora uma resposta atrasada na tela; uma gravação já enviada pode concluir no servidor. Consultar novamente antes de reenviar. Ainda não há detecção de alterações simultâneas: vale a última gravação aceita.

Teste manual, com a `020` aplicada e `npm run dev:full`:

1. Entrar como professor com MFA; abrir **Turmas → Rascunhos → Editar** e conferir os valores preenchidos.
2. Alterar título, tipo, datas ou duração e salvar. Conferir a linha, atualizar a lista e verificar `AVALIACAO_EDITADA` no banco quando houver mudança.
3. Alterar um campo e cancelar: a linha permanece igual. Abrir novamente e salvar sem mudanças: nenhum evento adicional.
4. Testar título curto, fim anterior ao início e duração zero. O campo recebe foco e nada é enviado.
5. Conferir que admin e turma inativa não apresentam Editar. Testar teclado e celular, incluindo rolagem horizontal da tabela.

Teste automatizado: `npm run test:ui -- tests/nova-avaliacao.test.tsx tests/rascunhos-turma.test.tsx`. Cobre criação após o reaproveitamento dos campos, preenchimento/edição, cancelamento, perfis, fuso, preservação de segundos, validação, envio duplicado e respostas atrasadas ou inválidas. Usa Auth/HTTP simulados, sem gravar no Supabase.

## Formulário de questões

**Turmas → Rascunhos → Nova questão**, na linha da avaliação. Disponível ao professor nas turmas ativas. ADMIN e turmas inativas não apresentam a ação. API e banco continuam verificando as permissões.

`RascunhosTurmaPanel` → `NovaQuestaoForm` → `criarQuestaoRascunho` em `src/services/questoes.ts` → `POST /api/questoes` → função SQL da `021`. Sem nova query ou dependência.

- A avaliação é a escolhida na tabela. Campos: tipo (Objetiva/Dissertativa), enunciado e pontuação. Vírgula e ponto são aceitos como separador decimal, sem separador de milhar.
- `questaoValidation.ts` compartilha as regras de enunciado e pontuação com o formulário, serviço e API. O limite de 10.000 caracteres conta pontos de código Unicode, como o banco; não usa o corte por unidades UTF-16 do `maxlength` do navegador.
- Erro de campo recebe foco e mensagem associada. Durante o envio, campos e cancelamento ficam bloqueados; um segundo envio simultâneo é ignorado. Edição da avaliação e criação de questão não ficam abertas ao mesmo tempo.
- Sucesso exige `201` e resposta válida correspondente aos dados enviados. Fecha o formulário e foca a confirmação com o número da questão e o título da avaliação. Erros mantêm os campos e focam a mensagem. Cancelar descarta os valores locais e devolve o foco ao botão da avaliação.
- Fechar ou trocar de turma ignora respostas atrasadas na tela. Uma gravação já enviada pode concluir no servidor. Em falha de conexão/resposta, conferir em **Questões** na avaliação antes de reenviar; não há repetição automática.
- Este formulário cria somente a questão. Para cadastrar alternativas e gabarito, abrir **Questões → Alternativas**. A questão objetiva permanece em rascunho sem alternativas até o cadastro delas.

Teste manual, com a `021` aplicada e `npm run dev:full`:

1. Entrar como professor com MFA e abrir **Turmas → Rascunhos → Nova questão** em uma turma ativa.
2. Cadastrar uma questão objetiva e uma dissertativa. Testar pontuação `2,5` e `0.29`.
3. Conferir avaliação, enunciado, tipo, pontuação e ordem na tabela `questoes`, além de `QUESTAO_CRIADA` em `eventos_seguranca`.
4. Testar enunciado vazio/curto e pontuação `0`, `2,555` ou `10000`: erro no campo, sem envio. Preencher e cancelar: nenhum registro criado.
5. Conferir ausência da ação como ADMIN e em turma inativa. Testar teclado, celular e enunciado longo. Alternativas não são criadas por esse formulário.

Teste automatizado: `npm run test:ui -- tests/nova-questao.test.tsx tests/rascunhos-turma.test.tsx`. Cobre os dois tipos, avaliação escolhida, perfis, validação, Unicode, decimais, foco, cancelamento, envio duplo, sessão, falhas e resposta atrasada/inválida. Auth/HTTP simulados, sem gravação no Supabase remoto.

Referências: [textarea no React](https://react.dev/reference/react-dom/components/textarea), [select no React](https://react.dev/reference/react-dom/components/select), [limpeza de efeitos](https://react.dev/reference/react/useEffect#fetching-data-with-effects).

## Listagem de questões por avaliação

**Turmas → Rascunhos → Questões**, na linha da avaliação. Professor responsável e ADMIN podem consultar, inclusive em turma inativa, conforme as permissões da API e do banco.

`RascunhosTurmaPanel` → `QuestoesAvaliacaoPanel` → `listarQuestoesRascunho` em `src/services/questoes.ts` → `GET /api/questoes?avaliacao_id=UUID`. Sem nova query, dependência ou alteração na API.

- Lista ordenada com número, tipo, pontuação e enunciado completo. Preserva quebras de linha e apresenta o conteúdo como texto, sem interpretar HTML.
- Consulta ao abrir e ao clicar em **Atualizar questões**. Uma avaliação aberta por vez; respostas atrasadas são ignoradas ao fechar ou trocar de avaliação/turma.
- Estados de carregamento, erro e lista vazia. Falhas não exibem os registros da consulta anterior nem são tratadas como lista vazia.
- As primeiras 50 questões são exibidas em ordem de cadastro, conforme o limite atual da API. Sem paginação. Questões objetivas apresentam o botão **Alternativas** para cadastro ou consulta do gabarito.
- Abrir criação/edição fecha a lista. Depois de salvar, reabrir **Questões** busca os dados atualizados.

Teste manual com `npm run dev:full`:

1. Como professor, abrir uma avaliação com questões e conferir ordem, tipo, pontuação e enunciados. Testar texto longo e quebras de linha no celular.
2. Trocar para uma avaliação sem questões e conferir a mensagem de lista vazia; voltar e atualizar.
3. Criar uma questão, reabrir **Questões** e confirmar o novo registro (dentro das primeiras 50 posições).
4. Consultar como ADMIN e em turma inativa: a listagem continua disponível, sem ações de criação/edição.

Teste automatizado: `npm run test:ui -- tests/questoes-avaliacao.test.tsx tests/rascunhos-turma.test.tsx tests/nova-questao.test.tsx`. Auth/HTTP simulados. Cobre navegação, perfis, atualização, estados, respostas atrasadas e validação do contrato da API.

Referências: [listas no React](https://react.dev/learn/rendering-lists), [consultas e limpeza de efeitos](https://react.dev/reference/react/useEffect#fetching-data-with-effects).

## API de alternativas e gabarito

Requer a `022` já aplicada. Nenhuma query nova. `api/alternativas.ts` está registrada em `scripts/api-dev.ts`, seguindo o formato das funções da Vercel.

- `POST /api/alternativas`: recebe somente `questao_id`, `alternativas` (lista de textos) e `ordem_correta` (posição de 1 a 5). Retorna `201` com `{ alternativas }`.
- `GET /api/alternativas?questao_id=UUID`: retorna `200` com `{ alternativas }`, ordenadas de 1 a 5. Questão objetiva acessível sem alternativas retorna lista vazia. Questão inexistente, alheia ou fora de rascunho retorna `404`; dissertativa acessível retorna `400`.
- Cada alternativa contém `id`, `questao_id`, `texto`, `ordem`, `correta` e `criado_em`. Exatamente uma tem `correta: true`. Campo restrito ao professor responsável e ADMIN; aluno não acessa esta rota.
- Autenticação: `Authorization: Bearer <access_token>`. Reutiliza `conferirAcessoAvaliacoes`, chave pública e JWT do usuário. RLS e função SQL mantêm as regras de autoria, organização, sessão e MFA.
- Cadastro: professor autor, turma ativa, avaliação em rascunho e questão objetiva ainda sem alternativas. De 2 a 5 textos distintos, com 1 a 2.000 caracteres Unicode após remover espaços nas extremidades. `ordem_correta` deve ser inteiro e apontar para um item da lista. Não aceita campos extras, texto vazio ou caractere nulo.
- Fluxo de gravação: validação → Auth/perfil → `criar_alternativas_rascunho` da `022` → alternativas e `ALTERNATIVAS_CRIADAS` na mesma transação. Repetição retorna `409`, sem sobrescrever. Nenhum reenvio automático de cadastro.
- Respostas sem cache. JSON/entrada inválida: `400`; sessão inválida: `401`; perfil/MFA sem permissão: `403`; recurso fora do acesso: `404`; conflito de estado: `409`; tipo de conteúdo incorreto: `415`; serviço ou resposta inválida: `503`.
- A resposta do banco é validada antes de confirmar: questão correta, IDs únicos, ordem sequencial, textos válidos e exatamente uma correta. No POST, o conjunto também deve corresponder ao enviado. Uma falha após a gravação exige consulta antes de reenviar.

### Teste manual da API

1. Executar `npm run dev:full` e entrar como professor com MFA.
2. Copiar da tabela `questoes` o ID de uma questão objetiva da própria turma ativa, em rascunho e ainda sem alternativas.
3. No console do navegador local, substituir o ID e executar. O POST cria registros no Supabase configurado:

```js
const { supabase: supabaseApiAlt } = await import('/src/lib/supabase.ts');
const { data: authApiAlt } = await supabaseApiAlt.auth.getSession();
const questaoApiAlt = 'COLE_O_ID_DA_QUESTAO';
const headersApiAlt = {
  Authorization: `Bearer ${authApiAlt.session.access_token}`,
  'Content-Type': 'application/json',
};
const cadastroApiAlt = await fetch('/api/alternativas', {
  method: 'POST',
  headers: headersApiAlt,
  body: JSON.stringify({
    questao_id: questaoApiAlt,
    alternativas: ['Testar uma função isolada', 'Testar a comunicação entre componentes', 'Alterar dados em produção'],
    ordem_correta: 2,
  }),
});
console.log(cadastroApiAlt.status, await cadastroApiAlt.json());
const consultaApiAlt = await fetch(`/api/alternativas?questao_id=${questaoApiAlt}`, {
  headers: headersApiAlt, cache: 'no-store',
});
console.log(consultaApiAlt.status, await consultaApiAlt.json());
```

4. Esperado: POST `201`, GET `200`, três alternativas ordenadas e somente a segunda correta. Conferir `ALTERNATIVAS_CRIADAS` em `eventos_seguranca`, com `recurso_id` igual ao ID da questão.
5. Repetir o POST: `409`, sem duplicar alternativas ou evento. Em outra questão, testar texto vazio/repetido ou posição correta `0`: `400`, sem gravação.
6. Ao trocar de conta, recarregar a página e obter a nova sessão. ADMIN consulta e recebe `403` no cadastro; aluno recebe `403`; outro professor recebe `404`, sem gabarito.

Teste automatizado: `node --test tests/alternativas-api.test.ts tests/questoes-api.test.ts`. A preparação do banco em `tests/helpers/bancoAvaliacoes.ts` é compartilhada pelos dois testes. Auth/HTTP são simulados; funções SQL, RLS, constraints e transações executam no PGlite. Inclui rollback quando a auditoria falha. Não acessa Supabase remoto nem testa concorrência entre conexões reais.

Referências: [RPC no Supabase](https://supabase.com/docs/reference/javascript/rpc), [validação de usuário](https://supabase.com/docs/reference/javascript/auth-getuser), [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security).

## Formulário e consulta de alternativas

**Turmas → Rascunhos → Questões → Alternativas**, disponível nas questões objetivas. Professor autor pode cadastrar em turma ativa; ADMIN e professor de turma inativa apenas consultam. API e banco conferem as permissões a cada operação.

`QuestoesAvaliacaoPanel` → `AlternativasQuestaoPanel` → `AlternativasForm` → `src/services/alternativas.ts` → `/api/alternativas` → regras da `022`. Sem nova query ou dependência.

- Ao abrir, consulta as alternativas. Se não houver nenhuma e o professor puder cadastrar, apresenta o formulário com dois campos.
- De 2 a 5 alternativas distintas, até 2.000 caracteres Unicode por texto. Adiciona ao final ou remove a última, mantendo pelo menos duas. Remover a alternativa marcada como correta exige selecionar outra.
- O campo **Alternativa correta** define uma única resposta. `alternativaValidation.ts` compartilha a validação com o formulário, serviço e API.
- Erro de campo recebe foco; falha da API mantém os valores e foca a mensagem. Durante o envio, campos e botões do formulário ficam bloqueados, sem repetição automática do POST.
- Ao salvar, apresenta a lista em ordem A–E e marca a resposta correta. Alternativas existentes são somente consultadas neste bloco. Textos completos, com quebras de linha e sem interpretar HTML.
- **Cancelar** descarta o preenchimento e devolve o foco ao botão da questão. Fechar ou trocar de questão/turma ignora respostas atrasadas na tela; uma gravação já enviada pode concluir no servidor. Em falha de conexão ou confirmação, fechar e reabrir **Alternativas** antes de reenviar.
- Carregamento e falha de consulta não apresentam formulário nem lista antiga. **Atualizar alternativas** refaz a consulta e fica desabilitado durante o preenchimento.

Teste manual, com a `022` aplicada e `npm run dev:full`:

1. Entrar como professor com MFA e abrir uma questão objetiva sem alternativas da própria turma ativa.
2. Preencher duas alternativas distintas, selecionar a correta e salvar. Conferir a lista, fechar e reabrir, verificando que não aparece outro formulário.
3. Em outra questão, cadastrar cinco alternativas. Antes de salvar, testar campo vazio, texto repetido, mais de 2.000 caracteres e ausência de gabarito: erro sem gravação. Testar remoção da última alternativa e cancelamento.
4. Conferir `ALTERNATIVAS_CRIADAS` em `eventos_seguranca`, com `recurso_id` igual ao ID da questão. Nenhuma query adicional é necessária para a interface.
5. Como ADMIN e em turma inativa, conferir consulta sem cadastro. Questões dissertativas não apresentam **Alternativas**. Testar teclado, celular e texto longo.

Teste automatizado: `npm run test:ui -- tests/alternativas-form.test.tsx tests/questoes-avaliacao.test.tsx tests/rascunhos-turma.test.tsx`. Cobre cadastro, consulta, gabarito, limites, cancelamento, perfis, foco, erros, envio duplicado e respostas atrasadas/inválidas. Auth/HTTP simulados, sem gravação no Supabase remoto.

Referências: [textarea no React](https://react.dev/reference/react-dom/components/textarea), [select no React](https://react.dev/reference/react-dom/components/select), [atualização de arrays no estado](https://react.dev/learn/updating-arrays-in-state).

## Publicação no banco e na API (023)

Com a `022` já aplicada, executar somente `database/023_publicar_avaliacao.sql` no Supabase de testes. Preserva os rascunhos e eventos existentes. A interface de publicação usa essa mesma query, sem outra migração ou dependência.

`POST /api/publicar-avaliacao` → Auth/perfil → `public.publicar_avaliacao` → função privada → atualização e auditoria na mesma transação. A rota separa a publicação da edição de campos e está registrada no servidor local.

- Recebe somente `{ "avaliacao_id": "UUID" }`, com `Content-Type: application/json` e `Authorization: Bearer <access_token>`. Reutiliza a chave pública e a sessão do usuário, sem chave administrativa.
- Somente professor autor ainda responsável pela turma, com perfil, organização e turma ativos, sessão própria e MFA `aal2`. ADMIN consulta, mas não publica. Avaliação inexistente e avaliação alheia retornam a mesma resposta.
- Exige `RASCUNHO`, ao menos uma questão e, para cada objetiva, de 2 a 5 alternativas distintas e sequenciais, com exatamente uma correta. Dissertativas não podem ter alternativas. Campos e pontuações positivas continuam protegidos pelas constraints existentes.
- A janela deve terminar depois do horário atual do banco, e a duração deve caber no intervalo entre início e fim. Pode publicar antes do início ou com a janela em andamento. São decisões desta implementação; a query `025` limita o prazo da tentativa ao encerramento da janela.
- Usa o mesmo bloqueio da avaliação que a edição e a criação de questões/alternativas. Depois de publicar, essas funções recusam alterações. Escrita direta permanece sem permissão.
- Define `PUBLICADA` e `publicada_em` e registra `AVALIACAO_PUBLICADA`. Falha na auditoria desfaz a publicação. Repetição retorna `409`, sem novo evento ou alteração de data.
- Sucesso: `200` com `{ avaliacao: { id, situacao: 'PUBLICADA', publicada_em } }`. A API valida a confirmação e não devolve questões ou gabarito. Todas as respostas usam `Cache-Control: no-store`.
- Erros: `400` para entrada ou preparação inválida; `401` para sessão inválida; `403` para perfil/MFA; `404` para avaliação fora do acesso; `409` para turma inativa ou situação diferente de rascunho; `415` para conteúdo não JSON; `503` para indisponibilidade ou confirmação inválida.
- A avaliação publicada deixa a lista de rascunhos e pode ser consultada em **Turmas → Publicadas**. As políticas de questões/alternativas continuam restritas aos rascunhos e não liberam acesso ao aluno.

### Teste manual da publicação

1. Aplicar a `023`, executar `npm run dev:full` e entrar como professor com MFA.
2. Criar uma avaliação de teste da própria turma ativa, com fim no futuro, duração que caiba na janela, questões e gabarito completo. Copiar o ID de `avaliacoes`.
3. No console do navegador local, substituir o ID e executar. Essa chamada publica a avaliação e bloqueia sua edição:

```js
const { supabase: supabasePublicacao } = await import('/src/lib/supabase.ts');
const { data: sessaoPublicacao } = await supabasePublicacao.auth.getSession();
const avaliacaoPublicacaoId = 'COLE_O_ID_DA_AVALIACAO';
const respostaPublicacao = await fetch('/api/publicar-avaliacao', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${sessaoPublicacao.session.access_token}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ avaliacao_id: avaliacaoPublicacaoId }),
});
console.log(respostaPublicacao.status, await respostaPublicacao.json());
const consultaPublicacao = await supabasePublicacao.from('avaliacoes')
  .select('id,situacao,publicada_em').eq('id', avaliacaoPublicacaoId).single();
console.log(consultaPublicacao);
```

4. Esperado: `200`, situação `PUBLICADA`, data preenchida e um evento `AVALIACAO_PUBLICADA` em `eventos_seguranca`, com `recurso_id` igual ao ID da avaliação. Atualizar **Rascunhos**: ela sai dessa lista.
5. Repetir o envio: `409`, sem novo evento. Tentar editar a avaliação pela API anterior ou cadastrar uma questão nela: `409`. A estrutura permanece igual.
6. Em outros rascunhos, testar ausência de questões, objetiva sem alternativas, janela encerrada e duração maior que a janela: `400`, permanecendo em `RASCUNHO` e sem evento de publicação.
7. Ao trocar de conta, recarregar e obter a nova sessão. ADMIN/aluno recebem `403`; outro professor recebe `404`. Sem MFA, publicação recusada. Em falha de conexão, consultar a situação antes de reenviar: não há repetição automática.

Testes: `node --test tests/publicar-avaliacao.test.ts`. Cobrem Prova/Atividade, campos, gabarito, janela, perfis, MFA/sessões, bloqueio de estrutura, rollback, resposta perdida e reaplicação. Usam PGlite com SQL e RLS reais, Auth/HTTP simulados. Não acessam Supabase remoto nem simulam concorrência entre conexões PostgreSQL independentes.

Referências: [funções e permissões no Supabase](https://supabase.com/docs/guides/database/functions), [RPC](https://supabase.com/docs/reference/javascript/rpc), [bloqueios de linha no PostgreSQL](https://www.postgresql.org/docs/current/explicit-locking.html).

## Publicação e consulta na interface

**Turmas → Rascunhos → Publicar**. Disponível ao professor nas turmas ativas; confirmação com o título e aviso do bloqueio da estrutura. ADMIN e professor de turma inativa apenas consultam. A autorização definitiva permanece na API e no banco.

- `PublicarAvaliacaoForm` → `publicarAvaliacao` em `src/services/avaliacoes.ts` → `POST /api/publicar-avaliacao`. Cancelar devolve o foco ao botão sem enviar. Confirmar bloqueia os controles durante o envio, sem repetir o POST.
- Sucesso remove a linha do rascunho, foca a confirmação e atualiza a lista de publicadas caso esteja aberta. Erro mantém o rascunho e foca a mensagem. Fechar ou trocar de turma ignora respostas atrasadas; o servidor pode concluir uma publicação já enviada. Conferir **Publicadas** e atualizar **Rascunhos** antes de reenviar após falha de conexão.
- **Turmas → Publicadas** abre `PublicadasTurmaPanel` → `listarAvaliacoesPublicadas` → `GET /api/avaliacoes?turma_id=UUID&situacao=PUBLICADA`. Exibe título, tipo, início, fim, duração e data da publicação, em horário local. Professor responsável e ADMIN podem consultar, inclusive em turma inativa.
- Consulta ao abrir e ao clicar em **Atualizar publicadas**. Estados de carregamento, erro e vazio; erros não mostram a lista anterior. Tabela com rolagem horizontal e foco por teclado no celular. Até 50 publicações mais recentes, sem paginação neste bloco.
- Listagem somente dos dados da avaliação: sem edição, questões, gabarito ou execução pelo aluno. A consulta não gera evento de auditoria.
- `avaliacaoValidation.ts` compartilha os contratos da confirmação e da avaliação publicada entre API e navegador. As duas listagens reaproveitam autenticação, requisição e validação da coleção, mantendo o contrato de rascunhos. Sem nova dependência.

Teste manual com a `023` aplicada e `npm run dev:full`:

1. Como professor, abrir **Turmas → Rascunhos → Publicar** em uma avaliação completa. Cancelar: nenhuma publicação. Abrir novamente e confirmar.
2. Conferir a mensagem, a saída da lista de rascunhos e a entrada em **Publicadas**. Fechar e reabrir a lista; conferir `PUBLICADA`, `publicada_em` e `AVALIACAO_PUBLICADA` no banco.
3. Publicar um rascunho sem questões ou sem gabarito: mensagem de erro, sem remover a linha. Corrigir o rascunho antes de publicar novamente.
4. Entrar como ADMIN: consultar **Publicadas**, sem botão Publicar nos rascunhos. Conferir também uma turma inativa.
5. Testar título longo, teclado e celular, incluindo a rolagem da tabela. Com **Publicadas** já aberta, publicar outra avaliação e conferir a atualização automática.

Testes de interface: `npm run test:ui -- tests/publicacao-avaliacao.test.tsx tests/rascunhos-turma.test.tsx`. Auth/HTTP simulados. Cobrem confirmação, cancelamento, foco, envio duplicado, perfis, consulta, erros, respostas atrasadas e contratos inválidos.

Teste da consulta no banco/API: `node --test tests/publicar-avaliacao.test.ts`. Inclui filtro por situação, isolamento, turma inativa, lista vazia, limite/ordenação, ausência de gabarito e falhas do serviço.

Referências: [consultas e limpeza de efeitos no React](https://react.dev/reference/react/useEffect#fetching-data-with-effects), [ordenação no Supabase](https://supabase.com/docs/reference/javascript/order).

## Consulta de avaliações pelo aluno (024)

Aplicar `database/024_listar_minhas_avaliacoes.sql` depois da `023`. A interface abaixo usa essa mesma query.

`GET /api/minhas-avaliacoes` → Supabase Auth → `public.listar_minhas_avaliacoes` → função privada. A API usa a chave pública e a sessão do aluno. Sem parâmetros: o banco identifica o aluno pela sessão.

- Exige aluno e organização ativos, sessão própria existente e MFA `aal2`.
- Retorna somente avaliações `PUBLICADA` de turmas ativas da mesma organização, com matrícula `ATIVA` do aluno. Sem matrícula válida, retorna lista vazia.
- Até 50 registros, por publicação mais recente e ID decrescente no desempate. Inclui avaliações futuras, em andamento e encerradas; aparecer na lista não autoriza iniciar uma tentativa.
- Resposta `{ avaliacoes: [...] }`: ID, turma, nome da turma, título, tipo, início, fim, duração, situação e data da publicação. Não retorna questões, alternativas, gabarito ou dados de outros alunos.
- Mantém as políticas existentes das tabelas. A função confere os vínculos antes de retornar os campos permitidos; consulta direta de avaliações, questões e alternativas continua bloqueada para o aluno.
- Erros: `400` para parâmetros, `401` para sessão inválida, `403` para perfil/MFA, `405` para método diferente de GET e `503` para falha de serviço ou resposta inválida. Respostas sem cache. A consulta não altera dados nem cria evento de auditoria.

Teste manual com `npm run dev:full`:

1. Aplicar a `024` no Supabase de testes. Como professor, publicar uma avaliação em turma ativa com aluno matriculado.
2. Entrar como esse aluno, concluir o MFA e executar no console do navegador local:

```js
const { supabase: supabaseAluno } = await import('/src/lib/supabase.ts');
const { data: sessaoAluno } = await supabaseAluno.auth.getSession();
const respostaAluno = await fetch('/api/minhas-avaliacoes', {
  headers: { Authorization: `Bearer ${sessaoAluno.session.access_token}` },
  cache: 'no-store',
});
console.log(respostaAluno.status, await respostaAluno.json());
```

3. Esperado: `200` com a avaliação, sem questões/gabarito. Rascunhos e avaliações de turmas sem matrícula ativa não aparecem.
4. Como professor/admin, inativar a matrícula de teste pela tela. Entrar novamente como aluno e repetir a consulta: a avaliação dessa turma não aparece.
5. A mesma chamada como professor ou ADMIN retorna `403`; sem autenticação, `401`.

Teste automatizado: `node --test tests/minhas-avaliacoes.test.ts`. Executa permissões e RLS no PostgreSQL local (PGlite), com Auth/HTTP simulados. Cobre isolamento entre alunos e organizações, matrículas/sessões, MFA, dados restritos, ordenação/limite e falhas. Não acessa o Supabase remoto.

Referências: [funções e permissões no Supabase](https://supabase.com/docs/guides/database/functions), [verificação de usuário](https://supabase.com/docs/reference/javascript/auth-getuser), [chamada RPC](https://supabase.com/docs/reference/javascript/rpc).

## Minhas avaliações no painel do aluno

**Minhas avaliações** aparece somente para Aluno. Lista título, turma, tipo, início, fim e duração. Horários no fuso do navegador, indicado acima da tabela. Mantém a ordem e o limite de 50 publicações definidos pela API.

`App` → `MinhasAvaliacoesPanel` → `listarMinhasAvaliacoes` em `src/services/avaliacoes.ts` → `GET /api/minhas-avaliacoes` → query `024`.

- Reutiliza o contrato `AvaliacaoAluno`, a validação `lerMinhasAvaliacoes` e os estilos de tabela existentes. Sem dependências ou query adicionais.
- **Atualizar** consulta novamente e fica desabilitado durante o carregamento. Carregamento, vazio e erro têm mensagens próprias; falha oculta a lista anterior. Resposta atrasada de uma tela fechada é ignorada.
- Foco no título ao abrir; tabela com cabeçalhos e rolagem horizontal acessível por teclado no celular. Textos longos quebram linha, sem interpretar HTML.
- Este bloco permite consultar as avaliações. O botão de início, respostas e resultados continuam pendentes. Os links legais permanecem no rodapé.

Teste manual com a `024` aplicada e `npm run dev:full`:

1. Entrar como aluno com MFA e matrícula ativa em uma turma com avaliação publicada. Abrir **Minhas avaliações** e conferir os campos.
2. Publicar outra avaliação como professor; no aluno, clicar em **Atualizar** e conferir sua inclusão. Rascunhos não aparecem.
3. Sem avaliações acessíveis, conferir a mensagem de lista vazia. Inativar uma matrícula de teste pelo professor/admin e atualizar a lista do aluno: avaliações dessa turma deixam de aparecer.
4. Conferir celular, título longo, navegação por teclado, rolagem da tabela e links legais. Professor e ADMIN não apresentam o botão **Minhas avaliações**.
5. Interromper a API local e clicar em **Atualizar**: exibe erro sem a lista antiga. Reiniciar a API e atualizar novamente.

Testes: `npm run test:ui -- tests/minhas-avaliacoes-panel.test.tsx tests/app-cadastro.test.tsx tests/minhas-matriculas.test.tsx`. Usam o serviço real do frontend com sessão e HTTP simulados; cobrem consulta, atualização, perfis, foco, respostas inválidas/atrasadas e estados da tela. Conferência visual em desktop e celular com dados fictícios, sem acesso ao Supabase remoto.

Referência: [consultas e limpeza de efeitos no React](https://react.dev/reference/react/useEffect#fetching-data-with-effects).

## Início da tentativa no banco (025)

Aplicar `database/025_iniciar_tentativa.sql` depois da `024`. Cria `tentativas` e a função `public.iniciar_tentativa(p_avaliacao_id)`, usada pela API descrita abaixo. O botão na interface ainda está pendente.

- Tabela: `id`, `avaliacao_id`, `aluno_id`, `situacao`, `iniciada_em` e `limite_em`. A situação inicial é `EM_ANDAMENTO`; finalização e cancelamento serão adicionados em etapas próprias.
- Exige aluno e organização ativos, sessão própria existente, MFA `aal2`, turma da mesma organização e matrícula `ATIVA`.
- Avaliação deve estar `PUBLICADA`, em turma ativa. Horário permitido: início inclusivo e fim exclusivo, conferidos pelo relógio do banco após possíveis esperas por bloqueios.
- `limite_em` recebe o menor valor entre `iniciada_em + duração` e o fim da janela. O navegador não informa aluno, situação ou horários.
- A constraint única `(avaliacao_id, aluno_id)` impede uma segunda tentativa. `INSERT ... ON CONFLICT DO NOTHING` resolve a disputa pela mesma combinação; repetição é recusada, sem retomar ou reiniciar a tentativa existente.
- Bloqueios de leitura preservam perfil, organização, sessão, turma, matrícula e avaliação durante o início. A função não bloqueia exclusivamente a avaliação inteira para todos os alunos.
- Registra `TENTATIVA_INICIADA`, com `usuario_id` do aluno e `recurso_id` da tentativa. Tentativa e evento são atômicos: falha na auditoria desfaz ambos.
- A lista de eventos também aceita `RESPOSTA_SALVA`, `TENTATIVA_FINALIZADA` e `TENTATIVA_RETOMADA`, encontrados no histórico do Supabase. Isso preserva os registros ao aplicar a `025`; não implementa esses fluxos nem permite retomar tentativas. Se a versão anterior falhou com `eventos_seguranca_evento_valido`, copiar e executar a `025` atualizada inteira antes da `026`.
- RLS permite consultar os metadados da própria tentativa, do professor autor ainda responsável pela turma e do ADMIN, reutilizando as regras de sessão/MFA dos helpers existentes. Matrícula inativa preserva essa consulta histórica, mas impede novo início. Mudança de organização retira o acesso do aluno ao histórico da organização anterior.
- Escrita direta e exclusão pela aplicação continuam bloqueadas. Não libera questões, alternativas ou gabarito.

Sucesso retorna os seis campos da tentativa. Erros SQL: `42501` para perfil/sessão/MFA, `P0002` para avaliação inexistente ou sem vínculo autorizado, `55000` para turma/situação/horário indisponível ou tentativa já existente.

Teste manual no Supabase de testes:

1. Aplicar a `025`. Criar e publicar uma avaliação específica para teste, com janela em andamento, e aprovar a matrícula do aluno. O teste consome a tentativa única dessa avaliação.
2. Entrar como aluno com MFA em `npm run dev:full`. No console do navegador, substituir o UUID e executar:

```js
const { supabase: supabaseTentativa } = await import('/src/lib/supabase.ts');
const resultadoTentativa = await supabaseTentativa.rpc('iniciar_tentativa', {
  p_avaliacao_id: 'UUID_DA_AVALIACAO_DE_TESTE',
});
console.log(resultadoTentativa.data, resultadoTentativa.error);
```

3. Conferir os horários retornados, a linha em `tentativas` e o evento `TENTATIVA_INICIADA` em `eventos_seguranca`. Repetir a chamada: erro `55000`, sem segunda linha/evento ou mudança do prazo.
4. Em outra avaliação de teste, conferir a recusa antes do início, sem matrícula ativa, como professor/admin ou sem MFA. Para conferir prazo reduzido, usar avaliação cuja janela já esteja em andamento e termine antes da duração completa a partir de agora.

Teste automatizado: `node --test tests/tentativas-sql.test.ts`. Executa funções, constraints, RLS e rollback no PostgreSQL local (PGlite), com identidades fictícias. PGlite serializa transações; chamadas enfileiradas e unicidade são testadas, mas não conexões simultâneas reais do Supabase. Nenhuma consulta ou gravação remota é feita pelos testes.

Pendentes neste fluxo: interface de início, API e tela do conteúdo da tentativa, respostas, encerramento, controle de saída/desconexão e captura inicial. A criação do registro ainda não representa uma prova executável; ultrapassar `limite_em` não altera a situação automaticamente neste bloco.

Referências: [unicidade no PostgreSQL](https://www.postgresql.org/docs/current/ddl-constraints.html#DDL-CONSTRAINTS-UNIQUE-CONSTRAINTS), [bloqueios de linhas](https://www.postgresql.org/docs/current/explicit-locking.html#LOCKING-ROWS), [funções e permissões no Supabase](https://supabase.com/docs/guides/database/functions).

## API de início da tentativa

`POST /api/iniciar-tentativa` → verificação no Supabase Auth → `public.iniciar_tentativa` → regras e auditoria da query `025`. Mantém o padrão de rotas separadas de `/api/publicar-avaliacao`, registrado também em `scripts/api-dev.ts`. Sem nova query ou dependência.

- Recebe somente `{ "avaliacao_id": "UUID" }`, com `Content-Type: application/json` e `Authorization: Bearer <access_token>`. Recusa parâmetros na URL e campos extras, inclusive aluno, situação e horários.
- Confirma a identidade com `auth.getUser` e chama a função com a chave pública e o token do usuário. As permissões de aluno, MFA e vínculo continuam no banco, inclusive para chamadas diretas à função.
- Sucesso: `201` com `{ tentativa: { id, avaliacao_id, aluno_id, situacao, iniciada_em, limite_em } }`. A API confere o aluno autenticado, a avaliação solicitada, os IDs, a situação e os horários antes de confirmar. `tentativaValidation.ts` concentra o contrato e reaproveita a validação de UUID e datas do projeto. Campos extras não são devolvidos.
- Erros: `400` entrada inválida; `401` sessão inválida; `403` perfil/MFA/sessão sem permissão; `404` avaliação inexistente ou sem acesso; `409` avaliação indisponível para início ou tentativa existente; `415` conteúdo diferente de JSON; `405` método diferente de POST; `503` falha de serviço ou confirmação inválida.
- Respostas usam `Cache-Control: no-store`. Erros internos do Supabase não são enviados ao navegador. Falha ao confirmar o início pode ocorrer depois da gravação; a API não repete a RPC automaticamente nem apaga ou reinicia a tentativa.

Teste manual com a `025` aplicada e `npm run dev:full`:

1. Publicar uma avaliação de teste com janela em andamento. Entrar como aluno com MFA e matrícula ativa. A avaliação não pode ter tentativa anterior desse aluno.
2. No console do navegador, substituir o UUID e executar uma vez. A chamada consome a tentativa única:

```js
const { supabase: supabaseInicio } = await import('/src/lib/supabase.ts');
const { data: sessaoInicio } = await supabaseInicio.auth.getSession();
const respostaInicio = await fetch('/api/iniciar-tentativa', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${sessaoInicio.session.access_token}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ avaliacao_id: 'UUID_DA_AVALIACAO_DE_TESTE' }),
});
console.log(respostaInicio.status, await respostaInicio.json());
```

3. Conferir `201`, os dados retornados, a linha em `tentativas` e `TENTATIVA_INICIADA` em `eventos_seguranca`. Repetir a chamada: `409`, sem novo registro ou alteração de prazo.
4. Como professor/admin, esperar `403`. Sem matrícula ativa, `404`. Em outra avaliação futura ou encerrada, `409`. Campos extras no corpo devem retornar `400`.

Testes: `node --test tests/iniciar-tentativa.test.ts tests/tentativas-sql.test.ts`. Auth/HTTP simulados e SQL executado no PGlite. Incluem a perda de resposta depois de gravar, sem repetição automática, sem acesso ao Supabase remoto.

Referências: [verificação da identidade](https://supabase.com/docs/reference/javascript/auth-getuser), [chamada RPC](https://supabase.com/docs/reference/javascript/rpc).

## Ordem sorteada da tentativa (026)

Aplicar `database/026_ordem_tentativa.sql` depois da `025`. Atende a parte de sorteio dos RF17–RF19: a chamada existente de início passa a salvar a ordem de todas as questões e das alternativas de cada questão objetiva.

- `tentativa_questoes`: tentativa, questão e posição sorteada.
- `tentativa_alternativas`: tentativa, questão, alternativa e posição sorteada dentro da questão. Dissertativas não recebem alternativas.
- O trigger `tentativas_sortear_ordem` chama `examentech_private.sortear_ordem_tentativa` após criar a tentativa. Sorteio, tentativa e auditoria pertencem à mesma transação; qualquer falha desfaz a operação.
- Guarda IDs e posições, sem copiar textos ou `correta`. A estrutura publicada já fica bloqueada para edição pela aplicação; a ordem original do professor permanece intacta.
- O sorteio acontece uma vez. Repetir o início continua recusado, sem mudar a ordem. Sorteios de alunos diferentes podem coincidir por acaso.
- Tentativas anteriores à `026` continuam sem ordem salva. Não são preenchidas, reabertas ou reiniciadas. Para validar este bloco, criar uma avaliação nova de teste.
- RLS ativada e acesso direto bloqueado para `anon` e `authenticated`, inclusive professor/admin pela aplicação. A API de início continua retornando apenas os seis metadados. A query `027` consulta o conteúdo sem liberar acesso direto a essas tabelas.

Teste manual no Supabase de testes:

1. Aplicar a `026` e publicar uma avaliação nova, com janela em andamento, questões objetivas com alternativas e uma dissertativa.
2. Como aluno com MFA e matrícula ativa, executar a chamada de `/api/iniciar-tentativa` da seção anterior. Esperado: `201`. Copiar o ID da tentativa.
3. No SQL Editor do Supabase, executar:

```sql
SELECT tq.tentativa_id, tq.ordem AS ordem_questao, tq.questao_id,
       ta.ordem AS ordem_alternativa, ta.alternativa_id
FROM public.tentativa_questoes tq
LEFT JOIN public.tentativa_alternativas ta
  ON ta.tentativa_id = tq.tentativa_id AND ta.questao_id = tq.questao_id
WHERE tq.tentativa_id = 'UUID_DA_TENTATIVA'
ORDER BY tq.ordem, ta.ordem;
```

4. Conferir todas as questões, posições consecutivas a partir de `1` e alternativas vinculadas à questão correspondente. Na dissertativa, os campos da alternativa ficam nulos. A consulta repete a questão em cada alternativa.
5. Repetir o início: `409`. Consultar novamente: mesma ordem e um único evento `TENTATIVA_INICIADA`. Outro aluno matriculado recebe sua própria tentativa, sem alterar a primeira.

Testes: `node --test tests/ordem-tentativa.test.ts tests/iniciar-tentativa.test.ts tests/tentativas-sql.test.ts`. Cobrem persistência, vínculos, permissões, repetição, preservação de registros antigos e rollback. PostgreSQL local via PGlite, Auth/HTTP simulados, sem acesso ao Supabase remoto. Sem nova dependência ou alteração visual.

Referências: [funções de janela](https://www.postgresql.org/docs/current/functions-window.html), [random e setseed](https://www.postgresql.org/docs/current/functions-math.html#FUNCTIONS-MATH-RANDOM-TABLE), [transações e triggers](https://www.postgresql.org/docs/current/trigger-definition.html).

## Consulta do conteúdo da tentativa (027)

Aplicar `database/027_consultar_conteudo_tentativa.sql` depois da `026`. Cria `public.consultar_conteudo_tentativa(p_tentativa_id)`, que chama a função privada com as regras de acesso. Sem nova tabela, rota da aplicação ou alteração visual.

- Exige aluno dono da tentativa, perfil e organização ativos, sessão própria existente e MFA `aal2`.
- Revalida matrícula `ATIVA`, organização da turma, turma ativa, avaliação `PUBLICADA` e tentativa `EM_ANDAMENTO`. Professor/admin não usam essa função de execução; a consulta histórica de metadados da `025` permanece separada.
- Confere o relógio do banco após obter os bloqueios de leitura: início inclusivo e fim exclusivo, respeitando tanto `limite_em` quanto a janela da avaliação. Prazo vencido bloqueia o conteúdo, mas ainda não muda a situação da tentativa.
- Retorna `tentativa_id`, `avaliacao_id`, `titulo`, `tipo`, `iniciada_em`, `limite_em` e `questoes`.
- Cada questão contém somente `id`, `tipo`, `enunciado`, `pontuacao`, `ordem` e `alternativas`. Cada alternativa contém somente `id`, `texto` e `ordem`. Dissertativas retornam `alternativas: []`.
- As listas usam as posições da `026`. Não retornam `correta`, ordem original do professor ou colunas internas. Nenhum novo sorteio, registro ou evento é gerado pela consulta.
- Tentativas antigas sem ordem salva são recusadas, sem preenchimento ou reinício automático.
- Erros SQL: `42501` para perfil/sessão/MFA sem permissão; `P0002` para tentativa inexistente, alheia ou sem vínculo ativo na organização; `55000` para situação, horário ou conteúdo indisponível.

Teste manual com `npm run dev:full`:

1. Aplicar a `027`. Entrar como aluno com MFA e matrícula ativa. Usar uma tentativa iniciada depois da `026`, ainda dentro do prazo, com questões objetivas e dissertativas. Se as tentativas de teste venceram, criar e publicar uma avaliação nova.
2. No console do navegador, substituir o ID e executar:

```js
const { supabase: supabaseConteudo } = await import('/src/lib/supabase.ts');
const resultadoConteudo = await supabaseConteudo.rpc('consultar_conteudo_tentativa', {
  p_tentativa_id: 'UUID_DA_TENTATIVA',
});
console.log(resultadoConteudo.data, resultadoConteudo.error);
```

3. Conferir os textos, pontuações e posições com a consulta do SQL Editor da seção `026`. Verificar a ausência de `correta` e a lista vazia de alternativas na dissertativa. Repetir: mesma ordem, horários e quantidade de eventos.
4. Outro aluno recebe `P0002`; professor/admin recebem `42501`. Inativar a matrícula pelo fluxo existente impede a consulta. Depois de vencer o prazo, esperar `55000`. A validação deve ser feita com a sessão do aluno no navegador, não como administrador do banco no SQL Editor.

Testes: `node --test tests/conteudo-tentativa.test.ts tests/ordem-tentativa.test.ts tests/tentativas-sql.test.ts tests/iniciar-tentativa.test.ts`. PostgreSQL local via PGlite, sem acesso remoto. Cobrem retorno permitido, ordem persistida, isolamento, MFA/sessão, vínculos, horários, preservação dos registros e acesso direto bloqueado.

**Situação dos RF17–RF19:** ainda parciais. A base de início, sorteio e consulta está pronta no banco. Faltam API de conteúdo, interface de realização e salvamento das respostas objetivas/dissertativas. A execução também precisará vincular a tentativa à sessão inicial e encerrar o acesso por saída/desconexão, conforme a ficha; esta consulta valida a sessão atual, mas não detecta esses eventos. Finalização e cancelamento serão tratados nos blocos próprios.

Referências: [funções e permissões no Supabase](https://supabase.com/docs/guides/database/functions), [agregação com ordem no PostgreSQL](https://www.postgresql.org/docs/current/functions-aggregate.html), [construção explícita de JSON](https://www.postgresql.org/docs/current/functions-json.html).
