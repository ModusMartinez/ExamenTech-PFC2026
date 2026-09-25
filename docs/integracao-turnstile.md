# Integração externa: Cloudflare Turnstile

## Finalidade e fluxo atual do login

O widget em `src/components/TurnstileWidget.tsx` gera um token temporário. `src/App.tsx` envia esse token no campo `captchaToken` de `supabase.auth.signInWithPassword` ou `supabase.auth.signUp`. Quando o CAPTCHA está habilitado no Supabase Auth, o serviço de autenticação valida o token antes de aceitar a operação. Essa é a integração usada pelas telas de login/cadastro.

O código da aplicação não persiste o token em `eventos_seguranca` nem o exibe ao usuário. Após cada tentativa, o widget é reiniciado para pedir um novo token. A configuração real exige uma chave de site no front-end e a chave secreta cadastrada no Supabase Auth. [Documentação oficial do CAPTCHA no Supabase](https://supabase.com/docs/guides/auth/auth-captcha).

## Rota própria, separada do login

`api/validar-turnstile.ts` é uma API independente de demonstração da integração servidor → Cloudflare Siteverify. Ela recebe `POST /api/validar-turnstile` com JSON `{ "token": "..." }`, chama o [Siteverify](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/) com a chave privada e, se a tabela existir, registra o resultado técnico em `public.eventos_seguranca`.

| Resposta | Significado |
| --- | --- |
| 200 | Token aceito e evento técnico gravado. |
| 400/405/415 | Requisição ou método incorreto. |
| 403 | Cloudflare recusou o token ou seu contexto. |
| 502 | Provedor externo indisponível. |
| 503 | Não foi possível gravar a auditoria técnica. |

Essa rota **não é chamada pelo login/cadastro atual** e não registra o sucesso ou a falha do login de uma pessoa. O mesmo token não pode ser enviado primeiro à rota e depois ao Supabase Auth: tokens do Turnstile são de uso único. A rota atual espera a ação `login`; não deve ser conectada à tela de cadastro sem revisão da regra de ação e do desenho de autenticação.

Os testes em `tests/validar-turnstile.test.ts` simulam as respostas do Cloudflare e do Supabase. Eles verificam aceitação, rejeição, ação/hostname, erros e ausência do token no evento gravado. Falta executar uma chamada real em ambiente configurado e registrar evidência para a apresentação.
