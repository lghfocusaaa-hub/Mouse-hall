// 鼠标大厅 - 零依赖 WebSocket 服务器（Node.js 内置 http + crypto 实现 RFC6455）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.DEPLOY_RUN_PORT || process.env.PORT || 8080;

/* ---------- 静态文件托管 ---------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

/* =================== 账号系统（零依赖） =================== */
const ACCOUNTS_FILE = path.join(__dirname, 'accounts.json');
const HISTORY_FILE = path.join(__dirname, 'chat_history.json');
const AVATAR_DIR = path.join(__dirname, 'uploads', 'avatars');
const AVATAR_URL_PREFIX = '/uploads/avatars/';
const MAX_BODY = 2 * 1024 * 1024;   // 上传总大小限制：2MB
const MAX_AVATARS_PER_USER = 5;
const HALL_HISTORY_LIMIT = 200;      // 大厅只保留最近 N 条
const PRIVATE_HISTORY_LIMIT_PER_PAIR = 500; // 每对私聊保留 N 条
const HISTORY_WELCOME_LIMIT = 50;    // 每人 welcome 时下发最近 N 条大厅/私聊
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天
const PBKDF2_ITER = 120000;
const PBKDF2_DK = 32;
const PBKDF2_ALGO = 'sha256';
const MAX_ACCOUNTS_PER_IP = 3; // 单个 IP 最多注册 3 个账号
const CAPTCHA_TTL_MS = 5 * 60 * 1000; // 验证码 5 分钟有效
const CAPTCHA_LEN = 4;
const CAPTCHA_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去除易混淆 0/O/1/I/l

/** 取客户端真实 IP：优先 x-forwarded-for（代理/反代场景），回退 socket 直连地址 */
function clientIp(req) {
  const xff = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  if (xff) return xff;
  return (req.socket && req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

try { fs.mkdirSync(AVATAR_DIR, { recursive: true }); } catch { }

/** 账号数据：{ username: { salt:hex, hash:hex, createdAt:ms } } */
let accounts = loadAccounts();
/** 历史消息：{ hall: [...msgNodes], offline: { user: [...msgNodes] } private: { "a||b": [...msgNodes] } } */
let history = loadHistory();
/** 会话：token -> { username, expiresAt } */
const sessions = new Map();

/* ---------- 管理员 ---------- */
const ADMIN_PASSWORD = 'vessel2024';
const adminSessions = new Set(); // ctx.id 集合：已认证管理员连接

// 历史 from 字段归一化：把老数据 from( username ) 转为账号 uid，使历史不再随改名漂移
(function normalizeHistoryUids() {
  const u2u = {}; for (const u of Object.keys(accounts)) { const a = accounts[u]; if (a && a.uid) u2u[u] = a.uid; }
  let changed = false;
  const fix = m => {
    if (m && typeof m.from === 'string' && u2u[m.from]) { m.from = u2u[m.from]; changed = true; }
  };
  if (Array.isArray(history.hall)) history.hall.forEach(fix);
  if (history.private && typeof history.private === 'object') {
    for (const k of Object.keys(history.private)) (history.private[k] || []).forEach(fix);
  }
  if (history.offline && typeof history.offline === 'object') {
    for (const u of Object.keys(history.offline)) (history.offline[u] || []).forEach(fix);
  }
  if (changed) { try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(history), 'utf8'); } catch { } }
})();

function loadHistory() {
  const empty = { hall: [], offline: {}, private: {} };
  try {
    if (!fs.existsSync(HISTORY_FILE)) return empty;
    const raw = fs.readFileSync(HISTORY_FILE, 'utf8');
    const obj = JSON.parse(raw || '{}');
    if (!obj || typeof obj !== 'object') return empty;
    if (!Array.isArray(obj.hall)) obj.hall = [];
    if (!obj.private || typeof obj.private !== 'object') obj.private = {};
    if (!obj.offline || typeof obj.offline !== 'object') obj.offline = {};
    // 兼容：老版本 offline 是单独文件；迁移时忽略即可（空的不影响）
    return obj;
  } catch { return empty; }
}
let saveHistoryTimer = null;
function scheduleSaveHistory() {
  if (saveHistoryTimer) return;
  saveHistoryTimer = setTimeout(() => {
    saveHistoryTimer = null;
    try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(history), 'utf8'); } catch { }
  }, 200);
}
function privateKey(a, b) {
  const x = (a || '') + '', y = (b || '') + '';
  return x < y ? (x + '||' + y) : (y + '||' + x);
}
function pushHallMsg(msg) {
  history.hall.push(msg);
  if (history.hall.length > HALL_HISTORY_LIMIT) {
    history.hall.splice(0, history.hall.length - HALL_HISTORY_LIMIT);
  }
  scheduleSaveHistory();
}
function pushPrivateMsg(a, b, msg) {
  const k = privateKey(a, b);
  const arr = history.private[k] = history.private[k] || [];
  arr.push(msg);
  if (arr.length > PRIVATE_HISTORY_LIMIT_PER_PAIR) {
    arr.splice(0, arr.length - PRIVATE_HISTORY_LIMIT_PER_PAIR);
  }
  scheduleSaveHistory();
}

function loadAccounts() {
  try {
    if (fs.existsSync(ACCOUNTS_FILE)) {
      const raw = fs.readFileSync(ACCOUNTS_FILE, 'utf8');
      const obj = JSON.parse(raw || '{}');
      if (obj && typeof obj === 'object') {
        // 字段兼容升级：老账号补 avatarEmoji / avatarColor 字段（保留 null 前端用默认）
        let dirty = false;
        for (const u of Object.keys(obj)) {
          const a = obj[u]; if (!a) continue;
          if (a.avatarEmoji === undefined) a.avatarEmoji = null;
          if (a.avatarColor === undefined) a.avatarColor = null;
          if (a.avatarImage === undefined) a.avatarImage = null; // 上传本地图：'/uploads/avatars/xxx.webp'
          if (!a.friends || !Array.isArray(a.friends)) a.friends = []; // 好友：username 数组（发消息自动加）
          if (a.regIp === undefined) a.regIp = null; // 注册来源 IP（老账号未知，不参与限制）
          if (a.mutedUntil === undefined) a.mutedUntil = 0; // 禁言到期时间戳（0 = 未禁言）
          if (a.muteCount === undefined) a.muteCount = 0;   // 累计违禁次数（用于升级阶梯）
          if (a.lastMuteAt === undefined) a.lastMuteAt = 0; // 最近一次触发禁言的时间（用于衰减清零）
          if (!a.uid) { a.uid = 'u' + (crypto.randomUUID ? crypto.randomUUID().split('-').join('').slice(0, 12) : (Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4))); dirty = true; }
        }
        if (dirty) { try { fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(obj, null, 2), 'utf8'); } catch { } }
        return obj;
      }
    }
  } catch { }
  return {};
}

function saveAccounts() {
  try {
    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

async function hashPwd(password, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(password, s, PBKDF2_ITER, PBKDF2_DK, PBKDF2_ALGO, (err, key) => {
      if (err) reject(err);
      else resolve({ salt: s, hash: key.toString('hex') });
    });
  });
}

