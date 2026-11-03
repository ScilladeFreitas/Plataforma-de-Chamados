# Plataforma de Chamados e OS — aplicação web

Aplicação web responsiva em português, com API REST e banco SQLite persistente, **sem dependências externas** (somente módulos nativos do Node). A interface de clientes e equipe é servida pela própria aplicação.

## Requisitos e execução
- Node.js **22.5 ou superior** (usa `node:sqlite`).
```bash
export ADMIN_EMAIL=admin@suaempresa.com ADMIN_SENHA='UmaSenhaForte123'   # cria o 1º administrador
npm start                    # http://localhost:3000  (PORT, DB_PATH, STORAGE_DIR configuráveis)
npm test                     # valida os fluxos principais
npm run seed:demo            # OPCIONAL: dados de demonstração (marcados [DEMO], demo=1)
npm run backup               # cópia consistente do banco + anexos em ./backups
```
Produção: defina `COOKIE_SECURE=1` e publique atrás de HTTPS (proxy reverso).
Restauração: pare a API, substitua `data/os.sqlite` (e a pasta `data/anexos`) pelos arquivos do backup e inicie novamente.

Logins de demonstração (senha `Demo@12345`): `admin@demo.local`, `tecnico@demo.local`, `cliente1@demo.local`, `cliente2@demo.local`. **Não use em produção.**

## Interface web
- Acesse `http://localhost:3000` após iniciar a aplicação.
- Clientes podem criar uma conta, cadastrar equipamento, abrir chamados e consultar seus atendimentos.
- Funcionários e administradores podem pesquisar chamados, registrar atualizações públicas ou notas internas, avançar o status e concluir ordens com relatório final.
- A tela de equipamento mostra os atendimentos anteriores. A ordem pode ser aberta em versão de impressão/PDF.
- Administradores podem conectar um Google Drive; a plataforma cria um Doc privado por OS e acrescenta nele atualizações e o relatório final. A integração exige credenciais OAuth no servidor: consulte [GOOGLE-DOCS.md](GOOGLE-DOCS.md).
- O controle de permissões é aplicado também pela API; ocultar ações na tela não é a única proteção.

## Permissões
| Capacidade | Cliente | Funcionário (padrão) | Administrador |
|---|---|---|---|
| Cadastrar-se, entrar, recuperar senha | ✔ | — | — |
| Abrir chamado / cadastrar equipamento | só os próprios (`os.criar` p/ terceiros) | `os.criar`, `equip.gerir` | ✔ |
| Ver chamados e equipamentos | só os próprios ou autorizados | `os.ver_todas` | ✔ |
| Ver atualizações | só as "visíveis ao cliente" | todas, inclusive notas internas | ✔ |
| Enviar anexos | nos próprios chamados | `os.editar` | ✔ |
| Editar chamado, status, prioridade, responsável, serviços, peças, atualizações e notas | ✘ | `os.editar` | ✔ |
| Fechar / cancelar (com confirmação) | ✘ | `os.fechar` | ✔ |
| Clientes | ✘ | `cliente.gerir` | ✔ |
| Relatórios | ✘ | `relatorio.ver` | ✔ |
| Usuários, config., permissões, auditoria | ✘ | só se concedido (`admin.*`, `auditoria.ver`) | ✔ |

O administrador cria funções de equipe e define as permissões de cada uma (`POST /api/admin/perfis`, `PUT /api/admin/perfis/:id/permissoes`).

## Segurança implementada
Senhas com scrypt + sal; sessão em cookie `HttpOnly`/`SameSite=Lax` (8 h) com token guardado só como hash; limite de 5 tentativas de login/15 min; recuperação de senha com token de uso único (30 min) que encerra as sessões; corpo exigido como JSON (barra envios de formulários externos); consultas parametrizadas; anexos validados pelo conteúdo real (PNG/JPG/PDF, até 5 MB), gravados fora de área pública com nome aleatório e entregues só por rota autenticada. Cliente que pede registro alheio recebe **404**. Notas internas são filtradas na própria consulta e nunca vão para API de cliente, busca, e-mail ou documento da OS.

## Endpoints principais
`POST /api/auth/{registrar,login,logout,esqueci-senha,redefinir-senha}` · `GET /api/me` · `GET /api/config`
`GET|POST /api/os` (filtros: `protocolo,q,equip,status_id,responsavel_id,cliente_id,de,ate`) · `GET|PUT /api/os/:id` · `POST /api/os/:id/{status,atualizacoes,servicos,pecas,anexos,fechar,cancelar}` · `GET /api/os/:id/documento` (HTML para imprimir/salvar como PDF)
`GET|POST|PUT /api/clientes` · `GET|POST|PUT /api/equipamentos` (o `GET /:id` traz o histórico de atendimentos) · `GET /api/anexos/:id` · `GET /api/relatorios`
`/api/admin/{usuarios,permissoes,perfis,config/:nome,auditoria}`

## Limitações conhecidas (a tratar na produção)
- **E-mail:** sem SMTP configurado, as mensagens (redefinição de senha, atualizações) são apenas registradas no console. Injete um `mailer` real em `createApp`.
- **PDF:** a OS é entregue como HTML de impressão; o PDF sai pelo "Salvar como PDF" do navegador.
- **Limite de login** fica em memória (reinicia com o servidor; não vale para várias instâncias).
- **Campos adicionais configuráveis:** equipamentos aceitam campos livres em `extras` (JSON), sem tela de configuração.
- A ligação de um cadastro de cliente criado pela equipe a uma conta de login é manual (`POST /api/clientes/:id/vincular-usuario`, só administrador), para evitar que alguém tome registros apenas digitando um e-mail.
- Para vários servidores ou grande volume, migrar para PostgreSQL e armazenamento de objetos.
