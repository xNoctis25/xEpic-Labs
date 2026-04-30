const profileData = document.getElementById('profileData');
if (!auth.getToken()) window.location.href = '/';

async function loadProfile() {
    try {
        const user = await auth.request('/me', { method: 'GET' });
        const ts = user.created_at || user.createdat;
        const dateStr = ts ? new Date(Number(ts) * (String(ts).length <= 10 ? 1000 : 1)).toLocaleDateString() : 'Active Member';
        profileData.innerHTML = `
            <div style="margin-bottom: 15px; text-align: center;">
                <div style="width: 60px; height: 60px; background: var(--primary); border-radius: 50%; margin: 0 auto 10px; display: flex; align-items: center; justify-content: center; font-size: 1.5rem; font-weight: bold; color: #000;">
                    ${user.username.charAt(0).toUpperCase()}</div>
                <label style="font-size: 0.8rem; color: var(--text-muted); text-transform: uppercase;">Username</label>
                <div style="font-size: 1.2rem; font-weight: bold; color: var(--primary);">${user.username}</div>
            </div>
            <hr style="border: none; border-top: 1px solid var(--glass-border); margin: 15px 0;">
            <div style="display: flex; justify-content: space-between;">
                <div><label style="font-size: 0.8rem; color: var(--text-muted); text-transform: uppercase;">Email</label><div style="font-size: 1rem;">${user.email}</div></div>
                <div style="text-align: right;"><label style="font-size: 0.8rem; color: var(--text-muted); text-transform: uppercase;">Member Since</label><div style="font-size: 0.9rem;">${dateStr}</div></div>
            </div>
        `;
        const userRole = user.user?.role || user.role;
        if (userRole === 'admin') {
            const dd = document.getElementById('modelDropdown');
            if (dd) dd.classList.remove('disabled');
        }
        const nameSpan = document.getElementById('novaUserName');
        if (nameSpan) nameSpan.textContent = user.username;
        novaUsername = user.username;
    } catch (err) { auth.clearToken(); window.location.href = '/'; }
}

document.getElementById('logoutBtn').addEventListener('click', async () => {
    try { await auth.request('/logout', { method: 'POST' }); }
    catch (e) { console.warn('Server logout failed.'); }
    finally { auth.clearToken(); window.location.href = '/'; }
});

loadProfile();

// ── Nova CHAT SESSION ENGINE ─────────────────────────────────────────────
const NOVA_KEY    = 'nova_chats';
const NOVA_ACTIVE = 'nova_active_chat';
let novaUsername  = 'User';

const novaForm     = document.getElementById('novaForm');
const novaInput    = document.getElementById('novaInput');
const novaMessages = document.getElementById('novaMessages');
const novaSubmit   = document.getElementById('novaSubmit');

function novaGetChats()       { try { return JSON.parse(localStorage.getItem(NOVA_KEY)) || []; } catch { return []; } }
function novaSaveChats(c)     { localStorage.setItem(NOVA_KEY, JSON.stringify(c)); }
function novaGetActiveId()    { return localStorage.getItem(NOVA_ACTIVE); }

function novaSetTitleBar(title) {
    const el = document.getElementById('novaChatTitle');
    const bar = el?.closest('.nova-title-bar');
    if (!el) return;
    if (!title || title === 'New chat') {
        el.textContent = '';
        if (bar) bar.style.display = 'none';
    } else {
        el.textContent = title;
        if (bar) bar.style.display = '';
    }
}
function novaSetActiveId(id)  { localStorage.setItem(NOVA_ACTIVE, id); }

