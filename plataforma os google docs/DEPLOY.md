# Publicar um piloto na Render

Esta implantação usa o SQLite atual em **uma única instância** com disco persistente. Não escolha hospedagem gratuita com sistema de arquivos temporário para este projeto: banco e anexos poderiam sumir após reinicializações ou novas publicações. Discos persistentes da Render exigem serviço pago.

## 1. Preparar o repositório

Crie um repositório privado no GitHub e envie o conteúdo desta pasta (`os-backend`) para a raiz do repositório. O arquivo `.gitignore` exclui o banco local, anexos, backups e segredos. Confirme que a pasta `data/` não foi enviada. Não execute `npm run seed:demo` em produção.

## 2. Criar o serviço

Na Render, escolha **New → Web Service**, conecte o repositório e use:

- Runtime: Node
- Build command: `npm install`
- Start command: `npm start`
- Plan: uma instância paga que permita disco persistente
- Disco persistente: mount path `/opt/render/project/src/data`

Envie o conteúdo de `os-backend` como raiz do repositório. Se mantiver uma pasta acima e configurar Root Directory, ajuste o mount path de acordo com o diretório de execução.

## 3. Configurar variáveis do serviço

Adicione-as em **Environment** na Render. Use valores próprios, guarde a senha do administrador em local seguro e nunca a inclua no GitHub.

| Chave | Valor |
|---|---|
| `NODE_VERSION` | `24.21.0` |
| `ADMIN_EMAIL` | e-mail de acesso do administrador inicial |
| `ADMIN_SENHA` | senha forte e exclusiva (mínimo 10 caracteres, letras e números) |
| `COOKIE_SECURE` | `1` |
| `DB_PATH` | `/opt/render/project/src/data/os.sqlite` |
| `STORAGE_DIR` | `/opt/render/project/src/data/anexos` |

Não configure `PORT`: a Render fornece essa variável automaticamente.

Para habilitar os Google Docs, siga [GOOGLE-DOCS.md](GOOGLE-DOCS.md) e cadastre as variáveis `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` e `GOOGLE_TOKEN_ENCRYPTION_KEY` também no Environment da Render. Use como redirect URI `https://SUA-URL.onrender.com/api/admin/google/callback`. O banco e o segredo de cifragem precisam permanecer no disco/ambiente entre reinicializações.

## 4. Publicar e conferir

Clique em **Deploy**. Quando o serviço ficar ativo, abra a URL `onrender.com` fornecida pela Render. Entre com o e-mail e a senha que configurou em `ADMIN_EMAIL` e `ADMIN_SENHA`. Cadastre um cliente e equipamento de teste e percorra o fluxo de abertura, atualização e fechamento.

## Antes de convidar clientes

- A recuperação de senha e notificações por e-mail ainda usam um mailer simulado no console. Configure e valide um provedor de e-mail no código antes de depender desses avisos.
- Faça um teste de restauração do banco e dos anexos. A Render informa que discos persistentes recebem snapshots automáticos diários, mantidos por sete dias; isso não substitui um plano de backup/restauração validado.
- O disco pertence a uma única instância. Para mais instâncias/escala, planeje migrar SQLite para PostgreSQL e anexos para armazenamento de objetos.
- Faça primeiro o piloto com dados fictícios e poucos usuários internos. Só use dados reais depois de verificar acesso por perfil, notificações, recuperação de senha, backup e restauração.
