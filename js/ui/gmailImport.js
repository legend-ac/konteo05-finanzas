// js/ui/gmailImport.js
// Auto-importación desde Gmail — flujo completo con consentimiento explícito

import {
    initGmailService,
    requestGmailToken,
    isTokenValid,
    revokeGmailToken,
    fetchTransactionEmails,
    decodeEmailBody,
    getEmailSender,
    getEmailDate,
    getEmailSubject,
    getConnectedEmail,
} from '../services/gmailService.js';

import { parseAllEmails } from '../services/gmailParser.js';
import { db, firebase }   from '../firebase/config.js';
import { saveIncome, saveExpense } from '../services/dbService.js';

// ─────────────────────────────────────────────
// ESTADO
// ─────────────────────────────────────────────
let currentUid        = null;
let pendingTxs        = [];
let selectedIds       = new Set();
let importedGmailIds  = new Set();

// ─────────────────────────────────────────────
// FIRESTORE: preferencia del usuario
// ─────────────────────────────────────────────
async function getGmailPref() {
    try {
        const doc = await db.collection('users').doc(currentUid).get();
        return doc.exists ? (doc.data().gmailImport || null) : null;
    } catch { return null; }
}

async function saveGmailPref(data) {
    try {
        await db.collection('users').doc(currentUid).set(
            { gmailImport: { ...data, updatedAt: firebase.firestore.FieldValue.serverTimestamp() } },
            { merge: true }
        );
    } catch (e) { console.warn('[gmailImport] No se pudo guardar preferencia:', e); }
}

async function disconnectGmail() {
    revokeGmailToken();
    await saveGmailPref({ enabled: false, email: null });
    importedGmailIds.clear();
    sessionStorage.removeItem('konteo_gmail_imported');
    renderHeaderBadge(null);
}

// ─────────────────────────────────────────────
// DEDUPLICACIÓN: IDs ya importados
// ─────────────────────────────────────────────
function loadImportedIds() {
    try {
        const raw = sessionStorage.getItem(`konteo_gmail_${currentUid}`) || '[]';
        importedGmailIds = new Set(JSON.parse(raw));
    } catch { importedGmailIds = new Set(); }
}

function persistImportedId(id) {
    importedGmailIds.add(id);
    try {
        sessionStorage.setItem(`konteo_gmail_${currentUid}`, JSON.stringify([...importedGmailIds]));
    } catch {}
}

// ─────────────────────────────────────────────
// HEADER BADGE: muestra Gmail conectado
// ─────────────────────────────────────────────
function renderHeaderBadge(email) {
    const btn = document.getElementById('btn-gmail-import');
    if (!btn) return;
    if (email) {
        btn.classList.add('gmail-connected');
        btn.title = `Gmail conectado: ${email}`;
        btn.innerHTML = `
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4-8 5-8-5V6l8 5 8-5v2z"/>
            </svg>
            <span>Gmail ✓</span>`;
    } else {
        btn.classList.remove('gmail-connected');
        btn.title = 'Conectar Gmail para auto-importar movimientos';
        btn.innerHTML = `
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4-8 5-8-5V6l8 5 8-5v2z"/>
            </svg>
            <span>Auto-importar</span>`;
    }
}

// ─────────────────────────────────────────────
// HELPERS UI
// ─────────────────────────────────────────────
const SOURCE_ICONS  = { yape:'💜', plin:'🔵', bcp:'🔴', interbank:'🟢', bbva:'🔵', scotiabank:'🔴', banbif:'🟡', mibanco:'🟠' };
const SOURCE_LABELS = { yape:'Yape', plin:'Plin', bcp:'BCP', interbank:'Interbank', bbva:'BBVA', scotiabank:'Scotiabank', banbif:'BanBif', mibanco:'MiBanco' };

function fmtAmt(n)  { return `S/ ${Number(n).toFixed(2)}`; }

