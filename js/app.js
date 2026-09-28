// js/app.js — Main orchestrator for Konteo 05

import { auth, db, firebase } from './firebase/config.js';
import { state, persistUiState }  from './state.js';
import {
    showPage, fmt, normalizeText, normalizeNote,
    todayString, sortTransactions, calculateProfileCompletion, toggleCustomRangePanel,
    startOfBusinessDate, endOfBusinessDate, businessDateToDate, businessDateString, transactionBusinessDate,
    formatBusinessDate, formatBusinessDateTime, BUSINESS_TIME_ZONE
} from './ui/helpers.js';
import { showToast }           from './ui/toast.js';
import { openModal, closeModal }  from './ui/modals.js';
import { renderTransactionList }  from './ui/render.js';
import { accountGuide, initContextGuides, updateContextGuide } from './ui/guides.js';
import { renderCharts }           from './ui/charts.js';
import { updateStrategyPanel, loadPlanConfigToUi, savePlanConfigFromUi } from './ui/insights.js';
import { renderExpenseAnalysis } from './ui/dailySpending.js';
import { movementIdentity, sourceIdentity } from './services/entityIdentity.js';
import * as dbService             from './services/dbService.js';
import { isActiveWallet, walletNeedsReview, walletSuggestions, resolveWalletAccount } from './services/walletPolicy.js';
import { isPosted, sumAmounts, summarizeCashflow } from './services/financialMath.js';
import { exportToExcel, exportToPDF } from './services/exportService.js';
import { openGmailImport, openGmailEntities, clearGmailImportCache } from './ui/gmailImport.js';
import { revokeGmailToken } from './services/gmailService.js';

const LEGAL_VERSION = '2026.09';

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
    if (btn) {
        btn.title = theme === 'dark' ? 'Activar tema claro' : 'Activar tema oscuro';
        btn.setAttribute('aria-label', btn.title);
        btn.setAttribute('aria-pressed', String(theme === 'dark'));
    }
}

let chartSnapshot = null;
// Avoid repeating the same Firestore reads when a person changes a control,
// returns to the dashboard, or two UI events request the same period together.
const dashboardReadCache = new Map();
const DASHBOARD_CACHE_TTL_MS = 45_000;

function dashboardCacheKey(uid, startDate, endDate) {
    return `${uid}:${startDate.toISOString()}:${endDate.toISOString()}`;
}

function pruneDashboardCache() {
    if (dashboardReadCache.size <= 8) return;
    const oldest = [...dashboardReadCache.entries()]
        .sort(([, a], [, b]) => a.loadedAt - b.loadedAt)
        .slice(0, dashboardReadCache.size - 8);
    oldest.forEach(([key]) => dashboardReadCache.delete(key));
}
function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    const next    = current === 'dark' ? 'light' : 'dark';
    localStorage.setItem('konteo.theme', next);
    applyTheme(next);
    // Chart.js resolves colors on render, so redraw the current dashboard after
    // a theme change instead of leaving stale canvas colors behind.
    if (chartSnapshot) renderCharts(chartSnapshot);
}

// Motion is deliberately restrained: it confirms interaction instead of
// competing with financial information. Cursor-only effects are never bound
// on touch devices, and the operating system's reduced-motion preference wins.
function interfaceMotionAllowed() {
    return !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

function replayInterfaceMotion(element) {
    if (!element || !interfaceMotionAllowed()) return;
    element.classList.remove('motion-enter');
    window.requestAnimationFrame(() => element.classList.add('motion-enter'));
}

function initInterfaceMotion() {
    if (!interfaceMotionAllowed()) return;
    document.documentElement.classList.add('motion-ready');

    const homePage = document.getElementById('home-page');
    if (homePage) window.requestAnimationFrame(() => homePage.classList.add('motion-revealed'));

}

// Firebase restores a saved session after the document first paints. Keep the
// workspace separately for each signed-in user so a reload never resets the
// person to Inicio. This stores only a view name and scroll position locally.
const WORKSPACE_STORAGE_PREFIX = 'konteo.workspace.';
const WORKSPACE_VIEWS = new Set(['home', 'wallets', 'expenses']);
let workspaceScrollTimer = null;
let workspaceRestoreInProgress = false;

function workspaceStorageKey(uid) {
    return `${WORKSPACE_STORAGE_PREFIX}${uid}`;
}

function currentWorkspaceView() {
    if (!document.getElementById('expenses-view')?.classList.contains('hidden')) return 'expenses';
    if (!document.getElementById('wallets-view')?.classList.contains('hidden')) return 'wallets';
    return 'home';
}

function currentScrollPosition() {
    return Math.max(0, Math.round(window.scrollY || document.documentElement.scrollTop || 0));
}

function readWorkspaceState(uid) {
    if (!uid) return null;
    try {
        const saved = JSON.parse(localStorage.getItem(workspaceStorageKey(uid)) || 'null');
        if (!saved || !WORKSPACE_VIEWS.has(saved.view)) return null;
        return {
            view: saved.view,
            scrollY: Number.isFinite(Number(saved.scrollY)) ? Math.max(0, Number(saved.scrollY)) : 0
        };
    } catch {
        return null;
    }
}

function persistWorkspaceState({ view = state.workspaceView || currentWorkspaceView(), scrollY = currentScrollPosition() } = {}) {
    const uid = state.currentUser?.uid;
    if (!uid || !WORKSPACE_VIEWS.has(view)) return;
    try {
        localStorage.setItem(workspaceStorageKey(uid), JSON.stringify({
            view,
            scrollY: Math.max(0, Math.round(Number(scrollY) || 0)),
            savedAt: Date.now()
        }));
    } catch {
        // Storage can be disabled by the browser. Navigation must continue.
    }
}

function queueWorkspaceScrollPersistence() {
    if (!state.currentUser || workspaceRestoreInProgress) return;
    window.clearTimeout(workspaceScrollTimer);
    workspaceScrollTimer = window.setTimeout(() => persistWorkspaceState(), 140);
}

function restoreWorkspaceScroll(scrollY) {
    const target = Math.max(0, Number(scrollY) || 0);
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
        window.scrollTo({ top: target, behavior: 'auto' });
        workspaceRestoreInProgress = false;
        persistWorkspaceState({ scrollY: target });
    }));
}

if ('scrollRestoration' in window.history) window.history.scrollRestoration = 'manual';
window.addEventListener('scroll', queueWorkspaceScrollPersistence, { passive: true });
window.addEventListener('pagehide', () => {
    window.clearTimeout(workspaceScrollTimer);
    persistWorkspaceState();
});

// ──────────────────────────────────────────────
// CONNECTIVITY
// ──────────────────────────────────────────────
window.addEventListener('online',  () => { state.isOnline = true; });
window.addEventListener('offline', () => { state.isOnline = false; });

// ──────────────────────────────────────────────
// PERIOD LABEL
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const PERIOD_LABELS = {
    today:  'Hoy',
    week:   '\u00daltimos 7 d\u00edas',
    month:  'Este mes',
    custom: 'Rango personalizado'
};

function updatePeriodLabel() {
    const el = document.getElementById('balance-period-label');
    if (!el) return;
    const isToday = state.currentFilter === 'today';
    el.textContent = PERIOD_LABELS[state.currentFilter] || 'Balance';
    el.classList.toggle('period-label-today', isToday);
}

function updateDashboardTime() {
    const el = document.getElementById('dashboard-time');
    if (!el) return;
    const time = new Intl.DateTimeFormat('es-PE', {
        hour: '2-digit', minute: '2-digit', hour12: true, timeZone: BUSINESS_TIME_ZONE
    }).format(new Date());
    el.textContent = ` · ${time}`;
}

function updateDashboardMetrics({ totalIncome, totalExpenses, expenseItems, startDate, endDate }) {
    // A metric with no data is visual noise. Keep the compact strip for
    // periods that actually have information to compare.
    document.getElementById('dashboard-page')?.classList.toggle(
        'has-financial-data', totalIncome > 0 || totalExpenses > 0
    );
    const setMetric = (id, value) => {
        const el = document.getElementById(id);
        if (el) el.textContent = value;
    };
    const elapsedDays = Math.max(1, Math.floor((endDate.getTime() - startDate.getTime()) / 86400000) + 1);
    const savingsRate = totalIncome > 0 ? Math.round(((totalIncome - totalExpenses) / totalIncome) * 100) : null;
    const categoryTotals = { green: 0, yellow: 0, red: 0 };
    expenseItems.forEach(item => {
        if (Object.hasOwn(categoryTotals, item.category)) categoryTotals[item.category] += Number(item.amount) || 0;
    });
    const top = Object.entries(categoryTotals).sort(([, a], [, b]) => b - a)[0];
    const categoryLabels = { green: 'Fijo', yellow: 'Necesario', red: 'Antojo' };

    setMetric('metric-savings', savingsRate === null ? '—' : `${savingsRate}%`);
    setMetric('metric-daily-spend', totalExpenses > 0 ? `S/ ${fmt(totalExpenses / elapsedDays)}` : '—');
    setMetric('metric-top-category', top?.[1] > 0 ? categoryLabels[top[0]] : '—');
}

function dailyEntityIdFor(item) {
    return movementIdentity(item, state.wallets, state.walletEntities).id;
}

function analyticsEntities() {
    const sourceItems = [
        ...(state.expenseData?.expenseItems || []),
        ...(state.expenseData?.incomeItems || [])
    ];
    const identities = new Map();
    sourceItems.forEach(item => {
        const identity = movementIdentity(item, state.wallets, state.walletEntities);
        identities.set(identity.id, identity);
    });
    return [...identities.values()];
}

function renderExpenseAnalysisView() {
    renderExpenseAnalysis({
        wallets: analyticsEntities(),
        expenses: state.expenseData?.expenseItems || [],
        incomes: state.expenseData?.incomeItems || [],
        selectedEntityIds: state.expenseEntityIds,
        resolveEntityId: dailyEntityIdFor,
        resolveIdentity: item => movementIdentity(item, state.wallets, state.walletEntities),
        movementType: state.expenseMovementType
    });
}

