# Integração local da desenv — 08/11/2026

Esta cópia parte do estado `369ecb523b3b5ee88e5e8d8a4f36b57aa024d6e2` da `desenv`. A preparação para publicação usa a branch proposta **0911**. Não se presume que esse commit seja o estado atual do remoto: confira atualizações dos colegas antes de aplicar as mudanças.

## Implementação atual

- Recuperação de senha, MFA e auditoria de acesso foram preservados e corrigidos na integração.
- A lista **Minhas provas** mantém cartões e simulação. Não há aba separada de pré-prova. O fluxo real usa `MinhasAvaliacoesPanel`, `TentativaMonitoradaPanel` e `services/tentativas.ts`.
- 023–027 seguem o contrato da equipe para publicação, listagem, início, ordem e conteúdo. A 028 acrescenta respostas e encerramento; 029 corresponde às versões anteriores dos documentos de novembro.
- 030 acrescenta liberação excepcional pelo professor responsável ou ADM da organização, preservando respostas e histórico. 031 acrescenta foto inicial, até três capturas aleatórias e acesso privado. 032 exige as novas versões dos documentos em novos cadastros.
- A limpeza pode rodar no Supabase por Edge Function + cron + Vault, sem depender de o site estar publicado ou de o computador permanecer ligado. O código e modelos não guardam o token; arquivos preenchidos terminam em `.local`.
- O protótipo anterior está em `src/dev/legacy` e não participa da navegação atual. As páginas isoladas de câmera/fotos em `dev/` continuam disponíveis para desenvolvimento.

## Base de testes

A base de testes usou anteriormente outro modelo de 023/024. A ponte `conciliar-banco-provas-teste.sql` foi preparada para esse diagnóstico específico, preservando uma tentativa e uma resposta antigas. Não é instalação geral e não deve ser reaplicada sobre a base conciliada.

Em 08/11, o usuário confirmou aplicação de 030, 031 e 032, bucket privado, função de limpeza publicada e cron ativo. A execução de conferência devolveu HTTP 200, sem timeout, com zero itens removidos. Confirmou também realização da prova com fotos e consulta das imagens pelo professor.

O envio real está habilitado apenas no arquivo privado do ambiente testado. O `.env.example` continua sem chaves e exige configuração consciente em outro ambiente. A publicação do código não configura o Supabase principal.

## Validação e pendências

O fluxo de fotos, banco, permissões, reativação e limpeza tem cobertura automatizada local, com serviços simulados. A execução do conjunto completo deve ser repetida antes do commit; resultados da preparação são registrados no pacote de entrega.

Conferência manual ainda a registrar: reativação pelo professor e ADM, recusa para outros responsáveis, revogação e remoção física de arquivo vencido. A monografia, ficha e diagramas de setembro devem ser alinhados ao comportamento de novembro pela equipe; não são editados por esta organização do código.

Roteiros atuais: [tentativas e fotos](tentativas-prova.md), [ativação](ativar-fotos-e-reativacao.md), [limpeza em localhost](limpeza-fotos-supabase.md), [privacidade](termos-privacidade.md) e [branch 0911](entrega-0911.md).