function validUsername(u) {
  return /^[\w\u4e00-\u9fff]{2,16}$/.test(u); // 2-16 位：字母/数字/中文/下划线
}
function validPassword(p) {
  return typeof p === 'string' && p.length >= 6 && p.length <= 64;
}
function getQuery(url, key) {
  try {
    const q = (url || '').split('?')[1] || '';
    const pairs = q.split('&');
    for (const p of pairs) {
      const i = p.indexOf('=');
      const k = i < 0 ? p : p.slice(0, i);
      if (k === key) return decodeURIComponent(i < 0 ? '' : p.slice(i + 1));
    }
  } catch { }
  return '';
}
function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    // 注意：不能对整个 content-type 做 toLowerCase()，否则会把大小写敏感的 boundary token
    // 也一起小写化，导致 multipart 解析器匹配不到真实分隔符、上传文件丢失。
    const ctype = req.headers['content-type'] || '';
    const isMultipart = ctype.toLowerCase().startsWith('multipart/form-data');
    const limit = isMultipart ? MAX_BODY : (64 * 1024);
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { req.destroy(); resolve(null); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      if (isMultipart) {
        // 手工解析 multipart/form-data：返回 { fieldName: value, __fileData: Buffer, __fileName, __fileMime }
        const parsed = parseMultipart(raw, ctype);
        if (!parsed) resolve(null); else resolve(parsed);
        return;
      }
      try { resolve(JSON.parse(raw.toString('utf8') || '{}')); }
      catch { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}
function parseMultipart(buf, ctype) {
  // 找 boundary
  const m = /boundary=([^;,\s]+)/i.exec(ctype);
  if (!m) return null;
  const boundary = Buffer.from('--' + m[1]);
  const crlf = Buffer.from('\r\n');
  const result = {};
  let i = 0;
  while (i + boundary.length <= buf.length) {
    // 查找下一个 boundary
    const idx = indexOfBuffer(buf, boundary, i);
    if (idx < 0) break;
    i = idx + boundary.length;
    // 结尾 --
    if (i + 2 <= buf.length && buf[i] === 0x2d && buf[i + 1] === 0x2d) break;
    // 跳过 \r\n
    if (i + 2 <= buf.length && buf[i] === 0x0d && buf[i + 1] === 0x0a) i += 2;
    // headers：直到遇到空行 \r\n\r\n
    const endHeader = indexOfBuffer(buf, Buffer.from('\r\n\r\n'), i);
    if (endHeader < 0) break;
    const headersRaw = buf.toString('utf8', i, endHeader);
    const bodyStart = endHeader + 4;
    // headers parse
    const nameMatch = /name="([^"]*)"/i.exec(headersRaw);
    const filenameMatch = /filename="([^"]*)"/i.exec(headersRaw);
    const contentTypeMatch = /Content-Type:\s*([^;\r\n]+)/i.exec(headersRaw);
    // 找下一个 boundary 作为 body 结束
    const nextIdx = indexOfBuffer(buf, boundary, bodyStart);
    if (nextIdx < 0) break;
    let bodyEnd = nextIdx;
    // 去掉 body 结尾的 \r\n（标准 multipart），两个分支必须互斥：
    // 否则删完 \r\n 后第二个判断会继续误删图片内容的最后一个字节（当其恰为 0x0A 时），导致上传的图片损坏
    if (bodyEnd - 2 >= bodyStart && buf[bodyEnd - 2] === 0x0d && buf[bodyEnd - 1] === 0x0a) bodyEnd -= 2;
    // 单独的 \n（部分非标准客户端）
    else if (bodyEnd - 1 >= bodyStart && buf[bodyEnd - 1] === 0x0a) bodyEnd -= 1;
    const body = buf.subarray(bodyStart, bodyEnd);
    i = nextIdx;
    if (!nameMatch) continue;
    const fieldName = nameMatch[1];
    if (filenameMatch) {
      result.__fileName = filenameMatch[1];
      result.__fileMime = contentTypeMatch ? contentTypeMatch[1].trim() : '';
      result.__fileData = Buffer.from(body);
      // 若还带 name 字段，也保留：约定 file input 的字段名永远是 'file'
      result[fieldName] = true;
    } else {
      result[fieldName] = body.toString('utf8');
    }
  }
  return result;
}
function indexOfBuffer(hay, needle, from) {
  const hlen = hay.length, nlen = needle.length;
  if (nlen === 0) return from || 0;
  outer: for (let i = from || 0; i + nlen <= hlen; i++) {
    for (let j = 0; j < nlen; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}
function issueToken(username) {
  const token = crypto.randomBytes(24).toString('hex');
  const expiresAt = Date.now() + SESSION_TTL_MS;
  sessions.set(token, { username, expiresAt });
  return { token, expiresAt };
}
function checkToken(token) {
  if (!token || typeof token !== 'string') return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (s.expiresAt <= Date.now()) { sessions.delete(token); return null; }
  // 续命：剩余 <50% 时延长
  if (s.expiresAt - Date.now() < SESSION_TTL_MS / 2) s.expiresAt = Date.now() + SESSION_TTL_MS;
  return s.username;
}

/* =================== 人机验证码（SVG，零依赖） =================== */
/** 验证码：cid -> { answer, expiresAt } */
const captchas = new Map();
function genCaptchaId() {
  return (crypto.randomUUID ? crypto.randomUUID() : (Math.random().toString(36).slice(2) + Date.now().toString(36)));
}
function genCaptchaText() {
  let s = '';
  for (let i = 0; i < CAPTCHA_LEN; i++) s += CAPTCHA_CHARS[Math.floor(Math.random() * CAPTCHA_CHARS.length)];
  return s;
}
function cleanupCaptchas() {
  const now = Date.now();
  for (const [k, c] of captchas) if (c.expiresAt <= now) captchas.delete(k);
}
/** 用 SVG 字符串渲染验证码：字符随机旋转/偏移/颜色 + 干扰线 + 噪点 */
function renderCaptchaSvg(text) {
  const W = 120, H = 40;
  const parts = [];
  parts.push(`<rect width="${W}" height="${H}" fill="#f3eee5"/>`);
  // 干扰线
  for (let i = 0; i < 4; i++) {
    const x1 = Math.random() * W, y1 = Math.random() * H;
    const x2 = Math.random() * W, y2 = Math.random() * H;
    parts.push(`<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="hsl(${Math.floor(Math.random() * 360)},60%,72%)" stroke-width="1"/>`);
  }
  // 噪点
  for (let i = 0; i < 30; i++) {
    parts.push(`<circle cx="${(Math.random() * W).toFixed(1)}" cy="${(Math.random() * H).toFixed(1)}" r="0.8" fill="#9a8f80"/>`);
  }
  // 字符
  const step = (W - 24) / text.length;
  for (let i = 0; i < text.length; i++) {
    const x = 14 + i * step + (Math.random() * 6 - 3);
    const y = H / 2 + 6 + (Math.random() * 6 - 3);
    const rot = Math.floor(Math.random() * 50 - 25);
    parts.push(`<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-family="Verdana, Arial, sans-serif" font-size="22" font-weight="bold" fill="hsl(${Math.floor(Math.random() * 360)},65%,42%)" transform="rotate(${rot} ${x.toFixed(1)} ${y.toFixed(1)})">${text[i]}</text>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${parts.join('')}</svg>`;
}

/* =================== HTTP 服务器（API + 静态文件） =================== */
const server = http.createServer(async (req, res) => {
  const urlPath = (req.url || '/').split('?')[0];

  // --- API 路由 ---
  if (urlPath.startsWith('/api/')) {
    const body = (req.method === 'POST') ? await readBody(req) : {};
    if (body === null) { json(res, 400, { ok: false, msg: '请求体格式错误' }); return; }
    switch (urlPath) {
      case '/api/register': {
        const username = (body?.username || '').trim();
        const password = body?.password || '';
        if (!validUsername(username)) { json(res, 400, { ok: false, msg: '用户名需 2-16 位（字母/数字/中文/下划线）' }); return; }
        if (!validPassword(password)) { json(res, 400, { ok: false, msg: '密码需 6-64 位' }); return; }
        // 人机验证：校验验证码（一次性，错误即失效）
        const cid = (body?.captchaId || '') + '';
        const code = ((body?.captchaCode || '') + '').trim().toUpperCase();
        const cap = captchas.get(cid);
        if (!cap || cap.expiresAt <= Date.now()) { json(res, 403, { ok: false, msg: '验证码已失效，请刷新后重试' }); return; }
        if (cap.answer.toUpperCase() !== code) { captchas.delete(cid); json(res, 403, { ok: false, msg: '验证码错误' }); return; }
        captchas.delete(cid); // 校验通过即消费，防止复用
        if (accounts[username]) { json(res, 409, { ok: false, msg: '用户名已存在' }); return; }
        // 同一 IP 最多注册 MAX_ACCOUNTS_PER_IP 个账号
        const ip = clientIp(req);
        if (ip) {
          let cnt = 0;
          for (const u of Object.keys(accounts)) {
            const a = accounts[u]; if (a && a.regIp === ip) cnt++;
          }
          if (cnt >= MAX_ACCOUNTS_PER_IP) {
            json(res, 403, { ok: false, msg: `该网络已注册 ${MAX_ACCOUNTS_PER_IP} 个账号，达到上限` });
            return;
          }
        }
        const { salt, hash } = await hashPwd(password);
        accounts[username] = { salt, hash, createdAt: Date.now(), avatarEmoji: null, avatarColor: null, friends: [], regIp: ip || null, uid: 'u' + (crypto.randomUUID ? crypto.randomUUID().split('-').join('').slice(0, 12) : (Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4))) };
        saveAccounts();
        const { token } = issueToken(username);
        json(res, 200, { ok: true, username, token });
        return;
      }
      case '/api/login': {
        const username = (body?.username || '').trim();
        const password = body?.password || '';
        if (!username || !password) { json(res, 400, { ok: false, msg: '请填写用户名和密码' }); return; }
        const a = accounts[username];
        if (!a) { json(res, 401, { ok: false, msg: '用户名或密码错误' }); return; }
        const { hash } = await hashPwd(password, a.salt);
        if (hash !== a.hash) { json(res, 401, { ok: false, msg: '用户名或密码错误' }); return; }
        const { token } = issueToken(username);
        json(res, 200, { ok: true, username, token });
        return;
      }
      case '/api/logout': {
        const tok = body?.token;
        if (tok && typeof tok === 'string') sessions.delete(tok);
        json(res, 200, { ok: true });
        return;
      }
      case '/api/me': {
        const u = checkToken(body?.token);
        if (!u) { json(res, 401, { ok: false, msg: '未登录' }); return; }
        const a = accounts[u] || {};
        json(res, 200, {
          ok: true, username: u,
          avatarEmoji: a.avatarEmoji || null,
          avatarColor: a.avatarColor || null,
          avatarImage: a.avatarImage || null,
          friends: a.friends || []
        });
        return;
      }
      case '/api/upload-avatar': {
        // 需要 content-type: multipart/form-data，token 支持 query（URL ?token=）或表单 field token；query 优先
        const tokStr = getQuery(req.url, 'token') || (body?.token || '') + '';
        let u = null;
        if (!tokStr) { json(res, 401, { ok: false, code: 'TOKEN_MISSING', msg: '未登录（缺少登录凭证）' }); return; }
        u = checkToken(tokStr);
        if (!u) { json(res, 401, { ok: false, code: 'TOKEN_INVALID', msg: '未登录（登录凭证已过期，请重新登录）' }); return; }
        if (!body?.__fileData || !body.__fileName) { json(res, 400, { ok: false, msg: '缺少上传文件' }); return; }
        const buf = body.__fileData;
        if (!(buf instanceof Buffer)) { json(res, 500, { ok: false, msg: '文件读取失败' }); return; }
        // 类型校验：仅接受 image/jpeg / image/png / image/webp（通过 magic bytes）
        const mime = sniffImage(buf);
        if (!mime) { json(res, 400, { ok: false, msg: '只支持 JPG / PNG / WebP 图片' }); return; }
        const ext = mime === 'image/jpeg' ? '.jpg' : (mime === 'image/webp' ? '.webp' : '.png');
        const name = crypto.randomBytes(12).toString('hex') + ext;
        const filePath = path.join(AVATAR_DIR, name);
        try { fs.writeFileSync(filePath, buf); } catch (e) { json(res, 500, { ok: false, msg: '写入失败：' + (e && e.message || '') }); return; }
        // 清理旧头像：最多保留 MAX_AVATARS_PER_USER 个，超出的删除文件
        const a = accounts[u]; if (!a) { json(res, 401, { ok: false, msg: '账号不存在' }); return; }
        if (!a._avatarHistory || !Array.isArray(a._avatarHistory)) a._avatarHistory = [];
        a._avatarHistory.push(name);
        while (a._avatarHistory.length > MAX_AVATARS_PER_USER) {
          const oldName = a._avatarHistory.shift();
          const oldPath = path.join(AVATAR_DIR, oldName);
          try { if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath); } catch { }
        }
        saveAccounts();
        json(res, 200, { ok: true, url: AVATAR_URL_PREFIX + name, mime });
        return;
      }
      case '/api/update-profile': {
        const u = checkToken(body?.token);
        if (!u) { json(res, 401, { ok: false, msg: '未登录' }); return; }
        const a = accounts[u];
        if (!a) { json(res, 401, { ok: false, msg: '账号不存在' }); return; }
        // 头像：1-4 个字符（emoji），允许 '' 清掉存 null
        if (body?.avatarEmoji !== undefined) {
          const s = (body.avatarEmoji == null ? '' : body.avatarEmoji) + '';
          if (s.length > 4) { json(res, 400, { ok: false, msg: '头像 emoji 过长' }); return; }
          a.avatarEmoji = s || null;
        }
        if (body?.avatarColor !== undefined) {
          const s = (body.avatarColor == null ? '' : body.avatarColor) + '';
          if (s && !/^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/.test(s)) {
            json(res, 400, { ok: false, msg: '颜色格式应为 #RRGGBB 或 #RGB' }); return;
          }
          a.avatarColor = s || null;
        }
        if (body?.avatarImage !== undefined) {
          // avatarImage：要么 null（清除），要么必须以 AVATAR_URL_PREFIX 开头，防止路径穿越和外链
          const v = (body.avatarImage == null ? '' : body.avatarImage) + '';
          if (v && !v.startsWith(AVATAR_URL_PREFIX)) { json(res, 400, { ok: false, msg: '非法的头像路径' }); return; }
          a.avatarImage = v || null;
        }
        saveAccounts();
        // 在线则广播改名（其实是改头像）
        for (const [rid, rctx] of roster) {
          if (rctx.username === u) {
            rctx.avatarEmoji = a.avatarEmoji;
            rctx.avatarColor = a.avatarColor || rctx.color;
            rctx.avatarImage = a.avatarImage || null;
            broadcast({ type: 'profile-update', id: rid, name: u, color: rctx.avatarColor, avatarEmoji: a.avatarEmoji, avatarImage: a.avatarImage });
          }
        }
        json(res, 200, { ok: true, avatarEmoji: a.avatarEmoji, avatarColor: a.avatarColor, avatarImage: a.avatarImage });
        return;
      }
      case '/api/change-username': {
        const u = checkToken(body?.token);
        if (!u) { json(res, 401, { ok: false, msg: '未登录' }); return; }
        const newName = ((body?.newUsername || '') + '').trim();
        const password = body?.password || '';
        if (!validUsername(newName)) { json(res, 400, { ok: false, msg: '新用户名需 2-16 位（字母/数字/中文/下划线）' }); return; }
        if (newName === u) { json(res, 200, { ok: true }); return; }
        if (accounts[newName]) { json(res, 409, { ok: false, msg: '新用户名已被占用' }); return; }
        const a = accounts[u]; if (!a) { json(res, 401, { ok: false, msg: '账号不存在' }); return; }
        const { hash } = await hashPwd(password, a.salt);
        if (hash !== a.hash) { json(res, 401, { ok: false, msg: '密码错误' }); return; }
        // 迁移 accounts 条目
        accounts[newName] = a; delete accounts[u];
        // 同步更新其他账号的 friends 里的旧用户名（避免改名掉好友）
        for (const otherU of Object.keys(accounts)) {
          const oa = accounts[otherU]; if (!oa) continue;
          if (oa.friends && Array.isArray(oa.friends)) {
            const idx = oa.friends.indexOf(u);
            if (idx >= 0) { oa.friends[idx] = newName; }
          }
        }
        // 同步更新私聊历史里的对称 key（消息 from 已是 uid，无需逐条改；仅会话 key 仍按 username）
        if (history && history.private && typeof history.private === 'object') {
          const newKeys = {};
          for (const k of Object.keys(history.private)) {
            const [pa, pb] = k.split('||');
            if (pa === u || pb === u) {
              const na = pa === u ? newName : pa;
              const nb = pb === u ? newName : pb;
              const nk = na < nb ? (na + '||' + nb) : (nb + '||' + na);
              // 合并
              if (!newKeys[nk]) newKeys[nk] = history.private[k];
              else newKeys[nk] = (newKeys[nk] || []).concat(history.private[k] || []);
            } else {
              if (!newKeys[k]) newKeys[k] = history.private[k];
              else newKeys[k] = (newKeys[k] || []).concat(history.private[k] || []);
            }
          }
          history.private = newKeys;
          scheduleSaveHistory();
        }
        // 注：消息 from 已是 uid（稳定），不再需要逐条重写大厅/私聊历史里的 from
        saveAccounts();
        // 刷新所有当前会话
        for (const [tok, s] of sessions) if (s.username === u) s.username = newName;
        // 同步迁移防刷屏瞬时窗口，防止改名规避即将到来的触发
        if (spamTracker.has(u)) { spamTracker.set(newName, spamTracker.get(u)); spamTracker.delete(u); }
        // 在线用户：改名并广播 rename
        let foundCtxId = null;
        for (const [rid, rctx] of roster) {
          if (rctx.username === u) {
            rctx.username = newName; rctx.name = newName; foundCtxId = rid;
          }
        }
        if (foundCtxId) broadcast({ type: 'rename', id: foundCtxId, uid: (accounts[newName]?.uid) || null, oldName: u, newName });
        json(res, 200, { ok: true, username: newName });
        return;
      }
      case '/api/changepwd': {
        const u = checkToken(body?.token);
        if (!u) { json(res, 401, { ok: false, msg: '未登录' }); return; }
        const oldPwd = body?.oldPassword || '';
        const newPwd = body?.newPassword || '';
        if (!validPassword(newPwd)) { json(res, 400, { ok: false, msg: '新密码需 6-64 位' }); return; }
        const a = accounts[u];
        if (!a) { json(res, 401, { ok: false, msg: '账号不存在' }); return; }
        const { hash: oldHash } = await hashPwd(oldPwd, a.salt);
        if (oldHash !== a.hash) { json(res, 401, { ok: false, msg: '原密码错误' }); return; }
        const { salt, hash } = await hashPwd(newPwd);
        a.salt = salt; a.hash = hash;
        saveAccounts();
        json(res, 200, { ok: true });
        return;
      }
      case '/api/friends/remove': {
        const u = checkToken(body?.token);
        if (!u) { json(res, 401, { ok: false, msg: '未登录' }); return; }
        const who = ((body?.username || '') + '').trim();
        const a = accounts[u]; const ta = accounts[who];
        if (!a) { json(res, 401, { ok: false, msg: '账号不存在' }); return; }
        a.friends = (a.friends || []).filter(x => x !== who);
        if (ta) { ta.friends = (ta.friends || []).filter(x => x !== u); }
        saveAccounts();
        for (const [rid, rctx] of roster) {
          if (rctx.username === who) sendTo(rctx, { type: 'friend-removed', username: u });
        }
        json(res, 200, { ok: true });
        return;
      }
      case '/api/friends/list': {
        const u = checkToken(body?.token);
        if (!u) { json(res, 401, { ok: false, msg: '未登录' }); return; }
        const a = accounts[u]; if (!a) { json(res, 401, { ok: false, msg: '账号不存在' }); return; }
        const friends = [];
        for (const fu of a.friends || []) {
          const fa = accounts[fu];
          if (!fa) continue;
          // 是否在线
          let online = false; let onlineId = null;
          for (const [rid, rctx] of roster) if (rctx.username === fu) { online = true; onlineId = rid; break; }
          friends.push({ username: fu, online, onlineId, avatarEmoji: fa.avatarEmoji || null, avatarColor: fa.avatarColor || null, avatarImage: fa.avatarImage || null });
        }
        json(res, 200, { ok: true, friends });
        return;
      }
      case '/api/captcha/new': {
        cleanupCaptchas();
        const cid = genCaptchaId();
        const answer = genCaptchaText();
        captchas.set(cid, { answer, expiresAt: Date.now() + CAPTCHA_TTL_MS });
        json(res, 200, { ok: true, cid });
        return;
      }
      case '/api/captcha/image': {
        const cid = (getQuery(req.url, 'cid') || '') + '';
        const c = captchas.get(cid);
        const hdr = { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' };
        if (!c || c.expiresAt <= Date.now()) {
          res.writeHead(404, hdr);
          res.end('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><text x="8" y="26" font-size="14" fill="#bbb">已失效，请刷新</text></svg>');
          return;
        }
        res.writeHead(200, hdr);
        res.end(renderCaptchaSvg(c.answer));
        return;
      }
      default:
        json(res, 404, { ok: false, msg: '未知接口' });
        return;
    }
  }

  // --- 静态文件托管 ---
  if (urlPath.includes('..')) { res.writeHead(400); res.end('Bad request'); return; }
  const serve = (urlPath === '/') ? '/index.html' : urlPath;
  // /uploads/avatars/xxx 特殊路由
  let filePath;
  if (urlPath.startsWith(AVATAR_URL_PREFIX)) {
    const fileName = path.basename(urlPath.slice(AVATAR_URL_PREFIX.length - 1)); // 保含 /
    filePath = path.join(AVATAR_DIR, fileName);
  } else {
    filePath = path.join(__dirname, serve);
  }
  // 防穿越：真实路径仍然必须在 __dirname 或 AVATAR_DIR 内
  const abs = fs.realpathSync && fs.realpathSync.native ? null : null;
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('404 Not Found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    // 安全头：头像禁止作为 script/style 解析
    const extra = {};
    if (urlPath.startsWith(AVATAR_URL_PREFIX)) extra['X-Content-Type-Options'] = 'nosniff';
    res.writeHead(200, Object.assign({ 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': urlPath.startsWith(AVATAR_URL_PREFIX) ? 'public, max-age=31536000, immutable' : 'no-cache' }, extra));
    res.end(data);
  });
});

/* ---------- 最小 WebSocket 协议实现 ---------- */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// 解析一帧，返回 { fin, opcode, payload, frameEnd } 或 null（数据不足）
function parseFrame(buf) {
  if (buf.length < 2) return null;
  const b0 = buf[0], b1 = buf[1];
  const fin = (b0 & 0x80) !== 0;
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let len = b1 & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }
  let mask = null;
  if (masked) {
    if (buf.length < offset + 4) return null;
    mask = buf.subarray(offset, offset + 4);
    offset += 4;
  }
  if (buf.length < offset + len) return null;
  let payload = buf.subarray(offset, offset + len);
  if (masked) {
    const u = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) u[i] = payload[i] ^ mask[i % 4];
    payload = u;
  }
  return { fin, opcode, payload, frameEnd: offset + len };
}

// 构造文本帧（服务端发送，不 mask）
function textFrame(str) {
  const data = Buffer.from(str, 'utf8');
  const len = data.length;
  let header;
  if (len < 126) { header = Buffer.alloc(2); header[1] = len; }
  else if (len < 65536) { header = Buffer.alloc(4); header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  header[0] = 0x81; // FIN + text
  return Buffer.concat([header, data]);
}

function closeFrame(code = 1000) {
  const data = Buffer.alloc(2);
  data.writeUInt16BE(code, 0);
  const header = Buffer.alloc(2);
  header[0] = 0x88; header[1] = 2;
  return Buffer.concat([header, data]);
}

/* ---------- 防刷屏 / 禁言（累犯升级 + 账号持久化） ---------- */
const SPAM_WINDOW_MS = 5 * 1000;           // 5 秒窗口
const SPAM_THRESHOLD = 10;               // 窗口内连发 N 条触发
const MUTE_LADDER_SEC = [60, 300, 1800, 7200, 21600]; // 累犯升级：1分 → 5分 → 30分 → 2时 → 6时
const MUTE_DECAY_MS = 24 * 60 * 60 * 1000; // 24h 内不再触发则累计次数清零
const spamTracker = new Map();           // username -> { times: number[] }（瞬时窗口，仅内存）

function muteDurationSec(count) {
  const idx = Math.max(0, Math.min(count - 1, MUTE_LADDER_SEC.length - 1));
  return MUTE_LADDER_SEC[idx];
}

/**
 * 返回 { muted, triggered?, remaining?, offense? }
 * - mute 状态持久化在账号记录上：改名 / 重启均不丢
 * - 累犯升级：第 1 次 1 分钟，第 2 次 5 分钟…逐级加重
 * - 24h 不再触发则清零累计，避免偶发爆发永久记仇
 */
function checkSpam(username) {
  if (!username) return { muted: false };
  let st = spamTracker.get(username);
  if (!st) { st = { times: [] }; spamTracker.set(username, st); }
  const acc = accounts[username];
  const now = Date.now();

  if (acc) {
    if (acc.muteCount === undefined) acc.muteCount = 0;
    if (acc.mutedUntil === undefined) acc.mutedUntil = 0;
    if (acc.lastMuteAt === undefined) acc.lastMuteAt = 0;
    // 累计衰减：距上次触发超过 24h，清零
    if (acc.muteCount > 0 && acc.lastMuteAt && (now - acc.lastMuteAt > MUTE_DECAY_MS)) {
      acc.muteCount = 0;
    }
    // 正在禁言
    if (acc.mutedUntil > now) {
      return { muted: true, remaining: Math.ceil((acc.mutedUntil - now) / 1000) };
    }
  }

  // 清理窗口外时间戳
  const cutoff = now - SPAM_WINDOW_MS;
  st.times = st.times.filter(t => t > cutoff);
  // 达到阈值 → 触发禁言（累犯升级）
  if (st.times.length >= SPAM_THRESHOLD - 1) {
    st.times = [];
    if (acc) {
      acc.muteCount = (acc.muteCount || 0) + 1;
      acc.lastMuteAt = now;
      const dur = muteDurationSec(acc.muteCount);
      acc.mutedUntil = now + dur * 1000;
      saveAccounts();
      return { muted: true, triggered: true, remaining: dur, offense: acc.muteCount };
    }
    // 无账号兜底（理论不会发生）：用首档时长
    return { muted: true, triggered: true, remaining: MUTE_LADDER_SEC[0], offense: 1 };
  }
  st.times.push(now);
  return { muted: false };
}

/* ---------- 连接管理 ----------*/
const PALETTE = ['#7BBEEB', '#F4A6B8', '#8FD3A8', '#F2C879', '#B89BD9', '#7EC8C8', '#E09A9A', '#9DB4E0', '#C9A582', '#A8C98E', '#E6B7D6', '#8FB9D8'];
let colorIdx = 0;

const roster = new Map();    // id -> ctx（已 join 的用户）
const contexts = new Map();  // socket -> ctx（所有握手后的连接）
const msgStore = new Map();  // mid -> { senderId, scope: 'hall'|'private', toName? }（撤回权限校验，保留最近 800 条）
/* 离线私聊：username -> [{ mid, fromId, fromName, color, text, to, toName, quote, avatarEmoji, ts }] 按用户名投递，登录后 flush；现用 history.offline 字段统一持久化 */
const PRIVATE_FILE = path.join(__dirname, 'private_messages.json');
const offline = loadOffline();

function loadOffline() {
  // 兼容老文件：优先读 chat_history.json 的 history.offline；如果 PRIVATE_FILE 里有数据，合并过去
  let merged = history.offline && typeof history.offline === 'object' ? history.offline : {};
  try {
    if (fs.existsSync(PRIVATE_FILE)) {
      const raw = fs.readFileSync(PRIVATE_FILE, 'utf8');
      const obj = JSON.parse(raw || '{}');
      if (obj && typeof obj === 'object') {
        for (const u of Object.keys(obj)) {
          if (Array.isArray(obj[u])) {
            merged[u] = Array.isArray(merged[u]) ? merged[u].concat(obj[u]) : obj[u];
          }
        }
        // 迁移后尝试删除旧文件，失败忽略
        try { fs.unlinkSync(PRIVATE_FILE); } catch { }
      }
    }
  } catch { }
  history.offline = merged || {};
  return history.offline;
}
function saveOffline() {
  history.offline = offline;
  scheduleSaveHistory();
  return true;
}
function pushOffline(username, payload) {
  if (!offline[username]) offline[username] = [];
  offline[username].push({ ...payload, ts: Date.now() });
  // 每个账号最多保留 200 条离线
  if (offline[username].length > 200) offline[username].splice(0, offline[username].length - 200);
  saveOffline();
}
function flushOffline(ctx) {
  const u = ctx.username;
  if (!u) return;
  const arr = offline[u]; if (!arr || arr.length === 0) return;
  for (const p of arr) {
    sendTo(ctx, { type: 'private', ...p });
  }
  delete offline[u]; saveOffline();
}

function sendTo(ctx, obj) { try { ctx.socket.write(textFrame(JSON.stringify(obj))); } catch { } }
function broadcast(obj, exceptId = null) {
  const data = textFrame(JSON.stringify(obj));
  for (const [id, ctx] of roster) {
    if (id === exceptId) continue;
    try { ctx.socket.write(data); } catch { }
  }
}
function listUsers() {
  return [...roster.entries()].map(([id, ctx]) => ({
    id, uid: ctx.uid || null,
    name: ctx.name,
    color: ctx.avatarColor || ctx.color,
    avatarEmoji: ctx.avatarEmoji || null,
    avatarImage: ctx.avatarImage || null
  }));
}
/** 由 uid 取账号资料快照（用于历史消息里补名字/头像） */
function profileByUid(uid) {
  if (!uid) return null;
  for (const u of Object.keys(accounts)) {
    const a = accounts[u]; if (a && a.uid === uid) {
      return { name: u, color: a.avatarColor || null, avatarEmoji: a.avatarEmoji || null, avatarColor: a.avatarColor || null, avatarImage: a.avatarImage || null };
    }
  }
  return null;
}
function removeCtx(ctx) {
  contexts.delete(ctx.socket);
  adminSessions.delete(ctx.id);
  if (ctx.joined && roster.get(ctx.id) === ctx) {
    roster.delete(ctx.id);
    broadcast({ type: 'leave', id: ctx.id });
  }
}

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );
  socket.setNoDelay(true);

  const id = Math.random().toString(36).slice(2, 10);
  const ctx = {
    id, socket,
    name: null,
    color: PALETTE[colorIdx++ % PALETTE.length],
    buffer: Buffer.alloc(0),
    pending: '',
    joined: false
  };
  contexts.set(socket, ctx);

  socket.on('data', (chunk) => {
    ctx.buffer = Buffer.concat([ctx.buffer, chunk]);
    let frame;
    while ((frame = parseFrame(ctx.buffer))) {
      ctx.buffer = ctx.buffer.subarray(frame.frameEnd);
      const { fin, opcode, payload } = frame;

      if (opcode === 0x8) {            // close
        try { socket.write(closeFrame()); } catch { }
        socket.end();
        return;
      } else if (opcode === 0x9) {    // ping -> pong
        const h = Buffer.alloc(2 + payload.length);
        h[0] = 0x8A; h[1] = payload.length;
        payload.copy(h, 2);
        try { socket.write(h); } catch { }
      } else if (opcode === 0xA) {     // pong
        // 忽略
      } else if (opcode === 0x1 || opcode === 0x0) { // text / continuation
        ctx.pending += payload.toString('utf8');
        if (fin) {
          const msg = ctx.pending;
          ctx.pending = '';
          handleMessage(ctx, msg);
        }
      }
    }
  });

  socket.on('end', () => removeCtx(ctx));
  socket.on('close', () => removeCtx(ctx));
  socket.on('error', () => removeCtx(ctx));
});

function buildAdminUserList() {
  const now = Date.now();
  const onlineIds = new Set();
  for (const [, rctx] of roster) onlineIds.add(rctx.username);
  return Object.keys(accounts).map(u => {
    const a = accounts[u];
    const isMuted = a.mutedUntil > now;
    return {
      username: u,
      uid: a.uid || null,
      createdAt: a.createdAt || 0,
      online: onlineIds.has(u),
      banned: !!a.banned,
      muted: isMuted,
      mutedUntil: a.mutedUntil || 0,
      muteCount: a.muteCount || 0,
      avatarEmoji: a.avatarEmoji || null,
      avatarColor: a.avatarColor || null,
      regIp: a.regIp || null
    };
  });
}

function handleMessage(ctx, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  switch (msg.type) {
    case 'join': {
      // 必须已登录：用 token 校验，昵称 = 账号用户名（无法自定义）
      const username = checkToken((msg.token || '') + '');
      if (!username) {
        sendTo(ctx, { type: 'auth_error', msg: '登录已失效，请重新登录' });
        try { ctx.socket.write(closeFrame(1008)); ctx.socket.end(); } catch { }
        return;
      }
      // 封号检查
      if (accounts[username] && accounts[username].banned) {
        sendTo(ctx, { type: 'banned', msg: '你的账号已被管理员封禁' });
        try { ctx.socket.write(closeFrame(1008)); ctx.socket.end(); } catch { }
        return;
      }
      // 同一账号重复登录：踢掉前一个连接（同账号只保留一个光标）
      for (const [rid, rctx] of roster) {
        if (rid !== ctx.id && rctx.username === username) {
          try { sendTo(rctx, { type: 'kick', msg: '该账号在其他地方登录，你已被踢下线' }); } catch { }
          try { rctx.socket.write(closeFrame(1008)); rctx.socket.end(); } catch { }
          removeCtx(rctx);
        }
      }
      ctx.username = username;
      ctx.name = username;
      const acc = accounts[username];
      if (acc) {
        ctx.uid = acc.uid || null;
        ctx.avatarEmoji = acc.avatarEmoji || null;
        ctx.avatarImage = acc.avatarImage || null;
        if (acc.avatarColor) ctx.color = acc.avatarColor;
      }
      ctx.joined = true;
      roster.set(ctx.id, ctx);
      // 组装 welcome 附带的历史：大厅最近 N 条 + 我参与的所有私聊会话摘要（最近 N 条/会话）
      const hallHistory = history.hall.slice(-HISTORY_WELCOME_LIMIT);
      const privHistMap = {};
      const meUser = username;
      if (history.private && typeof history.private === 'object') {
        for (const k of Object.keys(history.private)) {
          const [p1, p2] = k.split('||');
          if (p1 !== meUser && p2 !== meUser) continue;
          const peer = (p1 === meUser ? p2 : p1);
          const arr = history.private[k] || [];
          privHistMap[peer] = arr.slice(-HISTORY_WELCOME_LIMIT);
        }
      }
      // 构建 uid -> 资料 映射（供前端按 uid 渲染历史消息的名字/头像，改名后自动跟随）
      const uidProfiles = {};
      const putProfile = uid => { if (uid && !uidProfiles[uid]) { const p = profileByUid(uid); if (p) uidProfiles[uid] = p; } };
      putProfile(acc?.uid);
      for (const hm of hallHistory) if (hm && hm.from) putProfile(hm.from);
      for (const peer of Object.keys(privHistMap)) { const pa = accounts[peer]; if (pa && pa.uid) putProfile(pa.uid); }
      // 私聊会话对方 username -> uid 映射
      const peerUidMap = {};
      for (const peer of Object.keys(privHistMap)) { const pa = accounts[peer]; if (pa && pa.uid) peerUidMap[peer] = pa.uid; }
      sendTo(ctx, {
        type: 'welcome',
        id: ctx.id, uid: ctx.uid || null, name: username, username,
        color: ctx.color, users: listUsers(),
        avatarEmoji: ctx.avatarEmoji, avatarColor: acc?.avatarColor || null, avatarImage: ctx.avatarImage,
        history: { hall: hallHistory, private: privHistMap },
        friends: (acc?.friends || []).slice(),
        mutedUntil: acc?.mutedUntil || 0,
        muteCount: acc?.muteCount || 0,
        uidProfiles, peerUidMap
      });
      broadcast({ type: 'enter', id: ctx.id, uid: ctx.uid || null, name: username, color: ctx.color, avatarEmoji: ctx.avatarEmoji, avatarImage: ctx.avatarImage }, ctx.id);
      // 投递离线私聊remaining30

      flushOffline(ctx);
      break;
    }
    case 'move': {
      if (!ctx.joined) return;
      broadcast({ type: 'cursor', id: ctx.id, x: Number(msg.x) || 0, y: Number(msg.y) || 0 }, ctx.id);
      break;
    }
    case 'chat': {
      if (!ctx.joined) return;
      const text = (msg.text + '').slice(0, 500);
      if (!text.trim()) return;
      // 防刷屏
      const spam = checkSpam(ctx.username);
      if (spam.muted) {
        if (spam.triggered) sendTo(ctx, { type: 'muted', msg: `检测到刷屏（第 ${spam.offense || 1} 次），已禁言 ${spam.remaining} 秒`, remaining: spam.remaining });
        else sendTo(ctx, { type: 'muted', msg: `你已被禁言，剩余 ${spam.remaining} 秒`, remaining: spam.remaining });
        return;
      }
      const mentions = msg.mentions || [];
      // 引用透传（带长度限制）
      let quote = null;
      if (msg.quote && msg.quote.text) {
        quote = {
          name: ((msg.quote.name || '') + '').slice(0, 12),
          text: (msg.quote.text + '').slice(0, 200)
        };
      }
      const mid = Math.random().toString(36).slice(2, 10);
      msgStore.set(mid, { senderId: ctx.id, scope: 'hall' });
      while (msgStore.size > 800) { const first = msgStore.keys().next().value; msgStore.delete(first); }
      const ts = Date.now();
      const broadcastPayload = { type: 'chat', mid, id: ctx.id, uid: ctx.uid || null, name: ctx.name, from: ctx.uid || null, color: ctx.avatarColor || ctx.color, text, mentions, quote, avatarEmoji: ctx.avatarEmoji || null, avatarImage: ctx.avatarImage || null, ts };
      broadcast(broadcastPayload);
      pushHallMsg({ mid, id: ctx.id, uid: ctx.uid || null, name: ctx.name, from: ctx.uid || null, color: ctx.avatarColor || ctx.color, text, mentions: mentions || [], quote, avatarEmoji: ctx.avatarEmoji || null, avatarImage: ctx.avatarImage || null, ts });
      // 通知被 @ 的用户
      for (const uid of mentions) {
        if (uid === ctx.id) continue;
        const target = roster.get(uid);
        if (target) sendTo(target, { type: 'mention', from: ctx.id, fromName: ctx.name, text });
      }
      break;
    }
    case 'code': {
      if (!ctx.joined) return;
      const codeText = (msg.text + '').slice(0, 5000);
      if (!codeText.trim()) return;
      const language = ((msg.language || '') + '').trim().slice(0, 20) || 'plaintext';
      // 防刷屏
      const spam = checkSpam(ctx.username);
      if (spam.muted) {
        if (spam.triggered) sendTo(ctx, { type: 'muted', msg: `检测到刷屏（第 ${spam.offense || 1} 次），已禁言 ${spam.remaining} 秒`, remaining: spam.remaining });
        else sendTo(ctx, { type: 'muted', msg: `你已被禁言，剩余 ${spam.remaining} 秒`, remaining: spam.remaining });
        return;
      }
      const mid = Math.random().toString(36).slice(2, 10);
      msgStore.set(mid, { senderId: ctx.id, scope: 'hall' });
      while (msgStore.size > 800) { const first = msgStore.keys().next().value; msgStore.delete(first); }
      const ts = Date.now();
      const broadcastPayload = { type: 'code', mid, id: ctx.id, uid: ctx.uid || null, name: ctx.name, from: ctx.uid || null, color: ctx.avatarColor || ctx.color, language, text: codeText, avatarEmoji: ctx.avatarEmoji || null, avatarImage: ctx.avatarImage || null, ts };
      broadcast(broadcastPayload);
      pushHallMsg({ mid, id: ctx.id, uid: ctx.uid || null, name: ctx.name, from: ctx.uid || null, color: ctx.avatarColor || ctx.color, language, text: codeText, avatarEmoji: ctx.avatarEmoji || null, avatarImage: ctx.avatarImage || null, ts });
      break;
    }
    case 'revoke': {
      if (!ctx.joined) return;
      const mid = ((msg.mid || '') + '').slice(0, 20);
      if (!mid) return;
      const meta = msgStore.get(mid);
      if (!meta || meta.senderId !== ctx.id) return; // 只能撤回自己发的消息
      msgStore.delete(mid);
      if (meta.scope === 'hall') {
        broadcast({ type: 'revoke', mid, id: ctx.id, name: ctx.name });
        // 历史里也改为撤回提示
        const arr = history.hall;
        for (let i = 0; i < arr.length; i++) { if (arr[i] && arr[i].mid === mid) { arr.splice(i, 1); scheduleSaveHistory(); break; } }
      } else if (meta.scope === 'private') {
        // 私聊撤回：同时通知发送者 & 接收者（如果在线）
        const toId = meta.toId; const toName = meta.toName;
        const payload = { type: 'revoke', mid, id: ctx.id, name: ctx.name, private: true, peerId: toId };
        sendTo(ctx, payload);
        if (toId) {
          const peerCtx = roster.get(toId);
          if (peerCtx) sendTo(peerCtx, { type: 'revoke', mid, id: ctx.id, name: ctx.name, private: true, peerId: ctx.id });
        }
        // 私聊历史移除对应 mid
        const peer = meta.toName ? toName : '';
        if (ctx.username && peer) {
          const k = privateKey(ctx.username, peer);
          const arr = history.private[k];
          if (arr) {
            for (let i = 0; i < arr.length; i++) { if (arr[i] && arr[i].mid === mid) { arr.splice(i, 1); scheduleSaveHistory(); break; } }
          }
        }
      }
      break;
    }
    case 'private': {
      if (!ctx.joined) return;
      const text = (msg.text + '').slice(0, 500);
      if (!text.trim()) return;
      // 防刷屏
      const spam2 = checkSpam(ctx.username);
      if (spam2.muted) {
        if (spam2.triggered) sendTo(ctx, { type: 'muted', msg: `检测到刷屏（第 ${spam2.offense || 1} 次），已禁言 ${spam2.remaining} 秒`, remaining: spam2.remaining });
        else sendTo(ctx, { type: 'muted', msg: `你已被禁言，剩余 ${spam2.remaining} 秒`, remaining: spam2.remaining });
        return;
      }
      const targetId = (msg.to + '').slice(0, 16);
      if (!targetId || targetId === ctx.id) return;
      const target = roster.get(targetId);
      const mentions = Array.isArray(msg.mentions) ? msg.mentions.slice(0, 20) : [];
      // 私聊双方 username 已确认（下面会校验）
      const myAcc = accounts[ctx.username];
      // 允许引用透传
      let quote = null;
      if (msg.quote && msg.quote.text) {
        quote = {
          name: ((msg.quote.name || '') + '').slice(0, 12),
          text: (msg.quote.text + '').slice(0, 200)
        };
      }
      const mid = Math.random().toString(36).slice(2, 10);
      const toNameGiven = (msg.toName && typeof msg.toName === 'string') ? msg.toName : '';
      const toUsername = (target && target.username) ? target.username : toNameGiven;
      if (!toUsername) return; // 私聊双方都需要 username 才能持久化 + 离线投递
      // 发消息即自动双方互加好友（无需申请）
      let becameFriends = false;
      if (myAcc) {
        if (!Array.isArray(myAcc.friends)) myAcc.friends = [];
        if (!myAcc.friends.includes(toUsername)) { myAcc.friends.push(toUsername); becameFriends = true; }
      }
      const taAcc = accounts[toUsername];
      if (taAcc) {
        if (!Array.isArray(taAcc.friends)) taAcc.friends = [];
        if (!taAcc.friends.includes(ctx.username)) { taAcc.friends.push(ctx.username); becameFriends = true; }
      }
      if (becameFriends) saveAccounts();
      // 若刚成为好友，给双方推送 friend-added（带对方资料），让前端把会话标记成好友
      if (becameFriends) {
        for (const [rid, rctx] of roster) {
          if (rctx.username === ctx.username && taAcc) sendTo(rctx, { type: 'friend-added', username: toUsername, profile: { name: toUsername, color: taAcc.avatarColor || null, avatarEmoji: taAcc.avatarEmoji || null, avatarImage: taAcc.avatarImage || null } });
          if (rctx.username === toUsername && myAcc) sendTo(rctx, { type: 'friend-added', username: ctx.username, profile: { name: ctx.username, color: myAcc.avatarColor || null, avatarEmoji: myAcc.avatarEmoji || null, avatarImage: myAcc.avatarImage || null } });
        }
      }
      msgStore.set(mid, { senderId: ctx.id, scope: 'private', toId: targetId, toName: toUsername });
      while (msgStore.size > 800) { const first = msgStore.keys().next().value; msgStore.delete(first); }
      const ts = Date.now();
      const payloadForTarget = {
        type: 'private', mid, ts,
        id: ctx.id, uid: ctx.uid || null, name: ctx.name, color: ctx.avatarColor || ctx.color,
        avatarEmoji: ctx.avatarEmoji || null, avatarImage: ctx.avatarImage || null,
        text, mentions, to: targetId, toName: toUsername, from: ctx.uid || null, fromName: ctx.username, quote
      };
      const payloadForSelf = {
        type: 'private', mid, ts,
        id: ctx.id, uid: ctx.uid || null, name: ctx.name, color: ctx.avatarColor || ctx.color,
        avatarEmoji: ctx.avatarEmoji || null, avatarImage: ctx.avatarImage || null,
        text, mentions, to: targetId, toName: toUsername, from: ctx.uid || null, fromName: ctx.username, quote
      };
      sendTo(ctx, payloadForSelf);
      if (target) {
        sendTo(target, payloadForTarget);
      } else {
        pushOffline(toUsername, {
          mid, ts, id: ctx.id, uid: ctx.uid || null, name: ctx.name, color: ctx.avatarColor || ctx.color,
          avatarEmoji: ctx.avatarEmoji || null, avatarImage: ctx.avatarImage || null,
          text, to: targetId, toName: toUsername, from: ctx.uid || null, fromName: ctx.username, quote
        });
      }
      // 持久化到聊天历史
      pushPrivateMsg(ctx.username, toUsername, {
        mid, ts, from: ctx.uid || null, fromName: ctx.username, fromId: ctx.id, to: toUsername,
        color: ctx.avatarColor || ctx.color, avatarEmoji: ctx.avatarEmoji || null, avatarImage: ctx.avatarImage || null,
        text, mentions: mentions || [], quote
      });
      // 私聊里 @ 的人也收到通知
      for (const uid of mentions) {
        if (uid === ctx.id) continue;
        const m = roster.get(uid);
        if (m && m !== target) sendTo(m, { type: 'mention', from: ctx.id, fromName: ctx.name, text, privateHint: toUsername });
      }
      break;
    }
    case 'typing': {
      if (!ctx.joined) return;
      broadcast({ type: 'typing', id: ctx.id, on: !!msg.on }, ctx.id);
      break;
    }

    /* ========== 管理员指令 ========== */
    case 'admin_login': {
      if (msg.password === ADMIN_PASSWORD) {
        ctx.isAdmin = true;
        adminSessions.add(ctx.id);
        sendTo(ctx, { type: 'admin_ok', ok: true });
        // 立即推送用户列表
        sendTo(ctx, { type: 'admin_users', users: buildAdminUserList() });
      } else {
        sendTo(ctx, { type: 'admin_ok', ok: false, msg: '密码错误' });
      }
      break;
    }
    case 'admin_users': {
      if (!ctx.isAdmin) return;
      sendTo(ctx, { type: 'admin_users', users: buildAdminUserList() });
      break;
    }
    case 'admin_ban': {
      if (!ctx.isAdmin) return;
      const target = (msg.username || '').trim();
      if (!target || !accounts[target]) { sendTo(ctx, { type: 'admin_err', msg: '用户不存在' }); break; }
      accounts[target].banned = true;
      saveAccounts();
      // 踢掉在线连接
      for (const [rid, rctx] of roster) {
        if (rctx.username === target) {
          sendTo(rctx, { type: 'banned', msg: '你的账号已被管理员封禁' });
          try { rctx.socket.write(closeFrame(1008)); rctx.socket.end(); } catch { }
          removeCtx(rctx);
        }
      }
      sendTo(ctx, { type: 'admin_users', users: buildAdminUserList() });
      broadcast({ type: 'sys', text: `管理员封禁了用户「${target}」` });
      break;
    }
    case 'admin_unban': {
      if (!ctx.isAdmin) return;
      const target = (msg.username || '').trim();
      if (!target || !accounts[target]) { sendTo(ctx, { type: 'admin_err', msg: '用户不存在' }); break; }
      accounts[target].banned = false;
      saveAccounts();
      sendTo(ctx, { type: 'admin_users', users: buildAdminUserList() });
      break;
    }
    case 'admin_mute': {
      if (!ctx.isAdmin) return;
      const target = (msg.username || '').trim();
      const duration = Math.min(Math.max(Number(msg.duration) || 300, 10), 86400); // 10秒~24小时
      if (!target || !accounts[target]) { sendTo(ctx, { type: 'admin_err', msg: '用户不存在' }); break; }
      accounts[target].mutedUntil = Date.now() + duration * 1000;
      saveAccounts();
      // 通知被禁言用户
      for (const [rid, rctx] of roster) {
        if (rctx.username === target) {
          sendTo(rctx, { type: 'muted', msg: `管理员禁言了你，剩余 ${duration} 秒`, remaining: duration });
        }
      }
      sendTo(ctx, { type: 'admin_users', users: buildAdminUserList() });
      break;
    }
    case 'admin_unmute': {
      if (!ctx.isAdmin) return;
      const target = (msg.username || '').trim();
      if (!target || !accounts[target]) { sendTo(ctx, { type: 'admin_err', msg: '用户不存在' }); break; }
      accounts[target].mutedUntil = 0;
      accounts[target].muteCount = 0;
      saveAccounts();
      sendTo(ctx, { type: 'admin_users', users: buildAdminUserList() });
      break;
    }
    case 'admin_kick': {
      if (!ctx.isAdmin) return;
      const target = (msg.username || '').trim();
      for (const [rid, rctx] of roster) {
        if (rctx.username === target) {
          sendTo(rctx, { type: 'kick', msg: '你已被管理员踢下线' });
          try { rctx.socket.write(closeFrame(1008)); rctx.socket.end(); } catch { }
          removeCtx(rctx);
        }
      }
      sendTo(ctx, { type: 'admin_users', users: buildAdminUserList() });
      break;
    }
    case 'admin_delete_hall': {
      if (!ctx.isAdmin) return;
      history.hall = [];
      saveHistory();
      broadcast({ type: 'hall_cleared' });
      sendTo(ctx, { type: 'admin_ok', ok: true, msg: '大厅聊天记录已清空' });
      break;
    }
    case 'admin_delete_private': {
      if (!ctx.isAdmin) return;
      const target = (msg.username || '').trim();
      if (target) {
        // 删除与指定用户相关的所有私聊记录
        if (history.private && typeof history.private === 'object') {
          for (const k of Object.keys(history.private)) {
            const [p1, p2] = k.split('||');
            if (p1 === target || p2 === target) {
              delete history.private[k];
            }
          }
        }
        saveHistory();
        sendTo(ctx, { type: 'admin_ok', ok: true, msg: `已清空与「${target}」相关的所有私聊记录` });
      } else {
        // 清空所有私聊记录
        history.private = {};
        saveHistory();
        sendTo(ctx, { type: 'admin_ok', ok: true, msg: '所有私聊记录已清空' });
      }
      break;
    }
  }
}

server.listen(PORT, () => {
  console.log(`\n  鼠标大厅已启动 (零依赖)`);
  console.log(`  打开浏览器访问: http://localhost:${PORT}\n`);
});
