const passwordInput = document.getElementById('password');
const bars = [document.getElementById('bar-1'), document.getElementById('bar-2'), document.getElementById('bar-3'), document.getElementById('bar-4')];
const strengthText = document.getElementById('strengthText');
const submitBtn = document.getElementById('submitBtn');

passwordInput.addEventListener('input', (e) => {
    const val = e.target.value;
    let score = 0;
    if (val.length >= 8) score++;
    if (/[A-Z]/.test(val) && /[a-z]/.test(val)) score++;
    if (/[0-9]/.test(val)) score++;
    if (/[^A-Za-z0-9]/.test(val)) score++;
    const colors = ['#ff4c4c', '#ffa502', '#f1c40f', '#4cd137'];
    const labels = ['Weak', 'Fair', 'Good', 'Strong'];
    bars.forEach((bar, i) => { bar.style.background = i < score ? colors[score - 1] : 'rgba(255, 255, 255, 0.1)'; });
    strengthText.textContent = score > 0 ? labels[score - 1] : 'Waiting...';
    strengthText.style.color = score > 0 ? colors[score - 1] : 'var(--text-muted)';
    submitBtn.disabled = score < 4;
});

document.getElementById('signupForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    submitBtn.disabled = true;
    submitBtn.textContent = 'Creating...';
    const username = document.getElementById('username').value;
    const email = document.getElementById('email').value;
    const password = passwordInput.value;
    try {
        await auth.request('/signup', { method: 'POST', body: JSON.stringify({ username, email, password }) });
        localStorage.setItem('verify_email', email);
        window.location.href = '/verify.html';
    } catch (err) {
        auth.showError('alertBox', err.message);
        submitBtn.disabled = false;
        submitBtn.textContent = 'Sign Up';
    }
});
