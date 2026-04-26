if (auth.getToken()) window.location.href = '/dashboard.html';

// ── Tab Logic ──
const tabLogin    = document.getElementById('tabLogin');
const tabSignup   = document.getElementById('tabSignup');
const loginForm   = document.getElementById('loginForm');
const signupForm  = document.getElementById('signupForm');
const alertBox    = document.getElementById('alertBox');
const glassPanel  = document.querySelector('.glass-panel');

function switchTab(isLogin) {
    alertBox.style.display = 'none';
    if (isLogin) {
        tabLogin.classList.add('active');
        tabSignup.classList.remove('active');
        loginForm.classList.remove('hidden');
        signupForm.classList.add('hidden');
        if (glassPanel) glassPanel.classList.remove('wide');
    } else {
        tabSignup.classList.add('active');
        tabLogin.classList.remove('active');
        signupForm.classList.remove('hidden');
        loginForm.classList.add('hidden');
        if (glassPanel) glassPanel.classList.add('wide');
    }
}
tabLogin.addEventListener('click', () => switchTab(true));
tabSignup.addEventListener('click', () => switchTab(false));

// ── Eye Toggle Helper ──
function setupEyeToggle(inputId, toggleId, openIconId, closedIconId) {
    const input      = document.getElementById(inputId);
    const btn        = document.getElementById(toggleId);
    const openIcon   = document.getElementById(openIconId);
    const closedIcon = document.getElementById(closedIconId);
    btn.addEventListener('click', () => {
        const isHidden = input.type === 'password';
        input.type = isHidden ? 'text' : 'password';
        openIcon.classList.toggle('hidden', isHidden);
        closedIcon.classList.toggle('hidden', !isHidden);
    });
}
setupEyeToggle('loginPassword',        'toggleLoginPassword',   'eyeLoginOpen',   'eyeLoginClosed');
setupEyeToggle('signupPassword',       'toggleSignupPassword',  'eyeSignupOpen',  'eyeSignupClosed');
setupEyeToggle('signupConfirmPassword','toggleConfirmPassword',  'eyeConfirmOpen', 'eyeConfirmClosed');

// ── Password Strength Logic (Signup) ──
const signupPassword    = document.getElementById('signupPassword');
const confirmPassword   = document.getElementById('signupConfirmPassword');
const bars              = [document.getElementById('bar-1'), document.getElementById('bar-2'), document.getElementById('bar-3'), document.getElementById('bar-4')];
const strengthText      = document.getElementById('strengthText');
const matchText         = document.getElementById('matchText');
const signupSubmitBtn   = document.getElementById('signupSubmitBtn');

let passwordScore    = 0;
let usernameAvail    = true; // tracks real-time availability state
let emailAvail       = true;

function checkSubmitReady() {
    const passwordsMatch = confirmPassword.value === signupPassword.value && confirmPassword.value.length > 0;
    signupSubmitBtn.disabled = !(passwordScore >= 4 && passwordsMatch && usernameAvail && emailAvail);
}

// ── Real-Time Username / Email Availability ──
async function validateAvailability(field, element, displayName, setFlag) {
    if (!element.value.trim()) return;
    try {
        const res = await auth.request('/check-exists', {
            method: 'POST',
            body: JSON.stringify({ field, value: element.value.trim() })
        });
        if (res.exists) {
            element.style.borderColor = '#f87171';
            element.style.boxShadow   = '0 0 0 3px rgba(248,113,113,0.15)';
            auth.showError('alertBox', `${displayName} is already taken.`);
            setFlag(false);
        } else {
            element.style.borderColor = '#34d399';
            element.style.boxShadow   = '0 0 0 3px rgba(52,211,153,0.12)';
            alertBox.style.display    = 'none';
            setFlag(true);
        }
    } catch (err) {
        console.warn('Availability check failed:', err);
    }
    checkSubmitReady();
}

// Reset border when user starts re-typing
function resetFieldStyle(element) {
    element.style.borderColor = '';
    element.style.boxShadow   = '';
}

const signupUsernameEl = document.getElementById('signupUsername');
const signupEmailEl    = document.getElementById('signupEmail');

