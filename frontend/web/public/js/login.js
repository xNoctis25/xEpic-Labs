if (auth.getToken()) window.location.href = '/dashboard.html';

document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('submitBtn');
    btn.disabled = true;
    btn.textContent = 'Authenticating...';
    const email = document.getElementById('email').value;
    const password = document.getElementById('password').value;
    try {
        const res = await auth.request('/login', { method: 'POST', body: JSON.stringify({ email, password }) });
        auth.setToken(res.token);
        window.location.href = '/dashboard.html';
    } catch (err) {
        if (err.requiresVerification || err.status === 403) {
            localStorage.setItem('verify_email', email);
            window.location.href = '/verify.html';
            return;
        }
        auth.showError('alertBox', err.message);
        btn.disabled = false;
        btn.textContent = 'Log In';
    }
});
