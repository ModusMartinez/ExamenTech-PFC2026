# Preparação para a branch entrega0911

Destino definido pela equipe: **entrega0911**, já criada no GitHub. O código de referência utilizado nesta integração é `369ecb523b3b5ee88e5e8d8a4f36b57aa024d6e2`. Confira se o remoto avançou antes de aplicar as mudanças; o pacote não substitui uma revisão dos commits dos colegas. O nome `0911` foi a proposta inicial, substituída por `entrega0911`.

Nenhuma branch, commit ou push é criado pelos arquivos desta entrega. A publicação do código também não aplica SQL, publica Edge Functions ou configura variáveis no Supabase.

## Escopo da integração

- Correções de recuperação de senha e preservação do fluxo de MFA.
- Integração do contrato canônico das provas, salvamento de respostas e encerramento por saída, prazo ou perda persistente da câmera.
- Lista **Minhas provas** preservada em cartões; simulação no mesmo lugar, sem aba separada de pré-prova.
- Uma foto inicial e até três aleatórias por ciclo, consentimento específico, envio idempotente e aviso discreto ao aluno.
- Armazenamento privado, consulta restrita ao professor responsável ou ADM da organização e prazo máximo de 90 dias por foto.
- Liberação excepcional de tentativa interrompida, com justificativa, tempo autorizado e histórico. Respostas e ordem das questões permanecem.
- Limpeza automática preparada para Supabase Edge Functions + cron + Vault, com alternativa de endpoint para outro agendador.
- Modelos de variáveis sem chaves, documentos de integração atualizados e protótipo anterior separado em `src/dev/legacy`.

## Organização dos arquivos

| Pasta | Conteúdo |
| --- | --- |
| `src/components`, `src/hooks`, `src/services` | Interface e lógica da aplicação atual. |
| `src/content` | Textos e versões dos documentos acessíveis no sistema. |
| `api` | Rotas da aplicação, com validação e autorização por sessão. |
| `scripts` | API local, execução dos serviços e preparação explícita de armazenamento/agendamento. |
| `database` | Migrações 001–032; aplicação administrativa em cada ambiente. |
| `supabase/functions` | Função de exclusão de fotos elegíveis. |
| `supabase/config.toml` | Configuração dessa função; autenticação pelo token exclusivo no próprio código. |
| `dev`, `src/dev` | Simulações isoladas e protótipo anterior, sem ligação com a navegação atual. |
| `tests` | Testes de banco local, API, serviços e telas. |
| `docs` | Configuração, diagnósticos, roteiros de validação e histórico. |

## O que não entra no commit

- `.env.local` e outros arquivos de ambiente, exceto `.env.example`.
- `docs/token-limpeza-fotos.local` e `docs/agendar-limpeza-fotos.sql.local`.
- Tokens, chaves privadas, fotos dos participantes, capturas com credenciais e cópias do banco.
- `node_modules`, `dist`, caches de ferramentas, relatórios e logs.

O modelo `docs/agendar-limpeza-fotos.template.sql` entra no código; o SQL preenchido com o token não entra. O `.gitignore` não remove automaticamente um segredo que já estiver em um commit antigo, portanto a lista preparada para commit deve ser revisada.

## Dependências de banco e implantação

Antes de habilitar gerenciamento e fotos em outro ambiente, confira 025–028 e aplique os novos objetos que faltarem, conforme os diagnósticos. Em bases conciliadas não reaplique a ponte do protótipo nem as migrações existentes.

1. 030: reativação e respostas recuperadas na retomada.
2. 031: fotos, consentimentos, acesso restrito e funções de limpeza; inicia com a coleta desligada.
3. 032: novas versões de Termos e Política; deve acompanhar a interface configurada com gerenciamento habilitado.
4. Bucket privado `examentech-evidencias`, `image/jpeg`, 1 MiB.
5. Função de limpeza e agendamento autenticado ativos; conferir resposta HTTP e testar remoção de um arquivo fictício vencido.
6. Ativação consciente das opções do banco, da interface e da API.

Veja [ativação](ativar-fotos-e-reativacao.md) e [limpeza pelo Supabase](limpeza-fotos-supabase.md). O cron deve existir uma única vez para a mesma base, mesmo que o site depois seja publicado na Vercel.

## Validação antes de publicar

Na pasta do projeto:

```powershell
npm.cmd ci
npm.cmd run lint
npm.cmd test
npm.cmd run build
```

Os testes usam serviços e sessões simulados. O usuário já confirmou fotos na prova e consulta pelo professor na base de testes. Reativação manual, ADM, isolamento entre organizações, revogação e exclusão física continuam no roteiro de validação manual. Os resultados automatizados da preparação ficam no relatório que acompanha o pacote.

## Criar a branch e revisar as mudanças

Use a cópia Git que acompanha a branch definida. Se ainda não houver uma cópia, em um diretório escolhido:

```powershell
git -c core.autocrlf=false clone --branch entrega0911 https://github.com/ModusMartinez/ExamenTech-PFC2026.git ExamenTech-entrega0911
Set-Location ExamenTech-entrega0911
git branch --show-current
```

Confira que a branch exibida é `entrega0911`. Se você já aplicou o pacote, não o aplique novamente. O pacote de revisão contém um patch relativo à base identificada acima. Mantenha-o fora da pasta do clone e use seu caminho completo:

```powershell
git apply --check 'CAMINHO-COMPLETO/alteracoes-0911.patch'
```

Só se esse comando concluir sem erro, aplique:

```powershell
git apply 'CAMINHO-COMPLETO/alteracoes-0911.patch'
git status --short
git diff --stat
```

Se houver conflito ou uma migração 028–032 de mesmo número mas conteúdo diferente, pare para comparar com os commits dos colegas. Não copie a pasta inteira por cima para contornar a divergência. O pacote também inclui uma cópia integral limpa para consulta; ela não conhece mudanças posteriores da `desenv`.

Depois de conferir o conteúdo e executar os testes no clone:

```powershell
git add .
git diff --cached --stat
git diff --cached --name-only
```

Confira que não aparecem arquivos `.local`, segredos ou fotos. Ao decidir publicar a versão revisada:

```powershell
git commit -m "feat: integra monitoramento por camera, fotos privadas e reativacao"
git push origin entrega0911
```

Esses comandos são instruções para o responsável executar; não foram executados pela preparação local. Um pull request pode usar **base `desenv`** e **compare `entrega0911`**, para revisão antes da integração.

## Fora desta entrega

Não inclui reconhecimento facial, vigilância contínua, correção de respostas ou notas. A câmera e os eventos do navegador têm limitações de detecção; o sistema não garante identidade nem fraude por imagem. A monografia, ficha e BPMN de setembro ainda precisam de revisão da equipe para refletir o escopo atual.
