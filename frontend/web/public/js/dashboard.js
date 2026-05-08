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
    // Re-run layout so messages reposition below the (now visible/hidden) title bar.
    // Use 50ms + rAF to guarantee the bar is fully painted before we measure its height.
    setTimeout(function() { requestAnimationFrame(novaApplyLayout); }, 50);
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
                body: JSON.stringify({ message: text, model: document.getElementById('novaModelSelect')?.value || 'gemini-2.5-flash', history: (novaGetChats().find(c => c.id === novaGetActiveId())?.messages || []).slice(-20) })
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
    trading:  document.getElementById('navTrading'),
    settings: document.getElementById('navSettings')
};
const views = {
    home:     document.getElementById('homeView'),
    nova:     document.getElementById('novaView'),
    trading:  document.getElementById('tradingView'),
    settings: document.getElementById('profileView')
};

const ACTIVE_VIEW_KEY = 'nova_activeView';
const VIEW_TITLES = {
    home:     'xEpic Labs — Home',
    nova:     'xEpic Labs — Nova',
    trading:  'xEpic Labs — Trading',
    settings: 'xEpic Labs — Settings'
};

window.switchView = function (viewName) {
    Object.values(navs).forEach(nav => nav && nav.classList.remove('active'));
    Object.values(views).forEach(view => view && view.classList.add('hidden'));
    if (navs[viewName])  navs[viewName].classList.add('active');
    if (views[viewName]) views[viewName].classList.remove('hidden');
    // Persist active view so refresh lands on same screen
    localStorage.setItem(ACTIVE_VIEW_KEY, viewName);
    // Update browser tab title
    document.title = VIEW_TITLES[viewName] || 'xEpic Labs';
};

if (navs.home)     navs.home.addEventListener('click',     (e) => { e.preventDefault(); window.switchView('home'); });
if (navs.nova)     navs.nova.addEventListener('click',     (e) => { e.preventDefault(); window.switchView('nova'); });
if (navs.trading)  navs.trading.addEventListener('click',  (e) => { e.preventDefault(); window.switchView('trading'); loadPropAccounts(); });
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

// ── GLOBAL RISK TOGGLE ────────────────────────────────────────────────────────
const globalRiskToggleBtn = document.getElementById('globalRiskToggleBtn');

function updateGlobalRiskToggle(riskProfile) {
    if (!globalRiskToggleBtn) return;
    globalRiskToggleBtn.style.display = 'flex';
    
    if (riskProfile === 'SAFE') {
        globalRiskToggleBtn.textContent = 'Risk: SAFE 🛡️';
        globalRiskToggleBtn.style.background = 'rgba(52, 211, 153, 0.2)';
        globalRiskToggleBtn.style.color = '#34d399';
        globalRiskToggleBtn.style.borderColor = '#34d399';
    } else {
        globalRiskToggleBtn.textContent = 'Risk: MAX 🚀';
        globalRiskToggleBtn.style.background = 'rgba(248, 113, 113, 0.2)';
        globalRiskToggleBtn.style.color = '#f87171';
        globalRiskToggleBtn.style.borderColor = '#f87171';
    }
}

if (globalRiskToggleBtn) {
    globalRiskToggleBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        const currentRisk = localStorage.getItem('globalRiskProfile') || 'SAFE';
        const newRisk = currentRisk === 'SAFE' ? 'AGGRESSIVE' : 'SAFE';
        const originalText = globalRiskToggleBtn.textContent;
        globalRiskToggleBtn.textContent = 'Updating...';
        globalRiskToggleBtn.disabled = true;

        try {
            await auth.request('/trading/risk', {
                method: 'PATCH',
                body: JSON.stringify({ risk_profile: newRisk })
            });
            localStorage.setItem('globalRiskProfile', newRisk);
            updateGlobalRiskToggle(newRisk);
            await loadPropAccounts(); // Refresh table
        } catch (err) {
            console.error('Failed to toggle risk:', err);
            globalRiskToggleBtn.textContent = originalText;
            alert(err.message || 'Failed to update risk profile.');
        } finally {
            globalRiskToggleBtn.disabled = false;
        }
    });
}

// ── LIVE MARKET CLOCK ─────────────────────────────────────────────────────────
function updateMarketClock() {
    const uiSessionLabel  = document.getElementById('uiSessionLabel');
    const uiSessionDot    = document.getElementById('uiSessionDot');
    if (!uiSessionLabel || !uiSessionDot) return;

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
        return;
    }

    // 2. Weekend gate (Fri 17:00 → Sun 18:00 ET)
    if (day === 6 || (day === 5 && totalMinutes >= 1020) || (day === 0 && totalMinutes < 1080)) {
        uiSessionLabel.textContent  = 'Closed: Weekend';
        uiSessionDot.className      = 'dot red';
        return;
    }

    // 3. CME Daily Maintenance (Mon-Thu 17:00–18:00 ET)
    if (totalMinutes >= 1020 && totalMinutes < 1080) {
        uiSessionLabel.textContent  = 'Closed: CME';
        uiSessionDot.className      = 'dot red';
        return;
    }

    // 4. Classify active session & killzone
    // CME Futures Sessions (ET):
    //   Tokyo:    18:00–04:00 (1080–240)
    //   London:   02:00–11:00 (120–660)
    //   New York: 08:00–17:00 (480–1020)
    // Overlaps:
    //   Tokyo + London:    02:00–04:00 (120–240)
    //   London + New York: 08:00–11:00 (480–660)
    let sessionColor = 'green';

    const isTokyo  = totalMinutes >= 1080 || totalMinutes < 240;   // 18:00–04:00
    const isLondon = totalMinutes >= 120  && totalMinutes < 660;   // 02:00–11:00
    const isNY     = totalMinutes >= 480  && totalMinutes < 1020;  // 08:00–17:00

    const activeSessions = [];
    if (isTokyo)  activeSessions.push('Tokyo');
    if (isLondon) activeSessions.push('London');
    if (isNY)     activeSessions.push('New York');

    const isOverlap = activeSessions.length > 1;

    if (activeSessions.length === 0) {
        uiSessionLabel.textContent = 'Session: Closed';
        sessionColor = 'red';
        _stopSessionOverlap();
    } else if (!isOverlap) {
        uiSessionLabel.textContent = 'Session: ' + activeSessions[0];
        _stopSessionOverlap();
    } else {
        _startSessionOverlap(activeSessions, uiSessionLabel);
    }

    uiSessionDot.className = 'dot ' + (isOverlap ? 'pulse-green' : sessionColor);
}

// ── SESSION OVERLAP CROSSFADE ─────────────────────────────────────────────────
var _overlapTimer = null;
var _overlapSessions = [];
var _overlapIdx = 0;

function _startSessionOverlap(sessions, label) {
    // If already cycling these exact sessions, skip
    if (_overlapTimer && JSON.stringify(_overlapSessions) === JSON.stringify(sessions)) return;
    _stopSessionOverlap();
    _overlapSessions = sessions;
    _overlapIdx = 0;

    function cycle() {
        label.style.opacity = '0';
        setTimeout(function() {
            label.textContent = 'Session: ' + _overlapSessions[_overlapIdx];
            label.style.opacity = '1';
            _overlapIdx = (_overlapIdx + 1) % _overlapSessions.length;
        }, 400);
    }

    label.textContent = 'Session: ' + sessions[0];
    _overlapIdx = 1;
    _overlapTimer = setInterval(cycle, 3000);
}

function _stopSessionOverlap() {
    if (_overlapTimer) { clearInterval(_overlapTimer); _overlapTimer = null; }
    _overlapSessions = [];
}

updateMarketClock();
setInterval(updateMarketClock, 10000);

