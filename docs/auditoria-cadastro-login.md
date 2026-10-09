# Auditoria de cadastro e login

Os registros ficam em `public.eventos_seguranca`, junto com os eventos antigos
do Turnstile. Nenhum registro guarda senha, token, código de convite ou chave MFA.

## Eventos

- `CADASTRO_REALIZADO`: conta criada em `auth.users`. Confirmação de e-mail e
  MFA ainda podem faltar. Não significa acesso liberado. Após `007`, não há
  aprovação manual para novos alunos com convite.
- `LOGIN_SUCESSO`: sessão com MFA confirmado e perfil `ATIVO` válido.
- `LOGIN_NEGADO`: sessão com MFA confirmado, mas perfil inativo, inválido ou
  ausente. Perfis legados ainda `PENDENTE` também ficam bloqueados.
  `codigos_erro` informa o motivo.

Os três usam `provedor = 'SUPABASE_AUTH'`. Os eventos `TURNSTILE_*` continuam
exclusivos da rota separada `/api/validar-turnstile`.

## Chamadas importantes

### Cadastro

1. `App.tsx` chama `supabase.auth.signUp`, enviando o CAPTCHA ao Supabase Auth.
2. O Supabase cria a conta; os gatilhos existentes validam o convite e criam o perfil.
3. O gatilho `examentech_registrar_cadastro` chama
   `examentech_private.registrar_cadastro()` e insere `CADASTRO_REALIZADO`.

Tudo fica na mesma transação: se ela for desfeita, o registro de cadastro
também é desfeito. Não depende de o navegador ter recebido uma
sessão, então funciona com confirmação de e-mail habilitada.

### Login

1. `App.tsx` chama `supabase.auth.signInWithPassword` com o token do CAPTCHA.
2. `resolveAccess(supabase)`, em `src/services/access.ts`, confirma a sessão,
   o usuário e o MFA. Antes do segundo fator, ainda não registra acesso ao painel.
3. Após o MFA, chama `supabase.rpc('registrar_acesso')`, sem parâmetros.
4. A função do banco lê usuário e sessão do JWT validado pelo Supabase,
   verifica se a sessão ainda existe e consulta o próprio perfil.
5. Grava `LOGIN_SUCESSO` ou `LOGIN_NEGADO` e devolve o perfil usado na decisão.
6. `decideProfileAccess` libera ou bloqueia a tela. Na negativa, o App encerra
   a sessão local como já fazia.

O navegador não escolhe o usuário nem o resultado do evento. A função usa
`SECURITY DEFINER`, busca apenas o próprio perfil e exige MFA e sessão válida.
O navegador continua sem permissão para inserir diretamente na tabela.

O índice de sessão + evento evita duplicação em F5, foco de aba e renovação
do token. Outro login cria outra sessão e, portanto, outro registro. Se o
estado do perfil mudar, a mesma sessão pode ter uma negativa e um sucesso,
mas não várias cópias do mesmo resultado.

## Ativação no Supabase

1. Confira o projeto selecionado e faça backup antes de alterar o banco.
2. Execute **todo** o arquivo `database/006_auditoria_cadastro_login.sql` no
   SQL Editor do mesmo Supabase usado pela aplicação. Ele requer as estruturas
   de `001` e `002`; não reaplique esses arquivos em tabelas já existentes.
3. Não remova os gatilhos de perfil e convite. O `006` não substitui esses fluxos
   e preserva os registros antigos.
4. Use o front-end atualizado. Enquanto a função de `006` não existir ou a
   auditoria falhar, o painel não será liberado.
5. Aplique `007` para o [cadastro sem aprovação](cadastro-sem-aprovacao.md).
   Ele preserva os gatilhos e eventos de auditoria.

Esse SQL foi testado em PostgreSQL em memória. Não foi executado automaticamente
no Supabase remoto. O schema `examentech_private` deve continuar fora dos schemas
expostos pela Data API.

Esta auditoria não depende de `TURNSTILE_SECRET_KEY` no servidor local nem da
API Node. A configuração de CAPTCHA no painel Supabase continua necessária.
Não envie o mesmo token para nossa API e para o Supabase: ele só pode ser usado
uma vez.

## Conferência manual

1. Emita um convite pelo administrador e faça um novo cadastro pela aplicação.
2. Antes mesmo da confirmação do e-mail, confira `CADASTRO_REALIZADO`.
3. Confirme o e-mail, entre e configure/confirme o Authenticator.
4. Com o aluno `ATIVO`, confira acesso ao painel e `LOGIN_SUCESSO`, sem aprovação.
5. Para testar a negativa, marque apenas essa conta de teste como `INATIVO`
   pelo procedimento administrativo. Não use a conta administradora para isso.
6. Tente entrar com a conta inativa e confirme o MFA: confira `LOGIN_NEGADO`
   e `PERFIL_INATIVO`. Restaure a conta de teste para `ATIVO` ao terminar.
7. Atualize a página e troque de aba: não deve duplicar o mesmo evento da sessão.
8. Saia e entre novamente: deve gerar outro `LOGIN_SUCESSO` após o MFA.

Consulta para o SQL Editor:

```sql
SELECT evento, usuario_id, sucesso, codigos_erro, criado_em
FROM public.eventos_seguranca
ORDER BY criado_em DESC
LIMIT 20;
```

Pela aplicação, a leitura da auditoria continua restrita a `ADMIN/ATIVO` com MFA.

## Testes e limites

`npm test` inclui testes do fluxo de acesso e do SQL. O PGlite é uma dependência
somente de desenvolvimento: executa PostgreSQL em memória com tabelas mínimas
do Auth, sem ler `.env.local` ou conectar ao Supabase. Os testes também aplicam
`001` a `007` para conferir a compatibilidade com perfis, convites e a retirada
da aprovação. O cadastro e os eventos já foram conferidos pela equipe no
Supabase de testes; a nova regra de `007` ainda precisa dessa conferência remota.

Senha incorreta, CAPTCHA recusado, MFA incorreto ou abandono antes do segundo
fator **não geram `LOGIN_NEGADO` nesta implementação**. Esse evento representa
a decisão sobre o perfil após MFA, não todas as tentativas de autenticação.
Centralizar essas falhas e auditar as demais ações da aplicação são etapas separadas.

Não há importação retroativa de cadastros/logins anteriores à ativação. Uma
sessão já aberta será registrada na próxima conferência de acesso; nesse caso,
o horário é o da conferência, não o do login original.
