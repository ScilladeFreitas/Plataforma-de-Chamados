import { createApp } from './server.js';
import fs from 'node:fs';
import path from 'node:path';
const e = process.env;
const dbPath = e.DB_PATH || './data/os.sqlite';
if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
const { server } = createApp({
  dbPath, storageDir: e.STORAGE_DIR || './data/anexos',
  cookieSecure: e.COOKIE_SECURE === '1', adminEmail: e.ADMIN_EMAIL, adminSenha: e.ADMIN_SENHA,
});
const port = Number(e.PORT) || 3000;
server.listen(port, () => console.log(`API de chamados em http://localhost:${port}`));