function renderTxCard(tx, idx) {
    const icon      = SOURCE_ICONS[tx.source]  || '💳';
    const label     = SOURCE_LABELS[tx.source] || tx.source;
    const typeClass = tx.type === 'income' ? 'gmail-tx-income' : 'gmail-tx-expense';
    const typeLabel = tx.type === 'income' ? 'Ingreso' : 'Gasto';
    const sign      = tx.type === 'income' ? '+' : '−';
    const checked   = selectedIds.has(idx) ? 'checked' : '';
    return `
    <label class="gmail-tx-card ${typeClass}" data-idx="${idx}">
        <input type="checkbox" class="gmail-tx-check" data-idx="${idx}" ${checked}>
        <div class="gmail-tx-body">
            <div class="gmail-tx-header">
                <span class="gmail-tx-source">${icon} ${label}</span>
                <span class="gmail-tx-badge gmail-badge-${tx.type}">${typeLabel}</span>
            </div>
            <div class="gmail-tx-desc">${tx.description}</div>
            <div class="gmail-tx-date">${tx.date}</div>
        </div>
        <div class="gmail-tx-amount ${typeClass}-amount">${sign} ${fmtAmt(tx.amount)}</div>
    </label>`;
}

// ─────────────────────────────────────────────
// MODAL HTML
// ─────────────────────────────────────────────
function buildModal() {
    const old = document.getElementById('modal-gmail-import');
    if (old) old.remove();

    const el = document.createElement('div');
    el.id        = 'modal-gmail-import';
    el.className = 'modal hidden';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-labelledby', 'gmail-modal-title');
    el.innerHTML = `
    <div class="modal-content gmail-modal-content">
        <div class="modal-handle"></div>

        <!-- HEADER del modal -->
        <div class="gmail-modal-header">
            <div>
                <h3 id="gmail-modal-title">✉️ Auto-importar movimientos</h3>
                <p class="gmail-modal-sub" id="gmail-modal-sub">Conecta el Gmail donde recibes notificaciones de tu banco.</p>
            </div>
            <button id="gmail-modal-close" class="gmail-close-btn" aria-label="Cerrar">✕</button>
        </div>

        <!-- Estado 1: Consentimiento (pantalla inicial) -->
        <div id="gmail-state-consent" class="gmail-state">
            <div class="gmail-consent-box">
                <div class="gmail-consent-icon">🔒</div>
                <h4>¿Activar importación automática?</h4>
                <p>Konteo 05 leerá los emails de notificación de tus bancos y apps de pago para registrar tus movimientos automáticamente.</p>
                <div class="gmail-consent-features">
                    <div class="gmail-cf-item">✅ Solo lectura — nunca envía ni borra emails</div>
                    <div class="gmail-cf-item">✅ Tú decides qué importar antes de guardar</div>
                    <div class="gmail-cf-item">✅ Puedes desconectar en cualquier momento</div>
                    <div class="gmail-cf-item">✅ El token no se almacena en nuestros servidores</div>
                </div>
                <div class="gmail-consent-sources">
                    <span>💜 Yape</span><span>🔵 Plin</span><span>🔴 BCP</span>
                    <span>🟢 Interbank</span><span>🔵 BBVA</span><span>🔴 Scotiabank</span>
                </div>
                <div class="gmail-days-row" style="justify-content:center;margin-top:8px">
                    <label for="gmail-days-select">Buscar en los últimos:</label>
                    <select id="gmail-days-select">
                        <option value="7">7 días</option>
                        <option value="30" selected>30 días</option>
                        <option value="60">60 días</option>
                        <option value="90">90 días</option>
                    </select>
                </div>
            </div>
            <div class="gmail-consent-actions">
                <button id="gmail-btn-decline" class="gmail-btn-secondary">Ahora no</button>
                <button id="gmail-btn-connect" class="gmail-btn-primary">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                        <path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4-8 5-8-5V6l8 5 8-5v2z"/>
                    </svg>
                    Autorizar con Gmail
                </button>
            </div>
        </div>

        <!-- Estado 2: Ya conectado — acción rápida -->
        <div id="gmail-state-connected" class="gmail-state hidden">
            <div class="gmail-connected-box">
                <div class="gmail-connected-email" id="gmail-connected-email-label">
                    <span class="gmail-dot"></span>
                    <span id="gmail-email-display">Cargando…</span>
                </div>
                <div class="gmail-days-row" style="margin-top:12px">
                    <label for="gmail-days-select2">Buscar en los últimos:</label>
                    <select id="gmail-days-select2">
                        <option value="7">7 días</option>
                        <option value="30" selected>30 días</option>
                        <option value="60">60 días</option>
                        <option value="90">90 días</option>
                    </select>
                </div>
            </div>
            <div class="gmail-consent-actions">
                <button id="gmail-btn-disconnect" class="gmail-btn-sm gmail-btn-danger">Desconectar Gmail</button>
                <button id="gmail-btn-sync" class="gmail-btn-primary">🔄 Buscar movimientos ahora</button>
            </div>
        </div>

        <!-- Estado 3: Cargando -->
        <div id="gmail-state-loading" class="gmail-state hidden">
            <div class="gmail-spinner-wrap">
                <div class="gmail-spinner"></div>
                <p id="gmail-loading-msg">Conectando con Gmail…</p>
            </div>
        </div>

        <!-- Estado 4: Resultados / preview -->
        <div id="gmail-state-results" class="gmail-state hidden">
            <div class="gmail-results-toolbar">
                <span id="gmail-found-count" class="gmail-found-count"></span>
                <div class="gmail-select-btns">
                    <button id="gmail-select-all" class="gmail-btn-sm">Todos</button>
                    <button id="gmail-deselect-all" class="gmail-btn-sm">Ninguno</button>
                </div>
            </div>
            <div id="gmail-tx-list" class="gmail-tx-list"></div>
            <div class="gmail-actions-row">
                <button id="gmail-btn-back" class="gmail-btn-secondary">← Volver</button>
                <button id="gmail-btn-import" class="gmail-btn-primary" disabled>Importar seleccionados</button>
            </div>
        </div>

        <!-- Estado 5: Éxito -->
        <div id="gmail-state-success" class="gmail-state hidden">
            <div class="gmail-success-wrap">
                <div class="gmail-success-icon">✅</div>
                <h4 id="gmail-success-title">¡Listo!</h4>
                <p id="gmail-success-msg"></p>
                <button id="gmail-btn-done" class="gmail-btn-primary" style="align-self:center;width:auto;padding:0 32px">Ver movimientos</button>
            </div>
        </div>

        <!-- Estado 6: Error -->
        <div id="gmail-state-error" class="gmail-state hidden">
            <div class="gmail-error-wrap">
                <div class="gmail-error-icon">⚠️</div>
                <p id="gmail-error-msg"></p>
                <div class="gmail-consent-actions" style="margin-top:4px">
                    <button id="gmail-btn-retry" class="gmail-btn-secondary">Reintentar</button>
                    <button id="gmail-btn-err-close" class="gmail-btn-primary">Cerrar</button>
                </div>
            </div>
        </div>
    </div>`;
    document.body.appendChild(el);
    return el;
}

