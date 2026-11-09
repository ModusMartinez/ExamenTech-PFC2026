// A atualização da câmera acompanha 037. Os aceites anteriores permanecem com sua versão.
const env = (import.meta as ImportMeta & { env?: Record<string, unknown> }).env
const updatedDocuments = env?.VITE_EXAM_PHOTOS_ENABLED === 'true' || env?.VITE_EXAM_MANAGEMENT_ENABLED === 'true'
export const TERMS_VERSION = updatedDocuments ? '2026-11-08-v7' : '2026-11-08-v8'
export const PRIVACY_VERSION = updatedDocuments ? '2026-11-08-v5' : '2026-11-06-v4'
export const EXAM_NOTICE_VERSION = '2026-11-08-v3'
export const EXAM_NOTICE_SUMMARY = 'Use apenas provas de teste e dados fictícios nesta demonstração. A câmera precisa estar disponível durante a prova. Você tem uma única tentativa, sem retorno automático após sair. A indisponibilidade da câmera é registrada e permite continuar respondendo. Respostas salvas e interrupções ficam no banco. Nesta versão, nenhuma foto, gravação ou áudio é enviado.'
export const LEGAL_CONTACT_EMAIL = 'modusmartinezex@gmail.com'
export const LEGAL_RESPONSIBLE =
  'Equipe responsável pelo ExamenTech: João Pedro Martinez Landeira, Kenny Nascimento Pires e André Kenzo Narawa Nishiguchi, integrantes do PFC de Engenharia de Software da Universidade de Mogi das Cruzes (UMC).'
export const LEGAL_REVIEW_NOTICE =
  'Uso exclusivo para demonstração do PFC. Esta versão não é um serviço em operação em escolas.'

export type LegalDocumentType = 'termos' | 'privacidade'

type LegalDocument = {
  title: string
  version: string
  sections: { title: string; paragraphs: string[] }[]
}

