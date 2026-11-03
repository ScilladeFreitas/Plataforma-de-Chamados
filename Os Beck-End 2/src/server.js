import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { openDb, seedBase, hashSenha, confereSenha, nextProtocolo, PERMISSOES } from './db.js';

class HttpError extends Error { constructor(s, m) { super(m); this.status = s; } }
const err = (s, m) => new HttpError(s, m);
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// ---------- validação ----------
const txt = (v, { min = 0, max = 2000, nome = 'campo', req = false } = {}) => {
  if (v == null || v === '') { if (req) throw err(400, `${nome} é obrigatório`); return null; }
  if (typeof v !== 'string') throw err(400, `${nome} inválido`);
  const t = v.trim();
  if (req && !t) throw err(400, `${nome} é obrigatório`);
  if (t.length < min) throw err(400, `${nome} deve ter ao menos ${min} caracteres`);
  if (t.length > max) throw err(400, `${nome} excede ${max} caracteres`);
  return t;
};
const int = (v, nome = 'id') => { const n = Number(v); if (!Number.isInteger(n) || n <= 0) throw err(400, `${nome} inválido`); return n; };
const data = (v, nome) => { if (v == null || v === '') return null; if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(v) || isNaN(Date.parse(v))) throw err(400, `${nome} deve estar no formato AAAA-MM-DD`); return v; };
const email = v => { const e = txt(v, { req: true, max: 200, nome: 'E-mail' }); if (!EMAIL.test(e)) throw err(400, 'E-mail inválido'); return e.toLowerCase(); };
const checaSenha = s => { if (typeof s !== 'string' || s.length < 10 || s.length > 200 || !/[A-Za-z]/.test(s) || !/\d/.test(s)) throw err(400, 'A senha deve ter ao menos 10 caracteres, com letras e números'); };
const bool01 = v => (v === true || v === 1 ? 1 : 0);

