# ExamenTech-PFC2026

Sistema de gerenciamento de provas e atividades acadêmicas com foco em segurança, autenticidade, auditoria e proteção contra possíveis fraudes durante avaliações online.

Projeto desenvolvido como Projeto Final de Curso (PFC).

## Objetivo

O ExamenTech disponibilizará uma plataforma para criação, aplicação e correção de provas e atividades acadêmicas, incorporando autenticação em dois fatores, autorização por perfil, auditoria e monitoramento de eventos.

## Tecnologias

- Front-end: React, TypeScript e Vite.
- Back-end: Vercel Functions com Node.js e TypeScript.
- Banco de dados: PostgreSQL no Supabase.
- Autenticação: Supabase Auth.
- API externa: Cloudflare Turnstile.
- Deploy planejado: Vercel.
- Versionamento: Git e GitHub.

## Perfis de usuário

- Administrador
- Professor
- Aluno

## Branches

- `main`: versão estável.
- `desenv`: integração do desenvolvimento.
- `feature/*`: desenvolvimento isolado de funcionalidades.
- `entrega1409`: versão destinada à primeira avaliação, criada após a validação das funcionalidades.

## Configuração inicial

Instale as dependências:

```bash
npm install
```

Crie o arquivo `.env.local` com base em `.env.example`.

### Variáveis públicas

Estas variáveis são incorporadas ao front-end:

```env
VITE_SUPABASE_URL=
VITE_SUPABASE_PUBLISHABLE_KEY=
VITE_TURNSTILE_SITE_KEY=
```

### Variáveis privadas

Estas variáveis são lidas exclusivamente pelo back-end e nunca devem receber o prefixo `VITE_`:

```env
SUPABASE_URL=
SUPABASE_SECRET_KEY=
SUPABASE_SERVICE_ROLE_KEY=
TURNSTILE_SECRET_KEY=
TURNSTILE_EXPECTED_HOSTNAMES=
```

Use preferencialmente `SUPABASE_SECRET_KEY` (`sb_secret_...`). `SUPABASE_SERVICE_ROLE_KEY` permanece como alternativa para projetos que ainda utilizam a chave legada; apenas uma das duas deve ser preenchida.

Em `TURNSTILE_EXPECTED_HOSTNAMES`, informe os domínios aceitos separados por vírgula, por exemplo `app.exemplo.com,www.exemplo.com`. A variável pode ficar vazia no desenvolvimento local, mas deve ser configurada no deploy.

O `.env.local` é ignorado pelo Git. Não versione chaves reais, tokens, senhas ou o conteúdo de desafios do Turnstile.

## Banco de dados

Execute os scripts no SQL Editor do Supabase nesta ordem:

1. `database/001_perfis.sql`
2. `database/002_eventos_seguranca.sql`

O segundo script cria a tabela de auditoria utilizada pela integração com o Turnstile. O navegador não recebe permissão para inserir, alterar ou excluir esses registros; a gravação é feita pela função de back-end.

## Integração com Cloudflare Turnstile

A validação anti-bot segue este fluxo:

```text
Widget React
    -> token temporário
Vercel Function /api/validar-turnstile
    -> Siteverify do Cloudflare
Tabela public.eventos_seguranca
    -> resultado da validação sem armazenar o token
```

No desenvolvimento local, quando `VITE_TURNSTILE_SITE_KEY` e `TURNSTILE_SECRET_KEY` não estiverem configuradas, são utilizadas as chaves oficiais de teste que sempre aprovam o desafio. Como a resposta simplificada dessas chaves não representa o domínio e a ação reais, essas duas conferências de contexto são aplicadas somente com as chaves reais. Em produção, as duas chaves reais são obrigatórias.

Mesmo em desenvolvimento, a URL do projeto (`SUPABASE_URL` ou a `VITE_SUPABASE_URL` já configurada) e uma chave privada (`SUPABASE_SECRET_KEY` ou a alternativa legada `SUPABASE_SERVICE_ROLE_KEY`) precisam estar disponíveis para que o resultado seja auditado. A operação falha de forma segura quando não é possível gravar a auditoria.

## Executar localmente

Para iniciar o front-end e a API local juntos:

```bash
npm run dev:full
```

A aplicação ficará disponível normalmente em:

```text
http://localhost:5173
```

Também é possível executar os processos em terminais separados:

```bash
npm run dev:web
npm run dev:api
```

No deploy, a Vercel publica automaticamente `api/validar-turnstile.ts` como uma Function.

## Qualidade

```bash
npm run lint
npm run test
npm run build
```

Os testes da integração utilizam o test runner nativo do Node.js e não enviam tokens ou credenciais reais para serviços externos.

## Situação atual

- Interface responsiva de acesso implementada.
- Integração real com Cloudflare Turnstile implementada no cliente e no servidor, com testes automatizados.
- Migração da tabela `eventos_seguranca` pronta para execução no Supabase.
- Registro de validações implementado e verificado em desenvolvimento; cada ambiente precisa fornecer sua própria chave privada do Supabase.
- Estrutura de `perfis`, trigger e políticas RLS implementada.
- Validação de e-mail e senha ainda utiliza usuários simulados e será substituída pelo Supabase Auth.
- MFA/TOTP, cadastros, avaliações e dashboards acadêmicos permanecem em desenvolvimento.

## Segurança

- A consulta de `perfis` e eventos pela aplicação exige `aal2` nas políticas RLS.
- Cadastros públicos nunca podem criar administradores.
- A chave privada do Supabase é usada somente no back-end.
- O servidor confere a ação `login` e, quando configurados, os domínios autorizados do desafio.
- Tokens do Turnstile não são persistidos nem enviados a logs.
- Um acesso validado é bloqueado caso o respectivo evento de auditoria não possa ser gravado.
