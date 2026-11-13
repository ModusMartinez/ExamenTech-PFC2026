# Provas, sessão e fotografias

O fluxo atual usa as avaliações da equipe: 023 publica, 024 lista, 025 inicia, 026 grava a ordem sorteada e 027 consulta as questões. A 028 acrescenta salvamento e encerramento. A 031 integra fotos privadas, a 034 versiona respostas, a 037 preserva a prova quando falha só a câmera e a 038 vincula a execução à sessão inicial e desativa a reativação. Consulte os roteiros específicos antes de configurar outro ambiente.

## Fluxo do aluno

1. Aluno ativo, com MFA e matrícula ativa, abre **Minhas provas**. A simulação local com questão de exemplo não cria tentativa nem envia foto. Ao preparar uma avaliação, a simulação libera sua câmera.
2. Para uma Prova, o aluno confere a câmera, lê o aviso geral, os Termos e a Política e registra dois aceites separados. O segundo é o consentimento para captura, envio, acesso e retenção das fotos. Ao confirmar o início, a página entra em tela cheia antes de solicitar a tentativa. Para uma Atividade, aplica-se o aviso de tentativa única.
3. O servidor cria a tentativa única, grava a ordem sorteada e vincula a tentativa ao identificador da sessão Supabase e ao hash de uma chave aleatória da página. A chave permanece na memória da página. O prazo fica limitado ao fim da avaliação.
4. Em Provas, o servidor sorteia os três horários: 10–26%, 38–56% e 68–86% do tempo disponível na tentativa. Uma foto inicial é obtida antes das questões; o banco exige confirmação do arquivo no Storage para liberar o conteúdo. A tela compensa a diferença entre o relógio local e o horário informado pelo servidor ao programar as capturas.
5. As três fotos posteriores não retiram o foco nem bloqueiam as questões. Um aviso no canto inferior direito informa a captura. Uma recusa temporária do servidor permite reenviar o mesmo arquivo e identificador enquanto a execução permanece ativa. Uma perda de conexão detectada encerra a execução.
6. Alternativas são salvas ao selecionar e dissertativas após uma pausa na digitação. O botão de envio confirma as alterações restantes e encerra a tentativa. Depois do prazo o servidor recusa novas respostas. O job da migração 041 finaliza as tentativas vencidas que continuam em andamento, inclusive quando a página não enviou o encerramento.

A partir da 043, o aviso de Prova é `2026-11-09-v5` e o de Atividade continua em `2026-11-08-v4`. O consentimento específico das fotos é `2026-11-08-fotos-v1`. Cada ciclo com fotos registra as versões dos documentos e o aceite. Não há fotos no localStorage/IndexedDB; capturas pendentes ficam na memória até envio ou saída.

## Câmera e permanência

Com `036` e `037`, perder o sinal registra `CAMERA_FALHA` sem ocultar questões ou interromper a tentativa. O aluno pode continuar respondendo, salvar e enviar, ou usar **Reconectar câmera**. Uma falha contínua usa o mesmo identificador; reenvio após perda da confirmação não duplica o log. Se o registro falhar, a tela informa a pendência e oferece **Reenviar ocorrência**. **Minha imagem ficou preta** permite comunicar uma falha que o navegador não sinalizou. Nem toda câmera virtual ou driver permite detectar uma imagem inútil automaticamente.