// ── REAL-TIME EST CLOCK ───────────────────────────────────────────────────────
function updateRealtimeClock() {
    const uiRealtimeClock = document.getElementById('uiRealtimeClock');
    if (!uiRealtimeClock) return;

    // Use Intl.DateTimeFormat to get the EST time
    const options = {
        timeZone: 'America/New_York',
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true,
        month: 'short',
        day: '2-digit'
    };
    
    const formatter = new Intl.DateTimeFormat('en-US', options);
    // e.g. "Fri, May 08, 01:44:03 PM"
    const formatted = formatter.format(new Date());
    
    const parts = formatted.split(', ');
    if (parts.length === 3) {
        // parts[0] = "Fri"
        // parts[1] = "May 08"
        // parts[2] = "01:44:03 PM"
        const timeParts = parts[2].split(' ');
        const timeVal = timeParts[0];
        const amPm = timeParts[1];
        
        uiRealtimeClock.innerHTML = `
            <div style="color: #e3e3e3; padding-bottom: 2px;">${parts[0]}, ${parts[1]} <span style="opacity: 0.5; margin-left: 4px;">•</span></div>
            <div><span style="color: #66fcf1;">${timeVal}</span> <span style="color: rgba(255,255,255,0.6);">${amPm} ET</span></div>
        `;
    } else {
        uiRealtimeClock.innerHTML = formatted + " ET";
    }
}

updateRealtimeClock();
setInterval(updateRealtimeClock, 1000);

// ── NOVA LAYOUT ENGINE ──────────────────────────────────────────────────────

// Measure the real native scrollbar width once (0 on macOS overlay, ~17px on Windows)
var _nativeScrollbarW = (function() {
    var d = document.createElement('div');
    d.style.cssText = 'position:absolute;overflow:scroll;width:60px;height:60px;visibility:hidden;top:-999px';
    document.body.appendChild(d);
    var w = d.offsetWidth - d.clientWidth;
    document.body.removeChild(d);
    return w || 0;
}());

function novaApplyLayout() {
    var main = document.querySelector('.nova-main');
    var msgs = document.getElementById('novaMessages');
    var inp  = document.querySelector('.nova-input-wrapper');
    if (!main || !msgs || !inp) return;
    if (main.offsetHeight === 0) return; // Nova is hidden, skip

    // Reset previous inline layout so we can measure naturally
    msgs.style.cssText = msgs.style.cssText
        .replace(/\bposition\s*:[^;]+;?/gi, '')
        .replace(/\bheight\s*:[^;]+;?/gi, '')
        .replace(/\bmax-height\s*:[^;]+;?/gi, '')
        .replace(/\btop\s*:[^;]+;?/gi, '')
        .replace(/\bbottom\s*:[^;]+;?/gi, '');
    inp.style.cssText = inp.style.cssText
        .replace(/\bposition\s*:[^;]+;?/gi, '')
        .replace(/\bbottom\s*:[^;]+;?/gi, '');

    // Force reflow to get real measurements
    void main.offsetHeight;

    var mainH    = main.offsetHeight;
    var inpH     = inp.offsetHeight;
    // Account for the title bar so messages don't overlap the chat name
    var titleBar = main.querySelector('.nova-title-bar');
    var titleH   = (titleBar && titleBar.offsetHeight > 0) ? titleBar.offsetHeight : 0;
    var msgsH    = mainH - inpH - titleH;

    // Apply via setProperty so CSSStyleDeclaration setters fire correctly
    main.style.setProperty('position', 'relative', 'important');
    main.style.setProperty('overflow', 'hidden', 'important');

    msgs.style.setProperty('position',   'absolute',                           'important');
    msgs.style.setProperty('top',        titleH + 'px',                        'important');
    msgs.style.setProperty('left',       '0',                                  'important');
    // Push msgs right edge past parent so native scrollbar is clipped by overflow:hidden
    msgs.style.setProperty('right',      '-' + _nativeScrollbarW + 'px',      'important');
    msgs.style.setProperty('height',     msgsH + 'px',                        'important');
    msgs.style.setProperty('max-height', 'none',                               'important');
    msgs.style.setProperty('overflow-y', 'scroll',                             'important');

    inp.style.setProperty('position', 'absolute', 'important');
    inp.style.setProperty('bottom',   '0',        'important');
    inp.style.setProperty('left',     '0',        'important');
    inp.style.setProperty('right',    '0',        'important');

    // Position scroll-to-bottom button just above input
    var scrollBtn = document.getElementById('novaScrollBtn');
    if (scrollBtn) {
        scrollBtn.style.setProperty('position', 'absolute', 'important');
        scrollBtn.style.setProperty('bottom',   (inpH + 10) + 'px', 'important');
        scrollBtn.style.setProperty('left',     '50%',              'important');
        scrollBtn.style.setProperty('z-index',  '20',               'important');
    }

    // Position custom scroll track (right rail, between title bar and input)
    var track = document.getElementById('novaScrollTrack');
    if (track) {
        track.style.setProperty('position', 'absolute', 'important');
        track.style.setProperty('top',      titleH + 6 + 'px', 'important');
        track.style.setProperty('bottom',   inpH   + 6 + 'px', 'important');
        track.style.setProperty('right',    '3px',              'important');
        track.style.setProperty('z-index',  '15',               'important');
    }
}

document.addEventListener('DOMContentLoaded', function() {
    // ── Restore last active view on refresh ───────────────────────────────
    var savedView = localStorage.getItem(ACTIVE_VIEW_KEY) || 'home';
    window.switchView(savedView);
    // ── Auto-load data for the restored view ──────────────────────────────────
    if (savedView === 'trading') {
        loadPropAccounts();
    }
    if (savedView === 'nova') {
        // Layout engine needs view to be visible — wait for render
        setTimeout(novaApplyLayout, 500);
    }

    // ── Nav click: re-run layout when Nova opens ───────────────────────────
    var navNova = document.getElementById('navNova');
    if (navNova) {
        navNova.addEventListener('click', function() {
            setTimeout(novaApplyLayout, 500);
        });
    }

    // ── Window resize: re-apply layout if Nova is visible ─────────────────
    window.addEventListener('resize', function() {
        if (document.querySelector('.nova-main') && document.querySelector('.nova-main').offsetHeight > 0) {
            novaApplyLayout();
        }
    });

    // ── Custom scrollbar + ↓ button: show while scrolling, hide on idle ──────
    var msgs     = document.getElementById('novaMessages');
    var scrollBtn = document.getElementById('novaScrollBtn');
    var track    = document.getElementById('novaScrollTrack');
    var thumb    = document.getElementById('novaScrollThumb');

    function updateScrollThumb() {
        if (!track || !thumb || !msgs) return;
        var trackH   = track.offsetHeight;
        var contentH = msgs.scrollHeight;
        var visibleH = msgs.clientHeight;
        if (contentH <= visibleH) { thumb.style.height = '0'; return; }
        var thumbH   = Math.max(24, (visibleH / contentH) * trackH);
        var thumbTop = (msgs.scrollTop / (contentH - visibleH)) * (trackH - thumbH);
        thumb.style.height = thumbH + 'px';
        thumb.style.top    = thumbTop + 'px';
    }

    if (msgs) {
        // Scroll-to-bottom click
        if (scrollBtn) {
            scrollBtn.addEventListener('click', function() {
                msgs.scrollTo({ top: msgs.scrollHeight, behavior: 'smooth' });
            });
        }

        var scrollDebounce;
        msgs.addEventListener('scroll', function() {
            var atBottom = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 60;

            // ↓ button: show when not at bottom
            if (scrollBtn) {
                if (!atBottom) scrollBtn.classList.add('visible');
            }

            // Custom scrollbar: show track + update thumb position
            if (track) track.classList.add('is-scrolling');
            updateScrollThumb();

            // After 1.2s idle: hide both
            clearTimeout(scrollDebounce);
            scrollDebounce = setTimeout(function() {
                if (track)     track.classList.remove('is-scrolling');
                if (scrollBtn) scrollBtn.classList.remove('visible');
            }, 1200);
        });
    }
});

// ── PROP FIRM MANAGEMENT ──────────────────────────────────────────────────────
const propAccountModal = document.getElementById('propAccountModal');
const openPropModalBtn = document.getElementById('openPropModalBtn');
const closePropModalBtn = document.getElementById('closePropModalBtn');