async function novaGenTitle(userMessage, aiReply) {
    try {
        const prompt = `Generate a concise, professional 4-6 word title for a conversation. Reply with ONLY the title, no quotes, no punctuation at the end.\n\nUser asked: "${userMessage}"\nAssistant replied: "${aiReply.slice(0, 200)}"`;
        const res = await auth.request('/chat', {
            method: 'POST',
            body: JSON.stringify({ message: prompt, model: 'gemini-2.5-flash' })
        });
        return res.reply.trim().replace(/^["']|["']$/g, '').slice(0, 60);
    } catch {
        // fallback: capitalize first words
        return userMessage.split(/\s+/).slice(0, 5).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    }
}

function novaCreateSession() {
    const chat = { id: 'chat_' + Date.now(), title: 'New chat', messages: [], createdAt: Date.now(), pinned: false };
    const chats = novaGetChats();
    chats.unshift(chat);
    novaSaveChats(chats);
    novaSetActiveId(chat.id);
    return chat;
}

function novaTogglePin(chatId) {
    const chats = novaGetChats();
    const chat  = chats.find(c => c.id === chatId);
    if (chat) { chat.pinned = !chat.pinned; novaSaveChats(chats); novaRenderList(); }
}

function novaStartRename(chatId) {
    const itemEl = document.querySelector(`[data-chat-id="${chatId}"] .nova-chat-label`);
    if (!itemEl) return;
    const chats   = novaGetChats();
    const chat    = chats.find(c => c.id === chatId);
    if (!chat) return;

    const input = document.createElement('input');
    input.className = 'nova-rename-input';
    input.value = chat.title;
    itemEl.replaceWith(input);
    input.focus();
    input.select();

    const save = () => {
        const newTitle = input.value.trim() || chat.title;
        chat.title = newTitle;
        novaSaveChats(chats);
        if (novaGetActiveId() === chatId) novaSetTitleBar(newTitle);
        novaRenderList();
    };
    input.addEventListener('blur', save);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } if (e.key === 'Escape') { input.value = chat.title; input.blur(); } });
}

function novaDeleteChat(chatId) {
    let chats = novaGetChats().filter(c => c.id !== chatId);
    novaSaveChats(chats);
    if (novaGetActiveId() === chatId) {
        const next = chats.find(c => c.messages.length > 0);
        if (next) { novaLoadChat(next.id); }
        else { novaCreateSession(); novaShowGreeting(); novaSetTitleBar(''); }
    }
    novaRenderList();
}

function novaRenderList() {
    const list = document.getElementById('novaChatList');
    if (!list) return;
    const chats  = novaGetChats();
    const active = novaGetActiveId();
    const history = chats.filter(c => c.messages.length > 0);
    list.innerHTML = '';

    // Sections always render (pinned placeholder shown when empty)

    const pinned   = history.filter(c => c.pinned);
    const unpinned = history.filter(c => !c.pinned);

    function buildItem(chat) {
        const wrap = document.createElement('div');
        wrap.className = 'nova-chat-item' + (chat.id === active ? ' active' : '');
        wrap.dataset.chatId = chat.id;

        const label = document.createElement('span');
        label.className = 'nova-chat-label';
        label.textContent = chat.title;

        // Inline action buttons - direct event handlers, no floating popup
        const actions = document.createElement('div');
        actions.className = 'nova-chat-actions';

        function makeActionBtn(svgPath, label, cls, handler) {
            const btn = document.createElement('button');
            btn.className = 'nova-action-btn' + (cls ? ' ' + cls : '');
            btn.title = label;
            btn.setAttribute('aria-label', label);
            btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' + svgPath + '</svg>';
            btn.addEventListener('click', (e) => { e.stopPropagation(); handler(); });
            return btn;
        }

        actions.appendChild(makeActionBtn(
            '<line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24z"/>',
            chat.pinned ? 'Unpin' : 'Pin', chat.pinned ? 'active' : '',
            () => novaTogglePin(chat.id)
        ));
        actions.appendChild(makeActionBtn(
            '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>',
            'Rename', '',
            () => novaStartRename(chat.id)
        ));
        actions.appendChild(makeActionBtn(
            '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/>',
            'Delete', 'nova-action-danger',
            () => novaDeleteChat(chat.id)
        ));

        wrap.appendChild(label);
        wrap.appendChild(actions);
        wrap.addEventListener('click', () => novaLoadChat(chat.id));
        return wrap;
    }

    // ── Pinned Section (always visible) ─────────────────────────────────
    const pinnedLabel = document.createElement('p');
    pinnedLabel.className = 'nova-chat-section-label';
    pinnedLabel.textContent = 'Pinned';
    list.appendChild(pinnedLabel);
    if (pinned.length > 0) {
        pinned.forEach(c => list.appendChild(buildItem(c)));
    } else {
        const noPinned = document.createElement('div');
        noPinned.className = 'nova-chat-empty-sub';
        noPinned.textContent = 'No pinned chats';
        list.appendChild(noPinned);
    }

    // ── Recent Section ────────────────────────────────────────────────────
    const recentLabel = document.createElement('p');
    recentLabel.className = 'nova-chat-section-label';
    recentLabel.style.marginTop = '14px';
    recentLabel.textContent = 'Recent';
    list.appendChild(recentLabel);
    if (unpinned.length > 0) {
        unpinned.forEach(c => list.appendChild(buildItem(c)));
    } else {
        const noRecent = document.createElement('div');
        noRecent.className = 'nova-chat-empty-sub';
        noRecent.textContent = 'No recent chats';
        list.appendChild(noRecent);
    }
}

