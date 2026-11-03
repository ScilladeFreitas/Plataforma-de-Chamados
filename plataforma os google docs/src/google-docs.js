import crypto from 'node:crypto';

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

export const googleReady = env => Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REDIRECT_URI && env.GOOGLE_TOKEN_ENCRYPTION_KEY);

function tokenKey(env) {
  if (!env.GOOGLE_TOKEN_ENCRYPTION_KEY) throw new Error('GOOGLE_TOKEN_ENCRYPTION_KEY não configurada');
  return crypto.createHash('sha256').update(env.GOOGLE_TOKEN_ENCRYPTION_KEY).digest();
}

export function encryptGoogleToken(value, env = process.env) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', tokenKey(env), iv);
  const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map(x => x.toString('base64url')).join('.');
}

function decryptGoogleToken(value, env = process.env) {
  const [iv, tag, body] = value.split('.').map(x => Buffer.from(x, 'base64url'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', tokenKey(env), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

export function authorizationUrl({ env = process.env, state }) {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: env.GOOGLE_REDIRECT_URI,
    response_type: 'code',
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    scope: DRIVE_SCOPE,
    state,
  }).toString();
  return url.toString();
}

async function tokenRequest(form) {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error_description || data.error || 'Falha ao autorizar a conta Google');
  return data;
}

export async function exchangeCode(code, env = process.env) {
  return tokenRequest(new URLSearchParams({
    code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
    redirect_uri: env.GOOGLE_REDIRECT_URI, grant_type: 'authorization_code',
  }));
}

async function accessToken(db, env = process.env) {
  const row = db.prepare('SELECT refresh_token_cifrado FROM google_integracao WHERE id=1').get();
  if (!row) throw new Error('A conta Google ainda não foi conectada');
  const refresh_token = decryptGoogleToken(row.refresh_token_cifrado, env);
  const tokens = await tokenRequest(new URLSearchParams({
    refresh_token, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
    grant_type: 'refresh_token',
  }));
  return tokens.access_token;
}

async function googleJson(url, token, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || `Google API retornou HTTP ${response.status}`);
  return data;
}

export async function createGoogleDocument(db, { title, text, env = process.env }) {
  const token = await accessToken(db, env);
  const folderId = await ensureFolder(db, token);
  const meta = { name: title, mimeType: 'application/vnd.google-apps.document', parents: [folderId] };
  const file = await googleJson('https://www.googleapis.com/drive/v3/files?fields=id,webViewLink', token, {
    method: 'POST', body: JSON.stringify(meta),
  });
  await googleJson(`https://docs.googleapis.com/v1/documents/${encodeURIComponent(file.id)}:batchUpdate`, token, {
    method: 'POST', body: JSON.stringify({ requests: [{ insertText: { location: { index: 1 }, text } }] }),
  });
  return { id: file.id, url: file.webViewLink || `https://docs.google.com/document/d/${file.id}/edit` };
}

export async function appendGoogleDocument(db, documentId, text, env = process.env) {
  const token = await accessToken(db, env);
  const doc = await googleJson(`https://docs.googleapis.com/v1/documents/${encodeURIComponent(documentId)}`, token);
  const content = doc.body?.content || [];
  const endIndex = content.at(-1)?.endIndex || 1;
  const index = Math.max(1, endIndex - 1);
  await googleJson(`https://docs.googleapis.com/v1/documents/${encodeURIComponent(documentId)}:batchUpdate`, token, {
    method: 'POST', body: JSON.stringify({ requests: [{ insertText: { location: { index }, text: `\n${text}` } }] }),
  });
}

async function ensureFolder(db, token) {
  const existing = db.prepare('SELECT drive_folder_id FROM google_integracao WHERE id=1').get()?.drive_folder_id;
  if (existing) return existing;
  const folder = await googleJson('https://www.googleapis.com/drive/v3/files?fields=id', token, {
    method: 'POST', body: JSON.stringify({ name: 'Ordens de Serviço', mimeType: 'application/vnd.google-apps.folder' }),
  });
  db.prepare("UPDATE google_integracao SET drive_folder_id=?,atualizado_em=datetime('now') WHERE id=1").run(folder.id);
  return folder.id;
}