if (openPropModalBtn) {
    openPropModalBtn.addEventListener('click', (e) => {
        e.preventDefault();
        if (propAccountModal) propAccountModal.style.display = 'flex';
    });
}

if (closePropModalBtn) {
    closePropModalBtn.addEventListener('click', (e) => {
        e.preventDefault();
        if (propAccountModal) propAccountModal.style.display = 'none';
    });
}

if (propAccountModal) {
    propAccountModal.addEventListener('click', (e) => {
        if (e.target === propAccountModal) {
            propAccountModal.style.display = 'none';
        }
    });
}

async function loadPropAccounts() {
    const evalList = document.getElementById('evalAccountList');
    const fundedList = document.getElementById('fundedAccountList');
    if (!evalList || !fundedList) return;
    
    try {
        evalList.innerHTML = '<tr><td colspan="5" style="padding: 15px; text-align: center; color: var(--text-muted);">Loading evaluation accounts...</td></tr>';
        fundedList.innerHTML = '<tr><td colspan="5" style="padding: 15px; text-align: center; color: var(--text-muted);">Loading funded accounts...</td></tr>';
        
        const accounts = await auth.request('/trading/prop-accounts', { method: 'GET' });
        
        let evalHtml = '';
        let fundedHtml = '';

        if (!accounts || accounts.length === 0) {
            evalList.innerHTML = '<tr><td colspan="5" style="padding: 15px; text-align: center; color: var(--text-muted);">No evaluation accounts found.</td></tr>';
            fundedList.innerHTML = '<tr><td colspan="5" style="padding: 15px; text-align: center; color: var(--text-muted);">No funded accounts found.</td></tr>';
            updateGlobalRiskToggle(localStorage.getItem('globalRiskProfile') || 'SAFE');
            return;
        }

        let firstRisk = null;


        accounts.forEach(acc => {
            // ── Core calculations ─────────────────────────────────────────────
            const maxLoss    = Number(acc.max_loss_limit) || 0;
            const sizeNum    = Number(acc.account_size)   || 0;
            const balanceNum = Number(acc.account_balance ?? acc.account_size) || sizeNum;
            const pnlValue   = balanceNum - sizeNum;
            const buffer     = maxLoss + pnlValue; // maxLoss - |pnl| when pnl is negative

            // ── Auto-BLOWN: if buffer ≤ 0, override status regardless of DB ──
            const isBlown    = buffer <= 0;
            const displayStatus = isBlown ? 'BLOWN' : acc.status;

            // ── Status badge style ────────────────────────────────────────────
            const STATUS_MAP = {
                ACTIVE: { color: '#00e676', bg: 'rgba(0,230,118,0.12)' },
                PAUSED: { color: '#ffd600', bg: 'rgba(255,214,0,0.12)' },
                BLOWN:  { color: '#ff1744', bg: 'rgba(255,23,68,0.12)'  },
            };
            const statusStyle = STATUS_MAP[displayStatus] || { color: 'rgba(255,255,255,0.4)', bg: 'rgba(255,255,255,0.05)' };

            // ── Buffer color: green >50% left, yellow ≤50%, red ≤20% ─────────
            const bufferPct = maxLoss > 0 ? buffer / maxLoss : 1;
            const bufferColor = buffer <= 0    ? '#ff1744'
                              : bufferPct <= 0.2 ? '#ff6d00'
                              : bufferPct <= 0.5 ? '#ffd600'
                              :                   '#00e676';

            // ── Formatted values ──────────────────────────────────────────────
            const sizeFormatted    = sizeNum >= 1000 ? (sizeNum / 1000) + 'K' : '$' + sizeNum;
            const balanceFormatted = balanceNum.toLocaleString('en-US', {style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2});
            const lossFormatted    = maxLoss.toLocaleString('en-US', {style: 'currency', currency: 'USD', maximumFractionDigits: 0});
            const pnlColor         = pnlValue >= 0 ? 'var(--primary)' : 'var(--error)';
            const pnlFormatted     = (pnlValue >= 0 ? '+' : '') + pnlValue.toLocaleString('en-US', {style: 'currency', currency: 'USD'});
            const bufferFormatted  = buffer.toLocaleString('en-US', {style: 'currency', currency: 'USD', maximumFractionDigits: 0});

            const rowHtml = `
                <tr style="border-bottom: 1px solid rgba(255,255,255,0.05);">
                    <td style="padding: 10px 15px; color: var(--text-light); font-weight: 500; white-space: nowrap;">
                        ${acc.account_name}
                        <div style="font-size: 0.75rem; color: var(--text-muted);">${acc.firm}</div>
                    </td>
                    <td style="padding: 10px 15px; color: var(--text-light); font-family: monospace; font-size: 0.9rem; font-weight: 600;">${balanceFormatted}</td>
                    <td style="padding: 10px 15px; color: ${pnlColor}; font-family: monospace; font-size: 0.9rem; font-weight: 600;">${pnlFormatted}</td>
                    <td style="padding: 10px 15px; color: ${bufferColor}; font-family: monospace; font-size: 0.9rem; font-weight: 600;">${bufferFormatted}</td>
                    <td style="padding: 10px 15px; color: var(--text-muted); font-size: 0.9rem;">${sizeFormatted}</td>
                    <td style="padding: 10px 15px; color: var(--text-muted); font-size: 0.9rem;">${lossFormatted}</td>
                    <td style="padding: 10px 15px;">
                        <span style="color: ${statusStyle.color}; background: ${statusStyle.bg}; font-weight: 700; font-size: 0.78rem; padding: 3px 10px; border-radius: 20px; letter-spacing: 0.5px;">${displayStatus}</span>
                    </td>
                    <td style="padding: 10px 15px; color: var(--text-muted); font-size: 0.8rem; white-space: nowrap;">
                        ${acc.created_at ? (() => {
                            const d = new Date(acc.created_at);
                            const dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' });
                            const daysAgo = Math.floor((Date.now() - d.getTime()) / 86_400_000);
                            const rel = daysAgo === 0 ? 'Today' : daysAgo === 1 ? '1 day ago' : `${daysAgo} days ago`;
                            return `${dateStr}<div style="font-size:0.72rem;color:var(--text-muted);margin-top:2px;">${rel}</div>`;
                        })() : '—'}
                    </td>
                    <td style="padding: 10px 15px; text-align: right; white-space: nowrap;">
                        <button onclick="openEditAccountModal('${acc.id}')" title="Edit" style="background: none; border: 1px solid rgba(102,252,241,0.3); color: var(--primary); border-radius: 6px; padding: 4px 9px; cursor: pointer; font-size: 0.8rem; margin-right: 6px; transition: all 0.2s;">✏️</button>
                        <button onclick="deletePropAccount('${acc.id}')" title="Delete" style="background: none; border: 1px solid rgba(255,60,60,0.3); color: var(--error); border-radius: 6px; padding: 4px 9px; cursor: pointer; font-size: 0.8rem; transition: all 0.2s;">🗑️</button>
                    </td>
                </tr>
            `;

            if (acc.phase === 'EVAL') evalHtml += rowHtml;
            else fundedHtml += rowHtml;

            if (firstRisk === null) {
                firstRisk = acc.risk_profile;
                localStorage.setItem('globalRiskProfile', firstRisk);
                updateGlobalRiskToggle(firstRisk);
            }
        });

        evalList.innerHTML   = evalHtml   || '<tr><td colspan="8" style="padding: 15px; text-align: center; color: var(--text-muted);">No evaluation accounts.</td></tr>';
        fundedList.innerHTML = fundedHtml || '<tr><td colspan="8" style="padding: 15px; text-align: center; color: var(--text-muted);">No funded accounts.</td></tr>';
    } catch (err) {
        console.error('Failed to load prop accounts:', err);
        if (err.status === 401) {
            evalList.innerHTML   = `<tr><td colspan="8" style="padding: 15px; text-align: center; color: var(--error);">Session expired. <a href="/" style="color: var(--primary);">Please log in again.</a></td></tr>`;
            fundedList.innerHTML = `<tr><td colspan="8" style="padding: 15px; text-align: center; color: var(--error);">Session expired. <a href="/" style="color: var(--primary);">Please log in again.</a></td></tr>`;
        } else {
            const msg = err.message || 'Error loading accounts. <a href="#" onclick="loadPropAccounts();return false;" style="color:var(--primary);">Retry</a>';
            evalList.innerHTML   = `<tr><td colspan="8" style="padding: 15px; text-align: center; color: var(--error);">${msg}</td></tr>`;
            fundedList.innerHTML = `<tr><td colspan="8" style="padding: 15px; text-align: center; color: var(--error);">${msg}</td></tr>`;
        }
    }
}

