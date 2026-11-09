# Fluxo da prova com sessão e fotografias

Fluxograma da implementação da `entrega0911` com as regras da migração 043. O fluxo monitorado se aplica a Provas. Atividades usam a tentativa única sem câmera, tela cheia ou bloqueio da área de transferência. A simulação local continua separada da tentativa real.

## 1. Preparação e início

A preparação fica dentro de **Minhas provas**. Antes de criar a tentativa de uma Prova, a câmera precisa estar disponível, os avisos precisam estar confirmados e o navegador precisa entrar em tela cheia. O servidor confere a autorização do aluno, a matrícula, o período e os avisos.

```mermaid
flowchart TD
    A["Login com senha e MFA"] --> B["Abrir Minhas provas e escolher avaliação"]
    B --> C["Conferir imagem da câmera e ler os documentos"]
    C --> D{"Câmera pronta e dois aceites confirmados?"}
    D -->|Não| E["Manter preparação; não criar tentativa"]
    E --> C
    D -->|Sim| F["Aluno confirma o início"]
    F --> P{"Navegador entrou em tela cheia?"}
    P -->|Não| E
    P -->|Sim| G{"Servidor autoriza aluno, matrícula, período e tentativa?"}
    G -->|Não| H["Informar impedimento; não abrir questões"]
    G -->|Sim| I["Criar tentativa única, vincular sessão e página e iniciar prazo"]
    I --> J["Definir no servidor os três horários aleatórios da tentativa"]
    J --> K["Capturar e enviar a foto inicial"]
    K --> L{"Recebimento confirmado?"}
    L -->|Não| M["Manter questões ocultas; tentar reenviar a mesma captura"]
    M --> L
    L -->|Sim| N["Exibir questões na ordem persistida, sem gabarito"]
```

O aceite geral e o consentimento das fotos são separados e começam desmarcados. O prazo começa quando o servidor confirma a tentativa; o preparo da foto inicial ocorre depois desse início. Falha de conexão no envio não é classificada como falha de câmera.

## 2. Durante a tentativa

As capturas posteriores são programadas conforme a duração disponível, sem abrir outra janela nem tirar o foco do aluno. Uma prova enviada antes dos horários restantes não aguarda novas fotos.

```mermaid
flowchart TD
    A["Tentativa em andamento"] --> B["Responder questões com salvamento automático por versão"]
    B --> C{"O que acontece durante a execução?"}
    C -->|Horário sorteado| D["Capturar foto; mostrar aviso no canto; enviar em segundo plano"]
    D --> E{"Envio confirmado?"}
    E -->|Sim| B
    E -->|Não| F["Guardar captura temporária; permitir reenvio sem bloquear respostas"]
    F --> B
    C -->|Falha só na câmera| G["Registrar ocorrência e manter as questões disponíveis"]
    G --> B
    C -->|Copiar, colar ou recortar| P["Bloquear operação e registrar o tipo; manter a execução"]
    P --> B
    C -->|Sair da tela cheia, trocar aba ou perder foco| Q["Interromper e registrar a causa"]
    Q --> I["Bloquear a execução e cancelar capturas e salvamentos futuros"]
    C -->|Saída, recarga ou perda de conexão detectada| I
    C -->|Aluno confirma envio| J["Salvar respostas preenchidas e tentar concluir envios pendentes"]
    J --> K["Finalizar tentativa; parar câmera e cancelar capturas futuras"]
    C -->|Prazo termina| K
    C -->|Professor cancela a avaliação| R["Servidor encerra a tentativa e a tela informa o aluno via Realtime"]
    I --> L["Registrar encerramento quando houver conexão e preservar respostas recebidas"]
```

O banco exige a sessão inicial e a chave da página em todas as operações de execução. A página pode confirmar o encerramento após reconectar. Uma nova página não tem a chave inicial. O navegador pode fechar antes de registrar a interrupção no banco.

## 3. Consulta de fotos e retenção

A consulta das fotos pode ocorrer enquanto a tentativa está em andamento ou depois de encerrada, respeitando acesso e validade. A autorização não depende apenas de o botão estar visível: as funções do banco conferem perfil, sessão, MFA e vínculo com a organização/avaliação.

```mermaid
flowchart TD
    A["Professor responsável ou ADM da mesma organização, com MFA"] --> B["Abrir Turmas, Publicadas e Gerenciar avaliação"]
    B --> C["Consultar tentativas e fotografias autorizadas para análise manual"]
    C --> D["Registrar consulta na auditoria"]
    C --> L["Imagens em armazenamento privado; até 90 dias por captura"]
    L --> M["Limpeza diária identifica arquivos elegíveis e os remove pelo Storage"]
    M --> N["Confirmar exclusão nos metadados e registrar evento"]
```

A consulta pelo responsável preserva o histórico da tentativa. A tentativa não pode ser reaberta.

O limite de 90 dias é conservador, ancorado no horário programado no servidor; atrasos e reenvios não o estendem. A rotina diária trabalha com antecedência para respeitar o limite. Falhas de exclusão precisam ser acompanhadas e repetidas. O acesso é negado após a validade mesmo se uma remoção física estiver pendente. Revogação do consentimento bloqueia novos envios e consultas dos ciclos envolvidos e os inclui na limpeza.

Não há gravação contínua de áudio ou vídeo, reconhecimento facial nem identificação automática de fraude. As imagens são evidências para análise humana, sem garantia de identidade por si só.

## Referências da implementação

- `src/components/TentativaMonitoradaPanel.tsx`: preparo, aceite, respostas, câmera e permanência.
- `src/hooks/useExamPhotos.ts`: programação, captura e reenvio das fotos.
- `src/components/TentativasResponsavelPanel.tsx`: consulta pelo responsável.
- `database/038_tentativa_sessao.sql`: vínculo com a sessão inicial e bloqueio de retomada.
- `database/043_execucao_segura_prova.sql` exige a foto inicial e registra ocorrências.
- `database/031_fotos_tentativa.sql`: consentimentos, horários, autorização das imagens e retenção.
- `supabase/functions/examentech-limpar-fotos/index.ts`: remoção dos arquivos elegíveis.

Veja também o [roteiro de testes](tentativas-prova.md), a [ativação](ativar-fotos-e-reativacao.md) e a [limpeza automática](limpeza-fotos-supabase.md).
