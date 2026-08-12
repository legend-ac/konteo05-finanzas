// js/app.js — Main orchestrator for Konteo 05

import { auth, db, firebase } from './firebase/config.js';
import { state, persistUiState }  from './state.js';
import {
    showPage, fmt, normalizeText, normalizeNote,
    todayString, sortTransactions, calculateProfileCompletion, toggleCustomRangePanel
} from './ui/helpers.js';
import { showToast }           from './ui/toast.js';
import { openModal, closeModal }  from './ui/modals.js';
import { renderTransactionList }  from './ui/render.js';
import { renderCharts }           from './ui/charts.js';
import { updateStrategyPanel, loadPlanConfigToUi, savePlanConfigFromUi } from './ui/insights.js';
import * as dbService             from './services/dbService.js';
import { exportToExcel, exportToPDF } from './services/exportService.js';
import { initGmailImport, clearGmailImportCache } from './ui/gmailImport.js';

// ──────────────────────────────────────────────
// THEME
// ──────────────────────────────────────────────
function initTheme() {
    const saved       = localStorage.getItem('konteo.theme');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const theme       = saved || (prefersDark ? 'dark' : 'light');
    applyTheme(theme);
}

function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    const btn = document.getElementById('theme-toggle-btn');
    if (btn) btn.textContent = theme === 'dark' ? '☀️' : '🌙';
}

function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    const next    = current === 'dark' ? 'light' : 'dark';
    localStorage.setItem('konteo.theme', next);
    applyTheme(next);
}

// ──────────────────────────────────────────────
// CONNECTIVITY
// ──────────────────────────────────────────────
window.addEventListener('online',  () => { state.isOnline = true; });
window.addEventListener('offline', () => { state.isOnline = false; });

// ──────────────────────────────────────────────
// PERIOD LABEL
// ──────────────────────────────────────────────
const PERIOD_LABELS = {
    today:  'Hoy',
    week:   'Últimos 7 días',
    month:  'Este mes',
    custom: 'Rango personalizado'
};

function updatePeriodLabel() {
    const el = document.getElementById('balance-period-label');
    if (el) el.textContent = PERIOD_LABELS[state.currentFilter] || 'Balance';
}

function updateGreeting(fullName) {
    const firstName = (fullName || '').split(' ')[0];
    const hour = new Date().getHours();
    const saludo = hour < 12 ? 'Buenos días' : hour < 19 ? 'Buenas tardes' : 'Buenas noches';
    const greeting = document.getElementById('dashboard-greeting');
    const title    = document.getElementById('dashboard-title');
    if (greeting) greeting.textContent = `${saludo}, ${firstName} 👋`;
    if (title)    title.textContent    = 'Lo que importa, primero.';
}

// ──────────────────────────────────────────────
// PROFILE
// ──────────────────────────────────────────────
async function loadUserProfile() {
    if (!state.currentUser) return;
    try {
        const data = await dbService.getUserProfile(state.currentUser.uid) || {};
        state.userProfile = {
            name:             data.name             || state.currentUser.displayName || '',
            phone:            data.phone            || '',
            birthday:         data.birthday         || '',
            city:             data.city             || '',
            country:          data.country          || '',
            occupation:       data.occupation       || '',
            currency:         data.currency         || 'PEN',
            monthlyTarget:    Number(data.monthlyTarget || 0),
            bio:              data.bio              || '',
            recoveryEmail:    data.recoveryEmail    || '',
            emergencyContact: data.emergencyContact || ''
        };
        if (state.userProfile.name) {
            document.getElementById('user-name').textContent = state.userProfile.name;
            updateGreeting(state.userProfile.name);
        }
        const map = {
            'profile-name':             state.userProfile.name,
            'profile-phone':            state.userProfile.phone,
            'profile-birthday':         state.userProfile.birthday,
            'profile-city':             state.userProfile.city,
            'profile-country':          state.userProfile.country,
            'profile-occupation':       state.userProfile.occupation,
            'profile-currency':         state.userProfile.currency,
            'profile-bio':              state.userProfile.bio,
            'profile-recovery-email':   state.userProfile.recoveryEmail,
            'profile-emergency-contact':state.userProfile.emergencyContact
        };
        for (const [id, val] of Object.entries(map)) {
            const el = document.getElementById(id);
            if (el) el.value = val;
        }
        const tgt = document.getElementById('profile-monthly-target');
        if (tgt) tgt.value = state.userProfile.monthlyTarget > 0 ? String(state.userProfile.monthlyTarget) : '';
        const pct = document.getElementById('profile-completion');
        if (pct) pct.textContent = `${calculateProfileCompletion(state.userProfile)}%`;
    } catch {
        showToast('No se pudo cargar el perfil', 'error');
    }
}