function expensePeriodDates() {
    const today = todayString();
    if (state.expenseFilter === 'today') return [startOfBusinessDate(today), endOfBusinessDate(today)];
    if (state.expenseFilter === 'week') {
        const start = new Date(startOfBusinessDate(today));
        start.setUTCDate(start.getUTCDate() - 6);
        return [start, endOfBusinessDate(today)];
    }
    if (state.expenseFilter === 'custom') {
        if (!state.expenseRangeStart || !state.expenseRangeEnd) return [null, null];
        return [startOfBusinessDate(state.expenseRangeStart), endOfBusinessDate(state.expenseRangeEnd)];
    }
    return [startOfBusinessDate(`${today.slice(0, 7)}-01`), endOfBusinessDate(today)];
}

function syncExpensePeriodUi() {
    document.querySelectorAll('.expense-period').forEach(button => {
        const active = button.dataset.expenseFilter === state.expenseFilter;
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', String(active));
    });
    document.getElementById('expenses-range-panel')?.classList.toggle('hidden', state.expenseFilter !== 'custom');
}

function syncExpenseMovementTypeUi() {
    const isIncome = state.expenseMovementType === 'income';
    document.querySelectorAll('.expense-type').forEach(button => {
        const active = button.dataset.expenseType === state.expenseMovementType;
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', String(active));
    });
    const label = isIncome ? 'Ingreso' : 'Gasto';
    document.querySelector('.expenses-summary-card')?.classList.toggle('is-income', isIncome);
    document.getElementById('expenses-summary-label').textContent = `${label} seleccionado`;
    document.getElementById('expenses-detail-title').textContent = `${isIncome ? 'Ingresos' : 'Gastos'} por fecha`;
    document.getElementById('expenses-entities-copy').textContent = 'Elige un banco o billetera, revisa sus totales diarios y abre un día para ver los movimientos. Comparar suma solo las entidades que marques.';
    document.getElementById('expenses-summary-rule').textContent = isIncome
        ? 'Transferencias, pendientes, anulados y operaciones entre tus propias cuentas no se incluyen.'
        : 'Transferencias, pendientes, anulados y operaciones entre tus propias cuentas no se incluyen.';
}

let expenseLoadToken = 0;
async function loadExpenseAnalysis({ force = false } = {}) {
    if (!state.currentUser) return;
    const uid = state.currentUser.uid;
    const token = ++expenseLoadToken;
    if (force) state.expenseData = null;
    const [startDate, endDate] = expensePeriodDates();
    if (!startDate || !endDate) return;
    const startTs = firebase.firestore.Timestamp.fromDate(startDate);
    const endTs = firebase.firestore.Timestamp.fromDate(endDate);
    const periodStart = businessDateString(startDate);
    const periodEnd = businessDateString(endDate);
    try {
        const { incomeItems, expenseItems } = await dbService.getTransactions(uid, startTs, endTs);
        if (state.currentUser?.uid !== uid || token !== expenseLoadToken) return;
        const scoped = items => items.filter(item => {
            const date = transactionBusinessDate(item);
            return !!date && date >= periodStart && date <= periodEnd;
        });
        state.expenseData = { expenseItems: scoped(expenseItems), incomeItems: scoped(incomeItems) };
        renderExpenseAnalysisView();
    } catch (error) {
        if (state.currentUser?.uid !== uid || token !== expenseLoadToken) return;
        console.error('expense analysis error:', error);
        showToast('No se pudo cargar el detalle de gastos', 'error');
    }
}

function renderTransactionLedger(incomeItems, expenseItems) {
    const allItems = sortTransactions([...incomeItems, ...expenseItems], state.currentSort);
    const searchTerm = document.getElementById('search-input')?.value.toLowerCase() || '';
    const categoryFilter = document.getElementById('category-filter')?.value || 'all';
    const statusFilter = document.getElementById('status-filter')?.value || 'all';
    const filtered = allItems.filter(item => {
        const matchSearch = !searchTerm ||
            (item.note || '').toLowerCase().includes(searchTerm) ||
            (item.counterparty || '').toLowerCase().includes(searchTerm) ||
            (item.reference || '').toLowerCase().includes(searchTerm) ||
            (item.actorEmail || '').toLowerCase().includes(searchTerm) ||
            (item.status || 'completed').toLowerCase().includes(searchTerm) ||
            String(item.amount || '').includes(searchTerm);
        if (!matchSearch) return false;

        const matchesCategory = categoryFilter === 'all' ||
            (categoryFilter === 'income' ? item.type === 'income' : item.category === categoryFilter);
        return matchesCategory && (statusFilter === 'all' || (item.status || 'completed') === statusFilter);
    });

    const countEl = document.getElementById('tx-count');
    if (countEl) {
        countEl.textContent = filtered.length
            ? `${filtered.length} movimiento${filtered.length !== 1 ? 's' : ''}`
            : '';
    }
    renderTransactionList(document.getElementById('list'), filtered, {
        hasFilters: Boolean(searchTerm || categoryFilter !== 'all' || statusFilter !== 'all')
    });
}

function renderTransactionLedgerFromCache() {
    if (!state.dashboardData) {
        loadData();
        return;
    }
    renderTransactionLedger(state.dashboardData.incomeItems, state.dashboardData.expenseItems);
}

function updateGreeting(fullName) {
    const firstName = (fullName || '').split(' ')[0];
    const hour = new Date().getHours();
    const saludo = hour < 12 ? 'Buenos días' : hour < 19 ? 'Buenas tardes' : 'Buenas noches';
    const greeting = document.getElementById('dashboard-greeting');
    const title    = document.getElementById('dashboard-title');
    if (greeting) greeting.textContent = `${saludo}, ${firstName} 👋`;
    if (title)    title.textContent    = 'Resumen financiero';
}

// ──────────────────────────────────────────────
updateDashboardTime();
window.setInterval(updateDashboardTime, 60_000);

