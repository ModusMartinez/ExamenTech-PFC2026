# Turmas

RF07–RF11 em desenvolvimento: criação/consulta de turmas e solicitação de matrícula pela API. Formulário do aluno e aprovação ainda não estão disponíveis.

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

Usar somente dados demonstrativos. As próximas etapas acrescentarão o formulário de solicitação e a aprovação de matrícula, sem restaurar a aprovação manual da conta. Antes de liberar o formulário aos participantes, alinhar Termos de Uso e Política de Privacidade com turmas e matrículas, mantendo o prazo da demonstração; esta alteração não modifica os documentos nem a política de retenção.

## Matrículas — base do banco (012)

- `turma_alunos` vincula aluno e turma, com ID, situação e data da solicitação.
- Situação inicial `PENDENTE`; o modelo também aceita `ATIVA` e `INATIVA`.
- Cada par aluno/turma é único, inclusive após inativação. O aluno pode ter várias turmas.
- Leitura com MFA e sessão válida: aluno vê seus vínculos, professor vê os de suas turmas, ADMIN vê todos. Os perfis precisam estar ativos; aluno e professor também precisam manter vínculo com a organização ativa da turma.
- Consulta de histórico não depende da matrícula ou turma estar ativa; isso não autoriza realizar avaliações.
- Escrita direta está bloqueada para todos os perfis, inclusive ADMIN. A solicitação usa a função controlada da `013`; aprovação e inativação terão etapas próprias, com auditoria.
- As referências não apagam registros em cascata. Excluir uma conta ou turma com matrículas exige tratamento explícito do histórico; a rotina de encerramento da demonstração deverá considerar isso.

Aplicar `database/012_matriculas.sql` depois de `011` no Supabase de testes. A migração não cadastra matrículas, não modifica usuários/turmas e não altera telas. Não reaplicar migrações antigas depois dela.

Os testes deste bloco estão em `tests/turmas.test.ts`; os vínculos fictícios existem somente no PostgreSQL local do teste.

Referências: [RLS e funções privadas](https://supabase.com/docs/guides/database/postgres/row-level-security), [restrições e integridade referencial](https://www.postgresql.org/docs/current/ddl-constraints.html).

## Solicitação por código — servidor (013)

`POST /api/matriculas` → `public.solicitar_matricula` → função privada → matrícula e auditoria na mesma transação.

- Recebe somente `{ "codigo": "ABCDEF123456" }` e `Authorization: Bearer <access_token>`. Não recebe ID do aluno, organização ou situação.
- O código tem 12 caracteres hexadecimais; a API aceita letras minúsculas e espaços externos. Não é o código da organização nem o convite de cadastro.
- Somente aluno ativo, com MFA e sessão válida, pode solicitar para uma turma ativa de sua organização ativa. Professor e ADMIN não solicitam em nome de alunos.
- Retorna `201` com `matricula`: ID, ID/nome da turma, situação `PENDENTE` e data. Isso não libera avaliações nem consulta geral das turmas.
- Uma matrícula anterior, pendente/ativa/inativa, gera `409`, sem alterar ID, data ou situação. Não duplica nem reativa vínculos.
- Código desconhecido, turma inativa ou outra organização recebem a mesma mensagem (`400`). Sessão ausente/inválida: `401`; perfil/MFA/vínculo não autorizado: `403`; indisponibilidade: `503`.
- Registra `MATRICULA_SOLICITADA`, usuário e ID da matrícula em `recurso_id`. Não guarda código de ingresso no evento. Uma falha de auditoria desfaz a matrícula.
- A tela de auditoria já mostra o evento pelo nome técnico; seu filtro específico será incluído junto da interface no próximo bloco.

Aplicar `database/013_solicitar_matricula.sql` depois de `012` no Supabase de testes; não reaplicar SQLs antigas. Executar `npm run dev:full` para disponibilizar a rota local. Ainda não há botão/formulário de solicitação: este commit valida somente banco e API com `node --test tests/turmas.test.ts`, sem acessar o Supabase remoto. Não publicar JWTs nem códigos em prints, documentação ou commits.

Referências: [RPC do Supabase](https://supabase.com/docs/reference/javascript/rpc), [funções e permissões](https://supabase.com/docs/guides/database/functions).

## Verificações

`npm test`, `npm run lint` e `npm run build`.

Os testes de API simulam Auth/transporte HTTP e executam permissões, integridade e auditoria no PostgreSQL local via PGlite. Não criam usuários nem turmas no Supabase remoto.

Referências: [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security), [identidade no servidor](https://supabase.com/docs/reference/javascript/auth-getuser), [funções Node.js na Vercel](https://vercel.com/docs/functions/runtimes/node-js).
