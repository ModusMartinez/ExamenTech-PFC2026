# ExamenTech-PFC2026

Sistema de gerenciamento de provas e atividades acadêmicas com foco em segurança, autenticidade, auditoria e proteção contra possíveis fraudes durante avaliações online.

Projeto desenvolvido como Projeto Final de Curso (PFC).

## Objetivo

O ExamenTech tem como objetivo disponibilizar uma plataforma para criação, aplicação e correção de provas e atividades acadêmicas, incorporando mecanismos de segurança, autenticação em dois fatores, auditoria e monitoramento de eventos durante avaliações.

## Tecnologias

### Front-end
- React
- TypeScript
- Vite

### Back-end
- Node.js
- TypeScript
- API REST / JSON

### Banco de dados
- Supabase
- PostgreSQL

### Segurança
- Autenticação por e-mail e senha
- Autenticação em dois fatores (TOTP)
- Cloudflare Turnstile
- Controle de acesso por perfil
- Logs de auditoria

### Testes
- Vitest
- Playwright

### Deploy
- Vercel

### Versionamento
- Git
- GitHub

## Perfis de usuário

O sistema possui três perfis principais:

- Administrador
- Professor
- Aluno

## Branch

Estamos desenvolvendo na `desenv` e a `main` é a principal.
Novas funcionalidades serão desenvolvidas em branches específicas, como exemplo:
- `feature/auth`
- `feature/turmas`
- `feature/avaliacoes`
- `feature/auditoria`

## Configuração inicial

O projeto React com TypeScript foi criado utilizando Vite.

O arquivo `.gitignore` foi gerado utilizando o template Node:

- `npx gitignore node`

## As dependências do projeto podem ser instaladas com:

- `npm install`

## Para executar o ambiente de desenvolvimento:

- `npm run dev``

## Por padrão, a aplicação será disponibilizada em teste em:

- `http://localhost:5173`

## Variáveis de ambiente

Criar um arquivo .env.local na raiz do projeto baseado no arquivo .env.example.

## Variáveis necessárias:

VITE_SUPABASE_URL=
VITE_SUPABASE_PUBLISHABLE_KEY=

## Exigência 2fa pelo banco.

- `(SELECT auth.jwt() ->> 'aal') = 'aal2'`

É exatamente a estratégia recomendada pelo Supabase para exigir MFA através de RLS; para uma política que deve restringir todos os demais acessos, eles recomendam uma policy AS RESTRICTIVE