const documentsWithoutPhotos: Record<LegalDocumentType, LegalDocument> = {
  termos: {
    title: 'Termos de Uso',
    version: TERMS_VERSION,
    sections: [
      {
        title: '1. Sobre o ExamenTech',
        paragraphs: [
          'O ExamenTech é o Sistema de Gerenciamento Seguro de Provas e Atividades Acadêmicas, desenvolvido como Projeto Final de Curso (PFC) de Engenharia de Software da UMC. Esta versão serve apenas para demonstração e avaliação acadêmica do projeto.',
          'A demonstração atual inclui cadastro, autenticação em duas etapas, convites, turmas, provas de teste, tentativas, respostas e registros de segurança. Não deve ser usada para aplicar avaliações oficiais nem para guardar dados reais de turmas escolares.',
        ],
      },
      {
        title: '2. Cadastro e acesso',
        paragraphs: [
          'O cadastro exige convite individual válido, código da organização, nome e um e-mail sob seu controle. Utilize somente dados necessários à demonstração. Emita convites apenas para participantes que solicitaram acesso; não cadastre dados de terceiros sem autorização.',
          'O convite define uma conta de aluno ou professor, sem aprovação manual adicional. Somente administradores emitem convites para professores. Professores convidam alunos da própria organização; administradores também podem convidar alunos.',
          'O acesso exige confirmação de e-mail e autenticação em duas etapas. O cadastro por convite não cria administradores. Esse perfil é atribuído por procedimento administrativo da equipe.',
        ],
      },
      {
        title: '3. Responsabilidades do participante',
        paragraphs: [
          'Mantenha sua senha, seus convites e os códigos do Authenticator em sigilo. Não use contas de outras pessoas, não tente acessar dados sem permissão e não envie dados de turmas escolares reais para demonstrar o sistema.',
          'Contas inativas não acessam o painel. Falhas, dúvidas e suspeitas de acesso indevido devem ser comunicadas pelo e-mail de contato ao final deste documento. O sistema está em desenvolvimento e depende da disponibilidade dos serviços utilizados.',
        ],
      },
      {
        title: '4. Provas de teste e câmera',
        paragraphs: [
          'O aluno com matrícula ativa pode iniciar uma única tentativa por prova publicada no período definido pelo professor. A câmera deve mostrar uma imagem antes de iniciar e permanecer disponível durante a tentativa. Esta versão não grava fotos, vídeo ou áudio, nem compara rostos. A câmera aberta, sozinha, não comprova a identidade de quem responde.',
          'Se o navegador informar perda da câmera durante a prova, a falha é registrada e as questões continuam disponíveis, com salvamento e envio das respostas. O aluno pode tentar reconectar a câmera na mesma página. Sair pelo botão Encerrar tentativa também impede o retorno. Fechar ou atualizar a aba não oferece novo acesso à prova. Uma imagem preta com a câmera tecnicamente ativa pode exigir que o aluno informe o problema; a detecção automática não cobre todos os dispositivos.',
          'Antes de iniciar, o aluno recebe um aviso específico e confirma que tomou ciência da câmera, das respostas armazenadas, da tentativa única sem retorno e da Política de Privacidade. O sistema registra a versão do aviso e o horário. Respostas ainda não salvas podem se perder se a conexão falhar ou a página for fechada antes da confirmação do salvamento.',
        ],
      },
      {
        title: '5. Privacidade e encerramento da demonstração',
        paragraphs: [
          'Dados de cadastro, convites, turmas, tentativas, respostas e registros de segurança são tratados para oferecer o acesso solicitado, verificar permissões e demonstrar as funcionalidades. A Política de Privacidade detalha os dados, os serviços envolvidos e seus direitos.',
          'O prazo de conservação dos dados da demonstração sob controle da equipe é de até 3 meses a partir da coleta de cada registro. A exclusão é administrativa e manual nesta versão. Você pode solicitar o encerramento da conta antes desse prazo pelo e-mail de contato.',
          'O aceite destes termos não é uma autorização genérica para uso dos dados e não representa renúncia a direitos.',
        ],
      },
      {
        title: '6. Registro do aceite e consulta',
        paragraphs: [
          'Ao marcar a caixa e concluir o cadastro, você aceita esta versão dos Termos de Uso. O banco registra sua conta, a versão aceita, a versão da Política de Privacidade apresentada e o horário do registro no servidor.',
          'Fechar ou cancelar a janela antes de prosseguir não abre o cadastro nem registra aceite. Os documentos podem ser consultados pelos links no rodapé de todas as telas, sem login e sem novo aceite. Uma revisão do texto recebe uma nova versão; aceites anteriores não são alterados.',
        ],
      },
    ],
  },
  privacidade: {
    title: 'Política de Privacidade',
    version: PRIVACY_VERSION,
    sections: [
      {
        title: '1. Abrangência e responsáveis',
        paragraphs: [
          'Esta política se aplica à demonstração acadêmica do ExamenTech. Os integrantes identificados ao final são responsáveis pelas decisões sobre os dados utilizados nesta etapa. A menção à UMC identifica o vínculo acadêmico, não atribui à universidade a operação do sistema.',
          'A demonstração não se destina à operação em escolas. Respostas de provas de teste e o histórico das tentativas são armazenados. Fotos, vídeo, áudio, notas e identificação por imagem ainda não são coletados ou calculados nesta versão. Qualquer inclusão dessas funções ou de participantes menores de idade exige revisão prévia dos documentos e dos cuidados aplicáveis.',
        ],
      },
      {
        title: '2. Dados utilizados',
        paragraphs: [
          'Cadastro: nome, e-mail, identificador da conta, organização, perfil de acesso, situação e datas do cadastro. O RGM pode ser atribuído administrativamente; não é solicitado pelo formulário atual. Os dados são informados pelo participante ou pela equipe autorizada.',
          'Convites: e-mail do destinatário, organização, perfil de destino, emissor, datas de criação, validade e utilização. Códigos de organização, convites e tickets temporários verificam a autorização para cadastrar.',
          'Segurança: identificadores de usuário e sessão, data e hora, tipo de evento, resultado e, quando presentes, provedor, ação e códigos de erro. O aceite registra a conta, as versões dos documentos e o horário do servidor. A tabela de eventos da aplicação não guarda senhas, códigos de MFA nem tokens de autenticação ou do Turnstile.',
          'Autenticação: o Supabase Auth trata e-mail, hash da senha, fatores de autenticação e sessões. A sessão usa armazenamento local do navegador para manter o acesso. Os serviços de infraestrutura e proteção também podem tratar IP, navegador e outros sinais técnicos, mesmo que esses dados não estejam na tabela de eventos da aplicação.',
          'Provas de teste: turma e matrícula, prova escolhida, questões, alternativas selecionadas ou texto digitado pelo aluno, horários da tentativa, tempo restante, situação, falha da câmera quando detectada, versão e horário do aviso apresentado antes da tentativa. Os eventos de publicação, início, falha, interrupção, salvamento e envio são registrados na auditoria. A prévia da câmera é processada localmente no navegador; o aplicativo não envia nem armazena imagens ou áudio nesta etapa.',
        ],
      },
      {
        title: '3. Finalidades e bases legais',
        paragraphs: [
          'Dados de conta, convites solicitados e mensagens de confirmação são necessários para disponibilizar o acesso pedido pelo participante e executar os Termos de Uso da demonstração, com base no art. 7º, V, da LGPD.',
          'Verificações contra acesso indevido, registros de segurança e rastreabilidade do aceite atendem ao legítimo interesse de proteger a demonstração e seus participantes (art. 7º, IX). O tratamento é limitado aos dados necessários, com acesso restrito e prazo de conservação definido. Não há uso para publicidade, venda de dados ou classificação automática de fraude.',
          'O aceite dos termos não substitui uma base legal nem autoriza novas finalidades. O participante pode questionar o tratamento e exercer seus direitos pelo canal de contato.',
          'As respostas e o estado da tentativa são usados apenas para demonstrar a realização de provas de teste solicitadas pelo participante, conforme os Termos de Uso (art. 7º, V). O histórico de falhas e interrupções serve para proteger a integridade da demonstração e rastrear ações (art. 7º, IX). O aviso antes da prova registra ciência do funcionamento; não é tratado como autorização genérica para dados biométricos.',
        ],
      },
      {
        title: '4. Serviços e compartilhamento',
        paragraphs: [
          'Supabase: autenticação, banco de dados e registros técnicos necessários ao acesso. Cloudflare Turnstile: verificação contra tentativas automatizadas, com sinais técnicos do navegador e da conexão. Locaweb: envio das mensagens de confirmação por SMTP, incluindo destinatário e conteúdo necessário à entrega.',
          'A hospedagem está prevista na Vercel. Quando publicada nesse serviço, a aplicação também estará sujeita ao processamento de requisições e registros técnicos da hospedagem. Supabase, Cloudflare e Vercel podem utilizar infraestrutura fora do Brasil; não há garantia de armazenamento exclusivo no país. Informações sobre a configuração utilizada podem ser solicitadas à equipe.',
          'A equipe e o orientador podem avaliar o funcionamento durante a demonstração. Esta versão não oferece aos professores e administradores uma tela para consultar respostas nem para liberar tentativas interrompidas. Exemplos fictícios devem ser usados sempre que possível, e evidências públicas devem ocultar e-mails, identificadores e outros dados pessoais. A entrega do código não inclui contas, senhas, chaves privadas nem cópias do banco.',
        ],
      },
      {
        title: '5. Acesso e proteção',
        paragraphs: [
          'As permissões são verificadas conforme o perfil, a situação da conta e a autenticação em duas etapas. A consulta de auditoria na aplicação é restrita a administradores. A equipe responsável administra os serviços somente para manutenção, testes, atendimento e proteção dos dados.',
          'O Supabase Auth armazena hashes de senha, não senhas em texto na tabela de perfis. As APIs do Supabase usam HTTPS e a publicação deve usar HTTPS. Sair da conta encerra a sessão local. Não envie senhas, códigos do Authenticator, convites ou chaves do projeto em solicitações de atendimento.',
        ],
      },
      {
        title: '6. Conservação e exclusão',
        paragraphs: [
          'Contas, perfis, convites, aceites, turmas, tentativas, respostas e registros de segurança da demonstração sob controle da equipe têm prazo máximo de 3 meses, contado da coleta de cada registro. Esse prazo também orienta a retirada de cópias e evidências que contenham dados pessoais. Uma solicitação de exclusão pode ser enviada antes desse prazo.',
          'A equipe é responsável pela exclusão administrativa ao fim do prazo. O procedimento é manual nesta versão; não existe limpeza automática. Excluir a conta ou apenas o perfil pode ser impedido por vínculos com tentativas e respostas; a equipe deve tratar esses registros e o histórico técnico no atendimento. Retirar apenas o identificador do usuário não garante anonimização.',
          'Cópias de segurança e registros próprios dos fornecedores seguem os ciclos dos serviços contratados. A equipe deve considerar esses ciclos ao atender uma solicitação e informar eventuais limites ou obrigações de conservação aplicáveis.',
        ],
      },
      {
        title: '7. Direitos e atendimento',
        paragraphs: [
          'Você pode solicitar confirmação do tratamento, acesso aos dados, correção, informações sobre compartilhamento e, quando aplicável, exclusão, anonimização, bloqueio ou portabilidade. Também pode questionar tratamentos irregulares e revogar um consentimento específico, caso algum seja solicitado no futuro.',
          'Envie o pedido para ' + LEGAL_CONTACT_EMAIL + ', preferencialmente pelo e-mail da conta, informando o que deseja consultar ou corrigir. O atendimento é gratuito. A equipe verifica a identidade com os dados mínimos necessários, analisa a solicitação e responde conforme a LGPD, explicando eventuais limitações. Não são solicitadas senhas ou códigos de MFA.',
          'Se considerar que seus direitos não foram atendidos, você também pode procurar a Autoridade Nacional de Proteção de Dados (ANPD).',
        ],
      },
    ],
  },
}

