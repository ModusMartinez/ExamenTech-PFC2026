// Uma alteração publicada recebe nova versão aqui e no gatilho do banco.
export const TERMS_VERSION = '2026-09-27-v3'
export const PRIVACY_VERSION = '2026-09-27-v2'
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

export const legalDocuments: Record<LegalDocumentType, LegalDocument> = {
  termos: {
    title: 'Termos de Uso',
    version: TERMS_VERSION,
    sections: [
      {
        title: '1. Sobre o ExamenTech',
        paragraphs: [
          'O ExamenTech é o Sistema de Gerenciamento Seguro de Provas e Atividades Acadêmicas, desenvolvido como Projeto Final de Curso (PFC) de Engenharia de Software da UMC. Esta versão serve apenas para demonstração e avaliação acadêmica do projeto.',
          'A demonstração atual inclui cadastro, login, autenticação em duas etapas, convites, permissões por perfil e consulta de registros de segurança. Não deve ser usada para aplicar avaliações oficiais nem para guardar dados reais de turmas escolares.',
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
        title: '4. Privacidade e encerramento da demonstração',
        paragraphs: [
          'Dados de cadastro, convites e registros de segurança são tratados para oferecer o acesso solicitado, verificar permissões e demonstrar as funcionalidades. A Política de Privacidade detalha os dados, os serviços envolvidos e seus direitos.',
          'O prazo de conservação dos dados da demonstração sob controle da equipe é de até 3 meses a partir da coleta de cada registro. A exclusão é administrativa e manual nesta versão. Você pode solicitar o encerramento da conta antes desse prazo pelo e-mail de contato.',
          'O aceite destes termos não é uma autorização genérica para uso dos dados e não representa renúncia a direitos.',
        ],
      },
      {
        title: '5. Registro do aceite e consulta',
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
          'A demonstração não se destina à operação em escolas. Fotos, respostas de provas, notas e monitoramento de avaliações previstos na ficha do PFC ainda não são coletados nesta versão. Qualquer inclusão dessas funções ou de participantes menores de idade exige revisão prévia dos documentos e dos cuidados aplicáveis.',
        ],
      },
      {
        title: '2. Dados utilizados',
        paragraphs: [
          'Cadastro: nome, e-mail, identificador da conta, organização, perfil de acesso, situação e datas do cadastro. O RGM pode ser atribuído administrativamente; não é solicitado pelo formulário atual. Os dados são informados pelo participante ou pela equipe autorizada.',
          'Convites: e-mail do destinatário, organização, perfil de destino, emissor, datas de criação, validade e utilização. Códigos de organização, convites e tickets temporários verificam a autorização para cadastrar.',
          'Segurança: identificadores de usuário e sessão, data e hora, tipo de evento, resultado e, quando presentes, provedor, ação e códigos de erro. O aceite registra a conta, as versões dos documentos e o horário do servidor. A tabela de eventos da aplicação não guarda senhas, códigos de MFA nem tokens de autenticação ou do Turnstile.',
          'Autenticação: o Supabase Auth trata e-mail, hash da senha, fatores de autenticação e sessões. A sessão usa armazenamento local do navegador para manter o acesso. Os serviços de infraestrutura e proteção também podem tratar IP, navegador e outros sinais técnicos, mesmo que esses dados não estejam na tabela de eventos da aplicação.',
        ],
      },
      {
        title: '3. Finalidades e bases legais',
        paragraphs: [
          'Dados de conta, convites solicitados e mensagens de confirmação são necessários para disponibilizar o acesso pedido pelo participante e executar os Termos de Uso da demonstração, com base no art. 7º, V, da LGPD.',
          'Verificações contra acesso indevido, registros de segurança e rastreabilidade do aceite atendem ao legítimo interesse de proteger a demonstração e seus participantes (art. 7º, IX). O tratamento é limitado aos dados necessários, com acesso restrito e prazo de conservação definido. Não há uso para publicidade, venda de dados ou classificação automática de fraude.',
          'O aceite dos termos não substitui uma base legal nem autoriza novas finalidades. O participante pode questionar o tratamento e exercer seus direitos pelo canal de contato.',
        ],
      },
      {
        title: '4. Serviços e compartilhamento',
        paragraphs: [
          'Supabase: autenticação, banco de dados e registros técnicos necessários ao acesso. Cloudflare Turnstile: verificação contra tentativas automatizadas, com sinais técnicos do navegador e da conexão. Locaweb: envio das mensagens de confirmação por SMTP, incluindo destinatário e conteúdo necessário à entrega.',
          'A hospedagem está prevista na Vercel. Quando publicada nesse serviço, a aplicação também estará sujeita ao processamento de requisições e registros técnicos da hospedagem. Supabase, Cloudflare e Vercel podem utilizar infraestrutura fora do Brasil; não há garantia de armazenamento exclusivo no país. Informações sobre a configuração utilizada podem ser solicitadas à equipe.',
          'A equipe e o orientador podem avaliar o funcionamento durante a demonstração. Exemplos fictícios devem ser usados sempre que possível, e evidências públicas devem ocultar e-mails, identificadores e outros dados pessoais. A entrega do código não inclui contas, senhas, chaves privadas nem cópias do banco.',
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
          'Contas, perfis, convites, aceites e registros de segurança da demonstração sob controle da equipe têm prazo máximo de 3 meses, contado da coleta de cada registro. Esse prazo também orienta a retirada de cópias e evidências que contenham dados pessoais. Uma solicitação de exclusão pode ser enviada antes desse prazo.',
          'A equipe é responsável pela exclusão administrativa ao fim do prazo. O procedimento é manual nesta versão; não existe limpeza automática. Excluir a conta remove seu aceite, mas não elimina automaticamente convites e todo o histórico técnico. Esses registros também precisam ser revisados e excluídos pela equipe; retirar apenas o identificador do usuário não garante anonimização.',
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