// ── CUSTOM CONFIRM MODAL ──────────────────────────────────────────────────────
function xConfirm({ title = 'Confirm', message = '', okLabel = 'Confirm', icon = '⚠️' } = {}) {
    return new Promise((resolve) => {
        const overlay = document.getElementById('xConfirmOverlay');
        const titleEl = document.getElementById('xConfirmTitle');
        const msgEl   = document.getElementById('xConfirmMsg');
        const okBtn   = document.getElementById('xConfirmOk');
        const cancelBtn = document.getElementById('xConfirmCancel');
        const iconEl  = document.getElementById('xConfirmIcon');
        if (!overlay) { resolve(window.confirm(message)); return; }

        titleEl.textContent = title;
        msgEl.textContent   = message;
        okBtn.textContent   = okLabel;
        iconEl.textContent  = icon;
        overlay.style.display = 'flex';

        const cleanup = (result) => {
            overlay.style.display = 'none';
            okBtn.removeEventListener('click', onOk);
            cancelBtn.removeEventListener('click', onCancel);
            overlay.removeEventListener('click', onOverlay);
            resolve(result);
        };
        const onOk      = () => cleanup(true);
        const onCancel  = () => cleanup(false);
        const onOverlay = (e) => { if (e.target === overlay) cleanup(false); };

        okBtn.addEventListener('click', onOk);
        cancelBtn.addEventListener('click', onCancel);
        overlay.addEventListener('click', onOverlay);
    });
}

// ── DELETE ACCOUNT ────────────────────────────────────────────────────────────
window.deletePropAccount = async function(id) {
    const confirmed = await xConfirm({
        title:   'Delete Account',
        message: 'This account will be permanently removed. This action cannot be undone.',
        okLabel: 'Delete',
        icon:    '🗑️',
    });
    if (!confirmed) return;
    try {
        await auth.request(`/trading/prop-accounts/${id}`, { method: 'DELETE' });
        loadPropAccounts();
    } catch (err) {
        await xConfirm({ title: 'Error', message: 'Failed to delete: ' + (err.message || 'Unknown error'), okLabel: 'OK', icon: '❌' });
    }
};

// ── EDIT ACCOUNT (stub — opens modal pre-filled) ──────────────────────────────
// ── EDIT ACCOUNT MODAL ────────────────────────────────────────────────────────
const editAccountModal = document.getElementById('editAccountModal');
const closeEditModalBtn = document.getElementById('closeEditModalBtn');
const editPropAccountForm = document.getElementById('editPropAccountForm');

// Status toggle styling
const STATUS_STYLES = {
    ACTIVE: { bg: 'rgba(0,230,118,0.15)', border: '#00e676', color: '#00e676' },
    PAUSED: { bg: 'rgba(255,214,0,0.15)', border: '#ffd600', color: '#ffd600' },
    BLOWN:  { bg: 'rgba(255,23,68,0.15)',  border: '#ff1744', color: '#ff1744' },
};

function _setEditStatusToggle(status) {
    document.getElementById('editAccountStatus').value = status;
    document.querySelectorAll('.edit-status-btn').forEach(btn => {
        const s = btn.dataset.status;
        const active = s === status;
        const styles = STATUS_STYLES[s] || {};
        btn.style.background = active ? styles.bg : 'rgba(255,255,255,0.04)';
        btn.style.border     = '1px solid ' + (active ? styles.border : 'rgba(255,255,255,0.1)');
        btn.style.color      = active ? styles.color : 'rgba(255,255,255,0.4)';
    });
}

