import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';

// ---------- senhas (scrypt com sal por usuário; nunca texto puro) ----------
export function hashSenha(s) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(s, salt, 64);
  return `scrypt$${salt.toString('base64')}$${h.toString('base64')}`;
}
export function confereSenha(s, stored) {
  const [, salt, h] = stored.split('$');
  const x = crypto.scryptSync(s, Buffer.from(salt, 'base64'), 64);
  return crypto.timingSafeEqual(x, Buffer.from(h, 'base64'));
}

export const PERMISSOES = {
  'os.criar': 'Abrir chamados em nome de clientes',
  'os.ver_todas': 'Consultar todos os chamados e históricos',
  'os.editar': 'Editar chamados, atualizações, notas internas, serviços e peças',
  'os.fechar': 'Fechar e cancelar chamados',
  'cliente.gerir': 'Cadastrar e editar clientes',
  'equip.gerir': 'Cadastrar e editar equipamentos',
  'relatorio.ver': 'Consultar relatórios',
  'admin.usuarios': 'Criar, editar, desativar usuários e redefinir acessos',
  'admin.config': 'Configurar status, prioridades, categorias e tipos de serviço',
  'admin.permissoes': 'Definir permissões por função',
  'auditoria.ver': 'Consultar registros de auditoria',
};
const PERMS_EQUIPE = ['os.criar', 'os.ver_todas', 'os.editar', 'os.fechar', 'cliente.gerir', 'equip.gerir', 'relatorio.ver'];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS perfis(id INTEGER PRIMARY KEY, nome TEXT UNIQUE NOT NULL, tipo TEXT NOT NULL CHECK(tipo IN('cliente','equipe','admin')));
CREATE TABLE IF NOT EXISTS permissoes(id INTEGER PRIMARY KEY, codigo TEXT UNIQUE NOT NULL, descricao TEXT);
CREATE TABLE IF NOT EXISTS perfil_permissoes(perfil_id INTEGER NOT NULL REFERENCES perfis(id) ON DELETE CASCADE, permissao_id INTEGER NOT NULL REFERENCES permissoes(id), PRIMARY KEY(perfil_id,permissao_id));
CREATE TABLE IF NOT EXISTS usuarios(id INTEGER PRIMARY KEY, nome TEXT NOT NULL, email TEXT UNIQUE NOT NULL COLLATE NOCASE, senha_hash TEXT NOT NULL, perfil_id INTEGER NOT NULL REFERENCES perfis(id), ativo INTEGER NOT NULL DEFAULT 1, demo INTEGER NOT NULL DEFAULT 0, criado_em TEXT NOT NULL DEFAULT(datetime('now')));
CREATE TABLE IF NOT EXISTS sessoes(token_hash TEXT PRIMARY KEY, usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE, expira_em TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS reset_tokens(token_hash TEXT PRIMARY KEY, usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE, expira_em TEXT NOT NULL, usado INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS clientes(id INTEGER PRIMARY KEY, usuario_id INTEGER UNIQUE REFERENCES usuarios(id), nome TEXT NOT NULL, email TEXT, telefone TEXT, documento TEXT, demo INTEGER NOT NULL DEFAULT 0, criado_em TEXT NOT NULL DEFAULT(datetime('now')));
CREATE TABLE IF NOT EXISTS categorias_equipamento(id INTEGER PRIMARY KEY, nome TEXT UNIQUE NOT NULL, ativo INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS tipos_servico(id INTEGER PRIMARY KEY, nome TEXT UNIQUE NOT NULL, ativo INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS status(id INTEGER PRIMARY KEY, nome TEXT UNIQUE NOT NULL, ordem INTEGER NOT NULL DEFAULT 0, tipo TEXT NOT NULL DEFAULT 'normal' CHECK(tipo IN('inicial','normal','pronto','fechado','cancelado')), aguarda_acao INTEGER NOT NULL DEFAULT 0, ativo INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS prioridades(id INTEGER PRIMARY KEY, nome TEXT UNIQUE NOT NULL, peso INTEGER NOT NULL DEFAULT 0, prazo_horas INTEGER, ativo INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS equipamentos(id INTEGER PRIMARY KEY, cliente_id INTEGER NOT NULL REFERENCES clientes(id), categoria_id INTEGER NOT NULL REFERENCES categorias_equipamento(id), fabricante TEXT NOT NULL, modelo TEXT NOT NULL, numero_serie TEXT, patrimonio TEXT, extras TEXT, demo INTEGER NOT NULL DEFAULT 0, criado_em TEXT NOT NULL DEFAULT(datetime('now')));
CREATE UNIQUE INDEX IF NOT EXISTS ux_equip_serie ON equipamentos(cliente_id, numero_serie) WHERE numero_serie IS NOT NULL;
CREATE TABLE IF NOT EXISTS equipamento_autorizados(equipamento_id INTEGER NOT NULL REFERENCES equipamentos(id) ON DELETE CASCADE, cliente_id INTEGER NOT NULL REFERENCES clientes(id), PRIMARY KEY(equipamento_id,cliente_id));
CREATE TABLE IF NOT EXISTS contadores_protocolo(ano INTEGER PRIMARY KEY, ultimo INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS ordens_servico(
  id INTEGER PRIMARY KEY, protocolo TEXT NOT NULL UNIQUE,
  cliente_id INTEGER NOT NULL REFERENCES clientes(id), equipamento_id INTEGER NOT NULL REFERENCES equipamentos(id),
  status_id INTEGER NOT NULL REFERENCES status(id), prioridade_id INTEGER NOT NULL REFERENCES prioridades(id),
  responsavel_id INTEGER REFERENCES usuarios(id), aberto_por INTEGER NOT NULL REFERENCES usuarios(id),
  problema TEXT NOT NULL, forma_contato TEXT, data_entrada TEXT, acessorios TEXT, condicao_fisica TEXT, observacoes_iniciais TEXT, consentimento INTEGER NOT NULL DEFAULT 0,
  diagnostico TEXT, prazo_estimado TEXT, testes TEXT, recomendacoes TEXT,
  diagnostico_final TEXT, o_que_foi_feito TEXT, resultado TEXT, motivo_encerramento TEXT,
  aberto_em TEXT NOT NULL DEFAULT(datetime('now')), atualizado_em TEXT NOT NULL DEFAULT(datetime('now')), fechado_em TEXT, fechado_por INTEGER REFERENCES usuarios(id),
  demo INTEGER NOT NULL DEFAULT 0,
  documento_google_id TEXT, documento_google_url TEXT);
CREATE INDEX IF NOT EXISTS ix_os_cliente ON ordens_servico(cliente_id);
CREATE INDEX IF NOT EXISTS ix_os_equip ON ordens_servico(equipamento_id);
CREATE TABLE IF NOT EXISTS atualizacoes(id INTEGER PRIMARY KEY, os_id INTEGER NOT NULL REFERENCES ordens_servico(id), autor_id INTEGER NOT NULL REFERENCES usuarios(id), texto TEXT NOT NULL, visibilidade TEXT NOT NULL CHECK(visibilidade IN('cliente','interna')), criado_em TEXT NOT NULL DEFAULT(datetime('now')), editado_em TEXT);
CREATE TABLE IF NOT EXISTS servicos_executados(id INTEGER PRIMARY KEY, os_id INTEGER NOT NULL REFERENCES ordens_servico(id), tipo_servico_id INTEGER REFERENCES tipos_servico(id), descricao TEXT NOT NULL, autor_id INTEGER NOT NULL REFERENCES usuarios(id), criado_em TEXT NOT NULL DEFAULT(datetime('now')));
CREATE TABLE IF NOT EXISTS pecas_utilizadas(id INTEGER PRIMARY KEY, os_id INTEGER NOT NULL REFERENCES ordens_servico(id), descricao TEXT NOT NULL, quantidade INTEGER NOT NULL CHECK(quantidade>0), observacao TEXT, autor_id INTEGER NOT NULL REFERENCES usuarios(id), criado_em TEXT NOT NULL DEFAULT(datetime('now')));
CREATE TABLE IF NOT EXISTS anexos(id INTEGER PRIMARY KEY, os_id INTEGER NOT NULL REFERENCES ordens_servico(id), atualizacao_id INTEGER REFERENCES atualizacoes(id), nome_original TEXT NOT NULL, arquivo TEXT NOT NULL UNIQUE, mime TEXT NOT NULL, tamanho INTEGER NOT NULL, sha256 TEXT NOT NULL, visivel_cliente INTEGER NOT NULL DEFAULT 1, enviado_por INTEGER NOT NULL REFERENCES usuarios(id), criado_em TEXT NOT NULL DEFAULT(datetime('now')));
CREATE TABLE IF NOT EXISTS historico_alteracoes(id INTEGER PRIMARY KEY, entidade TEXT NOT NULL, entidade_id INTEGER NOT NULL, campo TEXT NOT NULL, valor_anterior TEXT, valor_novo TEXT, usuario_id INTEGER REFERENCES usuarios(id), criado_em TEXT NOT NULL DEFAULT(datetime('now')));
CREATE TABLE IF NOT EXISTS auditoria(id INTEGER PRIMARY KEY, usuario_id INTEGER REFERENCES usuarios(id), acao TEXT NOT NULL, entidade TEXT, entidade_id INTEGER, detalhe TEXT, ip TEXT, criado_em TEXT NOT NULL DEFAULT(datetime('now')));
`;

export function openDb(file = ':memory:') {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;');
  db.exec(SCHEMA);
  // Migração compatível com bancos locais criados por versões anteriores.
  const osCols = new Set(db.prepare('PRAGMA table_info(ordens_servico)').all().map(c => c.name));
  if (!osCols.has('documento_google_id')) db.exec('ALTER TABLE ordens_servico ADD COLUMN documento_google_id TEXT');
  if (!osCols.has('documento_google_url')) db.exec('ALTER TABLE ordens_servico ADD COLUMN documento_google_url TEXT');
  db.exec(`CREATE TABLE IF NOT EXISTS google_integracao(
    id INTEGER PRIMARY KEY CHECK(id=1), refresh_token_cifrado TEXT NOT NULL,
    drive_folder_id TEXT, atualizado_em TEXT NOT NULL DEFAULT(datetime('now'))
  )`);
  const googleCols = new Set(db.prepare('PRAGMA table_info(google_integracao)').all().map(c => c.name));
  if (!googleCols.has('drive_folder_id')) db.exec('ALTER TABLE google_integracao ADD COLUMN drive_folder_id TEXT');
  return db;
}

// Deve ser chamado dentro de uma transação (o servidor usa BEGIN IMMEDIATE).
export function nextProtocolo(db) {
  const ano = new Date().getFullYear();
  db.prepare('INSERT OR IGNORE INTO contadores_protocolo(ano,ultimo) VALUES(?,0)').run(ano);
  db.prepare('UPDATE contadores_protocolo SET ultimo=ultimo+1 WHERE ano=?').run(ano);
  const n = db.prepare('SELECT ultimo FROM contadores_protocolo WHERE ano=?').get(ano).ultimo;
  return `OS-${ano}-${String(n).padStart(6, '0')}`;
}

export function seedBase(db, { adminEmail, adminSenha } = {}) {
  if (!db.prepare('SELECT 1 FROM perfis LIMIT 1').get()) {
    const run = (sql, ...a) => db.prepare(sql).run(...a);
    for (const [c, d] of Object.entries(PERMISSOES)) run('INSERT INTO permissoes(codigo,descricao) VALUES(?,?)', c, d);
    run("INSERT INTO perfis(nome,tipo) VALUES('Cliente','cliente'),('Funcionário','equipe'),('Administrador','admin')");
    const eq = db.prepare("SELECT id FROM perfis WHERE nome='Funcionário'").get().id;
    for (const c of PERMS_EQUIPE) run('INSERT INTO perfil_permissoes SELECT ?,id FROM permissoes WHERE codigo=?', eq, c);
    const st = [['Aberto', 'inicial', 0], ['Em triagem', 'normal', 0], ['Aguardando aprovação', 'normal', 1], ['Aguardando peça', 'normal', 1], ['Em manutenção', 'normal', 0], ['Em teste', 'normal', 0], ['Pronto para retirada ou entrega', 'pronto', 1], ['Fechado', 'fechado', 0], ['Cancelado', 'cancelado', 0]];
    st.forEach(([n, t, a], i) => run('INSERT INTO status(nome,ordem,tipo,aguarda_acao) VALUES(?,?,?,?)', n, i + 1, t, a));
    [['Baixa', 1, 120], ['Normal', 2, 72], ['Alta', 3, 24], ['Urgente', 4, 8]].forEach(([n, p, h]) => run('INSERT INTO prioridades(nome,peso,prazo_horas) VALUES(?,?,?)', n, p, h));
    ['Notebook', 'Desktop', 'Impressora', 'Videogame', 'Outro'].forEach(n => run('INSERT INTO categorias_equipamento(nome) VALUES(?)', n));
    ['Diagnóstico', 'Limpeza preventiva', 'Troca de peça', 'Formatação / software', 'Reparo de placa'].forEach(n => run('INSERT INTO tipos_servico(nome) VALUES(?)', n));
  }
  if (adminEmail && adminSenha && !db.prepare('SELECT 1 FROM usuarios WHERE email=?').get(adminEmail)) {
    const p = db.prepare("SELECT id FROM perfis WHERE tipo='admin'").get().id;
    db.prepare('INSERT INTO usuarios(nome,email,senha_hash,perfil_id) VALUES(?,?,?,?)').run('Administrador', adminEmail, hashSenha(adminSenha), p);
  }
}