// ─────────────────────────────────────────────
// NAVEGACIÓN DE ESTADOS
// ─────────────────────────────────────────────
function showState(name) {
    ['consent','connected','loading','results','success','error'].forEach(s => {
        const el = document.getElementById(`gmail-state-${s}`);
        if (el) el.classList.toggle('hidden', s !== name);
    });
}

function openModal()  {
    const m = document.getElementById('modal-gmail-import');
    if (m) { m.classList.remove('hidden'); document.body.style.overflow = 'hidden'; }
}
function closeModal() {
    const m = document.getElementById('modal-gmail-import');
    if (m) { m.classList.add('hidden'); document.body.style.overflow = ''; }
}

// ─────────────────────────────────────────────
// FLUJO: conectar y buscar
// ─────────────────────────────────────────────
async function connectAndSearch(daysBack) {
    showState('loading');
    try {
        document.getElementById('gmail-loading-msg').textContent = 'Esperando autorización de Google…';
        await requestGmailToken();

        const connectedEmail = getConnectedEmail();
        await saveGmailPref({ enabled: true, email: connectedEmail });
        renderHeaderBadge(connectedEmail);

        await doSearch(daysBack);
    } catch (err) {
        handleError(err);
    }
}

async function doSearch(daysBack) {
    try {
        document.getElementById('gmail-loading-msg').textContent = `Buscando emails de los últimos ${daysBack} días…`;
        const rawMessages = await fetchTransactionEmails(daysBack);

        document.getElementById('gmail-loading-msg').textContent = `Analizando ${rawMessages.length} email${rawMessages.length !== 1 ? 's' : ''}…`;

        const txs = parseAllEmails({
            rawMessages,
            decodeBody: decodeEmailBody,
            getSender: getEmailSender,
            getDate: getEmailDate,
            getSubject: getEmailSubject,
            existingIds: importedGmailIds,
        });

        showResults(txs);
    } catch (err) {
        handleError(err);
    }
}

