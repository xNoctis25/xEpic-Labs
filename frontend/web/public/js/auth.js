if (auth.getToken()) window.location.href = '/dashboard.html';

// Tab Logic
const tabLogin = document.getElementById('tabLogin');
const tabSignup = document.getElementById('tabSignup');
const loginForm = document.getElementById('loginForm');
const signupForm = document.getElementById('signupForm');
const alertBox = document.getElementById('alertBox');

function switchTab(isLogin) {
    alertBox.style.display = 'none';
    if (isLogin) {
        tabLogin.classList.add('active');
        tabSignup.classList.remove('active');
        loginForm.classList.remove('hidden');
        signupForm.classList.add('hidden');
    } else {
        tabSignup.classList.add('active');
        tabLogin.classList.remove('active');
        signupForm.classList.remove('hidden');
        loginForm.classList.add('hidden');
    }
}
tabLogin.addEventListener('click', () => switchTab(true));
tabSignup.addEventListener('click', () => switchTab(false));

// Password Strength Logic (Signup)
const signupPassword = document.getElementById('signupPassword');
const bars = [document.getElementById('bar-1'), document.getElementById('bar-2'), document.getElementById('bar-3'), document.getElementById('bar-4')];
const strengthText = document.getElementById('strengthText');
const signupSubmitBtn = document.getElementById('signupSubmitBtn');

signupPassword.addEventListener('input', (e) => {
    const val = e.target.value;
    let score = 0;
    if (val.length >= 8) score++;
    if (/[A-Z]/.test(val) && /[a-z]/.test(val)) score++;
    if (/[0-9]/.test(val)) score++;
    if (/[^A-Za-z0-9]/.test(val)) score++;
    
    const colors = ['#ff4c4c', '#ffa502', '#f1c40f', '#4cd137'];
    const labels = ['Weak', 'Fair', 'Good', 'Strong'];
    
    bars.forEach((bar, i) => { bar.style.background = i < score ? colors[score - 1] : 'rgba(255, 255, 255, 0.07)'; });
    strengthText.textContent = val.length > 0 ? (score > 0 ? labels[score - 1] : '') : '';
    strengthText.style.color = score > 0 ? colors[score - 1] : 'var(--text-muted)';
    signupSubmitBtn.disabled = score < 4;
});

// Login Submit
loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('loginSubmitBtn');
    btn.disabled = true;
    btn.textContent = 'Authenticating...';
    const username = document.getElementById('loginUsername').value;
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
        btn.disabled = false;
        btn.textContent = 'Log In';
    }
});

// Signup Submit
signupForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    signupSubmitBtn.disabled = true;
    signupSubmitBtn.textContent = 'Creating...';
    const username = document.getElementById('signupUsername').value;
    const email = document.getElementById('signupEmail').value;
    const password = signupPassword.value;
    
    try {
        await auth.request('/signup', { method: 'POST', body: JSON.stringify({ username, email, password }) });
        sessionStorage.setItem('verify_email', email);
        window.location.href = '/verify.html';
    } catch (err) {
        auth.showError('alertBox', err.message);
        signupSubmitBtn.disabled = false;
        signupSubmitBtn.textContent = 'Create Account';
    }
});
