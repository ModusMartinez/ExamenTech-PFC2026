# Turmas

RF07–RF11 em desenvolvimento: criação/consulta de turmas, solicitação e consulta das matrículas pelo aluno e aprovação pelo professor responsável ou ADMIN. A ação de inativar matrículas fica para outro bloco.

## Fluxo

`TurmasPanel` → `services/turmas` → `/api/turmas` → Supabase → `public.turmas`.

- Professor ativo com MFA cria várias turmas e consulta somente as próprias.
- Administrador ativo com MFA consulta as turmas; não cria no lugar do professor.
- Aluno e visitante não criam nem consultam a lista geral de turmas. O aluno vê somente a identificação das turmas nas próprias matrículas.
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

Usar somente dados demonstrativos. Aprovação de matrícula não restaura a aprovação manual da conta. Antes de liberar o formulário aos participantes, alinhar Termos de Uso e Política de Privacidade com turmas e matrículas, mantendo o prazo da demonstração; estes blocos não modificam os documentos nem a política de retenção.

## Matrículas — base do banco (012)

- `turma_alunos` vincula aluno e turma, com ID, situação e data da solicitação.
- Situação inicial `PENDENTE`; o modelo também aceita `ATIVA` e `INATIVA`.
- Cada par aluno/turma é único, inclusive após inativação. O aluno pode ter várias turmas.
- Leitura com MFA e sessão válida: aluno vê seus vínculos, professor vê os de suas turmas, ADMIN vê todos. Os perfis precisam estar ativos; aluno e professor também precisam manter vínculo com a organização ativa da turma.
- Consulta de histórico não depende da matrícula ou turma estar ativa; isso não autoriza realizar avaliações.
- Escrita direta está bloqueada para todos os perfis, inclusive ADMIN. Solicitação e aprovação usam funções controladas das `013` e `014`, com auditoria; inativação terá etapa própria.
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
- A tela de auditoria mostra o evento como **Matrícula solicitada**, com filtro específico e ID da matrícula.

Aplicar `database/013_solicitar_matricula.sql` depois de `012` no Supabase de testes; não reaplicar SQLs antigas. Executar `npm run dev:full` para disponibilizar a rota local. Os testes de banco/API rodam com `node --test tests/turmas.test.ts`, sem acessar o Supabase remoto. Não publicar JWTs nem códigos em prints, documentação ou commits.

