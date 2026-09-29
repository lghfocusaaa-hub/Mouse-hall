import http from 'http';
import crypto from 'crypto';

const HOST = 'localhost';
const PORT = 8080;

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

function multipartBody(fields, file) {
  const boundary = '----test' + crypto.randomBytes(8).toString('hex');
  const parts = [];
  for (const k of Object.keys(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${fields[k]}\r\n`));
  }
  if (file) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.mime}\r\n\r\n`));
    parts.push(file.data);
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { boundary, body: Buffer.concat(parts) };
}

async function main() {
  const u1 = 'alice_' + Math.random().toString(36).slice(2, 7);
  const u2 = 'bob_' + Math.random().toString(36).slice(2, 7);
  const pwd = 'pass123456';
  console.log('users:', u1, u2);

  // 注册
  await req('POST', '/api/register', { 'Content-Type': 'application/json' },
    Buffer.from(JSON.stringify({ username: u1, password: pwd })));
  await req('POST', '/api/register', { 'Content-Type': 'application/json' },
    Buffer.from(JSON.stringify({ username: u2, password: pwd })));
  // 登录
  const t1 = await req('POST', '/api/login', { 'Content-Type': 'application/json' },
    Buffer.from(JSON.stringify({ username: u1, password: pwd }))).then(r => JSON.parse(r.body.toString()).token);
  const t2 = await req('POST', '/api/login', { 'Content-Type': 'application/json' },
    Buffer.from(JSON.stringify({ username: u2, password: pwd }))).then(r => JSON.parse(r.body.toString()).token);
  if (!t1 || !t2) { console.error('no tokens'); process.exit(1); }

  // 1) 上传头像 (使用 query token，这是修复点)
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63000100000500010d0a2db40000000049454e44ae426082', 'hex');
  const { boundary, body } = multipartBody({ token: t1 }, { name: 'x.png', mime: 'image/png', data: png });
  const url = '/api/upload-avatar?token=' + encodeURIComponent(t1);
  const up = await req('POST', url, { 'Content-Type': `multipart/form-data; boundary=${boundary}` }, body);
  const upR = JSON.parse(up.body.toString());
  console.log('upload via query token:', up.status, JSON.stringify(upR));
  if (!upR.ok) process.exit(2);

  // 2) 未登录上传：返回明确 code
  const { boundary: b2, body: bd2 } = multipartBody({}, { name: 'x.png', mime: 'image/png', data: png });
  const nope = await req('POST', '/api/upload-avatar', { 'Content-Type': `multipart/form-data; boundary=${b2}` }, bd2);
  const noR = JSON.parse(nope.body.toString());
  console.log('upload no token:', nope.status, JSON.stringify(noR));
  if (noR.code !== 'TOKEN_MISSING') process.exit(3);

  // 3) 使用 WebSocket（直接 TCP，最小握手 + text frame）发送大厅消息、私聊消息给对方（对方未在线，离线+持久化）、保存撤回
  // 这里只测 HTTP 层 + 消息历史持久化是否写文件 chat_history.json：通过给 WS 发消息的 API 不存在，所以通过构造 WS 客户端
  const WS = await import('node:ws');
  // 注意：node:ws 不是 Node 内建，零依赖禁止。手搓。
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(9); });
