# Turmas

Primeiro bloco de RF07–RF11: criação e consulta. Matrículas ainda não estão implementadas.

## Fluxo

`TurmasPanel` → `services/turmas` → `/api/turmas` → Supabase → `public.turmas`.

- Professor ativo com MFA cria várias turmas e consulta somente as próprias.
- Administrador ativo com MFA consulta as turmas; não cria no lugar do professor.
- Aluno e visitante não criam nem consultam turmas nesta etapa.
- O nome tem de 3 a 100 caracteres.
- Professor responsável, organização e código de 12 caracteres são definidos no banco.
- O professor precisa estar vinculado a uma organização ativa.
- Código da turma é diferente do convite de cadastro e não libera acesso sozinho.
- Não há edição, exclusão ou transferência de responsável nesta etapa.
- A criação registra `TURMA_CRIADA`, usuário e ID da turma. Uma falha de auditoria desfaz a criação.

## API

- `GET /api/turmas`: lista as turmas visíveis ao usuário.
- `POST /api/turmas`: recebe somente `{ "nome": "Engenharia 8B" }`; retorna `201` e a turma.
- Ambas exigem `Authorization: Bearer <access_token>`.
- O servidor verifica a identidade no Supabase Auth. As operações usam a chave pública e o JWT do usuário, mantendo a RLS. Não usam chave administrativa.
- As regras do banco continuam valendo mesmo se alguém tentar acessar a Data API diretamente.

## Ativação e teste manual

1. Aplicar `database/011_turmas.sql` no Supabase de testes que já recebeu `001` a `010`. Não reaplicar migrações antigas sobre a nova.
2. Manter URL e chave pública do Supabase configuradas. A API aceita `SUPABASE_URL` e `SUPABASE_PUBLISHABLE_KEY`, ou as variáveis públicas `VITE_SUPABASE_URL` e `VITE_SUPABASE_PUBLISHABLE_KEY` já usadas no projeto.
3. Executar `npm run dev:full`, pois a tela utiliza a API local.
4. Entrar como professor, concluir o MFA e abrir **Turmas**.
5. Criar duas turmas fictícias, atualizar a página e conferir nome e código.
6. Entrar como outro professor: as turmas anteriores não devem aparecer.
7. Entrar como administrador: consultar turmas e filtrar **Turma criada** na auditoria.
8. Conferir que aluno não recebe a opção de turmas nesta etapa.

Usar somente dados demonstrativos. A etapa seguinte acrescentará solicitação e aprovação de matrícula, sem restaurar a aprovação manual da conta. Antes de ampliar a coleta, alinhar a documentação de privacidade com as novas informações e manter o prazo da demonstração; esta alteração não modifica a política de retenção.

## Verificações

`npm test`, `npm run lint` e `npm run build`.

Os testes de API simulam Auth/transporte HTTP e executam permissões, integridade e auditoria no PostgreSQL local via PGlite. Não criam usuários nem turmas no Supabase remoto.

Referências: [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security), [identidade no servidor](https://supabase.com/docs/reference/javascript/auth-getuser), [funções Node.js na Vercel](https://vercel.com/docs/functions/runtimes/node-js).
