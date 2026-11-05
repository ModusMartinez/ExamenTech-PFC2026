# Termos de Uso e Política de Privacidade

Termos atuais: `2026-09-27-v3`. Política: `2026-09-27-v2`.
Histórico preservado: [termos v1](historico/termos-2026-09-27.md),
[termos v2](historico/termos-2026-09-27-v2.md) e
[política v1](historico/privacidade-2026-09-27.md).

## Fluxo da tela

1. **Criar conta** abre os Termos de Uso, antes do formulário.
2. A caixa **Li e aceito os Termos de Uso** fica no final do texto e começa desmarcada.
3. **Continuar para o cadastro** só fica disponível após marcar a caixa.
4. Cancelar, fechar ou pressionar `Esc` mantém a tela de login. Nada é gravado.
5. Ao concluir um cadastro válido, o banco registra a versão aceita junto da conta.

Os links pequenos no rodapé de **todas as telas** levam às páginas públicas
`/termos` e `/privacidade`. Estão presentes no login, cadastro, MFA, carregamento
de sessão e painéis de aluno, professor e administrador, incluindo auditoria.
Nas telas do sistema abrem em outra aba, preservando formulário e sessão. Nas
páginas de documentos, os links navegam na mesma aba. Ler não registra aceite.
O modal obrigatório antes do cadastro continua separado da consulta pública.
Voltar do cadastro para o login e iniciar outra tentativa exige novo aceite.

O modal usa o elemento nativo `dialog`: fundo indisponível enquanto aberto,
rolagem no texto e foco inicial no título. Ao fechar, o foco retorna ao botão;
ao continuar, vai para o nome no cadastro. Referência: [padrão de modal do W3C](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/).

## Arquivos e chamadas importantes

| Arquivo | Responsabilidade |
| --- | --- |
| `src/content/legalDocuments.ts` | Textos, versões, responsável e contato. |
| `src/components/LegalFooter.tsx` | Links discretos em todas as telas. |
| `src/components/LegalPage.tsx` | Páginas públicas com título e conteúdo. |
| `src/components/LegalContent.tsx` | Mesmo texto para página e modal. |
| `src/components/LegalModal.tsx` | Janela, checkbox, consulta da política e botões. |
| `src/styles/legal.css` | Aparência e adaptação para telas pequenas. |
| `src/App.tsx` | Abre o modal, libera o formulário e envia a declaração no cadastro. |
| `database/008_aceite_termos.sql` | Cria a tabela e o gatilho de aceite. |
| `database/009_convites_professor.sql` | Atualiza a versão exigida para os termos com cadastro de professor. |
| `database/010_documentos_lgpd.sql` | Exige as versões atuais sem alterar aceites antigos. |
| `vercel.json` | Faz os endereços dos documentos abrirem diretamente na Vercel. Não redireciona `/api`. |

O `App` escolhe a página pública pelo endereço antes de montar `AccessApp`.
Assim, a leitura não espera Auth, banco ou MFA. O rodapé fica fora das condições
de acesso e aparece também quando a sessão está carregando ou falha.

Em `AccessApp`, `startRegistration()` abre a janela sem aceite. A marcação apenas
habilita o botão; `acceptTermsAndRegister()` guarda a versão na memória e abre
o formulário. `handleRegister()` confere essa versão antes de chamar qualquer
serviço de cadastro.

Depois das validações de campos e CAPTCHA, `preparar_cadastro_aluno` troca os
códigos por um ticket (agora chamado por `preparar_cadastro`). `supabase.auth.signUp()` recebe o ticket, o nome e:

```ts
termos_aceitos: true
termos_versao: '2026-09-27-v3'
privacidade_versao: '2026-09-27-v2'
```

`privacidade_versao` identifica a política disponibilizada com os termos. Não é
um consentimento genérico para tratamento de dados. A caixa registra uma
declaração; ela não comprova que a pessoa leu todo o texto.

## Ativação no Supabase

Com `001` a `009` já aplicados, execute somente **`database/010_documentos_lgpd.sql`**,
completo, no SQL Editor do projeto usado pelo site. Em um ambiente novo, siga a
sequência dos arquivos. Não reaplique `008` ou `009` depois de `010`: eles exigem
versões anteriores. Publique o front-end atualizado junto desta alteração.

Os arquivos foram testados em PostgreSQL local, não executados automaticamente
no Supabase remoto. A equipe confirmou aplicação e teste de `008`/`009`.
**Sem `010`, o banco exige as versões anteriores e recusa novos cadastros feitos
com o texto atual.** A atualização não apaga registros nem solicita novo aceite
de contas existentes.

O gatilho `examentech_registrar_aceite_termos` chama
`examentech_private.registrar_aceite_termos()` após inserir a conta no Auth.
Exige o booleano `true` e as versões atuais. Campo ausente, `false`, string
`"true"` ou versão diferente fazem o cadastro falhar.

Conta, perfil, consumo do convite, aceite e auditoria ficam na mesma transação.
Uma falha desfaz todas essas etapas; o convite não é perdido. O Auth pode mostrar
uma mensagem genérica de banco na tela; o motivo detalhado fica nos logs do Auth.

### Tabela `public.aceites_termos`

| Campo | Conteúdo |
| --- | --- |
| `usuario_id` | ID da conta criada pelo Auth. |
| `termos_versao` | Versão dos Termos aceita no cadastro. |
| `privacidade_versao` | Versão da Política disponibilizada. |
| `aceito_em` | Horário do registro no servidor, não do clique no navegador. |

