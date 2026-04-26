const inputs = document.querySelectorAll('.otp-grid input');
const verifyForm = document.getElementById('verifyForm');
const submitBtn = document.getElementById('submitBtn');
const resendBtn = document.getElementById('resendBtn');
const email = localStorage.getItem('verify_email');

if (!email) window.location.href = '/signup.html';
document.getElementById('emailDisplay').textContent = `OTP sent to ${email}`;

inputs.forEach((input, index) => {
    input.addEventListener('input', (e) => {
        if (e.target.value.length === 1 && index < inputs.length - 1) inputs[index + 1].focus();
        checkSubmit();
    });
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace' && !e.target.value && index > 0) inputs[index - 1].focus();
    });
    input.addEventListener('paste', (e) => {
        e.preventDefault();
        const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);
        [...pasted].forEach((char, i) => {
            if (inputs[i]) { inputs[i].value = char; if (i < 5) inputs[i + 1].focus(); }
        });
        checkSubmit();
    });
});

function checkSubmit() {
    const allFilled = Array.from(inputs).every(i => i.value.length === 1);
    submitBtn.disabled = !allFilled;
    if (allFilled) setTimeout(() => verifyForm.dispatchEvent(new Event('submit')), 80);
}

let timeLeft = 600;
const countdownEl = document.getElementById('countdown');
const timer = setInterval(() => {
    timeLeft--;
    const m = Math.floor(timeLeft / 60).toString().padStart(2, '0');
    const s = (timeLeft % 60).toString().padStart(2, '0');
    countdownEl.textContent = `${m}:${s}`;
    if (timeLeft <= 0) clearInterval(timer);
}, 1000);

verifyForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    submitBtn.disabled = true;
    submitBtn.textContent = 'Verifying...';
    const otp = Array.from(inputs).map(i => i.value).join('');
    try {
        const res = await auth.request('/verify-otp', { method: 'POST', body: JSON.stringify({ email, otp }) });
        auth.setToken(res.token);
        localStorage.removeItem('verify_email');
        window.location.href = '/dashboard.html';
    } catch (err) {
        auth.showError('alertBox', err.message);
        inputs.forEach(i => i.value = '');
        inputs[0].focus();
        submitBtn.disabled = true;
        submitBtn.textContent = 'Verify Account';
    }
});

resendBtn.addEventListener('click', async () => {
    resendBtn.disabled = true;
    try {
        await auth.request('/resend-otp', { method: 'POST', body: JSON.stringify({ email }) });
        auth.showSuccess('alertBox', 'OTP Resent! Check terminal.');
        let cd = 60;
        const cdTimer = setInterval(() => {
            cd--;
            resendBtn.textContent = `Wait ${cd}s`;
            if (cd <= 0) { clearInterval(cdTimer); resendBtn.textContent = 'Resend OTP'; resendBtn.disabled = false; }
        }, 1000);
    } catch (err) { auth.showError('alertBox', err.message); resendBtn.disabled = false; }
});
