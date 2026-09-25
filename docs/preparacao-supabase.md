# Preparação e validação do acesso ExamenTech

Este roteiro separa os testes já feitos em um projeto Supabase isolado do que **ainda precisa ser comprovado** no projeto principal da equipe. Não publique chaves privadas, senhas de teste ou o arquivo `.env.local` no GitHub.

## O que já está no código

- Cadastro público de aluno, login por e-mail e senha, confirmação de segundo fator TOTP e leitura do perfil.
- O painel só aparece quando a sessão chega a `aal2` e a linha em `public.perfis` tem `situacao = 'ATIVO'`.
- Os formulários validam campos básicos; os testes automatizados verificam essas regras sem acessar um banco real.
- O token do Turnstile é enviado ao Supabase Auth no login e no cadastro. A proteção real depende da configuração de CAPTCHA no painel Supabase.

## Ao preparar o projeto principal

1. Confirme com a equipe qual é o projeto correto. Obtenha a URL do projeto e a **chave publicável** para o front-end; obtenha a chave do site do Turnstile. As chaves secretas ficam somente com quem administra o servidor/painel.
2. Crie `.env.local` a partir de `.env.example` no seu computador. Preencha `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` e `VITE_TURNSTILE_SITE_KEY`. Não envie o conteúdo desse arquivo na conversa nem em um commit.
3. Confirme se `database/001_perfis.sql` e `database/002_eventos_seguranca.sql` já foram executados. **Depois de `001`, aplique `database/003_cadastro_publico_aluno.sql`**, inclusive se o banco já existia: ele impede que um cadastro público se autodeclare Professor ou reserve um RGM. Confira antes com a equipe se ela alterou a mesma função em outra migração. Não reaplique `001` em um banco que já tenha a tabela `perfis`.
4. No Supabase Auth, confirme que o cadastro por e-mail, a confirmação de e-mail, o TOTP/MFA e a proteção CAPTCHA com Cloudflare Turnstile estão habilitados. Configure também as URLs de redirecionamento para desenvolvimento e produção. A chave secreta do Turnstile deve ser cadastrada **no painel Supabase**, não no navegador.
5. Peça a um administrador autorizado que prepare a conta administrativa inicial e verifique seu `id` e sua situação na tabela `perfis`. O cadastro público cria apenas `ALUNO` com situação `PENDENTE` e sem RGM; aprovação, RGM e promoção devem ocorrer por fluxo administrativo, nunca por metadados enviados pelo usuário. Revise manualmente perfis Professor/Admin criados antes da migração `003`.
6. Rode `npm.cmd run lint`, `npm.cmd test`, `npm.cmd run build` e `npm.cmd run dev:full` dentro da pasta que contém `package.json`.

## Cenários para a demonstração

| Cenário | Resultado esperado |
| --- | --- |
| E-mail ou senha vazios / e-mail malformado | Erro no formulário, sem chamar Auth. |
| Senha incorreta ou e-mail não confirmado | Acesso negado, sem painel. |
| Cadastro de aluno | E-mail de confirmação quando configurado; perfil inicial `ALUNO/PENDENTE`. |
| Cadastro por chamada direta com `perfil: 'PROFESSOR'` e RGM em metadados | Depois de aplicar `003`, perfil criado como `ALUNO/PENDENTE`, sem RGM. |
| Primeira entrada com senha correta | Configuração do aplicativo autenticador; ainda sem painel. |
| Código TOTP errado | Erro; ainda sem painel. |
| TOTP certo, mas conta pendente/inativa | Acesso negado e saída da sessão local. |
| TOTP certo e conta ativa | Painel com nome e perfil lidos do banco. |
| Sair da conta / trocar de conta em outra aba | Painel ocultado e estado de acesso conferido novamente; testar manualmente a sincronização entre abas. |

Faça esses testes com contas criadas pela equipe. O resultado dos testes automáticos locais **não comprova** que o Supabase, o e-mail, o Turnstile ou o TOTP estejam configurados em produção.

## Evidências e limites para a entrega

- Guarde capturas do fluxo completo e da consulta ao perfil após MFA, sem expor senha, QR code, chave TOTP, JWT ou chaves do projeto.
- O Supabase Auth possui [logs de auditoria de autenticação](https://supabase.com/docs/guides/auth/audit-logs) para tentativas de login, cadastro e saída. Confirme no painel se estão disponíveis e se a gravação no banco deve ser habilitada. Esses logs são diferentes da tabela `eventos_seguranca`, que registra somente a rota separada do Turnstile.
- **Ações acadêmicas** (criar avaliação, alterar turma etc.) ainda precisam de auditoria própria quando os módulos dos colegas estiverem conectados. Não apresente a tabela `eventos_seguranca` como log de todas as ações.
- A autorização de turmas/avaliações precisa de RLS ou validação no servidor nas respectivas tabelas. O bloqueio de tela no React, sozinho, não protege dados.
- Senhas são tratadas pelo Supabase Auth; não implemente hash de senha no navegador. Use HTTPS no ambiente publicado. Consulte [segurança de senhas](https://supabase.com/docs/guides/auth/password-security), [MFA](https://supabase.com/docs/guides/auth/auth-mfa) e [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security).
- Termo de Uso e Política de Privacidade ainda precisam de texto aprovado pela equipe/orientador e de informações institucionais (responsável, contato, finalidades e retenção). Não chame esta entrega de conformidade LGPD concluída.