function showResults(txs) {
    pendingTxs  = txs;
    selectedIds = new Set(txs.map((_, i) => i));

    const countEl  = document.getElementById('gmail-found-count');
    const listEl   = document.getElementById('gmail-tx-list');
    const importBtn = document.getElementById('gmail-btn-import');

    if (txs.length === 0) {
        if (countEl) countEl.textContent = 'No se encontraron movimientos nuevos.';
        if (listEl)  listEl.innerHTML = '<p class="gmail-empty">Todos los movimientos ya fueron importados o no hay emails bancarios en ese período.</p>';
        if (importBtn) importBtn.disabled = true;
        showState('results');
        return;
    }

    if (countEl)  countEl.textContent = `${txs.length} movimiento${txs.length !== 1 ? 's' : ''} detectado${txs.length !== 1 ? 's' : ''}`;
    if (listEl)   listEl.innerHTML    = txs.map((tx, i) => renderTxCard(tx, i)).join('');
    updateImportBtn();
    showState('results');
}

function updateImportBtn() {
    const btn = document.getElementById('gmail-btn-import');
    if (!btn) return;
    const n = selectedIds.size;
    btn.disabled    = n === 0;
    btn.textContent = n > 0 ? `Importar ${n} movimiento${n !== 1 ? 's' : ''}` : 'Selecciona al menos uno';
}

async function doImport() {
    showState('loading');
    document.getElementById('gmail-loading-msg').textContent = 'Guardando movimientos en tu cuenta…';

    const toImport = pendingTxs.filter((_, i) => selectedIds.has(i));
    let ok = 0, fail = 0;

    for (const tx of toImport) {
        try {
            const now     = firebase.firestore.Timestamp.fromDate(new Date());
            const dateTs  = firebase.firestore.Timestamp.fromDate(new Date(`${tx.date}T12:00:00`));
            const payload = { amount: tx.amount, note: tx.description, date: dateTs, createdAt: now,
                              source: `gmail:${tx.source}`, gmailId: tx.gmailId };

            if (tx.type === 'income') {
                await saveIncome(currentUid, { ...payload, category: tx.category || 'otros' });
            } else {
                await saveExpense(currentUid, { ...payload, category: tx.category || 'yellow', method: 'otro' });
            }
            persistImportedId(tx.gmailId);
            ok++;
        } catch (e) { console.error('[gmailImport] Error al guardar:', e); fail++; }
    }

    const title = document.getElementById('gmail-success-title');
    const msg   = document.getElementById('gmail-success-msg');
    if (title) title.textContent = ok > 0 ? '¡Importación completa!' : 'Sin cambios';
    if (msg)   msg.textContent   = [
        ok   > 0 ? `${ok} movimiento${ok !== 1 ? 's' : ''} importado${ok !== 1 ? 's' : ''} correctamente.`   : '',
        fail > 0 ? `${fail} no pudieron guardarse — intenta de nuevo.` : '',
    ].filter(Boolean).join(' ');

    showState('success');
}