// ── CURRENCY INPUT HELPERS ────────────────────────────────────────────────────
function formatCurrencyInput(val) {
    const num = parseFloat(String(val).replace(/[$,]/g, ''));
    if (isNaN(num) || val === '' || val === undefined) return '';
    return '$' + num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function parseCurrencyInput(val) {
    const num = parseFloat(String(val).replace(/[$,]/g, ''));
    return isNaN(num) ? undefined : num;
}

document.querySelectorAll('.edit-status-btn').forEach(btn => {
    btn.addEventListener('click', () => _setEditStatusToggle(btn.dataset.status));
});

if (closeEditModalBtn) closeEditModalBtn.addEventListener('click', () => { editAccountModal.style.display = 'none'; });
if (editAccountModal) editAccountModal.addEventListener('click', (e) => { if (e.target === editAccountModal) editAccountModal.style.display = 'none'; });

window.openEditAccountModal = async function(id) {
    // Fetch fresh account list to find this row
    try {
        const accounts = await auth.request('/trading/prop-accounts', { method: 'GET' });
        const acc = accounts.find(a => a.id === id || String(a.id) === String(id));
        if (!acc) { await xConfirm({ title: 'Error', message: 'Account not found.', okLabel: 'OK', icon: '❌' }); return; }

        const currentBalance = Number(acc.account_balance ?? acc.account_size);
        const balPlaceholder = 'Balance: ' + currentBalance.toLocaleString('en-US', {style: 'currency', currency: 'USD', maximumFractionDigits: 0});
        const balInput = document.getElementById('editAccountBalance');
        balInput.value       = formatCurrencyInput(currentBalance);
        balInput.placeholder = balPlaceholder;
        // Live format while typing
        balInput.oninput = () => {
            const raw = balInput.value.replace(/[^0-9.]/g, '');
            const parts = raw.split('.');
            const intFormatted = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
            balInput.value = '$' + intFormatted + (parts.length > 1 ? '.' + parts[1].slice(0, 2) : '');
        };
        // Reformat on blur (adds .00 if missing)
        balInput.onblur = () => { const formatted = formatCurrencyInput(balInput.value); if (formatted) balInput.value = formatted; };
        document.getElementById('editAccountId').value        = acc.id;
        document.getElementById('editAccountName').value      = acc.account_name;
        document.getElementById('editAccountError').style.display = 'none';
        document.getElementById('editAccountSubtitle').textContent = acc.firm + ' · ' + (Number(acc.account_size) / 1000) + 'K';
        _setEditStatusToggle(acc.status || 'ACTIVE');

        editAccountModal.style.display = 'flex';
    } catch (err) {
        await xConfirm({ title: 'Error', message: 'Could not load account data.', okLabel: 'OK', icon: '❌' });
    }
};

if (editPropAccountForm) {
    editPropAccountForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const id      = document.getElementById('editAccountId').value;
        const name    = document.getElementById('editAccountName').value.trim();
        const status  = document.getElementById('editAccountStatus').value;
        const balRaw  = document.getElementById('editAccountBalance').value;
        const balance = parseCurrencyInput(balRaw);
        const errEl   = document.getElementById('editAccountError');
        const submitBtn = editPropAccountForm.querySelector('[type=submit]');

        if (!name) { errEl.textContent = 'Account name is required.'; errEl.style.display = 'block'; return; }
        errEl.style.display = 'none';
        submitBtn.textContent = 'Saving...';
        submitBtn.disabled = true;

        try {
            await auth.request(`/trading/prop-accounts/${id}`, {
                method: 'PATCH',
                body: JSON.stringify({ account_name: name, status, account_balance: balance }),
            });
            editAccountModal.style.display = 'none';
            loadPropAccounts();
        } catch (err) {
            errEl.textContent = err.message || 'Failed to save. Please try again.';
            errEl.style.display = 'block';
        } finally {
            submitBtn.textContent = 'Save Changes';
            submitBtn.disabled = false;
        }
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// 🔔 NOTIFICATION CENTER
// ─────────────────────────────────────────────────────────────────────────────
(function initNotificationCenter() {
    const bellBtn     = document.getElementById('notifBellBtn');
    const dropdown    = document.getElementById('notifDropdown');
    const badge       = document.getElementById('notifBadge');
    const list        = document.getElementById('notifList');
    const pagination  = document.getElementById('notifPagination');
    const markReadBtn = document.getElementById('notifMarkRead');
    const historyLink = document.getElementById('notifHistoryLink');

    // History modal elements
    const overlay     = document.getElementById('notifHistoryOverlay');
    const historyBody = document.getElementById('notifHistoryBody');
    const historyPag  = document.getElementById('notifHistoryPagination');
    const historyMark = document.getElementById('notifHistoryMarkAll');
    const historyClose= document.getElementById('notifHistoryClose');

    if (!bellBtn || !dropdown) return;

    let currentPage = 1;
    const PAGE_LIMIT = 20;

    // ── Time helpers (UTC → EST display) ──────────────────────────────────
    function relativeTime(isoStr) {
        const diff = Math.floor((Date.now() - new Date(isoStr).getTime()) / 1000);
        if (diff < 60)    return 'just now';
        if (diff < 3600)  return `${Math.floor(diff / 60)} min ago`;
        if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
        return `${Math.floor(diff / 86400)}d ago`;
    }
    function absTimeEST(isoStr) {
        return new Date(isoStr).toLocaleString('en-US', {
            timeZone: 'America/New_York',
            month: 'short', day: 'numeric',
            hour: 'numeric', minute: '2-digit', hour12: true
        }) + ' ET';
    }

    // ── Renders an array of notification items into a container ───────────
    function renderItems(items, container) {
        if (items.length === 0) {
            container.innerHTML = '<div class="notif-empty">No notifications yet.</div>';
            return;
        }
        container.innerHTML = items.map(n => `
            <div class="notif-item ${n.read ? '' : 'unread'}" data-id="${n.id}">
                <span class="notif-msg">${n.message}</span>
                <div class="notif-time-wrap">
                    <span class="notif-rel-time">${relativeTime(n.created_at)}</span>
                    <span class="notif-abs-time">${absTimeEST(n.created_at)}</span>
                </div>
            </div>
        `).join('');
    }

    // ── Badge updater ─────────────────────────────────────────────────────
    async function refreshBadge() {
        try {
            const data  = await auth.request('/trading/notifications/unread-count', { method: 'GET' });
            const count = data.unread || 0;
            if (count > 0) {
                badge.textContent = count > 99 ? '99+' : count;
                badge.style.display = 'flex';
                bellBtn.classList.add('has-unread');
            } else {
                badge.style.display = 'none';
                bellBtn.classList.remove('has-unread');
            }
        } catch (_) { /* silent */ }
    }

    // ── Load UNREAD-only notifications into dropdown ───────────────────────
    async function loadDropdown(page = 1) {
        currentPage = page;
        try {
            const data  = await auth.request(`/trading/notifications?page=${page}&limit=${PAGE_LIMIT}&unread_only=true`, { method: 'GET' });
            const items = data.notifications || [];
            const total = data.total || 0;

            if (items.length === 0) {
                list.innerHTML = '<div class="notif-empty">All caught up 🎉</div>';
                pagination.innerHTML = '';
                return;
            }
            renderItems(items, list);

            const totalPages = Math.ceil(total / PAGE_LIMIT);
            if (totalPages > 1) {
                pagination.innerHTML = Array.from({ length: totalPages }, (_, i) => i + 1)
                    .map(p => `<button class="notif-page-btn ${p === page ? 'active' : ''}" data-page="${p}">${p}</button>`)
                    .join('');
                pagination.querySelectorAll('.notif-page-btn').forEach(btn =>
                    btn.addEventListener('click', () => loadDropdown(parseInt(btn.dataset.page)))
                );
            } else { pagination.innerHTML = ''; }
        } catch (_) {
            list.innerHTML = '<div class="notif-empty">Failed to load notifications.</div>';
        }
    }

    // ── Mark-as-read helper (reloads list from DB for guaranteed accuracy) ──
    async function markOneRead(id, rowEl, reloadFn) {
        rowEl.classList.add('marking');
        try {
            await auth.request(`/trading/notifications/${id}/read`, { method: 'PATCH' });
            await refreshBadge();
            await reloadFn();
        } catch (err) {
            console.error('[Notif] markOneRead failed:', err);
            rowEl.classList.remove('marking');
        }
    }

    // ── Event delegation — dropdown list (click row to mark read) ──────────
    list.addEventListener('click', async (e) => {
        const row = e.target.closest('.notif-item.unread');
        if (row) {
            await markOneRead(row.dataset.id, row, () => loadDropdown(currentPage));
        }
    });

    // ── Event delegation — history modal list (click row to mark read) ─────
    if (historyBody) {
        historyBody.addEventListener('click', async (e) => {
            const row = e.target.closest('.notif-item.unread');
            if (row) {
                await markOneRead(row.dataset.id, row, () => loadHistoryModal(currentHistoryPage));
            }
        });
    }

    // ── Bell click — toggle dropdown ──────────────────────────────────────
    bellBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const isOpen = dropdown.classList.contains('open');
        dropdown.classList.toggle('open', !isOpen);
        if (!isOpen) {
            await loadDropdown(1);  // just shows list — user marks manually
        }
    });

    // ── Mark all read button (dropdown header) — reload list after ────────
    markReadBtn?.addEventListener('click', async () => {
        markReadBtn.textContent = '…';
        markReadBtn.disabled = true;
        try {
            await auth.request('/trading/notifications/read-all', { method: 'PATCH' });
            await refreshBadge();
            await loadDropdown(currentPage);  // reload from DB
        } catch (err) {
            console.error('[Notif] markAllRead (dropdown) failed:', err);
        } finally {
            markReadBtn.textContent = 'Mark all read';
            markReadBtn.disabled = false;
        }
    });

    // ── View All History — open modal ─────────────────────────────────────
    let currentHistoryPage = 1;
    async function loadHistoryModal(page = 1) {
        currentHistoryPage = page;
        if (!overlay || !historyBody) return;
        overlay.classList.add('open');
        dropdown.classList.remove('open');
        historyBody.innerHTML = '<div class="notif-empty">Loading...</div>';
        try {
            const data  = await auth.request(`/trading/notifications?page=${page}&limit=${PAGE_LIMIT}`, { method: 'GET' });
            const items = data.notifications || [];
            const total = data.total || 0;
            renderItems(items, historyBody);

            const totalPages = Math.ceil(total / PAGE_LIMIT);
            if (historyPag) {
                if (totalPages > 1) {
                    historyPag.innerHTML = Array.from({ length: totalPages }, (_, i) => i + 1)
                        .map(p => `<button class="notif-page-btn ${p === page ? 'active' : ''}" data-page="${p}">${p}</button>`)
                        .join('');
                    historyPag.querySelectorAll('.notif-page-btn').forEach(btn =>
                        btn.addEventListener('click', () => loadHistoryModal(parseInt(btn.dataset.page)))
                    );
                } else { historyPag.innerHTML = ''; }
            }
        } catch (_) {
            historyBody.innerHTML = '<div class="notif-empty">Failed to load history.</div>';
        }
    }

    historyLink?.addEventListener('click', (e) => { e.preventDefault(); loadHistoryModal(1); });

    historyClose?.addEventListener('click', () => overlay?.classList.remove('open'));
    overlay?.addEventListener('click', (e) => { if (e.target === overlay) overlay.classList.remove('open'); });

    historyMark?.addEventListener('click', async () => {
        historyMark.textContent = '…';
        historyMark.disabled = true;
        try {
            await auth.request('/trading/notifications/read-all', { method: 'PATCH' });
            await refreshBadge();
            await loadHistoryModal(currentHistoryPage);  // reload from DB
        } catch (err) {
            console.error('[Notif] markAllRead (history) failed:', err);
        } finally {
            historyMark.textContent = 'Mark all read';
            historyMark.disabled = false;
        }
    });

    // ── Close dropdown on outside click ───────────────────────────────────
    document.addEventListener('click', (e) => {
        if (!document.getElementById('notifBellWrap')?.contains(e.target)) {
            dropdown.classList.remove('open');
        }
    });

    // ── Initial badge load ─────────────────────────────────────────────────
    refreshBadge();

    // ── SSE — real-time notification push ─────────────────────────────────
    // EventSource cannot set custom headers, so auth token passed as ?token=
    const sseToken = auth.getToken();
    if (sseToken && typeof EventSource !== 'undefined') {
        const sseUrl = `/api/auth/trading/notifications/stream?token=${encodeURIComponent(sseToken)}`;
        const evtSource = new EventSource(sseUrl);

        evtSource.addEventListener('connected', () => {
            console.log('[Notif SSE] 🟢 Stream connected — real-time notifications active');
        });

        evtSource.addEventListener('notification', async () => {
            // New notification arrived — refresh badge instantly
            await refreshBadge();
            // If dropdown is already open, reload it so new item appears
            if (dropdown.classList.contains('open')) {
                await loadDropdown(currentPage);
            }
        });

        evtSource.onerror = () => {
            // EventSource auto-reconnects; this fires on every retry attempt
            // No action needed — reconnect is handled natively
        };

        // 60s fallback poll: keeps badge accurate even during extended SSE outages
        setInterval(refreshBadge, 60_000);
    } else {
        // No EventSource support (very old browser) → fall back to 30s poll
        setInterval(refreshBadge, 30_000);
    }
})();


