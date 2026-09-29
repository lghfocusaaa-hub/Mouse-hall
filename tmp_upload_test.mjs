import http from 'http';
import fs from 'fs';
import crypto from 'crypto';
import path from 'path';

const HOST = 'localhost';
const PORT = 8080;
const __dirname = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):\//, '$1:/');

function req(method, path, headers, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: HOST, port: PORT, method, path, headers }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function main() {
  // 1. 生成随机账号注册
  const u = 'tu' + Math.random().toString(36).slice(2, 7);
  const p = 'pass123456';
  console.log('test user:', u);

  const r1 = await req('POST', '/api/register', { 'Content-Type': 'application/json' },
    Buffer.from(JSON.stringify({ username: u, password: p })));
  console.log('register', r1.status, r1.body.toString('utf8'));

  const r2 = await req('POST', '/api/login', { 'Content-Type': 'application/json' },
    Buffer.from(JSON.stringify({ username: u, password: p })));
  console.log('login', r2.status, r2.body.toString('utf8'));
  const login = JSON.parse(r2.body.toString('utf8'));
  console.log('login parsed:', JSON.stringify(login));
  const token = login.token || (login.data && login.data.token);
  if (!token) { console.error('no token', login); process.exit(1); }

  // 2. 造 2x2 真 WebP 字节（最小）—— 但服务器 sniff 要求 webp，这里我们直接送 PNG 更方便
  // 1x1 PNG
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63000100000500010d0a2db40000000049454e44ae426082', 'hex');

  // 3. multipart/form-data
  const boundary = '----bound' + crypto.randomBytes(8).toString('hex');
  const fileFieldName = 'file';
  const fileName = 'avatar.png';
  const mime = 'image/png';
  const lines = [];
  lines.push(`--${boundary}\r\nContent-Disposition: form-data; name="token"\r\n\r\n${token}\r\n`);
  lines.push(`--${boundary}\r\nContent-Disposition: form-data; name="${fileFieldName}"; filename="${fileName}"\r\nContent-Type: ${mime}\r\n\r\n`);
  const head = Buffer.from(lines.join(''), 'utf8');
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  const body = Buffer.concat([head, png, tail]);

  const r3 = await req('POST', '/api/upload-avatar', {
    'Content-Type': `multipart/form-data; boundary=${boundary}`,
    'Content-Length': body.length
  }, body);
  console.log('upload-avatar', r3.status, r3.body.toString('utf8'));
  const up = JSON.parse(r3.body.toString('utf8'));
  if (!up.ok) { console.error('upload failed'); process.exit(1); }
  const url = up.url;

  // 4. update-profile 设置 avatarImage
  const r4 = await req('POST', '/api/update-profile', { 'Content-Type': 'application/json' },
    Buffer.from(JSON.stringify({ token, avatarImage: url, avatarEmoji: '', avatarColor: '#ff0000' })));
  console.log('update-profile', r4.status, r4.body.toString('utf8'));

  // 5. /api/me 验证
  const r5 = await req('POST', '/api/me', { 'Content-Type': 'application/json' },
    Buffer.from(JSON.stringify({ token })));
  console.log('me', r5.status, r5.body.toString('utf8'));
  const me = JSON.parse(r5.body.toString('utf8'));
  const meData = me.data || me;
  if (meData.avatarImage !== url) { console.error('avatarImage mismatch', meData.avatarImage, 'vs', url); process.exit(2); }

  // 6. GET 图片本身
  const r6 = await req('GET', url, {}, null);
  console.log('GET avatar', r6.status, 'bytes:', r6.body.length, 'mime:', r6.headers['content-type']);
  if (r6.status !== 200) { console.error('GET avatar fail'); process.exit(3); }
  if (r6.body.length !== png.length) { console.error('GET bytes mismatch', r6.body.length, vs); process.exit(4); }

  console.log('\nALL OK');
}
main().catch(e => { console.error(e); process.exit(9); });