A foto inicial é obrigatória em Provas: se a captura falhar, reconectar e usar **Preparar envio das fotos** na mesma tentativa. O cronômetro continua correndo. Depois da confirmação inicial, falhas nas capturas seguintes não bloqueiam a prova, e os próximos horários são mantidos. Veja o [contrato e roteiro da câmera](avaliacoes.md#037--continuidade-da-prova-sem-câmera).

Sair pelo botão, trocar de aba, perder o foco, fechar ou recarregar a página ou perder a conexão interrompe a execução. A tela oculta as questões e preserva no banco as respostas já recebidas. Ao reconectar, a página pode tentar confirmar apenas o encerramento. Documentos e confirmações abrem dentro da página.

O servidor exige a sessão inicial e a chave da página para consultar conteúdo e respostas, salvar, encerrar e registrar eventos e fotos. Uma nova aba ou recarga perde a chave original. Outra sessão é recusada mesmo com a chave original. Se a página fechar antes de a saída chegar ao servidor, a linha pode continuar como `EM_ANDAMENTO`. A tentativa fica inacessível em uma nova página, e o servidor continua aplicando o prazo. A ficha dispensa heartbeat. Por isso uma queda transitória que o navegador não sinalize e que não afete nenhuma chamada não é detectada.

## Consulta pelo responsável

Em **Turmas → Publicadas → Gerenciar [avaliação]**, o responsável consulta os últimos 50 registros de tentativa. **Fotos de [aluno]** lista as capturas e preserva a identificação dos ciclos históricos. A abertura de uma imagem exige sessão e MFA, confere responsabilidade ou perfil ADM da organização e registra a consulta. A 038 revoga a função de reativação e preserva o histórico das autorizações anteriores.

## Correção e cálculo da nota

Após aplicar a migração 039, o professor autor abre **Corrigir tentativa de [aluno]** no gerenciamento de uma avaliação. O banco registra a pontuação objetiva ao finalizar a tentativa. Uma resposta correta vale todos os pontos da questão, e uma incorreta ou em branco vale zero. A migração também corrige as objetivas e atribui zero às respostas em branco de tentativas que já estavam finalizadas.

Dissertativas respondidas ficam pendentes até o professor registrar de zero ao máximo da questão, com até duas casas decimais e comentário opcional de até 2.000 caracteres. O banco recusa alterações concorrentes baseadas em uma versão anterior. Quando todas as questões têm pontuação, a nota é `pontos obtidos ÷ pontos totais × 10`, arredondada a duas casas decimais. Antes da publicação, a correção é visível apenas ao professor autor com sessão ativa e MFA. Tentativas interrompidas ficam no histórico.

No ExamenTech-Testes, uma transação com dados sintéticos confirmou o cálculo, a persistência da correção, os limites e as permissões da 039. O rollback removeu a migração e os dados dessa execução de teste.

## Finalização por prazo e publicação de resultados

No SQL Editor do Supabase, aplique 039, 040 e 041 nessa ordem. A 041 registra o job `examentech-finalizar-tentativas`, executado a cada minuto. O banco bloqueia respostas no limite da tentativa. Na execução seguinte, o job finaliza as tentativas vencidas em lotes de até 200, usa as respostas recebidas e aplica a correção da 039. A saída registrada antes do prazo continua sendo uma interrupção. Uma saída recebida após o limite vira finalização por prazo.

Em **Turmas → Publicadas → Gerenciar [avaliação]**, o professor autor publica os resultados depois que a janela fecha, as tentativas em andamento são finalizadas e todas as dissertativas respondidas estão corrigidas. A publicação registra o autor e bloqueia alterações posteriores nas pontuações. Em **Minhas provas → Ver resultados publicados**, o aluno titular com MFA consulta a nota, as questões na ordem da tentativa, as próprias respostas, o gabarito e os comentários. O histórico continua disponível se a matrícula for inativada.

No ExamenTech-Testes, a execução transacional confirmou a rotina de finalização sem chamada do navegador, o registro no Supabase Cron, a publicação exclusiva pelo autor e a consulta restrita ao aluno titular. O rollback desfez as migrações, o job e os dados sintéticos. Para conferir a execução automática depois de aplicar a 041, use o histórico do job no Supabase Cron e deixe vencer uma tentativa de teste que continue em andamento.

## Fotos e retenção

Uma captura é JPEG de até 960 × 720 pixels e 1 MiB. Não há áudio, vídeo contínuo, reconhecimento facial ou análise automática de fraude. As fotos ficam no bucket privado `examentech-evidencias`, associado à tentativa, ciclo e momento, sem nome ou e-mail no caminho.

A equipe confirmou prazo máximo de 90 dias por foto. O horário programado no servidor ancora uma validade conservadora; atraso e reenvio não renovam o prazo. A rotina diária usa a API de Storage e só depois marca a exclusão nos metadados. Revogação bloqueia novos envios e consulta das imagens dos ciclos envolvidos, incluindo-as na limpeza. Veja [ativação e privacidade](ativar-fotos-e-reativacao.md) e [agendamento no Supabase](limpeza-fotos-supabase.md).

## Estado de validação em 08/11/2026

O usuário confirmou a prova real na base de testes e a visualização das imagens com a conta do professor. Aplicou 030–032 e validou o agendamento com HTTP 200, `timed_out=false` e `{"removidas":0}`. Essa chamada não comprova sozinha a exclusão física de uma fotografia vencida.

## Homologação da migração 038

Em 08/11/2026, no ExamenTech-Testes, a API confirmou com sessões reais de MFA que outra página e outro login não acessam a tentativa. O teste também verificou versões da resposta, foto no Storage privado e saída definitiva. Professor e ADM tiveram a reativação recusada na validação do banco. No Chromium, três provas fictícias confirmaram o envio normal após registrar uma falha de câmera, o bloqueio após recarregar e o bloqueio após perder e recuperar a rede. As respostas objetiva e dissertativa já confirmadas permaneceram no banco nos três cenários.

No **Supabase de testes**, confira as migrações até 037. Aplique 038 antes de executar a aplicação atualizada. Tentativas em andamento anteriores à 038, sem vínculo de execução, são interrompidas e auditadas. Respostas, ordem e fotos anteriores continuam no histórico.

Use uma avaliação fictícia por cenário. Registre a situação no painel responsável e confira o conteúdo e a versão das respostas persistidas no banco.

1. Na sessão inicial, confira ordem sorteada, ausência de gabarito, gravação objetiva e dissertativa e envio normal.
2. Salve uma resposta e confirme a saída. Tente iniciar de novo, acessar pela aba nova e reabrir pelo professor e ADM. A tentativa permanece encerrada e a resposta confirmada permanece no banco.
3. Em outra avaliação, salve e recarregue com F5. O botão de iniciar não oferece uma segunda tentativa. Confira o bloqueio mesmo se o navegador não tiver registrado o encerramento no banco.
4. Em outra avaliação, salve, desconecte o navegador com a tentativa aberta e reconecte. A tela permanece bloqueada. A reconexão pode confirmar a interrupção, mas não envia alterações pendentes.
5. Com fotos habilitadas, confirme a captura inicial, derrube apenas a câmera e confira registro da ocorrência, salvamento, envio e consulta de fotos pelo responsável.

`node --test tests/tentativa-sessao.test.ts` e as suítes de interface exercitam essas regras com banco local e navegador simulado. Veja também o [roteiro de preparação da branch](entrega-0911.md).

## Cancelamento da avaliação (RF28–RF29)

Em **Turmas → Publicadas → Gerenciar**, o professor autor autenticado com MFA pode cancelar uma avaliação publicada, inclusive durante a aplicação. A confirmação informa que novas tentativas serão bloqueadas e que as tentativas em andamento serão encerradas. O banco recusa o cancelamento de rascunhos e de avaliações com resultados já divulgados. A avaliação cancelada continua no histórico da turma com data e registro de auditoria.

A migração 042 encerra as tentativas em andamento na mesma transação em que cancela a avaliação. As respostas recebidas e as tentativas que já estavam encerradas permanecem no histórico. Uma avaliação cancelada sai da lista de provas do aluno e não pode ser reaberta nem ter novos resultados publicados.

A publicação `supabase_realtime` inclui a tabela de tentativas. A tela assina apenas as atualizações da tentativa aberta, sob a RLS existente. Ao receber o cancelamento, a tela encerra a câmera e o preenchimento e avisa o aluno. A consulta de situação na inscrição e durante indisponibilidade do canal cobre cancelamentos ocorridos antes da assinatura ou durante uma reconexão. [Documentação do Supabase Realtime](https://supabase.com/docs/guides/realtime/postgres-changes).

No ExamenTech-Testes, o teste transacional confirmou a inclusão de `tentativas` na publicação Realtime, o cancelamento pelo autor, o encerramento da tentativa, a preservação da resposta e a retirada da prova da lista do aluno. O rollback desfez a migração e os dados sintéticos. A entrega do evento pelo WebSocket precisa da migração aplicada e de duas sessões abertas.

### Homologação em duas sessões

1. Aplique a 042 depois de 040 e 041 no Supabase de teste. Use `VITE_EXAM_MANAGEMENT_ENABLED=true` no ambiente da aplicação.
2. Em dois dispositivos, abra a gestão da avaliação com o professor autor e inicie a prova com um aluno matriculado. Mantenha a prova visível e com foco no navegador do aluno e salve uma resposta.
3. Confirme o cancelamento com o professor. Confira o aviso e o desligamento da câmera na sessão do aluno sem atualizar a página.
4. Volte às avaliações e confira que a prova saiu da lista. No histórico do professor, confira a situação e o horário. No banco de teste, confira que a resposta recebida continua vinculada à tentativa cancelada.

## Execução segura e antifraude (RF30–RF36)

A migração 043 exige o aceite versionado de monitoramento para iniciar uma Prova. A interface pede tela cheia antes da chamada de início. Se o navegador não permitir, o aluno continua na preparação e a tentativa permanece disponível. O banco só aceita iniciar Provas pelo fluxo com fotos e exige a confirmação da foto inicial para consultar questões, salvar respostas e enviar a prova. A coleta precisa estar ativa no banco, na API e na interface. Atividades continuam com tentativa única, sem os controles de câmera, tela cheia ou área de transferência.

| Sinal durante a Prova | Ação | Registro |
| --- | --- | --- |
| Saída da tela cheia | Encerra a tentativa e oculta as questões. | `TENTATIVA_INTERROMPIDA`, ação `saida_tela_cheia`. |
| Troca de aba ou perda de foco | Encerra a tentativa e oculta as questões. | `TENTATIVA_INTERROMPIDA`, ação `perda_aba_ou_foco`. |
| Copiar, colar ou recortar | Impede a operação e mantém a prova disponível. | `CLIPBOARD_BLOQUEADO` com tipo de operação, tentativa e horário. |
| Câmera indisponível durante a execução | Registra a falha. Após a foto inicial, respostas e envio continuam disponíveis. | `CAMERA_FALHA`. |

As ocorrências são sinais do navegador para análise humana. O bloqueio da área de transferência intercepta os eventos da página e preserva o conteúdo da área de transferência fora do sistema. As operações no servidor exigem a sessão e a página originais. O prazo e o cancelamento continuam autoritativos no banco. [Fullscreen API](https://developer.mozilla.org/en-US/docs/Web/API/Element/requestFullscreen), [eventos da área de transferência](https://developer.mozilla.org/en-US/docs/Web/API/Element/paste_event).

### Homologação da execução segura

1. Aplique a 042 e depois a 043 no **ExamenTech-Testes**. Confira o [roteiro de ativação de fotos](ativar-fotos-e-reativacao.md#5-habilitar-as-fotografias-na-base-e-no-site) e use um navegador compatível com a Fullscreen API.
2. Com dados fictícios, inicie uma Prova após aceitar os avisos. Confira a tela cheia, o recebimento da foto inicial e os três horários sorteados. Para conferir a coleta posterior, mantenha uma tentativa aberta até o último horário e confirme os registros pelo professor.
3. Salve uma resposta e tente copiar, colar e recortar. A prova deve continuar. Em tentativas separadas, saia da tela cheia e troque de aba. Confira a mensagem, a ocorrência no banco e a preservação das respostas salvas. Se perder apenas o sinal da câmera após a foto inicial, continue respondendo e envie a prova.
4. Inicie uma Atividade e confira que ela não solicita a câmera nem a tela cheia. Em uma Prova em navegador incompatível, confira que a preparação não consome a tentativa.

O teste transacional no ExamenTech-Testes confirmou os avisos, o plano de capturas, a exigência da foto inicial, a persistência de respostas e o registro das ocorrências. A confirmação da foto foi simulada no banco, sem enviar arquivo ao Storage. O rollback desfez as alterações da execução. A verificação em Chromium usou dados fictícios e câmera simulada.
