# Professores e tela de auditoria

## Quem pode emitir convites

| Conta conectada | Convite para aluno | Convite para professor | Consultar auditoria |
| --- | --- | --- | --- |
| Administrador ativo com MFA | Sim, escolhendo a organização | Sim, escolhendo a organização | Sim |
| Professor ativo com MFA | Somente da própria organização | Não | Não |
| Aluno | Não | Não | Não |

As permissões são verificadas no banco. Esconder os botões não é a proteção
principal: chamadas diretas de professor para emitir outro professor também
são recusadas. O cadastro por convite nunca cria um administrador.

## Cadastro e login do professor

1. Administrador entra com MFA, escolhe a organização e seleciona **Professor**
   em **Tipo de conta**.
2. Informa o e-mail do professor e gera o convite. O token aparece na tela,
   vale por sete dias e deve ser entregue por um canal seguro.
3. Professor abre **Criar conta**, aceita os termos e preenche o mesmo formulário
   usado pelos alunos, com código da organização e convite individual.
4. O banco cria `PROFESSOR/ATIVO` na organização do convite. Não há aprovação manual.
5. Professor confirma o e-mail e entra pela mesma tela de login. Configura ou
   confirma o Authenticator antes de acessar o painel.
6. No painel, pode emitir convites de alunos da própria organização.

O convite não entra no lugar da senha. O e-mail informado precisa ser o mesmo
para o qual ele foi emitido. O envio automático do convite ainda não foi
implementado; o SMTP do Supabase continua cuidando da confirmação de e-mail.

## O que cada parte chama

- `InvitationPanel.tsx`: administrador escolhe Aluno ou Professor. Professor
  não tem seletor de perfil nem de organização.
- `emitir_convite_professor`: encaminha para a função privada de emissão,
  que exige ADMIN ativo com MFA.
- `emitir_convite_aluno`: usa a mesma função privada, permitindo ADMIN ou
  PROFESSOR ativo com MFA; professor fica limitado à própria organização.
- `App.tsx`: chama `preparar_cadastro` com e-mail e os dois códigos. Recebe um
  ticket de cinco minutos e o envia ao `supabase.auth.signUp()` com o aceite.
- Gatilho de convite: confere e consome ticket/convite. Continua sendo o de `005`.
- `criar_perfil_novo_usuario()`: lê `perfil_destino` do convite consumido e
  cria o perfil. Ignora perfil, situação e RGM enviados nos metadados.

As tabelas `convites_aluno` e `tickets_cadastro_aluno` mantiveram os nomes antigos
para preservar dados e integrações. Agora atendem aos dois perfis. Convites
antigos recebem `perfil_destino = 'ALUNO'`; usuários antigos não são promovidos
nem alterados. Os códigos individuais continuam armazenados como hash.

## Auditoria básica

No painel do administrador, abra **Auditoria**. A tela contém:

- Até 50 eventos por consulta, ordenados do mais recente ao mais antigo.
- Filtro por tipo de evento e botão **Atualizar**.
- Data/hora local, evento, resultado, ID do usuário, origem/ação e códigos de erro.
- Avisos de carregamento, consulta vazia e falha de acesso ou conexão.

`AuditPanel.tsx` consulta diretamente `eventos_seguranca`, selecionando só os
campos mostrados. A RLS existente exige ADMIN ativo e MFA. A tela não grava,
edita nem apaga eventos; não usa chave secreta. IDs são identificadores, não
tokens de sessão. Eventos técnicos ou de contas excluídas podem não ter usuário
associado.

Ela mostra os eventos já registrados: cadastro, acesso autorizado/negado após
MFA e a integração separada do Turnstile. Não mostra os logs internos do Auth.
Falhas de senha ou MFA, emissão de convites e ações acadêmicas ainda não têm
registro nessa tabela. Não há exportação, pesquisa por usuário ou paginação
nesta primeira versão; o limite de 50 vale também quando um filtro é escolhido.

## Ativar no Supabase

1. Confira se `001` a `007` já foram aplicados no Supabase usado pela aplicação.
2. Se ainda não aplicou os termos, execute `008_aceite_termos.sql` primeiro.
3. Execute **`009_convites_professor.sql`** completo. Se `008` já estiver pronto,
   execute somente `009`. Não reaplique as versões antigas por cima da nova.
4. Execute `010_documentos_lgpd.sql` para usar as versões atuais dos documentos. Se `008`/`009` já foram aplicados, execute somente `010`.
5. Use o front-end atualizado e mantenha `VITE_INVITES_ENABLED=true`.

O SQL não foi executado automaticamente no banco remoto. `009` adiciona o perfil
do convite, as funções de emissão/cadastro e atualiza o gatilho de perfil.
Também exigia a versão `2026-09-27-v2` dos termos. A atualização `010` passa a
exigir termos `2026-09-27-v3` e política `2026-09-27-v2`. Aceites antigos continuam
na versão original. A equipe confirmou o fluxo de `008`/`009` no Supabase;
`010` ainda precisa ser aplicada junto ao front-end revisado.

Sem `009`, as novas chamadas não estão disponíveis e o cadastro com a nova
versão dos termos é recusado. A tela de auditoria usa as permissões já existentes
em `002`/`006`, sem liberar acesso a professor ou aluno.

Os textos atuais identificam os integrantes da ficha do PFC, contato, uso em
demonstração e prazo de três meses. Consulte [termos e privacidade](termos-privacidade.md).

## Conferência da equipe

- Como ADMIN, emita um convite de professor e copie o código antes de sair da tela.
- Em outra sessão do navegador, cadastre o professor com o e-mail correto.
- Confirme `PROFESSOR/ATIVO` e a organização em `perfis`; aceite em `aceites_termos`.
- Confirme o e-mail, configure MFA e entre como professor, sem aprovação manual.
- Emita um convite para aluno e confira o cadastro `ALUNO/ATIVO` na mesma escola.
- Professor não deve ver o seletor de Professor nem a seção Auditoria.
- ADMIN deve ver cadastro/login na auditoria. Teste filtro e atualização.
- Não publique tokens, senhas, QR de MFA ou dados pessoais nas capturas.

`npm test`, `npm run lint` e `npm run build` verificam o projeto localmente.
Os testes SQL exercitam as permissões, o fluxo completo e recusas com códigos
expirados/reutilizados, e-mail diferente, organização inativa ou aceite inválido.
O Auth HTTP, o envio de e-mail e o Authenticator real ainda precisam dessa
conferência manual no ambiente escolhido pela equipe.