function novaShowGreeting() {
    novaMessages.innerHTML = `
        <div id="novaGreeting" class="nova-greeting">
            <h1>Hi <span>${novaUsername}</span></h1>
            <p>What should we try today?</p>
        </div>`;
}

function novaLoadChat(id) {
    novaSetActiveId(id);
    const chats = novaGetChats();
    const chat  = chats.find(c => c.id === id);
    if (!chat) return;
    novaSetTitleBar(chat.title);
    // title set above
    novaMessages.innerHTML = '';
    if (chat.messages.length === 0) {
        novaShowGreeting();
    } else {
        chat.messages.forEach(m => appendMessage(m.text, m.role === 'user', false));
    }
    novaRenderList();
}

function appendMessage(text, isUser = false, save = true) {
    const div = document.createElement('div');
    div.className = `nova-msg ${isUser ? 'user-msg' : 'ai-msg'}`;
    if (!isUser) {
        let f = text.replace(/\n/g, '<br>').replace(/\*\*(.*?)\*\*/g, '<b style="color:#fff">$1</b>');
        div.innerHTML = f;
    } else {
        div.textContent = text;
    }
    novaMessages.appendChild(div);
    novaMessages.scrollTop = novaMessages.scrollHeight;
    if (save) {
        const chats = novaGetChats();
        const chat  = chats.find(c => c.id === novaGetActiveId());
        if (chat) { chat.messages.push({ role: isUser ? 'user' : 'ai', text }); novaSaveChats(chats); }
    }
    return div;
}

if (novaForm) {
    novaForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const text = novaInput.value.trim();
        if (!text) return;

        // Hide greeting on first send
        const greeting = document.getElementById('novaGreeting');
        if (greeting) greeting.style.display = 'none';

        appendMessage(text, true);
        novaInput.value = '';
        novaInput.style.height = 'auto';
        novaInput.disabled = true;
        novaSubmit.disabled = true;

        novaRenderList();

        const typingMsg = appendMessage('Processing...', false, false);
        const isFirstExchange = (novaGetChats().find(c => c.id === novaGetActiveId())?.messages.length ?? 0) <= 1;

        try {
            const res = await auth.request('/chat', {
                method: 'POST',
                body: JSON.stringify({ message: text, model: document.getElementById('novaModelSelect')?.value || 'gemini-2.5-flash' })
            });
            let f = res.reply.replace(/\n/g, '<br>').replace(/\*\*(.*?)\*\*/g, '<b style="color:#fff">$1</b>');
            typingMsg.innerHTML = f;

            // Save AI response
            const chats2 = novaGetChats();
            const chat2  = chats2.find(c => c.id === novaGetActiveId());
            if (chat2) { chat2.messages.push({ role: 'ai', text: res.reply }); novaSaveChats(chats2); }

            // AI-generated title — fires silently after first exchange, no loading state shown
            if (isFirstExchange && chat2 && chat2.title === 'New chat') {
                novaGenTitle(text, res.reply).then(generated => {
                    const chats3 = novaGetChats();
                    const chat3  = chats3.find(c => c.id === novaGetActiveId());
                    if (chat3 && chat3.title === 'New chat') {
                        chat3.title = generated;
                        novaSaveChats(chats3);
                        novaSetTitleBar(generated);
                        // title bar updated
                        novaRenderList();
                    }
                });
            }
        } catch (err) {
            typingMsg.innerHTML = `<span style="color:var(--error)">${err.message || 'Connection lost to core.'}</span>`;
        } finally {
            novaInput.disabled = false;
            novaSubmit.disabled = false;
            novaInput.focus();
        }
    });
}

// New chat button
const novaNewChatBtn = document.getElementById('novaNewChat');
if (novaNewChatBtn) {
    novaNewChatBtn.addEventListener('click', () => {
        novaCreateSession();
        novaSetTitleBar('');
        // new chat — hide title
        novaShowGreeting();
        novaRenderList();
        novaInput.focus();
    });
}

// Textarea auto-grow + Enter to submit
if (novaInput) {
    novaInput.addEventListener('input', function () { this.style.height = 'auto'; this.style.height = this.scrollHeight + 'px'; });
    novaInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            if (this.value.trim()) novaForm.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
        }
    });
}