async function saveUserProfile() {
    if (!state.currentUser) return;
    const name = normalizeText(document.getElementById('profile-name')?.value || '', 60);
    if (!name) { showToast('El nombre es obligatorio', 'error'); return; }

    const profileData = {
        name,
        phone:            normalizeText(document.getElementById('profile-phone')?.value || '', 20),
        birthday:         document.getElementById('profile-birthday')?.value || '',
        city:             normalizeText(document.getElementById('profile-city')?.value || '', 50),
        country:          normalizeText(document.getElementById('profile-country')?.value || '', 50),
        occupation:       normalizeText(document.getElementById('profile-occupation')?.value || '', 60),
        currency:         document.getElementById('profile-currency')?.value || 'PEN',
        monthlyTarget:    Math.max(0, Number(document.getElementById('profile-monthly-target')?.value || 0)),
        bio:              normalizeText(document.getElementById('profile-bio')?.value || '', 240),
        recoveryEmail:    normalizeText(document.getElementById('profile-recovery-email')?.value || '', 120),
        emergencyContact: normalizeText(document.getElementById('profile-emergency-contact')?.value || '', 20)
    };

    await dbService.saveUserProfile(state.currentUser.uid, profileData);
    if (state.currentUser.displayName !== name) {
        await state.currentUser.updateProfile({ displayName: name });
    }
    state.userProfile = { ...state.userProfile, ...profileData };
    document.getElementById('user-name').textContent = name;
    const pct = document.getElementById('profile-completion');
    if (pct) pct.textContent = `${calculateProfileCompletion(state.userProfile)}%`;
    closeModal('modal-profile');
    showToast('Perfil actualizado', 'success');
}

// ──────────────────────────────────────────────
// LOAD DATA
// ──────────────────────────────────────────────
async function loadData() {
    if (!state.currentUser) return;

    const myToken = ++state.currentLoadToken;
    const now     = new Date();

    let startDate, endDate = null;

    if (state.currentFilter === 'today') {
        startDate = new Date();
        startDate.setHours(0, 0, 0, 0);
    } else if (state.currentFilter === 'week') {
        startDate = new Date();
        startDate.setDate(startDate.getDate() - 6);
        startDate.setHours(0, 0, 0, 0);
    } else if (state.currentFilter === 'custom') {
        if (!state.customRangeStart || !state.customRangeEnd) {
            showToast('Selecciona un rango de fechas', 'error');
            return;
        }
        startDate = new Date(`${state.customRangeStart}T00:00:00`);
        endDate   = new Date(`${state.customRangeEnd}T23:59:59`);
    } else {
        startDate = new Date(now.getFullYear(), now.getMonth(), 1);
    }

    const startTs = firebase.firestore.Timestamp.fromDate(startDate);

    try {
        const planPromise = dbService.getPlan(state.currentUser.uid).catch(() => null);
        const { incomeItems: rawIncome, expenseItems: rawExpense } =
            await dbService.getTransactions(state.currentUser.uid, startTs);

        if (myToken !== state.currentLoadToken) return;

        const withinPeriod = item => {
            const d = item.date?.toDate?.() || item.createdAt?.toDate?.() || new Date(0);
            if (d < startDate) return false;
            if (endDate && d > endDate) return false;
            return true;
        };

        const incomeItems  = rawIncome.filter(withinPeriod);
        const expenseItems = rawExpense.filter(withinPeriod);

        const totalIncome   = incomeItems .reduce((s, i) => s + (Number(i.amount) || 0), 0);
        const totalExpenses = expenseItems.reduce((s, i) => s + (Number(i.amount) || 0), 0);
        const balance       = totalIncome - totalExpenses;

        const balanceEl = document.getElementById('balance');
        if (balanceEl) {
            balanceEl.textContent = `S/ ${fmt(balance)}`;
            balanceEl.className   = `balance-number ${balance >= 0 ? 'balance-positive' : 'balance-negative'}`;
        }
        document.getElementById('total-income')  .textContent = `S/ ${fmt(totalIncome)}`;
        document.getElementById('total-expenses') .textContent = `S/ ${fmt(totalExpenses)}`;
        updatePeriodLabel();

        const allItems = sortTransactions([...incomeItems, ...expenseItems], state.currentSort);

        const searchTerm     = document.getElementById('search-input')?.value.toLowerCase() || '';
        const categoryFilter = document.getElementById('category-filter')?.value || 'all';

        const filtered = allItems.filter(item => {
            const matchSearch = !searchTerm ||
                (item.note || '').toLowerCase().includes(searchTerm) ||
                String(item.amount || '').includes(searchTerm);
            if (!matchSearch) return false;

            if (categoryFilter === 'all')    return true;
            if (categoryFilter === 'income') return item.type === 'income';
            return item.category === categoryFilter;
        });

        const countEl = document.getElementById('tx-count');
        if (countEl) {
            countEl.textContent = filtered.length
                ? `${filtered.length} movimiento${filtered.length !== 1 ? 's' : ''}`
                : '';
        }

        updateStrategyPanel({ totalExpenses });

        renderTransactionList(document.getElementById('list'), filtered);
        renderCharts(totalIncome, totalExpenses, expenseItems);

        const plan = await planPromise;
        if (myToken !== state.currentLoadToken) return;
        if (plan) {
            state.planConfig.incomeTarget  = Number(plan.incomeTarget  || 0);
            state.planConfig.expenseLimit  = Number(plan.expenseLimit  || 0);
            loadPlanConfigToUi();
            updateStrategyPanel({ totalExpenses });
        }

    } catch (err) {
        console.error('loadData error:', err);
        showToast('Error cargando datos: ' + err.message, 'error');
    }
}

