/* ═══════════════════════════════════════════════════════════════
   Auth.js — Login / Register logic with LocalStorage
   ═══════════════════════════════════════════════════════════════ */

(function () {
    'use strict';

    // ── Check if already logged in ─────────────────────────────
    const token = localStorage.getItem('streamvibe_token');
    if (token) {
        verifyAndRedirect(token);
    }

    // ── DOM Elements ───────────────────────────────────────────
    const tabLogin = document.getElementById('tab-login');
    const tabRegister = document.getElementById('tab-register');
    const loginForm = document.getElementById('login-form');
    const registerForm = document.getElementById('register-form');
    const alertEl = document.getElementById('auth-alert');
    const successEl = document.getElementById('auth-success');

    // ── Tab Switching ──────────────────────────────────────────
    tabLogin.addEventListener('click', () => switchTab('login'));
    tabRegister.addEventListener('click', () => switchTab('register'));

    function switchTab(tab) {
        hideAlerts();
        if (tab === 'login') {
            tabLogin.classList.add('active');
            tabRegister.classList.remove('active');
            loginForm.style.display = 'flex';
            registerForm.style.display = 'none';
        } else {
            tabRegister.classList.add('active');
            tabLogin.classList.remove('active');
            registerForm.style.display = 'flex';
            loginForm.style.display = 'none';
        }
    }

    // ── Login ──────────────────────────────────────────────────
    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        hideAlerts();

        const username = document.getElementById('login-username').value.trim();
        const password = document.getElementById('login-password').value;
        const btn = document.getElementById('login-btn');

        if (!username || !password) {
            showError('Por favor completa todos los campos');
            return;
        }

        btn.disabled = true;
        btn.innerHTML = '<div class="spinner"></div> Entrando...';

        try {
            const res = await fetch('/api/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password }),
            });

            const data = await res.json();

            if (!res.ok) {
                showError(data.error || 'Error al iniciar sesión');
                return;
            }

            localStorage.setItem('streamvibe_token', data.token);
            localStorage.setItem('streamvibe_username', data.username);
            showSuccess('¡Bienvenido! Redirigiendo...');

            setTimeout(() => {
                window.location.href = '/admin.html';
            }, 800);
        } catch (err) {
            showError('Error de conexión. Intenta de nuevo.');
            console.error('Login error:', err);
        } finally {
            btn.disabled = false;
            btn.innerHTML = 'Entrar al Panel Admin';
        }
    });

    // ── Register ───────────────────────────────────────────────
    registerForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        hideAlerts();

        const username = document.getElementById('reg-username').value.trim();
        const password = document.getElementById('reg-password').value;
        const adminSecret = document.getElementById('reg-secret').value;
        const btn = document.getElementById('register-btn');

        if (!username || !password || !adminSecret) {
            showError('Por favor completa todos los campos');
            return;
        }

        btn.disabled = true;
        btn.innerHTML = '<div class="spinner"></div> Creando cuenta...';

        try {
            const res = await fetch('/api/register', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password, adminSecret }),
            });

            const data = await res.json();

            if (!res.ok) {
                showError(data.error || 'Error al registrarse');
                return;
            }

            localStorage.setItem('streamvibe_token', data.token);
            localStorage.setItem('streamvibe_username', data.username);
            showSuccess('¡Cuenta creada! Redirigiendo...');

            setTimeout(() => {
                window.location.href = '/admin.html';
            }, 800);
        } catch (err) {
            showError('Error de conexión. Intenta de nuevo.');
            console.error('Register error:', err);
        } finally {
            btn.disabled = false;
            btn.innerHTML = 'Crear Cuenta Admin';
        }
    });

    // ── Verify existing token ─────────────────────────────────
    async function verifyAndRedirect(token) {
        try {
            const res = await fetch('/api/verify', {
                headers: { 'Authorization': `Bearer ${token}` },
            });

            if (res.ok) {
                window.location.href = '/admin.html';
            } else {
                localStorage.removeItem('streamvibe_token');
                localStorage.removeItem('streamvibe_username');
            }
        } catch (err) {
            console.error('Token verification failed:', err);
        }
    }

    // ── Helpers ────────────────────────────────────────────────
    function showError(msg) {
        alertEl.textContent = msg;
        alertEl.style.display = 'block';
        successEl.style.display = 'none';
    }

    function showSuccess(msg) {
        successEl.textContent = msg;
        successEl.style.display = 'block';
        alertEl.style.display = 'none';
    }

    function hideAlerts() {
        alertEl.style.display = 'none';
        successEl.style.display = 'none';
    }
})();
