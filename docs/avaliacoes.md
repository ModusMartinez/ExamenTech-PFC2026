# Avaliações em rascunho (019)

RF12–RF16 da `Documentacao/FICHA_PFC.docx`: criação e consulta de rascunhos no banco e na API. Sem telas, edição, questões, publicação, cancelamento ou tentativas. Não representa os RF12–RF16 completos.

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
- Turma inativa continua consultável, mas não recebe novos rascunhos. Professor perde a consulta se a organização ficar inativa ou se deixar de ser responsável; ADMIN mantém a consulta institucional.
- Escrita direta, edição, exclusão e publicação estão bloqueadas para os perfis da aplicação, inclusive ADMIN. Somente a função controlada cria registros. A função pública usa `SECURITY INVOKER`; a privada usa `SECURITY DEFINER`, `search_path` vazio e permissões explícitas.
- `ON DELETE RESTRICT` impede apagar turma/autor referenciados. Não modifica matrículas, contas ou avaliações já existentes ao aplicar a query.
- `AVALIACAO_CRIADA` registra autor, ID da avaliação e horário, sem título, código ou dados dos alunos. Falha na auditoria desfaz o rascunho. O filtro/rótulo desse evento na tela fica para a integração; não há mudança de interface neste bloco.
- Locks mantêm perfil, organização, sessão e turma estáveis durante a criação. Não há alteração nos helpers ou nas permissões dos módulos anteriores.

Erros SQL: `42501` para perfil/sessão/MFA/permissão; `P0002` para turma inexistente ou fora do acesso; `55000` para turma inativa; `23502` para campo obrigatório e `23514` para regra de campo. UUID, data ou inteiro malformado é recusado pelo PostgreSQL antes da gravação.

## Aplicação e teste

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

O SQL Editor executa como administrador do banco, normalmente sem a sessão do aplicativo. Chamar a função por lá sem contexto autenticado deve falhar; não remover MFA/RLS para fazê-la funcionar. A API abaixo permite testar com a sessão do aplicativo; o formulário fica para o próximo bloco.

Os testes executam as funções e políticas reais no PostgreSQL local via PGlite, com Auth e sessões simulados. Cobrem campos, perfis, isolamento, aluno já matriculado, sessão de outro usuário, MFA, bloqueio de escrita, preservação dos eventos e rollback. Não acessam Supabase remoto nem substituem teste com Auth real ou concorrência entre conexões reais.

Referências: [funções e permissões no Supabase](https://supabase.com/docs/guides/database/functions), [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security), [constraints do PostgreSQL](https://www.postgresql.org/docs/current/ddl-constraints.html).

## API de criação e consulta

Sem nova query: requer a `019` já aplicada. Rota registrada no servidor local e no diretório `api` da Vercel. Usa chave pública e `Authorization: Bearer <access_token>` do usuário, nunca chave administrativa. `getUser` valida a identidade; perfil e RLS/função conferem as permissões.

- `POST /api/avaliacoes`: cria pela função `criar_avaliacao_rascunho`. Recebe somente `turma_id`, `titulo`, `tipo`, `inicio_em`, `fim_em`, `duracao_minutos`. Retorna `201` com `{ avaliacao }`, incluindo ID, autor, situação e data de criação definidos pelo banco.
- `GET /api/avaliacoes?turma_id=UUID`: consulta os rascunhos visíveis da turma, por data de criação decrescente e ID decrescente. Retorna `200` com `{ avaliacoes, limite: 50 }`. Ainda sem paginação; não é uma lista completa quando há mais de 50 rascunhos.
- Professor cria apenas nas próprias turmas. ADMIN consulta, mas não cria. Aluno é recusado mesmo matriculado. Consulta de turma inexistente ou fora do acesso retorna a mesma resposta `404`; turma acessível sem rascunhos retorna lista vazia. Turma inativa permite consulta, mas criação retorna `409`.
- Não recebe professor, organização, situação, data de criação ou aluno no corpo. Campos extras, parâmetros de URL extras/repetidos e JSON inválido são recusados.
- Datas na API usam ISO com segundos e fuso (`Z` ou `±HH:MM`); calendário inválido e fim anterior/igual ao início são recusados. Respostas normalizam datas em UTC com precisão de milissegundos. Minutos devem ser número inteiro positivo dentro do tipo INTEGER do PostgreSQL, não texto.
- O contrato em `src/services/avaliacaoValidation.ts` valida entrada e resposta do banco. Resposta inválida não confirma criação nem vira lista vazia; campos extras do banco não são devolvidos. Todos os retornos usam `Cache-Control: no-store`.
- Não repete o POST automaticamente. Em falha de conexão/resposta, consultar antes de reenviar: a transação pode ter sido concluída, e duas criações válidas geram registros diferentes.
- Erros HTTP: `400` dados/consulta inválidos, `401` token ausente/recusado, `403` perfil/MFA não permitido, `404` turma inacessível, `405` método, `409` turma inativa, `415` conteúdo diferente de JSON e `503` indisponibilidade/resposta inválida. Sessão encerrada recusada pela RLS pode retornar `404` na consulta, sem expor a turma.

### Teste manual da API

Rodar `npm run dev:full` com o Supabase de testes. Entrar como professor e concluir MFA. Ainda não há botão de avaliação. No console do navegador, apenas no ambiente local:

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
