# Fluxo da prova com câmera, fotografias e reativação

Fluxograma da implementação da `entrega0911`, conferido com as telas e as funções de 025–032. Os diagramas descrevem o ambiente com gerenciamento e fotografias habilitados. As simulações locais continuam separadas da tentativa real.

## 1. Preparação e início

A preparação fica dentro de **Minhas provas**. Antes de criar a tentativa, a câmera precisa estar disponível e os avisos precisam estar confirmados. A autorização de aluno, matrícula e período é conferida pelo servidor.

```mermaid
flowchart TD
    A["Login com senha e MFA"] --> B["Abrir Minhas provas e escolher avaliação"]
    B --> C["Conferir imagem da câmera e ler os documentos"]
    C --> D{"Câmera pronta e dois aceites confirmados?"}
    D -->|Não| E["Manter preparação; não criar tentativa"]
    E --> C
    D -->|Sim| F["Aluno confirma o início"]
    F --> G{"Servidor autoriza aluno, matrícula, período e tentativa?"}
    G -->|Não| H["Informar impedimento; não abrir questões"]
    G -->|Sim| I["Criar tentativa única ou consumir retomada autorizada; iniciar prazo"]
    I --> J["Definir no servidor os três horários aleatórios do ciclo"]
    J --> K["Capturar e enviar a foto inicial"]
    K --> L{"Recebimento confirmado?"}
    L -->|Não| M["Manter questões ocultas; tentar reenviar a mesma captura"]
    M --> L
    L -->|Sim| N["Exibir questões na ordem persistida e recuperar respostas salvas"]
```

O aceite geral e o consentimento das fotos são separados e começam desmarcados. O prazo começa quando o servidor confirma a tentativa; o preparo da foto inicial ocorre depois desse início. Falha de conexão no envio não é classificada como falha de câmera.

## 2. Durante a tentativa

As capturas posteriores são programadas conforme a duração disponível, sem abrir outra janela nem tirar o foco do aluno. Uma prova enviada antes dos horários restantes não aguarda novas fotos.

```mermaid
flowchart TD
    A["Tentativa em andamento"] --> B["Responder questões; usar Salvar resposta"]
    B --> C{"O que acontece durante a execução?"}
    C -->|Horário sorteado| D["Capturar foto; mostrar aviso no canto; enviar em segundo plano"]
    D --> E{"Envio confirmado?"}
    E -->|Sim| B
    E -->|Não| F["Guardar captura temporária; permitir reenvio sem bloquear respostas"]
    F --> B
    C -->|Sinal da câmera interrompido| G["Ocultar questões e conferir a câmera"]
    G --> H{"Sinal voltou em até três segundos?"}
    H -->|Sim| B
    H -->|Não| I["Interromper tentativa; ocultar questões; parar câmera e capturas"]
    C -->|Câmera encerrada ou falha informada| I
    C -->|Saída da página, aba ou foco da janela| I
    C -->|Aluno confirma envio| J["Salvar respostas preenchidas e tentar concluir envios pendentes"]
    J --> K["Finalizar tentativa; parar câmera e cancelar capturas futuras"]
    C -->|Prazo termina| K
    I --> L["Sem retorno automático; responsável analisa eventual reativação"]
```

As respostas não têm salvamento automático periódico: são gravadas pelo botão **Salvar resposta** e, quando possível, ao confirmar o envio da prova. Ao vencer o prazo ou ocorrer uma interrupção, respostas ainda não salvas podem se perder.

O sistema observa visibilidade da aba, perda de foco e saída da página. Não exige tela cheia nem trata copiar/colar como ocorrência nesta implementação. Uma faixa de câmera encerrada ou a falha informada pelo aluno interrompe sem esperar o prazo de recuperação de um sinal temporário. Não há contagem de três falhas para liberar retornos automáticos.

Fechar o navegador ou perder a rede pode impedir que o encerramento chegue imediatamente ao banco. O prazo continua correndo, e uma nova chamada de início não oferece retorno automático. A detecção de imagem preta depende do dispositivo; existe o botão **Minha imagem ficou preta**.

## 3. Responsável, reativação e retenção

A consulta das fotos pode ocorrer enquanto a tentativa está em andamento ou depois de encerrada, respeitando acesso e validade. A autorização não depende apenas de o botão estar visível: as funções do banco conferem perfil, sessão, MFA e vínculo com a organização/avaliação.

```mermaid
flowchart TD
    A["Professor responsável ou ADM da mesma organização, com MFA"] --> B["Abrir Turmas, Publicadas e Gerenciar avaliação"]
    B --> C["Consultar tentativas e fotografias autorizadas para análise manual"]
    C --> D["Registrar consulta na auditoria"]
    B --> E{"Tentativa interrompida e ainda sem liberação pendente?"}
    E -->|Não| F["Não oferecer reativação por este fluxo"]
    E -->|Sim| G["Informar motivo e minutos; conferir janela da avaliação"]
    G --> H["Registrar autorização e responsável; aguardar o aluno"]
    H --> I["Aluno prepara câmera e confirma avisos novamente"]
    I --> J["Retomar a mesma tentativa em novo ciclo; preservar respostas, ordem e histórico"]
    J --> K["Nova foto inicial e novos horários de captura; prazo limitado ao fim da avaliação"]
    C --> L["Imagens em armazenamento privado; até 90 dias por captura"]
    L --> M["Limpeza diária identifica arquivos elegíveis e os remove pelo Storage"]
    M --> N["Confirmar exclusão nos metadados e registrar evento"]
```

Tentativa finalizada por envio ou prazo não é reaberta por esse procedimento. A retomada autorizada não apaga os eventos anteriores e exige outro consentimento para novas fotos.

O limite de 90 dias é conservador, ancorado no horário programado no servidor; atrasos e reenvios não o estendem. A rotina diária trabalha com antecedência para respeitar o limite. Falhas de exclusão precisam ser acompanhadas e repetidas. O acesso é negado após a validade mesmo se uma remoção física estiver pendente. Revogação do consentimento bloqueia novos envios e consultas dos ciclos envolvidos e os inclui na limpeza.

Não há gravação contínua de áudio ou vídeo, reconhecimento facial nem identificação automática de fraude. As imagens são evidências para análise humana, sem garantia de identidade por si só.

## Referências da implementação

- `src/components/TentativaMonitoradaPanel.tsx`: preparo, aceite, respostas, câmera e permanência.
- `src/hooks/useExamPhotos.ts`: programação, captura e reenvio das fotos.
- `src/components/TentativasResponsavelPanel.tsx`: consulta e liberação pelo responsável.
- `database/030_reativacao_autorizada.sql`: autorização excepcional e preservação das respostas.
- `database/031_fotos_tentativa.sql`: consentimentos, horários, autorização das imagens e retenção.
- `supabase/functions/examentech-limpar-fotos/index.ts`: remoção dos arquivos elegíveis.

Veja também o [roteiro de testes](tentativas-prova.md), a [ativação](ativar-fotos-e-reativacao.md) e a [limpeza automática](limpeza-fotos-supabase.md).