if (signupUsernameEl) {
    signupUsernameEl.addEventListener('input',  () => { resetFieldStyle(signupUsernameEl); usernameAvail = true; });
    signupUsernameEl.addEventListener('blur',   () => validateAvailability('username', signupUsernameEl, 'Username',     (v) => { usernameAvail = v; }));
}
if (signupEmailEl) {
    signupEmailEl.addEventListener('input',  () => { resetFieldStyle(signupEmailEl); emailAvail = true; });
    signupEmailEl.addEventListener('blur',   () => validateAvailability('email',    signupEmailEl,    'Email address', (v) => { emailAvail = v; }));
}

signupPassword.addEventListener('input', (e) => {
    const val = e.target.value;
    let score = 0;
    if (val.length >= 8)                          score++;
    if (/[A-Z]/.test(val) && /[a-z]/.test(val))  score++;
    if (/[0-9]/.test(val))                        score++;
    if (/[^A-Za-z0-9]/.test(val))                score++;

    passwordScore = score;
    const colors = ['#f87171', '#fbbf24', '#facc15', '#34d399'];
    const labels = ['Weak', 'Fair', 'Good', 'Strong'];

    bars.forEach((bar, i) => { bar.style.background = i < score ? colors[score - 1] : 'rgba(255,255,255,0.07)'; });
    strengthText.textContent  = val.length > 0 ? (score > 0 ? labels[score - 1] : '') : '';
    strengthText.style.color  = score > 0 ? colors[score - 1] : 'var(--text-muted)';

    // Re-run confirm validation if user already typed there
    if (confirmPassword.value.length > 0) updateMatchFeedback();
    checkSubmitReady();
});

function updateMatchFeedback() {
    if (confirmPassword.value.length === 0) { matchText.textContent = ''; return; }
    const match = confirmPassword.value === signupPassword.value;
    matchText.textContent = match ? '✓ Passwords match' : '✗ Passwords do not match';
    matchText.style.color = match ? '#34d399' : '#f87171';
}

confirmPassword.addEventListener('input', () => {
    updateMatchFeedback();
    checkSubmitReady();
});

// ── Sign In Submit ──
loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn      = document.getElementById('loginSubmitBtn');
    btn.disabled   = true;
    btn.textContent = 'Authenticating...';
    const username = document.getElementById('loginUsername').value.trim();
    const password = document.getElementById('loginPassword').value;
    const remember = document.getElementById('rememberMe').checked;

    try {
        const res = await auth.request('/login', { method: 'POST', body: JSON.stringify({ username, password }) });
        auth.setToken(res.token, remember);
        window.location.href = '/dashboard.html';
    } catch (err) {
        if (err.requiresVerification || err.status === 403) {
            sessionStorage.setItem('verify_username', username);
            window.location.href = '/verify.html';
            return;
        }
        auth.showError('alertBox', err.message);
        btn.disabled    = false;
        btn.textContent = 'Sign In';
    }
});

// ── Create Account Submit ──
signupForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    // Final client-side guard: passwords must match
    if (signupPassword.value !== confirmPassword.value) {
        auth.showError('alertBox', 'Passwords do not match.');
        return;
    }

    signupSubmitBtn.disabled    = true;
    signupSubmitBtn.textContent = 'Creating...';
    const username = document.getElementById('signupUsername').value.trim();
    const email    = document.getElementById('signupEmail').value.trim();
    const password = signupPassword.value;

    try {
        await auth.request('/signup', { method: 'POST', body: JSON.stringify({ username, email, password }) });
        sessionStorage.setItem('verify_email', email);
        window.location.href = '/verify.html';
    } catch (err) {
        auth.showError('alertBox', err.message);
        signupSubmitBtn.disabled    = false;
        signupSubmitBtn.textContent = 'Create Account';
    }
});

// ── Forgot Password Flow ──
const forgotLink = document.querySelector('.forgot-link');
if (forgotLink) {
    forgotLink.addEventListener('click', async (e) => {
        e.preventDefault();

        const email = prompt('Enter your registered email address to receive a reset code:');
        if (!email || !email.trim()) return;

        try {
            auth.showError('alertBox', 'Sending reset code...');
            await auth.request('/forgot-password', {
                method: 'POST',
                body: JSON.stringify({ email: email.trim() })
            });
            sessionStorage.setItem('reset_email', email.trim());
            window.location.href = '/reset.html';
        } catch (err) {
            auth.showError('alertBox', err.message || 'Error processing request.');
        }
    });
}
