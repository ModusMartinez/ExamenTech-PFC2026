# Fotografias e consulta de tentativas

O procedimento de reativação da versão anterior foi revogado pela migração 038. Consulte a [regra atual da tentativa](tentativas-prova.md#homologação-da-migração-038). Estes arquivos não aplicam alterações no Supabase ou publicam no Git automaticamente. O modelo de configuração mantém fotos desligadas; o usuário já ativou e conferiu a coleta e a consulta pelo professor no ambiente de testes. Em outra base, siga o roteiro abaixo sem presumir a configuração existente.

## O que foi implementado

- O professor responsável pela avaliação ou um ADM **da mesma organização**, com conta ativa e MFA, consulta as tentativas em **Turmas → Publicadas → Gerenciar [avaliação]**.
- Quando habilitadas, as fotografias são uma inicial e três em horários sorteados **no servidor**, durante a tentativa. O conteúdo das questões só é liberado depois da confirmação da foto inicial. O envio antecipado da prova cancela capturas futuras.
- O aluno recebe um aviso no canto inferior direito quando a foto é capturada, sem mudança de foco ou bloqueio das questões. A confirmação do upload é separada da captura. Enquanto a execução permanece ativa, recusas temporárias podem preservar arquivos na memória para reenvio. Perda de conexão bloqueia a tentativa. Ao sair, a fila é liberada. Não há fotos em localStorage/IndexedDB, vídeo contínuo, áudio, comparação facial ou decisão automática de fraude.
- A consulta de uma imagem exige autorização nova na API e fica na auditoria. O aluno e professores de outras avaliações não leem os arquivos. O bucket é privado e uma política restritiva bloqueia acesso direto de `anon`/`authenticated`, mesmo diante de uma política permissiva anterior.
- A conservação máxima é de **90 dias por fotografia**, conforme confirmado pela equipe. O horário programado no servidor ancora a validade de forma conservadora; atraso ou reenvio não estende a retenção. Uma rotina diária apaga os arquivos com antecedência de até 26 horas, antes de marcar a exclusão. O acesso é negado no vencimento mesmo se a limpeza falhar. A equipe deve acompanhar e repetir falhas; bloqueio de acesso não equivale a arquivo apagado.

## 1. Conferir e aplicar os scripts na base de testes

Execute primeiro `docs/diagnostico-fotos-e-reativacao.sql`, somente de leitura. Confira que está no projeto de testes correto e que 025–028 e o aceite de documentos já estão presentes. Não reaplique 023/024 do modelo antigo.

Depois, no SQL Editor do **Supabase de testes**, aplique uma vez e nesta ordem:

1. `database/030_reativacao_autorizada.sql`
2. `database/031_fotos_tentativa.sql`
3. `database/032_documentos_fotos.sql` — pressupõe 010/029 e o gatilho de aceite ativo. Registros de aceite antigos não são modificados.

Os arquivos usam transações. Se houver erro, não remova verificações nem rode trechos isolados. Confira a estrutura antes de tentar novamente. A 031 cria tabelas, funções e a política do Storage; **não cria o bucket nem ativa a coleta**. A 032 passa a exigir as novas versões no cadastro; acompanhe essa aplicação com a configuração da interface descrita abaixo.

## 2. Habilitar a consulta pelo responsável

No `.env.local` da pasta que contém `package.json`, mantenha as variáveis existentes e acrescente:

```dotenv
VITE_EXAM_MANAGEMENT_ENABLED=true
VITE_EXAM_PHOTOS_ENABLED=false
EXAM_PHOTOS_ENABLED=false
```

Reinicie com `npm.cmd run dev:full`. A lista de provas do aluno continua com o mesmo formato. O botão de gerenciamento fica em **Turmas → Publicadas** para professor e ADM. Com a migração 038, essa configuração apresenta Termos `2026-11-08-v9` e Política `2026-11-08-v6`. O gerenciamento permite consulta. As fotos dependem do aviso e do consentimento específico antes da prova.

## 3. Criar e conferir o armazenamento privado

No Supabase de testes, vá em **Storage** e crie:

- Nome: `examentech-evidencias`
- **Public bucket desmarcado**
- Limite por arquivo: `1048576` bytes (1 MiB)
- Tipo permitido: `image/jpeg`

Não crie políticas de leitura ou escrita direta para esse bucket. A API confere essas configurações antes de transferir imagens.

Alternativa para o responsável que preferir configurar pelo terminal, depois de conferir a URL do projeto e a chave privada em `.env.local`:

```powershell
node --env-file=.env.local scripts/preparar-bucket-fotos.ts --criar-bucket-privado
```

Sem o argumento, esse script apenas mostra a orientação e não se conecta ao Supabase. Se encontrar um bucket com configuração diferente, interrompe sem alterá-lo. Não envie a chave privada para o navegador e não use prefixo `VITE_` para ela.

## 4. Configurar a exclusão automática antes de coletar fotos

**Teste somente em localhost:** utilize [Limpeza pelo próprio Supabase](limpeza-fotos-supabase.md). Essa opção roda sem computador ligado e não exige publicar o site na Vercel. A alternativa da Vercel está descrita abaixo; escolha um agendamento para a mesma base.

Como alternativa à limpeza pelo Supabase, uma aplicação publicada na Vercel pode agendar `/api/limpar-fotos-expiradas` diariamente às 03:00 UTC. Nesse caso, acrescente `"crons": [{ "path": "/api/limpar-fotos-expiradas", "schedule": "0 3 * * *" }]` à configuração de publicação e mantenha somente esse agendamento ativo para a base. A configuração padrão local não instala esse cron da Vercel. Rodar o site apenas no computador **não inicia um agendador diário**.

No servidor publicado, configure `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` (ou os equivalentes `VITE_` já utilizados), `SUPABASE_SECRET_KEY` (ou a chave legada de serviço) e um `CRON_SECRET` aleatório exclusivo. A Vercel envia esse segredo no cabeçalho do agendamento. Não copie valores privados para este documento nem para o Git.

Confira no painel da hospedagem que o agendamento existe. Execute-o manualmente pelo painel antes da ativação; sem fotos vencendo, o retorno esperado é `200` com `{"removidas":0}`. Em caso de `503`, verifique o serviço e repita a execução. A rotina remove lotes de até 100, repetindo por até 45 segundos; se ainda houver pendências, informa limpeza parcial e precisa ser executada novamente.

Se a equipe ainda não dispõe desse agendador, mantenha a coleta desligada. Com a 043, a simulação local e as Atividades continuam disponíveis, e Provas exigem a coleta configurada. Outro agendador pode chamar a mesma API autenticada diariamente.

## 5. Habilitar as fotografias na base e no site

Somente após conferir bucket, agendamento, avisos e exclusão, execute manualmente no projeto de testes:

```sql
UPDATE examentech_private.configuracao_fotos SET ativa = TRUE WHERE id = TRUE;
```

No `.env.local` e, quando publicado, nas variáveis do servidor e da interface:

```dotenv
VITE_EXAM_MANAGEMENT_ENABLED=true
VITE_EXAM_PHOTOS_ENABLED=true
EXAM_PHOTOS_ENABLED=true
```

Reinicie o ambiente local ou gere nova publicação da interface, pois as variáveis `VITE_` são incorporadas na compilação. Os três controles (banco, API e interface) devem concordar. Em divergência, o início com fotos é recusado. Não atualize as variáveis do projeto principal durante esse teste.

## Roteiro de validação manual

1. Use uma prova fictícia de poucos minutos, aluno matriculado e professor responsável da mesma organização. Use câmera própria e participantes adultos que concordaram com a demonstração.
2. Entre como aluno: confirmar só o aviso geral não habilita o início. Confirme separadamente o aviso das fotografias. Leia os documentos pelo link dentro da página.
3. Inicie: a primeira foto deve ser recebida antes das questões. Aguarde os três horários aleatórios durante a prova; o aviso aparece no canto sem mudar o foco. Não é obrigatório esperar fotos futuras para enviar uma prova terminada.
4. Entre como professor em **Turmas → Publicadas → Gerenciar [prova] → Fotos de [aluno]**. Abra cada fotografia. Repita como ADM da organização. Aluno, outro professor e ADM de outra organização não devem conseguir acessá-las.
5. Interrompa outra tentativa saindo da aba. Confira que a tentativa não pode ser retomada e que professor e ADM consultam o histórico sem ação de reativação.
6. Confira os registros de interrupção, recebimento e consulta. Não publique imagens reais ou cópias do banco em evidências de teste.
7. Para testar a exclusão sem esperar 90 dias, use **uma única foto fictícia de teste**. Consulte seu UUID e ajuste somente essa linha no SQL Editor: `UPDATE public.fotos_tentativa SET expira_em = clock_timestamp() - interval '1 second' WHERE id = 'UUID-DA-FOTO-DE-TESTE';`. A leitura deve ser negada imediatamente. Execute o agendamento e confira a ausência do arquivo no Storage e a situação `EXCLUIDA` nos metadados. Não altere a validade de fotos reais ou de outras tentativas.

## Atendimento a revogação/exclusão antecipada

O contato da Política continua sendo o canal para o titular. O responsável deve verificar a identidade com dados mínimos e identificar a tentativa e os ciclos abrangidos pelo pedido. No SQL Editor administrativo, registre a revogação **somente para a tentativa identificada**: `UPDATE public.avisos_fotos_tentativa SET revogado_em = clock_timestamp() WHERE tentativa_id = 'UUID-DA-TENTATIVA-CONFERIDA' AND revogado_em IS NULL;`. Isso bloqueia novos envios e consultas das imagens desses ciclos e as inclui na próxima limpeza, mesmo antes de 90 dias. Execute o agendamento autenticado imediatamente para concluir a retirada, sem aguardar a execução diária.

Confira a remoção dos arquivos e trate os metadados identificáveis, vínculos e backups conforme o pedido e os limites informados na Política. Não basta apagar a linha da tabela ou ocultar a imagem.

## Referências técnicas consultadas

- [Schema do Storage — Supabase](https://supabase.com/docs/guides/storage/schema/design): o arquivo deve ser removido pela API de armazenamento; apagar metadados SQL isoladamente não elimina o objeto.
- [Uploads e conflito de arquivo existente — Supabase](https://supabase.com/docs/guides/storage/uploads/standard-uploads): o reenvio não sobrescreve uma captura; a API compara o hash se o arquivo já existir.
- [Agendamento e autenticação — Vercel](https://vercel.com/docs/schedules/cron-jobs/manage-cron-jobs).
- [LGPD — texto atualizado da Câmara dos Deputados](https://www2.camara.leg.br/legin/fed/lei/2018/lei-13709-14-agosto-2018-787077-normaatualizada-pl.html): transparência, finalidade, consentimento específico, segurança e direitos dos titulares. Os 90 dias foram definidos pela equipe.

A atualização da monografia e da ficha fica para a etapa combinada com a equipe; os avisos e a Política disponíveis dentro do sistema já acompanham a funcionalidade.