// ──────────────────────────────────────────────
// TRANSACTION OPERATIONS
// ──────────────────────────────────────────────
async function deleteItem(id, type) {
    if (!confirm('¿Eliminar este registro?')) return;
    try {
        await dbService.deleteTransaction(state.currentUser.uid, type, id);
        showToast('Eliminado', 'success');
        loadData();
    } catch (err) {
        showToast('Error: ' + err.message, 'error');
    }
}

async function editItem(id, type) {
    try {
        const data = await dbService.getTransactionById(state.currentUser.uid, type, id);
        if (!data) { showToast('Registro no encontrado', 'error'); return; }

        const dateObj = data.date?.toDate?.() || data.createdAt?.toDate?.() || new Date();
        const dateStr = `${dateObj.getFullYear()}-${String(dateObj.getMonth()+1).padStart(2,'0')}-${String(dateObj.getDate()).padStart(2,'0')}`;

        if (type === 'income') {
            document.getElementById('income-amount').value = data.amount;
            document.getElementById('income-date').value   = dateStr;
            document.getElementById('income-note').value   = data.note || '';
            const src = document.getElementById('income-source');
            if (src) src.value = data.source || 'otros';
            document.getElementById('income-edit-id').value = id;
            openModal('modal-income');
        } else {
            document.getElementById('expense-amount').value = data.amount;
            document.getElementById('expense-date').value   = dateStr;
            document.getElementById('expense-note').value   = data.note || '';
            const mth = document.getElementById('expense-method');
            if (mth) mth.value = data.method || 'efectivo';
            const radio = document.querySelector(`input[name="category"][value="${data.category}"]`);
            if (radio) radio.checked = true;
            document.getElementById('expense-edit-id').value = id;
            openModal('modal-expense');
        }
    } catch (err) {
        showToast('Error: ' + err.message, 'error');
    }
}

// ──────────────────────────────────────────────
// AUTH STATE
// ──────────────────────────────────────────────
const todayStr = todayString();

