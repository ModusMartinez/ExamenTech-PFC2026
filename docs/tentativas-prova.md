# Provas, fotografias e reativação

O fluxo atual usa as avaliações da equipe: 023 publica, 024 lista, 025 inicia, 026 grava a ordem sorteada e 027 consulta as questões. A 028 acrescenta salvamento e encerramento. A 030 autoriza retomadas excepcionais, a 031 integra fotos privadas e a 032 atualiza os documentos. Consulte os roteiros específicos antes de configurar outro ambiente.

## Fluxo do aluno

1. Aluno ativo, com MFA e matrícula ativa, abre **Minhas provas**. A simulação local com questão de exemplo não cria tentativa nem envia foto. Ao preparar uma avaliação, a simulação libera sua câmera.
2. O aluno confere a câmera e lê o aviso geral, a regra de permanência, os Termos e a Política. Se fotografias estão habilitadas, um segundo aceite desmarcado pede consentimento específico para captura, envio, acesso e retenção. Sem os aceites exigidos não há início.
3. O servidor cria a tentativa única ou consome uma liberação excepcional já autorizada. Define o prazo, limitado ao fim da avaliação, e mantém a ordem persistida das questões e alternativas. O relógio não é pausado por fechar a página.
4. Com fotos habilitadas, o servidor sorteia os três horários: 10–26%, 38–56% e 68–86% do tempo disponível naquele ciclo. Uma foto inicial é obtida antes das questões; o banco exige confirmação do arquivo no Storage para liberar o conteúdo. A tela compensa a diferença entre o relógio local e o horário informado pelo servidor ao programar as capturas.
5. As três fotos posteriores não retiram o foco nem bloqueiam as questões. Um aviso no canto inferior direito informa a captura. Falha de envio permite reenviar o mesmo arquivo temporário e identificador, sem criar uma nova foto. É diferente de falha da câmera.
6. O aluno salva respostas objetivas ou dissertativas. Enviar encerra a tentativa e cancela fotos futuras. Ao vencer o prazo, o estado passa a finalizado; prova finalizada não recebe reativação por esse fluxo.

O aviso base permanece `2026-11-06-v2`, e o consentimento específico das fotos é `2026-11-08-fotos-v1`. Cada ciclo com fotos registra as versões dos documentos e o aceite. Não há fotos no localStorage/IndexedDB; capturas pendentes ficam na memória até envio ou saída.

## Câmera e permanência

Perder o sinal esconde as questões. Uma interrupção temporária pode voltar dentro de três segundos; se persistir, ou se a faixa de vídeo terminar, a tentativa é interrompida. **Minha imagem ficou preta** permite comunicar uma falha que o navegador não sinalizou. Nem toda câmera virtual ou driver permite detectar uma imagem inútil automaticamente.

Sair pelo botão, trocar de aba, ocultar a página ou tirar o foco da janela interrompe sem retorno automático. A tela não identifica qual aplicativo ou área de trabalho foi aberto. Os documentos e as confirmações abrem dentro da página: consultar a Política ou cancelar o envio não deve encerrar a prova.

Uma tentativa interrompida pode voltar **somente** após liberação do professor responsável ou ADM da mesma organização. Fechar a aba ou perder a rede pode impedir o registro imediato da saída; não existe retomada automática por uma nova chamada de início. O banco pode continuar mostrando `EM_ANDAMENTO` nesses casos. Respostas não salvas e fotos não confirmadas podem se perder.

## Consulta e reativação pelo responsável

Em **Turmas → Publicadas → Gerenciar [avaliação]**, o responsável consulta os últimos 50 registros de tentativa.

- **Fotos de [aluno]** lista as capturas por ciclo. A abertura de cada imagem passa pela API, com sessão e MFA, exige responsabilidade pela avaliação ou ADM da mesma organização e registra a consulta. Não há URL pública.
- **Reativar tentativa** aparece para uma tentativa interrompida ainda sem liberação pendente. Exige justificativa de 5–500 caracteres e minutos, até a duração original. A retomada deve ocorrer na janela da avaliação e não ultrapassa seu fim.
- O aluno prepara a câmera e confirma novamente. O identificador da tentativa, respostas salvas e ordem são preservados; o contador de ciclo avança. A autorização e seu uso ficam registrados. Um ciclo novo com fotos exige outro consentimento e novas capturas.
- Tentativa enviada ou finalizada por prazo não é reaberta.

As funções do banco verificam as permissões; o botão no React não é a autorização.

## Fotos e retenção

Uma captura é JPEG de até 960 × 720 pixels e 1 MiB. Não há áudio, vídeo contínuo, reconhecimento facial ou análise automática de fraude. As fotos ficam no bucket privado `examentech-evidencias`, associado à tentativa, ciclo e momento, sem nome ou e-mail no caminho.

A equipe confirmou prazo máximo de 90 dias por foto. O horário programado no servidor ancora uma validade conservadora; atraso e reenvio não renovam o prazo. A rotina diária usa a API de Storage e só depois marca a exclusão nos metadados. Revogação bloqueia novos envios e consulta das imagens dos ciclos envolvidos, incluindo-as na limpeza. Veja [ativação e privacidade](ativar-fotos-e-reativacao.md) e [agendamento no Supabase](limpeza-fotos-supabase.md).

## Estado de validação em 08/11/2026

O usuário confirmou a prova real na base de testes e a visualização das imagens com a conta do professor. Aplicou 030–032 e validou o agendamento com HTTP 200, `timed_out=false` e `{"removidas":0}`. Essa chamada não comprova sozinha a exclusão física de uma fotografia vencida.

As suítes locais cobrem ordem e respostas preservadas, liberação por professor/ADM, isolamento de organização, MFA, consentimento, upload idempotente, acesso restrito, revogação e limpeza. A conferência de navegador usou câmera e serviços simulados. Ainda é necessário registrar a validação manual de reativação, ADM, acesso negado entre organizações e exclusão de uma foto fictícia vencida. Não são comprovações de configuração da base principal.

O [roteiro de preparação da branch 0911](entrega-0911.md) reúne o escopo e as instruções de revisão. Os testes não alteram o Supabase.