// ── CUSTOM SELECT LOGIC ────────────────────────────────────────────────────────
const customSelectTrigger = document.getElementById('customSelectTrigger');
const customOptionsContainer = document.getElementById('customOptionsContainer');
const customSelectLabel = document.getElementById('customSelectLabel');
const propSizeInput = document.getElementById('propSize');

// Teleport dropdown to <body> to escape modal overflow clipping
if (customOptionsContainer && customOptionsContainer.parentNode !== document.body) {
    document.body.appendChild(customOptionsContainer);
}

function _positionDropdown() {
    if (!customSelectTrigger || !customOptionsContainer) return;
    const rect = customSelectTrigger.getBoundingClientRect();
    customOptionsContainer.style.position   = 'fixed';
    customOptionsContainer.style.top        = (rect.bottom + 6) + 'px';
    customOptionsContainer.style.left       = rect.left + 'px';
    customOptionsContainer.style.width      = rect.width + 'px';
    customOptionsContainer.style.zIndex     = '2147483647';
    customOptionsContainer.style.maxHeight  = '220px';
    customOptionsContainer.style.overflowY  = 'auto';
}

if (customSelectTrigger && customOptionsContainer) {
    customSelectTrigger.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = customOptionsContainer.style.display === 'block';
        if (isOpen) {
            customOptionsContainer.style.opacity = '0';
            customOptionsContainer.style.transform = 'translateY(-6px)';
            customSelectTrigger.classList.remove('open');
            setTimeout(() => { customOptionsContainer.style.display = 'none'; }, 200);
        } else {
            _positionDropdown();
            customOptionsContainer.style.display = 'block';
            setTimeout(() => {
                customOptionsContainer.style.opacity = '1';
                customOptionsContainer.style.transform = 'translateY(0)';
            }, 10);
            customSelectTrigger.classList.add('open');
        }
    });

    // Dynamically inject options to bypass aggressive adblockers or HTML cache dropping the 150K node
    customOptionsContainer.innerHTML = `
        <div class="custom-option" data-value="50000" style="padding: 12px 16px; color: var(--text-light); cursor: pointer; transition: background 0.2s; display: block !important; visibility: visible !important;">TopStep - No Activation - 50K</div>
        <div class="custom-option" data-value="100000" style="padding: 12px 16px; color: var(--text-light); cursor: pointer; transition: background 0.2s; display: block !important; visibility: visible !important;">TopStep - No Activation - 100K</div>
        <div class="custom-option" data-value="150000" style="padding: 12px 16px; color: var(--text-light); cursor: pointer; transition: background 0.2s; display: block !important; visibility: visible !important;">TopStep - No Activation - 150K</div>
    `;

    document.querySelectorAll('.custom-option').forEach(option => {
        option.addEventListener('click', (e) => {
            e.stopPropagation();
            const value = e.target.getAttribute('data-value');
            const text = e.target.textContent;
            
            // Update UI & Hidden Input
            customSelectLabel.textContent = text;
            customSelectLabel.style.color = 'var(--text-main)';
            propSizeInput.value = value;
            
            // Close Dropdown
            customOptionsContainer.style.opacity = '0';
            customOptionsContainer.style.transform = 'translateY(-10px)';
            customSelectTrigger.classList.remove('open');
            setTimeout(() => { customOptionsContainer.style.display = 'none'; }, 200);
        });
    });

    // Close on outside click
    document.addEventListener('click', (e) => {
        if (!customSelectTrigger.contains(e.target) && !customOptionsContainer.contains(e.target)) {
            customOptionsContainer.style.opacity = '0';
            customOptionsContainer.style.transform = 'translateY(-10px)';
            customSelectTrigger.classList.remove('open');
            setTimeout(() => { customOptionsContainer.style.display = 'none'; }, 200);
        }
    });
}

// ── PHASE TOGGLE LOGIC ────────────────────────────────────────────────────────
const phaseBtnEval = document.getElementById('phaseBtnEval');
const phaseBtnFunded = document.getElementById('phaseBtnFunded');
const propPhaseValue = document.getElementById('propPhaseValue');

function setPhaseToggle(phase) {
    if (!phaseBtnEval || !phaseBtnFunded || !propPhaseValue) return;
    propPhaseValue.value = phase;
    if (phase === 'EVAL') {
        phaseBtnEval.style.background = 'rgba(52, 211, 153, 0.2)';
        phaseBtnEval.style.borderColor = '#34d399';
        phaseBtnEval.style.color = '#34d399';
        phaseBtnFunded.style.background = 'rgba(255, 255, 255, 0.05)';
        phaseBtnFunded.style.borderColor = 'var(--glass-border)';
        phaseBtnFunded.style.color = 'var(--text-muted)';
    } else {
        phaseBtnFunded.style.background = 'rgba(52, 211, 153, 0.2)';
        phaseBtnFunded.style.borderColor = '#34d399';
        phaseBtnFunded.style.color = '#34d399';
        phaseBtnEval.style.background = 'rgba(255, 255, 255, 0.05)';
        phaseBtnEval.style.borderColor = 'var(--glass-border)';
        phaseBtnEval.style.color = 'var(--text-muted)';
    }
}

if (phaseBtnEval) phaseBtnEval.addEventListener('click', () => setPhaseToggle('EVAL'));
if (phaseBtnFunded) phaseBtnFunded.addEventListener('click', () => setPhaseToggle('FUNDED'));

const propForm = document.getElementById('addPropAccountForm');
if (propForm) {
    propForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = propForm.querySelector('button[type="submit"]');
        const originalText = btn.textContent;
        
        try {
            btn.disabled = true;
            btn.textContent = 'Initializing...';
            
            await auth.request('/trading/prop-accounts', {
                method: 'POST',
                body: JSON.stringify({
                    account_name: document.getElementById('propAccountName').value,
                    firm: 'Topstep',
                    phase: document.getElementById('propPhaseValue').value,
                    risk_profile: localStorage.getItem('globalRiskProfile') || 'SAFE',
                    account_size: Number(document.getElementById('propSize').value)
                })
            });
            
            propForm.reset();
            
            // Reset custom select UI
            if (customSelectLabel && propSizeInput) {
                customSelectLabel.textContent = 'Select Account Type';
                customSelectLabel.style.color = 'var(--text-muted)';
                propSizeInput.value = '';
            }
            
            // Reset phase toggle UI to EVAL
            setPhaseToggle('EVAL');

            await loadPropAccounts();
            
            // Temporary success state
            btn.textContent = 'Success!';
            btn.style.background = 'var(--primary)';
            btn.style.color = '#000';
            setTimeout(() => {
                btn.textContent = originalText;
                btn.style.background = '';
                btn.style.color = '';
                if (propAccountModal) propAccountModal.style.display = 'none';
            }, 1000);
            
        } catch (err) {
            alert('Failed to add account: ' + (err.message || 'Unknown error'));
            btn.textContent = originalText;
        } finally {
            btn.disabled = false;
        }
    });
}