Referências: [RPC do Supabase](https://supabase.com/docs/reference/javascript/rpc), [funções e permissões](https://supabase.com/docs/guides/database/functions).

## Formulário do aluno

`App` → `SolicitarMatriculaPanel` → `services/matriculas` → `POST /api/matriculas`.

- Opção **Solicitar matrícula** somente no painel do aluno, após login e MFA.
- Valida o formato do código, aceita minúsculas/espaços externos e bloqueia envio repetido enquanto aguarda a resposta.
- Usa o token da sessão no cabeçalho; envia somente o código no JSON. As permissões continuam no servidor e no banco.
- Sucesso informa nome da turma e situação pendente. Falha mantém o código para correção ou nova tentativa.
- A mensagem de sucesso é temporária. O aluno acompanha o registro em **Minhas matrículas**, descrito no bloco 016. Recarregar a página não apaga a matrícula salva. Professor e ADMIN têm a tela de aprovação descrita abaixo.
- Reutiliza estilos das turmas, mantém os links legais no rodapé e não adiciona dependências nem SQL.

Teste manual, com `011`–`013` já aplicadas e `npm run dev:full`:

1. Copiar o código de uma turma fictícia ativa criada pelo professor.
2. Entrar como aluno ativo da mesma organização, concluir MFA e abrir **Solicitar matrícula**.
3. Enviar um código incompleto: deve mostrar erro sem chamar a API. Enviar o código válido: deve confirmar a pendência.
4. No Supabase de testes, conferir o vínculo `PENDENTE` em `turma_alunos`. Repetir o código: deve informar matrícula existente, sem duplicar o vínculo.
5. Como ADMIN, abrir Auditoria e filtrar **Matrícula solicitada**. Conferir usuário e referência ao vínculo.

`tests/solicitar-matricula.test.tsx` testa o formulário junto do serviço do frontend, simulando sessão e HTTP. Navegação por perfil e filtro da auditoria são cobertos nos testes existentes. Referências: [formulários React](https://react.dev/reference/react-dom/components/input), [sessão no cliente Supabase](https://supabase.com/docs/reference/javascript/auth-getsession).

## Aprovação — servidor (014)

`PATCH /api/matriculas` → `public.aprovar_matricula` → função privada → vínculo `ATIVA` e auditoria.

- Recebe somente `{ "matricula_id": "UUID da matrícula" }`, com `Authorization: Bearer <access_token>`. Não recebe situação, aluno nem aprovador.
- Professor ativo aprova apenas suas turmas, mantendo vínculo com a organização. ADMIN ativo pode aprovar turmas de qualquer responsável, sem precisar pertencer à organização da turma. Ambos precisam de MFA e sessão válida.
- A matrícula precisa estar `PENDENTE`. Turma e organização precisam estar ativas; o aluno precisa continuar com perfil ALUNO ativo e pertencer à organização da turma, inclusive quando ADMIN aprova.
- Só muda `situacao` para `ATIVA`: preserva ID, aluno, turma e data da solicitação. Não altera perfis/contas, não reativa matrículas inativas e não implementa avaliações.
- Retorna `200` com `matricula`: ID, ID/nome da turma, situação `ATIVA` e data original da solicitação. Aprovar novamente retorna `409`, sem novo evento.
- Corpo inválido: `400`; sessão ausente/inválida: `401`; perfil/MFA/sessão não autorizado: `403`; vínculo inexistente ou fora do acesso: `404`; situação incompatível: `409`; falha do serviço: `503`. Turma/organização fora do acesso do professor não revela dados, mesmo que exista.
- Registra `MATRICULA_APROVADA`, o aprovador em `usuario_id` e o vínculo em `recurso_id`. O horário fica no evento. Não registra nome, e-mail, código de ingresso nem token.
- A matrícula fica bloqueada durante a transação para evitar duas aprovações do mesmo vínculo. Uma falha na auditoria desfaz a aprovação. Escrita direta nas tabelas continua bloqueada.

Aplicar somente `database/014_aprovar_matricula.sql`, depois de `013`, no Supabase de testes. Não reaplicar versões anteriores sobre a nova. A migração não aprova registros automaticamente. O `POST` de solicitação permanece disponível; `PATCH` usa a mesma rota e configuração local, sem dependências novas.

O bloco 014 implementou somente o servidor. A tela e o filtro de auditoria estão no bloco 015, abaixo. Testar banco/API com `node --test tests/turmas.test.ts`; a suíte cobre autorização, mudança de situação, repetição, rollback e reaplicação, usando Auth/HTTP simulados e PostgreSQL local. Não substitui a validação no Supabase nem um teste de concorrência entre conexões reais.

Referências: [funções e permissões](https://supabase.com/docs/guides/database/functions), [bloqueios de linhas no PostgreSQL](https://www.postgresql.org/docs/current/explicit-locking.html).

## Lista e botão Aprovar (015)

`App` → `MatriculasPanel` → `services/matriculas` → `GET /api/matriculas` → `listar_matriculas_pendentes()`.

- Seção **Matrículas** para professor e ADMIN, após login e MFA. O aluno tem **Solicitar matrícula** e **Minhas matrículas**, sem ações de aprovação.
- Professor vê as pendências das próprias turmas; ADMIN vê as de todos os responsáveis. A função reutiliza as permissões de consulta das turmas.
- Consulta devolve até 50 pendências, ordenadas por data e ID, da mais antiga para a mais recente. Não é uma lista completa quando há mais de 50; a tela informa o limite e busca novamente após cada aprovação.
- Mostra nome do aluno, RGM (ou ID, quando não informado), turma e data. Não devolve e-mail nem códigos de ingresso. A função identifica somente alunos dos vínculos autorizados; a leitura geral da tabela `perfis` continua restrita.
- O validador `matriculaValidation.ts` é usado na API e no navegador para manter o contrato da lista em um único lugar. O serviço do frontend compartilha a chamada HTTP entre consulta, solicitação e aprovação. Sem dependências novas.
- **Aprovar** chama o `PATCH` existente com somente o ID da matrícula. Após confirmar `ATIVA` para o mesmo ID, mostra sucesso, remove a pendência e consulta a lista novamente. Não envia perfil, aluno ou situação pelo navegador.
- Durante a aprovação, os botões ficam bloqueados contra cliques repetidos. Falhas não simulam sucesso: mantêm a solicitação e orientam atualizar a lista. Sessão inválida, matrícula já aprovada por outro usuário e indisponibilidade têm mensagens próprias.
- A consulta não garante que a pendência ainda possa ser aprovada: alterações na turma, organização ou aluno são verificadas novamente pela função da 014. Registros que deixaram de atender às condições continuam pendentes; não são apagados nem aprovados automaticamente.
- A auditoria do ADMIN ganhou **Matrícula aprovada** no filtro, com aprovador e ID do vínculo. Continua usando o evento da 014, sem duplicar registros no frontend.

### Ativação e teste manual deste bloco

1. Com `014` já aplicada, executar somente `database/015_listar_matriculas_pendentes.sql` no Supabase de testes. Não reaplicar migrações antigas. A nova consulta não altera matrículas nem aprova registros.
2. Rodar `npm run dev:full`.
3. Como aluno, solicitar matrícula em uma turma fictícia ativa da mesma organização.
4. Como professor responsável, concluir MFA e abrir **Matrículas**. Conferir nome/identificação do aluno, turma e data; clicar **Aprovar**. A solicitação deve desaparecer da lista e mostrar a confirmação.
5. Conferir `ATIVA` em `turma_alunos`. Como ADMIN, filtrar **Matrícula aprovada** na Auditoria e conferir o aprovador em `usuario_id` e o vínculo em `recurso_id`.
6. Gerar outra solicitação. Outro professor não deve vê-la; ADMIN deve conseguir aprová-la. Aluno não deve ter o menu de aprovação.
7. Abrir a mesma pendência como responsável e ADMIN. Aprovar em uma sessão e tentar na outra: deve informar conflito, sem novo evento. Usar **Atualizar** para remover a entrada desatualizada.

Os testes da consulta estão em `tests/turmas.test.ts`. `tests/matriculas-panel.test.tsx` testa tela e serviço juntos, com sessão/HTTP simulados: carregamento, campos, aprovação, atualização, duplicidade de clique e erros. Navegação e filtro da auditoria permanecem nas suítes existentes. A conferência visual usa dados fictícios isolados; o fluxo no Supabase precisa ser validado manualmente.

Referências: [funções e permissões do Supabase](https://supabase.com/docs/guides/database/functions), [carregamento e limpeza de efeitos no React](https://react.dev/reference/react/useEffect).

## Minhas matrículas — painel do aluno (016)

`App` → `MinhasMatriculasPanel` → `services/matriculas` → `GET /api/matriculas?consulta=minhas` → `listar_minhas_matriculas()`.

- Menu exclusivo do aluno. Mostra turma, data da solicitação e situação **Pendente**, **Ativa** ou **Inativa**. Sem botões de aprovação, cancelamento ou inativação.
- A identidade vem da sessão, não de um ID informado pelo navegador. A API valida o token; a função exige ALUNO ativo, organização ativa, sessão válida e MFA, reutilizando as regras de consulta da 012.
- Retorna somente os próprios vínculos na organização atual, inclusive matrículas e turmas inativas. Não libera leitura geral de turmas, códigos de ingresso ou dados dos colegas.
- Lista até 50 matrículas, ordenadas por data e ID, da solicitação mais recente para a mais antiga. Não há paginação neste bloco; o limite fica indicado na tela.
- **Atualizar** consulta novamente a situação no banco. Ao sair da tela e voltar, a lista também é consultada. Não há atualização em tempo real nem mudança automática de situação no frontend.
- Estado ativo indica matrícula aprovada, não liberação de avaliações; esse fluxo ainda não foi implementado.
- Reutiliza a rota, o serviço HTTP e os estilos existentes. A SQL cria apenas funções de consulta, sem alterar registros, eventos, permissões de escrita ou aprovação de contas. Não adiciona dependências.

### Teste manual deste bloco

1. Com `015` já aplicada, executar somente `database/016_listar_minhas_matriculas.sql` no Supabase de testes. Não reaplicar migrações anteriores.
2. Rodar `npm run dev:full`, entrar como aluno e concluir o MFA. Abrir **Minhas matrículas**.
3. Sem vínculos, deve aparecer a orientação para solicitar matrícula. Solicitar ingresso pelo formulário existente e voltar à lista: a turma deve aparecer como **Pendente**.
4. Aprovar com o professor responsável ou ADMIN. Na sessão do aluno, clicar **Atualizar**: a mesma matrícula deve aparecer como **Ativa**.
5. Outro aluno deve ver apenas as próprias matrículas. Professor e ADMIN não recebem o menu **Minhas matrículas**.
6. Caso já exista matrícula fictícia `INATIVA`, conferir sua exibição. A suíte local cobre esse estado e turma inativa; não é necessário alterar registros reais para testar.

Banco/API: `tests/turmas.test.ts`. Tela junto do serviço: `tests/minhas-matriculas.test.tsx`. Os testes cobrem isolamento, MFA/sessão, situações, ordem/limite, atualização e erros. Usam PostgreSQL local e Auth/HTTP simulados, sem acessar o Supabase remoto.

Referências: [funções e permissões](https://supabase.com/docs/guides/database/functions), [controle de acesso por linha](https://supabase.com/docs/guides/database/postgres/row-level-security).

## Verificações

`npm test`, `npm run lint` e `npm run build`.

Os testes de API simulam Auth/transporte HTTP e executam permissões, integridade e auditoria no PostgreSQL local via PGlite. Não criam usuários nem turmas no Supabase remoto.

Referências: [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security), [identidade no servidor](https://supabase.com/docs/reference/javascript/auth-getuser), [funções Node.js na Vercel](https://vercel.com/docs/functions/runtimes/node-js).
