# Limpeza automática para testes pelo localhost

O site e sua API podem continuar no computador. A retirada automática das fotos fica no Supabase e não depende de o PC estar ligado. Esta opção substitui o agendamento pela Vercel durante o teste; mantenha apenas um agendamento ativo para a mesma base.

O prazo continua sendo de até 90 dias por captura. As funções da 031 decidem quais arquivos podem ser apagados; a função de limpeza não aceita caminhos ou IDs enviados por um usuário. O arquivo é removido pelo Storage antes da confirmação dos metadados. Erros devolvem `503` e mantêm o trabalho pendente para repetição.

## Preparação local

Depois de aplicar 030, 031 e 032 na base de testes, execute na pasta do projeto:

```powershell
node scripts/preparar-fotos-local.mjs --preparar --projeto-teste REF_DO_PROJETO_DE_TESTES
```

Substitua `REF_DO_PROJETO_DE_TESTES` pela referência de 20 caracteres do projeto conferido no painel. O comando compara essa referência com a URL em `.env.local`, habilita somente a interface de gerenciamento e cria um token aleatório exclusivo da limpeza. Não contém endereço de banco fixo no código. Mantém a captura/envio real desligados e não acessa o Supabase ou o Git.

O comando é de preparação inicial: não o execute para iniciar o site depois de ativar as fotos. Para rodar o ambiente já configurado, use `npm.cmd run dev:full`. A repetição da preparação mantém o token existente, mas desliga o envio até nova ativação consciente.

Arquivos privados gerados:

- `docs/token-limpeza-fotos.local`: contém somente o token para o agendamento.
- `docs/agendar-limpeza-fotos.sql.local`: configuração do agendamento com o token no Vault.

Esses arquivos e `.env.local` são ignorados pela regra `*.local` do projeto. Não os envie ao Git, em mensagens ou em capturas. Repetir a preparação local conserva o mesmo token. O modelo versionado `agendar-limpeza-fotos.template.sql` não contém segredo e não deve ser executado sem preencher a configuração.

## Publicar somente a função de limpeza no Supabase de testes

1. No painel do projeto de testes, abra **Edge Functions → Deploy a new function → Via Editor**.
2. Use o nome exato `examentech-limpar-fotos`.
3. Copie o arquivo inteiro `supabase/functions/examentech-limpar-fotos/index.ts` para o editor, substituindo o exemplo. Ele é independente, sem imports nem instalação de pacotes.
4. Configure a função com **Verify JWT desativado**. O token exclusivo é conferido dentro do código; uma sessão de aluno/professor não autoriza a limpeza. A opção equivalente no arquivo local `supabase/config.toml` também está preparada para quem utilizar a CLI.
5. Em **Edge Functions → Secrets**, crie `EXAM_PHOTO_CLEANUP_TOKEN` usando o conteúdo de `docs/token-limpeza-fotos.local`.
6. Publique a função. A URL do projeto e a chave de serviço são fornecidas pelo ambiente do Supabase. A função aceita a chave de serviço legada ou o dicionário de chaves secretas modernas. Não coloque essas chaves no código nem no navegador.

No teste da função pelo painel, use método **POST**, corpo `{}` e cabeçalho `Authorization: Bearer VALOR-DO-TOKEN-EXCLUSIVO`. Substitua o valor apenas no painel, sem enviá-lo para o chat. A resposta esperada antes de haver arquivos vencendo é `200` com `{"removidas":0}`. Uma requisição sem esse token deve receber `401`. Não avance se o teste autorizado retornar `401` ou `503`.

## Agendar no próprio Supabase

Depois do teste autorizado:

1. Copie o arquivo inteiro **privado** `docs/agendar-limpeza-fotos.sql.local` para uma nova consulta no SQL Editor do mesmo projeto de testes.
2. Execute uma vez. Ele habilita `pg_cron`/`pg_net` quando disponíveis, guarda a configuração no Vault e cria `examentech-fotos-retencao` diariamente às **03:00 UTC**. Não ativa a captura de fotos.
3. Se houver erro, mantenha as fotos desligadas e confira a mensagem; não remova as verificações do script. Ele recusa sobrescrever um trabalho ou segredo existente.
4. Em **Cron → Jobs**, confira o trabalho ativo e seu histórico. Uma execução SQL bem-sucedida indica que a requisição foi enfileirada; confira também o retorno HTTP da Edge Function. O corpo precisa indicar sucesso, não somente um `request_id`.

Para disparar uma conferência pelo SQL Editor, sem revelar o token:

```sql
SELECT net.http_post(
  url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='examentech_fotos_cleanup_url')
    || '/functions/v1/examentech-limpar-fotos',
  headers := jsonb_build_object('Content-Type','application/json',
    'Authorization','Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='examentech_fotos_cleanup_token')),
  body := '{}'::jsonb,
  timeout_milliseconds := 120000
) AS request_id;
```

Depois que a requisição terminar, consulte o número recebido:

```sql
SELECT status_code, timed_out, error_msg, content
FROM net._http_response
WHERE id = NUMERO-DO-REQUEST-ID;
```

O resultado esperado é HTTP `200`, sem timeout ou erro. A consulta acima não mostra cabeçalhos nem tokens. Acompanhe falhas de agendamento e de exclusão; acesso vencido não significa que o arquivo foi apagado.

## Ativar as fotos após conferir a preparação

Com bucket `examentech-evidencias` privado, limitado a 1 MiB e `image/jpeg`, função testada e agendamento ativo:

```sql
UPDATE examentech_private.configuracao_fotos SET ativa=TRUE WHERE id=TRUE;
```

No `.env.local`, configure:

```dotenv
VITE_EXAM_MANAGEMENT_ENABLED=true
VITE_EXAM_PHOTOS_ENABLED=true
EXAM_PHOTOS_ENABLED=true
```

Reinicie com `npm.cmd run dev:full` para recarregar a interface e a API. Siga o roteiro de prova de um minuto, consulta pelo professor/ADM e teste de exclusão em `ativar-fotos-e-reativacao.md`. O aceite específico das fotos é obrigatório antes de iniciar.

## Fontes técnicas

- [Agendar Edge Functions com pg_cron, pg_net e Vault](https://supabase.com/docs/guides/functions/schedule-functions).
- [Criar e testar a função pelo painel](https://supabase.com/docs/guides/functions/quickstart-dashboard).
- [Variáveis injetadas no ambiente da função](https://supabase.com/docs/guides/functions/secrets).

O Vault evita escrever o token no texto permanente do cron. Durante o envio, o `pg_net` mantém cabeçalhos na fila técnica; por isso o token é exclusivo desta limpeza e não é uma chave de serviço do projeto. O código publicado nunca registra ou retorna credenciais.
