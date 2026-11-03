import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { createApp } from '../src/server.js';

const SENHA = 'Senha12345!';
const app = createApp({ storageDir: fs.mkdtempSync(path.join(os.tmpdir(), 'os-')), adminEmail: 'adm@t.local', adminSenha: SENHA, mailer: async (p, a, t) => { app.outbox.push({ p, a, t }); } });
await new Promise(r => app.server.listen(0, r));
const base = `http://127.0.0.1:${app.server.address().port}`;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).toString('base64');

function sessao() {
  let cookie = '';
  return async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(cookie && { Cookie: cookie }) }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
    return { s: r.status, j, raw: t };
  };
}
const registrar = async (nome, email) => { const a = sessao(); assert.equal((await a('POST', '/api/auth/registrar', { nome, email, senha: SENHA, consentimento: true })).s, 201); assert.equal((await a('POST', '/api/auth/login', { email, senha: SENHA })).s, 200); return a; };
const NOTA = 'SEGREDO-NOTA-INTERNA-XYZ';

const adm = sessao(); await adm('POST', '/api/auth/login', { email: 'adm@t.local', senha: SENHA });
const perfilEq = (await adm('GET', '/api/admin/permissoes')).j.perfis.find(p => p.nome === 'Funcionário').id;
assert.equal((await adm('POST', '/api/admin/usuarios', { nome: 'Téc', email: 'tec@t.local', senha: SENHA, perfil_id: perfilEq })).s, 201);
const tec = sessao(); await tec('POST', '/api/auth/login', { email: 'tec@t.local', senha: SENHA });
const A = await registrar('Ana', 'ana@t.local'), B = await registrar('Bruno', 'bruno@t.local');
const cfg = (await A('GET', '/api/config')).j;
let osA, eqA;

test('1. cliente abre e consulta chamado', async () => {
  eqA = (await A('POST', '/api/equipamentos', { categoria_id: cfg.categorias[0].id, fabricante: 'X', modelo: 'Y', numero_serie: 'SN1' })).j.id;
  assert.equal((await A('POST', '/api/os', { equipamento_id: eqA, problema: 'Não liga' })).s, 400, 'sem consentimento');
  const r = await A('POST', '/api/os', { equipamento_id: eqA, problema: 'Não liga mais', consentimento: true });
  assert.equal(r.s, 201); assert.match(r.j.protocolo, /^OS-\d{4}-\d{6}$/); osA = r.j.id;
  const l = await A('GET', '/api/os'); assert.equal(l.j.length, 1);
  assert.equal((await A('GET', `/api/os/${osA}`)).j.status.nome, 'Aberto');
  assert.equal((await A('POST', `/api/os/${osA}/anexos`, { nome: 'foto.png', conteudo_base64: PNG })).s, 201);
  assert.equal((await A('POST', `/api/os/${osA}/anexos`, { nome: 'x.exe', conteudo_base64: Buffer.from('MZ....').toString('base64') })).s, 400, 'tipo inválido');
});

test('2. cliente não acessa dados de terceiros nem notas internas', async () => {
  for (const u of [`/api/os/${osA}`, `/api/equipamentos/${eqA}`, `/api/os/${osA}/documento`, '/api/anexos/1']) assert.equal((await B('GET', u)).s, 404, u);
  assert.equal((await B('GET', '/api/os')).j.length, 0);
  assert.equal((await B('POST', '/api/os', { equipamento_id: eqA, problema: 'Tentando usar equip. alheio', consentimento: true })).s, 400);
  for (const [m, u, b] of [['GET', '/api/clientes'], ['GET', '/api/relatorios'], ['GET', '/api/admin/usuarios'], ['PUT', `/api/os/${osA}`, { diagnostico: 'x' }], ['POST', `/api/os/${osA}/status`, { status_id: 2 }], ['POST', `/api/os/${osA}/atualizacoes`, { texto: 'oi', visibilidade: 'cliente' }], ['POST', `/api/os/${osA}/fechar`, { confirmar: true }]])
    assert.equal((await A(m, u, b)).s, 403, `${m} ${u}`);
  assert.equal((await sessao()('GET', '/api/os')).s, 401);
  // equipe cria nota interna + atualização visível
  assert.equal((await tec('POST', `/api/os/${osA}/atualizacoes`, { texto: NOTA, visibilidade: 'interna' })).s, 201);
  assert.equal((await tec('POST', `/api/os/${osA}/atualizacoes`, { texto: 'Recebemos o equipamento', visibilidade: 'cliente' })).s, 201);
  const d = await A('GET', `/api/os/${osA}`);
  assert.equal(d.j.atualizacoes.length, 1); assert.ok(!d.raw.includes(NOTA));
  assert.ok(!(await A('GET', `/api/os/${osA}/documento`)).raw.includes(NOTA));
  assert.ok((await tec('GET', `/api/os/${osA}`)).raw.includes(NOTA));
  assert.ok(app.outbox.every(m => !m.t.includes(NOTA)), 'notificações não vazam nota interna');
  assert.ok(!(await A('GET', '/api/os?q=SEGREDO')).raw.includes(NOTA));
});

