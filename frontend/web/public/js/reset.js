const resetEmail = sessionStorage.getItem('reset_email');
if (!resetEmail) window.location.href = '/';

// ── Eye Toggle (reuses same helper pattern as auth.js) ──
function setupEye(inputId, btnId, openId, closedId) {
    const input  = document.getElementById(inputId);
    const btn    = document.getElementById(btnId);
    const open   = document.getElementById(openId);
    const closed = document.getElementById(closedId);
    btn.addEventListener('click', () => {
        const show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        open.classList.toggle('hidden', show);
        closed.classList.toggle('hidden', !show);
    });
}
setupEye('newPassword',        'toggleNewPw',      'eyeNewOpen',      'eyeNewClosed');
setupEye('confirmNewPassword', 'toggleConfirmPw',  'eyeConfirmNOpen', 'eyeConfirmNClosed');

// ── Live confirm match feedback ──
const newPwInput  = document.getElementById('newPassword');
const confPwInput = document.getElementById('confirmNewPassword');
const matchText   = document.getElementById('resetMatchText');
const resetBtn    = document.getElementById('resetBtn');

function updateMatch() {
    if (!confPwInput.value) { matchText.textContent = ''; return; }
    const match = confPwInput.value === newPwInput.value;
    matchText.textContent = match ? '✓ Passwords match' : '✗ Passwords do not match';
    matchText.style.color = match ? '#34d399' : '#f87171';
}
newPwInput.addEventListener('input', updateMatch);
confPwInput.addEventListener('input', updateMatch);

// ── Reset Form Submit ──
document.getElementById('resetForm').addEventListener('submit', async (e) => {
    e.preventDefault();

    const otp         = document.getElementById('resetOtp').value.trim();
    const newPassword = newPwInput.value;
    const confirmPw   = confPwInput.value;

    if (newPassword !== confirmPw) {
        return auth.showError('alertBox', 'Passwords do not match.');
    }

    if (otp.length !== 6 || !/^\d{6}$/.test(otp)) {
        return auth.showError('alertBox', 'Please enter the 6-digit code from your email.');
    }

    resetBtn.disabled    = true;
    resetBtn.textContent = 'Updating...';

    try {
        await auth.request('/reset-password', {
            method: 'POST',
            body: JSON.stringify({ email: resetEmail, otp, newPassword })
        });

        sessionStorage.removeItem('reset_email');
        auth.showSuccess = undefined; // clear any state
        alert('✅ Password updated! Please sign in with your new password.');
        window.location.href = '/';
    } catch (err) {
        auth.showError('alertBox', err.message || 'Invalid or expired reset code.');
        resetBtn.disabled    = false;
        resetBtn.textContent = 'Change Password';
    }
});
