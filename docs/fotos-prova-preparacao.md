# Simulação local de fotografias

O fluxo real já tem captura e envio privado, com 030–032 e a configuração de cada ambiente. Consulte [ativação das fotos](ativar-fotos-e-reativacao.md) e [tentativas](tentativas-prova.md). Esta página descreve somente a simulação isolada, preservada para desenvolvimento.

## Executar sem Supabase

Na pasta que contém `package.json`, execute `npm.cmd run dev:web` e abra `/dev/fotos-prova.html` no endereço do Vite. Use `localhost` ou HTTPS para permitir a câmera.

1. Ligue a câmera e confira a imagem.
2. Tire a foto inicial.
3. Inicie a simulação de 30 segundos. O navegador sorteia uma captura em cada uma das três faixas de tempo, e um aviso discreto informa cada foto.
4. Confira as quatro miniaturas e use **Limpar fotos e recomeçar**. Sair também libera as referências às imagens e a câmera.
5. Teste permissão negada, perda de sinal e o botão **Minha imagem ficou preta** quando o dispositivo não informar a falha.

Use a própria câmera ou uma fonte fictícia autorizada. A página não envia imagens, não cria tentativa real e não salva os arquivos no aplicativo. As imagens permanecem na memória da página. Não usa áudio.

## Módulo compartilhado

`src/services/photoEvidence.ts` produz JPEG de até 960 × 720 pixels e 1 MiB. Verifica faixa de vídeo ativa, prévia pronta e dimensões antes de capturar; libera o canvas depois de gerar o arquivo.

Os horários de 30 segundos pertencem apenas à simulação. Na prova real, a função de início no banco sorteia e guarda os momentos conforme o tempo disponível na tentativa. A fila do navegador envia os mesmos arquivos de forma idempotente, sem alterar a ordem das questões ou bloquear a resposta enquanto envia fotos posteriores.

Não há reconhecimento facial nem inferência automática de fraude. Uma câmera tecnicamente conectada pode entregar uma imagem sem utilidade; a prévia e os eventos do navegador não garantem identidade.

## Histórico e validação

O usuário validou a simulação em novembro com a câmera de um celular Android conectada ao Windows e confirmou as quatro miniaturas e o aviso no canto. Em 08/11, confirmou também o fluxo real e a consulta das fotos pelo professor na base de testes. O cron da limpeza respondeu HTTP 200. A documentação de execução e privacidade descreve os cenários manuais restantes.
