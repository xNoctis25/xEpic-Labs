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
        globalRiskToggleBtn.textContent = 'Risk: AGGRESSIVE 🚀';
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
    // CME Futures Sessions (ET):
    //   Tokyo:    18:00–04:00 (1080–240)
    //   London:   02:00–11:00 (120–660)
    //   New York: 08:00–17:00 (480–1020)
    // Overlaps:
    //   Tokyo + London:    02:00–04:00 (120–240)
    //   London + New York: 08:00–11:00 (480–660)
    let sessionColor = 'green';
    let kzText       = '';
    let kzColor      = 'gray';

    const isTokyo  = totalMinutes >= 1080 || totalMinutes < 240;   // 18:00–04:00
    const isLondon = totalMinutes >= 120  && totalMinutes < 660;   // 02:00–11:00
    const isNY     = totalMinutes >= 480  && totalMinutes < 1020;  // 08:00–17:00

    const activeSessions = [];
    if (isTokyo)  activeSessions.push('Tokyo');
    if (isLondon) activeSessions.push('London');
    if (isNY)     activeSessions.push('New York');

    const isOverlap = activeSessions.length > 1;

    if (activeSessions.length === 0) {
        // 17:00–18:00 gap caught by CME Maint above; this shouldn't fire
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

    // Killzone classification (matches engine MarketClock exactly)
    //   London KZ: 02:15–05:00 ET
    //   NY AM:     09:30–11:30 ET
    //   NY PM:     13:30–16:15 ET
    //   Wilderness = futures session open (09:30–17:00) but outside all killzones
    const isLondonKZ   = totalMinutes >= 135 && totalMinutes < 300;   // 02:15–05:00
    const isNYAM       = totalMinutes >= 570 && totalMinutes < 690;   // 09:30–11:30
    const isNYPM       = totalMinutes >= 810 && totalMinutes < 975;   // 13:30–16:15
    const isMarketOpen = totalMinutes >= 570 && totalMinutes < 1020;  // 09:30–17:00

    if (isLondonKZ) {
        kzText = 'Killzone: London'; kzColor = 'green';
    } else if (isNYAM) {
        kzText = 'Killzone: NY AM'; kzColor = 'green';
    } else if (isNYPM) {
        kzText = 'Killzone: NY PM'; kzColor = 'green';
    } else if (activeSessions.length > 0) {
        kzText = 'Killzone: Wilderness'; kzColor = 'yellow';
    } else {
        kzText = 'Killzone: Inactive'; kzColor = 'gray';
    }

    uiKillzoneLabel.textContent = kzText;
    uiKillzoneDot.className     = 'dot ' + kzColor;
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

// ── MOM ENGINE STATUS POLLING ──────────────────────────────────────────────────
async function updateEngineStatus() {
    const uiEngineLabel = document.getElementById('uiEngineLabel');
    const uiEngineDot   = document.getElementById('uiEngineDot');
    if (!uiEngineLabel || !uiEngineDot) return;

    try {
        const res = await auth.request('/trading/engine/status', { method: 'GET' });
        if (res.status === 'HALTED') {
            uiEngineLabel.textContent = 'MoM: Halted';
            uiEngineDot.className = 'dot pulse-yellow';
        } else {
            uiEngineLabel.textContent = 'MoM Engine';
            uiEngineDot.className = 'dot green';
        }
    } catch (err) {
        console.error('Failed to get engine status:', err);
        uiEngineLabel.textContent = 'MoM: Offline';
        uiEngineDot.className = 'dot red';
    }
}

updateEngineStatus();
setInterval(updateEngineStatus, 15000); // Check every 15s

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
            const statusColor = acc.status === 'ACTIVE' ? 'var(--primary)' : 
                              (acc.status === 'BLOWN' ? 'var(--error)' : 'var(--text-light)');
            
            const pnlColor = acc.current_pnl >= 0 ? 'var(--primary)' : 'var(--error)';
            const pnlFormatted = Number(acc.current_pnl).toLocaleString('en-US', {style: 'currency', currency: 'USD'});
            const targetFormatted = Number(acc.profit_target).toLocaleString('en-US', {style: 'currency', currency: 'USD', maximumFractionDigits: 0});

            const rowHtml = `
                <tr style="border-bottom: 1px solid rgba(255,255,255,0.05);">
                    <td style="padding: 10px 15px; color: var(--text-light); font-weight: 500;">
                        ${acc.account_name}
                        <div style="font-size: 0.75rem; color: var(--text-muted);">${acc.firm}</div>
                    </td>
                    <td style="padding: 10px 15px;">
                        <span style="color: ${acc.risk_profile === 'SAFE' ? 'var(--primary)' : 'var(--error)'}; font-size: 0.85rem;">${acc.risk_profile}</span>
                    </td>
                    <td style="padding: 10px 15px; color: var(--text-muted); font-size: 0.9rem;">
                        ${targetFormatted}
                    </td>
                    <td style="padding: 10px 15px; color: ${pnlColor}; font-family: monospace; font-size: 0.95rem;">
                        ${pnlFormatted}
                    </td>
                    <td style="padding: 10px 15px;">
                        <span style="color: ${statusColor}; font-weight: bold; font-size: 0.85rem;">${acc.status}</span>
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

        evalList.innerHTML = evalHtml || '<tr><td colspan="5" style="padding: 15px; text-align: center; color: var(--text-muted);">No evaluation accounts.</td></tr>';
        fundedList.innerHTML = fundedHtml || '<tr><td colspan="5" style="padding: 15px; text-align: center; color: var(--text-muted);">No funded accounts.</td></tr>';
    } catch (err) {
        console.error('Failed to load prop accounts:', err);
        const msg = err.status === 404 ? 'No accounts found.' : (err.message || 'Error loading accounts.');
        evalList.innerHTML = `<tr><td colspan="5" style="padding: 15px; text-align: center; color: var(--error);">${msg}</td></tr>`;
        fundedList.innerHTML = `<tr><td colspan="5" style="padding: 15px; text-align: center; color: var(--error);">${msg}</td></tr>`;
    }
}

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
                    firm: document.getElementById('propFirm').value,
                    phase: document.getElementById('propPhase').value,
                    risk_profile: localStorage.getItem('globalRiskProfile') || 'SAFE',
                    profit_target: Number(document.getElementById('propTarget').value)
                })
            });
            
            propForm.reset();
            await loadPropAccounts();
            if (propAccountModal) propAccountModal.style.display = 'none';
            
            // Temporary success state
            btn.textContent = 'Success!';
            btn.style.background = 'var(--primary)';
            btn.style.color = '#000';
            setTimeout(() => {
                btn.textContent = originalText;
                btn.style.background = '';
                btn.style.color = '';
            }, 2000);
            
        } catch (err) {
            alert('Failed to add account: ' + (err.message || 'Unknown error'));
            btn.textContent = originalText;
        } finally {
            btn.disabled = false;
        }
    });
}