function handleError(err) {
    console.error('[gmailImport]', err);
    const msgEl = document.getElementById('gmail-error-msg');
    if (msgEl) msgEl.textContent = err.message || 'Ocurrió un error. Intenta de nuevo.';
    showState('error');
}

// ─────────────────────────────────────────────
// LISTENERS
// ─────────────────────────────────────────────
function wireListeners(pref) {
    const modal = document.getElementById('modal-gmail-import');
    if (!modal) return;

    // Cerrar
    document.getElementById('gmail-modal-close')?.addEventListener('click', closeModal);
    modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });

    // Consentimiento
    document.getElementById('gmail-btn-decline')?.addEventListener('click', async () => {
        await saveGmailPref({ enabled: false, email: null });
        closeModal();
    });

    document.getElementById('gmail-btn-connect')?.addEventListener('click', () => {
        const days = parseInt(document.getElementById('gmail-days-select')?.value || '30', 10);
        connectAndSearch(days);
    });

    // Ya conectado → sincronizar
    document.getElementById('gmail-btn-sync')?.addEventListener('click', async () => {
        const days = parseInt(document.getElementById('gmail-days-select2')?.value || '30', 10);
        showState('loading');
        if (!isTokenValid()) {
            await connectAndSearch(days);
        } else {
            await doSearch(days);
        }
    });

    // Desconectar
    document.getElementById('gmail-btn-disconnect')?.addEventListener('click', async () => {
        await disconnectGmail();
        showState('consent');
    });

    // Selección
    document.getElementById('gmail-select-all')?.addEventListener('click', () => {
        selectedIds = new Set(pendingTxs.map((_, i) => i));
        modal.querySelectorAll('.gmail-tx-check').forEach(cb => cb.checked = true);
        updateImportBtn();
    });
    document.getElementById('gmail-deselect-all')?.addEventListener('click', () => {
        selectedIds.clear();
        modal.querySelectorAll('.gmail-tx-check').forEach(cb => cb.checked = false);
        updateImportBtn();
    });
    document.getElementById('gmail-tx-list')?.addEventListener('change', e => {
        const cb = e.target.closest('.gmail-tx-check');
        if (!cb) return;
        const idx = parseInt(cb.dataset.idx, 10);
        if (cb.checked) selectedIds.add(idx); else selectedIds.delete(idx);
        updateImportBtn();
    });

    // Importar
    document.getElementById('gmail-btn-import')?.addEventListener('click', doImport);

    // Volver desde resultados
    document.getElementById('gmail-btn-back')?.addEventListener('click', () => {
        showState(pref?.enabled ? 'connected' : 'consent');
    });

    // Reintentar error
    document.getElementById('gmail-btn-retry')?.addEventListener('click', () => {
        showState(pref?.enabled ? 'connected' : 'consent');
    });
    document.getElementById('gmail-btn-err-close')?.addEventListener('click', closeModal);

    // Listo (éxito)
    document.getElementById('gmail-btn-done')?.addEventListener('click', () => {
        closeModal();
        window.dispatchEvent(new CustomEvent('konteo:refresh'));
    });

    // Botón header
    document.getElementById('btn-gmail-import')?.addEventListener('click', async () => {
        const fresh = await getGmailPref();
        if (fresh?.enabled && fresh?.email) {
            const emailEl = document.getElementById('gmail-email-display');
            if (emailEl) emailEl.textContent = fresh.email;
            showState('connected');
        } else {
            showState('consent');
        }
        openModal();
    });
}

// ─────────────────────────────────────────────
// EXPORT: punto de entrada
// ─────────────────────────────────────────────
export async function initGmailImport(uid) {
    currentUid = uid;
    loadImportedIds();

    const pref = await getGmailPref();

    buildModal();
    wireListeners(pref);

    // Actualizar badge del header
    renderHeaderBadge(pref?.enabled ? pref.email : null);

    // Pre-cargar Google Identity Services en background
    initGmailService().catch(() => {});
}