// PROFILE
// ──────────────────────────────────────────────
async function loadUserProfile(profile = null) {
    if (!state.currentUser) return;
    try {
        const data = profile || await dbService.getUserProfile(state.currentUser.uid) || {};
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
async function loadData({ force = false } = {}) {
    if (!state.currentUser) return;

    const myToken = ++state.currentLoadToken;
    let startDate, endDate = null;
    const today = todayString();

    if (state.currentFilter === 'today') {
        startDate = startOfBusinessDate(today);
        endDate = endOfBusinessDate(today);
    } else if (state.currentFilter === 'week') {
        const weekStart = new Date(startOfBusinessDate(today));
        weekStart.setUTCDate(weekStart.getUTCDate() - 6);
        startDate = weekStart;
        endDate = endOfBusinessDate(today);
    } else if (state.currentFilter === 'custom') {
        if (!state.customRangeStart || !state.customRangeEnd) {
            showToast('Selecciona un rango de fechas', 'error');
            return;
        }
        startDate = startOfBusinessDate(state.customRangeStart);
        endDate   = endOfBusinessDate(state.customRangeEnd);
    } else {
        startDate = startOfBusinessDate(`${today.slice(0, 7)}-01`);
        endDate = endOfBusinessDate(today);
    }

    const startTs = firebase.firestore.Timestamp.fromDate(startDate);
    const endTs = firebase.firestore.Timestamp.fromDate(endDate);

    try {
        const cacheKey = dashboardCacheKey(state.currentUser.uid, startDate, endDate);
        const cached = dashboardReadCache.get(cacheKey);
        const cacheIsFresh = cached?.value && Date.now() - cached.loadedAt < DASHBOARD_CACHE_TTL_MS;
        let result;
        if (!force && cacheIsFresh) {
            result = cached.value;
        } else if (!force && cached?.pending) {
            result = await cached.pending;
        } else {
            const pending = Promise.all([
                dbService.getTransactions(state.currentUser.uid, startTs, endTs),
                dbService.getPlan(state.currentUser.uid).catch(() => null)
            ]);
            dashboardReadCache.set(cacheKey, { pending, loadedAt: Date.now() });
            try {
                result = await pending;
                if (dashboardReadCache.get(cacheKey)?.pending === pending) {
                    dashboardReadCache.set(cacheKey, { value: result, loadedAt: Date.now() });
                }
                pruneDashboardCache();
            } catch (error) {
                if (dashboardReadCache.get(cacheKey)?.pending === pending) dashboardReadCache.delete(cacheKey);
                throw error;
            }
        }
        const [{ incomeItems: rawIncome, expenseItems: rawExpense }, plan] = result;

        if (myToken !== state.currentLoadToken) return;

        const periodStart = businessDateString(startDate);
        const periodEnd = businessDateString(endDate);
        const withinPeriod = item => {
            const date = transactionBusinessDate(item);
            return !!date && date >= periodStart && (!periodEnd || date <= periodEnd);
        };

        const incomeItems  = rawIncome.filter(withinPeriod);
        const expenseItems = rawExpense.filter(withinPeriod);
        state.dashboardData = { incomeItems, expenseItems };

        // Transfers only redistribute money between wallets. They must never
        // make the global dashboard claim there was an income or an expense.
        const { realIncomeItems, realExpenseItems, totalIncome, totalExpenses, balance } = summarizeCashflow(incomeItems, expenseItems);

        const balanceEl = document.getElementById('balance');
        if (balanceEl) {
            balanceEl.textContent = `S/ ${fmt(balance)}`;
            const balanceState = balance === 0
                ? 'balance-zero'
                : (balance > 0 ? 'balance-positive' : 'balance-negative');
            balanceEl.className = `balance-number ${balanceState}`;
        }
        document.getElementById('total-income')  .textContent = `S/ ${fmt(totalIncome)}`;
        document.getElementById('total-expenses') .textContent = `S/ ${fmt(totalExpenses)}`;
        updatePeriodLabel();
        updateDashboardMetrics({ totalIncome, totalExpenses, expenseItems: realExpenseItems, startDate, endDate });
        // The dedicated expense view owns its own period and does not make
        // the dashboard query or render a second, competing expense panel.

        // Cargar configuración del plan antes de renderizar gráficas
        if (plan) {
            state.planConfig.incomeTarget = Number(plan.incomeTarget || 0);
            state.planConfig.expenseLimit = Number(plan.expenseLimit || 0);
            loadPlanConfigToUi();
        }

        updateStrategyPanel({ totalExpenses });
        renderTransactionLedger(incomeItems, expenseItems);
        chartSnapshot = {
            incomeItems: realIncomeItems,
            expenseItems: realExpenseItems,
            totalIncome,
            totalExpenses,
            expenseLimit: state.planConfig.expenseLimit
        };
        renderCharts(chartSnapshot);

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
        const current = await dbService.getTransactionById(state.currentUser.uid, type, id);
        if (current?.isTransfer || current?.transferId) {
            await dbService.deleteTransfer(state.currentUser.uid, current.transferId);
            showToast('Transferencia eliminada en ambas billeteras', 'success');
        } else {
            await dbService.deleteTransaction(state.currentUser.uid, type, id);
            showToast('Eliminado', 'success');
        }
        refreshFinancialViews();
    } catch (err) {
        showToast('Error: ' + err.message, 'error');
    }
}

async function editItem(id, type) {
    try {
        const data = await dbService.getTransactionById(state.currentUser.uid, type, id);
        if (!data) { showToast('Registro no encontrado', 'error'); return; }
        if (data.isTransfer || data.transferId) {
            showToast('Las transferencias se gestionan desde Billeteras', 'warn');
            return;
        }

        const dateStr = transactionBusinessDate(data) || todayString();

        if (type === 'income') {
            document.getElementById('income-amount').value = data.amount;
            document.getElementById('income-date').value   = dateStr;
            document.getElementById('income-note').value   = data.note || '';
            document.getElementById('income-counterparty').value = data.counterparty || '';
            const src = document.getElementById('income-source');
            if (src) src.value = data.source || 'otros';
            // Preserve import provenance when changing an income's account.
            document.getElementById('form-income').dataset.importedSource = data.gmailId || String(data.source || '').startsWith('gmail:') ? data.source || '' : '';
            setAccountOptions('income-account', data.accountId || '');
            document.getElementById('income-edit-id').value = id;
            openModal('modal-income');
        } else {
            document.getElementById('expense-amount').value = data.amount;
            document.getElementById('expense-date').value   = dateStr;
            document.getElementById('expense-note').value   = data.note || '';
            document.getElementById('expense-counterparty').value = data.counterparty || '';
            const mth = document.getElementById('expense-method');
            if (mth) mth.value = data.method || 'efectivo';
            const radio = document.querySelector(`input[name="category"][value="${data.category}"]`);
            if (radio) radio.checked = true;
            setAccountOptions('expense-account', data.accountId || '');
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
        if (existing.exists) return existing.data();

        const profile = {
            name: user.displayName || '',
            email: user.email || '',
            photoURL: user.photoURL || '',
            authProvider: user.providerData?.[0]?.providerId || 'password',
            currency: 'PEN',
            monthlyTarget: 0,
            bio: '',
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        };
        await ref.set(profile, { merge: true });
        return profile;
    } catch (error) {
        // Authentication must still work when a first profile write is rejected.
        console.warn('No se pudo crear el perfil inicial:', error);
    }
}

auth.onAuthStateChanged(user => {
    chartSnapshot = null;
    // Firebase restores persisted auth asynchronously. Wait for its answer
    // before revealing the app so a signed-in user never sees the landing page.
    document.body.classList.remove('auth-pending');
    if (user) {
        state.dashboardData = null;
        state.currentUser = user;
        const savedWorkspace = readWorkspaceState(user.uid);
        state.workspaceView = savedWorkspace?.view || 'home';
        workspaceRestoreInProgress = true;
        ensureAuthenticatedUserDocument(user).then(profile => {
            // Reuse the authentication read instead of immediately reading
            // /users/{uid} again just to populate the profile form.
            if (state.currentUser?.uid === user.uid) loadUserProfile(profile);
        });
        showPage('dashboard');
        // Startup must not use the normal navigation path: that path scrolls
        // to the top because it is for an intentional click in the sidebar.
        changeAppView(state.workspaceView, { scroll: false, persist: false, load: false });
        replayInterfaceMotion(document.getElementById('dashboard-page'));
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
        const recoveryEl = document.getElementById('recovery-email');
        if (recoveryEl) recoveryEl.value = user.email || '';

        const initialLoads = [loadData()];
        if (state.workspaceView === 'wallets' || state.workspaceView === 'expenses') {
            const walletsReady = loadWallets();
            initialLoads.push(walletsReady);
            if (state.workspaceView === 'expenses') {
                initialLoads.push(walletsReady.then(() => loadExpenseAnalysis()));
            }
        }
        Promise.all(initialLoads).finally(() => restoreWorkspaceScroll(savedWorkspace?.scrollY));
    } else {
        state.currentUser = null;
        state.dashboardData = null;
        state.workspaceView = 'home';
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

    if (!document.getElementById('reg-legal-accept')?.checked) {
        showToast('Debes aceptar los Términos y la Política de Privacidad.', 'error');
        return;
    }

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
            legalAcceptance: { termsVersion: LEGAL_VERSION, privacyVersion: LEGAL_VERSION, acceptedAt: firebase.firestore.FieldValue.serverTimestamp() },
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

async function finishGoogleAuthentication(authResult, acceptedTerms = false) {
    const isNewUser = Boolean(authResult?.additionalUserInfo?.isNewUser);
    if (isNewUser && !acceptedTerms) {
        await auth.signOut();
        showPage('register');
        throw new Error('Para crear una cuenta con Google debes aceptar los Términos y la Política de Privacidad.');
    }
    await ensureAuthenticatedUserDocument(authResult.user);
    if (isNewUser || acceptedTerms) {
        await db.collection('users').doc(authResult.user.uid).set({
            legalAcceptance: { termsVersion: LEGAL_VERSION, privacyVersion: LEGAL_VERSION, acceptedAt: firebase.firestore.FieldValue.serverTimestamp() },
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
    }
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
    const isRegistration = Boolean(button?.closest('#register-page'));
    const acceptedTerms = !isRegistration || Boolean(document.getElementById('reg-legal-accept')?.checked);
    if (!acceptedTerms) {
        showToast('Acepta los Términos y la Política de Privacidad para crear tu cuenta.', 'error');
        return;
    }
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
                        await finishGoogleAuthentication(authResult, isRegistration);
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
                                    await finishGoogleAuthentication(authResult, isRegistration);
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
                        await finishGoogleAuthentication(authResult, isRegistration);
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

async function signOutCurrentUser() {
    if (confirm('¿Cerrar sesión?')) {
        try { await auth.signOut(); }
        catch (err) { showToast('Error: ' + err.message, 'error'); }
    }
}

document.getElementById('logout-btn').onclick = signOutCurrentUser;
document.getElementById('show-register')?.addEventListener('click', e => { e.preventDefault(); showPage('register'); });
document.getElementById('show-login')?.addEventListener('click',    e => { e.preventDefault(); showPage('login'); });
document.getElementById('home-start-register')?.addEventListener('click', () => showPage('register'));
document.getElementById('home-start-login')?.addEventListener('click',    () => showPage('login'));
document.querySelectorAll('[data-home-auth]').forEach(button => {
    button.addEventListener('click', () => showPage(button.dataset.homeAuth === 'login' ? 'login' : 'register'));
});
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

document.getElementById('btn-logout-profile')?.addEventListener('click', async () => {
    closeModal('modal-profile');
    await signOutCurrentUser();
});
document.getElementById('form-profile')?.addEventListener('submit', async e => {
    e.preventDefault();
    try { await saveUserProfile(); }
    catch (err) { showToast('Error al guardar perfil: ' + err.message, 'error'); }
});


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
        updatePeriodLabel();
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
document.getElementById('expenses-range-start')?.setAttribute('max', todayStr);
document.getElementById('expenses-range-end')?.setAttribute('max', todayStr);
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
    updatePeriodLabel();
    loadData();
});

document.getElementById('sort-select')?.addEventListener('change', e => {
    state.currentSort = e.target.value;
    persistUiState();
    renderTransactionLedgerFromCache();
});

// ──────────────────────────────────────────────
// OPEN MODALS
// ──────────────────────────────────────────────
function openIncomeModal() {
    delete document.getElementById('form-income').dataset.importedSource;
    resetTransactionFormState(document.getElementById('form-income'));
    const today = todayString();
    document.getElementById('income-date').value  = today;
    document.getElementById('income-date').max = today;
    document.getElementById('income-edit-id').value = '';
    const src = document.getElementById('income-source');
    if (src) src.value = 'salario';
    const note = document.getElementById('income-note');
    if (note) note.value = '';
    const counterparty = document.getElementById('income-counterparty');
    if (counterparty) counterparty.value = '';
    const amt = document.getElementById('income-amount');
    if (amt) amt.value = '';
    setAccountOptions('income-account', state.selectedWalletId || '');
    openModal('modal-income');
}

function openExpenseModal() {
    resetTransactionFormState(document.getElementById('form-expense'));
    const today = todayString();
    document.getElementById('expense-date').value  = today;
    document.getElementById('expense-date').max = today;
    document.getElementById('expense-edit-id').value = '';
    const mth = document.getElementById('expense-method');
    if (mth) mth.value = 'efectivo';
    const note = document.getElementById('expense-note');
    if (note) note.value = '';
    const counterparty = document.getElementById('expense-counterparty');
    if (counterparty) counterparty.value = '';
    const amt = document.getElementById('expense-amount');
    if (amt) amt.value = '';
    setAccountOptions('expense-account', state.selectedWalletId || '');
    document.querySelectorAll('input[name="category"]').forEach(r => { r.checked = false; });
    openModal('modal-expense');
}

document.addEventListener('click', e => {
    const incBtn = e.target.closest('#btn-income, #btn-income-d, .btn-open-income');
    if (incBtn) { e.preventDefault(); openIncomeModal(); return; }
    const expBtn = e.target.closest('#btn-expense, #btn-expense-d, .btn-open-expense');
    if (expBtn) { e.preventDefault(); openExpenseModal(); return; }
});

function openWalletModal(wallet = null) {
    document.getElementById('modal-wallet-title').textContent = wallet?.id ? 'Editar billetera' : 'Nueva billetera';
    document.getElementById('wallet-edit-id').value = wallet?.id || '';
    document.getElementById('wallet-name').value = wallet?.name || '';
    document.getElementById('wallet-institution').value = wallet?.institution || '';
    document.getElementById('wallet-type').value = wallet?.type || 'bank';
    document.getElementById('wallet-color').value = wallet?.color || 'gold';
    document.getElementById('wallet-opening-balance').value = wallet ? Number(wallet.openingBalance || 0) : '';
    document.getElementById('wallet-include-total').checked = wallet?.includeInTotal !== false;
    document.getElementById('wallet-source-key').value = wallet?.sourceKey || '';
    const sourceKey = wallet?.sourceKey || '';
    const identity = sourceIdentity({ source: sourceKey }, state.walletEntities);
    const unsafePlinLink = identity.channel === 'Plin' && identity.unresolved;
    const linkInput = document.getElementById('wallet-link-source');
    linkInput.checked = !unsafePlinLink && wallet?.linkSource === true;
    linkInput.disabled = unsafePlinLink;
    document.getElementById('wallet-link-source-copy').textContent = unsafePlinLink
        ? 'Plin sin banco confirmado no se vincula automáticamente. Identifica el banco de cada comprobante antes de asociarlo a una cuenta.'
        : `Vincular solo movimientos de ${identity.name}${identity.channel ? ` · ${identity.channel}` : ''} sin una elección de cuenta y usar esta cuenta en futuras importaciones. Se respetan tus asignaciones previas.`;
    document.getElementById('wallet-link-source-row').classList.toggle('hidden', !sourceKey);
    openModal('modal-wallet');
}

function openTransferModal() {
    if (activeWallets().length < 2) {
        showToast('Crea al menos dos billeteras activas para transferir', 'warn');
        return;
    }
    setAccountOptions('transfer-from', state.selectedWalletId || activeWallets()[0].id);
    const destination = activeWallets().find(wallet => wallet.id !== document.getElementById('transfer-from').value)?.id || '';
    setAccountOptions('transfer-to', destination);
    document.getElementById('transfer-amount').value = '';
    document.getElementById('transfer-date').value = todayString();
    document.getElementById('transfer-date').max = todayString();
    document.getElementById('transfer-note').value = '';
    document.getElementById('form-transfer').dataset.submissionKey = createSubmissionKey();
    openModal('modal-transfer');
}

document.querySelectorAll('.app-nav-link').forEach(button => {
    button.addEventListener('click', () => {
        if (button.dataset.view) changeAppView(button.dataset.view);
        // Gmail: delegar al botón del header que ya tiene el listener de initGmailImport
        if (button.dataset.action === 'gmail') openGmailImport(state.currentUser?.uid).catch(error => {
            showToast(error.message || 'No se pudo abrir Gmail', 'error');
        });
        // Perfil: llamar directamente al modal sin delegación indirecta
        if (button.dataset.action === 'profile') openModal('modal-profile');
    });
});

document.getElementById('btn-gmail-import')?.addEventListener('click', () => {
    openGmailImport(state.currentUser?.uid).catch(error => {
        showToast(error.message || 'No se pudo abrir Gmail', 'error');
    });
});

document.getElementById('profile-btn')?.addEventListener('click', () => {
    openModal('modal-profile');
});

document.getElementById('btn-gmail-entities')?.addEventListener('click', () => {
    openGmailEntities(state.currentUser?.uid).catch(error => {
        showToast(error.message || 'No se pudo abrir los remitentes', 'error');
    });
});

document.getElementById('btn-new-wallet')?.addEventListener('click', () => openWalletModal());
document.getElementById('btn-wallet-transfer')?.addEventListener('click', openTransferModal);
document.getElementById('wallets-list')?.addEventListener('click', event => {
    const item = event.target.closest('[data-wallet-id]');
    if (!item) return;
    state.selectedWalletId = item.dataset.walletId;
    renderWallets();
});
document.getElementById('wallet-detail')?.addEventListener('click', async event => {
    const review = event.target.closest('[data-review-wallet-movement]');
    if (review) { editItem(review.dataset.reviewWalletMovement, review.dataset.movementType); return; }
    const action = event.target.closest('[data-wallet-action]')?.dataset.walletAction;
    if (!action) return;
    const wallet = state.wallets.find(item => item.id === state.selectedWalletId);
    if (action === 'income') openIncomeModal();
    else if (action === 'expense') openExpenseModal();
    else if (action === 'transfer') openTransferModal();
    else if (action === 'edit' && wallet) openWalletModal(wallet);
    else if (action === 'archive' && wallet) {
        if (!confirm(`¿Archivar ${wallet.name}? Sus movimientos se conservan.`)) return;
        try {
            await dbService.archiveWallet(state.currentUser.uid, wallet.id);
            showToast('Cuenta archivada', 'success');
            state.selectedWalletId = null;
            await loadWallets({ force: true });
        } catch (error) { showToast('No se pudo archivar: ' + error.message, 'error'); }
    }
});

document.getElementById('form-wallet')?.addEventListener('submit', async event => {
    event.preventDefault();
    const name = normalizeText(document.getElementById('wallet-name').value, 60);
    const openingBalance = Number(document.getElementById('wallet-opening-balance').value || 0);
    if (!name || !Number.isFinite(openingBalance) || Math.abs(openingBalance) > 999999999) {
        showToast('Revisa el nombre y saldo inicial', 'error');
        return;
    }
    try {
        const id = await dbService.saveWallet(state.currentUser.uid, {
            name,
            institution: normalizeText(document.getElementById('wallet-institution').value, 60),
            type: document.getElementById('wallet-type').value,
            color: document.getElementById('wallet-color').value,
            openingBalance,
            sourceKey: document.getElementById('wallet-source-key').value || undefined,
            linkSource: !document.getElementById('wallet-link-source').disabled && document.getElementById('wallet-link-source').checked,
            includeInTotal: document.getElementById('wallet-include-total').checked
        }, document.getElementById('wallet-edit-id').value || null);
        state.selectedWalletId = id;
        closeModal('modal-wallet');
        showToast('Billetera guardada', 'success');
        await loadWallets({ force: true });
    } catch (error) { showToast('No se pudo guardar: ' + error.message, 'error'); }
});

document.getElementById('form-transfer')?.addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    if (form.dataset.saving === 'true') return;
    const fromAccountId = document.getElementById('transfer-from').value;
    const toAccountId = document.getElementById('transfer-to').value;
    const amount = Math.round(Number(document.getElementById('transfer-amount').value || 0) * 100) / 100;
    const dateString = document.getElementById('transfer-date').value;
    if (!fromAccountId || !toAccountId || fromAccountId === toAccountId || !Number.isFinite(amount) || amount <= 0 || !dateString) {
        showToast('Elige dos billeteras distintas, monto y fecha válidos', 'error');
        return;
    }
    form.dataset.saving = 'true';
    try {
        await dbService.saveTransfer(state.currentUser.uid, {
            fromAccountId, toAccountId, amount,
            date: firebase.firestore.Timestamp.fromDate(businessDateToDate(dateString)), operationDate: dateString,
            note: normalizeNote(document.getElementById('transfer-note').value),
            fromName: walletName(fromAccountId), toName: walletName(toAccountId), ...transactionActorData()
        }, form.dataset.submissionKey || createSubmissionKey());
        closeModal('modal-transfer');
        showToast('Transferencia registrada sin afectar tu saldo total', 'success');
        await refreshFinancialViews();
    } catch (error) { showToast('No se pudo transferir: ' + error.message, 'error'); }
    finally { form.dataset.saving = 'false'; }
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

function transactionActorData() {
    return {
        actorUid: state.currentUser?.uid || '',
        actorEmail: state.currentUser?.email || '',
        occurredAt: firebase.firestore.Timestamp.fromDate(new Date())
    };
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
    const accountId = document.getElementById('income-account')?.value || '';
    const counterparty = normalizeText(document.getElementById('income-counterparty')?.value || '', 100);
    const editId  = document.getElementById('income-edit-id').value;

    if (!dateStr) { showToast('Selecciona una fecha', 'error'); return; }
    const date = businessDateToDate(dateStr);
    if (isNaN(date.getTime())) { showToast('Fecha inválida', 'error'); return; }

    if (dateStr > todayString()) { showToast('No puedes registrar fechas futuras', 'error'); return; }
    if (!state.isOnline)  { showToast('Sin conexión', 'error'); return; }

    setTransactionFormSaving(form, true);
    try {
        const data = {
            amount, date: firebase.firestore.Timestamp.fromDate(date), operationDate: dateStr,
            note, source: editId && form.dataset.importedSource ? form.dataset.importedSource : source, counterparty, accountId, ...transactionActorData()
        };
        await dbService.saveIncome(state.currentUser.uid, data, editId || null, form.dataset.submissionKey || null);
        showToast(editId ? 'Ingreso actualizado' : 'Ingreso guardado', 'success');
        setTransactionFormSaving(form, false);
        closeModal('modal-income');
        form.reset();
        document.getElementById('income-edit-id').value = '';
        refreshFinancialViews();
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
    const accountId = document.getElementById('expense-account')?.value || '';
    const counterparty = normalizeText(document.getElementById('expense-counterparty')?.value || '', 100);
    const editId   = document.getElementById('expense-edit-id').value;

    if (!category) { showToast('Selecciona una categoría', 'error'); return; }
    if (!dateStr)  { showToast('Selecciona una fecha', 'error'); return; }
    const date = businessDateToDate(dateStr);
    if (isNaN(date.getTime())) { showToast('Fecha inválida', 'error'); return; }

    if (dateStr > todayString()) { showToast('No puedes registrar fechas futuras', 'error'); return; }
    if (!state.isOnline)  { showToast('Sin conexión', 'error'); return; }

    setTransactionFormSaving(form, true);
    try {
        const data = {
            amount, date: firebase.firestore.Timestamp.fromDate(date), operationDate: dateStr,
            category, note, method, counterparty, accountId, ...transactionActorData()
        };
        await dbService.saveExpense(state.currentUser.uid, data, editId || null, form.dataset.submissionKey || null);
        showToast(editId ? 'Gasto actualizado' : 'Gasto guardado', 'success');
        setTransactionFormSaving(form, false);
        closeModal('modal-expense');
        form.reset();
        document.getElementById('expense-edit-id').value = '';
        refreshFinancialViews();
    } catch (err) {
        showToast('Error: ' + err.message, 'error');
    } finally {
        setTransactionFormSaving(form, false);
    }
};

function appendMovementDetailField(container, label, value) {
    const row = document.createElement('div');
    row.className = 'movement-detail-field';
    const key = document.createElement('span');
    key.textContent = label;
    const val = document.createElement('strong');
    val.textContent = value || '—';
    row.append(key, val);
    container.appendChild(row);
}

async function showMovementDetail(id, type) {
    try {
        const data = await dbService.getTransactionById(state.currentUser.uid, type, id);
        if (!data) { showToast('El movimiento ya no está disponible', 'error'); return; }

        const modal = document.getElementById('modal-movement-detail');
        const fields = document.getElementById('movement-detail-fields');
        const auditList = document.getElementById('movement-audit-list');
        const isIncome = type === 'income';
        const categoryNames = { green: 'Fijo', yellow: 'Necesario', red: 'Antojo' };
        const typeLabel = isIncome ? 'Ingreso' : 'Gasto';

        document.getElementById('movement-detail-kicker').textContent = `${typeLabel} · ${data.status === 'completed' ? 'Completado' : (data.status || 'Registrado')}`;
        document.getElementById('movement-detail-title').textContent = data.note || typeLabel;
        const amount = document.getElementById('movement-detail-amount');
        amount.textContent = `${isIncome ? '+' : '−'} S/ ${fmt(Number(data.amount) || 0)}`;
        amount.className = `movement-detail-amount ${isIncome ? 'is-income' : 'is-expense'}`;
        fields.textContent = '';
        appendMovementDetailField(fields, 'Fecha de operación', formatBusinessDate(transactionBusinessDate(data)));
        appendMovementDetailField(fields, `Hora registrada (${BUSINESS_TIME_ZONE})`, formatBusinessDateTime(data.occurredAt || data.createdAt));
        appendMovementDetailField(fields, 'Tipo', data.operationType || typeLabel);
        appendMovementDetailField(fields, isIncome ? 'Origen' : 'Categoría', isIncome ? (data.source || 'Otros') : (categoryNames[data.category] || data.category));
        appendMovementDetailField(fields, isIncome ? 'Cliente / contraparte' : 'Proveedor / contraparte', data.counterparty);
        appendMovementDetailField(fields, 'Método', data.method || (isIncome ? 'Registro manual' : '—'));
        appendMovementDetailField(fields, 'Billetera', data.accountId ? walletName(data.accountId) : 'Sin asignar');
        appendMovementDetailField(fields, 'Referencia', data.reference || id);
        appendMovementDetailField(fields, 'Registrado por', data.actorEmail || data.actorUid || state.currentUser.email);
        appendMovementDetailField(fields, 'Estado', data.status === 'completed' ? 'Completada' : (data.status || 'Registrada'));

        auditList.textContent = '';
        const events = await dbService.getTransactionAudit(state.currentUser.uid, id);
        if (!events.length) {
            const legacy = document.createElement('p');
            legacy.className = 'movement-audit-empty';
            legacy.textContent = 'Este registro fue creado antes de que se activara la trazabilidad detallada.';
            auditList.appendChild(legacy);
        } else {
            const eventLabels = { created: 'Creado', updated: 'Actualizado', deleted: 'Eliminado' };
            events.forEach(event => {
                const row = document.createElement('div');
                row.className = 'movement-audit-event';
                const title = document.createElement('strong');
                title.textContent = eventLabels[event.eventType] || 'Registrado';
                const meta = document.createElement('span');
                meta.textContent = `${formatBusinessDateTime(event.recordedAt || event.occurredAt)} · ${event.actorEmail || event.actorUid || 'Sistema'}`;
                row.append(title, meta);
                auditList.appendChild(row);
            });
        }
        openModal(modal.id);
    } catch (err) {
        console.error('detail error:', err);
        showToast('No se pudo cargar el detalle: ' + err.message, 'error');
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// BILLETERAS
// Gmail sources are not wallets. A wallet represents the place where money is
// held; a movement can optionally point to one. Existing movements remain safe
// and are simply shown as "Sin asignar".
// ─────────────────────────────────────────────────────────────────────────────
const WALLET_TYPE_LABELS = {
    bank: 'Cuenta bancaria', wallet: 'Billetera digital', cash: 'Efectivo',
    savings: 'Ahorro', credit: 'Tarjeta de crédito'
};
const walletBalances = new Map();
let walletTransactions = [];
let suggestedWallets = [];
let walletLoadToken = 0;
let walletCache = { uid: null, loadedAt: 0 };
const WALLET_CACHE_TTL_MS = 120_000;

function activeWallets() {
    return state.wallets.filter(isActiveWallet);
}

function walletLabel(wallet) {
    const name = String(wallet?.name || 'Cuenta').trim();
    const institution = String(wallet?.institution || '').trim();
    return institution && !name.toLocaleLowerCase('es').includes(institution.toLocaleLowerCase('es'))
        ? `${institution} · ${name}`
        : name;
}

function walletSubtitle(wallet) {
    const name = String(wallet?.name || '').trim();
    const institution = String(wallet?.institution || '').trim();
    if (institution && !name.toLocaleLowerCase('es').includes(institution.toLocaleLowerCase('es'))) return institution;
    return WALLET_TYPE_LABELS[wallet?.type] || 'Cuenta';
}

function setAccountOptions(selectId, selected = '') {
    const select = document.getElementById(selectId);
    if (!select) return;
    const allowEmpty = select.classList.contains('account-select');
    select.textContent = '';
    if (allowEmpty) {
        const empty = document.createElement('option');
        empty.value = '';
        empty.textContent = 'Sin asignar a una billetera';
        select.appendChild(empty);
    }
    activeWallets().forEach(wallet => {
        const option = document.createElement('option');
        option.value = wallet.id;
        option.textContent = walletLabel(wallet);
        select.appendChild(option);
    });
    select.value = selected || (allowEmpty ? '' : (activeWallets()[0]?.id || ''));
}

function walletName(id) {
    const wallet = state.wallets.find(item => item.id === id);
    return wallet ? walletLabel(wallet) : 'Sin asignar';
}

function accountBalance(wallet) {
    return walletBalances.get(wallet.id) || 0;
}

function walletBankKey(wallet) {
    const identity = `${wallet?.institution || ''} ${wallet?.name || ''} ${wallet?.sourceKey || ''}`.toLowerCase();
    if (/plin.*bbva|bbva/.test(identity)) return 'bbva';
    if (/plin.*interbank|interbank|ibk/.test(identity)) return 'interbank';
    if (/bcp|credito del peru|banco de credito/.test(identity)) return 'bcp';
    if (/scotiabank/.test(identity)) return 'scotiabank';
    if (/naci[oó]n|\bbn\b/.test(identity)) return 'nacion';
    if (/mibanco/.test(identity)) return 'mibanco';
    if (/yape/.test(identity)) return 'yape';
    if (/banbif/.test(identity)) return 'banbif';
    return 'default';
}

function walletVisualColor(wallet) {
    // Existing accounts often have the old generic gold default. Give those
    // a bank identity without overwriting a colour explicitly chosen later.
    if (wallet?.color && wallet.color !== 'gold') return wallet.color;
    const defaults = {
        bbva: 'blue', bcp: 'cyan', interbank: 'green', scotiabank: 'red',
        nacion: 'gold', mibanco: 'orange', yape: 'purple', banbif: 'pink'
    };
    return defaults[walletBankKey(wallet)] || wallet?.color || 'gold';
}

function createWalletItem(wallet) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `wallet-list-item wallet-bank-${walletBankKey(wallet)} ${state.selectedWalletId === wallet.id ? 'is-selected' : ''}`;
    item.dataset.walletId = wallet.id;
    item.setAttribute('aria-pressed', String(state.selectedWalletId === wallet.id));
    const identity = document.createElement('span');
    identity.className = `wallet-list-icon wallet-color-${walletVisualColor(wallet)}`;
    identity.textContent = wallet.type === 'wallet' ? '◉' : wallet.type === 'cash' ? 'S/' : wallet.type === 'credit' ? '▤' : '▣';
    const copy = document.createElement('span');
    copy.className = 'wallet-list-copy';
    const name = document.createElement('strong');
    name.textContent = wallet.name;
    const meta = document.createElement('small');
    meta.textContent = `${walletSubtitle(wallet)}${wallet.includeInTotal === false ? ' · Fuera del total' : ''}`;
    copy.append(name, meta);
    const amount = document.createElement('span');
    amount.className = 'wallet-list-amount';
    amount.textContent = `S/ ${fmt(accountBalance(wallet))}`;
    item.append(identity, copy, amount);
    return item;
}

function renderWalletDetail() {
    const panel = document.getElementById('wallet-detail');
    if (!panel) return;
    panel.textContent = '';
    const wallet = state.wallets.find(item => item.id === state.selectedWalletId && isActiveWallet(item));
    panel.className = `wallet-detail-panel wallet-bank-${wallet ? walletBankKey(wallet) : 'default'}`;
    if (!wallet) {
        if (!activeWallets().length) {
            panel.classList.add('hidden');
            return;
        }
        const empty = document.createElement('div');
        empty.className = 'wallet-detail-empty';
        empty.innerHTML = '<span>▣</span><h2>Elige una cuenta</h2><p>Verás su saldo, movimientos y acciones desde aquí.</p>';
        panel.appendChild(empty);
        return;
    }
    const movements = walletTransactions
        .filter(item => item.accountId === wallet.id)
        .sort((a, b) => (b.date?.toMillis?.() || 0) - (a.date?.toMillis?.() || 0));
    const income = sumAmounts(movements.filter(item => item.type === 'income' && isPosted(item)));
    const expense = sumAmounts(movements.filter(item => item.type === 'expense' && isPosted(item)));
    const heading = document.createElement('div');
    heading.className = 'wallet-detail-heading';
    heading.innerHTML = `<span class="wallet-detail-type">${WALLET_TYPE_LABELS[wallet.type] || 'Cuenta'}</span><h2></h2><p></p>`;
    heading.querySelector('h2').textContent = wallet.name;
    heading.querySelector('p').textContent = walletSubtitle(wallet);
    const settings = document.createElement('dl');
    settings.className = 'wallet-settings-summary';
    const settingsRows = [
        ['Estado', 'Activa'],
        ['Saldo total', wallet.includeInTotal === false ? 'No incluida' : 'Incluida'],
        ['Importaciones', wallet.linkSource && wallet.sourceKey ? (() => {
            const identity = sourceIdentity({ source: wallet.sourceKey }, state.walletEntities);
            return identity.channel === 'Plin' && identity.unresolved ? 'Plin sin banco: vinculación automática detenida' : `${identity.name}${identity.channel ? ` · ${identity.channel}` : ''} · vinculación autorizada`;
        })() : 'Asignación manual']
    ];
    settingsRows.forEach(([label, value]) => {
        const row = document.createElement('div');
        const term = document.createElement('dt');
        const detail = document.createElement('dd');
        term.textContent = label;
        detail.textContent = value;
        row.append(term, detail);
        settings.append(row);
    });
    const balance = document.createElement('strong');
    balance.className = 'wallet-detail-balance';
    balance.textContent = `S/ ${fmt(accountBalance(wallet))}`;
    const actions = document.createElement('div');
    actions.className = 'wallet-detail-actions';
    actions.innerHTML = `<button type="button" class="wallet-primary" data-wallet-action="income">+ Ingreso</button><button type="button" class="wallet-secondary" data-wallet-action="expense">− Gasto</button><button type="button" class="wallet-secondary" data-wallet-action="transfer">Transferir</button>`;
    const stats = document.createElement('div');
    stats.className = 'wallet-detail-stats';
    stats.innerHTML = `<div><span>Ingresos</span><strong>S/ ${fmt(income)}</strong></div><div><span>Gastos</span><strong>S/ ${fmt(expense)}</strong></div><div><span>Movimientos</span><strong>${movements.length}</strong></div>`;
    const recent = document.createElement('div');
    recent.className = 'wallet-recent';
    recent.innerHTML = '<h3>Últimos movimientos</h3>';
    if (!movements.length) {
        const p = document.createElement('p');
        p.className = 'wallet-no-movements';
        p.textContent = 'Aún no hay movimientos asignados a esta billetera.';
        recent.appendChild(p);
    } else {
        movements.slice(0, 5).forEach(item => {
            const row = document.createElement('div');
            row.className = 'wallet-recent-row';
            const direction = item.type === 'income' ? '+' : '−';
            row.innerHTML = `<span><strong></strong><small>${formatBusinessDate(transactionBusinessDate(item))}</small></span><b class="${item.type}">${direction} S/ ${fmt(Number(item.amount) || 0)}</b>`;
            row.querySelector('strong').textContent = item.note || (item.type === 'income' ? 'Ingreso' : 'Gasto');
            recent.appendChild(row);
        });
    }
    const management = document.createElement('div');
    management.className = 'wallet-management';
    management.innerHTML = '<button type="button" data-wallet-action="edit">Editar cuenta</button><button type="button" data-wallet-action="archive">Archivar cuenta</button>';
    panel.append(heading, balance, actions, stats, settings, recent, management);
    const conflicts = movements.filter(item => movementIdentity(item, state.wallets, state.walletEntities).accountConflict);
    if (conflicts.length) {
        const review = document.createElement('details'); review.className = 'wallet-link-review';
        const summary = document.createElement('summary'); summary.textContent = `${conflicts.length} movimiento${conflicts.length === 1 ? '' : 's'} con otro banco de origen`;
        const help = document.createElement('p'); help.textContent = 'La cuenta asignada no coincide con el banco del comprobante. Tus saldos se conservan; revisa la cuenta de cada movimiento antes de corregirla.';
        review.append(summary, help);
        conflicts.forEach(item => {
            const button = document.createElement('button'); button.type = 'button'; button.className = 'expense-review-account';
            button.dataset.reviewWalletMovement = item.id; button.dataset.movementType = item.type;
            button.textContent = `${formatBusinessDate(transactionBusinessDate(item))} · ${movementIdentity(item, state.wallets, state.walletEntities).name} · S/ ${fmt(item.amount)} · Revisar cuenta`;
            review.append(button);
        });
        panel.insertBefore(review, recent);
    }
}

function renderWalletChoices() {
    const panel = document.getElementById('wallet-choices');
    panel.replaceChildren();
    const review = state.wallets.filter(walletNeedsReview);
    const archived = state.wallets.filter(w => w.active === false);
    panel.classList.toggle('hidden', !review.length && !suggestedWallets.length && !archived.length);
    if (!review.length && !suggestedWallets.length && !archived.length) return;
    const heading = document.createElement('summary');
    heading.textContent = review.length
        ? `Revisar cuentas pendientes (${review.length})`
        : suggestedWallets.length ? `Ver cuentas sugeridas (${suggestedWallets.length})` : `Ver cuentas archivadas (${archived.length})`;
    const description = document.createElement('p');
    description.textContent = review.length
        ? 'Las cuentas pendientes no afectan tu saldo. Decide si las activas, las archivas o creas una cuenta sugerida para movimientos sin asignar.'
        : suggestedWallets.length
            ? 'Detectamos movimientos sin cuenta asignada. Crea y vincula una cuenta para ordenarlos.'
            : 'Estas cuentas están fuera de tu gestión diaria y del saldo total. Puedes revisarlas y reactivarlas cuando las necesites.';
    panel.append(heading, description);
    const addRow = (name, detail, actions) => {
        const row = document.createElement('div');
        row.className = 'wallet-choice-row';
        const copy = document.createElement('div');
        const title = document.createElement('strong');
        title.textContent = name;
        const text = document.createElement('small');
        text.textContent = detail;
        copy.append(title, text);
        row.append(copy);
        actions.forEach(([label, action, id]) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'wallet-secondary';
            button.textContent = label;
            button.dataset.walletChoice = action;
            button.dataset.choiceId = id;
            row.append(button);
        });
        return row;
    };
    const appendGroup = (title, rows, { collapsible = false, open = false } = {}) => {
        if (!rows.length) return;
        const group = document.createElement(collapsible ? 'details' : 'section');
        group.className = 'wallet-choice-group';
        if (collapsible) {
            group.open = open;
            const summary = document.createElement('summary');
            summary.textContent = title;
            group.appendChild(summary);
        } else {
            const titleEl = document.createElement('h3');
            titleEl.textContent = title;
            group.appendChild(titleEl);
        }
        const rowsEl = document.createElement('div');
        rowsEl.className = 'wallet-choice-rows';
        rows.forEach(row => rowsEl.appendChild(row));
        group.appendChild(rowsEl);
        panel.appendChild(group);
    };
    appendGroup(
        `Pendientes de revisar (${review.length})`,
        review.map(w => addRow(w.name, 'No se usa ni afecta tu saldo hasta que la revises.',
            [['Revisar y activar', 'keep', w.id], ['Archivar', 'archive', w.id]])),
        { collapsible: false }
    );
    appendGroup(`Cuentas sugeridas (${suggestedWallets.length})`, suggestedWallets.map(w => addRow(w.name,
        `${w.configured ? 'Entidad configurada' : 'Detectada en tus movimientos'} · ${w.count} movimientos sin asignar`,
        [['Crear y vincular', 'add', w.sourceKey]])));
    appendGroup(`Cuentas archivadas (${archived.length})`, archived.map(w => addRow(w.name,
        'No se muestra ni afecta tus saldos.', [['Reactivar y editar', 'keep', w.id]])));
}

document.getElementById('wallet-choices')?.addEventListener('click', async event => {
    const button = event.target.closest('[data-wallet-choice]');
    if (!button || !state.currentUser) return;
    const id = button.dataset.choiceId;
    if (button.dataset.walletChoice === 'add') {
        const suggestion = suggestedWallets.find(w => w.sourceKey === id);
        if (suggestion) openWalletModal({
            ...suggestion, institution: suggestion.name, openingBalance: 0,
            type: ['yape', 'plin'].includes(suggestion.sourceKey) ? 'wallet' : 'bank'
        });
    } else if (button.dataset.walletChoice === 'keep') {
        const wallet = state.wallets.find(w => w.id === id);
        if (wallet) openWalletModal(wallet);
    } else {
        button.disabled = true;
        try {
            await dbService.archiveWallet(state.currentUser.uid, id);
            await loadWallets({ force: true });
        } catch (error) {
            showToast(error.message || 'No se pudo archivar la cuenta', 'error');
        } finally { button.disabled = false; }
    }
});

function renderWallets() {
    const list = document.getElementById('wallets-list');
    const active = activeWallets();
    updateContextGuide('accounts-guide', accountGuide(active.length > 0));
    const included = active.filter(wallet => wallet.includeInTotal !== false);
    const total = included.reduce((sum, wallet) => sum + accountBalance(wallet), 0);
    const count = `${active.length} cuenta${active.length !== 1 ? 's' : ''} activa${active.length !== 1 ? 's' : ''}`;
    document.getElementById('wallets-total').textContent = `S/ ${fmt(total)}`;
    document.getElementById('wallets-total-detail').textContent = `${count} · ${included.length} incluida${included.length !== 1 ? 's' : ''} en saldo`;
    renderWalletChoices();
    document.getElementById('wallets-count').textContent = `${count} · ${included.length} en saldo total`;
    if (!list) return;
    list.textContent = '';
    if (!active.length) {
        list.innerHTML = '<div class="wallet-list-empty"><strong>Todavía no tienes cuentas registradas.</strong><span>Crea una para organizar tu dinero por banco, billetera o efectivo.</span></div>';
    } else {
        active.forEach(wallet => list.appendChild(createWalletItem(wallet)));
    }
    renderWalletDetail();
    setAccountOptions('income-account', document.getElementById('income-account')?.value || '');
    setAccountOptions('expense-account', document.getElementById('expense-account')?.value || '');
    setAccountOptions('transfer-from', state.selectedWalletId || '');
    setAccountOptions('transfer-to', '');
    renderExpenseAnalysisView();
}

async function loadWallets({ force = false } = {}) {
    if (!state.currentUser) return;
    const uid = state.currentUser.uid;
    if (!force && walletCache.uid === uid && Date.now() - walletCache.loadedAt < WALLET_CACHE_TTL_MS) {
        renderWallets();
        return;
    }
    const token = ++walletLoadToken;
    try {
        const [wallets, transactions, profile] = await Promise.all([
            dbService.getWallets(uid),
            dbService.getAllTransactionsOrdered(uid),
            dbService.getUserProfile(uid)
        ]);
        if (state.currentUser?.uid !== uid || token !== walletLoadToken) return;
        const entities = profile?.gmailImport?.customEntities || [];
        state.wallets = wallets;
        state.walletEntities = entities;
        walletCache = { uid, loadedAt: Date.now() };
        suggestedWallets = walletSuggestions(wallets, transactions, entities);
        walletTransactions = transactions.map(item => ({
            ...item, accountId: resolveWalletAccount(item, wallets, entities)
        }));
        window.dispatchEvent(new CustomEvent('konteo:wallets-changed', { detail: { uid, wallets } }));
        walletBalances.clear();
        wallets.forEach(wallet => walletBalances.set(wallet.id, Number(wallet.openingBalance || 0)));
        walletTransactions.forEach(item => {
            if (!item.accountId || !walletBalances.has(item.accountId) || !isPosted(item)) return;
            const current = walletBalances.get(item.accountId) || 0;
            const cents = Math.round(current * 100) + (item.type === 'income' ? 1 : -1) * Math.round(Number(item.amount || 0) * 100);
            walletBalances.set(item.accountId, cents / 100);
        });
        if (!state.selectedWalletId || !activeWallets().some(wallet => wallet.id === state.selectedWalletId)) {
            state.selectedWalletId = activeWallets()[0]?.id || null;
        }
        renderWallets();
    } catch (error) {
        console.error('wallets error:', error);
        showToast('No se pudieron cargar las billeteras', 'error');
    }
}

function changeAppView(view, { scroll = true, persist = true, load = true } = {}) {
    const nextView = WORKSPACE_VIEWS.has(view) ? view : 'home';
    const isWallets = nextView === 'wallets';
    const isExpenses = nextView === 'expenses';
    state.workspaceView = nextView;
    document.getElementById('home-view')?.classList.toggle('hidden', isWallets || isExpenses);
    document.getElementById('wallets-view')?.classList.toggle('hidden', !isWallets);
    document.getElementById('expenses-view')?.classList.toggle('hidden', !isExpenses);
    document.querySelectorAll('.app-nav-link[data-view]').forEach(button => {
        const active = button.dataset.view === nextView;
        button.classList.toggle('active', active);
        button.toggleAttribute('aria-current', active);
    });
    replayInterfaceMotion(document.getElementById(isWallets ? 'wallets-view' : (isExpenses ? 'expenses-view' : 'home-view')));
    if (load && isWallets) {
        const list = document.getElementById('wallets-list');
        if (!state.wallets.length && list) {
            list.innerHTML = '<div class="wallet-list-empty"><strong>Cargando tus cuentas...</strong><span>Preparando saldos y movimientos.</span></div>';
        }
        loadWallets();
    }
    if (load && isExpenses) {
        syncExpensePeriodUi();
        syncExpenseMovementTypeUi();
        if (!state.wallets.length) loadWallets();
        loadExpenseAnalysis();
    }
    if (persist) persistWorkspaceState({ view: nextView, scrollY: scroll ? 0 : currentScrollPosition() });
    if (scroll) window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function refreshFinancialViews() {
    const walletViewIsOpen = !document.getElementById('wallets-view')?.classList.contains('hidden');
    const expenseViewIsOpen = !document.getElementById('expenses-view')?.classList.contains('hidden');
    const tasks = [loadData({ force: true })];
    if (walletViewIsOpen || expenseViewIsOpen) tasks.push(loadWallets({ force: true }));
    if (expenseViewIsOpen) tasks.push(loadExpenseAnalysis({ force: true }));
    await Promise.all(tasks);
}

// Keep one refresh subscription for the lifetime of the page. Registering it
// inside auth.onAuthStateChanged caused duplicate reads after a new session.
window.addEventListener('konteo:refresh', refreshFinancialViews);

// ──────────────────────────────────────────────
// EVENT DELEGATION
// ──────────────────────────────────────────────
const listEl = document.getElementById('list');
if (listEl) {
    listEl.addEventListener('click', e => {
        const detail = e.target.closest('.detail-btn');
        const edit = e.target.closest('.edit-btn');
        const del  = e.target.closest('.delete-btn');
        if (detail) { showMovementDetail(detail.dataset.id, detail.dataset.type); return; }
        if (edit) { editItem(edit.dataset.id, edit.dataset.type); return; }
        if (del) { deleteItem(del.dataset.id, del.dataset.type); return; }
        const row = e.target.closest('.item[data-id]');
        if (row) showMovementDetail(row.dataset.id, row.dataset.type);
    });
    listEl.addEventListener('keydown', e => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        if (e.target.closest('button')) return;
        const row = e.target.closest('.item[data-id]');
        if (!row) return;
        e.preventDefault();
        showMovementDetail(row.dataset.id, row.dataset.type);
    });
}

document.getElementById('movement-detail-close')?.addEventListener('click', () => closeModal('modal-movement-detail'));

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
    searchTimeout = setTimeout(renderTransactionLedgerFromCache, 180);
});
document.getElementById('category-filter')?.addEventListener('change', renderTransactionLedgerFromCache);
document.getElementById('status-filter')?.addEventListener('change', renderTransactionLedgerFromCache);

document.getElementById('expenses-detail-list')?.addEventListener('submit', async event => {
    const form = event.target.closest('[data-identify-movement]');
    if (!form) return;
    event.preventDefault();
    if (!state.currentUser || form.dataset.saving === 'true') return;
    const bank = form.elements.institution.value;
    const uid = state.currentUser.uid;
    form.dataset.saving = 'true';
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true; button.textContent = 'Guardando…';
    try {
        await dbService.identifyMovementInstitution(uid, form.dataset.movementType, form.dataset.identifyMovement, bank);
        if (state.currentUser?.uid !== uid) return;
        dashboardReadCache.clear();
        state.expenseEntityIds = [`institution:${bank}`];
        await loadExpenseAnalysis({ force: true });
        showToast('Banco identificado. La cuenta y el importe no se han modificado.', 'success');
    } catch (error) { showToast(error.message || 'No se pudo identificar el banco.', 'error'); }
    finally { delete form.dataset.saving; button.disabled = false; button.textContent = 'Confirmar banco'; }
});

document.getElementById('expenses-detail-list')?.addEventListener('click', event => {
    const button = event.target.closest('[data-review-account]');
    if (button) editItem(button.dataset.reviewAccount, button.dataset.movementType);
});

document.getElementById('expense-entity-list')?.addEventListener('click', event => {
    const button = event.target.closest('[data-expense-entity-focus]');
    if (!button) return;
    // The card itself is the quick, unambiguous path: focus exactly one
    // institution and read its daily totals. The checkbox below is reserved
    // for a deliberate comparison of multiple institutions.
    state.expenseEntityIds = [button.dataset.expenseEntityFocus];
    renderExpenseAnalysisView();
    document.getElementById('expenses-detail-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    document.getElementById('expenses-detail-title')?.focus({ preventScroll: true });
});

document.getElementById('expense-entity-list')?.addEventListener('change', event => {
    const input = event.target.closest('[data-expense-entity-toggle]');
    if (!input) return;
    const available = [...document.querySelectorAll('[data-expense-entity-toggle]')].map(item => item.dataset.expenseEntityToggle);
    const current = state.expenseEntityIds === null ? new Set(available) : new Set(state.expenseEntityIds);
    input.checked ? current.add(input.dataset.expenseEntityToggle) : current.delete(input.dataset.expenseEntityToggle);
    state.expenseEntityIds = current.size === available.length ? null : [...current];
    renderExpenseAnalysisView();
    [...document.querySelectorAll('[data-expense-entity-toggle]')].find(element => element.dataset.expenseEntityToggle === input.dataset.expenseEntityToggle)?.focus({ preventScroll: true });
});

document.getElementById('btn-expenses-select-all')?.addEventListener('click', () => {
    state.expenseEntityIds = null;
    renderExpenseAnalysisView();
});

document.querySelectorAll('.expense-period').forEach(button => button.addEventListener('click', () => {
    state.expenseFilter = button.dataset.expenseFilter;
    syncExpensePeriodUi();
    if (state.expenseFilter === 'custom') {
        document.getElementById('expenses-range-start')?.focus();
        return;
    }
    state.expenseEntityIds = null;
    loadExpenseAnalysis();
}));

document.querySelectorAll('.expense-type').forEach(button => button.addEventListener('click', () => {
    state.expenseMovementType = button.dataset.expenseType;
    state.expenseEntityIds = null;
    syncExpenseMovementTypeUi();
    renderExpenseAnalysisView();
}));

document.getElementById('btn-apply-expenses-range')?.addEventListener('click', () => {
    const start = document.getElementById('expenses-range-start')?.value || '';
    const end = document.getElementById('expenses-range-end')?.value || '';
    if (!start || !end) { showToast('Define fecha inicio y fin', 'error'); return; }
    if (start > end) { showToast('La fecha inicio no puede ser mayor que la fin', 'error'); return; }
    state.expenseRangeStart = start;
    state.expenseRangeEnd = end;
    state.expenseFilter = 'custom';
    state.expenseEntityIds = null;
    syncExpensePeriodUi();
    loadExpenseAnalysis();
});

// ──────────────────────────────────────────────
// PLAN
// ──────────────────────────────────────────────
document.getElementById('btn-save-plan')?.addEventListener('click', async () => {
    if (await savePlanConfigFromUi()) loadData();
});


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

// Export buttons — Toolbar (único set de botones de exportación)
document.getElementById('btn-export-excel-toolbar')?.addEventListener('click', () => exportToExcel(getExportContext()));
document.getElementById('btn-export-pdf-toolbar')?.addEventListener('click', () => exportToPDF(getExportContext()));

// Native details keeps export choices keyboard-accessible without a custom menu.
document.addEventListener('click', event => {
    document.querySelectorAll('.export-control[open]').forEach(control => {
        if (!control.contains(event.target) || event.target.closest('.btn-export-mini')) control.open = false;
    });
    if (event.target.closest('[data-reset-ledger-filters]')) {
        document.getElementById('search-input').value = '';
        document.getElementById('category-filter').value = 'all';
        document.getElementById('status-filter').value = 'all';
        renderTransactionLedgerFromCache();
        document.getElementById('search-input').focus();
    }
});
document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    document.querySelectorAll('.export-control[open]').forEach(control => {
        if (control.contains(document.activeElement)) control.querySelector('summary').focus();
        control.open = false;
    });
});

// ──────────────────────────────────────────────
// DELETE ALL USER DATA
// ──────────────────────────────────────────────
function setDeleteAccountStatus(message = '', status = '') {
    const element = document.getElementById('delete-confirm-status');
    if (!element) return;
    element.textContent = message;
    element.hidden = !message;
    if (status) element.dataset.state = status;
    else delete element.dataset.state;
}

function accountDeletionErrorMessage(error) {
    const code = error?.code || '';
    if (code === 'auth/popup-closed-by-user' || code === 'konteo/deletion-cancelled') {
        return 'No se eliminó nada. La verificación de seguridad se canceló antes de terminar.';
    }
    if (code === 'auth/popup-blocked') {
        return 'No se eliminó nada. Permite las ventanas emergentes para Konteo y vuelve a verificar tu cuenta con Google.';
    }
    if (code === 'auth/cancelled-popup-request') {
        return 'La verificación anterior se interrumpió. Espera unos segundos y vuelve a intentarlo.';
    }
    if (code === 'auth/user-mismatch') {
        return 'No se eliminó nada. Verifica con la misma cuenta de Google que usas en Konteo.';
    }
    if (code === 'auth/network-request-failed') {
        return 'No se eliminó nada. Revisa tu conexión y vuelve a intentarlo.';
    }
    if (code === 'auth/requires-recent-login') {
        return 'Para proteger tu cuenta, vuelve a verificar tu identidad antes de eliminarla.';
    }
    return 'No se completó la eliminación. La cuenta de acceso sigue activa; inténtalo de nuevo o contacta a soporte si persiste.';
}

document.getElementById('btn-open-delete-data')?.addEventListener('click', () => {
    closeModal('modal-profile');
    const lbl = document.getElementById('delete-user-email-label');
    if (lbl) lbl.textContent = state.currentUser?.email || 'tu cuenta';
    const inp = document.getElementById('delete-confirm-input');
    if (inp) inp.value = '';
    const btn = document.getElementById('btn-confirm-delete-all');
    if (btn) btn.disabled = true;
    setDeleteAccountStatus();
    openModal('modal-confirm-delete');
});
document.getElementById('btn-cancel-delete')?.addEventListener('click', () => {
    closeModal('modal-confirm-delete');
});
document.getElementById('btn-export-all-data')?.addEventListener('click', async () => {
    if (!state.currentUser) return;
    const button = document.getElementById('btn-export-all-data');
    const original = button?.textContent;
    if (button) { button.disabled = true; button.textContent = 'Preparando copia...'; }
    try {
        const archive = await dbService.exportAllUserData(state.currentUser.uid);
        const blob = new window.Blob([JSON.stringify(archive, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url; link.download = `konteo05-datos-${todayString()}.json`;
        document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url);
        showToast('Tu copia de datos se descargó.', 'success');
    } catch (error) {
        showToast(`No se pudo exportar: ${error.message}`, 'error');
    } finally {
        if (button) { button.disabled = false; button.textContent = original; }
    }
});
document.getElementById('delete-confirm-input')?.addEventListener('input', e => {
    const val = (e.target.value || '').trim().toUpperCase();
    const btn = document.getElementById('btn-confirm-delete-all');
    if (btn) btn.disabled = val !== 'BORRAR';
});
async function reauthenticateForAccountDeletion(user) {
    const providers = new Set((user.providerData || []).map(provider => provider.providerId));
    const providerId = providers.has('google.com') ? 'google.com' : (providers.has('password') ? 'password' : '');
    if (providerId === 'password') {
        const password = window.prompt('Por seguridad, escribe tu contraseña para eliminar la cuenta.');
        if (!password) throw new Error('Se canceló la confirmación de seguridad.');
        const credential = firebase.auth.EmailAuthProvider.credential(user.email, password);
        await user.reauthenticateWithCredential(credential);
        return;
    }
    if (providerId === 'google.com') {
        const provider = new firebase.auth.GoogleAuthProvider();
        provider.setCustomParameters({ prompt: 'select_account' });
        await user.reauthenticateWithPopup(provider);
        return;
    }
    throw new Error('Vuelve a iniciar sesión recientemente antes de eliminar la cuenta.');
}
document.getElementById('btn-confirm-delete-all')?.addEventListener('click', async () => {
    if (!state.currentUser) return;
    const user = state.currentUser;
    const submitBtn = document.getElementById('btn-confirm-delete-all');
    const cancelBtn = document.getElementById('btn-cancel-delete');
    const confirmInput = document.getElementById('delete-confirm-input');
    const modal = document.getElementById('modal-confirm-delete');
    if (!submitBtn || modal?.dataset.saving === 'true') return;
    const origText = submitBtn.textContent;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Verificando...';
    if (confirmInput) confirmInput.disabled = true;
    if (cancelBtn) cancelBtn.disabled = true;
    if (modal) {
        modal.dataset.saving = 'true';
        modal.setAttribute('aria-busy', 'true');
    }
    try {
        setDeleteAccountStatus('Confirma tu identidad con Google. No se eliminará nada hasta terminar esta verificación.', 'progress');
        await reauthenticateForAccountDeletion(user);
        submitBtn.textContent = 'Eliminando...';
        setDeleteAccountStatus('Identidad confirmada. Eliminando tu cuenta y tus datos…', 'progress');
        revokeGmailToken();
        await dbService.deleteAllUserData(user.uid);
        // Limpiar el caché local de IDs de Gmail para que el usuario pueda reimportar sin ver "sin movimientos nuevos"
        clearGmailImportCache();
        if (modal) {
            modal.dataset.saving = 'false';
            modal.removeAttribute('aria-busy');
        }
        closeModal('modal-confirm-delete');
        await user.delete();
        showToast('Cuenta y datos eliminados definitivamente.', 'success');
        await auth.signOut().catch(() => {});
    } catch (err) {
        setDeleteAccountStatus(accountDeletionErrorMessage(err), 'error');
    } finally {
        if (modal) {
            modal.dataset.saving = 'false';
            modal.removeAttribute('aria-busy');
        }
        if (confirmInput) confirmInput.disabled = false;
        if (cancelBtn) cancelBtn.disabled = false;
        submitBtn.disabled = (confirmInput?.value || '').trim().toUpperCase() !== 'BORRAR';
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
            .then(regs => Promise.all(regs.filter(reg => {
                const worker = reg.active || reg.waiting || reg.installing;
                return worker && new URL(worker.scriptURL).pathname === '/service-worker.js';
            }).map(reg => reg.unregister())))
            .catch(() => {});
        if ('caches' in window) {
            caches.keys()
                .then(names => Promise.all(names.filter(name => name.startsWith('konteo05-')).map(name => caches.delete(name))))
                .catch(() => {});
        }
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
initInterfaceMotion();
initContextGuides({
    onNewAccount: () => openWalletModal(),
    onEditAccount: () => {
        const wallet = state.wallets.find(item => item.id === state.selectedWalletId && isActiveWallet(item));
        if (wallet) openWalletModal(wallet);
        else document.getElementById('wallets-list')?.querySelector('button')?.focus();
    }
});
