const profileData = document.getElementById('profileData');
if (!auth.getToken()) window.location.href = '/index.html';

async function loadProfile() {
    try {
        const user = await auth.request('/me', { method: 'GET' });
        const date = new Date(user.createdAt).toLocaleDateString();
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
                    <div style="font-size: 0.9rem;">${date}</div>
                </div>
            </div>
        `;
    } catch (err) {
        auth.clearToken();
        window.location.href = '/index.html';
    }
}

document.getElementById('logoutBtn').addEventListener('click', async () => {
    try { await auth.request('/logout', { method: 'POST' }); } 
    catch (e) { console.warn('Server logout failed, clearing local state.'); } 
    finally { auth.clearToken(); window.location.href = '/index.html'; }
});

loadProfile();
