document.addEventListener('DOMContentLoaded', () => {
    const email = sessionStorage.getItem('reset_email');
    if (!email) {
        window.location.href = '/index.html'; // Protect the route
        return;
    }

    const otpForm = document.getElementById('otpForm');
    const passwordForm = document.getElementById('passwordForm');
    const alertBoxOtp = document.getElementById('alertBoxOtp');
    const alertBoxPwd = document.getElementById('alertBoxPwd');

    // Setup Eye Toggles
    document.querySelectorAll('.eye-toggle').forEach(btn => {
        btn.addEventListener('click', function() {
            const input = this.previousElementSibling;
            if (input.type === 'password') {
                input.type = 'text';
                this.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>';
            } else {
                input.type = 'password';
                this.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>';
            }
        });
    });

    // Pro-Level FLIP Animation
    function animatePanelTo(targetForm) {
        const glassPanel = document.querySelector('.glass-panel');
        const startHeight = glassPanel.offsetHeight;
        glassPanel.style.setProperty('height', startHeight + 'px', 'important');
        glassPanel.style.setProperty('transition', 'none', 'important');

        if(otpForm) otpForm.classList.add('hidden');
        if(passwordForm) passwordForm.classList.add('hidden');

        targetForm.classList.remove('hidden');

        glassPanel.style.setProperty('height', 'auto', 'important');
        const targetHeight = glassPanel.offsetHeight;

        glassPanel.style.setProperty('height', startHeight + 'px', 'important');
        void glassPanel.offsetHeight;

        glassPanel.style.setProperty('transition', 'all 0.6s cubic-bezier(0.16, 1, 0.3, 1)', 'important');
        glassPanel.style.setProperty('height', targetHeight + 'px', 'important');

        setTimeout(() => {
            glassPanel.style.removeProperty('height');
            glassPanel.style.removeProperty('transition');
        }, 600);
    }

    // STEP 1: Verify OTP
    if (otpForm) {
        otpForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const btn = document.getElementById('verifyOtpBtn');
            const otp = document.getElementById('resetOtp').value;

            btn.disabled = true;
            btn.textContent = 'Verifying...';
            alertBoxOtp.style.display = 'none';
            
            try {
                await auth.request('/verify-otp', {
                    method: 'POST',
                    body: JSON.stringify({ email, otp })
                });
                // OTP Validated! Slide to Step 2
                animatePanelTo(passwordForm);
            } catch (err) {
                auth.showError('alertBoxOtp', err.message || 'Invalid reset code.');
                btn.disabled = false;
                btn.textContent = 'Verify Code';
            }
        });
    }

    // STEP 2: Update Password
    if (passwordForm) {
        passwordForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const btn = document.getElementById('resetSubmitBtn');
            const otp = document.getElementById('resetOtp').value; // Keep the verified OTP
            const newPassword = document.getElementById('newPassword').value;
            const confirmNewPassword = document.getElementById('confirmNewPassword').value;

            if (newPassword !== confirmNewPassword) {
                auth.showError('alertBoxPwd', 'Passwords do not match.');
                return;
            }

            btn.disabled = true;
            btn.textContent = 'Updating...';
            alertBoxPwd.style.display = 'none';

            try {
                await auth.request('/reset-password', {
                    method: 'POST',
                    body: JSON.stringify({ email, otp, newPassword })
                });

                auth.showSuccess('alertBoxPwd', 'Password updated successfully!');
                sessionStorage.removeItem('reset_email');
                setTimeout(() => window.location.href = '/index.html', 2000);
            } catch (err) {
                auth.showError('alertBoxPwd', err.message || 'Error updating password.');
                btn.disabled = false;
                btn.textContent = 'Update Password';
            }
        });
    }
});
