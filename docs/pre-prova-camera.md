# Pré-prova e teste de câmera

Na área do aluno, **Minhas provas** reúne a simulação com questão de exemplo e a lista de avaliações. A aba separada **Pré-prova** foi retirada da navegação. A simulação não consome a tentativa real nem grava a resposta; a câmera só é solicitada ao clicar em **Ligar câmera para simulação**. Ao preparar uma prova, a simulação é desmontada e libera a câmera. O preparo real tem a conferência da imagem e o aceite dos documentos. A prévia não usa áudio, não grava vídeo e não envia imagens.

O componente anterior de pré-prova continua acessível apenas na página local de desenvolvimento abaixo, para testes isolados.

## Teste local sem Supabase

Com as dependências instaladas, execute `npm.cmd run dev` no PowerShell, na pasta do projeto, e abra `http://localhost:5173/dev/pre-prova.html` (ou use a porta exibida no terminal). Essa página carrega apenas a pré-prova; não exige conta, chave de ambiente nem conexão com o Supabase. Ela serve para conferir o treino, as permissões e a prévia da câmera no navegador. O login e as provas reais continuam dependentes dos serviços do projeto.

O teste precisa ser aberto em `localhost` ou em uma página HTTPS; em um endereço HTTP comum, o navegador pode impedir o acesso à câmera. O aluno pode repetir o teste depois de corrigir permissões ou conectar outro dispositivo. Consulte a [documentação do navegador sobre `getUserMedia`](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia).

## Como conferir

1. Abrir a página local indicada acima para conferir o componente de pré-prova isolado.
2. Marcar uma resposta na questão de treino e verificar o retorno. Isso não deve abrir o pedido de acesso à câmera.
3. Clicar em **Testar câmera**, permitir o acesso e conferir a imagem ao vivo.
4. Desligar a câmera ou mudar de seção e confirmar que esta página deixa de usar a câmera.
5. Repetir com a permissão negada ou a câmera desconectada e verificar a mensagem exibida. Se a prévia ficar totalmente preta sem aviso, clicar em **Minha imagem ficou preta**.

## Validação manual em 04/11/2026

O teste foi feito na página local com a câmera de um celular Android disponibilizada como webcam ao Windows. O usuário confirmou que a imagem apareceu, que **Desligar câmera** interrompeu a prévia e que **Testar câmera** permitiu iniciá-la novamente. Esse teste confirma o funcionamento observado nesse dispositivo e navegador; permissão negada, desconexão física e realização de prova ainda não foram verificados manualmente.

## Observação manual em 05/11/2026

Ao pausar ou bloquear o celular, a webcam virtual exibiu uma imagem de aviso. Quando o acesso à câmera foi desativado no Windows, a prévia ficou totalmente preta e a versão anterior da página continuou indicando que a câmera funcionava. A página agora observa perda e retorno de sinal informados pelo navegador e oferece **Minha imagem ficou preta** para o caso em que a webcam continua conectada, mas não entrega uma imagem útil. Essas mudanças ainda precisam ser conferidas novamente no dispositivo real. Uma tela preta, sozinha, não é suficiente para contar automaticamente uma interrupção de prova.

## Limite desta etapa

O treino desta página continua separado das tentativas reais e não salva a resposta. A nova tela local de avaliação usa uma única tentativa sem retorno automático após saída. Com as queries `036` e `037`, a falha da câmera é registrada sem interromper a prova ou ocultar questões; veja [tentativas de prova e câmera](tentativas-prova.md). A simulação local também mantém a questão disponível e permite reconexão, sem gravar ocorrência real. O controle da câmera em `src/hooks/useCameraSession.ts` é compartilhado pelas duas telas. Ele informa permissão negada, câmera ocupada, perda temporária de sinal (`mute`) e fim do fluxo (`ended`). Também confere esses estados periodicamente. Conforme a [especificação do navegador](https://www.w3.org/TR/mediacapture-streams/), uma webcam removida costuma encerrar a faixa de vídeo, mas o comportamento depende do navegador e do dispositivo. Os testes automatizados simulam as situações; ainda falta validação manual com webcam física.

Há também uma [simulação isolada de fotos](fotos-prova-preparacao.md) em `/dev/fotos-prova.html`. Ela captura imagens apenas para prévia nessa página local e não envia nada ao Supabase nem altera a prova real.

As fotografias da prova real são tratadas separadamente desta simulação, com consentimento específico, acesso privado e prazo máximo de 90 dias. Veja [tentativas e fotos](tentativas-prova.md) e [versões dos documentos](termos-privacidade.md).

## Supabase de teste preparado em 05/11/2026

**Registro histórico:** a situação abaixo corresponde a 05/11. Em 08/11, a equipe conciliou o contrato das provas, aplicou 030–032 e o usuário validou fotos na prova real. O bucket atual é `examentech-evidencias`; não reutilize o bucket do protótipo descrito abaixo para substituir a configuração atual.

A cópia local em `Desenv 0411` foi configurada em `.env.local` para o projeto de teste `ebhbdbgipdktfpmasygu`. O arquivo é ignorado pelo Git; a chave privada fica apenas na variável do servidor, sem prefixo `VITE_`. Para testes locais do cadastro e login, o arquivo usa as chaves oficiais de teste do Cloudflare Turnstile. O projeto principal não foi alterado.

No Storage do projeto de teste foi criado o bucket privado `examentech-fotos-teste`, limitado a `image/jpeg` e 1 MiB por arquivo. Uma imagem artificial de 1 pixel foi enviada com a credencial do servidor (HTTP 200), não ficou disponível pela URL pública (HTTP 400) e foi removida (HTTP 200). A listagem posterior mostrou zero objetos. Nenhuma foto de participante foi enviada.

O Supabase de testes recebeu as versões antigas de `023` e `024`. A sequência atual de avaliações `023`–`029` não foi aplicada nesse projeto. `fotos_tentativa` ainda não existe. O bucket vazio prepara o armazenamento; não usar o bucket de teste como prova de que o fluxo de fotos está concluído.
Com essa configuração, o projeto compilou e o servidor local de validação Turnstile retornou HTTP 200 ("success": true, "audited": true) usando apenas o token oficial de teste. Isso valida a integração técnica local com a auditoria; o login de uma conta real não foi testado nesta etapa.
