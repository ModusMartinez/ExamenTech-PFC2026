# Cadastro sem aprovação manual

O convite individual já define quem pode se cadastrar. Depois de validar o
convite e o código da organização, o banco cria o perfil como `ALUNO/ATIVO`.
Não existe uma segunda aprovação do administrador nesse fluxo.

`ATIVO` não significa e-mail confirmado nem sessão autenticada. Confirmação
de e-mail, senha, Turnstile e Authenticator continuam obrigatórios conforme
a configuração do Supabase. O cadastro não pode escolher ADMIN ou PROFESSOR.

## Aplicar no Supabase

1. Confira se o projeto é o mesmo usado pela aplicação e faça backup.
2. Com `005` e `006` já aplicados, execute todo o arquivo
   `database/007_cadastro_sem_aprovacao.sql` no SQL Editor.
3. Não reaplique `001`, `003` ou `005` depois: as versões antigas da função
   de perfil voltariam a criar contas pendentes.
4. Atualize a aplicação e entre novamente com a conta de aluno já criada.
   Use o mesmo Authenticator; não precisa refazer o cadastro.

O SQL também ativa os alunos `PENDENTE` que tenham um convite `UTILIZADO`
para o mesmo usuário, e-mail e organização, desde que a organização esteja
ativa. Não muda o papel, a senha ou o MFA de ninguém. Contas `INATIVO`,
professores e administradores não são ativados automaticamente.

Registros antigos sem convite ou com vínculo divergente continuam bloqueados.
O estado `PENDENTE` permanece permitido apenas para essa compatibilidade;
novos cadastros por convite não usam mais esse estado. Esses registros antigos
precisam de revisão dos dados, não de uma etapa de aprovação no cadastro atual.

## O que muda no código

- `007_cadastro_sem_aprovacao.sql`: atualiza a função de criação do perfil,
  o valor padrão da situação e os alunos antigos elegíveis.
- `App.tsx`: sucesso do cadastro orienta a entrar e configurar o Authenticator.
- `profileAccess.ts`: exige perfil ativo, sem mensagem de aprovação pendente.
- A auditoria continua gravando cadastro e acesso. Eventos antigos são mantidos.

## Conferir

1. Novo aluno com convite válido deve aparecer como `ALUNO/ATIVO`.
2. Sem confirmar o e-mail ou sem concluir MFA, não deve acessar o painel.
3. Depois dessas verificações, deve entrar e gerar `LOGIN_SUCESSO`.
4. Uma conta de teste marcada como `INATIVO` deve continuar bloqueada e gerar
   `LOGIN_NEGADO` após MFA, com `PERFIL_INATIVO`.
5. Cadastro sem convite, convite reutilizado e tentativa de escolher ADMIN
   nos metadados não devem conceder acesso indevido.

Os testes locais executam o SQL em PostgreSQL em memória e verificam a tela
com respostas simuladas. Não alteram o Supabase remoto nem enviam e-mails.