test('3. funcionário atualiza e fecha chamado', async () => {
  const me = (await tec('GET', '/api/me')).j.id;
  assert.equal((await tec('PUT', `/api/os/${osA}`, { diagnostico: 'Fonte queimada', responsavel_id: me })).s, 200);
  const emTriagem = cfg.status.find(s => s.nome === 'Em manutenção').id;
  assert.equal((await tec('POST', `/api/os/${osA}/status`, { status_id: emTriagem })).s, 200);
  assert.equal((await tec('POST', `/api/os/${osA}/servicos`, { descricao: 'Troca da fonte' })).s, 201);
  assert.equal((await tec('POST', `/api/os/${osA}/pecas`, { descricao: 'Fonte 65W', quantidade: 1 })).s, 201);
  assert.equal((await tec('POST', `/api/os/${osA}/fechar`, { confirmar: true, diagnostico_final: 'x' })).s, 400, 'campos obrigatórios');
  assert.equal((await tec('POST', `/api/os/${osA}/status`, { status_id: cfg.status.find(s => s.nome === 'Fechado').id })).s, 400, 'não fecha pelo status');
  const f = { confirmar: true, diagnostico_final: 'Fonte queimada', o_que_foi_feito: 'Troca da fonte', testes_finais: '2h ligado, ok', recomendacoes: 'Usar estabilizador', resultado: 'Resolvido' };
  assert.equal((await tec('POST', `/api/os/${osA}/fechar`, { ...f, confirmar: false })).s, 400);
  assert.equal((await tec('POST', `/api/os/${osA}/fechar`, f)).s, 200);
  assert.equal((await tec('PUT', `/api/os/${osA}`, { diagnostico: 'mudou' })).s, 409, 'OS encerrada é imutável');
  const d = (await A('GET', `/api/os/${osA}`)).j;
  assert.equal(d.status.nome, 'Fechado'); assert.equal(d.resultado, 'Resolvido'); assert.ok(d.fechado_em);
  assert.deepEqual(d.historico_status.map(h => h.para), ['Aberto', 'Em manutenção', 'Fechado']);
  const h = (await tec('GET', `/api/os/${osA}`)).j.historico.filter(x => x.campo === 'status');
  assert.ok(h.every(x => x.usuario_id && x.criado_em) && h.length === 3);
  assert.ok((await A('GET', `/api/os/${osA}/documento`)).raw.includes('Troca da fonte'));
  assert.equal((await tec('GET', '/api/relatorios')).j.concluidos, 1);
  assert.ok((await adm('GET', '/api/admin/auditoria')).j.some(a => a.acao === 'os.fechar'));
});

test('4. histórico do equipamento permanece após o fechamento', async () => {
  const e = (await A('GET', `/api/equipamentos/${eqA}`)).j;
  assert.equal(e.historico_atendimentos.length, 1); assert.equal(e.historico_atendimentos[0].status, 'Fechado');
  const r2 = await A('POST', '/api/os', { equipamento_id: eqA, problema: 'Voltou a falhar', consentimento: true });
  assert.notEqual(r2.j.protocolo, (await A('GET', '/api/os')).j.find(o => o.id === osA).protocolo);
  assert.equal((await tec('GET', `/api/equipamentos/${eqA}`)).j.historico_atendimentos.length, 2);
});

test('5. protocolos únicos sob concorrência e recuperação de senha', async () => {
  const rs = await Promise.all(Array.from({ length: 15 }, () => A('POST', '/api/os', { equipamento_id: eqA, problema: 'Carga concorrente', consentimento: true })));
  assert.equal(new Set(rs.map(r => r.j.protocolo)).size, 15);
  const c = sessao(); await c('POST', '/api/auth/esqueci-senha', { email: 'ana@t.local' });
  const tok = /: (\w{64})/.exec(app.outbox.at(-1).t)[1];
  assert.equal((await c('POST', '/api/auth/redefinir-senha', { token: tok, senha: 'NovaSenha123' })).s, 200);
  assert.equal((await c('POST', '/api/auth/redefinir-senha', { token: tok, senha: 'OutraSenha123' })).s, 400, 'token de uso único');
  assert.equal((await A('GET', '/api/me')).s, 401, 'sessões antigas encerradas');
  assert.equal((await sessao()('POST', '/api/auth/login', { email: 'ana@t.local', senha: 'NovaSenha123' })).s, 200);
});

test.after(() => app.close());
