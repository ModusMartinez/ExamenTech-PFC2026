# Avaliações em rascunho (019–020)

RF12–RF16 da `Documentacao/FICHA_PFC.docx`: criação, consulta e edição de rascunhos no banco e na API, com formulário de criação para o professor e listagem por turma para professor/admin. O formulário de edição fica para o próximo bloco. Sem questões, publicação, cancelamento ou tentativas. Não representa os RF12–RF16 completos.

## Dados e regras

`public.avaliacoes`: ID, turma, professor autor, título, tipo, início, fim, duração em minutos, situação e data de criação. A avaliação pertence à turma inteira; não há seleção individual de alunos.

- Tipos: `PROVA` e `ATIVIDADE`. Situação permitida neste bloco: somente `RASCUNHO`.
- Título obrigatório, de 3 a 150 caracteres, sem espaços nas pontas. A função remove esses espaços; texto só de espaços em branco é recusado.
- Datas obrigatórias, finitas e com fim posterior ao início, em `TIMESTAMPTZ`. Enviar fuso explícito, por exemplo `2026-11-09T19:00:00-03:00`.
- Duração obrigatória, em minutos inteiros positivos. A janela não precisa estar no futuro para salvar um rascunho. Validação para publicação e cálculo do tempo da tentativa ficam para os próximos blocos.
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
- Escrita direta, exclusão e publicação estão bloqueadas para os perfis da aplicação, inclusive ADMIN. Criação e edição usam funções controladas. As funções públicas usam `SECURITY INVOKER`; as privadas usam `SECURITY DEFINER`, `search_path` vazio e permissões explícitas.
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
6. Recarregar a página ao trocar de conta e repetir como admin, aluno e outro professor: acesso recusado. A tela ainda não tem botão de edição.

Teste automatizado: `node --test tests/avaliacoes-sql.test.ts`. Inclui edição válida, permissões, MFA/sessão, conta/organização/turma inativas, troca de responsável, campos inválidos, preservação do histórico, situação diferente de rascunho, rollback da auditoria e reaplicação da `020`. Usa banco local e Auth simulado; não testa Supabase remoto nem concorrência entre conexões reais.

Referências da edição: [funções e permissões no Supabase](https://supabase.com/docs/guides/database/functions), [bloqueios de linha no PostgreSQL](https://www.postgresql.org/docs/current/explicit-locking.html).

## API de criação, consulta e edição

Requer a `019` para criação/consulta e a `020` para edição, sem nova query neste bloco. Rota registrada no servidor local e no diretório `api` da Vercel. Usa chave pública e `Authorization: Bearer <access_token>` do usuário, nunca chave administrativa. `getUser` valida a identidade; perfil e RLS/função conferem as permissões.

- `POST /api/avaliacoes`: cria pela função `criar_avaliacao_rascunho`. Recebe somente `turma_id`, `titulo`, `tipo`, `inicio_em`, `fim_em`, `duracao_minutos`. Retorna `201` com `{ avaliacao }`, incluindo ID, autor, situação e data de criação definidos pelo banco.
- `GET /api/avaliacoes?turma_id=UUID`: consulta os rascunhos visíveis da turma, por data de criação decrescente e ID decrescente. Retorna `200` com `{ avaliacoes, limite: 50 }`. Ainda sem paginação; não é uma lista completa quando há mais de 50 rascunhos.
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

Teste automatizado: `node --test tests/avaliacoes-sql.test.ts`. Cobre o PATCH integrado ao banco local, permissões, normalização, auditoria, repetição sem mudanças, rollback e falhas de Auth/RPC/resposta. Auth e HTTP são simulados; não acessa Supabase remoto. A tela de edição fica para o próximo bloco.

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
- Apenas leitura: não publica, edita, exclui ou gera novos eventos de auditoria.

Teste manual: executar `npm run dev:full`, entrar como professor com MFA, abrir **Turmas → Rascunhos** e conferir os registros criados no bloco anterior. Testar **Atualizar rascunhos**, outra turma sem avaliações e uma turma inativa. Repetir como admin e confirmar que aluno não acessa Turmas. Conferir datas/duração e, no celular, rolar a tabela para ler as últimas colunas.

Teste automatizado: `npm run test:ui -- tests/rascunhos-turma.test.tsx`. Cobre consulta por perfil, turma inativa, campos/ordem, lista vazia, atualização, respostas atrasadas, sessão, falhas e validação do contrato. HTTP/Auth simulados, sem acesso ao Supabase remoto.

Referências da listagem: [consultas em efeitos React](https://react.dev/reference/react/useEffect#fetching-data-with-effects), [tabelas HTML acessíveis](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/table).
