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
                    ${user.username.charAt(0).toUpperCase()}
                </div>
                <label style="font-size: 0.8rem; color: var(--text-muted); text-transform: uppercase;">Username</label>
                <div style="font-size: 1.2rem; font-weight: bold; color: var(--primary);">${user.username}</div>
            </div>
            <hr style="border: none; border-top: 1px solid var(--glass-border); margin: 15px 0;">
            <div style="display: flex; justify-content: space-between;">
                <div>
                    <label style="font-size: 0.8rem; color: var(--text-muted); text-transform: uppercase;">Email</label>
                    <div style="font-size: 1rem;">${user.email}</div>
                </div>
                <div style="text-align: right;">
                    <label style="font-size: 0.8rem; color: var(--text-muted); text-transform: uppercase;">Member Since</label>
                    <div style="font-size: 0.9rem;">${dateStr}</div>
                </div>
            </div>
        `;
        const userRole = user.user?.role || user.role;
        if (userRole === 'admin') {
            const ms = document.getElementById('novaModelSelect');
            if (ms) ms.disabled = false;
        }
    } catch (err) {
        auth.clearToken();
        window.location.href = '/';
    }
}

document.getElementById('logoutBtn').addEventListener('click', async () => {
    try { await auth.request('/logout', { method: 'POST' }); } 
    catch (e) { console.warn('Server logout failed, clearing local state.'); } 
    finally { auth.clearToken(); window.location.href = '/'; }
});

loadProfile();

// ── N.O.V.A. TERMINAL LOGIC ──
const novaForm = document.getElementById('novaForm');
const novaInput = document.getElementById('novaInput');
const novaMessages = document.getElementById('novaMessages');
const novaSubmit = document.getElementById('novaSubmit');

function appendMessage(text, isUser = false) {
    const div = document.createElement('div');
    div.className = `nova-msg ${isUser ? 'user-msg' : 'ai-msg'}`;

    if (!isUser) {
        // Parse simple markdown-like bold/breaks for cleaner UI
        let formatted = text.replace(/\n/g, '<br>');
        formatted = formatted.replace(/\*\*(.*?)\*\*/g, '<b style="color:#fff">$1</b>');
        div.innerHTML = `<strong>N.O.V.A.</strong><br>${formatted}`;
    } else {
        div.textContent = text;
    }

    novaMessages.appendChild(div);
    novaMessages.scrollTop = novaMessages.scrollHeight;
    return div;
}

if (novaForm) {
    novaForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const text = novaInput.value.trim();
        if (!text) return;

        appendMessage(text, true);
        novaInput.value = '';
        novaInput.disabled = true;
        novaSubmit.disabled = true;

        const typingMsg = appendMessage('<span class="nova-typing">Processing...</span>', false);

        try {
            const res = await auth.request('/chat', {
                method: 'POST',
                body: JSON.stringify({ message: text, model: document.getElementById('novaModelSelect')?.value || 'gemini-2.5-flash' })
            });
            let formatted = res.reply.replace(/\n/g, '<br>');
            formatted = formatted.replace(/\*\*(.*?)\*\*/g, '<b style="color:#fff">$1</b>');
            typingMsg.innerHTML = `<strong>N.O.V.A.</strong><br>${formatted}`;
        } catch (err) {
            typingMsg.innerHTML = `<strong>N.O.V.A. ERROR</strong><span style="color:var(--error)">${err.message || 'Connection lost to core.'}</span>`;
        } finally {
            novaInput.disabled = false;
            novaSubmit.disabled = false;
            novaInput.focus();
        }
    });
}