/* =========================================
   HOME SCREEN CALENDAR ENGINE
   ========================================= */
const calMonthYear = document.getElementById('calMonthYear');
const calendarGrid = document.getElementById('calendarGrid');
const btnPrevMonth = document.getElementById('calPrevMonth');
const btnNextMonth = document.getElementById('calNextMonth');

let currentCalDate = new Date(); // Tracks the currently viewed month

function renderCalendar(dateToRender) {
    if (!calendarGrid || !calMonthYear) return;
    
    calendarGrid.innerHTML = ''; // Clear existing days
    
    const year = dateToRender.getFullYear();
    const month = dateToRender.getMonth();
    
    // Set Header Title (e.g. "May 2026")
    const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    calMonthYear.textContent = `${monthNames[month]} ${year}`;
    
    // Manage Today button visibility
    const calTodayBtn = document.getElementById('calTodayBtn');
    if (calTodayBtn) {
        const realToday = new Date();
        if (year === realToday.getFullYear() && month === realToday.getMonth()) {
            calTodayBtn.classList.add('hidden');
        } else {
            calTodayBtn.classList.remove('hidden');
        }
    }
    
    // Set Top Bar Today Text
    const today = new Date();
    const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const epicCalTodayText = document.getElementById('epicCalTodayText');
    if (epicCalTodayText) {
        epicCalTodayText.textContent = `${dayNames[today.getDay()]}, ${monthNames[today.getMonth()]} ${today.getDate()}`;
    }
    
    // Calculate first day of the month and total days
    const firstDayIndex = new Date(year, month, 1).getDay(); // 0 (Sun) to 6 (Sat)
    const totalDays = new Date(year, month + 1, 0).getDate();
    
    // Calculate previous month total days
    const prevMonthDays = new Date(year, month, 0).getDate();
    
    const isCurrentMonth = today.getMonth() === month && today.getFullYear() === year;
    const currentDay = today.getDate();
    
    // 1. Inject faded days for previous month
    for (let x = firstDayIndex; x > 0; x--) {
        const dayCell = document.createElement('div');
        dayCell.classList.add('epic-cal-day', 'faded');
        // If the day is Sun (0) or Sat (6)
        const cellDayIndex = (firstDayIndex - x) % 7;
        if (cellDayIndex === 0 || cellDayIndex === 6) {
            dayCell.classList.add('weekend');
        }
        dayCell.textContent = prevMonthDays - x + 1;
        calendarGrid.appendChild(dayCell);
    }
    
    // 2. Inject actual days
    for (let day = 1; day <= totalDays; day++) {
        const dayCell = document.createElement('div');
        dayCell.classList.add('epic-cal-day');
        
        const cellDayIndex = new Date(year, month, day).getDay();
        if (cellDayIndex === 0 || cellDayIndex === 6) {
            dayCell.classList.add('weekend');
        }
        
        dayCell.textContent = day;
        
        // Add dot for aesthetic flair on some dummy days
        if (day === 7 || day === 12 || day === 25 || day === 31) {
            dayCell.classList.add('has-event');
            const dot = document.createElement('div');
            dot.classList.add('dot');
            dayCell.appendChild(dot);
        }
        
        if (isCurrentMonth && day === currentDay) {
            dayCell.classList.add('today');
        }
        
        calendarGrid.appendChild(dayCell);
    }
    
    // 3. Inject faded days for next month to fill grid (42 cells total for 6 rows)
    const totalCells = firstDayIndex + totalDays;
    const nextMonthDaysCount = 42 - totalCells;
    
    for (let j = 1; j <= nextMonthDaysCount; j++) {
        const dayCell = document.createElement('div');
        dayCell.classList.add('epic-cal-day', 'faded');
        
        const cellDayIndex = new Date(year, month + 1, j).getDay();
        if (cellDayIndex === 0 || cellDayIndex === 6) {
            dayCell.classList.add('weekend');
        }
        
        dayCell.textContent = j;
        calendarGrid.appendChild(dayCell);
    }
}

// Initial render
if (document.getElementById('homeView')) {
    renderCalendar(currentCalDate);
}

// Custom Overlay Nav Logic
const overlayMonthYearText = document.getElementById('calMonthYear');
const calMonthPickerOverlay = document.getElementById('calMonthPickerOverlay');
const calMainBody = document.getElementById('calMainBody');
const calMonthGrid = document.getElementById('calMonthGrid');
const calYearGrid = document.getElementById('calYearGrid');
const calDecadeGrid = document.getElementById('calDecadeGrid');
const calTodayBtn = document.getElementById('calTodayBtn');

const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
let overlayYear = currentCalDate.getFullYear();
let overlayMode = 'closed'; // 'closed', 'months', 'years', 'decades'

if (overlayMonthYearText && calMonthPickerOverlay) {
    // Open Overlay or Toggle Modes
    overlayMonthYearText.addEventListener('click', (e) => {
        e.stopPropagation();
        
        if (overlayMode === 'closed') {
            // Open into months mode
            overlayMode = 'months';
            overlayYear = currentCalDate.getFullYear();
            renderOverlay();
            calMonthPickerOverlay.classList.add('active');
            calMainBody.classList.add('dimmed');
        } else if (overlayMode === 'months') {
            // Switch to years mode
            overlayMode = 'years';
            renderOverlay();
        } else if (overlayMode === 'years') {
            // Switch to decades mode
            overlayMode = 'decades';
            renderOverlay();
        }
        // If already in decades, we stay there (or go higher, but we stop at decades)
    });

    if (calTodayBtn) {
        calTodayBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            currentCalDate = new Date();
            renderCalendar(currentCalDate);
            closeOverlay();
        });
    }

    function renderOverlay() {
        if (!overlayMonthYearText) return;
        if (calTodayBtn) calTodayBtn.classList.remove('hidden');
        
        if (overlayMode === 'months') {
            if (calYearGrid) calYearGrid.classList.add('hidden');
            if (calDecadeGrid) calDecadeGrid.classList.add('hidden');
            if (calMonthGrid) calMonthGrid.classList.remove('hidden');
            
            overlayMonthYearText.textContent = overlayYear;
            calMonthGrid.innerHTML = '';

            monthNames.forEach((month, index) => {
                const btn = document.createElement('button');
                btn.classList.add('epic-cal-month-btn');
                
                if (overlayYear === currentCalDate.getFullYear() && index === currentCalDate.getMonth()) {
                    btn.classList.add('selected');
                }
                
                btn.textContent = month;
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    currentCalDate.setFullYear(overlayYear, index, 1);
                    renderCalendar(currentCalDate);
                    closeOverlay();
                });
                calMonthGrid.appendChild(btn);
            });
        } else if (overlayMode === 'years') {
            if (calMonthGrid) calMonthGrid.classList.add('hidden');
            if (calDecadeGrid) calDecadeGrid.classList.add('hidden');
            if (calYearGrid) calYearGrid.classList.remove('hidden');
            
            // Generate a 12-year window based on the decade
            const decadeStart = Math.floor(overlayYear / 10) * 10;
            // E.g., if year is 2026 -> decadeStart = 2020. We will show 2020-2031.
            overlayMonthYearText.textContent = `${decadeStart} - ${decadeStart + 11}`;
            
            calYearGrid.innerHTML = '';
            for (let i = 0; i < 12; i++) {
                const y = decadeStart + i;
                const btn = document.createElement('button');
                btn.classList.add('epic-cal-month-btn');
                
                if (y === currentCalDate.getFullYear()) {
                    btn.classList.add('selected');
                }
                
                btn.textContent = y;
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    overlayYear = y;
                    overlayMode = 'months';
                    renderOverlay();
                });
                calYearGrid.appendChild(btn);
            }
        } else if (overlayMode === 'decades') {
            if (calMonthGrid) calMonthGrid.classList.add('hidden');
            if (calYearGrid) calYearGrid.classList.add('hidden');
            if (calDecadeGrid) calDecadeGrid.classList.remove('hidden');
            
            // Generate a 12-decade window (120 years).
            // Calculate a century-aligned anchor to center around
            // E.g., if year is 2026, let's show 1950 - 2069 (12 decades).
            // A simple anchor: subtract 5 decades to keep the current year somewhat centered.
            const decadeStart = Math.floor(overlayYear / 10) * 10;
            const gridDecadeStart = decadeStart - 50; 
            
            overlayMonthYearText.textContent = `${gridDecadeStart} - ${gridDecadeStart + 119}`;
            
            const currentDecade = Math.floor(currentCalDate.getFullYear() / 10) * 10;
            
            calDecadeGrid.innerHTML = '';
            for (let i = 0; i < 12; i++) {
                const d = gridDecadeStart + (i * 10);
                const btn = document.createElement('button');
                btn.classList.add('epic-cal-month-btn');
                
                if (d === currentDecade) {
                    btn.classList.add('selected');
                }
                
                // Show as "1990", "2000", "2010"
                btn.textContent = d;
                
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    overlayYear = d; // Sets the focus to the start of that decade
                    overlayMode = 'years';
                    renderOverlay();
                });
                calDecadeGrid.appendChild(btn);
            }
        }
    }

    function closeOverlay() {
        overlayMode = 'closed';
        calMonthPickerOverlay.classList.remove('active');
        calMainBody.classList.remove('dimmed');
        renderCalendar(currentCalDate); // Restores "Month Year" header
    }
}