// ── INIT NOVA (on page load) ──────────────────────────────────────────────────
(function initNova() {
    let chats = novaGetChats();
    if (chats.length === 0) { novaCreateSession(); chats = novaGetChats(); }
    if (!novaGetActiveId() || !chats.find(c => c.id === novaGetActiveId())) novaSetActiveId(chats[0].id);
    const active = chats.find(c => c.id === novaGetActiveId());
    if (active) novaSetTitleBar(active.title);
    // init title done
    if (active && active.messages.length > 0) {
        novaMessages.innerHTML = '';
        active.messages.forEach(m => appendMessage(m.text, m.role === 'user', false));
    }
    novaRenderList();
})();

// ── CUSTOM DROPDOWN ───────────────────────────────────────────────────────────
const modelDropdown    = document.getElementById('modelDropdown');
const dropdownTrigger  = document.getElementById('dropdownTrigger');
const selectedModelText = document.getElementById('selectedModelText');
const dropdownItems    = document.querySelectorAll('.dropdown-item');

let hiddenModelInput = document.getElementById('novaModelSelect');
if (!hiddenModelInput && modelDropdown) {
    hiddenModelInput = document.createElement('input');
    hiddenModelInput.type  = 'hidden';
    hiddenModelInput.id    = 'novaModelSelect';
    hiddenModelInput.value = 'gemini-2.5-flash';
    modelDropdown.parentNode.appendChild(hiddenModelInput);
}

if (dropdownTrigger && modelDropdown) {
    dropdownTrigger.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!modelDropdown.classList.contains('disabled')) {
            modelDropdown.classList.toggle('open');
        }
    });
    document.addEventListener('click', (e) => {
        if (!modelDropdown.contains(e.target)) modelDropdown.classList.remove('open');
    });
    dropdownItems.forEach(item => {
        item.addEventListener('click', (e) => {
            e.stopPropagation();
            dropdownItems.forEach(i => i.classList.remove('active'));
            item.classList.add('active');
            const titleEl = item.querySelector('.item-title');
            if (selectedModelText && titleEl) selectedModelText.textContent = titleEl.textContent;
            if (hiddenModelInput) hiddenModelInput.value = item.getAttribute('data-value') || 'gemini-2.5-flash';
            modelDropdown.classList.remove('open');
        });
    });
}

// ── NAVIGATION & VIEW SWITCHING ───────────────────────────────────────────────
const navs = {
    home:     document.getElementById('navHome'),
    nova:     document.getElementById('navNova'),
    settings: document.getElementById('navSettings')
};
const views = {
    home:     document.getElementById('homeView'),
    nova:     document.getElementById('novaView'),
    settings: document.getElementById('profileView')
};

window.switchView = function (viewName) {
    Object.values(navs).forEach(nav => nav && nav.classList.remove('active'));
    Object.values(views).forEach(view => view && view.classList.add('hidden'));
    if (navs[viewName])  navs[viewName].classList.add('active');
    if (views[viewName]) views[viewName].classList.remove('hidden');
};

if (navs.home)     navs.home.addEventListener('click',     (e) => { e.preventDefault(); window.switchView('home'); });
if (navs.nova)     navs.nova.addEventListener('click',     (e) => { e.preventDefault(); window.switchView('nova'); });
if (navs.settings) navs.settings.addEventListener('click', (e) => { e.preventDefault(); window.switchView('settings'); });

// ── CHANGE PASSWORD ───────────────────────────────────────────────────────────
const changePwdForm = document.getElementById('changePasswordForm');
if (changePwdForm) {
    changePwdForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const cur    = document.getElementById('currentPassword').value;
        const newVal = document.getElementById('newProfilePassword').value;
        const conf   = document.getElementById('confirmNewProfilePassword').value;
        const btn      = document.getElementById('changePwdBtn');
        const alertBox = document.getElementById('pwdAlertBox');

        alertBox.style.display = 'none';
        alertBox.className = 'alert';

        if (newVal !== conf) {
            alertBox.className   = 'alert error';
            alertBox.textContent = 'New passwords do not match.';
            alertBox.style.display = 'block';
            return;
        }

        btn.disabled    = true;
        btn.textContent = 'Updating...';

        try {
            await auth.request('/change-password', {
                method: 'POST',
                body: JSON.stringify({ currentPassword: cur, newPassword: newVal })
            });
            alertBox.className   = 'alert success';
            alertBox.textContent = 'Password updated successfully.';
            alertBox.style.display = 'block';
            changePwdForm.reset();
        } catch (err) {
            alertBox.className   = 'alert error';
            alertBox.textContent = err.message || 'Failed to update password.';
            alertBox.style.display = 'block';
        } finally {
            btn.disabled    = false;
            btn.textContent = 'Update Password';
        }
    });
}

