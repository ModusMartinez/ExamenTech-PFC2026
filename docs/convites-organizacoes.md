# Convites e organizações — preparação para revisão

Esta funcionalidade foi exercitada em um projeto Supabase de teste separado.
Na última conferência, `003`, `004` e `005` ainda não haviam sido aplicados
ao projeto principal. Adicionar estes arquivos ao Git não executa SQL no banco.
O fluxo atual de cadastro continua funcionando enquanto `VITE_INVITES_ENABLED`
não estiver definido como `true` **e** a migração `005` não tiver sido aplicada.

## Fluxo proposto

1. Um ADMIN com MFA e situação `ATIVO` cria uma organização ou rotaciona o
   código de uma existente. A interface mostra o código uma vez. A coluna
   `organizacoes.token_login` continua guardando o código de 21 caracteres,
   conforme a restrição já existente na tabela da equipe.
2. Um ADMIN, ou um PROFESSOR ativo vinculado àquela organização, emite um
   convite individual para o e-mail do aluno. O convite vale por sete dias e
   seu código em claro também aparece uma vez.
3. No cadastro, o aluno informa e-mail, senha, código da organização e
   convite. Uma função do banco confere os códigos e entrega um ticket de
   cinco minutos. Somente esse ticket é enviado ao Supabase Auth.
4. O gatilho em `auth.users` exige e consome o ticket e o convite na mesma
   transação, remove o ticket dos metadados e cria o perfil `ALUNO/PENDENTE`
   vinculado à organização. A confirmação de e-mail e o TOTP continuam nos
   seus fluxos atuais. Um ADMIN ainda precisa mudar a situação para `ATIVO`.

O código da organização é gerado no PostgreSQL com `gen_random_uuid()` e
convertido para 21 caracteres compatíveis com `token_login`. Ele permanece
em claro nessa coluna; somente administradores autorizados devem poder
consultá-la. Convites individuais e tickets temporários são guardados como
SHA-256. Não é preciso instalar `nanoid`; ele gera identificadores, mas não
faz o hash nem substitui a validação no servidor.

## Arquivos e ordem de implantação

- `database/003_cadastro_publico_aluno.sql`: depois de `001`, força novos
  cadastros públicos a nascerem como `ALUNO/PENDENTE`, sem RGM informado pelo
  navegador. Confirmar com a equipe o impacto sobre o cadastro de professores.
- `database/004_convites_organizacoes.sql`: adiciona vínculo, tabelas e
  funções. Requer a tabela `public.organizacoes` preexistente. Não altera os
  códigos existentes nem ativa o bloqueio de cadastro.
- `database/005_ativar_convite_cadastro.sql`: exige convite em **toda** nova
  linha de `auth.users`. Esta é a etapa que impede o uso direto de `signUp`
  sem convite.
- `src/App.tsx` e `src/components/InvitationPanel.tsx`: interface preparada.
  Ela só aparece quando `VITE_INVITES_ENABLED=true` no ambiente do Vite.

Antes de aplicar qualquer SQL, revisar com a pessoa responsável pela tabela
`organizacoes`, especialmente o uso atual de `token_login`, fazer backup e
testar em um ambiente de homologação. A migração não muda a restrição de 21
caracteres nem os códigos atuais. Uma organização existente só participará
dos novos convites depois de uma rotação explícita; ela invalida seu código
anterior e pode afetar outros fluxos que o utilizem. Antes de rotacionar uma
organização compartilhada, confirmar com a equipe onde `token_login` é usado.
Não copiar códigos, tickets, senhas, chaves ou QR de MFA para o GitHub ou para
capturas públicas.
Confirmar também que o schema `examentech_private` não está na lista de
schemas expostos pela Data API.

Sequência sugerida na homologação: aplicar `003` após `001`, depois `004`;
preparar uma conta ADMIN ativa com MFA; criar/rotacionar o código da
organização; atribuir
`perfis.organizacao_id` aos professores que emitirão convites; aplicar `005`;
ativar `VITE_INVITES_ENABLED=true` no front-end e reiniciar o Vite. Publicar
o front com a flag e ativar `005` devem fazer parte da mesma janela de
implantação. Se `005` entrar antes, o cadastro antigo falhará de forma
segura; se o front novo entrar antes, a tela de convites recusará cadastros
até o gatilho estar ativo.

**Atenção:** depois de `005`, o botão **Add user** do painel Supabase e outros
métodos de criação de usuário sem convite também falharão. Não criar exceção
baseada em metadados informados pelo navegador. Para a demonstração, um
professor pode ser cadastrado com convite como ALUNO e depois promovido e
vinculado à organização por um ADMIN. O cadastro de um novo ADMIN exigirá um
procedimento privilegiado separado e revisado pela equipe.

## Testes necessários no Supabase de homologação

No projeto de teste separado, a equipe relatou que validou o cadastro com
convite, a confirmação de e-mail, o TOTP, o bloqueio do perfil `PENDENTE` e o
acesso após mudar para `ATIVO`. Também relatou testes de convite errado,
reutilizado e cadastro sem convite. Esses relatos não comprovam o mesmo
comportamento no projeto principal; os demais casos abaixo ainda precisam ser
conferidos antes da implantação.

- ADMIN com MFA cria organização e emite convite; PROFESSOR da mesma
  organização emite convite; PROFESSOR de outra organização é recusado.
- Aluno com ambos os códigos e e-mail correto confirma e-mail, configura
  TOTP e permanece bloqueado enquanto `PENDENTE`; depois de `ATIVO`, acessa.
- Código de organização errado/antigo, convite errado, expirado, usado ou
  destinado a outro e-mail não criam conta. `signUp` chamado diretamente sem
  ticket também não cria conta.
- O código da organização recém-criada tem exatamente 21 caracteres do
  alfabeto `[A-Za-z0-9_-]`; trocar uma letra maiúscula por minúscula o invalida.
- Dois cadastros simultâneos com o mesmo convite não produzem duas contas.
- Verificar em `auth.users.raw_user_meta_data` que o ticket foi removido;
  verificar em `perfis` o `organizacao_id` correto e, nas tabelas novas, o
  consumo único. Não mostrar valores dos códigos nessas evidências.

`npm run build`, `lint` e os testes JavaScript não executam PostgreSQL. Eles
não substituem os testes da migração, das permissões e do Auth em homologação.
Usuários antigos permanecem com `organizacao_id` nulo até que a equipe revise
os vínculos; o isolamento de turmas e avaliações por organização e o bloqueio
automático de contas quando a organização é inativada ainda exigem políticas
específicas nos módulos correspondentes.
O prazo de retenção e a limpeza de convites/tickets expirados também precisam
ser definidos com a pessoa responsável pela LGPD; a migração não agenda
essa exclusão automaticamente.
