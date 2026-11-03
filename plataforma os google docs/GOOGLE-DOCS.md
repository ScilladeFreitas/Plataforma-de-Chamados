# Conectar a plataforma ao Google Docs

Depois que o administrador autorizar uma conta Google, a plataforma cria uma pasta **Ordens de Serviço** no Drive dessa conta. Cada OS gera um Google Doc nessa pasta. O documento recebe os dados de abertura e depois as atualizações, serviços, peças, mudanças de status e o relatório de encerramento. O link fica visível somente para funcionários e administradores dentro da plataforma.

Inicialmente, os arquivos pertencem à conta Google conectada. Para que outros funcionários consigam abri-los, compartilhe a pasta `Ordens de Serviço` com as contas da equipe no próprio Drive (ou use uma conta corporativa que já tenha o compartilhamento apropriado). A plataforma não compartilha documentos automaticamente com clientes.

O SQLite continua sendo o registro principal. Se o Google estiver fora do ar ao abrir a OS, o chamado continua salvo e a equipe pode usar **Gerar Google Doc** nos detalhes para tentar novamente. O token de atualização OAuth é guardado cifrado no banco, usando a chave do ambiente `GOOGLE_TOKEN_ENCRYPTION_KEY`.

## Configuração no Google Cloud

1. Crie um projeto no [Google Cloud Console](https://console.cloud.google.com/).
2. Ative **Google Drive API** e **Google Docs API** nesse projeto.
3. Configure a tela de consentimento OAuth. Para testar, inclua a conta Google que será conectada como usuária de teste.
4. Crie uma credencial OAuth do tipo **Web application**.
5. Cadastre como URI de redirecionamento autorizada exatamente:
   - local: `http://localhost:3000/api/admin/google/callback`
   - hospedado: `https://SEU-DOMINIO/api/admin/google/callback`
6. Guarde o Client ID e o Client Secret. Não os coloque em arquivos enviados ao GitHub.

A integração solicita `drive.file`, que limita o acesso a arquivos criados pelo próprio aplicativo, além do escopo de e-mail básico. O Google pode mostrar a tela de aplicativo não verificado em testes. Com a tela OAuth no modo Testing, autorizações que pedem acesso ao Drive expiram após sete dias; nesse período será preciso conectar a conta novamente. Para uso contínuo, configure o status e a verificação OAuth adequados no Google Cloud.

## Variáveis do servidor

Configure os valores no arquivo `.env` local (não commitado) ou no painel de variáveis do provedor:

- `GOOGLE_CLIENT_ID`: Client ID da credencial Web
- `GOOGLE_CLIENT_SECRET`: Client Secret da credencial Web
- `GOOGLE_REDIRECT_URI`: callback exato acima, correspondente ao endereço usado
- `GOOGLE_TOKEN_ENCRYPTION_KEY`: segredo aleatório longo, exclusivo e persistente. Não troque depois de conectar, ou a plataforma não conseguirá decifrar o token já guardado.

Após configurar, entre na plataforma como administrador, clique em **Conectar Google Drive** e aceite a autorização na conta da empresa. A primeira geração de Doc criará automaticamente a pasta `Ordens de Serviço`.

Não execute os dados de demonstração no ambiente real. Teste inicialmente com cliente e equipamento fictícios e confirme que o Doc e a pasta têm as permissões esperadas.