const MAGIC = [['image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'png'], ['image/jpeg', Buffer.from([0xff, 0xd8, 0xff]), 'jpg'], ['application/pdf', Buffer.from('%PDF'), 'pdf']];
const CONFIG = {
  status: ['status', { nome: v => txt(v, { req: true, max: 80, nome: 'Nome' }), ordem: v => int(v, 'ordem'), aguarda_acao: bool01, ativo: bool01 }],
  prioridades: ['prioridades', { nome: v => txt(v, { req: true, max: 80, nome: 'Nome' }), peso: v => int(v, 'peso'), prazo_horas: v => (v == null ? null : int(v, 'prazo_horas')), ativo: bool01 }],
  categorias: ['categorias_equipamento', { nome: v => txt(v, { req: true, max: 80, nome: 'Nome' }), ativo: bool01 }],
  tipos_servico: ['tipos_servico', { nome: v => txt(v, { req: true, max: 80, nome: 'Nome' }), ativo: bool01 }],
};

export function createApp({ dbPath = ':memory:', storageDir = './storage', mailer, cookieSecure = false, adminEmail, adminSenha } = {}) {
  const db = openDb(dbPath);
  seedBase(db, { adminEmail, adminSenha });
  fs.mkdirSync(storageDir, { recursive: true });
  const outbox = [];
  const enviarEmail = mailer || (async (para, assunto, corpo) => { outbox.push({ para, assunto, corpo }); console.log(`[e-mail simulado] para=${para} assunto=${assunto}`); });
  const tx = fn => { db.exec('BEGIN IMMEDIATE'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };
  const q1 = (sql, ...a) => db.prepare(sql).get(...a);
  const qa = (sql, ...a) => db.prepare(sql).all(...a);
  const run = (sql, ...a) => db.prepare(sql).run(...a);
  const audit = (c, acao, ent, id, det) => run('INSERT INTO auditoria(usuario_id,acao,entidade,entidade_id,detalhe,ip) VALUES(?,?,?,?,?,?)', c.user?.id ?? null, acao, ent ?? null, id ?? null, det ? JSON.stringify(det) : null, c.ip);
  const hist = (ent, id, campo, ant, novo, uid) => run('INSERT INTO historico_alteracoes(entidade,entidade_id,campo,valor_anterior,valor_novo,usuario_id) VALUES(?,?,?,?,?,?)', ent, id, campo, ant == null ? null : String(ant), novo == null ? null : String(novo), uid);
  const isStaff = u => u.tipo !== 'cliente';
  const can = (u, cod) => u.tipo === 'admin' || u.perms.has(cod);
  const need = (u, cod) => { if (!can(u, cod)) throw err(403, 'Você não tem permissão para esta ação'); };
  const nomeStatus = id => q1('SELECT nome FROM status WHERE id=?', id)?.nome;

  // atualiza campos validados, registrando histórico campo a campo
  const aplicar = (tabela, ent, row, b, spec, uid) => {
    const sets = [], vals = [];
    for (const [k, fn] of Object.entries(spec)) {
      if (!(k in b)) continue;
      const v = fn(b[k]);
      if ((row[k] ?? null) === v) continue;
      sets.push(`${k}=?`); vals.push(v); hist(ent, row.id, k, row[k], v, uid);
    }
    if (sets.length) run(`UPDATE ${tabela} SET ${sets.join(',')}${tabela === 'ordens_servico' ? ",atualizado_em=datetime('now')" : ''} WHERE id=?`, ...vals, row.id);
    return sets.length;
  };

  // ---------- autenticação ----------
  const tentativas = new Map();
  const bloqueado = k => { const t = tentativas.get(k); return t && t.n >= 5 && Date.now() - t.ts < 15 * 60e3; };
  const falhou = k => { const t = tentativas.get(k); tentativas.set(k, { n: (t && Date.now() - t.ts < 15 * 60e3 ? t.n : 0) + 1, ts: Date.now() }); };
  const carregaUsuario = req => {
    const sid = /(?:^|;\s*)sid=([a-f0-9]{64})/.exec(req.headers.cookie || '')?.[1];
    if (!sid) return null;
    const u = q1(`SELECT u.id,u.nome,u.email,u.perfil_id,p.nome perfil,p.tipo,s.token_hash FROM sessoes s JOIN usuarios u ON u.id=s.usuario_id JOIN perfis p ON p.id=u.perfil_id WHERE s.token_hash=? AND s.expira_em>datetime('now') AND u.ativo=1`, sha(sid));
    if (!u) return null;
    const user = { ...u, perms: new Set(qa('SELECT pe.codigo FROM perfil_permissoes pp JOIN permissoes pe ON pe.id=pp.permissao_id WHERE pp.perfil_id=?', u.perfil_id).map(r => r.codigo)) };
    user.clienteId = q1('SELECT id FROM clientes WHERE usuario_id=?', u.id)?.id ?? null;
    return user;
  };
  const abreSessao = (res, uid) => {
    const tok = crypto.randomBytes(32).toString('hex');
    run("INSERT INTO sessoes(token_hash,usuario_id,expira_em) VALUES(?,?,datetime('now','+8 hours'))", sha(tok), uid);
    run("DELETE FROM sessoes WHERE expira_em<=datetime('now')");
    res.setHeader('Set-Cookie', `sid=${tok}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800${cookieSecure ? '; Secure' : ''}`);
  };

  // ---------- acesso a recursos ----------
  const equipOk = (equipId, clienteId) => !!q1('SELECT 1 FROM equipamentos e WHERE e.id=? AND (e.cliente_id=? OR EXISTS(SELECT 1 FROM equipamento_autorizados a WHERE a.equipamento_id=e.id AND a.cliente_id=?))', equipId, clienteId, clienteId);
  const getOS = (c, id) => {
    const o = q1('SELECT o.*,s.tipo status_tipo,s.nome status_nome FROM ordens_servico o JOIN status s ON s.id=o.status_id WHERE o.id=?', int(id));
    if (!o) throw err(404, 'Chamado não encontrado');
    if (isStaff(c.user)) need(c.user, 'os.ver_todas');
    else if (o.cliente_id !== c.user.clienteId) throw err(404, 'Chamado não encontrado'); // 404: não revela existência
    return o;
  };
  const final = o => o.status_tipo === 'fechado' || o.status_tipo === 'cancelado';
  const naoFinal = o => { if (final(o)) throw err(409, 'Chamado já encerrado; não pode mais ser alterado'); };
  const equipamentoDe = id => q1('SELECT e.id,e.cliente_id,e.fabricante,e.modelo,e.numero_serie,e.patrimonio,c.nome categoria FROM equipamentos e JOIN categorias_equipamento c ON c.id=e.categoria_id WHERE e.id=?', id);

  const detalheOS = (c, o) => {
    const staff = isStaff(c.user);
    const d = {
      id: o.id, protocolo: o.protocolo, cliente_id: o.cliente_id, equipamento: equipamentoDe(o.equipamento_id),
      problema: o.problema, status: { id: o.status_id, nome: o.status_nome, tipo: o.status_tipo },
      prioridade: q1('SELECT nome FROM prioridades WHERE id=?', o.prioridade_id)?.nome,
      aberto_em: o.aberto_em, atualizado_em: o.atualizado_em, fechado_em: o.fechado_em, prazo_estimado: o.prazo_estimado,
      forma_contato: o.forma_contato, data_entrada: o.data_entrada, acessorios: o.acessorios, condicao_fisica: o.condicao_fisica, observacoes_iniciais: o.observacoes_iniciais,
      atualizacoes: qa(`SELECT a.id,a.texto,a.visibilidade,a.criado_em,a.editado_em,u.nome autor FROM atualizacoes a JOIN usuarios u ON u.id=a.autor_id WHERE a.os_id=? ${staff ? '' : "AND a.visibilidade='cliente'"} ORDER BY a.id`, o.id),
      anexos: qa(`SELECT id,atualizacao_id,nome_original,mime,tamanho,criado_em${staff ? ',visivel_cliente' : ''} FROM anexos WHERE os_id=? ${staff ? '' : 'AND visivel_cliente=1'} ORDER BY id`, o.id),
      historico_status: qa(`SELECT valor_anterior de,valor_novo para,criado_em${staff ? ',usuario_id' : ''} FROM historico_alteracoes WHERE entidade='os' AND entidade_id=? AND campo='status' ORDER BY id`, o.id),
    };
    if (staff || final(o)) {
      Object.assign(d, { diagnostico_final: o.diagnostico_final, o_que_foi_feito: o.o_que_foi_feito, testes: o.testes, resultado: o.resultado, recomendacoes: o.recomendacoes, motivo_encerramento: o.motivo_encerramento,
        servicos: qa('SELECT id,descricao,criado_em FROM servicos_executados WHERE os_id=? ORDER BY id', o.id),
        pecas: qa(`SELECT id,descricao,quantidade${staff ? ',observacao' : ''} FROM pecas_utilizadas WHERE os_id=? ORDER BY id`, o.id) });
    }
    if (staff) {
      Object.assign(d, { diagnostico: o.diagnostico, responsavel_id: o.responsavel_id, aberto_por: o.aberto_por, historico: qa("SELECT campo,valor_anterior,valor_novo,usuario_id,criado_em FROM historico_alteracoes WHERE entidade='os' AND entidade_id=? ORDER BY id", o.id) });
    }
    return d;
  };

  // ---------- rotas ----------
  const routes = [];
  const R = (m, p, perm, fn) => routes.push({ m, re: new RegExp('^' + p.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), perm, fn });
  const raw = (status, headers, body) => ({ raw: { status, headers, body } });

  // --- auth
  R('POST', '/api/auth/registrar', 'public', async c => {
    const b = c.body, nome = txt(b.nome, { req: true, max: 120, nome: 'Nome' }), em = email(b.email);
    checaSenha(b.senha);
    if (b.consentimento !== true) throw err(400, 'É necessário aceitar o tratamento de dados pessoais');
    const id = tx(() => {
      const uid = run('INSERT INTO usuarios(nome,email,senha_hash,perfil_id) VALUES(?,?,?,(SELECT id FROM perfis WHERE tipo=\'cliente\'))', nome, em, hashSenha(b.senha)).lastInsertRowid;
      run('INSERT INTO clientes(usuario_id,nome,email,telefone) VALUES(?,?,?,?)', uid, nome, em, txt(b.telefone, { max: 30, nome: 'Telefone' }));
      return uid;
    });
    c.user = { id }; audit(c, 'auth.registro', 'usuario', id);
    return { status: 201, body: { id } };
  });
  R('POST', '/api/auth/login', 'public', async c => {
    const em = String(c.body.email || '').toLowerCase(), k = `${em}|${c.ip}`;
    if (bloqueado(k)) throw err(429, 'Muitas tentativas. Aguarde alguns minutos.');
    const u = q1('SELECT id,senha_hash,ativo FROM usuarios WHERE email=?', em);
    if (!u || !u.ativo || typeof c.body.senha !== 'string' || !confereSenha(c.body.senha, u.senha_hash)) { falhou(k); c.user = null; audit(c, 'auth.login_falhou', 'usuario', u?.id ?? null); throw err(401, 'E-mail ou senha incorretos'); }
    tentativas.delete(k); abreSessao(c.res, u.id); c.user = { id: u.id }; audit(c, 'auth.login', 'usuario', u.id);
    return { body: { ok: true } };
  });
  R('POST', '/api/auth/logout', 'auth', async c => { run('DELETE FROM sessoes WHERE token_hash=?', c.user.token_hash); c.res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; Max-Age=0'); audit(c, 'auth.logout', 'usuario', c.user.id); return { body: { ok: true } }; });
  R('POST', '/api/auth/esqueci-senha', 'public', async c => {
    const u = q1('SELECT id,email FROM usuarios WHERE email=? AND ativo=1', String(c.body.email || '').toLowerCase());
    if (u) {
      const tok = crypto.randomBytes(32).toString('hex');
      run("INSERT INTO reset_tokens(token_hash,usuario_id,expira_em) VALUES(?,?,datetime('now','+30 minutes'))", sha(tok), u.id);
      await enviarEmail(u.email, 'Redefinição de senha', `Use este código para redefinir sua senha (válido por 30 minutos): ${tok}`);
    }
    return { body: { mensagem: 'Se o e-mail estiver cadastrado, enviaremos as instruções.' } }; // resposta idêntica: não revela contas
  });
  R('POST', '/api/auth/redefinir-senha', 'public', async c => {
    checaSenha(c.body.senha);
    const t = q1("SELECT token_hash,usuario_id FROM reset_tokens WHERE token_hash=? AND usado=0 AND expira_em>datetime('now')", sha(String(c.body.token || '')));
    if (!t) throw err(400, 'Código inválido ou expirado');
    tx(() => { run('UPDATE usuarios SET senha_hash=? WHERE id=?', hashSenha(c.body.senha), t.usuario_id); run('UPDATE reset_tokens SET usado=1 WHERE token_hash=?', t.token_hash); run('DELETE FROM sessoes WHERE usuario_id=?', t.usuario_id); });
    c.user = { id: t.usuario_id }; audit(c, 'auth.senha_redefinida', 'usuario', t.usuario_id);
    return { body: { ok: true } };
  });
  R('GET', '/api/me', 'auth', async c => ({ body: { id: c.user.id, nome: c.user.nome, email: c.user.email, perfil: c.user.perfil, tipo: c.user.tipo, cliente_id: c.user.clienteId, permissoes: c.user.tipo === 'admin' ? Object.keys(PERMISSOES) : [...c.user.perms] } }));
  R('GET', '/api/config', 'auth', async () => ({ body: {
    status: qa('SELECT id,nome,ordem,tipo,aguarda_acao FROM status WHERE ativo=1 ORDER BY ordem'), prioridades: qa('SELECT id,nome,peso,prazo_horas FROM prioridades WHERE ativo=1 ORDER BY peso'),
    categorias: qa('SELECT id,nome FROM categorias_equipamento WHERE ativo=1'), tipos_servico: qa('SELECT id,nome FROM tipos_servico WHERE ativo=1') } }));

  // --- clientes (equipe)
  const specCliente = { nome: v => txt(v, { req: true, max: 120, nome: 'Nome' }), email: v => (v ? email(v) : null), telefone: v => txt(v, { max: 30, nome: 'Telefone' }), documento: v => txt(v, { max: 30, nome: 'Documento' }) };
  R('GET', '/api/clientes', 'cliente.gerir', async c => { const q = `%${c.query.get('q') || ''}%`; return { body: qa('SELECT id,nome,email,telefone,documento,usuario_id FROM clientes WHERE nome LIKE ? OR email LIKE ? OR telefone LIKE ? ORDER BY nome LIMIT 200', q, q, q) }; });
  R('POST', '/api/clientes', 'cliente.gerir', async c => {
    const nome = specCliente.nome(c.body.nome);
    const id = run('INSERT INTO clientes(nome,email,telefone,documento) VALUES(?,?,?,?)', nome, specCliente.email(c.body.email), specCliente.telefone(c.body.telefone), specCliente.documento(c.body.documento)).lastInsertRowid;
    audit(c, 'cliente.criar', 'cliente', id); return { status: 201, body: { id } };
  });
  R('GET', '/api/clientes/:id', 'cliente.gerir', async c => { const r = q1('SELECT id,nome,email,telefone,documento,usuario_id FROM clientes WHERE id=?', int(c.params.id)); if (!r) throw err(404, 'Cliente não encontrado'); return { body: r }; });
  R('PUT', '/api/clientes/:id', 'cliente.gerir', async c => {
    const row = q1('SELECT * FROM clientes WHERE id=?', int(c.params.id)); if (!row) throw err(404, 'Cliente não encontrado');
    const n = tx(() => aplicar('clientes', 'cliente', row, c.body, specCliente, c.user.id)); audit(c, 'cliente.editar', 'cliente', row.id); return { body: { alterados: n } };
  });
  R('POST', '/api/clientes/:id/vincular-usuario', 'admin.usuarios', async c => {
    const uid = int(c.body.usuario_id, 'usuario_id');
    if (!q1("SELECT 1 FROM usuarios u JOIN perfis p ON p.id=u.perfil_id WHERE u.id=? AND p.tipo='cliente'", uid)) throw err(400, 'Usuário cliente inválido');
    run('UPDATE clientes SET usuario_id=? WHERE id=?', uid, int(c.params.id)); audit(c, 'cliente.vincular', 'cliente', c.params.id, { usuario_id: uid }); return { body: { ok: true } };
  });

  // --- equipamentos
  const specEquip = { categoria_id: v => int(v, 'categoria_id'), fabricante: v => txt(v, { req: true, max: 80, nome: 'Fabricante' }), modelo: v => txt(v, { req: true, max: 80, nome: 'Modelo' }), numero_serie: v => txt(v, { max: 80, nome: 'Número de série' }), patrimonio: v => txt(v, { max: 80, nome: 'Patrimônio' }),
    extras: v => (v == null ? null : JSON.stringify(typeof v === 'object' ? v : (() => { throw err(400, 'extras inválido'); })())) };
  const acessoEquip = (c, id) => {
    const e = q1('SELECT * FROM equipamentos WHERE id=?', int(id));
    if (!e || (isStaff(c.user) ? !can(c.user, 'os.ver_todas') : !equipOk(e.id, c.user.clienteId))) throw err(404, 'Equipamento não encontrado');
    return e;
  };
  R('GET', '/api/equipamentos', 'auth', async c => {
    const staff = isStaff(c.user), w = [], a = [];
    if (staff) need(c.user, 'os.ver_todas'); else { w.push('(e.cliente_id=? OR EXISTS(SELECT 1 FROM equipamento_autorizados x WHERE x.equipamento_id=e.id AND x.cliente_id=?))'); a.push(c.user.clienteId, c.user.clienteId); }
    const qs = c.query.get('q'); if (qs) { w.push('(e.fabricante LIKE ? OR e.modelo LIKE ? OR e.numero_serie LIKE ? OR e.patrimonio LIKE ?' + (staff ? ' OR cl.nome LIKE ?)' : ')')); const l = `%${qs}%`; a.push(l, l, l, l); if (staff) a.push(l); }
    if (c.query.get('tipo')) { w.push('e.categoria_id=?'); a.push(int(c.query.get('tipo'), 'tipo')); }
    if (staff && c.query.get('cliente_id')) { w.push('e.cliente_id=?'); a.push(int(c.query.get('cliente_id'), 'cliente_id')); }
    return { body: qa(`SELECT e.id,e.cliente_id,${staff ? 'cl.nome cliente,' : ''}ca.nome categoria,e.fabricante,e.modelo,e.numero_serie,e.patrimonio FROM equipamentos e JOIN clientes cl ON cl.id=e.cliente_id JOIN categorias_equipamento ca ON ca.id=e.categoria_id ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY e.id DESC LIMIT 200`, ...a) };
  });
  R('POST', '/api/equipamentos', 'auth', async c => {
    let cid; if (isStaff(c.user)) { need(c.user, 'equip.gerir'); cid = int(c.body.cliente_id, 'cliente_id'); } else cid = c.user.clienteId;
    const v = Object.fromEntries(Object.entries(specEquip).map(([k, f]) => [k, f(c.body[k])]));
    const id = run('INSERT INTO equipamentos(cliente_id,categoria_id,fabricante,modelo,numero_serie,patrimonio,extras) VALUES(?,?,?,?,?,?,?)', cid, v.categoria_id, v.fabricante, v.modelo, v.numero_serie, v.patrimonio, v.extras).lastInsertRowid;
    audit(c, 'equipamento.criar', 'equipamento', id); return { status: 201, body: { id } };
  });
  R('GET', '/api/equipamentos/:id', 'auth', async c => {
    const e = acessoEquip(c, c.params.id), staff = isStaff(c.user);
    const linha = qa(`SELECT o.id,o.protocolo,o.problema,s.nome status,o.aberto_em,o.fechado_em,${staff ? 'o.diagnostico,' : ''}CASE WHEN s.tipo IN('fechado','cancelado') THEN o.resultado END resultado FROM ordens_servico o JOIN status s ON s.id=o.status_id WHERE o.equipamento_id=? ORDER BY o.id DESC`, e.id);
    return { body: { ...e, extras: e.extras ? JSON.parse(e.extras) : null, historico_atendimentos: linha } };
  });
  R('PUT', '/api/equipamentos/:id', 'equip.gerir', async c => {
    const e = q1('SELECT * FROM equipamentos WHERE id=?', int(c.params.id)); if (!e) throw err(404, 'Equipamento não encontrado');
    const n = tx(() => aplicar('equipamentos', 'equipamento', e, c.body, specEquip, c.user.id)); audit(c, 'equipamento.editar', 'equipamento', e.id); return { body: { alterados: n } };
  });
  R('POST', '/api/equipamentos/:id/autorizados', 'equip.gerir', async c => { run('INSERT OR IGNORE INTO equipamento_autorizados VALUES(?,?)', int(c.params.id), int(c.body.cliente_id, 'cliente_id')); audit(c, 'equipamento.autorizar', 'equipamento', c.params.id, { cliente_id: c.body.cliente_id }); return { status: 201, body: { ok: true } }; });

  // --- chamados
  R('POST', '/api/os', 'auth', async c => {
    const b = c.body, staff = isStaff(c.user); let cid;
    if (staff) { need(c.user, 'os.criar'); cid = int(b.cliente_id, 'cliente_id'); if (!q1('SELECT 1 FROM clientes WHERE id=?', cid)) throw err(400, 'Cliente inexistente'); } else cid = c.user.clienteId;
    const eid = int(b.equipamento_id, 'equipamento_id');
    if (!equipOk(eid, cid)) throw err(400, 'Equipamento não pertence ao cliente nem foi autorizado a ele');
    const problema = txt(b.problema, { req: true, min: 5, max: 4000, nome: 'Descrição do problema' });
    if (!staff && b.consentimento !== true) throw err(400, 'Confirme o envio do equipamento/consentimento');
    let prio = staff && b.prioridade_id != null ? int(b.prioridade_id, 'prioridade_id') : q1("SELECT id FROM prioridades WHERE nome='Normal'")?.id ?? q1('SELECT id FROM prioridades WHERE ativo=1 ORDER BY peso LIMIT 1').id;
    const pr = q1('SELECT prazo_horas FROM prioridades WHERE id=? AND ativo=1', prio); if (!pr) throw err(400, 'Prioridade inválida');
    const dt = data(b.data_entrada, 'Data de entrada') || new Date().toISOString().slice(0, 10);
    const r = tx(() => {
      const protocolo = nextProtocolo(db), st = q1("SELECT id FROM status WHERE tipo='inicial' AND ativo=1").id;
      const id = run(`INSERT INTO ordens_servico(protocolo,cliente_id,equipamento_id,status_id,prioridade_id,aberto_por,problema,forma_contato,data_entrada,acessorios,condicao_fisica,observacoes_iniciais,consentimento,prazo_estimado)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,${pr.prazo_horas ? "datetime('now','+' || ? || ' hours')" : '?'})`, protocolo, cid, eid, st, prio, c.user.id, problema,
        txt(b.forma_contato, { max: 100, nome: 'Forma de contato' }), dt, txt(b.acessorios, { max: 500, nome: 'Acessórios' }), txt(b.condicao_fisica, { max: 1000, nome: 'Condição física' }), txt(b.observacoes_iniciais, { max: 2000, nome: 'Observações' }), b.consentimento === true ? 1 : 0, pr.prazo_horas ?? null).lastInsertRowid;
      hist('os', id, 'status', null, nomeStatus(st), c.user.id); return { id, protocolo };
    });
    audit(c, 'os.abrir', 'os', r.id, { protocolo: r.protocolo }); return { status: 201, body: r };
  });
  R('GET', '/api/os', 'auth', async c => {
    const staff = isStaff(c.user), w = [], a = [], g = k => c.query.get(k);
    if (staff) need(c.user, 'os.ver_todas'); else { w.push('o.cliente_id=?'); a.push(c.user.clienteId); }
    if (g('protocolo')) { w.push('o.protocolo LIKE ?'); a.push(`%${g('protocolo')}%`); }
    if (g('status_id')) { w.push('o.status_id=?'); a.push(int(g('status_id'), 'status_id')); }
    if (g('de')) { w.push('date(o.aberto_em)>=date(?)'); a.push(data(g('de'), 'de')); }
    if (g('ate')) { w.push('date(o.aberto_em)<=date(?)'); a.push(data(g('ate'), 'ate')); }
    if (staff) {
      if (g('q')) { w.push('(cl.nome LIKE ? OR cl.email LIKE ? OR cl.telefone LIKE ?)'); const l = `%${g('q')}%`; a.push(l, l, l); }
      if (g('equip')) { w.push('(ca.nome LIKE ? OR e.fabricante LIKE ? OR e.modelo LIKE ? OR e.numero_serie LIKE ?)'); const l = `%${g('equip')}%`; a.push(l, l, l, l); }
      if (g('responsavel_id')) { w.push('o.responsavel_id=?'); a.push(int(g('responsavel_id'), 'responsavel_id')); }
      if (g('cliente_id')) { w.push('o.cliente_id=?'); a.push(int(g('cliente_id'), 'cliente_id')); }
    }
    const lim = Math.min(Number(g('limite')) || 50, 200), off = Math.max(Number(g('offset')) || 0, 0);
    const rows = qa(`SELECT o.id,o.protocolo,substr(o.problema,1,140) problema,o.aberto_em,o.atualizado_em,o.prazo_estimado,s.nome status,s.tipo status_tipo,p.nome prioridade,ca.nome tipo_equipamento,e.fabricante,e.modelo,e.numero_serie${staff ? ',cl.nome cliente,cl.email cliente_email,u.nome responsavel' : ''}
      FROM ordens_servico o JOIN status s ON s.id=o.status_id JOIN prioridades p ON p.id=o.prioridade_id JOIN clientes cl ON cl.id=o.cliente_id JOIN equipamentos e ON e.id=o.equipamento_id JOIN categorias_equipamento ca ON ca.id=e.categoria_id LEFT JOIN usuarios u ON u.id=o.responsavel_id
      ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY o.id DESC LIMIT ? OFFSET ?`, ...a, lim, off);
    return { body: rows };
  });
  R('GET', '/api/os/:id', 'auth', async c => ({ body: detalheOS(c, getOS(c, c.params.id)) }));
  const specOS = {
    problema: v => txt(v, { req: true, min: 5, max: 4000, nome: 'Problema' }), diagnostico: v => txt(v, { max: 4000, nome: 'Diagnóstico' }),
    responsavel_id: v => { if (v == null) return null; const id = int(v, 'responsavel_id'); if (!q1("SELECT 1 FROM usuarios u JOIN perfis p ON p.id=u.perfil_id WHERE u.id=? AND u.ativo=1 AND p.tipo<>'cliente'", id)) throw err(400, 'Responsável inválido'); return id; },
    prioridade_id: v => { const id = int(v, 'prioridade_id'); if (!q1('SELECT 1 FROM prioridades WHERE id=? AND ativo=1', id)) throw err(400, 'Prioridade inválida'); return id; },
    prazo_estimado: v => data(v, 'Prazo estimado'), testes: v => txt(v, { max: 4000, nome: 'Testes' }), recomendacoes: v => txt(v, { max: 4000, nome: 'Recomendações' }),
    observacoes_iniciais: v => txt(v, { max: 2000, nome: 'Observações' }), condicao_fisica: v => txt(v, { max: 1000, nome: 'Condição física' }), acessorios: v => txt(v, { max: 500, nome: 'Acessórios' }), forma_contato: v => txt(v, { max: 100, nome: 'Forma de contato' }),
  };
  R('PUT', '/api/os/:id', 'os.editar', async c => { const o = getOS(c, c.params.id); naoFinal(o); const n = tx(() => aplicar('ordens_servico', 'os', o, c.body, specOS, c.user.id)); audit(c, 'os.editar', 'os', o.id); return { body: { alterados: n } }; });
  R('POST', '/api/os/:id/status', 'os.editar', async c => {
    const o = getOS(c, c.params.id); naoFinal(o);
    const st = q1('SELECT id,nome,tipo FROM status WHERE id=? AND ativo=1', int(c.body.status_id, 'status_id'));
    if (!st) throw err(400, 'Status inválido'); if (st.tipo === 'fechado' || st.tipo === 'cancelado') throw err(400, 'Use as ações de fechar ou cancelar (exigem relatório/motivo)');
    tx(() => { run("UPDATE ordens_servico SET status_id=?,atualizado_em=datetime('now') WHERE id=?", st.id, o.id); hist('os', o.id, 'status', o.status_nome, st.nome, c.user.id); });
    audit(c, 'os.status', 'os', o.id, { de: o.status_nome, para: st.nome }); return { body: { ok: true } };
  });
  R('POST', '/api/os/:id/atualizacoes', 'os.editar', async c => {
    const o = getOS(c, c.params.id), texto = txt(c.body.texto, { req: true, max: 4000, nome: 'Texto' }), vis = c.body.visibilidade;
    if (vis !== 'cliente' && vis !== 'interna') throw err(400, "visibilidade deve ser 'cliente' ou 'interna'");
    const id = run('INSERT INTO atualizacoes(os_id,autor_id,texto,visibilidade) VALUES(?,?,?,?)', o.id, c.user.id, texto, vis).lastInsertRowid;
    run("UPDATE ordens_servico SET atualizado_em=datetime('now') WHERE id=?", o.id); audit(c, 'os.atualizacao', 'os', o.id, { visibilidade: vis });
    if (vis === 'cliente') { const cl = q1('SELECT email FROM clientes WHERE id=?', o.cliente_id); if (cl?.email) await enviarEmail(cl.email, `Atualização do chamado ${o.protocolo}`, texto); } // só texto visível ao cliente
    return { status: 201, body: { id } };
  });
  R('PUT', '/api/atualizacoes/:id', 'os.editar', async c => {
    const a = q1('SELECT * FROM atualizacoes WHERE id=?', int(c.params.id)); if (!a) throw err(404, 'Registro não encontrado'); getOS(c, a.os_id);
    const texto = txt(c.body.texto, { req: true, max: 4000, nome: 'Texto' });
    tx(() => { hist('atualizacao', a.id, 'texto', a.texto, texto, c.user.id); run("UPDATE atualizacoes SET texto=?,editado_em=datetime('now') WHERE id=?", texto, a.id); });
    audit(c, 'os.atualizacao_editar', 'atualizacao', a.id); return { body: { ok: true } };
  });
  R('POST', '/api/os/:id/servicos', 'os.editar', async c => {
    const o = getOS(c, c.params.id); naoFinal(o); const tipo = c.body.tipo_servico_id == null ? null : int(c.body.tipo_servico_id, 'tipo_servico_id');
    const id = run('INSERT INTO servicos_executados(os_id,tipo_servico_id,descricao,autor_id) VALUES(?,?,?,?)', o.id, tipo, txt(c.body.descricao, { req: true, max: 1000, nome: 'Descrição' }), c.user.id).lastInsertRowid; audit(c, 'os.servico', 'os', o.id); return { status: 201, body: { id } };
  });
  R('POST', '/api/os/:id/pecas', 'os.editar', async c => {
    const o = getOS(c, c.params.id); naoFinal(o);
    const id = run('INSERT INTO pecas_utilizadas(os_id,descricao,quantidade,observacao,autor_id) VALUES(?,?,?,?,?)', o.id, txt(c.body.descricao, { req: true, max: 300, nome: 'Descrição' }), int(c.body.quantidade, 'quantidade'), txt(c.body.observacao, { max: 500, nome: 'Observação' }), c.user.id).lastInsertRowid; audit(c, 'os.peca', 'os', o.id); return { status: 201, body: { id } };
  });
  R('POST', '/api/os/:id/fechar', 'os.fechar', async c => {
    const o = getOS(c, c.params.id); naoFinal(o); const b = c.body;
    if (b.confirmar !== true) throw err(400, 'Confirmação obrigatória para fechar o chamado');
    const f = { diagnostico_final: txt(b.diagnostico_final, { req: true, max: 4000, nome: 'Diagnóstico final' }), o_que_foi_feito: txt(b.o_que_foi_feito, { req: true, max: 4000, nome: 'O que foi feito' }), testes: txt(b.testes_finais, { req: true, max: 4000, nome: 'Testes finais e resultado' }), recomendacoes: txt(b.recomendacoes, { req: true, max: 4000, nome: 'Recomendações' }), resultado: txt(b.resultado, { req: true, max: 1000, nome: 'Resultado do atendimento' }) };
    const st = q1("SELECT id,nome FROM status WHERE tipo='fechado' AND ativo=1");
    tx(() => { run("UPDATE ordens_servico SET diagnostico_final=?,o_que_foi_feito=?,testes=?,recomendacoes=?,resultado=?,status_id=?,fechado_em=datetime('now'),fechado_por=?,atualizado_em=datetime('now') WHERE id=?", f.diagnostico_final, f.o_que_foi_feito, f.testes, f.recomendacoes, f.resultado, st.id, c.user.id, o.id); hist('os', o.id, 'status', o.status_nome, st.nome, c.user.id); });
    audit(c, 'os.fechar', 'os', o.id, { protocolo: o.protocolo }); return { body: { ok: true } };
  });
  R('POST', '/api/os/:id/cancelar', 'os.fechar', async c => {
    const o = getOS(c, c.params.id); naoFinal(o);
    if (c.body.confirmar !== true) throw err(400, 'Confirmação obrigatória para cancelar o chamado');
    const motivo = txt(c.body.motivo, { req: true, min: 5, max: 2000, nome: 'Motivo do cancelamento' }), st = q1("SELECT id,nome FROM status WHERE tipo='cancelado' AND ativo=1");
    tx(() => { run("UPDATE ordens_servico SET motivo_encerramento=?,resultado=?,status_id=?,fechado_em=datetime('now'),fechado_por=?,atualizado_em=datetime('now') WHERE id=?", motivo, txt(c.body.resultado, { max: 1000, nome: 'Resultado' }) || 'Cancelado', st.id, c.user.id, o.id); hist('os', o.id, 'status', o.status_nome, st.nome, c.user.id); });
    audit(c, 'os.cancelar', 'os', o.id, { protocolo: o.protocolo }); return { body: { ok: true } };
  });

  // --- anexos
  R('POST', '/api/os/:id/anexos', 'auth', async c => {
    const o = getOS(c, c.params.id), staff = isStaff(c.user); if (staff) need(c.user, 'os.editar');
    const nome = txt(c.body.nome, { req: true, max: 200, nome: 'Nome do arquivo' }).replace(/[^\w.\- ]/g, '_');
    if (typeof c.body.conteudo_base64 !== 'string') throw err(400, 'conteudo_base64 obrigatório');
    const buf = Buffer.from(c.body.conteudo_base64, 'base64');
    if (!buf.length || buf.length > 5 * 1024 * 1024) throw err(400, 'Arquivo vazio ou maior que 5 MB');
    const tipo = MAGIC.find(([, m]) => buf.subarray(0, m.length).equals(m)); if (!tipo) throw err(400, 'Tipo de arquivo não permitido (use PNG, JPG ou PDF)');
    let atid = null, vis = 1;
    if (staff) { vis = c.body.visivel_cliente === true ? 1 : 0; if (c.body.atualizacao_id != null) { const a = q1('SELECT visibilidade FROM atualizacoes WHERE id=? AND os_id=?', int(c.body.atualizacao_id), o.id); if (!a) throw err(400, 'Atualização inválida'); atid = c.body.atualizacao_id; if (a.visibilidade === 'interna') vis = 0; } }
    const arquivo = crypto.randomBytes(16).toString('hex') + '.' + tipo[2]; fs.writeFileSync(path.join(storageDir, arquivo), buf, { mode: 0o600 });
    const id = run('INSERT INTO anexos(os_id,atualizacao_id,nome_original,arquivo,mime,tamanho,sha256,visivel_cliente,enviado_por) VALUES(?,?,?,?,?,?,?,?,?)', o.id, atid, nome, arquivo, tipo[0], buf.length, sha(buf.toString('latin1')), vis, c.user.id).lastInsertRowid;
    audit(c, 'os.anexo', 'os', o.id, { anexo: id }); return { status: 201, body: { id } };
  });
  R('GET', '/api/anexos/:id', 'auth', async c => {
    const a = q1('SELECT * FROM anexos WHERE id=?', int(c.params.id)); if (!a) throw err(404, 'Anexo não encontrado');
    getOS(c, a.os_id); if (!isStaff(c.user) && !a.visivel_cliente) throw err(404, 'Anexo não encontrado');
    return raw(200, { 'Content-Type': a.mime, 'Content-Disposition': `attachment; filename="${a.nome_original}"` }, fs.readFileSync(path.join(storageDir, a.arquivo)));
  });

  // --- documento para impressão/PDF (nunca inclui notas internas)
  R('GET', '/api/os/:id/documento', 'auth', async c => {
    const o = getOS(c, c.params.id), cl = q1('SELECT nome,email,telefone FROM clientes WHERE id=?', o.cliente_id), e = equipamentoDe(o.equipamento_id);
    const sv = qa('SELECT descricao FROM servicos_executados WHERE os_id=?', o.id), pc = qa('SELECT descricao,quantidade FROM pecas_utilizadas WHERE os_id=?', o.id);
    const li = (arr, f) => arr.length ? `<ul>${arr.map(x => `<li>${esc(f(x))}</li>`).join('')}</ul>` : '<p>—</p>';
    const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${esc(o.protocolo)}</title><style>body{font:14px/1.5 system-ui,sans-serif;max-width:800px;margin:2rem auto;padding:0 1rem}h1{margin-bottom:0}h2{font-size:1rem;border-bottom:1px solid #999;margin-top:1.5rem}@media print{body{margin:0}}</style></head><body>
<h1>Ordem de Serviço ${esc(o.protocolo)}</h1><p>Status: <b>${esc(o.status_nome)}</b></p>
<h2>Cliente</h2><p>${esc(cl.nome)}<br>${esc(cl.email)} ${esc(cl.telefone)}</p>
<h2>Equipamento</h2><p>${esc(e.categoria)} — ${esc(e.fabricante)} ${esc(e.modelo)}<br>Nº de série: ${esc(e.numero_serie || '—')} · Patrimônio: ${esc(e.patrimonio || '—')}</p>
<h2>Problema informado</h2><p>${esc(o.problema)}</p>
<h2>Diagnóstico</h2><p>${esc(o.diagnostico_final || o.diagnostico || '—')}</p>
<h2>Serviços realizados</h2>${o.o_que_foi_feito ? `<p>${esc(o.o_que_foi_feito)}</p>` : ''}${li(sv, x => x.descricao)}
<h2>Peças</h2>${li(pc, x => `${x.quantidade}× ${x.descricao}`)}
<h2>Resultado e recomendações</h2><p>${esc(o.resultado || '—')}</p><p>${esc(o.recomendacoes || '')}</p>
<h2>Datas</h2><p>Abertura: ${esc(o.aberto_em)} · Fechamento: ${esc(o.fechado_em || '—')}</p></body></html>`;
    audit(c, 'os.documento', 'os', o.id); return raw(200, { 'Content-Type': 'text/html; charset=utf-8' }, html);
  });

  // --- relatórios
  R('GET', '/api/relatorios', 'relatorio.ver', async c => {
    const w = [], a = [], g = k => c.query.get(k);
    if (g('de')) { w.push('date(o.aberto_em)>=date(?)'); a.push(data(g('de'), 'de')); } if (g('ate')) { w.push('date(o.aberto_em)<=date(?)'); a.push(data(g('ate'), 'ate')); }
    if (g('status_id')) { w.push('o.status_id=?'); a.push(int(g('status_id'))); } if (g('tipo')) { w.push('e.categoria_id=?'); a.push(int(g('tipo'))); }
    if (g('responsavel_id')) { w.push('o.responsavel_id=?'); a.push(int(g('responsavel_id'))); } if (g('cliente_id')) { w.push('o.cliente_id=?'); a.push(int(g('cliente_id'))); }
    const F = `FROM ordens_servico o JOIN status s ON s.id=o.status_id JOIN equipamentos e ON e.id=o.equipamento_id ${w.length ? 'WHERE ' + w.join(' AND ') : ''}`;
    const t = q1(`SELECT count(*) total, sum(s.tipo='fechado') concluidos, sum(s.aguarda_acao=1 AND s.tipo NOT IN('fechado','cancelado')) aguardando_acao, round(avg(CASE WHEN s.tipo='fechado' THEN (julianday(o.fechado_em)-julianday(o.aberto_em))*24 END),2) tempo_medio_horas ${F}`, ...a);
    return { body: { ...t, concluidos: t.concluidos ?? 0, aguardando_acao: t.aguardando_acao ?? 0, por_status: qa(`SELECT s.nome status,count(*) quantidade ${F} GROUP BY s.id ORDER BY s.ordem`, ...a) } };
  });

  // --- administração
  R('GET', '/api/admin/usuarios', 'admin.usuarios', async () => ({ body: qa('SELECT u.id,u.nome,u.email,u.ativo,p.nome perfil,p.tipo,u.demo FROM usuarios u JOIN perfis p ON p.id=u.perfil_id ORDER BY u.id') }));
  R('POST', '/api/admin/usuarios', 'admin.usuarios', async c => {
    checaSenha(c.body.senha); const p = q1("SELECT id FROM perfis WHERE id=? AND tipo<>'cliente'", int(c.body.perfil_id, 'perfil_id')); if (!p) throw err(400, 'Perfil inválido');
    const id = run('INSERT INTO usuarios(nome,email,senha_hash,perfil_id) VALUES(?,?,?,?)', txt(c.body.nome, { req: true, max: 120, nome: 'Nome' }), email(c.body.email), hashSenha(c.body.senha), p.id).lastInsertRowid; audit(c, 'admin.usuario_criar', 'usuario', id); return { status: 201, body: { id } };
  });
  R('PUT', '/api/admin/usuarios/:id', 'admin.usuarios', async c => {
    const id = int(c.params.id), u = q1('SELECT id FROM usuarios WHERE id=?', id); if (!u) throw err(404, 'Usuário não encontrado'); const b = c.body;
    if (id === c.user.id && 'ativo' in b && !b.ativo) throw err(400, 'Você não pode desativar o próprio acesso');
    tx(() => {
      if ('nome' in b) run('UPDATE usuarios SET nome=? WHERE id=?', txt(b.nome, { req: true, max: 120, nome: 'Nome' }), id);
      if ('perfil_id' in b) { if (!q1("SELECT 1 FROM perfis WHERE id=? AND tipo<>'cliente'", int(b.perfil_id))) throw err(400, 'Perfil inválido'); run('UPDATE usuarios SET perfil_id=? WHERE id=?', b.perfil_id, id); }
      if ('ativo' in b) { run('UPDATE usuarios SET ativo=? WHERE id=?', bool01(b.ativo), id); if (!b.ativo) run('DELETE FROM sessoes WHERE usuario_id=?', id); }
      if ('senha' in b) { checaSenha(b.senha); run('UPDATE usuarios SET senha_hash=? WHERE id=?', hashSenha(b.senha), id); run('DELETE FROM sessoes WHERE usuario_id=?', id); }
    });
    audit(c, 'admin.usuario_editar', 'usuario', id, { campos: Object.keys(b).filter(k => k !== 'senha') }); return { body: { ok: true } };
  });
  R('GET', '/api/admin/permissoes', 'admin.permissoes', async () => ({ body: { permissoes: PERMISSOES, perfis: qa('SELECT id,nome,tipo FROM perfis').map(p => ({ ...p, permissoes: p.tipo === 'admin' ? Object.keys(PERMISSOES) : qa('SELECT pe.codigo FROM perfil_permissoes pp JOIN permissoes pe ON pe.id=pp.permissao_id WHERE pp.perfil_id=?', p.id).map(r => r.codigo) })) } }));
  R('POST', '/api/admin/perfis', 'admin.permissoes', async c => { const id = run("INSERT INTO perfis(nome,tipo) VALUES(?,'equipe')", txt(c.body.nome, { req: true, max: 60, nome: 'Nome' })).lastInsertRowid; audit(c, 'admin.perfil_criar', 'perfil', id); return { status: 201, body: { id } }; });
  R('PUT', '/api/admin/perfis/:id/permissoes', 'admin.permissoes', async c => {
    const p = q1("SELECT id FROM perfis WHERE id=? AND tipo='equipe'", int(c.params.id)); if (!p) throw err(400, 'Só é possível editar permissões de funções de equipe');
    const lista = c.body.permissoes; if (!Array.isArray(lista) || lista.some(x => !(x in PERMISSOES))) throw err(400, 'Lista de permissões inválida');
    tx(() => { run('DELETE FROM perfil_permissoes WHERE perfil_id=?', p.id); for (const x of lista) run('INSERT INTO perfil_permissoes SELECT ?,id FROM permissoes WHERE codigo=?', p.id, x); });
    audit(c, 'admin.permissoes', 'perfil', p.id, { permissoes: lista }); return { body: { ok: true } };
  });
  R('POST', '/api/admin/config/:nome', 'admin.config', async c => {
    const [tab, spec] = CONFIG[c.params.nome] || []; if (!tab) throw err(404, 'Configuração desconhecida');
    const cols = Object.keys(spec).filter(k => k in c.body), vals = cols.map(k => spec[k](c.body[k]));
    if (tab === 'status') { cols.push('tipo'); vals.push(c.body.tipo === 'normal' || c.body.tipo === 'pronto' || !c.body.tipo ? c.body.tipo || 'normal' : (() => { throw err(400, "Novos status só podem ser do tipo 'normal' ou 'pronto'"); })()); }
    const id = run(`INSERT INTO ${tab}(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`, ...vals).lastInsertRowid; audit(c, 'admin.config_criar', tab, id); return { status: 201, body: { id } };
  });
  R('PUT', '/api/admin/config/:nome/:id', 'admin.config', async c => {
    const [tab, spec] = CONFIG[c.params.nome] || []; if (!tab) throw err(404, 'Configuração desconhecida');
    const row = q1(`SELECT * FROM ${tab} WHERE id=?`, int(c.params.id)); if (!row) throw err(404, 'Item não encontrado');
    if (tab === 'status' && ['inicial', 'fechado', 'cancelado'].includes(row.tipo) && 'ativo' in c.body && !c.body.ativo) throw err(400, 'Este status é essencial ao fluxo e não pode ser desativado (apenas renomeado)');
    const n = tx(() => aplicar(tab, 'config:' + tab, row, c.body, spec, c.user.id)); audit(c, 'admin.config_editar', tab, row.id); return { body: { alterados: n } };
  });
  R('GET', '/api/admin/auditoria', 'auditoria.ver', async c => ({ body: qa('SELECT a.id,a.criado_em,u.nome usuario,a.acao,a.entidade,a.entidade_id,a.detalhe,a.ip FROM auditoria a LEFT JOIN usuarios u ON u.id=a.usuario_id ORDER BY a.id DESC LIMIT ? OFFSET ?', Math.min(Number(c.query.get('limite')) || 100, 500), Number(c.query.get('offset')) || 0) }));

  // ---------- servidor ----------
  const send = (res, status, headers, body) => { res.writeHead(status, { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', ...headers }); res.end(body); };
  const server = http.createServer(async (req, res) => {
    const ip = req.socket.remoteAddress; const c = { req, res, ip, params: {}, body: {}, user: null };
    try {
      const url = new URL(req.url, 'http://localhost'); c.query = url.searchParams;
      // Interface web estática servida pela mesma origem da API.
      if (url.pathname === '/' || url.pathname.startsWith('/app/')) {
        const root = path.resolve('public');
        const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(5));
        const file = path.resolve(root, rel);
        if (!file.startsWith(root + path.sep) && file !== path.join(root, 'index.html')) return send(res, 403, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Acesso negado');
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Página não encontrada');
        const type = file.endsWith('.css') ? 'text/css; charset=utf-8' : file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8';
        return send(res, 200, { 'Content-Type': type }, fs.readFileSync(file));
      }
      let r = null; for (const x of routes) { if (x.m !== req.method) continue; const m = x.re.exec(url.pathname); if (m) { r = x; c.params = { ...m.groups }; break; } }
      if (!r) return send(res, 404, { 'Content-Type': 'application/json' }, JSON.stringify({ erro: 'Rota não encontrada' }));
      if (req.method !== 'GET') {
        if (!/^application\/json/.test(req.headers['content-type'] || '')) throw err(415, 'Content-Type deve ser application/json');
        const chunks = []; let len = 0; for await (const ch of req) { len += ch.length; if (len > 8 * 1024 * 1024) throw err(413, 'Requisição muito grande'); chunks.push(ch); }
        try { c.body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}; } catch { throw err(400, 'JSON inválido'); }
        if (c.body === null || typeof c.body !== 'object' || Array.isArray(c.body)) throw err(400, 'Corpo deve ser um objeto JSON');
      }
      if (r.perm !== 'public') { c.user = carregaUsuario(req); if (!c.user) throw err(401, 'Autenticação necessária'); if (!['auth', 'public'].includes(r.perm)) need(c.user, r.perm); }
      const out = await r.fn(c);
      if (out.raw) return send(res, out.raw.status, out.raw.headers, out.raw.body);
      send(res, out.status || 200, { 'Content-Type': 'application/json' }, JSON.stringify(out.body));
    } catch (e) {
      let status = e.status || 500, msg = e.message;
      if (!e.status) {
        if (/UNIQUE constraint/.test(e.message)) { status = 409; msg = /usuarios\.email/.test(e.message) ? 'E-mail já cadastrado' : 'Registro duplicado'; }
        else if (/FOREIGN KEY|CHECK constraint|NOT NULL/.test(e.message)) { status = 400; msg = 'Dados inválidos ou vínculo inexistente'; }
        else { console.error(e); msg = 'Erro interno'; }
      }
      send(res, status, { 'Content-Type': 'application/json' }, JSON.stringify({ erro: msg }));
    }
  });
  return { server, db, outbox, close: () => new Promise(r => server.close(() => { db.close(); r(); })) };
}
