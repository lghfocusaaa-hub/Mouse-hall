(() => {
    const WS_URL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
    const LS_TOKEN = 'mhall_token';
    const HALL = 'hall';
    const EMOJIS = ['😀', '😎', '🤠', '🤡', '🐱', '🐶', '🦆', '🦊', '🐼', '🦁', '🐯', '🐸', '🐵', '🐨', '🦄', '🐙', '🦉', '🌵', '🌸', '🌻', '🍀', '🍎', '🍉', '🍊', '🍇', '🍕', '🍔', '🎈', '🎮', '🎨', '🎧', '⭐', '🌙', '☀️', '🌈', '⚡', '🔥', '💧', '❤️', '💯', '🚀', '✈️', '🗺️', '🏠', '🎁', '☕', '🍵'];

    let ws = null;
    let me = null; // { id, name, color, avatarEmoji }
    let myProfile = { avatarEmoji: null, avatarColor: null };
    const cursors = new Map();
    const userList = new Map(); // id -> { name, color, avatarEmoji, avatarImage }
    const friendSet = new Set();   // 好友 username 集合（稳定不变，改名服务端同步更新）
    const friendInfoMap = new Map(); // username -> { online, onlineId, avatarEmoji, avatarColor, avatarImage }
    const uidProfile = new Map();   // uid -> { name, color, avatarEmoji, avatarColor, avatarImage }（按 uid 渲染历史消息，改名后自动跟随）
    // 会话：hall 群聊 + f_${username} 私聊好友会话（按稳定 username 建 key，对方改名不掉）
    const sessions = new Map();
    let curSessionId = HALL;
    let searchQuery = '';
    let lastSend = 0;
    let quoting = null;
    const ctxMenuData = {};

    const $ = id => document.getElementById(id);
    const shell = $('shell');
    const sbList = $('sbList');
    const sbSearch = $('sbSearch');
    const chatBody = $('chatBody');
    const hAvatar = $('hAvatar'), hName = $('hName'), hSub = $('hSub');
    const input = $('input'), sendBtn = $('sendBtn');
    const codeBtn = $('codeBtn'), codeInputWrap = $('codeInputWrap'), codeInput = $('codeInput'), codeCancel = $('codeCancel'), codeSend = $('codeSend'), codeCharCount = $('codeCharCount');
    const onlineBadge = $('onlineBadge'), connDot = $('connDot');
    const toast = $('toast');
    const usersToggle = $('usersToggle'), usersPanel = $('usersPanel'), usersPanelClose = $('usersPanelClose'), usersList = $('usersList');
    const overlay = $('overlay'), overlayHint = $('overlayHint');
    const quoteBar = $('quoteBar'), qbarName = $('qbarName'), qbarText = $('qbarText');
    const atDropdown = $('atDropdown');
    const meAvatar = $('meAvatar'), meBtn = $('meBtn'), meMenu = $('meMenu');
    const btnAvatar = $('btnAvatar'), btnUser = $('btnUser'), btnChangePwd = $('btnChangePwd'), btnLogout = $('btnLogout');
    const pwdModal = $('pwdModal'), pwdCancel = $('pwdCancel'), pwdSubmit = $('pwdSubmit'), pwdErr = $('pwdErr');
    const avModal = $('avModal'), avPreview = $('avPreview'), emojiRow = $('emojiRow'), colorPicker = $('colorPicker'),
        avCancel = $('avCancel'), avSubmit = $('avSubmit'), avErr = $('avErr');
    const userModal = $('userModal'), newUser = $('newUser'), userPwd = $('userPwd'),
        userCancel = $('userCancel'), userSubmit = $('userSubmit'), userErr = $('userErr');
    const ctxMenu = $('ctxMenu');
    // 好友模态元素
    const frModal = $('frModal'), frCancel = $('frCancel'),
        frListPanel = $('frListPanel');
    const sbFriendBtn = $('sbFriendBtn'), sbFriendCount = $('sbFriendCount');
    const captchaImg = $('captchaImg'), captchaRefresh = $('captchaRefresh'), regCaptcha = $('regCaptcha');
    let captchaId = '';   // 当前验证码 challengeId

    function ensureHall() {
        if (sessions.has(HALL)) return;
        sessions.set(HALL, {
            id: HALL, name: '鼠标大厅', color: '#8aa9c9', avatarEmoji: '🏠',
            isPrivate: false, messages: [], unread: 0,
            lastText: '', lastTime: 0, sub: '所有人的公共聊天'
        });
    }
    function ensurePrivate(id, username, color, avatarEmoji, avatarImage) {
        // 私聊会话 KEY 统一按 username：f_${username}，改名后服务端同步过来，会话永不丢
        if (!username) return null;
        const key = 'f_' + escapeJsKey(username);
        if (sessions.has(key)) {
            const s = sessions.get(key);
            // 名字等于 username（服务端改名后，welcome/rename 会用新 username 调用 ensurePrivate）
            s.name = username;
            s.peerUsername = username;
            // 头像用创建时快照，不实时跟随对方更换（需求3）
            // 对方在线 id 同步（只要是新 id 就替换）
            if (id && String(id).slice(0, 8) !== 'offline_' && !/^off_/.test(String(id))) {
                s.withId = id;
            }
            return s;
        }
        const s = {
            id: key, withId: (id && String(id).slice(0, 8) !== 'offline_' && !/^off_/.test(String(id))) ? id : null,
            name: username, color: color || '#8aa9c9',
            avatarEmoji: avatarEmoji || null, avatarImage: avatarImage || null,
            peerUsername: username,
            isPrivate: true, isFriend: friendSet.has(username),
            messages: [], unread: 0,
            lastText: '', lastTime: 0, sub: '好友私聊'
        };
        sessions.set(key, s);
        return s;
    }
    // 工具：escaped key 生成（按 username 建会话 key 时用）
    function escapeJsKey(s) { return String(s || '').replace(/[^A-Za-z0-9_]/g, x => x.charCodeAt(0).toString(16)); }
    // 按 username 找好友会话 key（不存在返回 null）
    function friendSessionKey(username) { return username ? ('f_' + escapeJsKey(username)) : null; }
    function isFriendOfMine(username) { return friendSet.has(username); }

    // ---------- API ----------
    const api = async (path, body) => {
        const res = await fetch(path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json;charset=utf-8' },
            body: JSON.stringify(body || {})
        });
        let obj = {};
        try { obj = await res.json(); } catch { }
        return { status: res.status, ok: !!obj.ok, msg: obj.msg || '', data: obj };
    };
    function setToken(token) { token ? localStorage.setItem(LS_TOKEN, token) : localStorage.removeItem(LS_TOKEN); }
    function getToken() { return localStorage.getItem(LS_TOKEN) || ''; }

    // ---------- 头像工具 ----------
    const AVATAR_SIZE = 192; // 保存大小
    const AVATAR_BG = '#d9e2ee';
    function firstChar(s) { return ((s || '') + '').trim()[0] || '?'; }
    function avHTML({ avatarEmoji, avatarImage, color, name }) {
        const bg = color || '#8aa9c9';
        if (avatarImage) {
            return `<img src="${escapeAttr(avatarImage)}" alt="${escapeAttr(name || '头像')}" style="width:100%;height:100%;object-fit:cover;display:block;background:${AVATAR_BG};"/>`;
        }
        if (avatarEmoji) return `<div style="background:${bg};width:100%;height:100%;display:grid;place-items:center;font-size:1.3em;">${avatarEmoji}</div>`;
        return `<div style="background:${bg};width:100%;height:100%;display:grid;place-items:center;">${firstChar(name)}</div>`;
    }
    function fillAvatar(el, info) { el.innerHTML = avHTML(info); }
    function escapeAttr(s) { return (s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
    // 头像缓存破坏：上传后 URL 不同，本函数主要用于本地 dataURL 无此问题；远端也加 query。
    function avatarUrl(u) {
        if (!u) return u;
        if (u.startsWith('/') || u.startsWith('http')) {
            // 带一次时间戳防止服务器端缓存过于激进（但文件本身是唯一命名，加不加都行）
            return u;
        }
        return u;
    }

    function setMeUI(profile) {
        myProfile = {
            avatarEmoji: profile.avatarEmoji || null,
            avatarColor: profile.avatarColor || null,
            avatarImage: profile.avatarImage || null
        };
        const name = profile.username || (me && me.name) || '我';
        const color = (profile.avatarColor || (me && me.color) || '#8aa9c9');
        fillAvatar(meAvatar, { avatarEmoji: profile.avatarEmoji, avatarImage: profile.avatarImage, color, name });
        updateFriendCountBadge();
    }

    // ---------- 好友功能 ----------
    function updateFriendCountBadge() {
        if (sbFriendCount) {
            if (friendSet.size > 0) { sbFriendCount.style.display = 'inline-block'; sbFriendCount.textContent = String(friendSet.size); }
            else sbFriendCount.style.display = 'none';
        }
    }
    async function renderFriendModal() {
        if (!frListPanel) return;
        frListPanel.innerHTML = '';
        if (friendSet.size === 0) {
            frListPanel.innerHTML = '<div class="fr-empty">还没有好友<br>点开大厅里任意人的头像昵称，给他发一条消息就会自动成为好友</div>';
            return;
        }
        const list = await api('/api/friends/list', { token: getToken() });
        const arr = (list.ok && Array.isArray(list.data.friends)) ? list.data.friends : [...friendSet].map(u => ({ username: u }));
        for (const f of arr) {
            // 更新本地 friendInfoMap 缓存
            friendInfoMap.set(f.username, { online: !!f.online, onlineId: f.onlineId || null, avatarEmoji: f.avatarEmoji || null, avatarColor: f.avatarColor || null, avatarImage: f.avatarImage || null });
            if (f.online && f.onlineId) {
                const sk = friendSessionKey(f.username); const sess = sessions.get(sk);
                if (sess) sess.withId = f.onlineId;
            }
            const row = document.createElement('div'); row.className = 'fr-row';
            const av = document.createElement('div'); av.className = 'fr-av'; fillAvatar(av, { avatarEmoji: f.avatarEmoji, avatarImage: f.avatarImage, color: f.avatarColor || '#8aa9c9', name: f.username });
            const info = document.createElement('div'); info.className = 'fr-info';
            const nn = document.createElement('div'); nn.className = 'fr-name'; nn.textContent = f.username;
            const mt = document.createElement('div'); mt.className = 'fr-meta'; mt.textContent = f.online ? '🟢 在线' : '⚪ 离线';
            info.appendChild(nn); info.appendChild(mt);
            const acts = document.createElement('div'); acts.className = 'fr-actions';
            const chat = document.createElement('button'); chat.className = 'primary'; chat.textContent = '聊天';
            chat.onclick = () => {
                const sk = ensurePrivate(f.onlineId || null, f.username, f.avatarColor || null, f.avatarEmoji || null, f.avatarImage || null);
                if (sk) { closeFriendModal(); switchSession(sk.id); }
            };
            const del = document.createElement('button'); del.className = 'danger'; del.textContent = '删除';
            del.onclick = async () => {
                if (!confirm(`确定要删除好友「${f.username}」吗？（私聊历史仍保留）`)) return;
                const r2 = await api('/api/friends/remove', { token: getToken(), username: f.username });
                if (!r2.ok) showToast(r2.msg || '操作失败');
                else { refreshFriendsFromServer(); showToast('已删除好友'); }
            };
            acts.appendChild(chat); acts.appendChild(del);
            row.appendChild(av); row.appendChild(info); row.appendChild(acts);
            frListPanel.appendChild(row);
        }
    }
    async function refreshFriendsFromServer() {
        const r = await api('/api/friends/list', { token: getToken() });
        if (r.ok) {
            friendSet.clear(); friendInfoMap.clear();
            for (const f of r.data.friends || []) {
                friendSet.add(f.username);
                friendInfoMap.set(f.username, { online: !!f.online, onlineId: f.onlineId || null, avatarEmoji: f.avatarEmoji || null, avatarColor: f.avatarColor || null, avatarImage: f.avatarImage || null });
            }
            for (const s of sessions.values()) if (s.isPrivate) s.isFriend = friendSet.has(s.peerUsername);
        }
        updateFriendCountBadge();
    }
    function openFriendModal() {
        if (!frModal) return;
        renderFriendModal();
        frModal.classList.add('show');
    }
    function closeFriendModal() { if (frModal) frModal.classList.remove('show'); }
    if (frCancel) frCancel.onclick = closeFriendModal;
    if (sbFriendBtn) sbFriendBtn.onclick = openFriendModal;

    // ---------- 登录/注册 ----------
    for (const el of document.querySelectorAll('#overlay .tab')) {
        el.addEventListener('click', () => {
            document.querySelectorAll('#overlay .tab').forEach(t => t.classList.toggle('active', t === el));
            document.querySelectorAll('#overlay .panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + el.dataset.tab));
            $('loginErr').textContent = ''; $('regErr').textContent = '';
            if (el.dataset.tab === 'register' && !captchaId) loadCaptcha();
        });
    }
    for (const btn of document.querySelectorAll('.pw-toggle')) {
        btn.addEventListener('click', () => {
            const i = $(btn.dataset.target); if (!i) return;
            const show = i.type === 'password';
            i.type = show ? 'text' : 'password';
            btn.textContent = show ? '隐藏' : '显示';
        });
    }
    ['loginUser', 'loginPwd'].forEach(id => $(id).addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); }));
    ['regUser', 'regPwd', 'regPwd2', 'regCaptcha'].forEach(id => $(id).addEventListener('keydown', e => { if (e.key === 'Enter') doRegister(); }));
    $('loginBtn').addEventListener('click', doLogin);
    $('regBtn').addEventListener('click', doRegister);

    // ---------- 人机验证码 ----------
    async function loadCaptcha() {
        try {
            const r = await api('/api/captcha/new', {});
            if (r.ok && r.data.cid) {
                captchaId = r.data.cid;
                if (captchaImg) captchaImg.src = '/api/captcha/image?cid=' + encodeURIComponent(captchaId) + '&t=' + Date.now();
                if (regCaptcha) regCaptcha.value = '';
            }
        } catch { }
    }
    if (captchaImg) captchaImg.addEventListener('click', loadCaptcha);
    if (captchaRefresh) captchaRefresh.addEventListener('click', loadCaptcha);

    async function doLogin() {
        const u = $('loginUser').value.trim(); const p = $('loginPwd').value;
        const err = $('loginErr');
        if (!u || !p) { err.textContent = '请填写用户名和密码'; return; }
        $('loginBtn').disabled = true; err.textContent = '';
        const r = await api('/api/login', { username: u, password: p });
        $('loginBtn').disabled = false;
        if (!r.ok) { err.textContent = r.msg || '登录失败'; return; }
        setToken(r.data.token); connectToHall();
    }
    async function doRegister() {
        const u = $('regUser').value.trim(); const p = $('regPwd').value; const p2 = $('regPwd2').value;
        const cap = regCaptcha ? regCaptcha.value.trim() : '';
        const err = $('regErr');
        if (!/^[\w\u4e00-\u9fff]{2,16}$/.test(u)) { err.textContent = '用户名需 2-16 位'; return; }
        if (p.length < 6) { err.textContent = '密码至少 6 位'; return; }
        if (p !== p2) { err.textContent = '两次输入的密码不一致'; return; }
        if (!cap) { err.textContent = '请输入验证码'; return; }
        $('regBtn').disabled = true; err.textContent = '';
        const r = await api('/api/register', { username: u, password: p, captchaId, captchaCode: cap });
        $('regBtn').disabled = false;
        if (!r.ok) { err.textContent = r.msg || '注册失败'; loadCaptcha(); return; }
        setToken(r.data.token); connectToHall();
    }

    // ---------- 设置菜单 ----------
    meBtn.addEventListener('click', (e) => { e.stopPropagation(); meMenu.classList.toggle('show'); });
    document.addEventListener('click', () => meMenu.classList.remove('show'));
    meMenu.addEventListener('click', e => e.stopPropagation());

    btnLogout.addEventListener('click', async () => {
        meMenu.classList.remove('show');
        try { const tok = getToken(); if (tok) await api('/api/logout', { token: tok }); } catch { }
        forceLogout('已退出登录');
    });
    function forceLogout(msg) {
        setToken('');
        if (ws) { try { ws.close(); } catch { } ws = null; }
        me = null;
        userList.clear(); sessions.clear(); cursors.clear();
        for (const c of cursors.values()) c.el.remove();
        shell.classList.add('hidden'); overlay.style.display = '';
        $('loginUser').value = ''; $('loginPwd').value = ''; $('loginErr').textContent = ''; $('regErr').textContent = '';
        captchaId = ''; if (regCaptcha) regCaptcha.value = '';
        showToast(msg || '请重新登录');
    }

    // --- 修改密码 ---
    btnChangePwd.addEventListener('click', () => {
        meMenu.classList.remove('show');
        $('oldPwd').value = ''; $('newPwd').value = ''; $('newPwd2').value = ''; pwdErr.textContent = '';
        pwdModal.classList.add('show'); setTimeout(() => $('oldPwd').focus(), 50);
    });
    pwdCancel.addEventListener('click', () => pwdModal.classList.remove('show'));
    pwdSubmit.addEventListener('click', async () => {
        const o = $('oldPwd').value; const n = $('newPwd').value; const n2 = $('newPwd2').value;
        if (!o || !n) { pwdErr.textContent = '请填写完整'; return; }
        if (n.length < 6) { pwdErr.textContent = '新密码至少 6 位'; return; }
        if (n !== n2) { pwdErr.textContent = '两次新密码不一致'; return; }
        pwdSubmit.disabled = true; pwdErr.textContent = '';
        const r = await api('/api/changepwd', { token: getToken(), oldPassword: o, newPassword: n });
        pwdSubmit.disabled = false;
        if (!r.ok) { pwdErr.textContent = r.msg || '修改失败'; return; }
        pwdModal.classList.remove('show'); showToast('密码已修改，请重新登录'); forceLogout('密码已修改，请重新登录');
    });

    // --- 更换头像 ---
    let curEmoji = null, curColor = '#8aa9c9', curAvatarImage = null, curUploadBlob = null;
    const avUploadBtn = $('avUploadBtn'), avFile = $('avFile');
    function refreshAvPreview() {
        if (curAvatarImage) {
            avPreview.innerHTML = `<img src="${escapeAttr(curAvatarImage)}" style="width:100%;height:100%;object-fit:cover;display:block;"/>`;
            avPreview.style.background = '#fff';
        } else {
            avPreview.innerHTML = curEmoji ? `<div style="font-size:34px;">${curEmoji}</div>` : firstChar(me ? me.name : '我');
            avPreview.style.background = curColor;
        }
    }
    avUploadBtn.addEventListener('click', () => avFile.click());
    avFile.addEventListener('change', async e => {
        const f = e.target.files && e.target.files[0];
        avFile.value = '';
        if (!f) return;
        if (f.size > 2 * 1024 * 1024) { avErr.textContent = '图片不能超过 2MB，请选更小的图片'; return; }
        const allowed = ['image/jpeg', 'image/png', 'image/webp'];
        if (!allowed.includes(f.type)) { avErr.textContent = '仅支持 JPG / PNG / WebP 图片'; return; }
        avErr.textContent = '';
        const { blob, dataURL, err } = await compressAndCrop(f, AVATAR_SIZE);
        if (err || !blob) { avErr.textContent = err || '图片处理失败'; return; }
        curAvatarImage = dataURL;   // 预览用 dataURL
        curUploadBlob = blob;       // 上传用 blob（已经压缩/裁剪，约 ≤ 300KB）
        curEmoji = null;            // 上传图片就切到图片模式
        document.querySelectorAll('#emojiRow button').forEach(b => b.classList.remove('active'));
        const none = emojiRow.querySelector('button');
        if (none) none.classList.remove('active');
        refreshAvPreview();
    });
    btnAvatar.addEventListener('click', () => {
        meMenu.classList.remove('show');
        curEmoji = myProfile.avatarEmoji || null;
        curColor = myProfile.avatarColor || (me && me.color) || '#8aa9c9';
        curAvatarImage = myProfile.avatarImage || null;   // 已有上传头像 -> 预览
        curUploadBlob = null;
        colorPicker.value = /^#[0-9a-fA-F]{6}$/.test(curColor) ? curColor : '#8aa9c9';
        // emoji 选择器：标记当前激活
        emojiRow.innerHTML = '';
        const noneBtn = document.createElement('button');
        noneBtn.textContent = 'Aa'; noneBtn.style.fontSize = '14px'; noneBtn.style.fontWeight = '700';
        if (!curAvatarImage && curEmoji === null) noneBtn.classList.add('active');
        noneBtn.addEventListener('click', () => {
            curEmoji = null; curAvatarImage = null; curUploadBlob = null;
            document.querySelectorAll('#emojiRow button').forEach(b => b.classList.toggle('active', b === noneBtn));
            refreshAvPreview();
        });
        emojiRow.appendChild(noneBtn);
        for (const e of EMOJIS) {
            const b = document.createElement('button');
            b.textContent = e;
            if (!curAvatarImage && curEmoji === e) b.classList.add('active');
            b.addEventListener('click', () => {
                curEmoji = e; curAvatarImage = null; curUploadBlob = null;
                document.querySelectorAll('#emojiRow button').forEach(bb => bb.classList.toggle('active', bb === b));
                refreshAvPreview();
            });
            emojiRow.appendChild(b);
        }
        for (const pb of document.querySelectorAll('.preset-btn')) {
            pb.style.cssText += ';display:inline-block;width:22px;height:22px;border-radius:50%;border:1px solid #fff;cursor:pointer;vertical-align:middle;margin:2px;';
            pb.addEventListener('click', () => {
                curColor = pb.style.background; colorPicker.value = curColor; refreshAvPreview();
            });
        }
        colorPicker.oninput = () => { curColor = colorPicker.value; refreshAvPreview(); };
        refreshAvPreview(); avErr.textContent = '';
        avModal.classList.add('show');
    });
    avCancel.addEventListener('click', () => avModal.classList.remove('show'));
    avSubmit.addEventListener('click', async () => {
        avSubmit.disabled = true; avErr.textContent = '';
        try {
            // 若用户选了新图片：先上传到 /api/upload-avatar，再用 update-profile 把 avatarImage 切过去
            let finalAvatarImage = curAvatarImage;
            if (curUploadBlob) {
                avUploadBtn.disabled = true; avUploadBtn.textContent = '上传中…';
                const fd = new FormData();
                fd.append('file', curUploadBlob, 'avatar.webp');
                fd.append('token', getToken());
                const q = encodeURIComponent(getToken());
                const up = await fetch('/api/upload-avatar?token=' + q, { method: 'POST', body: fd });
                let upR = {}; try { upR = await up.json(); } catch { }
                avUploadBtn.disabled = false; avUploadBtn.textContent = '📁 选择本地图片…';
                if (!upR || !upR.ok) {
                    if (upR && upR.code === 'TOKEN_MISSING') { avErr.textContent = '未上传登录凭证，请刷新页面重新登录'; }
                    else if (upR && upR.code === 'TOKEN_INVALID') { avErr.textContent = '登录已过期，请重新登录'; showToast('登录已过期'); forceLogout('登录凭证无效'); }
                    else { avErr.textContent = upR.msg || '上传失败（HTTP ' + up.status + '）'; }
                    avSubmit.disabled = false; return;
                }
                finalAvatarImage = upR.url;
            }
            const r = await api('/api/update-profile', {
                token: getToken(),
                avatarEmoji: curAvatarImage ? '' : (curEmoji || ''),
                avatarColor: curColor || '',
                avatarImage: finalAvatarImage ? finalAvatarImage : null
            });
            if (!r.ok) { avErr.textContent = r.msg || '保存失败'; return; }
            myProfile.avatarEmoji = r.data.avatarEmoji;
            myProfile.avatarColor = r.data.avatarColor;
            myProfile.avatarImage = r.data.avatarImage;
            if (me) { me.avatarEmoji = r.data.avatarEmoji; me.avatarImage = r.data.avatarImage; }
            setMeUI({ username: me ? me.name : '', avatarEmoji: myProfile.avatarEmoji, avatarColor: myProfile.avatarColor || (me && me.color), avatarImage: myProfile.avatarImage });
            // 会话/侧边栏/顶部刷新（含私聊自己头像）
            renderSidebar(); fillHHeader();
            avModal.classList.remove('show'); showToast(finalAvatarImage ? '头像已上传并保存' : '头像已保存');
        } finally {
            avSubmit.disabled = false; avUploadBtn.disabled = false; avUploadBtn.textContent = '📁 选择本地图片…';
        }
    });

    // canvas 压缩 + 正方形居中裁剪，返回 Blob + dataURL
    function compressAndCrop(file, size = 192) {
        return new Promise(resolve => {
            const reader = new FileReader();
            reader.onload = () => {
                const img = new Image();
                img.onload = () => {
                    const w = img.naturalWidth, h = img.naturalHeight;
                    if (!w || !h) { resolve({ err: '图片读取失败' }); return; }
                    const s = Math.min(w, h);
                    const sx = (w - s) / 2, sy = (h - s) / 2;
                    const canvas = document.createElement('canvas');
                    canvas.width = size; canvas.height = size;
                    const ctx = canvas.getContext('2d');
                    ctx.imageSmoothingQuality = 'high';
                    ctx.drawImage(img, sx, sy, s, s, 0, 0, size, size);
                    canvas.toBlob(b => {
                        if (!b) { resolve({ err: '生成图片失败' }); return; }
                        resolve({ blob: b, dataURL: canvas.toDataURL('image/webp', 0.85) });
                    }, 'image/webp', 0.85);
                };
                img.onerror = () => resolve({ err: '无法解析该图片，请换一张' });
                img.src = reader.result;
            };
            reader.onerror = () => resolve({ err: '读取图片失败' });
            reader.readAsDataURL(file);
        });
    }

    // --- 修改用户名 ---
    btnUser.addEventListener('click', () => {
        meMenu.classList.remove('show');
        newUser.value = me ? me.name : ''; userPwd.value = ''; userErr.textContent = '';
        userModal.classList.add('show'); setTimeout(() => newUser.focus(), 50);
    });
    userCancel.addEventListener('click', () => userModal.classList.remove('show'));
    userSubmit.addEventListener('click', async () => {
        const nn = newUser.value.trim(); const pwd = userPwd.value;
        if (!/^[\w\u4e00-\u9fff]{2,16}$/.test(nn)) { userErr.textContent = '新用户名需 2-16 位'; return; }
        if (!pwd) { userErr.textContent = '请输入当前密码'; return; }
        userSubmit.disabled = true; userErr.textContent = '';
        const r = await api('/api/change-username', { token: getToken(), newUsername: nn, password: pwd });
        userSubmit.disabled = false;
        if (!r.ok) { userErr.textContent = r.msg || '修改失败'; return; }
        userModal.classList.remove('show');
        showToast('用户名已修改为「' + r.data.username + '」');
        // UI 更新会在 rename 广播时做，这里手动刷新自己
        if (me) { me.name = r.data.username; }
        setMeUI({ username: r.data.username, avatarEmoji: myProfile.avatarEmoji, avatarColor: myProfile.avatarColor || (me && me.color) });
        renderSidebar();
    });

    // ---------- Toast / 工具 ----------
    function showToast(text) {
        toast.textContent = text;
        toast.classList.add('show');
        clearTimeout(showToast._t);
        showToast._t = setTimeout(() => toast.classList.remove('show'), 2800);
    }
    function truncate(s, n) { s = (s == null ? '' : s) + ''; return s.length > n ? s.slice(0, n) + '…' : s; }
    function fmtTime(ts) {
        const d = new Date(ts || Date.now());
        const hh = d.getHours().toString().padStart(2, '0');
        const mm = d.getMinutes().toString().padStart(2, '0');
        return `${hh}:${mm}`;
    }

    // ---------- 侧栏会话列表渲染 ----------
    sbSearch.addEventListener('input', () => { searchQuery = sbSearch.value.trim().toLowerCase(); renderSidebar(); });
    function renderSidebar() {
        sbList.innerHTML = '';
        const q = searchQuery;
        const arr = [...sessions.values()].sort((a, b) => {
            if (a.id === HALL) return -1; if (b.id === HALL) return 1;
            return (b.lastTime || 0) - (a.lastTime || 0);
        });
        for (const s of arr) {
            if (q) {
                if (!s.name.toLowerCase().includes(q) && !(s.lastText || '').toLowerCase().includes(q)) continue;
            }
            const el = document.createElement('div');
            el.className = 'conv' + (s.id === curSessionId ? ' active' : '');
            const av = document.createElement('div'); av.className = 'c-av'; fillAvatar(av, s);
            const info = document.createElement('div'); info.className = 'c-info';
            const top = document.createElement('div'); top.className = 'c-top';
            const name = document.createElement('span'); name.className = 'c-name'; name.textContent = s.name;
            const time = document.createElement('span'); time.className = 'c-time'; time.textContent = s.lastTime ? fmtTime(s.lastTime) : '';
            top.appendChild(name); top.appendChild(time);
            const prev = document.createElement('span'); prev.className = 'c-preview'; prev.textContent = s.lastText || (s.id === HALL ? '说点什么，开始群聊吧' : '发个消息，开始聊天');
            info.appendChild(top); info.appendChild(prev);
            el.appendChild(av); el.appendChild(info);
            if (s.unread > 0) {
                const badge = document.createElement('span'); badge.className = 'c-badge'; badge.textContent = s.unread > 99 ? '99+' : s.unread;
                el.appendChild(badge);
            } else if (s.id !== HALL && s.isPrivate) {
                const dotOnline = (s.withId && userList.has(s.withId)) || (s.peerUsername && friendInfoMap.get(s.peerUsername)?.online);
                if (dotOnline) {
                    const d = document.createElement('span'); d.className = 'c-dot'; d.style.background = '#7fcf8f'; d.title = '在线';
                    el.appendChild(d);
                }
            }
            el.addEventListener('click', () => switchSession(s.id));
            sbList.appendChild(el);
        }
    }
    function switchSession(id) {
        // 退出代码模式
        if (codeMode) { codeMode = false; codeBtn.classList.remove('active'); codeInputWrap.style.display = 'none'; input.style.display = ''; sendBtn.style.display = ''; codeBtn.style.display = ''; }
        if (!sessions.has(id)) return;
        curSessionId = id;
        const s = sessions.get(id);
        s.unread = 0;
        fillHHeader();
        chatBody.innerHTML = '';
        for (const m of s.messages) chatBody.appendChild(renderMsgNode(m, /*skipAttach*/ true));
        chatBody.scrollTop = chatBody.scrollHeight;
        if (s.isPrivate) {
            if (!s.isFriend || !isFriendOfMine(s.peerUsername)) {
                input.disabled = false;
                input.placeholder = `发一条消息给 ${s.peerUsername || s.name}，会自动加为好友…`;
            } else {
                input.disabled = false;
                input.placeholder = `发送私聊给 ${s.name}… 输入 @ 艾特在线用户`;
            }
        } else {
            input.disabled = false;
            input.placeholder = '说点什么… 输入 @ 艾特在线用户';
        }
        renderSidebar();
        input.focus();
    }

    function fillHHeader() {
        const s = sessions.get(curSessionId) || sessions.get(HALL);
        fillAvatar(hAvatar, s);
        hName.textContent = s.name;
        hSub.textContent = s.sub || (s.isPrivate ? '一对一私聊' : '所有人的公共聊天');
    }

    // ---------- 会话接收新消息 ----------
    function dispatchMsg(sessionId, data) {
        const s = sessions.get(sessionId); if (!s) return;
        s.messages.push(data);
        if (s.messages.length > 500) s.messages.splice(0, s.messages.length - 500);
        if (!data.sys) {
            s.lastText = (data.quote ? '引用: ' : '') + (data.text || '');
            s.lastTime = Date.now();
        }
        if (sessionId === curSessionId) {
            chatBody.appendChild(renderMsgNode(data, true));
            chatBody.scrollTop = chatBody.scrollHeight;
            while (chatBody.children.length > 500) chatBody.removeChild(chatBody.firstChild);
        } else {
            s.unread = Math.min(999, s.unread + 1);
        }
        renderSidebar();
    }

    // ---------- 消息节点工厂（可复用到切换会话时）----------
    function renderMsgNode(data) {
        const div = document.createElement('div');
        div.className = 'msg';
        const bubble = document.createElement('div');
        bubble.className = 'bubble';

        if (data.sys) {
            div.classList.add('sys');
            bubble.textContent = data.text;
        } else {
            // 按 uid 解析当前名字（改名后历史消息自动跟随）；找不到则回退快照名
            const uidInfo = data.from ? uidProfile.get(data.from) : null;
            const dispName = (uidInfo && uidInfo.name) || data.name || '';
            const isSelf = (data.from && data.from === me?.uid) || data.id === me?.id;
            const isPrivate = !!data.typePrivate;
            div.classList.add(isSelf ? 'self' : 'other');
            if (isPrivate) div.classList.add('private');
            if (data.mid) { div.dataset.mid = data.mid; bubble.dataset.msgId = data.mid; }
            bubble.dataset.msgName = dispName;
            bubble.dataset.msgIsSelf = isSelf ? '1' : '0';
            bubble.dataset.msgText = data.text || '';
            if (!isSelf && (uidInfo?.color || data.color)) bubble.style.setProperty('--c', uidInfo?.color || data.color);

            if (data.quote && data.quote.text) {
                const qb = document.createElement('div'); qb.className = 'qbox';
                const qn = document.createElement('span'); qn.className = 'qname'; qn.textContent = data.quote.name || '';
                const qt = document.createElement('span'); qt.className = 'qtext'; qt.textContent = truncate(data.quote.text, 60);
                qb.appendChild(qn); qb.appendChild(qt); bubble.appendChild(qb);
            }
            if (!isSelf) {
                const nameTag = document.createElement('span');
                nameTag.className = 'name-tag';
                nameTag.style.color = uidInfo?.color || data.color;
                nameTag.textContent = dispName;
                nameTag.addEventListener('click', () => {
                    if (!data.id || data.id === me?.id) return;
                    const u = userList.get(data.id);
                    const targetName = (uidInfo && uidInfo.name) || (u ? u.name : data.name) || dispName;
                    const sess = ensurePrivate(data.id, targetName, u ? u.color : (uidInfo?.color || data.color), u ? u.avatarEmoji : (uidInfo?.avatarEmoji || null), u ? u.avatarImage : (uidInfo?.avatarImage || null));
                    if (!sess) return;
                    // 发消息时自动成好友，这里不再拦截；直接切到私聊
                    switchSession(sess.id);
                });
                bubble.appendChild(nameTag);
            }
            if (isPrivate && data.toName) {
                const badge = document.createElement('span');
                badge.className = 'private-badge';
                badge.textContent = isSelf ? `私聊 ${data.toName}` : '私聊';
                bubble.appendChild(badge);
            }
            if (data.language) {
                // 代码消息
                bubble.dataset.msgLanguage = data.language;
                const codeBlock = document.createElement('div');
                codeBlock.className = 'code-block';
                const header = document.createElement('div');
                header.className = 'code-block-header';
                const langSpan = document.createElement('span');
                langSpan.className = 'code-block-lang';
                langSpan.textContent = data.language;
                const copyBtn = document.createElement('button');
                copyBtn.className = 'code-block-copy';
                copyBtn.textContent = '复制';
                copyBtn.addEventListener('click', () => {
                    navigator.clipboard.writeText(data.text).then(() => {
                        copyBtn.textContent = '已复制';
                        copyBtn.classList.add('copied');
                        setTimeout(() => { copyBtn.textContent = '复制'; copyBtn.classList.remove('copied'); }, 2000);
                    }).catch(() => showToast('复制失败'));
                });
                header.appendChild(langSpan);
                header.appendChild(copyBtn);
                const body = document.createElement('div');
                body.className = 'code-block-body';
                body.textContent = data.text;
                codeBlock.appendChild(header);
                codeBlock.appendChild(body);
                bubble.appendChild(codeBlock);
            } else {
                const textFrag = renderTextWithMentions(data.text, data.mentions);
                bubble.appendChild(textFrag);
            }
        }

        div.appendChild(bubble);
        return div;
    }

    // ---------- 撤回消息（跨会话找 DOM + 替换）----------
    function applyRevoke(mid, byName, peerId) {
        // 找当前 chatBody 里对应的 live DOM 替换
        const selector = '.msg[data-mid="' + mid + '"]';
        const live = chatBody.querySelector(selector);
        if (live) {
            live.className = 'msg sys';
            const b = live.querySelector('.bubble');
            if (b) {
                b.className = 'bubble'; b.textContent = byName + ' 撤回了一条消息';
                for (const k of ['msgId', 'msgIsSelf', 'msgName', 'msgText']) b.removeAttribute('data-' + k.toLowerCase());
            }
        }
        // 同步改 sessions 里的 data
        let affectedSessions = 0;
        for (const s of sessions.values()) {
            for (let i = 0; i < s.messages.length; i++) {
                if (s.messages[i].mid === mid) {
                    s.messages[i] = { sys: true, text: byName + ' 撤回了一条消息' };
                    affectedSessions++;
                    break;
                }
            }
        }
        // 如果此 mid 不在任何已知会话里，可能是对方（peerId）的会话 -> 强制同步一次
        if (affectedSessions === 0 && peerId) {
            const sk = 'p_' + peerId;
            const s = sessions.get(sk);
            if (s) {
                s.messages.push({ sys: true, text: byName + ' 撤回了一条消息' });
            }
        }
    }

    // ---------- 用户列表（右侧抽屉）----------
    usersToggle.addEventListener('click', () => usersPanel.style.transform = usersPanel.style.transform === 'translateX(0)' ? 'translateX(100%)' : 'translateX(0)');
    usersPanelClose.addEventListener('click', () => usersPanel.style.transform = 'translateX(100%)');
    function renderUsers() {
        usersList.innerHTML = '';
        for (const [id, u] of userList) {
            const isMe = id === me?.id;
            const div = document.createElement('div');
            div.style.cssText = 'display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:10px;margin-bottom:2px;font-size:13px;cursor:pointer;transition:background .15s;';
            if (!isMe) div.addEventListener('mouseenter', () => div.style.background = 'rgba(0,0,0,.04)');
            if (!isMe) div.addEventListener('mouseleave', () => div.style.background = '');
            const av = document.createElement('div');
            av.style.cssText = 'width:28px;height:28px;border-radius:50%;overflow:hidden;display:grid;place-items:center;color:#fff;font-weight:700;font-size:12px;';
            fillAvatar(av, { ...u, name: u.name });
            const nm = document.createElement('span');
            nm.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
            nm.textContent = u.name + (isMe ? ' （我）' : '');
            div.appendChild(av); div.appendChild(nm);
            if (!isMe) {
                div.addEventListener('click', () => {
                    const key = 'p_' + id;
                    ensurePrivate(id, u.name, u.color, u.avatarEmoji, u.avatarImage);
                    switchSession(key);
                    usersPanel.style.transform = 'translateX(100%)';
                });
            }
            usersList.appendChild(div);
        }
    }
    function setCount(n) { onlineBadge.textContent = n + ' 在线'; }

    // ---------- @ 艾特渲染 ----------
    function renderTextWithMentions(text, mentions) {
        if (!mentions || mentions.length === 0) return document.createTextNode(text);
        const nameToId = {};
        for (const mid of mentions) { const u = userList.get(mid); if (u) nameToId[u.name] = mid; }
        if (Object.keys(nameToId).length === 0) return document.createTextNode(text);
        const names = Object.keys(nameToId).sort((a, b) => b.length - a.length);
        const escaped = names.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        const re = new RegExp('@(' + escaped.join('|') + ')', 'g');
        const parts = text.split(re);
        const frag = document.createDocumentFragment();
        let idx = 0;
        for (const part of parts) {
            if (idx % 2 === 0) { frag.appendChild(document.createTextNode(part)); }
            else {
                const span = document.createElement('span');
                span.className = 'at-mention'; span.textContent = '@' + part;
                const uid = nameToId[part];
                if (uid) {
                    span.addEventListener('click', () => {
                        if (uid === me?.id) return;
                        const key = 'p_' + uid;
                        if (!sessions.has(key)) { const u = userList.get(uid); ensurePrivate(uid, u.name, u.color, u.avatarEmoji); }
                        switchSession(key);
                    });
                }
                frag.appendChild(span);
            }
            idx++;
        }
        return frag;
    }

    // ---------- @ 艾特输入 ----------
    let atState = null;
    function updateAtDropdown() {
        if (!atState) { atDropdown.classList.remove('show'); atDropdown.innerHTML = ''; return; }
        const q = atState.query.toLowerCase(); const items = [];
        for (const [id, u] of userList) {
            if (id === me?.id) continue;
            if (q === '' || u.name.toLowerCase().includes(q)) items.push({ id, name: u.name, color: u.color });
        }
        if (items.length === 0) { atDropdown.classList.remove('show'); return; }
        atDropdown.classList.add('show'); atDropdown.innerHTML = '';
        items.forEach((item, i) => {
            const div = document.createElement('div');
            div.className = 'at-item' + (i === 0 ? ' active' : '');
            div.innerHTML = `<span class="at-dot" style="background:${item.color}"></span><span>${item.name}</span><span class="at-name-tag">@${item.name}</span>`;
            div.addEventListener('click', () => selectAt(item));
            atDropdown.appendChild(div);
        });
        atDropdown._items = items;
    }
    function selectAt(item) {
        if (!atState) return;
        const before = input.value.slice(0, atState.start);
        const after = input.value.slice(atState.start + atState.query.length + 1);
        input.value = before + '@' + item.name + ' ' + after;
        const pos = before.length + item.name.length + 2;
        input.setSelectionRange(pos, pos);
        atState = null; updateAtDropdown(); input.focus();
    }
    input.addEventListener('input', () => {
        const pos = input.selectionStart; const val = input.value; let atPos = -1;
        for (let i = pos - 1; i >= 0; i--) {
            const ch = val[i]; if (ch === '@') { atPos = i; break; }
            if (ch === ' ' || ch === '\n') break;
        }
        if (atPos >= 0) {
            const query = val.slice(atPos + 1, pos);
            if (/^[\w\u4e00-\u9fff]*$/.test(query)) { atState = { start: atPos, query }; updateAtDropdown(); return; }
        }
        atState = null; updateAtDropdown();
    });
    input.addEventListener('keydown', e => {
        if (atState && atDropdown.classList.contains('show')) {
            const items = atDropdown._items || [];
            if (e.key === 'ArrowDown' || e.key === 'Tab') {
                e.preventDefault();
                const active = atDropdown.querySelector('.at-item.active');
                if (active) { const next = active.nextElementSibling; active.classList.remove('active'); if (next) next.classList.add('active'); }
                else { const f = atDropdown.firstElementChild; if (f) f.classList.add('active'); }
                return;
            }
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                const active = atDropdown.querySelector('.at-item.active');
                if (active) { const prev = active.previousElementSibling; active.classList.remove('active'); if (prev) prev.classList.add('active'); }
                return;
            }
            if (e.key === 'Enter' || e.key === ' ') {
                const active = atDropdown.querySelector('.at-item.active');
                if (active) {
                    e.preventDefault();
                    const idx = Array.from(atDropdown.children).indexOf(active);
                    if (idx >= 0 && items[idx]) selectAt(items[idx]);
                    return;
                }
            }
            if (e.key === 'Escape') { atState = null; updateAtDropdown(); e.preventDefault(); return; }
        }
        if (e.key === 'Enter' && !e.shiftKey && !atState) sendMessage();
    });
    input.addEventListener('blur', () => setTimeout(() => { atState = null; updateAtDropdown(); }, 150));

    function parseMentions(text) {
        const ids = [];
        for (const [id, u] of userList) {
            if (id === me?.id) continue;
            const re = new RegExp('@' + u.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:\\s|$|\\n)');
            if (re.test(text)) ids.push(id);
        }
        return ids;
    }

    // ---------- 引用 ----------
    function startQuote(name, text) {
        quoting = { name, text };
        qbarName.textContent = name; qbarText.textContent = truncate(text, 50);
        quoteBar.classList.add('show'); input.focus();
    }
    function clearQuote() { quoting = null; quoteBar.classList.remove('show'); }
    $('qbarCancel').addEventListener('click', clearQuote);
    function doRevoke(mid) { if (!ws || ws.readyState !== 1 || !mid) return; ws.send(JSON.stringify({ type: 'revoke', mid })); }

    // ---------- 右键菜单 ----------
    function hideCtxMenu() { ctxMenu.classList.remove('show'); ctxMenuData.current = null; }
    document.addEventListener('click', hideCtxMenu);
    document.addEventListener('keydown', e => { if (e.key === 'Escape') hideCtxMenu(); });
    document.addEventListener('contextmenu', (e) => {
        const bubble = e.target.closest ? e.target.closest('.bubble') : null;
        if (!bubble || bubble.dataset.msgId === undefined) {
            // 不在聊天气泡上：隐藏菜单
            hideCtxMenu(); return;
        }
        e.preventDefault();
        const mid = bubble.dataset.msgId;
        const isSelf = bubble.dataset.msgIsSelf === '1';
        const name = bubble.dataset.msgName || '';
        const text = bubble.dataset.msgText || '';
        ctxMenuData.current = { mid, isSelf, name, text };

        const items = [];
        items.push({ k: 'quote', label: '引用回复', danger: false, disabled: false });
        items.push({ k: 'copy', label: '复制文本', danger: false, disabled: !text });
        items.push({ divider: true });
        items.push({ k: 'revoke', label: '撤回此消息', danger: true, disabled: !isSelf });

        ctxMenu.innerHTML = '';
        for (const it of items) {
            if (it.divider) {
                const d = document.createElement('div'); d.className = 'c-div'; ctxMenu.appendChild(d); continue;
            }
            const b = document.createElement('div');
            b.className = 'c-item' + (it.danger ? ' danger' : '') + (it.disabled ? ' disabled' : '');
            b.textContent = it.label;
            if (!it.disabled) {
                b.addEventListener('click', () => handleCtxAction(it.k));
            }
            ctxMenu.appendChild(b);
        }

        // 定位：不超出视口
        const pad = 6;
        let x = e.clientX, y = e.clientY;
        ctxMenu.classList.add('show');
        const m = ctxMenu.getBoundingClientRect();
        if (x + m.width + pad > window.innerWidth) x = window.innerWidth - m.width - pad;
        if (y + m.height + pad > window.innerHeight) y = window.innerHeight - m.height - pad;
        ctxMenu.style.left = Math.max(0, x) + 'px';
        ctxMenu.style.top = Math.max(0, y) + 'px';
    });
    async function handleCtxAction(kind) {
        const d = ctxMenuData.current; if (!d) return; hideCtxMenu();
        switch (kind) {
            case 'quote': startQuote(d.name, d.text); break;
            case 'copy':
                try {
                    await navigator.clipboard.writeText(d.text);
                    showToast('已复制到剪贴板');
                } catch { showToast('复制失败'); }
                break;
            case 'revoke': doRevoke(d.mid); break;
        }
    }

    // ---------- 发送消息 ----------
    function findIdByName(name) {
        for (const [id, info] of userList) { if (info.name === name) return id; }
        return null;
    }
    function sendMessage() {
        const text = input.value.trim();
        if (!text || !ws || ws.readyState !== 1) return;
        const cur = sessions.get(curSessionId);
        if (cur && cur.isPrivate) {
            const peerName = cur.peerUsername || cur.name;
            // 发消息即自动成好友（服务端处理），前端不再拦截
            // toId 可能历史会话初始无值；每次发送前重新按 peerUsername 或 cur.name 反查
            let toId = cur.withId;
            if (!toId || !userList.has(toId)) {
                const realId = findIdByName(peerName);
                if (realId) { toId = realId; cur.withId = realId; }
            }
            if (!toId) {
                // 对方不在线时也要投出（服务端通过 toName 定位离线收信人）
                toId = 'offline_' + escapeJsKey(peerName);
            }
            const mentions = parseMentions(text);
            const payload = { type: 'private', text, to: toId, toName: peerName, mentions };
            if (quoting) payload.quote = quoting;
            ws.send(JSON.stringify(payload));
            clearQuote();
        } else {
            const mentions = parseMentions(text);
            const payload = { type: 'chat', text, mentions };
            if (quoting) payload.quote = quoting;
            ws.send(JSON.stringify(payload));
            clearQuote();
        }
        input.value = '';
        clearTimeout(typingTimer); if (ws && me) ws.send(JSON.stringify({ type: 'typing', on: false }));
        input.focus();
    }
    sendBtn.addEventListener('click', sendMessage);

    // ---------- 发送代码消息 ----------
    function sendCodeMessage() {
        const text = codeInput.value.trim();
        if (!text || !ws || ws.readyState !== 1) return;
        if (text.length > 5000) { showToast('⚠️ 代码不能超过 5000 字'); return; }
        ws.send(JSON.stringify({ type: 'code', language: 'code', text }));
        codeInput.value = '';
        codeCharCount.textContent = '0/5000';
        // 退出代码模式
        codeMode = false;
        codeBtn.classList.remove('active');
        codeInputWrap.style.display = 'none';
        input.style.display = '';
        sendBtn.style.display = '';
        codeBtn.style.display = '';
        input.focus();
    }

    // ---------- 代码模式 ----------
    let codeMode = false;
    codeBtn.addEventListener('click', () => {
        codeMode = !codeMode;
        codeBtn.classList.toggle('active', codeMode);
        codeInputWrap.style.display = codeMode ? 'flex' : 'none';
        input.style.display = codeMode ? 'none' : '';
        sendBtn.style.display = codeMode ? 'none' : '';
        codeBtn.style.display = codeMode ? 'none' : '';
        if (codeMode) { codeInput.value = ''; codeCharCount.textContent = '0/5000'; codeInput.focus(); }
        else { input.focus(); }
    });
    codeCancel.addEventListener('click', () => { codeMode = false; codeBtn.classList.remove('active'); codeInputWrap.style.display = 'none'; input.style.display = ''; sendBtn.style.display = ''; codeBtn.style.display = ''; input.focus(); });
    codeSend.addEventListener('click', sendCodeMessage);
    codeInput.addEventListener('input', () => {
        const len = codeInput.value.length;
        codeCharCount.textContent = len + '/5000';
    });
    // 代码模式 Ctrl+Enter 发送
    codeInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendCodeMessage(); }
    });

    let typingTimer = null;
    let mutedTimer = null;
    input.addEventListener('input', () => {
        if (!ws || ws.readyState !== 1 || !me) return;
        ws.send(JSON.stringify({ type: 'typing', on: true }));
        clearTimeout(typingTimer);
        typingTimer = setTimeout(() => { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'typing', on: false })); }, 1500);
    });
    input.addEventListener('blur', () => {
        clearTimeout(typingTimer);
        if (ws && ws.readyState === 1 && me) ws.send(JSON.stringify({ type: 'typing', on: false }));
    });

    // ---------- 光标 ----------
    const cursorsLayer = $('cursors');
    const stage = $('stage'), hintText = $('hintText');
    function ensureCursor(id, name, color, avatarEmoji, avatarImage) {
        let c = cursors.get(id);
        if (!c) {
            const el = document.createElement('div');
            el.className = 'cursor';
            el.style.setProperty('--c', color);
            el.innerHTML = `
        <svg class="arrow" width="18" height="20" viewBox="0 0 16 20">
          <path d="M2 2 L2 15 L5.5 11.5 L8 17 L10 16 L7.5 10.5 L12 10.5 Z"
            fill="${color}" stroke="#fff" stroke-width="1.1" stroke-linejoin="round"/>
        </svg>
        <div class="tag"></div>
        <div class="tip">正在输入…</div>`;
            cursorsLayer.appendChild(el);
            const mx = window.innerWidth / 2, my = window.innerHeight / 2;
            c = { el, x: mx, y: my, tx: mx, ty: my, name };
            cursors.set(id, c);
            hintText.style.display = 'none';
        }
        if (name !== undefined) c.name = name;
        if (color !== undefined) {
            c.el.style.setProperty('--c', color);
            const svg = c.el.querySelector('svg path');
            if (svg) svg.setAttribute('fill', color);
        }
        const tag = c.el.querySelector('.tag');
        const info = { name: c.name, color: color || '#8aa9c9', avatarEmoji, avatarImage };
        tag.innerHTML = `<span class="mini-av">${avHTML({ ...info, name: c.name })}</span> <span class="tag-text"></span>`;
        tag.querySelector('.tag-text').textContent = c.name;
        return c;
    }
    function removeCursor(id) {
        const c = cursors.get(id); if (c) { c.el.remove(); cursors.delete(id); }
        if (cursors.size === 0) hintText.style.display = '';
    }
    function tick() {
        for (const c of cursors.values()) {
            c.x += (c.tx - c.x) * 0.35;
            c.y += (c.ty - c.y) * 0.35;
            c.el.style.transform = `translate3d(${c.x.toFixed(2)}px, ${c.y.toFixed(2)}px, 0)`;
        }
        requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);

    document.addEventListener('mousemove', e => {
        if (!ws || ws.readyState !== 1) return;
        const now = performance.now();
        if (now - lastSend < 33) return;
        lastSend = now;
        ws.send(JSON.stringify({ type: 'move', x: e.clientX, y: e.clientY }));
    });
    document.addEventListener('touchmove', e => {
        if (!ws || ws.readyState !== 1) return;
        const t = e.touches[0]; if (!t) return;
        ws.send(JSON.stringify({ type: 'move', x: t.clientX, y: t.clientY }));
    }, { passive: true });

    // ---------- WebSocket ----------
    function connectToHall() {
        const token = getToken();
        overlayHint.innerHTML = '正在连接服务器…';
        try { ws = new WebSocket(WS_URL); }
        catch { overlayHint.innerHTML = '连接失败，请刷新重试'; return; }

        ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'join', token })));

        ws.addEventListener('message', ev => {
            let m; try { m = JSON.parse(ev.data); } catch { return; }
            switch (m.type) {
                case 'auth_error':
                case 'kick':
                    showToast(m.msg || (m.type === 'auth_error' ? '登录已失效' : '账号已在其他地方登录'));
                    forceLogout(m.msg || '请重新登录');
                    return;
                case 'welcome':
                    me = { id: m.id, uid: m.uid || null, name: m.name, color: m.color, avatarEmoji: m.avatarEmoji || null, avatarImage: m.avatarImage || null };
                    // 填充 uid -> 资料 映射（历史消息按 uid 渲染名字/头像）
                    uidProfile.clear();
                    if (m.uidProfiles && typeof m.uidProfiles === 'object') {
                        for (const uid of Object.keys(m.uidProfiles)) {
                            const p = m.uidProfiles[uid]; if (!p) continue;
                            uidProfile.set(uid, { name: p.name || uid, color: p.color || null, avatarEmoji: p.avatarEmoji || null, avatarColor: p.avatarColor || null, avatarImage: p.avatarImage || null });
                        }
                    }
                    // 在线用户也带 uid，补进映射
                    for (const u of (m.users || [])) {
                        if (u && u.uid) uidProfile.set(u.uid, { name: u.name || u.uid, color: u.color || null, avatarEmoji: u.avatarEmoji || null, avatarColor: u.color || null, avatarImage: u.avatarImage || null });
                    }
                    myProfile.avatarEmoji = m.avatarEmoji || null;
                    myProfile.avatarColor = m.avatarColor || null;
                    myProfile.avatarImage = m.avatarImage || null;
                    setMeUI({ username: m.name, avatarEmoji: myProfile.avatarEmoji, avatarColor: myProfile.avatarColor || m.color, avatarImage: myProfile.avatarImage });
                    userList.set(m.id, { name: m.name, color: m.color, avatarEmoji: m.avatarEmoji || null, avatarImage: m.avatarImage || null });
                    // 初始化好友集合（基于 username，稳定不变）
                    friendSet.clear(); friendInfoMap.clear();
                    const welcomeFriends = Array.isArray(m.friends) ? m.friends : [];
                    for (const fu of welcomeFriends) friendSet.add(fu);
                    updateFriendCountBadge();
                    // 初始化会话
                    ensureHall();
                    for (const u of m.users) {
                        if (u.id === me.id) continue;
                        userList.set(u.id, { name: u.name, uid: u.uid || null, color: u.color, avatarEmoji: u.avatarEmoji || null, avatarImage: u.avatarImage || null });
                        if (u.uid) uidProfile.set(u.uid, { name: u.name || u.uid, color: u.color || null, avatarEmoji: u.avatarEmoji || null, avatarColor: u.color || null, avatarImage: u.avatarImage || null });
                        ensureCursor(u.id, u.name, u.color, u.avatarEmoji, u.avatarImage);
                        // 在线的好友：同步 onlineId + info
                        if (friendSet.has(u.name)) {
                            friendInfoMap.set(u.name, { online: true, onlineId: u.id, avatarEmoji: u.avatarEmoji || null, avatarColor: u.color, avatarImage: u.avatarImage || null });
                        }
                    }
                    // 为每位好友先建会话（哪怕还没历史），放在会话列表里能被看见
                    for (const fu of friendSet) {
                        if (fu === me.name) continue;
                        const info = friendInfoMap.get(fu) || {};
                        ensurePrivate(info.onlineId || null, fu, info.avatarColor || null, info.avatarEmoji || null, info.avatarImage || null);
                    }
                    // 应用服务端下发的历史：大厅 + 所有我参与过的私聊
                    if (m.history && typeof m.history === 'object') {
                        const hall = Array.isArray(m.history.hall) ? m.history.hall : [];
                        for (const msg of hall) {
                            if (!msg || !msg.mid) continue;
                            // 按服务端消息格式直接转成渲染格式（chat type，mid/id/name/color/text/.../ts）
                            sessions.get(HALL).messages.push(Object.assign({}, msg));
                            // 更新 lastText / lastTime
                            if (msg.text) { sessions.get(HALL).lastText = (msg.quote ? '引用 ' : '') + msg.text; sessions.get(HALL).lastTime = msg.ts || Date.now(); }
                        }
                        if (hall.length > 0) { sessions.get(HALL).lastTime = hall[hall.length - 1].ts || Date.now(); }
                        const privMap = (m.history.private && typeof m.history.private === 'object') ? m.history.private : {};
                        const peerUidMap = (m.peerUidMap && typeof m.peerUidMap === 'object') ? m.peerUidMap : {};
                        for (const peerUser of Object.keys(privMap)) {
                            if (!peerUser || peerUser === me.name) continue;
                            const arr = privMap[peerUser] || [];
                            const peerUid = peerUidMap[peerUser] || null;
                            // 对方发的最后一条（from 为对方 uid），用于 color/avatar 快照
                            const lastFromPeer = [...arr].reverse().find(x => x && peerUid && x.from === peerUid);
                            const sampleColor = (lastFromPeer && lastFromPeer.color) || (friendInfoMap.get(peerUser)?.avatarColor) || '#8aa9c9';
                            const sampleEmoji = (lastFromPeer && lastFromPeer.avatarEmoji) || (friendInfoMap.get(peerUser)?.avatarEmoji) || null;
                            const sampleImage = (lastFromPeer && lastFromPeer.avatarImage) || (friendInfoMap.get(peerUser)?.avatarImage) || null;
                            const sess = ensurePrivate(null, peerUser, sampleColor, sampleEmoji, sampleImage);
                            if (!sess) continue;
                            // 如果该用户在线，刷新 withId
                            for (const [cid, info] of userList) { if (info.name === peerUser) { sess.withId = cid; break; } }
                            for (const msg of arr) {
                                if (!msg || !msg.mid) continue;
                                // 转化为渲染结构：from 为 uid，名字/头像由 renderMsgNode 按 uid 解析
                                const isMe = msg.from === me.uid;
                                const node = {
                                    typePrivate: true,
                                    mid: msg.mid, ts: msg.ts,
                                    from: msg.from,
                                    id: isMe ? me.id : (sess.withId || ('off_' + escapeJsKey(msg.from || ''))),
                                    name: msg.fromName || msg.from,
                                    color: msg.color || sampleColor,
                                    avatarEmoji: msg.avatarEmoji || null,
                                    avatarImage: msg.avatarImage || null,
                                    text: msg.text || '', quote: msg.quote || null,
                                    mentions: msg.mentions || []
                                };
                                sess.messages.push(node);
                                if (msg.text) { sess.lastText = (msg.quote ? '引用 ' : '') + msg.text; sess.lastTime = msg.ts || sess.lastTime; }
                            }
                            if (arr.length > 0) { sess.lastTime = arr[arr.length - 1].ts || sess.lastTime; }
                        }
                    }
                    // 切换到大厅并显示外壳
                    overlay.style.display = 'none';
                    shell.classList.remove('hidden');
                    connDot.classList.remove('off');
                    setCount(m.users.length);
                    renderUsers();
                    curSessionId = HALL;
                    fillHHeader();
                    // 把历史刷进 chatBody
                    chatBody.innerHTML = '';
                    const startSession = sessions.get(curSessionId) || sessions.get(HALL);
                    for (const x of (startSession ? startSession.messages : [])) chatBody.appendChild(renderMsgNode(x, true));
                    chatBody.scrollTop = chatBody.scrollHeight;
                    if (sessions.get(HALL).messages.length === 0) dispatchMsg(HALL, { sys: true, text: `你以「${m.name}」进入了大厅` });
                    else dispatchMsg(HALL, { sys: true, text: `欢迎回来「${m.name}」！` });
                    // 登录即同步禁言状态（持久化在账号上，重登/改名都不丢）
                    if (m.mutedUntil && m.mutedUntil > Date.now()) {
                        const rem = Math.ceil((m.mutedUntil - Date.now()) / 1000);
                        input.disabled = true;
                        input.placeholder = `禁言中……，剩余 ${rem} 秒…`;
                        showToast(`🔇 你处于禁言中，剩余 ${rem} 秒`);
                        clearTimeout(mutedTimer);
                        mutedTimer = setTimeout(() => {
                            input.disabled = false;
                            input.placeholder = '说点什么… 输入 @ 艾特在线用户';
                        }, rem * 1000);
                    }
                    input.focus();
                    break;
                case 'enter':
                    userList.set(m.id, { name: m.name, uid: m.uid || null, color: m.color, avatarEmoji: m.avatarEmoji || null, avatarImage: m.avatarImage || null });
                    if (m.uid) uidProfile.set(m.uid, { name: m.name || m.uid, color: m.color || null, avatarEmoji: m.avatarEmoji || null, avatarColor: m.color || null, avatarImage: m.avatarImage || null });
                    // 若是好友，标记在线并同步会话 withId（头像用快照，不实时更换）
                    if (friendSet.has(m.name)) {
                        const fi = friendInfoMap.get(m.name) || { online: false, onlineId: null, avatarEmoji: null, avatarColor: null, avatarImage: null };
                        fi.online = true; fi.onlineId = m.id;
                        fi.avatarEmoji = m.avatarEmoji || fi.avatarEmoji; fi.avatarColor = m.color || fi.avatarColor; fi.avatarImage = m.avatarImage || fi.avatarImage;
                        friendInfoMap.set(m.name, fi);
                        const sk = friendSessionKey(m.name);
                        const sess = sessions.get(sk);
                        if (sess) { sess.withId = m.id; }
                    }
                    renderUsers(); renderSidebar();
                    ensureCursor(m.id, m.name, m.color, m.avatarEmoji, m.avatarImage);
                    setCount(userList.size);
                    dispatchMsg(HALL, { sys: true, text: `${m.name} 进入了大厅` });
                    break;
                case 'profile-update': {
                    const u = userList.get(m.id);
                    if (u) { u.name = m.name; u.color = m.color; u.avatarEmoji = m.avatarEmoji || null; u.avatarImage = m.avatarImage || null; }
                    if (me && me.id === m.id) {
                        me.name = m.name; me.color = m.color; me.avatarEmoji = m.avatarEmoji || null; me.avatarImage = m.avatarImage || null;
                        myProfile.avatarEmoji = m.avatarEmoji || null; myProfile.avatarColor = m.color; myProfile.avatarImage = m.avatarImage || null;
                        setMeUI({ username: m.name, avatarEmoji: myProfile.avatarEmoji, avatarColor: myProfile.avatarColor, avatarImage: myProfile.avatarImage });
                    }
                    const cc = cursors.get(m.id); if (cc) ensureCursor(m.id, m.name, m.color, m.avatarEmoji, m.avatarImage);
                    renderUsers(); renderSidebar(); fillHHeader();
                    break;
                }
                case 'rename': {
                    const u = userList.get(m.id);
                    if (u) u.name = m.newName;
                    // uid 资料映射：改名后名字自动更新（历史消息按 uid 渲染会跟随）
                    if (m.uid) {
                        const cur = uidProfile.get(m.uid) || { name: m.newName, color: null, avatarEmoji: null, avatarColor: null, avatarImage: null };
                        cur.name = m.newName;
                        if (u) { cur.color = u.color || cur.color; cur.avatarEmoji = u.avatarEmoji || cur.avatarEmoji; cur.avatarColor = u.color || cur.avatarColor; cur.avatarImage = u.avatarImage || cur.avatarImage; }
                        uidProfile.set(m.uid, cur);
                    }
                    if (me && me.id === m.id) {
                        me.name = m.newName;
                        setMeUI({ username: m.newName, avatarEmoji: myProfile.avatarEmoji, avatarColor: myProfile.avatarColor || me.color, avatarImage: myProfile.avatarImage });
                    }
                    const cc = cursors.get(m.id); if (cc) ensureCursor(m.id, m.newName, u ? u.color : '#8aa9c9', u ? u.avatarEmoji : null, u ? u.avatarImage : null);
                    // 好友改名：同步 friendSet / friendInfoMap 的 username key
                    if (friendSet.has(m.oldName)) {
                        friendSet.delete(m.oldName); friendSet.add(m.newName);
                    }
                    if (friendInfoMap.has(m.oldName)) {
                        const fi = friendInfoMap.get(m.oldName); friendInfoMap.delete(m.oldName); friendInfoMap.set(m.newName, fi);
                    }
                    // 私聊会话：按旧 username 找 session，若存在 -> 改 session key + peerUsername + name
                    const oldKey = 'f_' + escapeJsKey(m.oldName);
                    if (sessions.has(oldKey)) {
                        const s = sessions.get(oldKey);
                        s.peerUsername = m.newName;
                        s.name = m.newName;
                        // 迁移会话 key
                        sessions.delete(oldKey);
                        const newKey = 'f_' + escapeJsKey(m.newName);
                        s.id = newKey;
                        sessions.set(newKey, s);
                        if (curSessionId === oldKey) curSessionId = newKey;
                    }
                    renderUsers(); renderSidebar(); fillHHeader();
                    dispatchMsg(HALL, { sys: true, text: `${m.oldName} 改名为「${m.newName}」` });
                    break;
                }
                case 'cursor': {
                    const c = ensureCursor(m.id);
                    c.tx = m.x; c.ty = m.y;
                    break;
                }
                case 'chat':
                    dispatchMsg(HALL, {
                        id: m.id, from: m.uid || m.from, name: m.name, color: m.color, text: m.text,
                        mentions: m.mentions, mid: m.mid, quote: m.quote,
                        avatarEmoji: m.avatarEmoji || null
                    });
                    break;
                case 'code':
                    dispatchMsg(HALL, {
                        id: m.id, from: m.uid || m.from, name: m.name, color: m.color, text: m.text,
                        language: m.language, mid: m.mid, quote: m.quote,
                        avatarEmoji: m.avatarEmoji || null
                    });
                    break;
                case 'revoke':
                    applyRevoke(m.mid, m.name, m.peerId || null);
                    renderSidebar();
                    break;
                case 'private': {
                    let otherId = m.id;
                    let isSelfSend = false;
                    if (m.id === me?.id) {
                        // 自己发送的回传：对方 id = m.to
                        otherId = m.to;
                        isSelfSend = true;
                    }
                    // 确定对方 username：稳定唯一标识
                    const peerUser = isSelfSend ? (m.toName || '') : (m.fromName || m.name || '');
                    let sess = null;
                    if (peerUser) {
                        const realOnlineId = (otherId && String(otherId).slice(0, 8) !== 'offline_' && !/^off_/.test(String(otherId))) ? otherId : null;
                        sess = ensurePrivate(realOnlineId, peerUser, m.color, m.avatarEmoji || null, m.avatarImage || null);
                        if (sess && realOnlineId) sess.withId = realOnlineId;
                        else if (sess && !sess.withId) { const realId = findIdByName(peerUser); if (realId) sess.withId = realId; }
                    } else {
                        sess = null;
                    }
                    if (!sess) break;
                    const sk = sess.id;
                    const other = (otherId && userList.has(otherId)) ? userList.get(otherId) : null;
                    const color = other ? other.color : m.color;
                    const av = other ? other.avatarEmoji : (m.avatarEmoji || null);
                    const img = other ? other.avatarImage : (m.avatarImage || null);
                    dispatchMsg(sk, {
                        from: m.uid || m.from,
                        id: m.id, name: isSelfSend ? (me?.name || m.name) : (m.fromName || m.name || (sess && sess.name)),
                        color: isSelfSend ? (me?.color || color) : color,
                        avatarEmoji: isSelfSend ? (me?.avatarEmoji || av) : av,
                        avatarImage: isSelfSend ? (me?.avatarImage || img) : img,
                        text: m.text, mentions: m.mentions || [],
                        typePrivate: true, mid: m.mid, quote: m.quote,
                        to: m.to, toName: m.toName, ts: m.ts
                    });
                    break;
                }
                case 'private-error':
                    showToast(`⚠️ ${m.msg || '私聊发送失败'}`);
                    break;
                case 'mention':
                    showToast(`🔔 ${m.fromName} 在${m.privateHint ? '私聊' : '群聊'}中艾特了你`);
                    break;
                case 'friend-added': {
                    // 新增一个好友
                    friendSet.add(m.username);
                    if (m.profile) friendInfoMap.set(m.username, { online: false, onlineId: null, avatarEmoji: m.profile.avatarEmoji || null, avatarColor: m.profile.color || null, avatarImage: m.profile.avatarImage || null });
                    // 如果对方当前在 userList 里（在线），更新 onlineId + info + 会话 withId
                    for (const [uid, info] of userList) {
                        if (info.name === m.username) {
                            const fi = friendInfoMap.get(m.username) || {};
                            fi.online = true; fi.onlineId = uid; fi.avatarEmoji = info.avatarEmoji; fi.avatarColor = info.color; fi.avatarImage = info.avatarImage;
                            friendInfoMap.set(m.username, fi);
                            break;
                        }
                    }
                    const fi = friendInfoMap.get(m.username) || {};
                    ensurePrivate(fi.onlineId || null, m.username, fi.avatarColor || null, fi.avatarEmoji || null, fi.avatarImage || null);
                    showToast(`👥 ${m.username} 已成为你的好友，开始聊天吧`);
                    renderSidebar();
                    if (frModal && frModal.classList.contains('show')) renderFriendModal();
                    break;
                }
                case 'friend-removed':
                    friendSet.delete(m.username);
                    friendInfoMap.delete(m.username);
                    // 会话留着（历史还在），但标记非好友，以后再发消息会被拦住
                    const sk1 = friendSessionKey(m.username);
                    const s1 = sessions.get(sk1);
                    if (s1) { s1.isFriend = false; }
                    renderSidebar();
                    showToast(`「${m.username}」已被移除好友`);
                    break;
                case 'muted':
                    showToast(`🔇 ${m.msg || '你已被禁言'}`);
                    input.disabled = true;
                    input.placeholder = `禁言中……，剩余 ${m.remaining} 秒…`;
                    clearTimeout(mutedTimer);
                    mutedTimer = setTimeout(() => {
                        input.disabled = false;
                        const cur = sessions.get(curSessionId);
                        if (cur && cur.isPrivate) {
                            if (!cur.isFriend || !isFriendOfMine(cur.peerUsername)) input.placeholder = `发一条消息给 ${cur.peerUsername || cur.name}，会自动加为好友…`;
                            else input.placeholder = `发送私聊给 ${cur.name}… 输入 @ 艾特在线用户`;
                        } else input.placeholder = '说点什么… 输入 @ 艾特在线用户';
                    }, (m.remaining || 30) * 1000);
                    break;
                case 'typing': {
                    const c = cursors.get(m.id); if (c) c.el.classList.toggle('typing', !!m.on);
                    break;
                }
                case 'leave': {
                    const who = userList.get(m.id);
                    const whoName = who ? who.name : '';
                    userList.delete(m.id);
                    // 好友离线：标记，会话 withId 保留（下次 enter 会重新补）
                    if (whoName && friendSet.has(whoName)) {
                        const fi = friendInfoMap.get(whoName);
                        if (fi) { fi.online = false; fi.onlineId = null; friendInfoMap.set(whoName, fi); }
                        const sk = friendSessionKey(whoName);
                        const sess = sessions.get(sk);
                        if (sess && sess.withId === m.id) sess.withId = null;
                    }
                    renderUsers(); renderSidebar();
                    removeCursor(m.id); setCount(userList.size);
                    if (who) dispatchMsg(HALL, { sys: true, text: `${who.name} 离开了大厅` });
                    else dispatchMsg(HALL, { sys: true, text: '有人离开了大厅' });
                    break;
                }
            }
        });

        ws.addEventListener('close', () => {
            connDot.classList.add('off');
            setCount(userList.size);
            showToast('与服务器的连接已断开');
        });
        ws.addEventListener('error', () => {
            overlayHint.innerHTML = '连接失败，请确认服务器已启动（node server.js）';
        });
    }

    // ---------- 启动 ----------
    (async function boot() {
        const tok = getToken();
        if (tok) {
            overlayHint.innerHTML = '正在校验登录…';
            const r = await api('/api/me', { token: tok }).catch(() => ({ ok: false }));
            if (r.ok && r.data.username) {
                setMeUI({
                    username: r.data.username,
                    avatarEmoji: r.data.avatarEmoji,
                    avatarColor: r.data.avatarColor
                });
                connectToHall();
                return;
            } else setToken('');
        }
        overlayHint.innerHTML = '公告：服务器重启，需要重新注册。';
        $('loginUser').focus();
    })();
})();