function updatedLegalDocuments(): Record<LegalDocumentType, LegalDocument> {
  const documents = structuredClone(documentsWithoutPhotos)
  function replace(type: LegalDocumentType, title: string, paragraphs: string[]) {
    const section = documents[type].sections.find(item => item.title === title)
    if (section) section.paragraphs = paragraphs
  }
  replace('termos', '4. Provas de teste e câmera', [
    'O aluno com matrícula ativa pode iniciar uma tentativa por prova publicada dentro da janela definida pelo professor. A câmera deve apresentar imagem antes do início e permanecer disponível. Sair da aba, da janela ou da página interrompe a tentativa, sem retorno automático. Durante a resolução das questões, a perda do sinal da câmera é registrada sem interromper a prova: as questões, o salvamento e o envio continuam disponíveis. A câmera pode ser reconectada na mesma página. Quando a coleta de fotos está habilitada, a foto inicial precisa ser confirmada antes de liberar as questões. Se essa captura falhar, é necessário recuperar a câmera e preparar a foto novamente; o prazo continua correndo. Uma imagem preta com a câmera tecnicamente ativa pode exigir que o participante informe o problema; nem todo dispositivo permite detectar a falha automaticamente.',
    'O professor responsável e o ADM da mesma organização podem analisar uma interrupção e autorizar excepcionalmente a retomada, com justificativa e tempo definido. A autorização, quem a concedeu e seu uso ficam registrados. As respostas salvas e a ordem das questões são mantidas. Provas já enviadas ou finalizadas pelo prazo não são reabertas por esse procedimento.',
    'Quando o aviso antes da prova informar que a coleta de fotografias está habilitada, será solicitada concordância específica para uma foto inicial e três fotos em momentos aleatórios da tentativa. Não há gravação de vídeo ou áudio nem comparação facial automática. O professor responsável e o ADM da organização podem analisar as imagens manualmente. As fotos não comprovam identidade ou fraude sozinhas. Uma retomada autorizada tem novo aviso e novo ciclo de capturas; um envio antecipado encerra as capturas futuras.',
    'Esta é uma demonstração voluntária, destinada a participantes adultos, sem aplicação de avaliações escolares oficiais. Sem concordar com as fotos, o participante pode cancelar a preparação e continuar usando o painel. A permissão da câmera no navegador não substitui o consentimento específico. Respostas não salvas e capturas cujo envio não foi confirmado podem se perder em uma falha; falha de rede no envio não é classificada como falha da câmera.',
  ])
  replace('termos', '5. Privacidade e encerramento da demonstração', [
    'A Política de Privacidade identifica os dados de cadastro, convites, turmas, provas, autorizações, respostas, fotografias quando habilitadas e registros de segurança, suas finalidades e os serviços envolvidos. Os documentos continuam acessíveis pelo rodapé; durante a prova, abrem na própria página.',
    'As fotos têm conservação máxima de 90 dias por captura, com exclusão automática dos arquivos privados. A programação de captura no servidor fixa um limite conservador, e atrasos no envio não renovam o prazo. A limpeza diária pode apagar o arquivo antes de completar 90 dias. Os demais registros da demonstração seguem o prazo de até 3 meses e exclusão administrativa, conforme a Política.',
    'O participante pode pedir acesso, exclusão e revogação do consentimento pelo contato indicado. O aceite dos termos não autoriza novas finalidades nem representa renúncia a direitos.',
  ])
  replace('privacidade', '1. Abrangência e responsáveis', [
    'Esta política se aplica à demonstração acadêmica voluntária do ExamenTech, destinada a participantes adultos. Os integrantes identificados ao final decidem sobre os dados nesta etapa. A menção à UMC identifica o vínculo acadêmico; não atribui à universidade a operação do sistema.',
    'A demonstração não se destina a avaliações oficiais em escolas nem à participação de menores de idade. Guarda respostas de teste e histórico de tentativas. A coleta de fotos, quando habilitada, é informada antes da prova e depende de concordância específica; sem esse aviso e concordância não ocorre envio. Não há gravação de vídeo ou áudio, notas automáticas ou reconhecimento facial.',
  ])
  const dataSection = documents.privacidade.sections.find(item => item.title === '2. Dados utilizados')
  if (dataSection) dataSection.paragraphs = dataSection.paragraphs.slice(0, 4).concat([
    'Provas de teste: turma, matrícula, avaliação, questões, alternativas ou texto respondido, horários, prazo e situação da tentativa. Interrupções, falhas detectadas da câmera, autorizações de retomada com justificativa, responsável, minutos concedidos e uso da liberação integram o histórico. O aceite do aviso específico registra conta, tentativa, ciclo, versão e horário do servidor.',
    'Fotografias, quando habilitadas: uma imagem JPEG inicial e três em horários aleatórios de cada ciclo autorizado, no máximo 960 × 720 pixels e 1 MiB por foto. São associados identificador da tentativa e da captura, momento programado, recebimento, validade, dimensões e situação do envio. A foto pode mostrar o rosto e o ambiente visível pela câmera. Não é coletado áudio e não é feito vídeo contínuo, extração de características faciais ou comparação automatizada de identidade. Evite expor documentos e terceiros no enquadramento.',
  ])
  const purposes = documents.privacidade.sections.find(item => item.title === '3. Finalidades e bases legais')
  purposes?.paragraphs.push('A captura e a análise manual das fotografias nesta demonstração voluntária dependem de consentimento específico, destacado antes da tentativa (art. 7º, I, e, quando aplicável ao tratamento de dados sensíveis, art. 11, I, da LGPD). A finalidade é demonstrar a conferência manual das evidências pelo responsável da prova; não há decisão automática de fraude. O participante pode cancelar antes de iniciar e solicitar revogação e exclusão pelo contato indicado, sem penalidade escolar. A permissão técnica da câmera não equivale a consentimento para armazenar fotografias.')
  replace('privacidade', '4. Serviços e compartilhamento', [
    'Supabase: autenticação, banco de dados e Storage privado das fotos, quando habilitadas. Cloudflare Turnstile: proteção contra tentativas automatizadas, com sinais técnicos do navegador e da conexão. Locaweb: envio de mensagens por SMTP. Vercel, quando utilizada na publicação, hospeda a aplicação, processa requisições e executa o agendamento de limpeza.',
    'Supabase, Cloudflare e Vercel podem utilizar infraestrutura fora do Brasil. Não há garantia de armazenamento exclusivo no país. A equipe deve informar a configuração utilizada e considerar as regras aplicáveis à transferência internacional antes de qualquer uso fora da demonstração voluntária.',
    'As fotos são consultadas apenas pelo professor responsável pela avaliação e pelo ADM da mesma organização, com conta ativa e MFA. A consulta é registrada. A equipe administra os serviços para manutenção, testes e atendimento. Não publique imagens reais, tokens ou cópias do banco no repositório, na monografia ou em capturas públicas. A equipe e o orientador devem usar exemplos fictícios ou evidências sem dados pessoais para apresentar o projeto.',
  ])
  replace('privacidade', '5. Acesso e proteção', [
    'As permissões das fotos e da reativação são verificadas no servidor pelo perfil, organização, responsabilidade pela avaliação e autenticação em duas etapas. Os arquivos ficam em bucket privado, sem acesso público ou leitura direta pelo navegador. A imagem só é entregue depois de uma autorização válida; as respostas da API não devem ser armazenadas em cache. Não há envio de fotos para ferramenta externa de reconhecimento facial.',
    'A aplicação processa as capturas temporariamente na memória do navegador até confirmar o envio. Não guarda fotos em localStorage ou IndexedDB. Ao sair ou encerrar, libera as capturas pendentes. O Supabase Auth gerencia os hashes de senha. Os serviços devem ser acessados por HTTPS na publicação. Não envie senhas, códigos de MFA ou chaves em pedidos de atendimento.',
  ])
  replace('privacidade', '6. Conservação e exclusão', [
    'As fotos têm prazo máximo de 90 dias por captura. O servidor usa o horário programado, anterior à captura, como limite conservador de validade; atrasar ou repetir o envio não renova esse prazo. A limpeza automática diária remove o arquivo pelo serviço de armazenamento e registra a exclusão. Para respeitar o limite entre execuções, pode eliminar imagens antes de completar 90 dias. O acesso também é negado quando a validade termina.',
    'A equipe precisa manter o agendamento e acompanhar falhas de exclusão. Em falha do serviço, a limpeza é repetida; não se considera o arquivo apagado apenas por estar indisponível na tela. Um pedido de revogação ou exclusão pode ser enviado antes do prazo. A equipe trata o arquivo e seus vínculos, preservando somente o que tiver justificativa legal de conservação.',
    'Os demais dados de conta, convites, aceites, turmas, tentativas, respostas e segurança sob controle da equipe seguem prazo máximo de 3 meses desde cada coleta e exclusão administrativa. Os registros de auditoria não contêm o conteúdo das imagens. Metadados identificáveis e cópias fora do sistema também devem ser tratados no encerramento e no atendimento; remover apenas o identificador não garante anonimização.',
    'Backups e registros próprios dos fornecedores seguem os ciclos dos serviços contratados. A equipe deve considerar esses ciclos no atendimento e explicar limites ou obrigações de conservação. O prazo de 90 dias das fotografias é uma decisão do projeto, não um prazo geral imposto pela LGPD.',
  ])
  const rights = documents.privacidade.sections.find(item => item.title === '7. Direitos e atendimento')
  if (rights) rights.paragraphs[0] = 'Você pode solicitar confirmação do tratamento, acesso, correção, informações sobre compartilhamento e, quando aplicável, exclusão, anonimização, bloqueio ou portabilidade. Pode questionar tratamentos irregulares e revogar o consentimento para as fotografias pelo contato abaixo. A revogação interrompe futuros tratamentos baseados nesse consentimento, e a equipe analisa o pedido de exclusão dos dados já coletados.'
  return documents
}

export const legalDocuments = updatedDocuments ? updatedLegalDocuments() : documentsWithoutPhotos
