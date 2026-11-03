// Dados de DEMONSTRAÇÃO. Tudo é marcado com demo=1 e nomes "[DEMO]". Não use em produção.
import fs from 'node:fs';
import { openDb, seedBase, hashSenha, nextProtocolo } from './db.js';
const e = process.env, file = e.DB_PATH || './data/os.sqlite';
fs.mkdirSync('./data', { recursive: true });
const db = openDb(file); seedBase(db);
if (db.prepare('SELECT 1 FROM usuarios WHERE demo=1').get()) { console.log('Dados de demonstração já existem.'); process.exit(0); }
const run = (s, ...a) => db.prepare(s).run(...a), perfil = t => db.prepare('SELECT id FROM perfis WHERE tipo=?').get(t).id;
const SENHA = 'Demo@12345', h = hashSenha(SENHA);
const user = (nome, email, tipo) => run('INSERT INTO usuarios(nome,email,senha_hash,perfil_id,demo) VALUES(?,?,?,?,1)', nome, email, h, perfil(tipo)).lastInsertRowid;
const adm = user('[DEMO] Administrador', 'admin@demo.local', 'admin'), fun = db.prepare("SELECT id FROM perfis WHERE nome='Funcionário'").get().id;
const tec = run('INSERT INTO usuarios(nome,email,senha_hash,perfil_id,demo) VALUES(?,?,?,?,1)', '[DEMO] Técnico', 'tecnico@demo.local', h, fun).lastInsertRowid;
const u1 = user('[DEMO] Cliente Um', 'cliente1@demo.local', 'cliente'), u2 = user('[DEMO] Cliente Dois', 'cliente2@demo.local', 'cliente');
const cli = (u, n, em) => run('INSERT INTO clientes(usuario_id,nome,email,telefone,demo) VALUES(?,?,?,?,1)', u, n, em, '(21) 90000-0000').lastInsertRowid;
const c1 = cli(u1, '[DEMO] Cliente Um', 'cliente1@demo.local'), c2 = cli(u2, '[DEMO] Cliente Dois', 'cliente2@demo.local');
const cat = n => db.prepare('SELECT id FROM categorias_equipamento WHERE nome=?').get(n).id;
const eq = (c, k, f, m, s) => run('INSERT INTO equipamentos(cliente_id,categoria_id,fabricante,modelo,numero_serie,demo) VALUES(?,?,?,?,?,1)', c, cat(k), f, m, s).lastInsertRowid;
const e1 = eq(c1, 'Notebook', 'Fabricante Exemplo', 'NB-DEMO-1', 'DEMO-SN-001'), e2 = eq(c2, 'Videogame', 'Fabricante Exemplo', 'CONSOLE-DEMO', 'DEMO-SN-002');
const st = t => db.prepare('SELECT id FROM status WHERE tipo=? LIMIT 1').get(t).id, pr = db.prepare("SELECT id FROM prioridades WHERE nome='Normal'").get().id;
const os = (c, e, s, prob) => run('INSERT INTO ordens_servico(protocolo,cliente_id,equipamento_id,status_id,prioridade_id,responsavel_id,aberto_por,problema,demo) VALUES(?,?,?,?,?,?,?,?,1)', nextProtocolo(db), c, e, s, pr, tec, tec, prob).lastInsertRowid;
const o1 = os(c1, e1, db.prepare("SELECT id FROM status WHERE nome='Em manutenção'").get().id, '[DEMO] Notebook não liga.');
run("INSERT INTO atualizacoes(os_id,autor_id,texto,visibilidade) VALUES(?,?,?,'cliente')", o1, tec, '[DEMO] Equipamento em manutenção.');
run("INSERT INTO atualizacoes(os_id,autor_id,texto,visibilidade) VALUES(?,?,?,'interna')", o1, tec, '[DEMO] NOTA INTERNA: placa-mãe suspeita; confirmar custo antes de informar.');
const o2 = os(c2, e2, st('fechado'), '[DEMO] Console sem vídeo.');
run("UPDATE ordens_servico SET diagnostico_final='[DEMO] Cabo HDMI interno solto.',o_que_foi_feito='[DEMO] Reconexão e limpeza.',testes='[DEMO] 2h de jogo sem falhas.',recomendacoes='[DEMO] Evitar mover ligado.',resultado='Resolvido',fechado_em=datetime('now'),fechado_por=? WHERE id=?", tec, o2);
console.log(`Demo criada. Logins (senha ${SENHA}): admin@demo.local, tecnico@demo.local, cliente1@demo.local, cliente2@demo.local`);
