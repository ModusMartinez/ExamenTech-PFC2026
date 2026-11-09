# Termos, Política e consentimento das fotografias

Os textos exibidos pelo sistema estão em `src/content/legalDocuments.ts`. Responsáveis e contato da demonstração são identificados ali. A monografia e a ficha não são alteradas automaticamente por mudanças no código.

## Versões por ambiente

| Configuração | Termos | Política | Banco de novos aceites |
| --- | --- | --- | --- |
| Fotos e gerenciamento desligados | `2026-11-06-v5` | `2026-11-06-v4` | `029_versoes_documentos.sql`. |
| Gerenciamento ou fotos habilitados | `2026-11-08-v6` | `2026-11-08-v5` | `032_documentos_fotos.sql`, após conferir os pré-requisitos. |

Após aplicar 032, mantenha `VITE_EXAM_MANAGEMENT_ENABLED=true`, mesmo se desativar as fotos. Isso apresenta os documentos novos que o banco exige no cadastro. Não reaplique os scripts antigos de versões após a atualização. Os registros anteriores de aceite são preservados; contas existentes não recebem aceite retroativo.

O aviso base de execução é `2026-11-06-v2`. O aviso específico de fotografias é `2026-11-08-fotos-v1`, registrado por ciclo em `avisos_fotos_tentativa`, com versões dos documentos e horário do servidor.

## Cadastro e consulta dos textos

**Criar conta** abre os Termos antes do formulário. A caixa de aceite começa desmarcada; cancelar ou fechar não registra aceite. Só a criação válida da conta grava o aceite no gatilho do Auth, na mesma transação de cadastro. Metadados posteriores de usuário não alteram o aceite já registrado.

As páginas públicas `/termos` e `/privacidade` podem ser consultadas sem login e têm links no rodapé. Durante o preparo e a execução da prova, esses links abrem um diálogo dentro da página para não exigir troca de aba. Ler o documento não registra novo aceite.

O formulário usa as constantes de versão do código, não valores digitados pelo usuário. O gatilho confere o booleano de aceite e as versões exigidas; uma divergência deve ser corrigida alinhando interface e banco.

## Prova e imagens

Antes da tentativa, há ciência das regras de câmera, permanência e respostas. Quando as fotografias estão habilitadas, uma **segunda caixa desmarcada** solicita consentimento específico para a demonstração voluntária, informando captura, envio, finalidade, acesso e prazo. Permitir câmera no navegador não substitui esse consentimento.

Uma foto inicial e até três fotos aleatórias por ciclo são guardadas em bucket privado, para análise manual pelo professor responsável ou ADM da mesma organização. Uma retomada autorizada exige novo consentimento e novas capturas. Se a prova for enviada antes dos horários seguintes, não haverá essas fotos futuras.

Não são gravados áudio ou vídeo contínuo, nem extraídos atributos faciais para reconhecimento automático. As imagens não comprovam identidade ou fraude sozinhas. Evite expor terceiros e documentos no enquadramento. O uso é uma demonstração acadêmica voluntária destinada a adultos, sem aplicação de avaliações escolares oficiais.

## Conservação, exclusão e atendimento

- **Fotografias:** prazo máximo de 90 dias por captura, decisão confirmada pela equipe. O horário programado dá um limite conservador; atrasos e reenvios não estendem a validade. A rotina diária remove arquivos pelo Storage e só depois confirma a exclusão nos metadados. Trabalha com antecedência de até 26 horas para cobrir o intervalo entre execuções.
- **Demais dados identificáveis da demonstração:** até 3 meses por registro, com procedimento administrativo. A rotina de fotos não apaga automaticamente contas, respostas e logs. Trate metadados identificáveis e cópias no encerramento e no atendimento.
- **Revogação:** pelo contato `modusmartinezex@gmail.com`. Após verificar a identidade com dados mínimos, a equipe registra a revogação nos ciclos envolvidos, bloqueia novos envios/consultas e executa a limpeza. Veja o procedimento em [ativação das fotos](ativar-fotos-e-reativacao.md).
- **Fornecedores e backups:** considere os ciclos e limites dos serviços configurados ao atender solicitações. Os documentos não prometem eliminar instantaneamente cópias fora do controle da equipe.

O prazo de 90 dias é uma decisão do projeto, não um prazo geral estabelecido pela LGPD. A equipe precisa acompanhar falhas de exclusão e repetir o trabalho; foto inacessível não significa arquivo apagado.

## Arquivos principais

| Arquivo | Responsabilidade |
| --- | --- |
| `src/content/legalDocuments.ts` | Texto, versões, responsáveis e contato. |
| `src/components/LegalContent.tsx`, `LegalModal.tsx`, `LegalPage.tsx`, `LegalFooter.tsx` | Consulta pública e diálogos. |
| `src/components/TentativaMonitoradaPanel.tsx` | Ciência e consentimento específico antes da prova. |
| `database/008_aceite_termos.sql` | Estrutura e gatilho inicial de aceites. |
| `database/029_versoes_documentos.sql`, `032_documentos_fotos.sql` | Versões exigidas em novos cadastros. |
| `database/031_fotos_tentativa.sql` | Consentimento por ciclo, retenção e revogação. |
| `supabase/functions/examentech-limpar-fotos/index.ts` | Exclusão dos arquivos elegíveis e confirmação dos metadados. |

## Validação

No ambiente de testes, o usuário confirmou a aplicação de 032, o envio das fotos e a consulta pelo professor. A função de limpeza respondeu HTTP 200 com zero arquivos removidos; a remoção física de um objeto vencido deve ser validada separadamente com uma foto fictícia. Os testes locais verificam consentimento, versões, autorização, revogação e limpeza com banco/serviços simulados.

Antes de uma nova implantação, confira textos e versões, aceite no cadastro, duas caixas antes da prova, consulta dos documentos sem interromper a tentativa, isolamento de responsáveis e retirada de imagem vencida. Não inclua fotos reais nem tokens nas evidências da entrega.

Os textos históricos estão em [historico](historico/): termos e política de setembro e a versão de novembro anterior à integração. Os diagramas da entrega de setembro também são históricos. A documentação acadêmica consolidada continua sendo uma revisão da equipe.
