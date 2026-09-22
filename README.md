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

- `main`: versão estável
- `desenv`: desenvolvimento integrado
- `feature/*`: funcionalidades em desenvolvimento
- `entrega1409`: versão preparada para a primeira entrega

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
```

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

Antes de verificar o e-mail e a senha, o sistema exige a validação do Cloudflare Turnstile.

O token é enviado para `/api/validar-turnstile`, validado no servidor e descartado. O resultado da operação é registrado em `eventos_seguranca` e o protocolo aparece no painel após o acesso.

No desenvolvimento local, o projeto usa as chaves oficiais de teste quando nenhuma chave do Turnstile foi configurada. No ambiente de produção, as chaves reais são obrigatórias.

## Verificações

```bash
npm run lint
npm run test
npm run build
```

## Situação atual

- Tela de acesso responsiva
- Cadastro de alunos com Supabase Auth, sem gravar senhas no navegador
- Validação com Cloudflare Turnstile
- Verificação do token no back-end
- Auditoria dos resultados no Supabase
- Estrutura de perfis e políticas RLS
- Login ainda simulado com as três contas de demonstração
- Login pelo Supabase e MFA serão integrados nas próximas etapas

Contas cadastradas no Supabase ainda não entram pela tela de login nesta etapa.
Os cadastros antigos do navegador deixaram de ser usados e não foram migrados.

Confirmação de e-mail conforme a configuração do Supabase. Em **Authentication → URL Configuration**, adicione `http://localhost:5173` às URLs de redirecionamento permitidas para os testes locais.

## Cuidados

- Chaves privadas ficam somente no back-end
- Tokens do Turnstile não são armazenados
- O acesso é bloqueado se a validação ou a auditoria falhar
- Arquivos com senhas e chaves não devem ser enviados ao GitHub
