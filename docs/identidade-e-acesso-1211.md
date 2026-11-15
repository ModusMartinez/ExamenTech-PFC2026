# Identidade e acesso — RF01–RF06 — 12/11/2026

Base: ZIP da branch `entrega0911`, com dashboard e migrações até 044. Esta atualização prepara código e SQL locais; a aplicação das migrações e a publicação são realizadas separadamente pela equipe.

## Cadastro e RGM

O convite continua determinando organização e perfil; o formulário não permite escolher privilégios. Para alunos novos, o RGM é obrigatório. Professores não recebem RGM discente. Contas anteriores sem RGM permanecem válidas.

`preparar_cadastro_com_rgm` valida os códigos existentes e associa o RGM ao ticket temporário privado. O gatilho do Auth cria o perfil a partir desse ticket, ignorando RGM/perfil enviados em metadados mutáveis. A validação acontece no formulário e no banco. RGM vazio para aluno, formato inválido e duplicidade geram mensagens específicas antes do cadastro; uma colisão concorrente também é bloqueada pelo índice e desfaz a transação.

O formato técnico aceita de 1 a 50 caracteres: começa por letra ou número e permite letras ASCII, números, ponto, hífen, barra e sublinhado. Espaços externos são removidos e letras convertidas para maiúsculas; zeros iniciais são preservados. A ficha não estabelece quantidade institucional de dígitos. O limite técnico não comprova a autenticidade do registro. A unicidade global já existia e passa a considerar também caixa e espaços externos. Se houver colisões em dados antigos, 045 interrompe a aplicação para revisão manual.

## Primeira turma

A ficha informa “aluno depende da primeira turma”, sem detalhar os estados. Nesta implementação, a conta continua `ATIVO`, permitindo solicitar e acompanhar matrícula após o MFA. Enquanto nunca houve matrícula aprovada na organização, o aluno vê somente o ingresso inicial. Depois da aprovação, o botão **Verificar liberação** consulta novamente o servidor e libera o painel.

Vínculos já aprovados e depois inativados preservam o ingresso e a consulta do histórico. Inativar uma turma ou matrícula não concede acesso a novas avaliações: as APIs de avaliações continuam exigindo matrícula e turma ativas, período válido e demais regras existentes. A consulta de ingresso considera todos os vínculos, sem depender da listagem limitada a 50 itens. Conta ou organização inativa e sessão sem MFA continuam recusadas.

## Redefinição do 2FA

Em **Administrador → Redefinir 2FA**, busque o nome/e-mail de um aluno ou professor ativo da mesma organização. Confirme a identidade do titular antes de selecionar a conta e confirmar a ação. O sistema não solicita senha nem código do autenticador ao administrador.

A API valida a sessão e registra uma autorização no banco antes de usar a Admin API do Supabase. A credencial privada fica somente no servidor. São removidos os fatores antigos, conferida a remoção, encerradas as sessões da conta e registrado o resultado. No próximo login com senha, o fluxo existente exige cadastrar e verificar um novo autenticador. A senha, o perfil, as matrículas e os resultados são preservados. Falha parcial exibe orientação para conferir a auditoria; não é apresentada como sucesso.

Este fluxo não permite redefinir a própria conta nem contas ADMIN. Administradores antigos sem `organizacao_id` precisam ser vinculados administrativamente à organização correta antes de usar esta tela. Não há concessão automática de alcance global.

A migração 046 usa uma função restrita a `service_role` para invalidar sessões em `auth.sessions`, porque a remoção do fator, por si só, não elimina um JWT já emitido. O SQL verifica a compatibilidade da FK de refresh tokens quando essa tabela existe. As RPCs verificam a sessão e a emissão de convites também passa a recusá-la após encerramento. Reavalie a compatibilidade com o esquema Auth ao atualizar o Supabase. Não manipule essas tabelas manualmente durante os testes.

## Preparação do ambiente

1. Confira com a equipe se a base já está alinhada até 044. Use primeiro uma base de testes e preserve seu backup.
2. Aplique, nesta ordem: `045_rgm_cadastro.sql`, `046_redefinicao_mfa.sql`, `047_ingresso_primeira_turma.sql`, `048_documentos_identidade.sql`. Cada arquivo usa transação. Pare diante de qualquer erro e confira a mensagem antes de prosseguir.
3. Execute `docs/diagnostico-identidade-1211.sql`. Os indicadores devem retornar `true`.
4. Configure o `.env.local` pelo `.env.example`, usando o mesmo projeto na interface e na API. O cadastro por convite usa `VITE_INVITES_ENABLED=true`. A redefinição exige `SUPABASE_SECRET_KEY` ou `SUPABASE_SERVICE_ROLE_KEY` somente no servidor. Nunca use prefixo `VITE_` para a credencial privada.
5. Instale as dependências com `npm.cmd ci` e inicie interface/API com `npm.cmd run dev:full`.

A nova interface e 045–048 devem ser entregues juntas. Sem as RPCs, o ingresso inicial permanece bloqueado com orientação de configuração. A 048 exige as versões novas dos documentos somente em novos cadastros; aceites anteriores não são reescritos. Os textos anteriores foram preservados em `docs/historico/documentos-2026-11-08-identidade.txt`.

## Roteiro de validação manual

- Cadastre aluno com convite novo e RGM fictício. Confira o perfil no banco; tente vazio, caracteres inválidos e duplicidade com caixa/espaços diferentes. Cadastre também professor e confirme que seu perfil continua definido pelo convite.
- Entre com aluno novo, confirme o MFA e solicite matrícula. Antes da aprovação, confira que não há acesso ao painel acadêmico; após aprovação, use **Verificar liberação**. Confirme que outro aluno não herda a liberação. Confira o histórico de uma conta com matrícula já inativada.
- Com ADMIN da mesma organização e MFA, busque uma conta fictícia, confira o destinatário, confirme a redefinição e verifique a auditoria. No navegador da conta afetada, encerre a sessão local se necessário e entre com senha: deve pedir nova configuração do Authenticator, não o código antigo.
- Confirme que professor, aluno, sessão sem MFA, ADMIN de outra organização e chamadas diretas sem autorização não conseguem redefinir. Não use contas reais ou a única conta administrativa para este teste.
- Confira cadastro, recuperação de senha, matrículas, provas, fotografias e dashboards já existentes. Os documentos legais devem continuar acessíveis pelo rodapé em todas as telas.

Verificações automatizadas: `npm.cmd run build`, `npm.cmd run lint`, `npm.cmd test`. Os testes usam PostgreSQL local em memória e serviços simulados; não criam contas nem alteram um Supabase remoto. Eles não substituem a validação manual do envio de e-mail e do Authenticator no projeto configurado.
