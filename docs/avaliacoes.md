# Avaliações (019–034)

Este documento detalha o contrato local até `028_salvar_resposta_tentativa.sql`, incluindo a API de respostas com controle de versão. A `entrega0911` acrescentou a tela de realização, encerramento, fotografias e reativação em `028_respostas_e_encerramento.sql`–`032`; consulte o [fluxo da entrega0911](tentativas-prova.md).

**Integração em andamento:** com `033` e `034`, a API com versão e a tela da entrega0911 gravam em `respostas_tentativa`. O painel agora chama a API com versão no salvamento individual e no envio final. Falta revogar o acesso à RPC antiga de quatro argumentos. Não executar as duas queries `028` nem reaplicar as anteriores; seguir o diagnóstico do banco e as etapas abaixo. Reativação de tentativas e interrupção por falha da câmera também precisam ser alinhadas à ficha do PFC.

Para conferir o banco, executar [diagnostico-banco-provas.sql](diagnostico-banco-provas.sql) no SQL Editor do projeto configurado no ambiente local, com o papel `postgres`. A consulta identifica as tabelas, colunas e assinaturas das funções dos dois modelos, sem ler respostas nem alterar registros. Guardar o resultado antes de preparar a unificação. A existência dos objetos não confirma que todas as migrations foram aplicadas nem que os dados das duas tabelas coincidem.

O diagnóstico informado na integração confirmou `respostas_tentativa`, consulta, encerramento, reativação e fotos, sem a tabela `respostas` nem a RPC com versão. Para esse banco, a tabela mantida será `respostas_tentativa`. Não executar `028_salvar_resposta_tentativa.sql`; seu contrato abaixo permanece como referência da implementação local anterior.

RF12–RF19 da `Documentacao/FICHA_PFC.docx`: criação, consulta e edição de rascunhos no banco e na API, com formulários para o professor e listagem por turma para professor/admin. Questões têm criação e consulta pela API, formulário de cadastro e listagem por avaliação. Alternativas e gabarito têm banco, API, formulário e consulta por questão objetiva. Publicação tem banco, API, confirmação na interface e listagem das publicadas por turma. Tentativas têm início e consulta no banco/API, confirmação no painel do aluno e exibição do conteúdo na ordem sorteada persistida, sem gabarito. Respostas têm banco, função e API com versão conectada ao painel da entrega0911. O salvamento automático ainda está pendente. As seções abaixo descrevem o contrato local; não representam os RF12–RF19 completos.

## 033 — Preparação das respostas da entrega0911

Aplicar somente `database/033_preparar_respostas_com_versao.sql` no banco diagnosticado. A query exige a base de respostas e consulta da entrega0911 e recusa bancos que também tenham `public.respostas`, para evitar escolher entre registros de duas tabelas automaticamente.

- Acrescenta `id`, `versao` e `criado_em` a `respostas_tentativa`, mantendo a chave por tentativa/questão. Conteúdo, `salva_em`, tentativas e eventos anteriores são preservados. A tabela antiga `respostas_prova` não é alterada.
- Respostas existentes começam com versão 1. Como não há histórico do primeiro envio, `criado_em` recebe o `salva_em` conhecido na aplicação da query. Para novas respostas, recebe a data do primeiro envio.
- Um trigger mantém ID e data inicial nas atualizações e incrementa a versão. A RPC sem versão continua com os mesmos parâmetros e retorno. Cada atualização por ela avança a versão, inclusive reenvio do mesmo conteúdo.
- A consulta mantém `salva_em` e acrescenta ID, tentativa, versão, data inicial e `atualizado_em` (igual a `salva_em`). A tela atual aceita os campos adicionais. Permissões, MFA e RLS continuam aplicados.
- Reaplicar a `033` preserva os IDs, versões e datas já preenchidos. A query é transacional e não altera as regras de câmera, fotos, reativação ou encerramento.

Este bloco prepara os dados. A API com `p_versao` exige também a `034`, descrita abaixo. A chamada antiga não detecta uma versão desatualizada enviada pelo aluno; a conexão da tela exige a `034` e o serviço descrito abaixo.

Teste local: `node --test tests/preparar-respostas-versao.test.ts`. Usa PGlite e sessões simuladas, sem acessar o Supabase remoto. Após aplicar a query, testar uma avaliação pela tela atual e conferir `id`, `versao`, `criado_em` e `salva_em` em `respostas_tentativa`: a segunda gravação deve aumentar a versão e manter ID/data inicial.