async function ensureAuthenticatedUserDocument(user) {
    if (!user) return;
    try {
        const ref = db.collection('users').doc(user.uid);
        const existing = await ref.get();
        if (existing.exists) return;

        await ref.set({
            name: user.displayName || '',
            email: user.email || '',
            photoURL: user.photoURL || '',
            authProvider: user.providerData?.[0]?.providerId || 'password',
            currency: 'PEN',
            monthlyTarget: 0,
            bio: '',
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
    } catch (error) {
        // Authentication must still work when a first profile write is rejected.
        console.warn('No se pudo crear el perfil inicial:', error);
    }
}

auth.onAuthStateChanged(user => {
    if (user) {
        state.currentUser = user;
        ensureAuthenticatedUserDocument(user);
        showPage('dashboard');
        document.getElementById('user-name').textContent = user.displayName || '';

        const sortEl       = document.getElementById('sort-select');
        const rangeStartEl = document.getElementById('range-start');
        const rangeEndEl   = document.getElementById('range-end');
        if (sortEl)       sortEl.value       = state.currentSort;
        if (rangeStartEl) rangeStartEl.value = state.customRangeStart;
        if (rangeEndEl)   rangeEndEl.value   = state.customRangeEnd;

        document.querySelectorAll('.filter').forEach(btn => {
            const active = btn.dataset.filter === state.currentFilter;
            btn.classList.toggle('active', active);
            btn.setAttribute('aria-pressed', String(active));
        });

        toggleCustomRangePanel(state.currentFilter);
        updatePeriodLabel();
        loadPlanConfigToUi();
        loadUserProfile();

        const recoveryEl = document.getElementById('recovery-email');
        if (recoveryEl) recoveryEl.value = user.email || '';

        loadData();

        // Gmail auto-import feature
        initGmailImport(user.uid);

        // Refresh dashboard when gmail import completes
        window.addEventListener('konteo:refresh', () => loadData(), { once: false });
    } else {
        state.currentUser = null;
        showPage('home');
    }
});

// ──────────────────────────────────────────────
// AUTH FORMS
// ──────────────────────────────────────────────
document.getElementById('login-form').onsubmit = async e => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    const orig = btn?.textContent;
    if (btn) { btn.disabled = true; btn.textContent = 'Cargando...'; }
    try {
        await auth.signInWithEmailAndPassword(
            document.getElementById('email').value,
            document.getElementById('password').value
        );
    } catch (err) {
        showToast('Error: ' + err.message, 'error');
        if (btn) { btn.disabled = false; btn.textContent = orig; }
    }
};

document.getElementById('register-form').onsubmit = async e => {
    e.preventDefault();
    const name     = document.getElementById('reg-name').value.trim();
    const email    = document.getElementById('reg-email').value;
    const phone    = normalizeText(document.getElementById('reg-phone')?.value || '', 20);
    const birthday = document.getElementById('reg-birthday')?.value || '';
    const password = document.getElementById('reg-password').value;

    if (name.length < 2 || name.length > 50) {
        showToast('El nombre debe tener entre 2 y 50 caracteres', 'error');
        return;
    }

    const btn  = e.target.querySelector('button[type="submit"]');
    const orig = btn?.textContent;
    if (btn) { btn.disabled = true; btn.textContent = 'Creando cuenta...'; }

    try {
        const cred = await auth.createUserWithEmailAndPassword(email, password);
        const safeName = name.replace(/<[^>]*>/g, '');
        await cred.user.updateProfile({ displayName: safeName });
        await db.collection('users').doc(cred.user.uid).set({
            name: safeName, phone, birthday, currency: 'PEN', monthlyTarget: 0, bio: '',
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        showToast('Cuenta creada. Bienvenido a Konteo 05', 'success');
    } catch (err) {
        showToast('Error: ' + err.message, 'error');
        if (btn) { btn.disabled = false; btn.textContent = orig; }
    }
};

function authErrorMessage(error) {
    const code = error?.code || '';
    if (code === 'auth/popup-closed-by-user') return 'Se cerró la ventana de Google antes de terminar.';
    if (code === 'auth/popup-blocked') return 'El navegador bloqueó la ventana de Google. Permite las ventanas emergentes e inténtalo de nuevo.';
    if (code === 'auth/account-exists-with-different-credential') return 'Ya existe una cuenta con ese correo usando otro método de acceso.';
    if (code === 'auth/operation-not-allowed') return 'Google aún no está habilitado como proveedor de acceso en Firebase.';
    return `No se pudo iniciar con Google: ${error?.message || 'inténtalo de nuevo.'}`;
}

// Manejar resultado de redirección de Google Auth si existió
auth.getRedirectResult().then(async result => {
    if (result && result.user) {
        await ensureAuthenticatedUserDocument(result.user);
    }
}).catch(err => {
    if (err && err.code !== 'auth/credential-already-in-use') {
        console.warn('Error en redirect auth:', err);
    }
});

async function signInWithGoogle(button) {
    if (button?.disabled) return;
    const buttons = [...document.querySelectorAll('[data-google-auth]')];
    const originalText = button?.querySelector('span')?.textContent || 'Continuar con Google';

    const resetButton = () => {
        buttons.forEach(item => { item.disabled = false; });
        if (button?.querySelector('span')) button.querySelector('span').textContent = originalText;
    };

    buttons.forEach(item => { item.disabled = true; });
    if (button?.querySelector('span')) button.querySelector('span').textContent = 'Abriendo Google…';

    const clientId = window.__KONTEO_FIREBASE_CONFIG__?.gmailClientId || '320231487787-fm226uea8oumub95ol4ekbj90sdbk8if.apps.googleusercontent.com';

    // Intento 1: Usar Google Identity Services (GIS) ID Token si está disponible
    if (window.google?.accounts?.id) {
        try {
            window.google.accounts.id.initialize({
                client_id: clientId,
                callback: async (response) => {
                    if (!response?.credential) {
                        resetButton();
                        return;
                    }
                    try {
                        const credential = firebase.auth.GoogleAuthProvider.credential(response.credential);
                        const authResult = await auth.signInWithCredential(credential);
                        await ensureAuthenticatedUserDocument(authResult.user);
                        showToast('¡Bienvenido! Sesión iniciada con Google', 'success');
                    } catch (err) {
                        showToast(authErrorMessage(err), 'error');
                    } finally {
                        resetButton();
                    }
                }
            });
            // Solicitar selección de cuenta con One Tap / Popup
            window.google.accounts.id.prompt((notification) => {
                if (notification.isNotDisplayed() || notification.isSkippedMoment()) {
                    // Fallback a Token Client si One Tap no se muestra
                    if (window.google?.accounts?.oauth2) {
                        const client = window.google.accounts.oauth2.initTokenClient({
                            client_id: clientId,
                            scope: 'email profile openid',
                            callback: async (resp) => {
                                if (resp.error) { resetButton(); return; }
                                try {
                                    const credential = firebase.auth.GoogleAuthProvider.credential(null, resp.access_token);
                                    const authResult = await auth.signInWithCredential(credential);
                                    await ensureAuthenticatedUserDocument(authResult.user);
                                    showToast('¡Bienvenido! Sesión iniciada con Google', 'success');
                                } catch (err) {
                                    showToast(authErrorMessage(err), 'error');
                                } finally {
                                    resetButton();
                                }
                            }
                        });
                        client.requestAccessToken();
                    } else {
                        resetButton();
                    }
                }
            });
            return;
        } catch (gisErr) {
            console.warn('GIS ID Token falló:', gisErr);
        }
    }

    // Intento 2: Usar Popup directo con oauth-callback.html
    try {
        const redirectUri = encodeURIComponent(window.location.origin + '/oauth-callback.html');
        const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=token&scope=email%20profile%20openid&prompt=select_account`;
        
        const popup = window.open(authUrl, 'google_auth_popup', 'width=500,height=600');

        if (!popup) {
            const provider = new firebase.auth.GoogleAuthProvider();
            provider.setCustomParameters({ prompt: 'select_account' });
            await auth.signInWithRedirect(provider);
            return;
        }

        const handleMessage = async (event) => {
            if (event.origin !== window.location.origin) return;
            const { type, token, error } = event.data || {};
            if (type === 'konteo-gmail-oauth') {
                window.removeEventListener('message', handleMessage);
                if (token) {
                    try {
                        const credential = firebase.auth.GoogleAuthProvider.credential(null, token);
                        const authResult = await auth.signInWithCredential(credential);
                        await ensureAuthenticatedUserDocument(authResult.user);
                        showToast('¡Bienvenido! Sesión iniciada con Google', 'success');
                    } catch (err) {
                        showToast(authErrorMessage(err), 'error');
                    }
                } else if (error) {
                    showToast('Error en OAuth: ' + error, 'error');
                }
                resetButton();
            }
        };

        window.addEventListener('message', handleMessage);

    } catch (error) {
        showToast(authErrorMessage(error), 'error');
        resetButton();
    }
}

document.querySelectorAll('[data-google-auth]').forEach(button => {
    button.addEventListener('click', () => signInWithGoogle(button));
});

document.getElementById('logout-btn').onclick = async () => {
    if (confirm('¿Cerrar sesión?')) {
        try { await auth.signOut(); showToast('Sesión cerrada', 'success'); }
        catch (err) { showToast('Error: ' + err.message, 'error'); }
    }
};

document.getElementById('show-register')?.addEventListener('click', e => { e.preventDefault(); showPage('register'); });
document.getElementById('show-login')?.addEventListener('click',    e => { e.preventDefault(); showPage('login'); });
document.getElementById('home-start-register')?.addEventListener('click', () => showPage('register'));
document.getElementById('home-start-login')?.addEventListener('click',    () => showPage('login'));
document.getElementById('home-start-login-2')?.addEventListener('click',  () => showPage('login'));
document.getElementById('home-cta-register')?.addEventListener('click',   () => showPage('register'));
document.getElementById('back-home-from-login')?.addEventListener('click',    e => { e.preventDefault(); showPage('home'); });
document.getElementById('back-home-from-register')?.addEventListener('click', e => { e.preventDefault(); showPage('home'); });

// ──────────────────────────────────────────────
// PASSWORD RECOVERY
// ──────────────────────────────────────────────
document.getElementById('forgot-password-link')?.addEventListener('click', e => {
    e.preventDefault();
    const emailVal = document.getElementById('email')?.value?.trim() || '';
    const recEl    = document.getElementById('recovery-email');
    if (recEl) recEl.value = emailVal;
    openModal('modal-recovery');
});

document.getElementById('btn-open-recovery')?.addEventListener('click', () => {
    const recEl    = document.getElementById('recovery-email');
    const recAltEl = document.getElementById('recovery-alt-email');
    if (recEl)    recEl.value    = state.currentUser?.email || '';
    if (recAltEl) recAltEl.value = state.userProfile.recoveryEmail || '';
    closeModal('modal-profile');
    openModal('modal-recovery');
});

document.getElementById('form-recovery')?.addEventListener('submit', async e => {
    e.preventDefault();
    const email = (document.getElementById('recovery-email')?.value || '').trim();
    const alt   = (document.getElementById('recovery-alt-email')?.value || '').trim();
    if (!email) { showToast('Ingresa el correo de la cuenta', 'error'); return; }
    try {
        await auth.sendPasswordResetEmail(email);
        if (alt && state.currentUser) {
            db.collection('users').doc(state.currentUser.uid).set({
                recoveryEmail: alt,
                lastRecoveryRequestAt: firebase.firestore.FieldValue.serverTimestamp()
            }, { merge: true }).catch(() => {});
        }
        closeModal('modal-recovery');
        showToast('Enlace de recuperación enviado', 'success');
    } catch (err) {
        showToast('No se pudo enviar: ' + err.message, 'error');
    }
});

// ──────────────────────────────────────────────
// PROFILE MODAL
// ──────────────────────────────────────────────
document.getElementById('profile-btn')?.addEventListener('click', () => openModal('modal-profile'));
document.getElementById('form-profile')?.addEventListener('submit', async e => {
    e.preventDefault();
    try { await saveUserProfile(); }
    catch (err) { showToast('Error al guardar perfil: ' + err.message, 'error'); }
});

// ──────────────────────────────────────────────
// PERIOD FILTERS
// ──────────────────────────────────────────────
document.querySelectorAll('.filter').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.filter').forEach(b => {
            b.classList.remove('active');
            b.setAttribute('aria-pressed', 'false');
        });
        btn.classList.add('active');
        btn.setAttribute('aria-pressed', 'true');
        state.currentFilter = btn.dataset.filter;
        toggleCustomRangePanel(state.currentFilter);
        if (state.currentFilter === 'custom') {
            document.getElementById('range-start')?.focus();
        } else {
            loadData();
        }
    });
});

const incomeDateInput  = document.getElementById('income-date');
const expenseDateInput = document.getElementById('expense-date');
const rangeStartInput  = document.getElementById('range-start');
const rangeEndInput    = document.getElementById('range-end');

if (incomeDateInput)  incomeDateInput.setAttribute('max', todayStr);
if (expenseDateInput) expenseDateInput.setAttribute('max', todayStr);
if (rangeStartInput)  rangeStartInput.setAttribute('max', todayStr);
if (rangeEndInput)    rangeEndInput.setAttribute('max', todayStr);
if (rangeStartInput && state.customRangeStart) rangeStartInput.value = state.customRangeStart;
if (rangeEndInput   && state.customRangeEnd)   rangeEndInput.value   = state.customRangeEnd;

rangeStartInput?.addEventListener('change', e => { state.customRangeStart = e.target.value; persistUiState(); });
rangeEndInput?.addEventListener('change',   e => { state.customRangeEnd   = e.target.value; persistUiState(); });

document.getElementById('btn-apply-range')?.addEventListener('click', () => {
    const s = rangeStartInput?.value || '';
    const e = rangeEndInput?.value   || '';
    if (!s || !e) { showToast('Define fecha inicio y fin', 'error'); return; }
    if (s > e)    { showToast('La fecha inicio no puede ser mayor que la fin', 'error'); return; }
    state.customRangeStart = s;
    state.customRangeEnd   = e;
    state.currentFilter    = 'custom';
    persistUiState();
    document.querySelectorAll('.filter').forEach(b => {
        const active = b.dataset.filter === 'custom';
        b.classList.toggle('active', active);
        b.setAttribute('aria-pressed', String(active));
    });
    loadData();
});

document.getElementById('sort-select')?.addEventListener('change', e => {
    state.currentSort = e.target.value;
    persistUiState();
    loadData();
});

// ──────────────────────────────────────────────
// OPEN MODALS
// ──────────────────────────────────────────────
function openIncomeModal() {
    resetTransactionFormState(document.getElementById('form-income'));
    document.getElementById('income-date').value  = todayStr;
    document.getElementById('income-edit-id').value = '';
    const src = document.getElementById('income-source');
    if (src) src.value = 'salario';
    const note = document.getElementById('income-note');
    if (note) note.value = '';
    const amt = document.getElementById('income-amount');
    if (amt) amt.value = '';
    openModal('modal-income');
}

function openExpenseModal() {
    resetTransactionFormState(document.getElementById('form-expense'));
    document.getElementById('expense-date').value  = todayStr;
    document.getElementById('expense-edit-id').value = '';
    const mth = document.getElementById('expense-method');
    if (mth) mth.value = 'efectivo';
    const note = document.getElementById('expense-note');
    if (note) note.value = '';
    const amt = document.getElementById('expense-amount');
    if (amt) amt.value = '';
    document.querySelectorAll('input[name="category"]').forEach(r => { r.checked = false; });
    openModal('modal-expense');
}

document.addEventListener('click', e => {
    const incBtn = e.target.closest('#btn-income, #btn-income-d, .btn-open-income');
    if (incBtn) { e.preventDefault(); openIncomeModal(); return; }
    const expBtn = e.target.closest('#btn-expense, #btn-expense-d, .btn-open-expense');
    if (expBtn) { e.preventDefault(); openExpenseModal(); return; }
});

// ──────────────────────────────────────────────
// SAVE INCOME
// ──────────────────────────────────────────────
function createSubmissionKey() {
    return window.crypto?.randomUUID?.()
        || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function resetTransactionFormState(form) {
    if (!form) return;
    form.dataset.submissionKey = createSubmissionKey();
    setTransactionFormSaving(form, false);
}

function setTransactionFormSaving(form, isSaving) {
    if (!form) return;
    const modal = form.closest('.modal');
    form.classList.toggle('is-saving', isSaving);
    form.setAttribute('aria-busy', String(isSaving));
    form.querySelector('.transaction-saving-overlay')?.setAttribute('aria-hidden', String(!isSaving));
    if (modal) modal.dataset.saving = String(isSaving);

    Array.from(form.elements).forEach(control => { control.disabled = isSaving; });
}

function isTransactionFormSaving(form) {
    return form?.dataset.saving === 'true' || form?.classList.contains('is-saving');
}

document.getElementById('form-income').onsubmit = async e => {
    e.preventDefault();
    const form = e.currentTarget;
    if (isTransactionFormSaving(form)) return;
    let amount = parseFloat(document.getElementById('income-amount').value);
    if (isNaN(amount) || amount <= 0 || amount > 999_999_999) {
        showToast('Monto inválido', 'error'); return;
    }
    amount = Math.round(amount * 100) / 100;

    const dateStr = document.getElementById('income-date').value;
    const note    = normalizeNote(document.getElementById('income-note').value);
    const source  = document.getElementById('income-source')?.value || 'otros';
    const editId  = document.getElementById('income-edit-id').value;

    if (!dateStr) { showToast('Selecciona una fecha', 'error'); return; }
    const [y, m, d] = dateStr.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    if (isNaN(date.getTime())) { showToast('Fecha inválida', 'error'); return; }

    const todayEnd = new Date(); todayEnd.setHours(23, 59, 59, 999);
    if (date > todayEnd) { showToast('No puedes registrar fechas futuras', 'error'); return; }
    if (!state.isOnline)  { showToast('Sin conexión', 'error'); return; }

    setTransactionFormSaving(form, true);
    try {
        const data = { amount, date: firebase.firestore.Timestamp.fromDate(date), note, source };
        await dbService.saveIncome(state.currentUser.uid, data, editId || null, form.dataset.submissionKey || null);
        showToast(editId ? 'Ingreso actualizado' : 'Ingreso guardado', 'success');
        setTransactionFormSaving(form, false);
        closeModal('modal-income');
        form.reset();
        document.getElementById('income-edit-id').value = '';
        loadData();
    } catch (err) {
        showToast('Error: ' + err.message, 'error');
    } finally {
        setTransactionFormSaving(form, false);
    }
};

// ──────────────────────────────────────────────
// SAVE EXPENSE
// ──────────────────────────────────────────────
document.getElementById('form-expense').onsubmit = async e => {
    e.preventDefault();
    const form = e.currentTarget;
    if (isTransactionFormSaving(form)) return;
    let amount = parseFloat(document.getElementById('expense-amount').value);
    if (isNaN(amount) || amount <= 0 || amount > 999_999_999) {
        showToast('Monto inválido', 'error'); return;
    }
    amount = Math.round(amount * 100) / 100;

    const dateStr  = document.getElementById('expense-date').value;
    const category = document.querySelector('input[name="category"]:checked')?.value;
    const note     = normalizeNote(document.getElementById('expense-note').value);
    const method   = document.getElementById('expense-method')?.value || 'efectivo';
    const editId   = document.getElementById('expense-edit-id').value;

    if (!category) { showToast('Selecciona una categoría', 'error'); return; }
    if (!dateStr)  { showToast('Selecciona una fecha', 'error'); return; }
    const [y, m, d] = dateStr.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    if (isNaN(date.getTime())) { showToast('Fecha inválida', 'error'); return; }

    const todayEnd = new Date(); todayEnd.setHours(23, 59, 59, 999);
    if (date > todayEnd) { showToast('No puedes registrar fechas futuras', 'error'); return; }
    if (!state.isOnline)  { showToast('Sin conexión', 'error'); return; }

    setTransactionFormSaving(form, true);
    try {
        const data = { amount, date: firebase.firestore.Timestamp.fromDate(date), category, note, method };
        await dbService.saveExpense(state.currentUser.uid, data, editId || null, form.dataset.submissionKey || null);
        showToast(editId ? 'Gasto actualizado' : 'Gasto guardado', 'success');
        setTransactionFormSaving(form, false);
        closeModal('modal-expense');
        form.reset();
        document.getElementById('expense-edit-id').value = '';
        loadData();
    } catch (err) {
        showToast('Error: ' + err.message, 'error');
    } finally {
        setTransactionFormSaving(form, false);
    }
};

// ──────────────────────────────────────────────
// EVENT DELEGATION
// ──────────────────────────────────────────────
const listEl = document.getElementById('list');
if (listEl) {
    listEl.addEventListener('click', e => {
        const edit = e.target.closest('.edit-btn');
        const del  = e.target.closest('.delete-btn');
        if (edit) editItem(edit.dataset.id, edit.dataset.type);
        if (del)  deleteItem(del.dataset.id, del.dataset.type);
    });
}

document.addEventListener('click', e => {
    const cancelBtn = e.target.closest('.cancel[data-modal]');
    if (cancelBtn) closeModal(cancelBtn.dataset.modal);

    const qBtn = e.target.closest('.quick-amount');
    if (qBtn) {
        const wrap      = qBtn.closest('.quick-amounts');
        const targetId  = wrap?.dataset?.target;
        const targetIn  = targetId ? document.getElementById(targetId) : null;
        const add       = parseFloat(qBtn.dataset.amount || '0');
        if (targetIn && !isNaN(add)) {
            const cur = parseFloat(targetIn.value || '0');
            targetIn.value = (Math.round(((isNaN(cur) ? 0 : cur) + add) * 100) / 100).toFixed(2);
            targetIn.focus();
        }
    }
});

// ──────────────────────────────────────────────
// SEARCH & FILTERS
// ──────────────────────────────────────────────
let searchTimeout;
document.getElementById('search-input')?.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(loadData, 280);
});
document.getElementById('category-filter')?.addEventListener('change', loadData);

// ──────────────────────────────────────────────
// PLAN
// ──────────────────────────────────────────────
document.getElementById('btn-save-plan')?.addEventListener('click', async () => {
    if (await savePlanConfigFromUi()) loadData();
});
// Accordion toggles for plan and charts sections
['plan-toggle', 'charts-toggle'].forEach(id => {
    const row = document.getElementById(id);
    if (!row) return;
    const section = row.closest('.plan-section, .charts-section-wrap');
    if (!section) return;
    row.addEventListener('click', () => section.classList.toggle('open'));
});
// Open plan section by default
document.getElementById('plan-card')?.classList.add('open');

// ──────────────────────────────────────────────
// EXPORT — usa el período activo del dashboard
// ──────────────────────────────────────────────
function getExportContext() {
    return {
        filter:    state.currentFilter    || 'week',
        startDate: state.customRangeStart || '',
        endDate:   state.customRangeEnd   || '',
    };
}

// Export buttons — Header, Toolbar y sección inferior
['btn-export-excel', 'btn-export-excel-top', 'btn-export-excel-toolbar'].forEach(id => {
    document.getElementById(id)?.addEventListener('click', () => exportToExcel(getExportContext()));
});
['btn-export-pdf', 'btn-export-pdf-top', 'btn-export-pdf-toolbar'].forEach(id => {
    document.getElementById(id)?.addEventListener('click', () => exportToPDF(getExportContext()));
});

// ──────────────────────────────────────────────
// DELETE ALL USER DATA
// ──────────────────────────────────────────────
document.getElementById('btn-open-delete-data')?.addEventListener('click', () => {
    closeModal('modal-profile');
    const lbl = document.getElementById('delete-user-email-label');
    if (lbl) lbl.textContent = state.currentUser?.email || 'tu cuenta';
    const inp = document.getElementById('delete-confirm-input');
    if (inp) inp.value = '';
    const btn = document.getElementById('btn-confirm-delete-all');
    if (btn) btn.disabled = true;
    openModal('modal-confirm-delete');
});
document.getElementById('btn-cancel-delete')?.addEventListener('click', () => {
    closeModal('modal-confirm-delete');
});
document.getElementById('delete-confirm-input')?.addEventListener('input', e => {
    const val = (e.target.value || '').trim().toUpperCase();
    const btn = document.getElementById('btn-confirm-delete-all');
    if (btn) btn.disabled = val !== 'BORRAR';
});
document.getElementById('btn-confirm-delete-all')?.addEventListener('click', async () => {
    if (!state.currentUser) return;
    const submitBtn = document.getElementById('btn-confirm-delete-all');
    const origText = submitBtn.textContent;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Eliminando...';
    try {
        await dbService.deleteAllUserData(state.currentUser.uid);
        // Limpiar el caché local de IDs de Gmail para que el usuario pueda reimportar sin ver "sin movimientos nuevos"
        clearGmailImportCache();
        closeModal('modal-confirm-delete');
        showToast('✅ Todos los datos eliminados. Ya puedes reimportar tus movimientos desde Gmail.', 'success');
        await loadData();
    } catch (err) {
        showToast('Error al eliminar datos: ' + err.message, 'error');
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = origText;
    }
});

// ──────────────────────────────────────────────
// THEME
// ──────────────────────────────────────────────
document.getElementById('theme-toggle-btn')?.addEventListener('click', toggleTheme);

// ──────────────────────────────────────────────
// SERVICE WORKER
// ──────────────────────────────────────────────
if ('serviceWorker' in navigator) {
    const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);
    if (isLocal) {
        navigator.serviceWorker.getRegistrations()
            .then(regs => regs.forEach(r => r.unregister()))
            .catch(() => {});
    } else {
        const hadController = Boolean(navigator.serviceWorker.controller);
        let refreshingForUpdate = false;

        navigator.serviceWorker.addEventListener('controllerchange', () => {
            if (!hadController || refreshingForUpdate) return;
            refreshingForUpdate = true;
            window.location.reload();
        });

        window.addEventListener('load', () => {
            navigator.serviceWorker.register('/service-worker.js', { updateViaCache: 'none' })
                .then(reg => reg.update())
                .catch(() => {});
        });
    }
}

// ──────────────────────────────────────────────
// INIT
// ──────────────────────────────────────────────
initTheme();