// =========================================
// EVENTS PANEL ENGINE
// =========================================
function renderEvents() {
    const eventsTodayList = document.getElementById('eventsTodayList');
    const eventsThisWeekList = document.getElementById('eventsThisWeekList');
    const eventsNextWeekList = document.getElementById('eventsNextWeekList');
    
    if (!eventsTodayList || !eventsThisWeekList || !eventsNextWeekList) return;
    
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    
    const endOfToday = new Date(startOfToday);
    endOfToday.setDate(endOfToday.getDate() + 1);
    
    // This week ends on Saturday at 23:59:59.
    // If today is Sunday (0), end of week is Saturday (6) -> 6 days ahead.
    const daysUntilSaturday = 6 - now.getDay();
    const endOfThisWeek = new Date(startOfToday);
    endOfThisWeek.setDate(endOfThisWeek.getDate() + daysUntilSaturday + 1); // +1 because we use < for comparison
    
    const endOfNextWeek = new Date(endOfThisWeek);
    endOfNextWeek.setDate(endOfNextWeek.getDate() + 7);
    
    // Mock events based on current time to ensure they always populate the UI
    const mockEvents = [];
    
    // Generate enough data to trigger pagination (more than 4)
    for (let i = 0; i < 7; i++) {
        mockEvents.push({ title: `Today Event ${i + 1}`, date: new Date(now.getTime() + (i + 1) * 60 * 60 * 1000) });
    }
    
    if (daysUntilSaturday > 0) {
        for (let i = 0; i < 6; i++) {
            mockEvents.push({ title: `Upcoming Event ${i + 1}`, date: new Date(startOfToday.getTime() + 1 * 24 * 60 * 60 * 1000 + i * 4 * 60 * 60 * 1000) });
        }
    }
    
    for (let i = 0; i < 8; i++) {
        mockEvents.push({ title: `Next Week Event ${i + 1}`, date: new Date(startOfToday.getTime() + 8 * 24 * 60 * 60 * 1000 + i * 12 * 60 * 60 * 1000) });
    }
    
    // Sort events chronologically
    mockEvents.sort((a, b) => a.date - b.date);
    
    // Categorize
    const todayEvents = [];
    const thisWeekEvents = [];
    const nextWeekEvents = [];
    
    mockEvents.forEach(evt => {
        if (evt.date >= startOfToday && evt.date < endOfToday) {
            todayEvents.push(evt);
        } else if (evt.date >= endOfToday && evt.date < endOfThisWeek) {
            thisWeekEvents.push(evt);
        } else if (evt.date >= endOfThisWeek && evt.date < endOfNextWeek) {
            nextWeekEvents.push(evt);
        }
    });
    
    function formatEventTime(date) {
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    function formatEventDate(date) {
        return date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
    }
    
    const EVENTS_PER_PAGE = 4;
    
    // State to track current page for each tab
    const paginationState = {
        'today': { page: 1, events: todayEvents, listEl: eventsTodayList, paginatorEl: document.getElementById('pagination-today'), stylingClass: '' },
        'thisWeek': { page: 1, events: thisWeekEvents, listEl: eventsThisWeekList, paginatorEl: document.getElementById('pagination-thisWeek'), stylingClass: 'upcoming' },
        'nextWeek': { page: 1, events: nextWeekEvents, listEl: eventsNextWeekList, paginatorEl: document.getElementById('pagination-nextWeek'), stylingClass: 'next-week' }
    };
    
    function renderPage(tabId) {
        const state = paginationState[tabId];
        const { page, events, listEl, paginatorEl, stylingClass } = state;
        
        listEl.innerHTML = '';
        if (events.length === 0) {
            listEl.innerHTML = '<div class="epic-event-empty">No events scheduled.</div>';
            if (paginatorEl) paginatorEl.innerHTML = '';
            return;
        }
        
        const totalPages = Math.ceil(events.length / EVENTS_PER_PAGE);
        const startIndex = (page - 1) * EVENTS_PER_PAGE;
        const endIndex = startIndex + EVENTS_PER_PAGE;
        const pageEvents = events.slice(startIndex, endIndex);
        
        pageEvents.forEach(evt => {
            const li = document.createElement('li');
            if (stylingClass) li.classList.add(stylingClass);
            
            const timeSpan = document.createElement('span');
            timeSpan.classList.add('epic-event-time');
            timeSpan.textContent = stylingClass === 'next-week' ? formatEventDate(evt.date) : formatEventTime(evt.date);
            
            const titleSpan = document.createElement('span');
            titleSpan.classList.add('epic-event-title');
            titleSpan.textContent = evt.title;
            
            li.appendChild(timeSpan);
            li.appendChild(titleSpan);
            listEl.appendChild(li);
        });
        
        // Render pagination controls
        if (paginatorEl) {
            if (totalPages > 1) {
                let dotsHtml = '';
                for (let i = 1; i <= totalPages; i++) {
                    dotsHtml += `<div class="epic-page-dot ${i === page ? 'active' : ''}" data-page="${i}"></div>`;
                }
                paginatorEl.innerHTML = dotsHtml;
                
                const dots = paginatorEl.querySelectorAll('.epic-page-dot');
                dots.forEach(dot => {
                    dot.addEventListener('click', (e) => {
                        const targetPage = parseInt(e.target.getAttribute('data-page'));
                        if (targetPage !== state.page) {
                            state.page = targetPage;
                            renderPage(tabId);
                        }
                    });
                });
            } else {
                paginatorEl.innerHTML = '';
            }
        }
    }
    
    // Initial Render
    renderPage('today');
    renderPage('thisWeek');
    renderPage('nextWeek');
    
    // Tab Switching Logic
    const tabs = document.querySelectorAll('.epic-event-tab');
    const tabContents = document.querySelectorAll('.epic-events-tab-content');
    
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            tabs.forEach(t => t.classList.remove('active'));
            tabContents.forEach(c => c.classList.remove('active'));
            
            tab.classList.add('active');
            
            const targetId = 'tab-' + tab.getAttribute('data-tab');
            const targetContent = document.getElementById(targetId);
            if (targetContent) {
                targetContent.classList.add('active');
            }
        });
    });
}

// Call renderEvents initially
if (document.getElementById('eventsTodayList')) {
    renderEvents();
}