Referência: [alteração de tabelas no PostgreSQL](https://www.postgresql.org/docs/current/ddl-alter.html).

## 034 — Salvamento com versão na tabela existente

Com a `033` aplicada, executar somente `database/034_salvar_resposta_com_versao.sql`. Não cria `public.respostas`, não copia registros e não altera os dados já salvos. Recusa banco sem a preparação da `033` ou com as duas tabelas de respostas.

- Acrescenta a assinatura `salvar_resposta_tentativa(UUID, UUID, INTEGER, UUID, TEXT)` já chamada por `POST /api/salvar-resposta-tentativa`. Os cinco argumentos são obrigatórios para não disputar chamadas com a assinatura antiga de quatro argumentos; alternativa ou texto podem ser `NULL`.
- A primeira gravação recebe versão 1; alterações usam a próxima versão. Para respostas anteriores, consultar a versão existente em `consultar_respostas_tentativa`. Repetir a versão atual com o mesmo conteúdo confirma sem alterar horário, versão ou auditoria. Versão antiga, salto ou mesma versão com outro conteúdo retornam `409` pela API.
- Mantém as validações da implementação local: aluno ativo, organização, sessão/MFA, vínculo, questão/alternativa da tentativa, situação e prazo. O bloqueio da tentativa serializa gravação, encerramento e as duas assinaturas de salvamento. Reenvio também exige acesso e prazo válidos.
- Usa o trigger da `033` para a sequência e mantém ID/data inicial. Retorna os oito campos que a API já valida, com `atualizado_em` igual a `salva_em`. A consulta e a API leem a mesma resposta, sem gabarito.
- Permite limpar alternativa/texto e preserva espaços da dissertativa, até 10.000 caracteres. O evento `RESPOSTA_SALVA` continua identificando a tentativa, como no modelo da entrega; não registra o conteúdo. Falha na auditoria desfaz a resposta e o incremento da versão.
- A RPC antiga mantém seu contrato e segue disponível neste bloco. Ela ainda pode substituir uma resposta sem verificar a versão do cliente. O painel já usa a API com versão; retirar o acesso à assinatura antiga fica para o próximo bloco.

Testes: `node --test tests/respostas-entrega.test.ts tests/salvar-resposta-tentativa-api.test.ts tests/fotos-sql.test.ts`. A API é exercitada com a função SQL real no PGlite; Auth/HTTP são simulados. Inclui aplicação sobre respostas existentes, reaplicação, versões, reenvio após perda da confirmação, permissões, prazo, encerramento, rollback de auditoria e compatibilidade com fotos. PGlite serializa transações; não substitui concorrência entre conexões reais nem validação do PostgREST remoto.

Conferência após aplicar no Supabase: `SELECT to_regprocedure('public.salvar_resposta_tentativa(uuid,uuid,integer,uuid,text)');` deve retornar a assinatura. A query solicita atualização do cache de funções do PostgREST. O frontend já está conectado à API; validar o fluxo no Supabase configurado seguindo o teste manual abaixo. Abrir o console ou mudar de foco durante a prova atual pode interromper a tentativa.

Referências: [bloqueios no PostgreSQL](https://www.postgresql.org/docs/current/explicit-locking.html) e [funções no Supabase](https://supabase.com/docs/guides/database/functions).

## Serviço de respostas com versão no frontend

`src/services/respostasTentativa.ts` reúne a consulta e o salvamento com versão, reutilizando `respostaValidation.ts`. Sem query ou dependência adicional; a consulta exige a `033` e o salvamento exige a `034`.

- `consultarRespostasTentativa(id)` chama a RPC de consulta existente. Confere IDs, versão, conteúdo e datas; recusa registros de outra tentativa, duplicados e respostas incompletas. Retorna somente os oito campos previstos. Erro de consulta não vira lista vazia.
- `salvarRespostaTentativa(dados)` recebe tentativa, questão, versão, alternativa e texto. Usa a sessão atual e faz um POST em `/api/salvar-resposta-tentativa`, sem cache. Não consulta a versão mais recente para substituir a enviada nem repete a gravação automaticamente.
- A confirmação precisa ser HTTP 200 e corresponder à tentativa, questão, versão e conteúdo enviados. Preserva espaços e quebras de linha; texto vazio é confirmado como `null`, conforme a função SQL.
- `ErroSalvamentoResposta.codigo` distingue `CONFLITO` (409), `RECUSADA` (entrada, sessão ou recusa explícita) e `NAO_CONFIRMADA` (rede, servidor ou confirmação inválida). Isso permite que a tela trate o conflito sem comparar mensagens de texto. Em confirmação perdida, manter o mesmo conteúdo e versão para eventual reenvio explícito.

O `TentativaMonitoradaPanel` usa esse serviço. As funções antigas de consulta e salvamento foram retiradas de `tentativas.ts`; início, conteúdo e encerramento permanecem nesse arquivo.

- Consulta as respostas e suas versões antes de liberar os campos, mesmo sem a gestão de tentativas habilitada. Erro de consulta permite repetir o carregamento, sem presumir versão inicial.
- Salvar e Enviar prova usam o mesmo fluxo. Só envia conteúdo alterado, com a próxima versão; preserva espaços e permite apagar uma dissertativa já salva.
- Sem confirmação, mantém o conteúdo e a versão enviados em memória. Reenviar confirma essa pendência primeiro e, se o campo mudou depois da falha, grava a alteração na versão seguinte. Uma recusa durante essa repetição não descarta a pendência original.
- Conflito mantém o formulário e impede novo envio daquela questão. **Conferir resposta salva** consulta e mostra a resposta do servidor, sem escrever ou substituir o campo. Depois de conferir, o aluno pode salvar sua resposta explicitamente.
- Envios são sequenciais; campos e botões ficam indisponíveis durante a requisição. Falha de salvamento impede o encerramento por envio. Na repetição, respostas já confirmadas não são gravadas de novo. Saída, prazo e câmera continuam com as regras existentes.

Não há salvamento automático nem armazenamento de respostas no navegador após sair/recarregar. Sem query nova neste bloco. Próximo: revogar a assinatura antiga de quatro argumentos, ainda acessível no banco.

Teste manual, com `033` e `034` aplicadas e `npm run dev:full`:

1. Iniciar uma avaliação de teste com questões objetiva e dissertativa. Salvar cada resposta, alterar e salvar novamente.
2. Apagar a dissertativa já salva e clicar em Salvar resposta; o campo deve continuar vazio e confirmado.
3. Alterar respostas sem salvar individualmente e usar Enviar prova, confirmando o encerramento.
4. Depois de sair da prova, conferir em `respostas_tentativa` o conteúdo final, a versão crescente e o mesmo ID/data inicial. Conferir também os eventos de salvamento e encerramento.

Não trocar de aba ou abrir ferramentas que tirem o foco durante o teste real: a regra atual interrompe a tentativa. Falhas de rede, conflitos e confirmações tardias são cobertos nos testes simulados.

Teste local: `npm run test:ui -- tests/respostas-service.test.tsx tests/tentativas-service.test.tsx tests/tentativa-monitorada.test.tsx tests/tentativa-com-fotos.test.tsx`. Sessão, RPC e HTTP simulados; não acessa o Supabase remoto. Cobre consulta, erros, versões explícitas, limpeza, confirmação divergente, reenvio após falha e alteração do objeto enquanto a sessão é consultada.

Referências: [RPC no Supabase](https://supabase.com/docs/reference/javascript/rpc) e [Fetch](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch).

## Dados e regras

`public.avaliacoes`: ID, turma, professor autor, título, tipo, início, fim, duração em minutos, situação e data de criação. A avaliação pertence à turma inteira; não há seleção individual de alunos.

- Tipos: `PROVA` e `ATIVIDADE`. Criação em `RASCUNHO`; a função da `023` altera para `PUBLICADA` e preenche `publicada_em`.
- Título obrigatório, de 3 a 150 caracteres, sem espaços nas pontas. A função remove esses espaços; texto só de espaços em branco é recusado.
- Datas obrigatórias, finitas e com fim posterior ao início, em `TIMESTAMPTZ`. Enviar fuso explícito, por exemplo `2026-11-09T19:00:00-03:00`.
- Duração obrigatória, em minutos inteiros positivos. A janela não precisa estar no futuro para salvar um rascunho. A publicação exige janela ainda não encerrada e duração que caiba no intervalo. A query `025` calcula o prazo da tentativa.
- Autor, ID, situação e data de criação vêm do banco. Organização é obtida pela turma, sem coluna duplicada na avaliação.
- Títulos iguais são permitidos: duas chamadas válidas criam dois rascunhos distintos. Ainda não há idempotência de criação por requisição.

## Acesso

`public.criar_avaliacao_rascunho` → função privada → `avaliacoes` e `eventos_seguranca`, na mesma transação.

```sql
-- Contrato da função; exige sessão autenticada com MFA.
SELECT public.criar_avaliacao_rascunho(
    p_turma_id => 'UUID_DA_TURMA',
    p_titulo => 'Primeira prova',
    p_tipo => 'PROVA',
    p_inicio_em => '2026-11-09T19:00:00-03:00',
    p_fim_em => '2026-11-09T21:00:00-03:00',
    p_duracao_minutos => 60
);
```

- Criação: somente professor responsável, com perfil e organização ativos, sessão existente pertencente ao usuário e MFA `aal2`. Turma precisa estar ativa e na organização atual do professor.
- Consulta: professor autor que continua responsável pela turma, ou ADMIN. Reutiliza RLS de turmas e `pode_consultar_turma`, incluindo sessão/MFA e situação da conta. Aluno não lê rascunhos, mesmo matriculado.
- Turma inativa continua consultável, mas não recebe novos rascunhos nem permite edição. Professor perde a consulta se a organização ficar inativa ou se deixar de ser responsável; ADMIN mantém a consulta institucional.
- Escrita direta e exclusão estão bloqueadas para os perfis da aplicação, inclusive ADMIN. Criação, edição e publicação usam funções controladas. As funções públicas usam `SECURITY INVOKER`; as privadas usam `SECURITY DEFINER`, `search_path` vazio e permissões explícitas.
- `ON DELETE RESTRICT` impede apagar turma/autor referenciados. Não modifica matrículas, contas ou avaliações já existentes ao aplicar a query.
- `AVALIACAO_CRIADA` registra autor, ID da avaliação e horário, sem título, código ou dados dos alunos. Falha na auditoria desfaz o rascunho. O filtro/rótulo desse evento na tela de auditoria ainda está pendente.
- Locks mantêm perfil, organização, sessão e turma estáveis durante a criação. Não há alteração nos helpers ou nas permissões dos módulos anteriores.

Erros SQL: `42501` para perfil/sessão/MFA/permissão; `P0002` para turma inexistente ou fora do acesso; `55000` para turma inativa; `23502` para campo obrigatório e `23514` para regra de campo. UUID, data ou inteiro malformado é recusado pelo PostgreSQL antes da gravação.

## Base 019: aplicação e teste

1. No Supabase de testes com `018` aplicada, executar somente `database/019_avaliacoes_rascunho.sql`. Não reaplicar migrações anteriores. A query cria a estrutura, mas não cria avaliações automaticamente.
2. No terminal, dentro do repositório, executar:

```bash
node --test tests/avaliacoes-sql.test.ts
npm test
npm run lint
npm run build
```

3. Conferir a estrutura pelo SQL Editor:

```sql
SELECT relrowsecurity AS rls_ativa
FROM pg_class WHERE oid = 'public.avaliacoes'::regclass;

SELECT
    has_table_privilege('authenticated', 'public.avaliacoes', 'SELECT') AS consulta,
    has_table_privilege('authenticated', 'public.avaliacoes', 'INSERT') AS escrita_direta,
    has_table_privilege('authenticated', 'public.avaliacoes', 'UPDATE') AS alteracao,
    has_table_privilege('authenticated', 'public.avaliacoes', 'DELETE') AS exclusao;
```

Esperado: RLS e consulta `true`; escrita direta, alteração e exclusão `false`. A consulta continua limitada pela RLS, não é acesso geral aos rascunhos.

O SQL Editor executa como administrador do banco, normalmente sem a sessão do aplicativo. Chamar a função por lá sem contexto autenticado deve falhar; não remover MFA/RLS para fazê-la funcionar. A API e o formulário permitem testar com a sessão do aplicativo.

Os testes executam as funções e políticas reais no PostgreSQL local via PGlite, com Auth e sessões simulados. Cobrem campos, perfis, isolamento, aluno já matriculado, sessão de outro usuário, MFA, bloqueio de escrita, preservação dos eventos e rollback. Não acessam Supabase remoto nem substituem teste com Auth real ou concorrência entre conexões reais.

Referências: [funções e permissões no Supabase](https://supabase.com/docs/guides/database/functions), [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security), [constraints do PostgreSQL](https://www.postgresql.org/docs/current/ddl-constraints.html).

## Edição no banco (020)

Com a `019` já aplicada, executar somente `database/020_editar_avaliacao_rascunho.sql` no SQL Editor. A aplicação da query preserva avaliações e eventos existentes. Não reaplicar as queries anteriores.

`public.editar_avaliacao_rascunho` → função privada → atualização de `avaliacoes` e inserção em `eventos_seguranca`, na mesma transação.

- Recebe ID da avaliação e os cinco campos completos: título, tipo, início, fim e duração. Reutiliza as constraints da criação. Não altera ID, turma, autor, situação ou data de criação.
- Exige professor autor ainda responsável pela turma, perfil/organização/turma ativos, sessão do próprio usuário e MFA `aal2`. ADMIN continua apenas consultando; aluno e outro professor não editam.
- Somente `RASCUNHO` pode ser editado. A função confere a situação após bloquear a linha. Turma inativa permite consulta, mas impede edição.
- Uma alteração efetiva gera `AVALIACAO_EDITADA`, com usuário, avaliação e horário. Não registra o título nem os valores anteriores/novos. Falha no evento desfaz a edição; reenviar os mesmos valores não altera a linha nem duplica o evento. O filtro/rótulo na tela de auditoria ainda está pendente.
- Locks mantêm perfil, organização, sessão e turma estáveis. Edições simultâneas da mesma avaliação aguardam a liberação da linha; a última gravação válida prevalece. Ainda não há controle de versão para detectar formulário desatualizado.

Erros: `42501` para perfil/sessão/MFA; `P0002` para avaliação inexistente ou fora do acesso; `55000` para turma inativa ou avaliação fora de rascunho. Campos continuam usando os erros de constraints da `019`.

### Teste manual da edição

1. Aplicar a `020`, rodar `npm run dev:full` e entrar como professor com MFA.
2. Escolher um rascunho de teste de uma turma ativa própria. Copiar seu ID da tabela `avaliacoes` no Supabase.
3. No console do navegador, no ambiente local, executar o exemplo abaixo com esse ID. A chamada altera o rascunho escolhido usando a sessão atual:

```js
const { supabase: supabaseEdicao } = await import('/src/lib/supabase.ts');
const camposEdicao = {
  p_avaliacao_id: 'UUID_DA_AVALIACAO',
  p_titulo: 'Prova revisada',
  p_tipo: 'PROVA',
  p_inicio_em: '2026-11-09T19:00:00-03:00',
  p_fim_em: '2026-11-09T21:00:00-03:00',
  p_duracao_minutos: 60,
};
const resultadoEdicao = await supabaseEdicao.rpc('editar_avaliacao_rascunho', camposEdicao);
console.log(resultadoEdicao);
```

4. Esperado: `error: null` e os dados atualizados. Em **Turmas → Rascunhos → Atualizar rascunhos**, conferir os novos valores. ID, turma, autor e data de criação permanecem iguais.
5. Conferir `AVALIACAO_EDITADA` em `eventos_seguranca`, com `recurso_id` igual ao ID escolhido. Repetir a chamada com os mesmos valores: nenhum evento adicional. Testar uma duração zero: erro e nenhuma alteração.
6. Recarregar a página ao trocar de conta e repetir como admin, aluno e outro professor: acesso recusado.

Teste automatizado: `node --test tests/avaliacoes-sql.test.ts`. Inclui edição válida, permissões, MFA/sessão, conta/organização/turma inativas, troca de responsável, campos inválidos, preservação do histórico, situação diferente de rascunho, rollback da auditoria e reaplicação da `020`. Usa banco local e Auth simulado; não testa Supabase remoto nem concorrência entre conexões reais.

Referências da edição: [funções e permissões no Supabase](https://supabase.com/docs/guides/database/functions), [bloqueios de linha no PostgreSQL](https://www.postgresql.org/docs/current/explicit-locking.html).

## Questões no banco (021)

Com a `020` já aplicada, executar somente `database/021_questoes_rascunho.sql` no SQL Editor do Supabase de testes. A query preserva avaliações e eventos existentes; não cria questões automaticamente. Não reaplicar as queries anteriores.

`public.questoes` pertence à avaliação, sem banco reutilizável de questões:

| Campo | Regra |
| --- | --- |
| `id` | UUID gerado pelo banco |
| `avaliacao_id` | Avaliação existente; impede excluir a avaliação enquanto houver questões |
| `tipo` | `OBJETIVA` ou `DISSERTATIVA` |
| `enunciado` | Obrigatório, de 3 a 10.000 caracteres; remove espaços nas pontas |
| `pontuacao` | De 0,01 a 9.999,99, com até duas casas decimais |
| `ordem` | Inteiro positivo, automático e único dentro da avaliação |
| `criado_em` | Data e hora geradas pelo banco |

Os limites de texto e pontuação são escolhas desta implementação. A pontuação usa `NUMERIC` sem escala fixa para recusar casas excedentes antes de qualquer arredondamento. A ordem representa a posição no rascunho; a query `026` salva separadamente o sorteio de cada tentativa.

`public.criar_questao_rascunho` → função privada → `questoes` e `eventos_seguranca`, na mesma transação.

- Recebe somente avaliação, tipo, enunciado e pontuação. Professor e organização são verificados pela avaliação e turma, sem colunas duplicadas na questão.
- Criação exige professor autor ainda responsável pela turma, perfil/organização/turma ativos, sessão do próprio usuário e MFA `aal2`. Funciona para Prova e Atividade, somente em `RASCUNHO`.
- Consulta herda a RLS da avaliação: professor autor ainda responsável ou ADMIN, ambos com sessão e MFA. Aluno não lê questões em rascunho, mesmo matriculado. Turma inativa permite consulta, mas impede criação.
- Escrita direta, edição e exclusão ficam bloqueadas para os perfis da aplicação. ADMIN apenas consulta. A `022` acrescenta alternativas e gabarito; uma questão objetiva pode ficar sem alternativas enquanto rascunho.
- A função bloqueia a linha da avaliação antes de conferir sua situação e calcular a próxima ordem. Criações na mesma avaliação são serializadas; a constraint também impede ordem repetida.
- `QUESTAO_CRIADA` registra usuário, ID da questão (`recurso_id`) e horário, sem enunciado ou pontuação. Falha no evento desfaz a questão. O filtro/rótulo desse evento na tela de auditoria fica pendente.
- Repetir uma chamada válida cria outra questão. Em falha de conexão, consultar os registros antes de reenviar.

Erros: `42501` para perfil/sessão/MFA; `P0002` para avaliação inexistente ou fora do acesso; `55000` para turma inativa ou avaliação fora de rascunho; `23502` para campos obrigatórios e `23514` para regras de campos.

### Teste manual das questões

1. Aplicar a `021`, rodar `npm run dev:full` e entrar como professor com MFA.
2. Copiar o ID de uma avaliação em rascunho da própria turma ativa, na tabela `avaliacoes` do Supabase.
3. No console do navegador, no ambiente local, executar uma vez com esse ID. A chamada cria uma questão real no ambiente de testes, usando a sessão atual:

```js
const { supabase: supabaseQuestoes } = await import('/src/lib/supabase.ts');
const avaliacaoQuestoesId = 'UUID_DA_AVALIACAO';
const resultadoQuestao = await supabaseQuestoes.rpc('criar_questao_rascunho', {
  p_avaliacao_id: avaliacaoQuestoesId,
  p_tipo: 'DISSERTATIVA',
  p_enunciado: 'Explique a finalidade de um teste de integração.',
  p_pontuacao: 2.5,
});
console.log(resultadoQuestao);
```

4. Esperado: `error: null`, questão com ID e próxima `ordem`. Conferir `QUESTAO_CRIADA` em `eventos_seguranca`, com `recurso_id` igual ao ID da questão. O cadastro também está disponível em **Turmas → Rascunhos → Nova questão**. Para consultar pela sessão atual:

```js
const consultaQuestoes = await supabaseQuestoes
  .from('questoes')
  .select('id, avaliacao_id, tipo, enunciado, pontuacao, ordem, criado_em')
  .eq('avaliacao_id', avaliacaoQuestoesId)
  .order('ordem');
console.log(consultaQuestoes);
```

5. Repetir a criação com `OBJETIVA`: próximo número de ordem e um novo evento. Pontuação `0`, `2.555` ou enunciado vazio devem falhar sem criar questão nem evento.
6. Recarregar a página ao trocar de conta e executar novamente os trechos com o mesmo ID: ADMIN consulta, mas não cria; aluno e outro professor não criam e recebem lista vazia na consulta.

O SQL Editor não fornece a sessão do professor; chamar a função por ele sem contexto autenticado deve falhar. Não remover MFA/RLS para realizar o teste.

Teste automatizado: `node --test tests/avaliacoes-sql.test.ts`. Cobre tipos, limites, ordem por avaliação, permissões, MFA/sessão, conta/organização/turma inativas, troca de responsável, bloqueio fora de rascunho, escrita direta, rollback da auditoria e reaplicação da query. Executa no PGlite com Auth simulado; não acessa Supabase remoto nem testa concorrência entre conexões reais.

Referências: [funções e permissões no Supabase](https://supabase.com/docs/guides/database/functions), [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security), [tipos numéricos do PostgreSQL](https://www.postgresql.org/docs/current/datatype-numeric.html).

## Alternativas e gabarito no banco (022)

Com a `021` aplicada, executar somente `database/022_alternativas_rascunho.sql` no SQL Editor do Supabase de testes. Preserva questões, avaliações e eventos; não cadastra alternativas automaticamente. Não reaplicar as queries anteriores.

`public.alternativas`: ID, questão, texto, ordem, `correta` e data de criação. O gabarito é a alternativa marcada com `correta = true`; não há tabela adicional ou cópia da pontuação da questão.

- Cadastro em conjunto: de 2 a 5 alternativas, com exatamente uma correta. Ordem definida pela posição na lista, começando em 1.
- Textos distintos após remover espaços nas pontas, de 1 a 2.000 caracteres. Nulos, vazios e textos só de espaços em branco são recusados. Quantidade, limite de texto e resposta única são escolhas deste bloco; a ficha não detalha esses limites.
- Somente questão `OBJETIVA` de avaliação `RASCUNHO`, ainda sem alternativas. Professor autor deve continuar responsável, com perfil/organização/turma ativos, sessão própria e MFA `aal2`.
- Consulta por professor autor e ADMIN, seguindo a RLS da questão/avaliação e limitada a rascunhos. Aluno não consulta alternativas nem gabarito, mesmo matriculado. Turma inativa mantém a consulta, mas impede cadastro.
- A função grava o conjunto e um evento `ALTERNATIVAS_CRIADAS` na mesma transação. `recurso_id` identifica a questão; não registra textos nem resposta correta no evento. Erro em qualquer alternativa ou na auditoria desfaz todo o conjunto.
- Índices impedem ordem repetida e mais de uma correta na mesma questão. A função garante a quantidade mínima e a presença de uma correta. Escrita direta, edição e exclusão estão bloqueadas para os perfis da aplicação.
- Avaliação e questão são bloqueadas durante a gravação. Repetir a chamada, inclusive com os mesmos dados, retorna “A questão já possui alternativas”, sem substituir registros ou gerar outro evento. Em falha de conexão, consultar antes de reenviar.

`public.criar_alternativas_rascunho(p_questao_id, p_alternativas, p_ordem_correta)` → função privada → `alternativas` e `eventos_seguranca`. Retorna a lista gravada, ordenada por `ordem`. Não recebe usuário, IDs das alternativas ou datas.

A edição do conjunto e o filtro/rótulo do evento na tela de auditoria ficam para outros blocos. A validação para publicação está na `023`. Quando houver tentativa do aluno, o servidor deverá fornecer apenas os campos permitidos, sem `correta`; não liberar a tabela inteira nem ocultar o gabarito somente na interface.

Erros: `42501` para perfil/sessão/MFA; `P0002` para questão inexistente ou fora do acesso; `55000` para turma inativa, avaliação fora de rascunho ou questão já preenchida; `23514` para tipo da questão, lista, textos ou posição correta inválidos.

### Teste manual das alternativas

1. Aplicar a `022`, rodar `npm run dev:full` e entrar como professor com MFA.
2. Escolher uma questão objetiva da própria turma ativa, em rascunho e sem alternativas. Copiar o ID da tabela `questoes`. Se necessário, criar uma questão pelo procedimento da `021` acima.
3. Executar no console do navegador local, substituindo o ID. Cria três alternativas reais no ambiente de testes; a segunda será a correta:

```js
const { supabase: supabaseAlternativas } = await import('/src/lib/supabase.ts');
const questaoAlternativasId = 'UUID_DA_QUESTAO';
const resultadoAlternativas = await supabaseAlternativas.rpc('criar_alternativas_rascunho', {
  p_questao_id: questaoAlternativasId,
  p_alternativas: [
    'Verificar somente a aparência da tela.',
    'Verificar a interação entre componentes do sistema.',
    'Substituir todos os testes unitários.',
  ],
  p_ordem_correta: 2,
});
console.log(resultadoAlternativas);
```

4. Esperado: `error: null`, três registros com ordens 1, 2 e 3; apenas a ordem 2 com `correta: true`. Conferir um evento `ALTERNATIVAS_CRIADAS` com `recurso_id` igual ao ID da questão. Consulta pela sessão atual:

```js
const consultaAlternativas = await supabaseAlternativas
  .from('alternativas')
  .select('id, questao_id, texto, ordem, correta, criado_em')
  .eq('questao_id', questaoAlternativasId)
  .order('ordem');
console.log(consultaAlternativas);
```

5. Repetir o cadastro nessa questão: erro, sem outro evento ou alteração. Para testar texto vazio, alternativas repetidas ou posição correta `0`, usar outra questão objetiva ainda sem alternativas. Nenhuma alternativa deve ser gravada nessas tentativas.
6. Recarregar a página ao trocar de conta. Com o mesmo ID, ADMIN consulta mas não cadastra; aluno e outro professor recebem lista vazia na consulta SQL e erro no cadastro. Na interface, abrir **Turmas → Rascunhos → Questões → Alternativas**.

Teste automatizado: `node --test tests/avaliacoes-sql.test.ts`. Cobre limites, gabarito, ordem, perfis, MFA/sessões, organização/turma, autoria, estados fora de rascunho, escrita direta, rollback e reaplicação. PGlite e Auth simulado, sem acesso ao Supabase remoto ou teste de concorrência entre conexões reais.

Referências: [funções e permissões no Supabase](https://supabase.com/docs/guides/database/functions), [índices únicos parciais](https://www.postgresql.org/docs/current/indexes-partial.html), [bloqueios de linha](https://www.postgresql.org/docs/current/explicit-locking.html).

## API de criação e consulta de questões

Requer a `021` já aplicada; nenhuma query nova neste bloco. Rota `api/questoes.ts`, registrada no servidor local e disponível como função da Vercel. Alternativas/gabarito usam a rota própria descrita abaixo; edição de questões fica para outro bloco.

- `POST /api/questoes`: recebe somente `avaliacao_id`, `tipo`, `enunciado` e `pontuacao`. Chama `criar_questao_rascunho` e retorna `201` com `{ questao }`. ID, ordem e data de criação vêm do banco; o evento `QUESTAO_CRIADA` é gravado pela mesma função SQL.
- `GET /api/questoes?avaliacao_id=UUID`: retorna `200` com `{ questoes, limite: 50 }`, nas primeiras 50 posições da avaliação. Sem paginação neste bloco. Avaliação acessível sem questões retorna lista vazia; inexistente, fora do acesso ou fora de rascunho retorna `404`.
- Professor autor cria e consulta; ADMIN apenas consulta. Aluno não acessa, mesmo matriculado. A consulta da avaliação e das questões respeita a RLS. A criação confere novamente autoria, situação da turma/avaliação, organização, sessão e MFA na função SQL.
- Usa chave pública e JWT do usuário. `server/acessoAvaliacoes.ts` compartilha a consulta de identidade por `getUser` e a verificação de perfil ativo entre as APIs de avaliações e questões. As permissões de gravação permanecem em cada rota e no banco.
- `src/services/questaoValidation.ts` valida entrada e resposta: enunciado de 3 a 10.000 caracteres após remover espaços nas pontas; pontuação numérica de 0,01 a 9.999,99, com até duas casas decimais, sem arredondamento. Número em texto é recusado. Datas da resposta são normalizadas para UTC.
- Resposta contém somente `id`, `avaliacao_id`, `tipo`, `enunciado`, `pontuacao`, `ordem` e `criado_em`. Não consulta nem devolve alternativas ou gabarito. Campos extras no POST e parâmetros desconhecidos/repetidos na URL são recusados.
- Respostas usam `Cache-Control: no-store`. Falha ou resposta inválida não confirma gravação nem vira lista vazia. Não repete o POST automaticamente: consultar antes de reenviar, pois a criação pode ter sido concluída. Acima de 50 questões, conferir também a tabela no Supabase.
- O servidor local aceita até 128 KiB no corpo desta rota, para comportar enunciados longos e Unicode escapado em JSON. As demais rotas mantêm o limite local de 16 KiB.

Erros HTTP: `400` campos/consulta inválidos; `401` sessão ausente ou recusada; `403` perfil/MFA não permitido; `404` avaliação inacessível; `405` método não permitido; `409` turma inativa ou avaliação fora de rascunho na criação; `415` conteúdo diferente de JSON; `503` indisponibilidade/resposta inválida. O servidor local retorna `413` quando o corpo excede seu limite. Sessão encerrada ou organização sem acesso também podem resultar em `404` no GET, pela RLS.

### Teste manual da API de questões

1. Rodar `npm run dev:full` com o Supabase de testes e entrar como professor com MFA.
2. Escolher uma avaliação em rascunho da própria turma ativa. Copiar o ID da tabela `avaliacoes`.
3. No console do navegador local, executar uma vez com esse ID. O POST cria uma questão real no ambiente de testes:

```js
const { supabase: supabaseApiQuestoes } = await import('/src/lib/supabase.ts');
const sessaoApiQuestoes = await supabaseApiQuestoes.auth.getSession();
if (sessaoApiQuestoes.error || !sessaoApiQuestoes.data.session) {
  throw new Error('Entre novamente e conclua o MFA.');
}
const headersQuestoes = {
  Authorization: `Bearer ${sessaoApiQuestoes.data.session.access_token}`,
  'Content-Type': 'application/json',
};
const avaliacaoApiQuestoesId = 'UUID_DA_AVALIACAO';
const criacaoQuestao = await fetch('/api/questoes', {
  method: 'POST', headers: headersQuestoes,
  body: JSON.stringify({
    avaliacao_id: avaliacaoApiQuestoesId,
    tipo: 'DISSERTATIVA',
    enunciado: 'Explique a finalidade de um teste de integração.',
    pontuacao: 2.5,
  }),
});
console.log(criacaoQuestao.status, await criacaoQuestao.json());
```

4. Esperado: `201` com a questão gravada. Conferir `QUESTAO_CRIADA` em `eventos_seguranca`. Consultar separadamente, sem repetir o POST:

```js
const consultaApiQuestoes = await fetch(`/api/questoes?avaliacao_id=${avaliacaoApiQuestoesId}`, {
  headers: headersQuestoes,
});
console.log(consultaApiQuestoes.status, await consultaApiQuestoes.json());
```

5. Esperado: `200`, questões ordenadas e nenhum novo evento. Repetir a criação com tipo `OBJETIVA`: novo registro, sem alternativas automáticas. Pontuação `0`, `2.555` ou `"2.5"`, enunciado vazio e campo extra devem retornar `400`, sem gravação.
6. Ao trocar de conta, recarregar a página e obter os cabeçalhos da nova sessão. ADMIN consulta e recebe `403` ao criar; aluno recebe `403` nas duas operações; outro professor recebe `404`. Não compartilhar tokens ou cabeçalhos.

Testes: `node --test tests/questoes-api.test.ts tests/avaliacoes-sql.test.ts`. Executam SQL/RLS no PGlite com Auth/HTTP simulados, cobrindo criação/consulta, isolamento, auditoria, decimais, Unicode, limite/ordem e falhas de resposta/transporte. Não acessam o Supabase remoto. A API de avaliações também é verificada após compartilhar a conferência de acesso.

Referências: [identidade no servidor](https://supabase.com/docs/reference/javascript/auth-getuser), [RPC](https://supabase.com/docs/reference/javascript/rpc), [consulta](https://supabase.com/docs/reference/javascript/select), [Vercel Functions](https://vercel.com/docs/functions/runtimes/node-js).

## API de criação, consulta e edição de avaliações

Requer a `019` para criação/consulta e a `020` para edição, sem nova query neste bloco. Rota registrada no servidor local e no diretório `api` da Vercel. Usa chave pública e `Authorization: Bearer <access_token>` do usuário, nunca chave administrativa. `getUser` valida a identidade; perfil e RLS/função conferem as permissões.

- `POST /api/avaliacoes`: cria pela função `criar_avaliacao_rascunho`. Recebe somente `turma_id`, `titulo`, `tipo`, `inicio_em`, `fim_em`, `duracao_minutos`. Retorna `201` com `{ avaliacao }`, incluindo ID, autor, situação e data de criação definidos pelo banco.
- `GET /api/avaliacoes?turma_id=UUID`: consulta os rascunhos visíveis da turma, por data de criação decrescente e ID decrescente. Retorna `200` com `{ avaliacoes, limite: 50 }`. Ainda sem paginação; não é uma lista completa quando há mais de 50 rascunhos.
- O parâmetro opcional `situacao=PUBLICADA` consulta as publicadas, por data de publicação decrescente e ID decrescente, incluindo `publicada_em`. Aceita somente `RASCUNHO` ou `PUBLICADA`; sem parâmetro mantém a consulta anterior. Mesmas permissões, limite de 50 e validação da resposta.
- `PATCH /api/avaliacoes`: edita pela função `editar_avaliacao_rascunho`. Recebe somente `avaliacao_id`, `titulo`, `tipo`, `inicio_em`, `fim_em`, `duracao_minutos`, todos obrigatórios. Retorna `200` com `{ avaliacao }`, inclusive ao salvar os mesmos valores. Não recebe `turma_id`; turma e autor permanecem os da avaliação.
- Edição exige professor autor ainda responsável pela turma e as regras da `020`. ADMIN e aluno recebem `403`; avaliação inexistente ou de outro professor recebem a mesma resposta `404`. Turma inativa ou avaliação fora de rascunho retornam `409`. Não repete o PATCH automaticamente: em falha, consultar os valores atuais antes de reenviar.
- Professor cria apenas nas próprias turmas. ADMIN consulta, mas não cria. Aluno é recusado mesmo matriculado. Consulta de turma inexistente ou fora do acesso retorna a mesma resposta `404`; turma acessível sem rascunhos retorna lista vazia. Turma inativa permite consulta, mas criação retorna `409`.
- Não recebe professor, organização, situação, data de criação ou aluno no corpo. Campos extras, parâmetros de URL extras/repetidos e JSON inválido são recusados.
- Datas na API usam ISO com segundos e fuso (`Z` ou `±HH:MM`); calendário inválido e fim anterior/igual ao início são recusados. Respostas normalizam datas em UTC com precisão de milissegundos. Minutos devem ser número inteiro positivo dentro do tipo INTEGER do PostgreSQL, não texto.
- O contrato em `src/services/avaliacaoValidation.ts` compartilha a validação de título, tipo, datas e duração entre criação e edição. Resposta inválida não confirma gravação nem vira lista vazia; campos extras do banco não são devolvidos. Todos os retornos usam `Cache-Control: no-store`.
- Não repete o POST automaticamente. Em falha de conexão/resposta, consultar antes de reenviar: a transação pode ter sido concluída, e duas criações válidas geram registros diferentes.
- Erros HTTP: `400` dados/consulta inválidos, `401` token ausente/recusado, `403` perfil/MFA não permitido, `404` turma inacessível, `405` método, `409` turma inativa, `415` conteúdo diferente de JSON e `503` indisponibilidade/resposta inválida. Sessão encerrada recusada pela RLS pode retornar `404` na consulta, sem expor a turma.

### Teste manual da API

Rodar `npm run dev:full` com o Supabase de testes. Entrar como professor e concluir MFA. Para testar a API diretamente, no console do navegador, apenas no ambiente local:

```js
const { supabase } = await import('/src/lib/supabase.ts');
const { data, error } = await supabase.auth.getSession();
if (error || !data.session) throw new Error('Entre novamente e conclua o MFA.');
const headers = {
  Authorization: `Bearer ${data.session.access_token}`,
  'Content-Type': 'application/json',
};
const turmasResponse = await fetch('/api/turmas', { headers });
const { turmas } = await turmasResponse.json();
console.table(turmas.map(({ id, nome }) => ({ id, nome })));
```

Escolher uma turma ativa própria e preencher seu UUID abaixo. O POST cria um rascunho real no ambiente de testes; executar uma vez:

```js
const turmaId = 'UUID_DA_TURMA';
const criacao = await fetch('/api/avaliacoes', {
  method: 'POST', headers,
  body: JSON.stringify({
    turma_id: turmaId, titulo: 'Prova demonstrativa', tipo: 'PROVA',
    inicio_em: '2026-11-09T19:00:00-03:00', fim_em: '2026-11-09T21:00:00-03:00',
    duracao_minutos: 60,
  }),
});
console.log(criacao.status, await criacao.json());
const consulta = await fetch(`/api/avaliacoes?turma_id=${turmaId}`, { headers });
console.log(consulta.status, await consulta.json());
```

Esperado: `201` com `RASCUNHO`, depois `200` contendo o mesmo ID. Conferir `AVALIACAO_CRIADA` no banco; GET não gera evento. Não compartilhar token, sessão, cabeçalhos ou capturas deles. Ao trocar de conta, recarregar a página e obter os cabeçalhos da nova sessão; ADMIN deve consultar e receber `403` ao criar, aluno deve receber `403` nas duas operações e outro professor deve receber `404` para a turma alheia.

`tests/avaliacoes-sql.test.ts` agora também cobre API integrada ao banco local, limite/ordem, métodos, validação, isolamento, auditoria e falhas de Auth/transporte/contrato. Auth e HTTP são simulados; nenhum registro é criado no Supabase remoto pelos testes. Executar `node --test tests/avaliacoes-sql.test.ts`, `npm test`, `npm run lint` e `npm run build`.

Referências da API: [identidade no servidor](https://supabase.com/docs/reference/javascript/auth-getuser), [RPC](https://supabase.com/docs/reference/javascript/rpc), [consulta](https://supabase.com/docs/reference/javascript/select), [Vercel Functions](https://vercel.com/docs/functions/runtimes/node-js).

### Teste manual da API de edição

Com a `020` aplicada, rodar `npm run dev:full` e entrar como professor com MFA. Escolher uma avaliação de teste da própria turma ativa e substituir o ID abaixo. Executar no console do navegador; a chamada altera esse rascunho:

```js
await (async () => {
  const { supabase } = await import('/src/lib/supabase.ts');
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session) throw new Error('Entre novamente e conclua o MFA.');
  const resposta = await fetch('/api/avaliacoes', {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${data.session.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      avaliacao_id: 'UUID_DA_AVALIACAO',
      titulo: 'Atividade revisada pela API', tipo: 'ATIVIDADE',
      inicio_em: '2026-11-09T19:00:00-03:00', fim_em: '2026-11-09T21:00:00-03:00',
      duracao_minutos: 45,
    }),
  });
  console.log(resposta.status, await resposta.json());
})();
```

1. Esperado: `200` com a avaliação atualizada. Conferir em **Turmas → Rascunhos → Atualizar rascunhos** e na tabela `avaliacoes`. ID, turma, autor e data de criação permanecem iguais.
2. Conferir um novo `AVALIACAO_EDITADA` em `eventos_seguranca` quando houver mudança. Repetir os mesmos valores: `200`, sem outro evento.
3. Trocar duração por `0`, remover um campo ou acrescentar `turma_id`: `400`, sem alteração nem evento.
4. Recarregar a página ao trocar de conta e repetir com o mesmo ID: admin/aluno recebem `403`; outro professor recebe `404`. Sem MFA, `403`.

Teste automatizado: `node --test tests/avaliacoes-sql.test.ts`. Cobre o PATCH integrado ao banco local, permissões, normalização, auditoria, repetição sem mudanças, rollback e falhas de Auth/RPC/resposta. Auth e HTTP são simulados; não acessa Supabase remoto.

## Formulário do professor

Painel → **Nova avaliação**. Campos: turma ativa, título, tipo (Prova/Atividade), início, fim e duração em minutos. A consulta existente de turmas já limita o professor às próprias turmas. API e banco continuam responsáveis pela autorização; esconder o botão não substitui essas regras.

`NovaAvaliacaoPanel` → `criarAvaliacaoRascunho` em `src/services/avaliacoes.ts` → `POST /api/avaliacoes` → função SQL da `019`. Sem nova query ou dependência.

- Datas usam o fuso do navegador, informado junto aos campos, e são convertidas para ISO/UTC antes do envio.
- Validação indica e foca o campo inválido. Reutiliza o contrato `lerDadosAvaliacao` antes de enviar.
- Durante o envio, campos e atualização de turmas ficam bloqueados. Um segundo envio simultâneo é ignorado.
- Sucesso somente após `201` com rascunho válido e correspondente aos dados enviados. Limpa o formulário; erros preservam os campos.
- Falha de rede/resposta não repete o POST. Conferir a criação em **Turmas → Rascunhos** antes de reenviar. A tela mostra até 50 registros; a consulta direta ao banco permite conferir registros anteriores a esse limite.

### Teste manual do formulário

1. `npm run dev:full`; entrar como professor e concluir MFA.
2. Abrir **Nova avaliação**, selecionar uma turma ativa própria e criar uma Prova. Repetir com Atividade.
3. Conferir `RASCUNHO` em `avaliacoes` e `AVALIACAO_CRIADA` em `eventos_seguranca`. A avaliação pertence à turma inteira.
4. Tentar título vazio/curto, fim igual ou anterior ao início e duração zero/fracionada. Nenhum registro deve ser criado.
5. Conferir que turma inativa não aparece, professor sem turma ativa não consegue enviar e aluno/administrador não têm esse botão.

Teste automatizado do formulário e serviço: `npm run test:ui -- tests/nova-avaliacao.test.tsx tests/app-cadastro.test.tsx`. Usa respostas simuladas; não grava no Supabase.

Referências do formulário: [inputs no React](https://react.dev/reference/react-dom/components/input), [datas locais e fuso horário](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/input/datetime-local).

## Listagem por turma

Em **Turmas → Rascunhos**, professor consulta as próprias turmas e admin consulta as turmas disponíveis pela RLS. Turmas inativas continuam consultáveis. Aluno não tem acesso à tela nem à API.

`TurmasPanel` → `RascunhosTurmaPanel` → `listarAvaliacoesRascunho` → `GET /api/avaliacoes?turma_id=UUID` → consultas protegidas pela RLS. Sem nova query, dependência ou alteração no backend.

- Tabela com título, tipo, início, fim, duração e situação. Datas no fuso do navegador. No celular, a rolagem horizontal fica dentro da tabela, também acessível por teclado.
- Até 50 rascunhos, na ordem recebida da API (criação mais recente primeiro). Ainda sem paginação.
- Consulta somente ao abrir a turma ou clicar em **Atualizar rascunhos**. Trocar de turma ou fechar o painel ignora respostas atrasadas.
- Resposta inválida ou erro não aparece como lista vazia. Uma falha ao atualizar oculta o resultado anterior.
- A consulta não gera eventos. Professor pode abrir a edição nas turmas ativas; admin e turmas inativas permanecem somente para consulta.

Teste manual: executar `npm run dev:full`, entrar como professor com MFA, abrir **Turmas → Rascunhos** e conferir os registros criados no bloco anterior. Testar **Atualizar rascunhos**, outra turma sem avaliações e uma turma inativa. Repetir como admin e confirmar que aluno não acessa Turmas. Conferir datas/duração e, no celular, rolar a tabela para ler as últimas colunas.

Teste automatizado: `npm run test:ui -- tests/rascunhos-turma.test.tsx`. Cobre consulta por perfil, turma inativa, campos/ordem, lista vazia, atualização, respostas atrasadas, sessão, falhas e validação do contrato. HTTP/Auth simulados, sem acesso ao Supabase remoto.

Referências da listagem: [consultas em efeitos React](https://react.dev/reference/react/useEffect#fetching-data-with-effects), [tabelas HTML acessíveis](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/table).

## Formulário de edição

**Turmas → Rascunhos → Editar**. Disponível ao professor nas turmas ativas retornadas pela API. As regras de autoria, sessão e MFA continuam sendo conferidas no servidor e no banco.

`RascunhosTurmaPanel` → `EditarAvaliacaoForm` → `editarAvaliacaoRascunho` → `PATCH /api/avaliacoes` → função SQL da `020`. Sem nova query ou dependência.

- Campos preenchidos: título, tipo, início, fim e duração. Turma e autor não são editáveis.
- `CamposAvaliacao` e `avaliacaoForm.ts` concentram os campos, mensagens e conversão de datas usados também na criação. Cada formulário mantém sua operação de envio.
- Datas aparecem no fuso do navegador. Se o horário não mudar, o envio preserva o instante original, inclusive segundos existentes no banco.
- Erro de validação foca o campo; erro da API mantém os valores e foca a mensagem. Enquanto salva, campos, cancelamento e outros botões de edição ficam bloqueados. Não há repetição automática da gravação.
- Sucesso atualiza somente a linha correspondente, mantém a ordem e foca a confirmação. Cancelar descarta os valores locais e devolve o foco ao botão Editar.
- Fechar ou trocar de turma ignora uma resposta atrasada na tela; uma gravação já enviada pode concluir no servidor. Consultar novamente antes de reenviar. Ainda não há detecção de alterações simultâneas: vale a última gravação aceita.

Teste manual, com a `020` aplicada e `npm run dev:full`:

1. Entrar como professor com MFA; abrir **Turmas → Rascunhos → Editar** e conferir os valores preenchidos.
2. Alterar título, tipo, datas ou duração e salvar. Conferir a linha, atualizar a lista e verificar `AVALIACAO_EDITADA` no banco quando houver mudança.
3. Alterar um campo e cancelar: a linha permanece igual. Abrir novamente e salvar sem mudanças: nenhum evento adicional.
4. Testar título curto, fim anterior ao início e duração zero. O campo recebe foco e nada é enviado.
5. Conferir que admin e turma inativa não apresentam Editar. Testar teclado e celular, incluindo rolagem horizontal da tabela.

Teste automatizado: `npm run test:ui -- tests/nova-avaliacao.test.tsx tests/rascunhos-turma.test.tsx`. Cobre criação após o reaproveitamento dos campos, preenchimento/edição, cancelamento, perfis, fuso, preservação de segundos, validação, envio duplicado e respostas atrasadas ou inválidas. Usa Auth/HTTP simulados, sem gravar no Supabase.

## Formulário de questões

**Turmas → Rascunhos → Nova questão**, na linha da avaliação. Disponível ao professor nas turmas ativas. ADMIN e turmas inativas não apresentam a ação. API e banco continuam verificando as permissões.

`RascunhosTurmaPanel` → `NovaQuestaoForm` → `criarQuestaoRascunho` em `src/services/questoes.ts` → `POST /api/questoes` → função SQL da `021`. Sem nova query ou dependência.

- A avaliação é a escolhida na tabela. Campos: tipo (Objetiva/Dissertativa), enunciado e pontuação. Vírgula e ponto são aceitos como separador decimal, sem separador de milhar.
- `questaoValidation.ts` compartilha as regras de enunciado e pontuação com o formulário, serviço e API. O limite de 10.000 caracteres conta pontos de código Unicode, como o banco; não usa o corte por unidades UTF-16 do `maxlength` do navegador.
- Erro de campo recebe foco e mensagem associada. Durante o envio, campos e cancelamento ficam bloqueados; um segundo envio simultâneo é ignorado. Edição da avaliação e criação de questão não ficam abertas ao mesmo tempo.
- Sucesso exige `201` e resposta válida correspondente aos dados enviados. Fecha o formulário e foca a confirmação com o número da questão e o título da avaliação. Erros mantêm os campos e focam a mensagem. Cancelar descarta os valores locais e devolve o foco ao botão da avaliação.
- Fechar ou trocar de turma ignora respostas atrasadas na tela. Uma gravação já enviada pode concluir no servidor. Em falha de conexão/resposta, conferir em **Questões** na avaliação antes de reenviar; não há repetição automática.
- Este formulário cria somente a questão. Para cadastrar alternativas e gabarito, abrir **Questões → Alternativas**. A questão objetiva permanece em rascunho sem alternativas até o cadastro delas.

Teste manual, com a `021` aplicada e `npm run dev:full`:

1. Entrar como professor com MFA e abrir **Turmas → Rascunhos → Nova questão** em uma turma ativa.
2. Cadastrar uma questão objetiva e uma dissertativa. Testar pontuação `2,5` e `0.29`.
3. Conferir avaliação, enunciado, tipo, pontuação e ordem na tabela `questoes`, além de `QUESTAO_CRIADA` em `eventos_seguranca`.
4. Testar enunciado vazio/curto e pontuação `0`, `2,555` ou `10000`: erro no campo, sem envio. Preencher e cancelar: nenhum registro criado.
5. Conferir ausência da ação como ADMIN e em turma inativa. Testar teclado, celular e enunciado longo. Alternativas não são criadas por esse formulário.

Teste automatizado: `npm run test:ui -- tests/nova-questao.test.tsx tests/rascunhos-turma.test.tsx`. Cobre os dois tipos, avaliação escolhida, perfis, validação, Unicode, decimais, foco, cancelamento, envio duplo, sessão, falhas e resposta atrasada/inválida. Auth/HTTP simulados, sem gravação no Supabase remoto.

Referências: [textarea no React](https://react.dev/reference/react-dom/components/textarea), [select no React](https://react.dev/reference/react-dom/components/select), [limpeza de efeitos](https://react.dev/reference/react/useEffect#fetching-data-with-effects).

## Listagem de questões por avaliação

**Turmas → Rascunhos → Questões**, na linha da avaliação. Professor responsável e ADMIN podem consultar, inclusive em turma inativa, conforme as permissões da API e do banco.

`RascunhosTurmaPanel` → `QuestoesAvaliacaoPanel` → `listarQuestoesRascunho` em `src/services/questoes.ts` → `GET /api/questoes?avaliacao_id=UUID`. Sem nova query, dependência ou alteração na API.

- Lista ordenada com número, tipo, pontuação e enunciado completo. Preserva quebras de linha e apresenta o conteúdo como texto, sem interpretar HTML.
- Consulta ao abrir e ao clicar em **Atualizar questões**. Uma avaliação aberta por vez; respostas atrasadas são ignoradas ao fechar ou trocar de avaliação/turma.
- Estados de carregamento, erro e lista vazia. Falhas não exibem os registros da consulta anterior nem são tratadas como lista vazia.
- As primeiras 50 questões são exibidas em ordem de cadastro, conforme o limite atual da API. Sem paginação. Questões objetivas apresentam o botão **Alternativas** para cadastro ou consulta do gabarito.
- Abrir criação/edição fecha a lista. Depois de salvar, reabrir **Questões** busca os dados atualizados.

Teste manual com `npm run dev:full`:

1. Como professor, abrir uma avaliação com questões e conferir ordem, tipo, pontuação e enunciados. Testar texto longo e quebras de linha no celular.
2. Trocar para uma avaliação sem questões e conferir a mensagem de lista vazia; voltar e atualizar.
3. Criar uma questão, reabrir **Questões** e confirmar o novo registro (dentro das primeiras 50 posições).
4. Consultar como ADMIN e em turma inativa: a listagem continua disponível, sem ações de criação/edição.

Teste automatizado: `npm run test:ui -- tests/questoes-avaliacao.test.tsx tests/rascunhos-turma.test.tsx tests/nova-questao.test.tsx`. Auth/HTTP simulados. Cobre navegação, perfis, atualização, estados, respostas atrasadas e validação do contrato da API.

Referências: [listas no React](https://react.dev/learn/rendering-lists), [consultas e limpeza de efeitos](https://react.dev/reference/react/useEffect#fetching-data-with-effects).

## API de alternativas e gabarito

Requer a `022` já aplicada. Nenhuma query nova. `api/alternativas.ts` está registrada em `scripts/api-dev.ts`, seguindo o formato das funções da Vercel.

- `POST /api/alternativas`: recebe somente `questao_id`, `alternativas` (lista de textos) e `ordem_correta` (posição de 1 a 5). Retorna `201` com `{ alternativas }`.
- `GET /api/alternativas?questao_id=UUID`: retorna `200` com `{ alternativas }`, ordenadas de 1 a 5. Questão objetiva acessível sem alternativas retorna lista vazia. Questão inexistente, alheia ou fora de rascunho retorna `404`; dissertativa acessível retorna `400`.
- Cada alternativa contém `id`, `questao_id`, `texto`, `ordem`, `correta` e `criado_em`. Exatamente uma tem `correta: true`. Campo restrito ao professor responsável e ADMIN; aluno não acessa esta rota.
- Autenticação: `Authorization: Bearer <access_token>`. Reutiliza `conferirAcessoAvaliacoes`, chave pública e JWT do usuário. RLS e função SQL mantêm as regras de autoria, organização, sessão e MFA.
- Cadastro: professor autor, turma ativa, avaliação em rascunho e questão objetiva ainda sem alternativas. De 2 a 5 textos distintos, com 1 a 2.000 caracteres Unicode após remover espaços nas extremidades. `ordem_correta` deve ser inteiro e apontar para um item da lista. Não aceita campos extras, texto vazio ou caractere nulo.
- Fluxo de gravação: validação → Auth/perfil → `criar_alternativas_rascunho` da `022` → alternativas e `ALTERNATIVAS_CRIADAS` na mesma transação. Repetição retorna `409`, sem sobrescrever. Nenhum reenvio automático de cadastro.
- Respostas sem cache. JSON/entrada inválida: `400`; sessão inválida: `401`; perfil/MFA sem permissão: `403`; recurso fora do acesso: `404`; conflito de estado: `409`; tipo de conteúdo incorreto: `415`; serviço ou resposta inválida: `503`.
- A resposta do banco é validada antes de confirmar: questão correta, IDs únicos, ordem sequencial, textos válidos e exatamente uma correta. No POST, o conjunto também deve corresponder ao enviado. Uma falha após a gravação exige consulta antes de reenviar.

### Teste manual da API

1. Executar `npm run dev:full` e entrar como professor com MFA.
2. Copiar da tabela `questoes` o ID de uma questão objetiva da própria turma ativa, em rascunho e ainda sem alternativas.
3. No console do navegador local, substituir o ID e executar. O POST cria registros no Supabase configurado:

```js
const { supabase: supabaseApiAlt } = await import('/src/lib/supabase.ts');
const { data: authApiAlt } = await supabaseApiAlt.auth.getSession();
const questaoApiAlt = 'COLE_O_ID_DA_QUESTAO';
const headersApiAlt = {
  Authorization: `Bearer ${authApiAlt.session.access_token}`,
  'Content-Type': 'application/json',
};
const cadastroApiAlt = await fetch('/api/alternativas', {
  method: 'POST',
  headers: headersApiAlt,
  body: JSON.stringify({
    questao_id: questaoApiAlt,
    alternativas: ['Testar uma função isolada', 'Testar a comunicação entre componentes', 'Alterar dados em produção'],
    ordem_correta: 2,
  }),
});
console.log(cadastroApiAlt.status, await cadastroApiAlt.json());
const consultaApiAlt = await fetch(`/api/alternativas?questao_id=${questaoApiAlt}`, {
  headers: headersApiAlt, cache: 'no-store',
});
console.log(consultaApiAlt.status, await consultaApiAlt.json());
```

4. Esperado: POST `201`, GET `200`, três alternativas ordenadas e somente a segunda correta. Conferir `ALTERNATIVAS_CRIADAS` em `eventos_seguranca`, com `recurso_id` igual ao ID da questão.
5. Repetir o POST: `409`, sem duplicar alternativas ou evento. Em outra questão, testar texto vazio/repetido ou posição correta `0`: `400`, sem gravação.
6. Ao trocar de conta, recarregar a página e obter a nova sessão. ADMIN consulta e recebe `403` no cadastro; aluno recebe `403`; outro professor recebe `404`, sem gabarito.

Teste automatizado: `node --test tests/alternativas-api.test.ts tests/questoes-api.test.ts`. A preparação do banco em `tests/helpers/bancoAvaliacoes.ts` é compartilhada pelos dois testes. Auth/HTTP são simulados; funções SQL, RLS, constraints e transações executam no PGlite. Inclui rollback quando a auditoria falha. Não acessa Supabase remoto nem testa concorrência entre conexões reais.

Referências: [RPC no Supabase](https://supabase.com/docs/reference/javascript/rpc), [validação de usuário](https://supabase.com/docs/reference/javascript/auth-getuser), [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security).

## Formulário e consulta de alternativas

**Turmas → Rascunhos → Questões → Alternativas**, disponível nas questões objetivas. Professor autor pode cadastrar em turma ativa; ADMIN e professor de turma inativa apenas consultam. API e banco conferem as permissões a cada operação.

`QuestoesAvaliacaoPanel` → `AlternativasQuestaoPanel` → `AlternativasForm` → `src/services/alternativas.ts` → `/api/alternativas` → regras da `022`. Sem nova query ou dependência.

- Ao abrir, consulta as alternativas. Se não houver nenhuma e o professor puder cadastrar, apresenta o formulário com dois campos.
- De 2 a 5 alternativas distintas, até 2.000 caracteres Unicode por texto. Adiciona ao final ou remove a última, mantendo pelo menos duas. Remover a alternativa marcada como correta exige selecionar outra.
- O campo **Alternativa correta** define uma única resposta. `alternativaValidation.ts` compartilha a validação com o formulário, serviço e API.
- Erro de campo recebe foco; falha da API mantém os valores e foca a mensagem. Durante o envio, campos e botões do formulário ficam bloqueados, sem repetição automática do POST.
- Ao salvar, apresenta a lista em ordem A–E e marca a resposta correta. Alternativas existentes são somente consultadas neste bloco. Textos completos, com quebras de linha e sem interpretar HTML.
- **Cancelar** descarta o preenchimento e devolve o foco ao botão da questão. Fechar ou trocar de questão/turma ignora respostas atrasadas na tela; uma gravação já enviada pode concluir no servidor. Em falha de conexão ou confirmação, fechar e reabrir **Alternativas** antes de reenviar.
- Carregamento e falha de consulta não apresentam formulário nem lista antiga. **Atualizar alternativas** refaz a consulta e fica desabilitado durante o preenchimento.

Teste manual, com a `022` aplicada e `npm run dev:full`:

1. Entrar como professor com MFA e abrir uma questão objetiva sem alternativas da própria turma ativa.
2. Preencher duas alternativas distintas, selecionar a correta e salvar. Conferir a lista, fechar e reabrir, verificando que não aparece outro formulário.
3. Em outra questão, cadastrar cinco alternativas. Antes de salvar, testar campo vazio, texto repetido, mais de 2.000 caracteres e ausência de gabarito: erro sem gravação. Testar remoção da última alternativa e cancelamento.
4. Conferir `ALTERNATIVAS_CRIADAS` em `eventos_seguranca`, com `recurso_id` igual ao ID da questão. Nenhuma query adicional é necessária para a interface.
5. Como ADMIN e em turma inativa, conferir consulta sem cadastro. Questões dissertativas não apresentam **Alternativas**. Testar teclado, celular e texto longo.

Teste automatizado: `npm run test:ui -- tests/alternativas-form.test.tsx tests/questoes-avaliacao.test.tsx tests/rascunhos-turma.test.tsx`. Cobre cadastro, consulta, gabarito, limites, cancelamento, perfis, foco, erros, envio duplicado e respostas atrasadas/inválidas. Auth/HTTP simulados, sem gravação no Supabase remoto.

Referências: [textarea no React](https://react.dev/reference/react-dom/components/textarea), [select no React](https://react.dev/reference/react-dom/components/select), [atualização de arrays no estado](https://react.dev/learn/updating-arrays-in-state).

## Publicação no banco e na API (023)

Com a `022` já aplicada, executar somente `database/023_publicar_avaliacao.sql` no Supabase de testes. Preserva os rascunhos e eventos existentes. A interface de publicação usa essa mesma query, sem outra migração ou dependência.

`POST /api/publicar-avaliacao` → Auth/perfil → `public.publicar_avaliacao` → função privada → atualização e auditoria na mesma transação. A rota separa a publicação da edição de campos e está registrada no servidor local.

- Recebe somente `{ "avaliacao_id": "UUID" }`, com `Content-Type: application/json` e `Authorization: Bearer <access_token>`. Reutiliza a chave pública e a sessão do usuário, sem chave administrativa.
- Somente professor autor ainda responsável pela turma, com perfil, organização e turma ativos, sessão própria e MFA `aal2`. ADMIN consulta, mas não publica. Avaliação inexistente e avaliação alheia retornam a mesma resposta.
- Exige `RASCUNHO`, ao menos uma questão e, para cada objetiva, de 2 a 5 alternativas distintas e sequenciais, com exatamente uma correta. Dissertativas não podem ter alternativas. Campos e pontuações positivas continuam protegidos pelas constraints existentes.
- A janela deve terminar depois do horário atual do banco, e a duração deve caber no intervalo entre início e fim. Pode publicar antes do início ou com a janela em andamento. São decisões desta implementação; a query `025` limita o prazo da tentativa ao encerramento da janela.
- Usa o mesmo bloqueio da avaliação que a edição e a criação de questões/alternativas. Depois de publicar, essas funções recusam alterações. Escrita direta permanece sem permissão.
- Define `PUBLICADA` e `publicada_em` e registra `AVALIACAO_PUBLICADA`. Falha na auditoria desfaz a publicação. Repetição retorna `409`, sem novo evento ou alteração de data.
- Sucesso: `200` com `{ avaliacao: { id, situacao: 'PUBLICADA', publicada_em } }`. A API valida a confirmação e não devolve questões ou gabarito. Todas as respostas usam `Cache-Control: no-store`.
- Erros: `400` para entrada ou preparação inválida; `401` para sessão inválida; `403` para perfil/MFA; `404` para avaliação fora do acesso; `409` para turma inativa ou situação diferente de rascunho; `415` para conteúdo não JSON; `503` para indisponibilidade ou confirmação inválida.
- A avaliação publicada deixa a lista de rascunhos e pode ser consultada em **Turmas → Publicadas**. As políticas de questões/alternativas continuam restritas aos rascunhos e não liberam acesso ao aluno.

### Teste manual da publicação

1. Aplicar a `023`, executar `npm run dev:full` e entrar como professor com MFA.
2. Criar uma avaliação de teste da própria turma ativa, com fim no futuro, duração que caiba na janela, questões e gabarito completo. Copiar o ID de `avaliacoes`.
3. No console do navegador local, substituir o ID e executar. Essa chamada publica a avaliação e bloqueia sua edição:

```js
const { supabase: supabasePublicacao } = await import('/src/lib/supabase.ts');
const { data: sessaoPublicacao } = await supabasePublicacao.auth.getSession();
const avaliacaoPublicacaoId = 'COLE_O_ID_DA_AVALIACAO';
const respostaPublicacao = await fetch('/api/publicar-avaliacao', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${sessaoPublicacao.session.access_token}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ avaliacao_id: avaliacaoPublicacaoId }),
});
console.log(respostaPublicacao.status, await respostaPublicacao.json());
const consultaPublicacao = await supabasePublicacao.from('avaliacoes')
  .select('id,situacao,publicada_em').eq('id', avaliacaoPublicacaoId).single();
console.log(consultaPublicacao);
```

4. Esperado: `200`, situação `PUBLICADA`, data preenchida e um evento `AVALIACAO_PUBLICADA` em `eventos_seguranca`, com `recurso_id` igual ao ID da avaliação. Atualizar **Rascunhos**: ela sai dessa lista.
5. Repetir o envio: `409`, sem novo evento. Tentar editar a avaliação pela API anterior ou cadastrar uma questão nela: `409`. A estrutura permanece igual.
6. Em outros rascunhos, testar ausência de questões, objetiva sem alternativas, janela encerrada e duração maior que a janela: `400`, permanecendo em `RASCUNHO` e sem evento de publicação.
7. Ao trocar de conta, recarregar e obter a nova sessão. ADMIN/aluno recebem `403`; outro professor recebe `404`. Sem MFA, publicação recusada. Em falha de conexão, consultar a situação antes de reenviar: não há repetição automática.

Testes: `node --test tests/publicar-avaliacao.test.ts`. Cobrem Prova/Atividade, campos, gabarito, janela, perfis, MFA/sessões, bloqueio de estrutura, rollback, resposta perdida e reaplicação. Usam PGlite com SQL e RLS reais, Auth/HTTP simulados. Não acessam Supabase remoto nem simulam concorrência entre conexões PostgreSQL independentes.

Referências: [funções e permissões no Supabase](https://supabase.com/docs/guides/database/functions), [RPC](https://supabase.com/docs/reference/javascript/rpc), [bloqueios de linha no PostgreSQL](https://www.postgresql.org/docs/current/explicit-locking.html).

## Publicação e consulta na interface

**Turmas → Rascunhos → Publicar**. Disponível ao professor nas turmas ativas; confirmação com o título e aviso do bloqueio da estrutura. ADMIN e professor de turma inativa apenas consultam. A autorização definitiva permanece na API e no banco.

- `PublicarAvaliacaoForm` → `publicarAvaliacao` em `src/services/avaliacoes.ts` → `POST /api/publicar-avaliacao`. Cancelar devolve o foco ao botão sem enviar. Confirmar bloqueia os controles durante o envio, sem repetir o POST.
- Sucesso remove a linha do rascunho, foca a confirmação e atualiza a lista de publicadas caso esteja aberta. Erro mantém o rascunho e foca a mensagem. Fechar ou trocar de turma ignora respostas atrasadas; o servidor pode concluir uma publicação já enviada. Conferir **Publicadas** e atualizar **Rascunhos** antes de reenviar após falha de conexão.
- **Turmas → Publicadas** abre `PublicadasTurmaPanel` → `listarAvaliacoesPublicadas` → `GET /api/avaliacoes?turma_id=UUID&situacao=PUBLICADA`. Exibe título, tipo, início, fim, duração e data da publicação, em horário local. Professor responsável e ADMIN podem consultar, inclusive em turma inativa.
- Consulta ao abrir e ao clicar em **Atualizar publicadas**. Estados de carregamento, erro e vazio; erros não mostram a lista anterior. Tabela com rolagem horizontal e foco por teclado no celular. Até 50 publicações mais recentes, sem paginação neste bloco.
- Listagem somente dos dados da avaliação: sem edição, questões, gabarito ou execução pelo aluno. A consulta não gera evento de auditoria.
- `avaliacaoValidation.ts` compartilha os contratos da confirmação e da avaliação publicada entre API e navegador. As duas listagens reaproveitam autenticação, requisição e validação da coleção, mantendo o contrato de rascunhos. Sem nova dependência.

Teste manual com a `023` aplicada e `npm run dev:full`:

1. Como professor, abrir **Turmas → Rascunhos → Publicar** em uma avaliação completa. Cancelar: nenhuma publicação. Abrir novamente e confirmar.
2. Conferir a mensagem, a saída da lista de rascunhos e a entrada em **Publicadas**. Fechar e reabrir a lista; conferir `PUBLICADA`, `publicada_em` e `AVALIACAO_PUBLICADA` no banco.
3. Publicar um rascunho sem questões ou sem gabarito: mensagem de erro, sem remover a linha. Corrigir o rascunho antes de publicar novamente.
4. Entrar como ADMIN: consultar **Publicadas**, sem botão Publicar nos rascunhos. Conferir também uma turma inativa.
5. Testar título longo, teclado e celular, incluindo a rolagem da tabela. Com **Publicadas** já aberta, publicar outra avaliação e conferir a atualização automática.

Testes de interface: `npm run test:ui -- tests/publicacao-avaliacao.test.tsx tests/rascunhos-turma.test.tsx`. Auth/HTTP simulados. Cobrem confirmação, cancelamento, foco, envio duplicado, perfis, consulta, erros, respostas atrasadas e contratos inválidos.

Teste da consulta no banco/API: `node --test tests/publicar-avaliacao.test.ts`. Inclui filtro por situação, isolamento, turma inativa, lista vazia, limite/ordenação, ausência de gabarito e falhas do serviço.

Referências: [consultas e limpeza de efeitos no React](https://react.dev/reference/react/useEffect#fetching-data-with-effects), [ordenação no Supabase](https://supabase.com/docs/reference/javascript/order).

## Consulta de avaliações pelo aluno (024)

Aplicar `database/024_listar_minhas_avaliacoes.sql` depois da `023`. A interface abaixo usa essa mesma query.

`GET /api/minhas-avaliacoes` → Supabase Auth → `public.listar_minhas_avaliacoes` → função privada. A API usa a chave pública e a sessão do aluno. Sem parâmetros: o banco identifica o aluno pela sessão.

- Exige aluno e organização ativos, sessão própria existente e MFA `aal2`.
- Retorna somente avaliações `PUBLICADA` de turmas ativas da mesma organização, com matrícula `ATIVA` do aluno. Sem matrícula válida, retorna lista vazia.
- Até 50 registros, por publicação mais recente e ID decrescente no desempate. Inclui avaliações futuras, em andamento e encerradas; aparecer na lista não autoriza iniciar uma tentativa.
- Resposta `{ avaliacoes: [...] }`: ID, turma, nome da turma, título, tipo, início, fim, duração, situação e data da publicação. Não retorna questões, alternativas, gabarito ou dados de outros alunos.
- Mantém as políticas existentes das tabelas. A função confere os vínculos antes de retornar os campos permitidos; consulta direta de avaliações, questões e alternativas continua bloqueada para o aluno.
- Erros: `400` para parâmetros, `401` para sessão inválida, `403` para perfil/MFA, `405` para método diferente de GET e `503` para falha de serviço ou resposta inválida. Respostas sem cache. A consulta não altera dados nem cria evento de auditoria.

Teste manual com `npm run dev:full`:

1. Aplicar a `024` no Supabase de testes. Como professor, publicar uma avaliação em turma ativa com aluno matriculado.
2. Entrar como esse aluno, concluir o MFA e executar no console do navegador local:

```js
const { supabase: supabaseAluno } = await import('/src/lib/supabase.ts');
const { data: sessaoAluno } = await supabaseAluno.auth.getSession();
const respostaAluno = await fetch('/api/minhas-avaliacoes', {
  headers: { Authorization: `Bearer ${sessaoAluno.session.access_token}` },
  cache: 'no-store',
});
console.log(respostaAluno.status, await respostaAluno.json());
```

3. Esperado: `200` com a avaliação, sem questões/gabarito. Rascunhos e avaliações de turmas sem matrícula ativa não aparecem.
4. Como professor/admin, inativar a matrícula de teste pela tela. Entrar novamente como aluno e repetir a consulta: a avaliação dessa turma não aparece.
5. A mesma chamada como professor ou ADMIN retorna `403`; sem autenticação, `401`.

Teste automatizado: `node --test tests/minhas-avaliacoes.test.ts`. Executa permissões e RLS no PostgreSQL local (PGlite), com Auth/HTTP simulados. Cobre isolamento entre alunos e organizações, matrículas/sessões, MFA, dados restritos, ordenação/limite e falhas. Não acessa o Supabase remoto.

Referências: [funções e permissões no Supabase](https://supabase.com/docs/guides/database/functions), [verificação de usuário](https://supabase.com/docs/reference/javascript/auth-getuser), [chamada RPC](https://supabase.com/docs/reference/javascript/rpc).

## Minhas avaliações no painel do aluno

**Minhas avaliações** aparece somente para Aluno. Lista título, turma, tipo, início, fim e duração. Horários no fuso do navegador, indicado acima da tabela. Mantém a ordem e o limite de 50 publicações definidos pela API.

`App` → `MinhasAvaliacoesPanel` → `listarMinhasAvaliacoes` em `src/services/avaliacoes.ts` → `GET /api/minhas-avaliacoes` → query `024`.

- Reutiliza o contrato `AvaliacaoAluno`, a validação `lerMinhasAvaliacoes` e os estilos de tabela existentes. Sem dependências ou query adicionais.
- **Atualizar** consulta novamente e fica desabilitado durante o carregamento. Carregamento, vazio e erro têm mensagens próprias; falha oculta a lista anterior. Resposta atrasada de uma tela fechada é ignorada.
- Foco no título ao abrir; tabela com cabeçalhos e rolagem horizontal acessível por teclado no celular. Textos longos quebram linha, sem interpretar HTML.
- A listagem agora tem botão de início, descrito abaixo. Os links legais permanecem no rodapé. Respostas na interface e resultados continuam pendentes.

Teste manual com a `024` aplicada e `npm run dev:full`:

1. Entrar como aluno com MFA e matrícula ativa em uma turma com avaliação publicada. Abrir **Minhas avaliações** e conferir os campos.
2. Publicar outra avaliação como professor; no aluno, clicar em **Atualizar** e conferir sua inclusão. Rascunhos não aparecem.
3. Sem avaliações acessíveis, conferir a mensagem de lista vazia. Inativar uma matrícula de teste pelo professor/admin e atualizar a lista do aluno: avaliações dessa turma deixam de aparecer.
4. Conferir celular, título longo, navegação por teclado, rolagem da tabela e links legais. Professor e ADMIN não apresentam o botão **Minhas avaliações**.
5. Interromper a API local e clicar em **Atualizar**: exibe erro sem a lista antiga. Reiniciar a API e atualizar novamente.

Testes: `npm run test:ui -- tests/minhas-avaliacoes-panel.test.tsx tests/app-cadastro.test.tsx tests/minhas-matriculas.test.tsx`. Usam o serviço real do frontend com sessão e HTTP simulados; cobrem consulta, atualização, perfis, foco, respostas inválidas/atrasadas e estados da tela. Conferência visual em desktop e celular com dados fictícios, sem acesso ao Supabase remoto.

Referência: [consultas e limpeza de efeitos no React](https://react.dev/reference/react/useEffect#fetching-data-with-effects).

## Início da tentativa no banco (025)

Aplicar `database/025_iniciar_tentativa.sql` depois da `024`. Cria `tentativas` e a função `public.iniciar_tentativa(p_avaliacao_id)`, usada pela API descrita abaixo. O botão na interface ainda está pendente.

- Tabela: `id`, `avaliacao_id`, `aluno_id`, `situacao`, `iniciada_em` e `limite_em`. A situação inicial é `EM_ANDAMENTO`; finalização e cancelamento serão adicionados em etapas próprias.
- Exige aluno e organização ativos, sessão própria existente, MFA `aal2`, turma da mesma organização e matrícula `ATIVA`.
- Avaliação deve estar `PUBLICADA`, em turma ativa. Horário permitido: início inclusivo e fim exclusivo, conferidos pelo relógio do banco após possíveis esperas por bloqueios.
- `limite_em` recebe o menor valor entre `iniciada_em + duração` e o fim da janela. O navegador não informa aluno, situação ou horários.
- A constraint única `(avaliacao_id, aluno_id)` impede uma segunda tentativa. `INSERT ... ON CONFLICT DO NOTHING` resolve a disputa pela mesma combinação; repetição é recusada, sem retomar ou reiniciar a tentativa existente.
- Bloqueios de leitura preservam perfil, organização, sessão, turma, matrícula e avaliação durante o início. A função não bloqueia exclusivamente a avaliação inteira para todos os alunos.
- Registra `TENTATIVA_INICIADA`, com `usuario_id` do aluno e `recurso_id` da tentativa. Tentativa e evento são atômicos: falha na auditoria desfaz ambos.
- A lista de eventos também aceita `RESPOSTA_SALVA`, `TENTATIVA_FINALIZADA` e `TENTATIVA_RETOMADA`, encontrados no histórico do Supabase. Isso preserva os registros ao aplicar a `025`; não implementa esses fluxos nem permite retomar tentativas. Se a versão anterior falhou com `eventos_seguranca_evento_valido`, copiar e executar a `025` atualizada inteira antes da `026`.
- RLS permite consultar os metadados da própria tentativa, do professor autor ainda responsável pela turma e do ADMIN, reutilizando as regras de sessão/MFA dos helpers existentes. Matrícula inativa preserva essa consulta histórica, mas impede novo início. Mudança de organização retira o acesso do aluno ao histórico da organização anterior.
- Escrita direta e exclusão pela aplicação continuam bloqueadas. Não libera questões, alternativas ou gabarito.

Sucesso retorna os seis campos da tentativa. Erros SQL: `42501` para perfil/sessão/MFA, `P0002` para avaliação inexistente ou sem vínculo autorizado, `55000` para turma/situação/horário indisponível ou tentativa já existente.

Teste manual no Supabase de testes:

1. Aplicar a `025`. Criar e publicar uma avaliação específica para teste, com janela em andamento, e aprovar a matrícula do aluno. O teste consome a tentativa única dessa avaliação.
2. Entrar como aluno com MFA em `npm run dev:full`. No console do navegador, substituir o UUID e executar:

```js
const { supabase: supabaseTentativa } = await import('/src/lib/supabase.ts');
const resultadoTentativa = await supabaseTentativa.rpc('iniciar_tentativa', {
  p_avaliacao_id: 'UUID_DA_AVALIACAO_DE_TESTE',
});
console.log(resultadoTentativa.data, resultadoTentativa.error);
```

3. Conferir os horários retornados, a linha em `tentativas` e o evento `TENTATIVA_INICIADA` em `eventos_seguranca`. Repetir a chamada: erro `55000`, sem segunda linha/evento ou mudança do prazo.
4. Em outra avaliação de teste, conferir a recusa antes do início, sem matrícula ativa, como professor/admin ou sem MFA. Para conferir prazo reduzido, usar avaliação cuja janela já esteja em andamento e termine antes da duração completa a partir de agora.

Teste automatizado: `node --test tests/tentativas-sql.test.ts`. Executa funções, constraints, RLS e rollback no PostgreSQL local (PGlite), com identidades fictícias. PGlite serializa transações; chamadas enfileiradas e unicidade são testadas, mas não conexões simultâneas reais do Supabase. Nenhuma consulta ou gravação remota é feita pelos testes.

Pendentes neste fluxo: interface das respostas, encerramento, controle de saída/desconexão e captura inicial. A criação do registro ainda não representa uma prova executável; ultrapassar `limite_em` não altera a situação automaticamente neste bloco.

Referências: [unicidade no PostgreSQL](https://www.postgresql.org/docs/current/ddl-constraints.html#DDL-CONSTRAINTS-UNIQUE-CONSTRAINTS), [bloqueios de linhas](https://www.postgresql.org/docs/current/explicit-locking.html#LOCKING-ROWS), [funções e permissões no Supabase](https://supabase.com/docs/guides/database/functions).

## API de início da tentativa

`POST /api/iniciar-tentativa` → verificação no Supabase Auth → `public.iniciar_tentativa` → regras e auditoria da query `025`. Mantém o padrão de rotas separadas de `/api/publicar-avaliacao`, registrado também em `scripts/api-dev.ts`. Sem nova query ou dependência.

- Recebe somente `{ "avaliacao_id": "UUID" }`, com `Content-Type: application/json` e `Authorization: Bearer <access_token>`. Recusa parâmetros na URL e campos extras, inclusive aluno, situação e horários.
- Confirma a identidade com `auth.getUser` e chama a função com a chave pública e o token do usuário. As permissões de aluno, MFA e vínculo continuam no banco, inclusive para chamadas diretas à função.
- Sucesso: `201` com `{ tentativa: { id, avaliacao_id, aluno_id, situacao, iniciada_em, limite_em } }`. A API confere o aluno autenticado, a avaliação solicitada, os IDs, a situação e os horários antes de confirmar. `tentativaValidation.ts` concentra o contrato e reaproveita a validação de UUID e datas do projeto. Campos extras não são devolvidos.
- Erros: `400` entrada inválida; `401` sessão inválida; `403` perfil/MFA/sessão sem permissão; `404` avaliação inexistente ou sem acesso; `409` avaliação indisponível para início ou tentativa existente; `415` conteúdo diferente de JSON; `405` método diferente de POST; `503` falha de serviço ou confirmação inválida.
- Respostas usam `Cache-Control: no-store`. Erros internos do Supabase não são enviados ao navegador. Falha ao confirmar o início pode ocorrer depois da gravação; a API não repete a RPC automaticamente nem apaga ou reinicia a tentativa.

Teste manual com a `025` aplicada e `npm run dev:full`:

1. Publicar uma avaliação de teste com janela em andamento. Entrar como aluno com MFA e matrícula ativa. A avaliação não pode ter tentativa anterior desse aluno.
2. No console do navegador, substituir o UUID e executar uma vez. A chamada consome a tentativa única:

```js
const { supabase: supabaseInicio } = await import('/src/lib/supabase.ts');
const { data: sessaoInicio } = await supabaseInicio.auth.getSession();
const respostaInicio = await fetch('/api/iniciar-tentativa', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${sessaoInicio.session.access_token}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ avaliacao_id: 'UUID_DA_AVALIACAO_DE_TESTE' }),
});
console.log(respostaInicio.status, await respostaInicio.json());
```

3. Conferir `201`, os dados retornados, a linha em `tentativas` e `TENTATIVA_INICIADA` em `eventos_seguranca`. Repetir a chamada: `409`, sem novo registro ou alteração de prazo.
4. Como professor/admin, esperar `403`. Sem matrícula ativa, `404`. Em outra avaliação futura ou encerrada, `409`. Campos extras no corpo devem retornar `400`.

Testes: `node --test tests/iniciar-tentativa.test.ts tests/tentativas-sql.test.ts`. Auth/HTTP simulados e SQL executado no PGlite. Incluem a perda de resposta depois de gravar, sem repetição automática, sem acesso ao Supabase remoto.

Referências: [verificação da identidade](https://supabase.com/docs/reference/javascript/auth-getuser), [chamada RPC](https://supabase.com/docs/reference/javascript/rpc).

## Ordem sorteada da tentativa (026)

Aplicar `database/026_ordem_tentativa.sql` depois da `025`. Atende a parte de sorteio dos RF17–RF19: a chamada existente de início passa a salvar a ordem de todas as questões e das alternativas de cada questão objetiva.

- `tentativa_questoes`: tentativa, questão e posição sorteada.
- `tentativa_alternativas`: tentativa, questão, alternativa e posição sorteada dentro da questão. Dissertativas não recebem alternativas.
- O trigger `tentativas_sortear_ordem` chama `examentech_private.sortear_ordem_tentativa` após criar a tentativa. Sorteio, tentativa e auditoria pertencem à mesma transação; qualquer falha desfaz a operação.
- Guarda IDs e posições, sem copiar textos ou `correta`. A estrutura publicada já fica bloqueada para edição pela aplicação; a ordem original do professor permanece intacta.
- O sorteio acontece uma vez. Repetir o início continua recusado, sem mudar a ordem. Sorteios de alunos diferentes podem coincidir por acaso.
- Tentativas anteriores à `026` continuam sem ordem salva. Não são preenchidas, reabertas ou reiniciadas. Para validar este bloco, criar uma avaliação nova de teste.
- RLS ativada e acesso direto bloqueado para `anon` e `authenticated`, inclusive professor/admin pela aplicação. A API de início continua retornando apenas os seis metadados. A query `027` consulta o conteúdo sem liberar acesso direto a essas tabelas.

Teste manual no Supabase de testes:

1. Aplicar a `026` e publicar uma avaliação nova, com janela em andamento, questões objetivas com alternativas e uma dissertativa.
2. Como aluno com MFA e matrícula ativa, executar a chamada de `/api/iniciar-tentativa` da seção anterior. Esperado: `201`. Copiar o ID da tentativa.
3. No SQL Editor do Supabase, executar:

```sql
SELECT tq.tentativa_id, tq.ordem AS ordem_questao, tq.questao_id,
       ta.ordem AS ordem_alternativa, ta.alternativa_id
FROM public.tentativa_questoes tq
LEFT JOIN public.tentativa_alternativas ta
  ON ta.tentativa_id = tq.tentativa_id AND ta.questao_id = tq.questao_id
WHERE tq.tentativa_id = 'UUID_DA_TENTATIVA'
ORDER BY tq.ordem, ta.ordem;
```

4. Conferir todas as questões, posições consecutivas a partir de `1` e alternativas vinculadas à questão correspondente. Na dissertativa, os campos da alternativa ficam nulos. A consulta repete a questão em cada alternativa.
5. Repetir o início: `409`. Consultar novamente: mesma ordem e um único evento `TENTATIVA_INICIADA`. Outro aluno matriculado recebe sua própria tentativa, sem alterar a primeira.

Testes: `node --test tests/ordem-tentativa.test.ts tests/iniciar-tentativa.test.ts tests/tentativas-sql.test.ts`. Cobrem persistência, vínculos, permissões, repetição, preservação de registros antigos e rollback. PostgreSQL local via PGlite, Auth/HTTP simulados, sem acesso ao Supabase remoto. Sem nova dependência ou alteração visual.

Referências: [funções de janela](https://www.postgresql.org/docs/current/functions-window.html), [random e setseed](https://www.postgresql.org/docs/current/functions-math.html#FUNCTIONS-MATH-RANDOM-TABLE), [transações e triggers](https://www.postgresql.org/docs/current/trigger-definition.html).

## Consulta do conteúdo da tentativa (027)

Aplicar `database/027_consultar_conteudo_tentativa.sql` depois da `026`. Cria `public.consultar_conteudo_tentativa(p_tentativa_id)`, que chama a função privada com as regras de acesso. Sem nova tabela, rota da aplicação ou alteração visual.

- Exige aluno dono da tentativa, perfil e organização ativos, sessão própria existente e MFA `aal2`.
- Revalida matrícula `ATIVA`, organização da turma, turma ativa, avaliação `PUBLICADA` e tentativa `EM_ANDAMENTO`. Professor/admin não usam essa função de execução; a consulta histórica de metadados da `025` permanece separada.
- Confere o relógio do banco após obter os bloqueios de leitura: início inclusivo e fim exclusivo, respeitando tanto `limite_em` quanto a janela da avaliação. Prazo vencido bloqueia o conteúdo, mas ainda não muda a situação da tentativa.
- Retorna `tentativa_id`, `avaliacao_id`, `titulo`, `tipo`, `iniciada_em`, `limite_em` e `questoes`.
- Cada questão contém somente `id`, `tipo`, `enunciado`, `pontuacao`, `ordem` e `alternativas`. Cada alternativa contém somente `id`, `texto` e `ordem`. Dissertativas retornam `alternativas: []`.
- As listas usam as posições da `026`. Não retornam `correta`, ordem original do professor ou colunas internas. Nenhum novo sorteio, registro ou evento é gerado pela consulta.
- Tentativas antigas sem ordem salva são recusadas, sem preenchimento ou reinício automático.
- Erros SQL: `42501` para perfil/sessão/MFA sem permissão; `P0002` para tentativa inexistente, alheia ou sem vínculo ativo na organização; `55000` para situação, horário ou conteúdo indisponível.

Teste manual com `npm run dev:full`:

1. Aplicar a `027`. Entrar como aluno com MFA e matrícula ativa. Usar uma tentativa iniciada depois da `026`, ainda dentro do prazo, com questões objetivas e dissertativas. Se as tentativas de teste venceram, criar e publicar uma avaliação nova.
2. No console do navegador, substituir o ID e executar:

```js
const { supabase: supabaseConteudo } = await import('/src/lib/supabase.ts');
const resultadoConteudo = await supabaseConteudo.rpc('consultar_conteudo_tentativa', {
  p_tentativa_id: 'UUID_DA_TENTATIVA',
});
console.log(resultadoConteudo.data, resultadoConteudo.error);
```

3. Conferir os textos, pontuações e posições com a consulta do SQL Editor da seção `026`. Verificar a ausência de `correta` e a lista vazia de alternativas na dissertativa. Repetir: mesma ordem, horários e quantidade de eventos.
4. Outro aluno recebe `P0002`; professor/admin recebem `42501`. Inativar a matrícula pelo fluxo existente impede a consulta. Depois de vencer o prazo, esperar `55000`. A validação deve ser feita com a sessão do aluno no navegador, não como administrador do banco no SQL Editor.

Testes: `node --test tests/conteudo-tentativa.test.ts tests/ordem-tentativa.test.ts tests/tentativas-sql.test.ts tests/iniciar-tentativa.test.ts`. PostgreSQL local via PGlite, sem acesso remoto. Cobrem retorno permitido, ordem persistida, isolamento, MFA/sessão, vínculos, horários, preservação dos registros e acesso direto bloqueado.

**Situação dos RF17–RF19:** ainda parciais. Início e consulta têm banco e API; o sorteio fica salvo no banco. A interface já permite iniciar e visualizar as questões. A query `028` e a API salvam respostas objetivas/dissertativas; faltam os campos com salvamento automático na interface. A execução também precisará vincular a tentativa à sessão inicial e encerrar o acesso por saída/desconexão, conforme a ficha; esta consulta valida a sessão atual, mas não detecta esses eventos. Finalização e cancelamento serão tratados nos blocos próprios.

Referências: [funções e permissões no Supabase](https://supabase.com/docs/guides/database/functions), [agregação com ordem no PostgreSQL](https://www.postgresql.org/docs/current/functions-aggregate.html), [construção explícita de JSON](https://www.postgresql.org/docs/current/functions-json.html).

## API de consulta do conteúdo da tentativa

`GET /api/conteudo-tentativa?tentativa_id=UUID` → verificação no Supabase Auth → `public.consultar_conteudo_tentativa` da `027` → validação e seleção dos campos da resposta. Rota registrada em `scripts/api-dev.ts`, seguindo o padrão de `/api/iniciar-tentativa`. Sem nova query ou dependência.

- Recebe somente `tentativa_id` na URL e `Authorization: Bearer <access_token>`. Recusa ID inválido, parâmetros extras ou repetidos e métodos diferentes de GET.
- Usa a chave pública e a sessão do usuário. A função no banco confere aluno dono, perfil, organização, matrícula, MFA, situação e prazo.
- Sucesso: `200` com `{ conteudo }`, no formato descrito na seção `027`. `lerConteudoTentativa`, em `tentativaValidation.ts`, valida IDs, datas, textos, pontuações, tipos e posições consecutivas. Objetivas exigem de 2 a 5 alternativas; dissertativas, lista vazia. IDs repetidos e respostas de outra tentativa são recusados.
- Monta objetos novos com os campos permitidos em todos os níveis. `correta`, gabarito e outros campos extras da RPC não são enviados ao navegador. Reaproveita as validações de texto, pontuação, UUID e data existentes.
- Preserva a ordem recebida, sem novo sorteio ou limite de 50 questões. Resposta inválida retorna erro, sem conteúdo parcial. A consulta não inicia, reabre ou altera a tentativa.
- Erros: `400` parâmetro inválido; `401` sessão inválida; `403` perfil/MFA/sessão sem permissão; `404` tentativa inexistente ou sem acesso; `409` tentativa indisponível para realização; `405` método incorreto; `503` falha de serviço ou resposta inválida.
- Todas as respostas usam `Cache-Control: no-store`. Detalhes internos de erros não são expostos. Não há repetição automática da RPC.

Teste manual com a `027` aplicada e `npm run dev:full`:

1. Entrar como aluno com MFA e matrícula ativa. Usar uma tentativa com ordem salva e ainda dentro do prazo. No console do navegador, substituir o ID:

```js
const { supabase: supabaseApiConteudo } = await import('/src/lib/supabase.ts');
const { data: sessaoConteudo } = await supabaseApiConteudo.auth.getSession();
const respostaConteudo = await fetch('/api/conteudo-tentativa?tentativa_id=UUID_DA_TENTATIVA', {
  headers: { Authorization: `Bearer ${sessaoConteudo.session.access_token}` },
});
console.log(respostaConteudo.status, await respostaConteudo.json());
```

2. Esperado: `200`, questões e alternativas na ordem salva, sem `correta`. Repetir: mesmos dados, sem mudar o prazo ou criar eventos. Conferir `Cache-Control: no-store` na aba Network.
3. Como professor/admin, esperar `403`; com outro aluno, `404`; com prazo vencido, `409`. UUID inválido ou parâmetro extra deve retornar `400`.

Testes: `node --test tests/conteudo-tentativa-api.test.ts tests/conteudo-tentativa.test.ts tests/iniciar-tentativa.test.ts`. Integração com SQL real no PGlite e Auth/HTTP simulados. Cobrem permissões, prazo, ordem salva, ausência de gabarito mesmo em retorno com campos extras, conteúdo inválido e falhas de serviço. Sem acesso ao Supabase remoto.

Referências: [verificação da identidade no Supabase](https://supabase.com/docs/reference/javascript/auth-getuser), [chamada RPC](https://supabase.com/docs/reference/javascript/rpc).

## Chamadas de tentativas no frontend

`src/services/tentativas.ts` prepara a integração da tela com as duas APIs existentes. Sem nova query, dependência ou mudança visual neste bloco.

- `iniciarTentativa(avaliacaoId)` obtém a sessão atual e envia somente `avaliacao_id` para `POST /api/iniciar-tentativa`. Confere status `201`, avaliação e aluno da confirmação. Falha de rede ou confirmação inválida informa que a tentativa pode ter sido criada, sem repetir o POST.
- `consultarConteudoTentativa(tentativaId)` chama `GET /api/conteudo-tentativa`, sem cache. Confere status `200`, ID solicitado e conteúdo com os validadores existentes. Preserva a ordem e devolve apenas campos permitidos, sem gabarito.
- IDs inválidos e sessão ausente/com erro impedem a chamada à API. Cada chamada obtém a sessão atual para usar o token renovado. Identidade, MFA, permissões e prazo continuam validados no servidor.
- Erros HTTP preservam a mensagem da API. Falha de consulta não usa conteúdo anterior nem inicia outra tentativa. As funções são separadas para a tela manter a confirmação do início mesmo se a consulta seguinte falhar.

Teste automatizado: `npm run test:ui -- tests/tentativas-service.test.tsx`. Usa os serviços reais do frontend e simula apenas sessão e HTTP. Cobre sucesso, identidade da confirmação, validação do conteúdo, token renovado, falhas de rede e ausência de repetição automática. Não acessa o Supabase remoto.

Teste manual com as queries até `027` aplicadas e `npm run dev:full`:

1. Entrar como aluno com MFA e matrícula ativa. Usar uma avaliação nova de teste, publicada e com janela em andamento. O início consome a tentativa única.
2. No console do navegador, executar uma vez, substituindo o ID:

```js
const tentativasFrontend = await import('/src/services/tentativas.ts');
const tentativaFrontend = await tentativasFrontend.iniciarTentativa('UUID_DA_AVALIACAO_DE_TESTE');
console.log(tentativaFrontend);
const conteudoFrontend = await tentativasFrontend.consultarConteudoTentativa(tentativaFrontend.id);
console.log(conteudoFrontend);
```

3. Conferir o ID e prazo, os textos na ordem salva e a ausência de `correta`. Se já houver tentativa ativa com ordem salva, testar somente `consultarConteudoTentativa('UUID_DA_TENTATIVA')`.
4. Repetir somente a consulta: mesmo conteúdo e prazo, sem novo evento. Uma falha de consulta não dispara outra chamada de início. Não repetir o início se a mensagem informar que a tentativa pode ter sido criada.

O painel do aluno usa essas chamadas conforme a seção abaixo. RF17–RF19 continuam parciais, conforme as pendências registradas acima.

Referência: [obtenção da sessão no navegador](https://supabase.com/docs/reference/javascript/auth-getsession).


## Início e exibição das questões no painel do aluno

`MinhasAvaliacoesPanel` → botão **Iniciar** → confirmação em `TentativaAlunoPanel` → `iniciarTentativa` → `consultarConteudoTentativa`.

- A confirmação informa tentativa única, duração e encerramento. **Cancelar** recebe o foco inicial e volta à lista sem criar tentativa. Somente **Confirmar início** envia o POST.
- Durante o início, os botões ficam desabilitados. Envios repetidos não duplicam o POST. Se o início falhar, a tela mostra o erro, sem nova chamada automática; uma falha de rede pode ocorrer depois da gravação.
- Após a confirmação do servidor, a tela consulta o conteúdo pelo ID retornado. Confere avaliação, início e prazo com a confirmação. Exibe questões objetivas/dissertativas, pontuação, enunciados e alternativas na ordem salva, sem gabarito.
- Falha de consulta permite **Tentar carregar questões**: repete somente o GET, com o mesmo ID e prazo. O conteúdo anterior não fica visível durante uma nova consulta. Respostas atrasadas de uma tela fechada são ignoradas.
- O prazo exibido vem do servidor. Ao chegar ao prazo, o navegador oculta as questões e mostra **Prazo da tentativa encerrado**. Esse aviso depende do relógio local e não finaliza o registro no banco; a API continua responsável pela validação do prazo.
- Este bloco permite apenas visualizar. A tela informa que respostas e envio ainda estão indisponíveis. Não há retomada após recarregar a página ou sair do painel. O bloqueio por sessão inicial e o encerramento por saída/desconexão ainda precisam ser implementados.
- Estilos, confirmação em formulário e links legais seguem o painel existente. A tabela mantém rolagem horizontal; questões e alternativas ajustam os textos à largura da tela. Sem dependência ou query nova.

Teste manual, com as queries até `027` aplicadas:

1. Executar `npm run dev:full`. Entrar como aluno com MFA e matrícula ativa em uma turma com avaliação nova de teste, publicada e dentro da janela. O teste de início consome a tentativa única.
2. Abrir **Minhas avaliações → Iniciar**. Cancelar e conferir que nenhuma tentativa foi criada.
3. Abrir novamente e confirmar. Conferir questões, alternativas e prazo. Em `tentativas` e `eventos_seguranca`, deve existir somente um início para esse aluno/avaliação.
4. Conferir a ordem com `tentativa_questoes` e `tentativa_alternativas`. A resposta da consulta na aba Network não deve conter `correta` ou gabarito.
5. Para testar falha de consulta, bloquear somente `/api/conteudo-tentativa` no navegador antes de iniciar outra avaliação de teste. Após o erro, desbloquear e clicar em **Tentar carregar questões**. Não deve ocorrer outro POST de início.
6. Conferir no celular, com título e enunciado longos, foco pelo teclado e links legais no rodapé. Em uma avaliação com janela curta, conferir o aviso de prazo encerrado.

Testes automatizados:

```bash
npm run test:ui -- tests/minhas-avaliacoes-panel.test.tsx tests/tentativa-aluno.test.tsx tests/tentativas-service.test.tsx tests/app-cadastro.test.tsx
npm run lint
npm run build
```

Os testes usam serviços reais do frontend com sessão e HTTP simulados, sem acessar o Supabase remoto. Cobrem cancelamento, clique duplo, ordem salva, texto seguro, falhas de início/consulta, prazo e resposta atrasada. Prévia local conferida em desktop e celular com dados fictícios; validação integrada com o Supabase fica para o teste manual.

Banco e regras das respostas adicionados na `028`, descrita abaixo. RF17–RF19 ainda não estão concluídos.


## 028 — Banco e regras das respostas

Aplicar `database/028_salvar_resposta_tentativa.sql` depois da `027`. Este bloco cria `public.respostas` e `public.salvar_resposta_tentativa`. Sem mudança nas APIs ou telas.

- Uma linha por tentativa/questão: `id`, `tentativa_id`, `questao_id`, `alternativa_id`, `texto`, `versao`, `criado_em` e `atualizado_em`. Guarda a última resposta recebida; não guarda todas as versões do texto.
- Objetiva recebe o ID da alternativa da própria questão e tentativa. Dissertativa recebe até 10.000 caracteres. Não aceita texto em objetiva nem alternativa em dissertativa. O limite de texto é uma decisão deste bloco, não um limite especificado na ficha.
- Espaços e quebras de linha da dissertativa são preservados. Texto vazio vira `NULL`. Enviar ambos os campos como `NULL` limpa a resposta, mantendo o registro. Não há exclusão pela aplicação.
- FKs exigem questão da ordem salva e alternativa vinculada àquela questão/tentativa. Um índice único na tabela de alternativas sorteadas permite a FK com os três IDs. Tentativas antigas sem ordem salva não recebem respostas.
- Somente o aluno dono, ativo, da organização ativa, com sessão válida, MFA e matrícula ativa. Turma precisa estar ativa, avaliação publicada e tentativa em andamento, dentro da janela e do prazo. Professor/admin não respondem pelo aluno.
- A função bloqueia a tentativa durante a gravação e confere o relógio do banco depois dos bloqueios. Alterar uma resposta não muda o prazo, a situação ou o sorteio. Finalização e cancelamento ainda não são implementados pela `028`.
- RLS habilitada e acesso direto à tabela revogado. A função pública usa `SECURITY INVOKER`; a privada usa `SECURITY DEFINER`, `search_path` vazio e as mesmas verificações mesmo quando chamada diretamente.
- Cada nova versão registra `RESPOSTA_SALVA` na mesma transação. `recurso_id` aponta para `respostas.id`. O log registra usuário, ação e horário, sem texto, alternativa selecionada ou gabarito. Se a auditoria falhar, a resposta também é desfeita. A constraint de eventos da `025` é preservada.

### Versões e confirmação

A primeira gravação de cada questão usa `p_versao: 1`; a alteração seguinte usa `2`, depois `3` etc. Repetir a última versão com o mesmo conteúdo devolve a mesma confirmação, sem atualizar horário ou duplicar evento. Versão antiga, salto na sequência ou versão repetida com outro conteúdo retorna erro.

Isso evita que um envio atrasado substitua uma resposta mais recente. A futura interface deverá enviar uma gravação por vez por questão, avançar a versão após confirmar o salvamento e repetir o mesmo conteúdo/versão se perder a confirmação. Mesmo uma repetição exige acesso e prazo válidos. Não é um mecanismo de retomada da avaliação.

Contrato da RPC:

```text
salvar_resposta_tentativa(
  p_tentativa_id UUID,
  p_questao_id UUID,
  p_versao INTEGER,
  p_alternativa_id UUID = NULL,
  p_texto TEXT = NULL
)
```

Retorno: objeto com os oito campos da resposta. Sem gabarito, correção ou nota. Erros SQL: `42501` para sessão/perfil/MFA; `P0002` para tentativa fora do acesso ou questão ausente na ordem; `23514` para formato/tamanho/tipo da resposta; `55000` para prazo, situação ou versão incompatível. UUID malformado é recusado pelo PostgreSQL.

### Teste manual

1. Aplicar a `028` no SQL Editor. Executar `npm run dev:full`, entrar como aluno com MFA e matrícula ativa e iniciar uma avaliação nova de teste, com questões objetivas e dissertativas. Usar o ID dessa tentativa; o teste precisa ocorrer antes do prazo.
2. No console do navegador, substituir os IDs e executar. Obter os IDs da questão e alternativa na resposta de `/api/conteudo-tentativa`, na aba Network. Não usar o SQL Editor para simular o aluno, pois ele tem privilégios administrativos.

```js
const { supabase: supabaseRespostas } = await import('/src/lib/supabase.ts');
const respostaObjetiva = await supabaseRespostas.rpc('salvar_resposta_tentativa', {
  p_tentativa_id: 'UUID_DA_TENTATIVA',
  p_questao_id: 'UUID_DA_QUESTAO_OBJETIVA',
  p_versao: 1,
  p_alternativa_id: 'UUID_DA_ALTERNATIVA',
});
console.log(respostaObjetiva.data, respostaObjetiva.error);

const respostaDissertativa = await supabaseRespostas.rpc('salvar_resposta_tentativa', {
  p_tentativa_id: 'UUID_DA_TENTATIVA',
  p_questao_id: 'UUID_DA_QUESTAO_DISSERTATIVA',
  p_versao: 1,
  p_texto: 'Resposta de teste.\nSegunda linha.',
});
console.log(respostaDissertativa.data, respostaDissertativa.error);
```

3. Conferir duas linhas em `respostas` e dois eventos `RESPOSTA_SALVA`. Repetir os mesmos parâmetros: mesmos IDs/horários, sem novas linhas ou eventos. Para alterar, usar versão `2`; para limpar, enviar os campos de conteúdo como `null` na próxima versão.
4. Tentar enviar uma versão antiga, alternativa de outra questão ou como outro usuário: erro e preservação da resposta salva. Depois de vencer o prazo, novos salvamentos e repetições devem ser recusados.

Teste automatizado: `node --test tests/respostas-tentativa.test.ts`. Usa PostgreSQL local via PGlite: salvamento e limpeza, versões, isolamento, MFA/sessão, vínculos, prazo, FKs, acesso direto bloqueado, rollback da auditoria e reaplicação. PGlite enfileira transações; disputa de versão é testada, mas concorrência entre conexões reais no Supabase fica para a validação integrada.

**Para concluir o grupo RF17–RF19:** adicionar seleção de alternativa e texto dissertativo com salvamento automático e estados de confirmação/erro; validar o fluxo completo. A execução também precisa cumprir a regra da ficha de encerrar acesso por saída/desconexão e impedir retomada, vinculando a tentativa à sessão inicial. A `028` ainda valida somente a sessão atual. Finalização automática/manual, correção e publicação de resultados pertencem aos outros grupos de RFs.

API de salvamento adicionada conforme a seção abaixo.

Referências: [INSERT e ON CONFLICT no PostgreSQL](https://www.postgresql.org/docs/current/sql-insert.html), [bloqueios de linhas](https://www.postgresql.org/docs/current/explicit-locking.html), [segurança de funções no Supabase](https://supabase.com/docs/guides/database/functions).


## API de salvamento das respostas

`POST /api/salvar-resposta-tentativa` → `auth.getUser` → `public.salvar_resposta_tentativa` da `034` → validação da confirmação. Rota registrada em `scripts/api-dev.ts`, no mesmo padrão das APIs de início e conteúdo. Contrato HTTP preservado; no banco da entrega0911, requer `033` e `034`, sem dependência nova.

- Exige `Authorization: Bearer <access_token>` e `Content-Type: application/json`. Recebe `tentativa_id`, `questao_id`, `versao` e pelo menos um dos campos `alternativa_id` ou `texto`. Campos extras e parâmetros na URL são recusados. Para limpar, enviar conteúdo explicitamente `null`.
- A versão deve ser inteira entre 1 e 2.147.483.647. Texto aceita até 10.000 caracteres Unicode, preservando espaços e quebras de linha. NUL, Unicode inválido e conteúdo misturando alternativa e texto são recusados antes de chamar o banco. O servidor local permite até 128 KiB nessa rota para comportar o texto com Unicode escapado; demais limites existentes são mantidos.
- `respostaValidation.ts` concentra os tipos e a validação dos dados enviados e recebidos, reaproveitando UUID e datas do projeto. Texto vazio segue até a função, que confere o tipo da questão e o converte em `NULL`.
- A RPC usa a chave pública e a sessão do aluno. Dono, perfil, organização, MFA, matrícula, prazo e sequência da versão continuam validados no banco. Não usa service role nem aceita aluno ou horários no corpo.
- Sucesso: `200` com `{ resposta }`, tanto na criação como na alteração ou repetição confirmada. Confere tentativa, questão, versão, alternativa e texto; devolve somente os oito campos da resposta. Datas e IDs são normalizados, sem gabarito, nota ou colunas internas.
- Erros: `400` para entrada/tipo de resposta inválidos; `401` sessão inválida; `403` perfil/MFA sem permissão; `404` tentativa/questão fora do acesso; `409` tentativa indisponível ou versão fora de sequência; `415` formato diferente de JSON; `405` método diferente de POST; `503` indisponibilidade ou confirmação inválida. Respostas sem cache e sem detalhes internos do banco.
- Não repete a RPC automaticamente. Se a confirmação se perder, a resposta pode já estar gravada: repetir **o mesmo conteúdo e a mesma versão**, enquanto o acesso e o prazo forem válidos. A `034` confirma essa repetição sem duplicar registro ou auditoria. Não avançar a versão antes de confirmar.

### Referência do teste manual anterior à tela monitorada

O roteiro abaixo foi usado com o modelo local `028`. Na integração atual, usar a `034` e a tabela `respostas_tentativa`. A tela monitorada pode interromper a tentativa ao abrir o console ou trocar de foco; a validação deste bloco usa os testes automatizados acima. O roteiro integrado será atualizado com a conexão da tela à API.

1. Com a `028` aplicada, executar `npm run dev:full`. Entrar como aluno com MFA e matrícula ativa e iniciar uma avaliação nova de teste dentro da janela.
2. Na aba Network, obter o ID da tentativa, questão e alternativa da consulta de conteúdo. No console do navegador, substituir os IDs e executar:

```js
const { supabase: supabaseApiResposta } = await import('/src/lib/supabase.ts');
const { data: sessaoApiResposta } = await supabaseApiResposta.auth.getSession();
const dadosApiResposta = {
  tentativa_id: 'UUID_DA_TENTATIVA',
  questao_id: 'UUID_DA_QUESTAO_OBJETIVA',
  versao: 1,
  alternativa_id: 'UUID_DA_ALTERNATIVA',
};
const retornoApiResposta = await fetch('/api/salvar-resposta-tentativa', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${sessaoApiResposta.session.access_token}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify(dadosApiResposta),
});
console.log(retornoApiResposta.status, await retornoApiResposta.json());
```

3. Esperado: `200`, uma linha em `respostas` e um evento `RESPOSTA_SALVA`. Repetir a requisição mantendo os dados: mesmos ID/horários e nenhum novo evento. Para alterar, usar a versão seguinte.
4. Para dissertativa, usar seu ID e trocar `alternativa_id` por `texto`. Texto vazio limpa a resposta. Se a questão já foi respondida no teste da RPC, usar a próxima versão ou uma avaliação nova de teste.
5. Enviar uma versão antiga após alterar a resposta: `409`. Outro aluno: `404`; professor/admin ou sem MFA: `403`; prazo vencido: `409`. As recusas não devem alterar a resposta já salva.

Testes: `node --test tests/salvar-resposta-tentativa-api.test.ts tests/respostas-tentativa.test.ts`. Integração com SQL real no PGlite e Auth/HTTP simulados, sem acesso ao Supabase remoto. Cobrem gravação, alteração, limpeza, repetição após perda da confirmação, Unicode, permissões, prazo, rollback de auditoria e proteção dos campos retornados. Lint e build verificados. Rota e limites de tamanho conferidos também por HTTP no servidor local, com Auth/RPC simulados.

Próximo bloco: chamada da API no frontend e campos de resposta com salvamento automático, mantendo as etapas pequenas. RF17–RF19 continuam parciais.

Referências: [identidade pelo Supabase Auth](https://supabase.com/docs/reference/javascript/auth-getuser), [chamada RPC](https://supabase.com/docs/reference/javascript/rpc).