// ── LIVE MARKET CLOCK ─────────────────────────────────────────────────────────
function updateMarketClock() {
    const uiSessionLabel  = document.getElementById('uiSessionLabel');
    const uiSessionDot    = document.getElementById('uiSessionDot');
    const uiKillzoneLabel = document.getElementById('uiKillzoneLabel');
    const uiKillzoneDot   = document.getElementById('uiKillzoneDot');
    if (!uiSessionLabel || !uiSessionDot || !uiKillzoneLabel || !uiKillzoneDot) return;

    const nowStr = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
    const now    = new Date(nowStr);
    const yyyy   = now.getFullYear();
    const mm     = String(now.getMonth() + 1).padStart(2, '0');
    const dd     = String(now.getDate()).padStart(2, '0');
    const dateStr      = `${yyyy}-${mm}-${dd}`;
    const day          = now.getDay();
    const totalMinutes = now.getHours() * 60 + now.getMinutes();

    // 1. CME Holiday Calendar 2026–2027
    const cmeHolidays = [
        '2026-01-01','2026-01-19','2026-02-16','2026-04-03','2026-05-25',
        '2026-06-19','2026-07-03','2026-09-07','2026-11-26','2026-12-25',
        '2027-01-01','2027-01-18','2027-02-15','2027-03-26','2027-05-31',
        '2027-06-18','2027-07-05','2027-09-06','2027-11-25','2027-12-24'
    ];
    if (cmeHolidays.includes(dateStr)) {
        uiSessionLabel.textContent  = 'Closed: Holiday';
        uiSessionDot.className      = 'dot red';
        uiKillzoneLabel.textContent = 'Killzone: Inactive';
        uiKillzoneDot.className     = 'dot gray';
        return;
    }

    // 2. Weekend gate (Fri 17:00 → Sun 18:00 ET)
    if (day === 6 || (day === 5 && totalMinutes >= 1020) || (day === 0 && totalMinutes < 1080)) {
        uiSessionLabel.textContent  = 'Closed: Weekend';
        uiSessionDot.className      = 'dot red';
        uiKillzoneLabel.textContent = 'Killzone: Inactive';
        uiKillzoneDot.className     = 'dot gray';
        return;
    }

    // 3. CME Daily Maintenance (Mon-Thu 17:00–18:00 ET)
    if (totalMinutes >= 1020 && totalMinutes < 1080) {
        uiSessionLabel.textContent  = 'Closed: CME Maint';
        uiSessionDot.className      = 'dot red';
        uiKillzoneLabel.textContent = 'Killzone: Inactive';
        uiKillzoneDot.className     = 'dot gray';
        return;
    }

    // 4. Classify active session & killzone
    let sessionText  = 'Session: Asia';
    let sessionColor = 'green';
    let kzText       = 'Killzone: Inactive';
    let kzColor      = 'gray';

    if (totalMinutes >= 120 && totalMinutes < 300) {
        sessionText  = 'Session: London'; sessionColor = 'green';
        kzText  = totalMinutes >= 135 ? 'Killzone: London' : 'Killzone: Pre-London';
        kzColor = totalMinutes >= 135 ? 'green' : 'gray';
    } else if (totalMinutes >= 570 && totalMinutes < 720) {
        sessionText  = 'Session: New York'; sessionColor = 'green';
        kzText  = (totalMinutes >= 585 && totalMinutes < 690) ? 'Killzone: NY AM' : 'Killzone: Outside';
        kzColor = (totalMinutes >= 585 && totalMinutes < 690) ? 'green' : 'gray';
    } else if (totalMinutes >= 810 && totalMinutes < 960) {
        sessionText  = 'Session: New York'; sessionColor = 'green';
        kzText  = totalMinutes < 945 ? 'Killzone: NY PM' : 'Killzone: Outside';
        kzColor = totalMinutes < 945 ? 'green' : 'gray';
    }

    uiSessionLabel.textContent  = sessionText;
    uiSessionDot.className      = 'dot ' + sessionColor;
    uiKillzoneLabel.textContent = kzText;
    uiKillzoneDot.className     = 'dot ' + kzColor;
}

updateMarketClock();
setInterval(updateMarketClock, 10000);
