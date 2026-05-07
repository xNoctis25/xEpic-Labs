const API_BASE = '/api/auth';
const auth = {
    setToken: (token, remember = false) => {
        if (remember) localStorage.setItem('jwt_token', token);
        else sessionStorage.setItem('jwt_token', token);
    },
    getToken: () => localStorage.getItem('jwt_token') || sessionStorage.getItem('jwt_token'),
    clearToken: () => { localStorage.removeItem('jwt_token'); sessionStorage.removeItem('jwt_token'); },
    request: async (endpoint, options = {}) => {
        const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
        const token = auth.getToken();
        if (token) headers['Authorization'] = `Bearer ${token}`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000); // 8s timeout
        try {
            const response = await fetch(`${API_BASE}${endpoint}`, { ...options, headers, signal: controller.signal });
            clearTimeout(timer);
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw { status: response.status, message: data.message || 'Something went wrong', ...data };
            return data;
        } catch (error) {
            clearTimeout(timer);
            if (error.name === 'AbortError') throw { status: 408, message: 'Request timed out. The server may be restarting — please refresh.' };
            throw error;
        }
    },
    showError: (elementId, message) => { const el = document.getElementById(elementId); if (el) { el.textContent = message; el.className = 'alert error'; } },
    showSuccess: (elementId, message) => { const el = document.getElementById(elementId); if (el) { el.textContent = message; el.className = 'alert success'; } }
};
