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
            const dd = document.getElementById('modelDropdown');
            if (dd) dd.classList.remove('disabled');
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
        novaInput.style.height = 'auto';
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

// --- Custom Dropdown Interactive Logic ---
const modelDropdown = document.getElementById('modelDropdown');
const dropdownTrigger = document.getElementById('dropdownTrigger');
const selectedModelText = document.getElementById('selectedModelText');
const dropdownItems = document.querySelectorAll('.dropdown-item');

// Dynamically inject the hidden input if it's missing to prevent crashes
let hiddenModelInput = document.getElementById('novaModelSelect');
if (!hiddenModelInput && modelDropdown) {
    hiddenModelInput = document.createElement('input');
    hiddenModelInput.type = 'hidden';
    hiddenModelInput.id = 'novaModelSelect';
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
        if (!modelDropdown.contains(e.target)) {
            modelDropdown.classList.remove('open');
        }
    });

    dropdownItems.forEach(item => {
        item.addEventListener('click', (e) => {
            e.stopPropagation(); // Prevent bubbling conflicts

            // Visual update
            dropdownItems.forEach(i => i.classList.remove('active'));
            item.classList.add('active');

            // Safe text update
            const titleEl = item.querySelector('.item-title');
            if (selectedModelText && titleEl) {
                selectedModelText.textContent = titleEl.textContent;
            }

            // Safe value update
            if (hiddenModelInput) {
                hiddenModelInput.value = item.getAttribute('data-value') || 'gemini-2.5-flash';
            }

            // Close menu
            modelDropdown.classList.remove('open');
        });
    });
}



// --- Navigation & View Switching ---
const navs = {
    home: document.getElementById('navHome'),
    nova: document.getElementById('navNova'),
    settings: document.getElementById('navSettings')
};
const views = {
    home: document.getElementById('homeView'),
    nova: document.getElementById('novaView'),
    settings: document.getElementById('profileView')
};

window.switchView = function(viewName) {
    Object.values(navs).forEach(nav => nav && nav.classList.remove('active'));
    Object.values(views).forEach(view => view && view.classList.add('hidden'));
    if (navs[viewName]) navs[viewName].classList.add('active');
    if (views[viewName]) views[viewName].classList.remove('hidden');
};

if (navs.home) navs.home.addEventListener('click', (e) => { e.preventDefault(); window.switchView('home'); });
if (navs.nova) navs.nova.addEventListener('click', (e) => { e.preventDefault(); window.switchView('nova'); });
if (navs.settings) navs.settings.addEventListener('click', (e) => { e.preventDefault(); window.switchView('settings'); });

// --- Change Password Logic ---
const changePwdForm = document.getElementById('changePasswordForm');
if (changePwdForm) {
    changePwdForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const cur = document.getElementById('currentPassword').value;
        const newVal = document.getElementById('newProfilePassword').value;
        const conf = document.getElementById('confirmNewProfilePassword').value;
        const btn = document.getElementById('changePwdBtn');
        const alertBox = document.getElementById('pwdAlertBox');

        alertBox.style.display = 'none';
        alertBox.className = 'alert';

        if (newVal !== conf) {
            alertBox.className = 'alert error';
            alertBox.textContent = 'New passwords do not match.';
            alertBox.style.display = 'block';
            return;
        }

        btn.disabled = true; btn.textContent = 'Updating...';
        try {
            await auth.request('/change-password', {
                method: 'POST',
                body: JSON.stringify({ currentPassword: cur, newPassword: newVal })
            });
            alertBox.className = 'alert success';
            alertBox.textContent = 'Password updated successfully.';
            alertBox.style.display = 'block';
            changePwdForm.reset();
        } catch (err) {
            alertBox.className = 'alert error';
            alertBox.textContent = err.message || 'Failed to update password.';
            alertBox.style.display = 'block';
        } finally {
            btn.disabled = false; btn.textContent = 'Update Password';
        }
    });
}


