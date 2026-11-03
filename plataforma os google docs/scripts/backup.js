import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
const e = process.env, ts = new Date().toISOString().replace(/[:.]/g, '-'), dir = e.BACKUP_DIR || './backups';
fs.mkdirSync(dir, { recursive: true });
const db = new DatabaseSync(e.DB_PATH || './data/os.sqlite');
db.exec(`VACUUM INTO '${dir}/os-${ts}.sqlite'`); db.close(); // cópia consistente, mesmo com a API em uso
if (fs.existsSync(e.STORAGE_DIR || './data/anexos')) fs.cpSync(e.STORAGE_DIR || './data/anexos', `${dir}/anexos-${ts}`, { recursive: true });
console.log(`Backup gerado em ${dir} (os-${ts}.sqlite + anexos-${ts}/)`);