O usuário consulta somente seu registro, após MFA. Administradores ativos com
MFA podem consultar os registros. O navegador não tem permissão para inserir,
alterar ou excluir linhas, nem mesmo quando o usuário é administrador.

Os metadados do Auth servem como transporte na criação da conta. Alterá-los
posteriormente não muda o registro em `aceites_termos`. Contas anteriores a
`008` continuam entrando normalmente e **não recebem aceite retroativo**.
Excluir uma conta exclui seu aceite; a auditoria anterior mantém sua regra de
preservar eventos sem o vínculo direto com o usuário removido.

## Conferência manual

- Abra **Criar conta**: o formulário não deve aparecer antes do aceite.
- Marque e desmarque a caixa: o botão deve habilitar e desabilitar.
- Cancele e abra novamente: a caixa deve estar desmarcada.
- Consulte a política sem login e teste navegação por teclado e `Esc`.
- Abra `/termos` e `/privacidade` diretamente e recarregue a página, inclusive na Vercel.
- Confira os links no rodapé durante MFA e nos três perfis, incluindo Auditoria.
- No cadastro preenchido, abra um link: a nova aba não deve apagar o formulário.
- Confira nomes da equipe, contato, serviços e retenção na página e no modal.
- Com um convite de teste válido, conclua cadastro, confirmação de e-mail e MFA.
- No SQL Editor, confira o registro do novo usuário, sem publicar seu ID:

```sql
SELECT usuario_id, termos_versao, privacidade_versao, aceito_em
FROM public.aceites_termos
ORDER BY aceito_em DESC
LIMIT 10;
```

Não haverá registro apenas por abrir o modal, marcar a caixa ou cancelar.
Não é necessário recriar sua conta de administrador para testar o login.

Os testes em `tests/app-cadastro.test.tsx`, `tests/auditoria-sql.test.ts` e
`tests/convites-professor-sql.test.ts` cobrem páginas, rodapé, janela, metadados,
versões antigas, permissões e desfazimento do cadastro em caso de erro. Eles não criam contas
no Supabase e não comprovam envio real de e-mail ou MFA em produção.

## Definições da demonstração

Fonte: `Documentacao/FICHA_PFC.docx` no workspace, seções 2, 3, 8, 9 e 11,
com as definições atualizadas pela equipe em 27/09/2026. O Word não foi alterado.

- Responsáveis: João Pedro Martinez Landeira, Kenny Nascimento Pires e André Kenzo Narawa Nishiguchi. Os RGMs dos integrantes não são publicados nos textos.
- Contato: `modusmartinezex@gmail.com`, para privacidade, dúvidas e incidentes.
- Finalidade: demonstração do PFC, sem operação em escolas ou avaliações oficiais.
- Serviços: Supabase, Cloudflare Turnstile e SMTP Locaweb. Hospedagem prevista na Vercel; não foi feito deploy nesta alteração.
- Conservação: até **3 meses a partir da coleta de cada registro** sob controle da equipe, com exclusão administrativa manual. Não há rotina automática de limpeza.

**Diferença em relação à ficha:** o documento original prevê logs por até um ano
e fotos por 90 dias. A definição mais recente da equipe adota três meses para os
dados da demonstração atual. Fotos, notas, respostas e monitoramento de provas
ainda não fazem parte da coleta atual. Revise a ficha antes de entregar uma
versão consolidada da documentação; não apresente funções planejadas como prontas.

## Atendimento e retenção na prática

Pedidos chegam pelo e-mail de contato. A equipe confere a identidade com o
mínimo de dados, localiza os registros e informa o atendimento ou sua justificativa.
Não deve pedir senha, código de MFA, CPF ou documentos sem necessidade.

A equipe precisa controlar o vencimento dos registros pela data de criação.
Ao atingir três meses, a revisão administrativa inclui Auth/perfis, convites,
tickets, aceites, eventos, cópias exportadas e evidências com dados pessoais.
Excluir só a conta não elimina todo o histórico: convites podem conter e-mail e
os eventos restantes não são necessariamente anônimos. Verifique as relações e
dependências antes de qualquer exclusão. Não há permissão de exclusão de logs
pela interface, nem foi executada limpeza no banco remoto nesta alteração.

Antes do deploy, confira regiões, contratos, registros técnicos e ciclos de
backup dos fornecedores. O texto não promete apagar cópias fora do controle da
equipe. Não publique segredos ou evidências identificáveis no GitHub.

## Bases legais e revisão

A redação usa o art. 7º, V para conta, convite solicitado e acesso conforme os
termos, e o art. 7º, IX para proteção e rastreabilidade. A justificativa desta
proposta é a segurança dos participantes, com dados mínimos, acesso restrito,
prazo curto e atendimento de direitos. O convite pressupõe pedido do destinatário.
A equipe deve revisar e documentar esse enquadramento e o balanceamento do
legítimo interesse com o orientador/responsável adequado. O texto não é uma
certificação jurídica nem autoriza uso institucional ou novos tratamentos.

Referências: [LGPD, arts. 7, 9, 10 e 18](https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13709.htm)
e [direitos dos titulares — ANPD](https://www.gov.br/anpd/pt-br/assuntos/titular-de-dados/direito-dos-titulares).

Depois que uma versão for usada em cadastros reais, preserve seu texto no histórico
Git. Uma mudança no documento exige nova versão em `legalDocuments.ts` e um novo
arquivo SQL atualizando as versões exigidas pelo gatilho. Não sobrescreva uma
versão já aceita. O pedido de novo aceite para usuários antigos é uma etapa futura.
