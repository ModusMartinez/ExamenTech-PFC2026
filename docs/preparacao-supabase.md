# Preparação e validação do acesso ExamenTech

Este roteiro separa os testes já feitos em um projeto Supabase isolado do que **ainda precisa ser comprovado** no projeto principal da equipe. Não publique chaves privadas, senhas de teste ou o arquivo `.env.local` no GitHub.

## O que já está no código

- Cadastro público de aluno, login por e-mail e senha, confirmação de segundo fator TOTP e leitura do perfil.
- O painel só aparece quando a sessão chega a `aal2` e a linha em `public.perfis` tem `situacao = 'ATIVO'`.
- Os formulários validam campos básicos; os testes automatizados verificam essas regras sem acessar um banco real.
- O token do Turnstile é enviado ao Supabase Auth no login e no cadastro. A proteção real depende da configuração de CAPTCHA no painel Supabase.
- A auditoria de cadastro e acesso após MFA usa `database/006_auditoria_cadastro_login.sql`. Aplique antes de usar o front-end atualizado; siga o [roteiro de auditoria](auditoria-cadastro-login.md).
- Cadastro com convite cria `ALUNO/ATIVO`, sem aprovação manual, depois de aplicar `007`. Veja o [roteiro de cadastro](cadastro-sem-aprovacao.md).
- Modal de termos antes do cadastro, aceite obrigatório e páginas públicas pelo rodapé de todas as telas. O registro começa em `008`; `009` contempla professores e `010` atualiza os documentos da demonstração. Veja o [roteiro de termos e privacidade](termos-privacidade.md).
- Cadastro compartilhado de aluno/professor, com perfil definido pelo convite, e auditoria básica para ADMIN. Veja [professores e auditoria](professores-auditoria.md).

## Ao preparar o projeto principal

1. Confirme com a equipe qual é o projeto correto. Obtenha a URL do projeto e a **chave publicável** para o front-end; obtenha a chave do site do Turnstile. As chaves secretas ficam somente com quem administra o servidor/painel.
2. Crie `.env.local` a partir de `.env.example` no seu computador. Preencha `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` e `VITE_TURNSTILE_SITE_KEY`. Não envie o conteúdo desse arquivo na conversa nem em um commit.
3. Confirme se `database/001_perfis.sql` e `database/002_eventos_seguranca.sql` já foram executados. **Depois de `001`, aplique `database/003_cadastro_publico_aluno.sql`**, inclusive se o banco já existia: ele impede que um cadastro público se autodeclare Professor ou reserve um RGM. Confira antes com a equipe se ela alterou a mesma função em outra migração. Não reaplique `001` em um banco que já tenha a tabela `perfis`.
4. No Supabase Auth, confirme que o cadastro por e-mail, a confirmação de e-mail, o TOTP/MFA e a proteção CAPTCHA com Cloudflare Turnstile estão habilitados. Configure também as URLs de redirecionamento para desenvolvimento e produção. A chave secreta do Turnstile deve ser cadastrada **no painel Supabase**, não no navegador.
5. Peça a um administrador autorizado que prepare a conta administrativa inicial e verifique seu `id` e sua situação na tabela `perfis`. Prepare convites com `004`/`005`, auditoria com `006` e retirada da aprovação com `007`. RGM e promoção para ADMIN continuam administrativos, nunca definidos por metadados enviados pelo usuário. Professores passam a usar o convite próprio com `009`. Revise perfis Professor/Admin criados antes de `003`.
6. Aplique `008_aceite_termos.sql`, `009_convites_professor.sql` e `010_documentos_lgpd.sql`, nessa ordem, somente se faltarem. Se `008` e `009` já estão aplicados, execute apenas `010`. Use o front-end atualizado: novos cadastros exigem o aceite atual e recebem ALUNO ou PROFESSOR conforme o convite; contas existentes não são alteradas. Não reaplique versões anteriores depois de `010`.
7. Rode `npm run lint`, `npm test`, `npm run build` e `npm run dev:full` dentro da pasta que contém `package.json`.

## Cenários para a demonstração

| Cenário | Resultado esperado |
| --- | --- |
| E-mail ou senha vazios / e-mail malformado | Erro no formulário, sem chamar Auth. |
| Senha incorreta ou e-mail não confirmado | Acesso negado, sem painel. |
| Criar conta sem marcar aceite / cancelar o modal | Formulário não abre; nenhum aceite gravado. |
| Cadastro concluído com aceite e convite válidos | Registro de versão e horário em `aceites_termos`. |
| Cadastro de aluno com convite | E-mail de confirmação; perfil inicial `ALUNO/ATIVO`, sem aprovação manual. |
| Cadastro de professor com convite emitido por ADMIN | E-mail de confirmação; perfil `PROFESSOR/ATIVO` na organização do convite. |
| Cadastro com convite de aluno e `perfil: 'PROFESSOR'` e RGM em metadados | Perfil continua `ALUNO/ATIVO`, sem RGM. Sem ticket válido, o cadastro é recusado. |
| Professor tenta emitir convite de professor ou de aluno de outra escola | Banco recusa, mesmo com chamada direta. |
| ADMIN abre Auditoria | Lista, filtro e atualização dos eventos; sem edição ou exclusão. |
| Professor/aluno tenta consultar auditoria | Sem acesso aos registros pela RLS. |
| Primeira entrada com senha correta | Configuração do aplicativo autenticador; ainda sem painel. |
| Código TOTP errado | Erro; ainda sem painel. |
| TOTP certo, mas conta inativa | Acesso negado e saída da sessão local. |
| TOTP certo e conta ativa | Painel com nome e perfil lidos do banco. |
| Sair da conta / trocar de conta em outra aba | Painel ocultado e estado de acesso conferido novamente; testar manualmente a sincronização entre abas. |

Faça esses testes com contas criadas pela equipe. O resultado dos testes automáticos locais **não comprova** que o Supabase, o e-mail, o Turnstile ou o TOTP estejam configurados em produção.

## Evidências e limites para a entrega

- Guarde capturas do fluxo completo e da consulta ao perfil após MFA, sem expor senha, QR code, chave TOTP, JWT ou chaves do projeto.
- O Supabase Auth possui [logs de auditoria de autenticação](https://supabase.com/docs/guides/auth/audit-logs). Confirme no painel se estão disponíveis e se a gravação no banco deve ser habilitada. São diferentes da tabela `eventos_seguranca`, que recebe eventos da rota separada do Turnstile e, após `006`, de cadastro e acesso após MFA. Senha/CAPTCHA/MFA recusados antes dessa etapa não são copiados para nossa tabela.
- **Ações acadêmicas** (criar avaliação, alterar turma etc.) ainda precisam de auditoria própria quando os módulos dos colegas estiverem conectados. Não apresente a tabela `eventos_seguranca` como log de todas as ações.
- A autorização de turmas/avaliações precisa de RLS ou validação no servidor nas respectivas tabelas. O bloqueio de tela no React, sozinho, não protege dados.
- Senhas são tratadas pelo Supabase Auth; não implemente hash de senha no navegador. Use HTTPS no ambiente publicado. Consulte [segurança de senhas](https://supabase.com/docs/guides/auth/password-security), [MFA](https://supabase.com/docs/guides/auth/auth-mfa) e [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security).
- Termos e Política estão acessíveis na tela, com registro de aceite preparado no banco. Os textos acadêmicos ainda precisam de aprovação da equipe/orientador e de informações institucionais (responsável, contato, bases legais e retenção). Não chame esta entrega de conformidade LGPD concluída.
