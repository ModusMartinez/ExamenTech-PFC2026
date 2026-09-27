# ExamenTech-PFC2026

Sistema de Gerenciamento Seguro de Provas e Atividades Acadêmicas (SGPA), desenvolvido como Projeto Final de Curso.

O projeto reúne criação, aplicação e correção de avaliações, com controle de acesso, autenticação em dois fatores e registro de eventos de segurança.

## Tecnologias

- React, TypeScript e Vite
- Node.js e Vercel Functions
- Supabase e PostgreSQL
- Cloudflare Turnstile
- Git e GitHub

## Perfis

- Administrador
- Professor
- Aluno

## Branches

- `desenv`: desenvolvimento integrado
- `feature/*`: funcionalidades em desenvolvimento
- `entrega1409`: branch principal da entrega do grupo

## Configuração

Instale as dependências:

```bash
npm install
```

Crie um arquivo `.env.local` usando `.env.example` como modelo.

### Front-end

Variáveis incorporadas no front-end:

```env
VITE_SUPABASE_URL=
VITE_SUPABASE_PUBLISHABLE_KEY=
VITE_TURNSTILE_SITE_KEY=
VITE_INVITES_ENABLED=false
```

Mantenha `VITE_INVITES_ENABLED=false` até as etapas de convites estarem prontas
no mesmo projeto Supabase usado pelo site.

### Back-end

Variáveis lidas pelo back-end; não usam o prefixo `VITE_`:

```env
SUPABASE_URL=
SUPABASE_SECRET_KEY=
SUPABASE_SERVICE_ROLE_KEY=
TURNSTILE_SECRET_KEY=
TURNSTILE_EXPECTED_HOSTNAMES=
```

Use `SUPABASE_SECRET_KEY` nos projetos atuais. `SUPABASE_SERVICE_ROLE_KEY` fica disponível para projetos que ainda usam a chave antiga.

Em `TURNSTILE_EXPECTED_HOSTNAMES`, informe os domínios permitidos separados por vírgula. No ambiente local, essa variável pode ficar vazia.

O arquivo `.env.local` não deve ser enviado ao GitHub.

## Executando o projeto

Inicie o front-end e a API juntos:

```bash
npm run dev:full
```

Acesse:

```text
http://localhost:5173
```

Para executar separadamente:

```bash
npm run dev:web
npm run dev:api
```

## Integração com Turnstile

No login e no cadastro, o token do Turnstile é enviado ao Supabase Auth por meio de `captchaToken`. Para essa proteção funcionar de verdade, habilite Cloudflare Turnstile nas configurações de CAPTCHA do Supabase Auth e informe a chave secreta no painel do Supabase. Cada token pode ser usado apenas uma vez.

A rota `/api/validar-turnstile` continua disponível como integração separada com a API da Cloudflare. Ela valida o token no servidor e grava eventos técnicos em `eventos_seguranca`, mas não participa do login pelo Supabase Auth nem registra se o usuário entrou com sucesso. Não envie o mesmo token para as duas validações.

Cadastro e acesso após MFA têm auditoria própria na mesma tabela, com eventos `CADASTRO_REALIZADO`, `LOGIN_SUCESSO` e `LOGIN_NEGADO`. A ativação e os testes estão no [roteiro de auditoria](docs/auditoria-cadastro-login.md).

No desenvolvimento local, a rota separada usa as chaves oficiais de teste quando nenhuma chave foi configurada. Em preview e produção, exige chave real. O CAPTCHA do Supabase Auth precisa ser configurado no próprio projeto Supabase.

## Preparação do acesso real

- Configure `.env.local` com a URL e a chave pública do projeto Supabase, usando `.env.example` como modelo. Nunca coloque a chave secreta no front-end.
- Confirme que os arquivos `database/001_perfis.sql` e `database/002_eventos_seguranca.sql` foram aplicados ao projeto Supabase. Os arquivos no repositório não aplicam as regras automaticamente.
- Aplique também `database/003_cadastro_publico_aluno.sql` depois de `001`, inclusive em projetos onde `001` já foi executado. Essa correção impede elevação de perfil pelo cadastro público.
- Para o cadastro por convite, siga [o roteiro específico](docs/convites-organizacoes.md): `004` prepara tabelas e funções; `005` passa a exigir convite em toda criação de conta. A tabela `public.organizacoes` precisa existir antes de `004`. Ative `VITE_INVITES_ENABLED=true` no site somente quando o banco correspondente estiver pronto.
- Configure confirmação de e-mail e proteção CAPTCHA no Supabase Auth. O login exige um aplicativo autenticador TOTP: o usuário configura o QR code na primeira entrada e informa o código nas próximas entradas.
- O acesso ao painel só é liberado depois do TOTP e da leitura de `perfis` com situação `ATIVO`. Com o [cadastro sem aprovação](docs/cadastro-sem-aprovacao.md) aplicado, novos alunos com convite entram como `ALUNO/ATIVO`, sem aprovação manual. Uma conta administradora inicial deve ser preparada pela equipe no Supabase, nunca pelo cadastro público.
- Publique a aplicação usando HTTPS. O Supabase Auth gerencia o hash das senhas; não armazene senhas no código, no navegador ou na tabela `perfis`.

## Verificações

```bash
npm run lint
npm run test
npm run build
```

`npm test` também verifica a tela de cadastro: troca de janela, mensagens de
erro e retorno ao login após sucesso. Para rodar só esses testes, use
`npm run test:ui`. Supabase e CAPTCHA são simulados; nenhuma conta é criada.

## Situação atual

Cadastro, confirmação de e-mail, MFA, acesso de administrador e registros de cadastro/login foram validados pela equipe no Supabase de testes. A retirada da aprovação manual foi testada localmente e precisa do ajuste no banco descrito no roteiro de cadastro. Cada ambiente precisa ter suas configurações e testes conferidos.

- Tela de acesso responsiva
- Cadastro e login por e-mail e senha usando Supabase Auth
- Configuração e confirmação de TOTP antes de liberar o painel
- Cadastro por convite sem aprovação manual; leitura do perfil real e bloqueio de contas inativas
- Cadastro por convite individual, vinculado a uma organização, disponível somente com `VITE_INVITES_ENABLED=true` e as migrações correspondentes
- Token Turnstile enviado ao Supabase Auth; requer configuração do CAPTCHA no painel Supabase
- Rota separada de validação Turnstile com testes e auditoria técnica
- Dashboards por perfil em `src/components/Dashboard` ainda com dados de exemplo e sem ligação com o painel atual
- Auditoria de cadastro e acesso aprovado/negado após MFA, com registro no banco e sem duplicação por sessão
- Auditoria das demais ações dos usuários ainda pendente

Tentativas recusadas antes do MFA não são copiadas para nossa tabela. O Supabase Auth também oferece logs próprios; confirme sua disponibilidade/configuração no projeto. Auditoria de ações acadêmicas ainda não foi implementada.

Roteiros para a próxima etapa: [preparação e testes do Supabase](docs/preparacao-supabase.md), [convites e organizações](docs/convites-organizacoes.md) e [integração externa com Turnstile](docs/integracao-turnstile.md).

A política de privacidade e as decisões de retenção de dados ainda precisam de revisão pela equipe responsável pela LGPD.

## Cuidados

- Chaves privadas ficam somente no back-end
- Tokens do Turnstile não são armazenados
- O acesso depende de sessão Supabase, TOTP e perfil ativo
- Arquivos com senhas e chaves não devem ser enviados ao GitHub
