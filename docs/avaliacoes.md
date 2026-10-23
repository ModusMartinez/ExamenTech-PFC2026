# Avaliações em rascunho (019)

Primeiro bloco de RF12–RF16 da `Documentacao/FICHA_PFC.docx`: criação e consulta no banco. Sem API própria, telas, edição, questões, publicação, cancelamento ou tentativas. Não representa os RF12–RF16 completos.

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

O SQL Editor executa como administrador do banco, normalmente sem a sessão do aplicativo. Chamar a função por lá sem contexto autenticado deve falhar; não remover MFA/RLS para fazê-la funcionar. O teste pelo navegador fica para a API e a tela.

Os testes executam as funções e políticas reais no PostgreSQL local via PGlite, com Auth e sessões simulados. Cobrem campos, perfis, isolamento, aluno já matriculado, sessão de outro usuário, MFA, bloqueio de escrita, preservação dos eventos e rollback. Não acessam Supabase remoto nem substituem teste com Auth real ou concorrência entre conexões reais.

Referências: [funções e permissões no Supabase](https://supabase.com/docs/guides/database/functions), [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security), [constraints do PostgreSQL](https://www.postgresql.org/docs/current/ddl-constraints.html).