// --- Live Market Clock Logic ---
function updateMarketClock() {
    const uiSessionLabel   = document.getElementById('uiSessionLabel');
    const uiSessionDot     = document.getElementById('uiSessionDot');
    const uiKillzoneLabel  = document.getElementById('uiKillzoneLabel');
    const uiKillzoneDot    = document.getElementById('uiKillzoneDot');

    if (!uiSessionLabel || !uiSessionDot || !uiKillzoneLabel || !uiKillzoneDot) return;

    // Resolve current ET time
    const nowStr = new Date().toLocaleString("en-US", { timeZone: "America/New_York" });
    const now    = new Date(nowStr);

    const yyyy    = now.getFullYear();
    const mm      = String(now.getMonth() + 1).padStart(2, '0');
    const dd      = String(now.getDate()).padStart(2, '0');
    const dateStr = `${yyyy}-${mm}-${dd}`;

    const day          = now.getDay();           // 0=Sun � 6=Sat
    const h            = now.getHours();
    const min          = now.getMinutes();
    const totalMinutes = h * 60 + min;

    // -- 1. CME Holiday Calendar (2026-2027) ---------------------------
    const cmeHolidays = [
        "2026-01-01","2026-01-19","2026-02-16","2026-04-03",
        "2026-05-25","2026-06-19","2026-07-03","2026-09-07",
        "2026-11-26","2026-12-25",
        "2027-01-01","2027-01-18","2027-02-15","2027-03-26",
        "2027-05-31","2027-06-18","2027-07-05","2027-09-06",
        "2027-11-25","2027-12-24"
    ];
    if (cmeHolidays.includes(dateStr)) {
        uiSessionLabel.textContent  = "Closed: Holiday";
        uiSessionDot.className      = "dot red";
        uiKillzoneLabel.textContent = "Killzone: Inactive";
        uiKillzoneDot.className     = "dot gray";
        return;
    }

    // -- 2. Weekend Gate (Fri 17:00 ET ? Sun 18:00 ET) ----------------
    const isFriAfterClose = day === 5 && totalMinutes >= 1020;
    const isSat           = day === 6;
    const isSunBeforeOpen = day === 0 && totalMinutes < 1080;
    if (isFriAfterClose || isSat || isSunBeforeOpen) {
        uiSessionLabel.textContent  = "Closed: Weekend";
        uiSessionDot.className      = "dot red";
        uiKillzoneLabel.textContent = "Killzone: Inactive";
        uiKillzoneDot.className     = "dot gray";
        return;
    }

    // -- 3. CME Daily Maintenance (Mon-Thu 17:00�18:00 ET) ------------
    if (totalMinutes >= 1020 && totalMinutes < 1080) {
        uiSessionLabel.textContent  = "Closed: CME Maint";
        uiSessionDot.className      = "dot red";
        uiKillzoneLabel.textContent = "Killzone: Inactive";
        uiKillzoneDot.className     = "dot gray";
        return;
    }

    // -- 4. Classify Active Session & Killzone -------------------------
    let sessionText = "Session: Asia";
    let sessionColor = "green";
    let kzText  = "Killzone: Inactive";
    let kzColor = "gray";

    if (totalMinutes >= 120 && totalMinutes < 300) {
        // London session 02:00�05:00 ET
        sessionText  = "Session: London";
        sessionColor = "green";
        if (totalMinutes >= 135) {
            // London Killzone starts at 02:15
            kzText  = "Killzone: London";
            kzColor = "green";
        } else {
            kzText = "Killzone: Pre-London";
        }
    } else if (totalMinutes >= 570 && totalMinutes < 720) {
        // NY AM session 09:30�12:00 ET
        sessionText  = "Session: New York";
        sessionColor = "green";
        if (totalMinutes >= 585 && totalMinutes < 690) {
            // NY AM Killzone 09:45�11:30 ET
            kzText  = "Killzone: NY AM";
            kzColor = "green";
        } else {
            kzText = "Killzone: Outside";
        }
    } else if (totalMinutes >= 810 && totalMinutes < 960) {
        // NY PM session 13:30�16:00 ET
        sessionText  = "Session: New York";
        sessionColor = "green";
        if (totalMinutes >= 810 && totalMinutes < 945) {
            // NY PM Killzone 13:30�15:45 ET
            kzText  = "Killzone: NY PM";
            kzColor = "green";
        } else {
            kzText = "Killzone: Outside";
        }
    }

    // -- 5. Apply to DOM -----------------------------------------------
    uiSessionLabel.textContent  = sessionText;
    uiSessionDot.className      = "dot " + sessionColor;
    uiKillzoneLabel.textContent = kzText;
    uiKillzoneDot.className     = "dot " + kzColor;
}

// Boot immediately, then refresh every 10 seconds
updateMarketClock();
setInterval(updateMarketClock, 10000);

// --- N.O.V.A. Textarea Auto-Grow & Submit ---
const novaTextArea = document.getElementById('novaInput');
if (novaTextArea) {
    novaTextArea.addEventListener('input', function() {
        this.style.height = 'auto';
        this.style.height = (this.scrollHeight) + 'px';
    });
    novaTextArea.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            if (this.value.trim() !== '') {
                document.getElementById('novaForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
            }
        }
    });
}
