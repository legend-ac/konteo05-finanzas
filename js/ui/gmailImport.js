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
import { saveIncome, saveExpense, getImportedGmailIds } from '../services/dbService.js';

// ─────────────────────────────────────────────
// ESTADO
// ─────────────────────────────────────────────
let currentUid        = null;
let pendingTxs        = [];
let selectedIds       = new Set();
let importedGmailIds  = new Set();
let gmailPreference   = null;

// ─────────────────────────────────────────────
// FIRESTORE: preferencia del usuario
// ─────────────────────────────────────────────
async function getGmailPref() {
    try {
        const doc = await db.collection('users').doc(currentUid).get();
        gmailPreference = doc.exists ? (doc.data().gmailImport || null) : null;
        return gmailPreference;
    } catch {
        gmailPreference = null;
        return null;
    }
}

async function saveGmailPref(data) {
    try {
        gmailPreference = { ...(gmailPreference || {}), ...data };
        await db.collection('users').doc(currentUid).set(
            { gmailImport: { ...gmailPreference, updatedAt: firebase.firestore.FieldValue.serverTimestamp() } },
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
const SOURCE_ICONS  = { yape:'💜', plin:'🔵', bcp:'🔴', interbank:'🟢', bbva:'🔵', scotiabank:'🔴', banbif:'🟡', nacion:'🔴', mibanco:'🟠', sip:'🔷', binance:'🟡', pagoefectivo:'🟨' };
const SOURCE_LABELS = { yape:'Yape', plin:'Plin', bcp:'BCP', interbank:'Interbank', bbva:'BBVA', scotiabank:'Scotiabank', banbif:'BanBif', nacion:'Banco de la Nación', mibanco:'MiBanco', sip:'SIP', binance:'Binance', pagoefectivo:'PagoEfectivo' };
const EXPENSE_CATEGORIES = [
    ['green', 'Fijo'],
    ['yellow', 'Necesario'],
    ['red', 'Antojo'],
];

function fmtAmt(n, currency = 'PEN')  {
    const amount = Number(n).toFixed(2);
    return currency === 'PEN' ? `S/ ${amount}` : `${amount} ${currency}`;
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, char => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
    }[char]));
}

function sourceLabel(source) {
    return SOURCE_LABELS[source] || source;
}

function renderCategoryControl(tx, idx) {
    if (tx.type !== 'expense' || tx.reviewOnly) return '';
    const options = EXPENSE_CATEGORIES.map(([value, label]) => (
        `<option value="${value}" ${tx.category === value ? 'selected' : ''}>${label}</option>`
    )).join('');
    return `
        <label class="gmail-category-control" for="gmail-category-${idx}">
            <span>Categoría</span>
            <select id="gmail-category-${idx}" class="gmail-tx-category" data-idx="${idx}">${options}</select>
        </label>`;
}

function renderTxCard(tx, idx) {
    const icon      = SOURCE_ICONS[tx.source]  || '💳';
    const label     = tx.sourceLabel || SOURCE_LABELS[tx.source] || tx.source;
    const isReview  = tx.reviewOnly || tx.type === 'review';
    const typeClass = isReview ? 'gmail-tx-review' : (tx.type === 'income' ? 'gmail-tx-income' : 'gmail-tx-expense');
    const typeLabel = isReview ? 'Revisar' : (tx.type === 'income' ? 'Ingreso' : 'Gasto');
    const sign      = tx.type === 'income' ? '+' : (isReview ? '' : '−');
    const checked   = selectedIds.has(idx) ? 'checked' : '';
    const disabled  = isReview ? 'disabled' : '';
    const reason    = isReview && tx.reviewReason ? `<div class="gmail-tx-reason">${escapeHtml(tx.reviewReason)}</div>` : '';
    return `
    <article class="gmail-tx-card ${typeClass}${isReview ? ' is-review' : ''}" data-idx="${idx}" data-source="${escapeHtml(tx.source)}">
        <input type="checkbox" class="gmail-tx-check" data-idx="${idx}" ${checked} ${disabled}>
        <div class="gmail-tx-body">
            <div class="gmail-tx-header">
                <span class="gmail-tx-source">${icon} ${escapeHtml(label)}</span>
                <span class="gmail-tx-badge gmail-badge-${tx.type}">${typeLabel}</span>
            </div>
            <div class="gmail-tx-desc">${escapeHtml(tx.description)}</div>
            <div class="gmail-tx-date">${escapeHtml(tx.date)}</div>
            ${reason}
        </div>
        ${renderCategoryControl(tx, idx)}
        <div class="gmail-tx-amount ${typeClass}-amount">${sign} ${fmtAmt(tx.amount, tx.currency)}</div>
    </article>`;
}

function getIgnoredSources() {
    return new Set(Array.isArray(gmailPreference?.ignoredSources) ? gmailPreference.ignoredSources : []);
}

function getSourceEntries() {
    const counts = new Map();
    pendingTxs.forEach((tx, index) => {
        if (tx.reviewOnly) return;
        const entry = counts.get(tx.source) || { source: tx.source, label: tx.sourceLabel || sourceLabel(tx.source), indexes: [] };
        entry.indexes.push(index);
        counts.set(tx.source, entry);
    });

    // Mantiene visibles las fuentes que el usuario excluyó para poder activarlas de nuevo.
    getIgnoredSources().forEach(source => {
        if (!counts.has(source)) counts.set(source, { source, label: sourceLabel(source), indexes: [] });
    });

    return [...counts.values()].sort((a, b) => a.label.localeCompare(b.label, 'es'));
}

function renderSourceControls() {
    const container = document.getElementById('gmail-source-controls');
    if (!container) return;
    const ignored = getIgnoredSources();
    const sources = getSourceEntries();

    if (!sources.length) {
        container.classList.add('hidden');
        container.innerHTML = '';
        return;
    }

    container.classList.remove('hidden');
    container.innerHTML = `
        <div class="gmail-source-heading">
            <div>
                <span class="gmail-results-kicker">Fuentes detectadas</span>
                <p>Elige de qué bancos o apps quieres importar movimientos.</p>
            </div>
        </div>
        <div class="gmail-source-options">
            ${sources.map(({ source, label, indexes }) => {
                const allSelected = indexes.length
                    ? indexes.every(index => selectedIds.has(index))
                    : !ignored.has(source);
                const countText = indexes.length === 1 ? '1 movimiento' : `${indexes.length} movimientos`;
                return `
                    <label class="gmail-source-option">
                        <input class="gmail-source-check" type="checkbox" data-source="${escapeHtml(source)}" ${allSelected ? 'checked' : ''}>
                        <span>${SOURCE_ICONS[source] || '💳'} ${escapeHtml(label)}</span>
                        <small>${indexes.length ? countText : 'Sin movimientos en este período'}</small>
                    </label>`;
            }).join('')}
        </div>
        <label class="gmail-remember-sources">
            <input id="gmail-remember-sources" type="checkbox" ${gmailPreference?.rememberSources ? 'checked' : ''}>
            <span>Recordar esta selección para próximos análisis</span>
        </label>`;
}

function syncSourceControls() {
    const ignored = getIgnoredSources();
    document.querySelectorAll('.gmail-source-check').forEach(check => {
        const source = check.dataset.source;
        const indexes = pendingTxs.flatMap((tx, index) => (
            !tx.reviewOnly && tx.source === source ? [index] : []
        ));
        if (!indexes.length) {
            check.checked = !ignored.has(source);
            check.indeterminate = false;
            return;
        }
        const selectedCount = indexes.filter(index => selectedIds.has(index)).length;
        check.checked = selectedCount === indexes.length;
        check.indeterminate = selectedCount > 0 && selectedCount < indexes.length;
    });
}

function applySourceSelection(source, include) {
    pendingTxs.forEach((tx, index) => {
        if (tx.reviewOnly || tx.source !== source) return;
        if (include) selectedIds.add(index); else selectedIds.delete(index);
    });
    document.querySelectorAll(`.gmail-tx-check`).forEach(check => {
        const index = Number.parseInt(check.dataset.idx, 10);
        if (pendingTxs[index]?.source === source && !check.disabled) check.checked = include;
    });
    syncSourceControls();
    updateImportBtn();
}

async function persistSourceChoices() {
    const remembered = getIgnoredSources();
    document.querySelectorAll('.gmail-source-check').forEach(check => {
        if (check.checked) remembered.delete(check.dataset.source);
        else remembered.add(check.dataset.source);
    });
    await saveGmailPref({ ignoredSources: [...remembered].sort(), rememberSources: true });
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
                <button id="gmail-btn-manage-entities" class="gmail-btn-sm" type="button">Entidades</button>
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
        <div id="gmail-state-results" class="gmail-state gmail-results-state hidden">
            <div class="gmail-results-toolbar">
                <div class="gmail-results-summary">
                    <span class="gmail-results-kicker">Movimientos encontrados</span>
                    <strong id="gmail-found-count" class="gmail-found-count"></strong>
                    <span id="gmail-selection-summary" class="gmail-selection-summary" aria-live="polite"></span>
                </div>
                <div class="gmail-select-btns">
                    <button id="gmail-select-all" class="gmail-btn-sm">Todos</button>
                    <button id="gmail-deselect-all" class="gmail-btn-sm">Ninguno</button>
                </div>
            </div>
            <section id="gmail-source-controls" class="gmail-source-controls hidden" aria-label="Elegir fuentes para importar"></section>
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

function getCustomEntities() {
    return Array.isArray(gmailPreference?.customEntities) ? gmailPreference.customEntities : [];
}

function normalizeEntitySender(value) {
    return String(value || '').trim().toLowerCase().replace(/^from:/, '');
}

function renderEntitiesList() {
    const list = document.getElementById('gmail-entities-list');
    if (!list) return;
    const entities = getCustomEntities();
    if (!entities.length) {
        list.innerHTML = '<p class="gmail-entities-empty">Aún no agregaste entidades manuales.</p>';
        return;
    }
    list.innerHTML = entities.map(entity => `
        <article class="gmail-entity-row" data-entity-id="${escapeHtml(entity.id)}">
            <label class="gmail-entity-active">
                <input type="checkbox" class="gmail-entity-toggle" data-entity-id="${escapeHtml(entity.id)}" ${entity.active !== false ? 'checked' : ''}>
                <span>${entity.active !== false ? 'Activa' : 'Pausada'}</span>
            </label>
            <div class="gmail-entity-info">
                <strong>${escapeHtml(entity.name)}</strong>
                <span>${escapeHtml(entity.sender)}</span>
                <small>${entity.defaultType === 'income' ? 'Ingreso' : entity.defaultType === 'expense' ? 'Gasto' : 'Detectar según correo'}${entity.defaultType !== 'income' ? ` · ${EXPENSE_CATEGORIES.find(([value]) => value === entity.defaultCategory)?.[1] || 'Necesario'}` : ''}</small>
            </div>
            <button type="button" class="gmail-entity-delete" data-entity-id="${escapeHtml(entity.id)}" aria-label="Eliminar ${escapeHtml(entity.name)}">Eliminar</button>
        </article>`).join('');
}

function buildEntitiesModal() {
    const existing = document.getElementById('modal-gmail-entities');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'modal-gmail-entities';
    modal.className = 'modal hidden';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'gmail-entities-title');
    modal.innerHTML = `
        <div class="modal-content gmail-entities-modal">
            <div class="modal-handle"></div>
            <div class="gmail-modal-header">
                <div>
                    <h3 id="gmail-entities-title">Entidades de Gmail</h3>
                    <p class="gmail-modal-sub">Agrega solo correos oficiales. Siempre verás los movimientos antes de importarlos.</p>
                </div>
                <button type="button" id="gmail-entities-close" class="gmail-close-btn" aria-label="Cerrar">×</button>
            </div>
            <form id="gmail-entity-form" class="gmail-entity-form">
                <input id="gmail-entity-name" type="text" maxlength="50" placeholder="Nombre de entidad: Caja Ejemplo" required>
                <input id="gmail-entity-sender" type="email" maxlength="120" placeholder="Correo oficial: alertas@entidad.pe" required>
                <div class="gmail-entity-form-grid">
                    <label>Tipo por defecto
                        <select id="gmail-entity-type">
                            <option value="auto">Detectar según el correo</option>
                            <option value="expense">Gasto</option>
                            <option value="income">Ingreso</option>
                        </select>
                    </label>
                    <label>Categoria de gasto
                        <select id="gmail-entity-category">
                            <option value="green">Fijo</option>
                            <option value="yellow" selected>Necesario</option>
                            <option value="red">Antojo</option>
                        </select>
                    </label>
                </div>
                <button type="submit" class="gmail-btn-primary">Agregar entidad</button>
            </form>
            <p id="gmail-entity-feedback" class="gmail-entity-feedback" aria-live="polite"></p>
            <div class="gmail-entities-list-header">
                <span class="gmail-results-kicker">Tus entidades</span>
                <span>Actívalas o páusalas cuando quieras.</span>
            </div>
            <div id="gmail-entities-list" class="gmail-entities-list"></div>
        </div>`;
    document.body.appendChild(modal);
    return modal;
}

function openEntitiesModal() {
    const modal = document.getElementById('modal-gmail-entities');
    if (!modal) return;
    renderEntitiesList();
    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
}

function closeEntitiesModal() {
    const modal = document.getElementById('modal-gmail-entities');
    if (modal) modal.classList.add('hidden');
    const importModal = document.getElementById('modal-gmail-import');
    if (importModal?.classList.contains('hidden')) document.body.style.overflow = '';
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
        document.getElementById('gmail-loading-msg').textContent = 'Iniciando conexión con Google…';

        // Garantizar que Google Identity Services esté cargado antes de pedir el token
        await initGmailService();

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
        const customEntities = gmailPreference?.customEntities || [];
        
        // Consultar transacciones registradas e IDs de Gmail guardados previamente en Firestore
        const { gmailIds: dbGmailIds, existingTxKeys } = await getImportedGmailIds(currentUid).catch(() => ({ gmailIds: new Set(), existingTxKeys: new Set() }));
        const allExistingIds = new Set([...importedGmailIds, ...dbGmailIds]);

        const rawMessages = await fetchTransactionEmails(daysBack, customEntities);

        document.getElementById('gmail-loading-msg').textContent = `Analizando ${rawMessages.length} email${rawMessages.length !== 1 ? 's' : ''}…`;

        const txs = parseAllEmails({
            rawMessages,
            decodeBody: decodeEmailBody,
            getSender: getEmailSender,
            getDate: getEmailDate,
            getSubject: getEmailSubject,
            existingIds: allExistingIds,
            existingTxKeys,
            customEntities,
        });

        showResults(txs);
    } catch (err) {
        handleError(err);
    }
}

function showResults(txs) {
    pendingTxs  = txs;
    const ignoredSources = getIgnoredSources();
    selectedIds = new Set(txs.flatMap((tx, i) => (
        tx.reviewOnly || ignoredSources.has(tx.source) ? [] : [i]
    )));

    const countEl  = document.getElementById('gmail-found-count');
    const listEl   = document.getElementById('gmail-tx-list');
    const importBtn = document.getElementById('gmail-btn-import');

    if (txs.length === 0) {
        if (countEl) countEl.textContent = 'No se encontraron movimientos nuevos.';
        const selectionEl = document.getElementById('gmail-selection-summary');
        if (selectionEl) selectionEl.textContent = '';
        if (listEl)  listEl.innerHTML = '<p class="gmail-empty">Todos los movimientos ya fueron importados o no hay emails bancarios en ese período.</p>';
        const sourceControls = document.getElementById('gmail-source-controls');
        if (sourceControls) { sourceControls.classList.add('hidden'); sourceControls.innerHTML = ''; }
        if (importBtn) importBtn.disabled = true;
        showState('results');
        return;
    }

    const importableCount = txs.filter(tx => !tx.reviewOnly).length;
    const reviewCount = txs.length - importableCount;
    if (countEl) {
        const importableText = importableCount > 0
            ? `${importableCount} movimiento${importableCount !== 1 ? 's' : ''} listo${importableCount !== 1 ? 's' : ''} para importar`
            : 'No hay movimientos en soles listos para importar';
        countEl.textContent = reviewCount > 0
            ? `${importableText} · ${reviewCount} para revisar`
            : importableText;
    }
    if (listEl)   listEl.innerHTML    = txs.map((tx, i) => renderTxCard(tx, i)).join('');
    renderSourceControls();
    updateImportBtn();
    showState('results');
}

function updateImportBtn() {
    const btn = document.getElementById('gmail-btn-import');
    if (!btn) return;
    const n = selectedIds.size;
    const selectedTotal = pendingTxs
        .filter((tx, index) => selectedIds.has(index) && !tx.reviewOnly)
        .reduce((sum, tx) => sum + (Number(tx.amount) || 0), 0);
    const selectionEl = document.getElementById('gmail-selection-summary');
    if (selectionEl) {
        selectionEl.textContent = n > 0
            ? `${n} seleccionado${n !== 1 ? 's' : ''} · ${fmtAmt(selectedTotal)}`
            : 'No has seleccionado movimientos';
    }
    btn.disabled    = n === 0;
    btn.textContent = n > 0 ? `Importar ${n} movimiento${n !== 1 ? 's' : ''}` : 'Selecciona al menos uno';
}

async function doImport() {
    showState('loading');
    document.getElementById('gmail-loading-msg').textContent = 'Guardando movimientos en tu cuenta…';

    const toImport = pendingTxs.filter((tx, i) => selectedIds.has(i) && !tx.reviewOnly);
    let ok = 0, fail = 0;

    for (const tx of toImport) {
        try {
            const now     = firebase.firestore.Timestamp.fromDate(new Date());
            const dateTs  = firebase.firestore.Timestamp.fromDate(new Date(`${tx.date}T12:00:00`));
            const payload = { amount: tx.amount, note: tx.description, date: dateTs, createdAt: now,
                              source: `gmail:${tx.source}`, gmailId: tx.gmailId };

            const docId = `gmail_${tx.gmailId}`;

            if (tx.type === 'income') {
                await saveIncome(currentUid, { ...payload, category: tx.category || 'otros' }, null, docId);
            } else {
                await saveExpense(currentUid, { ...payload, category: tx.category || 'yellow', method: 'otro' }, null, docId);
            }
            persistImportedId(tx.gmailId);
            ok++;
        } catch (e) { console.error('[gmailImport] Error al guardar:', e); fail++; }
    }

    // Refrescar el dashboard
    window.dispatchEvent(new CustomEvent('konteo:refresh'));

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
    const entitiesModal = document.getElementById('modal-gmail-entities');

    // Cerrar
    document.getElementById('gmail-modal-close')?.addEventListener('click', closeModal);
    modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });

    // Entidades manuales: se guardan en el perfil del usuario y se usan en la próxima búsqueda.
    document.getElementById('gmail-entities-close')?.addEventListener('click', closeEntitiesModal);
    entitiesModal?.addEventListener('click', e => { if (e.target === entitiesModal) closeEntitiesModal(); });
    document.getElementById('btn-gmail-entities')?.addEventListener('click', async () => {
        await getGmailPref();
        document.getElementById('modal-profile')?.classList.add('hidden');
        openEntitiesModal();
    });
    document.getElementById('gmail-btn-manage-entities')?.addEventListener('click', async () => {
        await getGmailPref();
        openEntitiesModal();
    });
    document.getElementById('gmail-entity-form')?.addEventListener('submit', async e => {
        e.preventDefault();
        const name = String(document.getElementById('gmail-entity-name')?.value || '').trim();
        const sender = normalizeEntitySender(document.getElementById('gmail-entity-sender')?.value);
        const defaultType = document.getElementById('gmail-entity-type')?.value || 'auto';
        const defaultCategory = document.getElementById('gmail-entity-category')?.value || 'yellow';
        const feedback = document.getElementById('gmail-entity-feedback');

        if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sender)) {
            if (feedback) feedback.textContent = 'Ingresa un nombre y un correo oficial válido.';
            return;
        }
        if (getCustomEntities().some(entity => entity.sender === sender)) {
            if (feedback) feedback.textContent = 'Ese correo ya está registrado.';
            return;
        }

        const entity = { id: `entity-${Date.now().toString(36)}`, name, sender, defaultType, defaultCategory, active: true };
        await saveGmailPref({ customEntities: [...getCustomEntities(), entity] });
        e.target.reset();
        if (document.getElementById('gmail-entity-category')) document.getElementById('gmail-entity-category').value = 'yellow';
        if (feedback) feedback.textContent = 'Entidad agregada. Se incluirá en la próxima búsqueda.';
        renderEntitiesList();
    });
    document.getElementById('gmail-entities-list')?.addEventListener('change', async e => {
        const toggle = e.target.closest('.gmail-entity-toggle');
        if (!toggle) return;
        const id = toggle.dataset.entityId;
        const customEntities = getCustomEntities().map(entity => (
            entity.id === id ? { ...entity, active: toggle.checked } : entity
        ));
        await saveGmailPref({ customEntities });
        renderEntitiesList();
    });
    document.getElementById('gmail-entities-list')?.addEventListener('click', async e => {
        const button = e.target.closest('.gmail-entity-delete');
        if (!button) return;
        const customEntities = getCustomEntities().filter(entity => entity.id !== button.dataset.entityId);
        await saveGmailPref({ customEntities });
        renderEntitiesList();
    });

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
        selectedIds = new Set(pendingTxs.flatMap((tx, i) => tx.reviewOnly ? [] : [i]));
        modal.querySelectorAll('.gmail-tx-check').forEach(cb => { if (!cb.disabled) cb.checked = true; });
        syncSourceControls();
        updateImportBtn();
    });
    document.getElementById('gmail-deselect-all')?.addEventListener('click', () => {
        selectedIds.clear();
        modal.querySelectorAll('.gmail-tx-check').forEach(cb => { if (!cb.disabled) cb.checked = false; });
        syncSourceControls();
        updateImportBtn();
    });
    document.getElementById('gmail-tx-list')?.addEventListener('change', e => {
        const categorySelect = e.target.closest('.gmail-tx-category');
        if (categorySelect) {
            const idx = Number.parseInt(categorySelect.dataset.idx, 10);
            if (pendingTxs[idx]?.type === 'expense') pendingTxs[idx].category = categorySelect.value;
            return;
        }
        const cb = e.target.closest('.gmail-tx-check');
        if (!cb) return;
        const idx = parseInt(cb.dataset.idx, 10);
        if (pendingTxs[idx]?.reviewOnly) return;
        if (cb.checked) selectedIds.add(idx); else selectedIds.delete(idx);
        syncSourceControls();
        updateImportBtn();
    });

    document.getElementById('gmail-source-controls')?.addEventListener('change', async e => {
        const sourceCheck = e.target.closest('.gmail-source-check');
        if (sourceCheck) {
            applySourceSelection(sourceCheck.dataset.source, sourceCheck.checked);
            if (document.getElementById('gmail-remember-sources')?.checked) await persistSourceChoices();
            return;
        }

        if (e.target.id === 'gmail-remember-sources') {
            if (e.target.checked) await persistSourceChoices();
            else await saveGmailPref({ ignoredSources: [], rememberSources: false });
        }
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
    buildEntitiesModal();
    wireListeners(pref);

    // Actualizar badge del header
    renderHeaderBadge(pref?.enabled ? pref.email : null);

    // Pre-cargar Google Identity Services en background
    initGmailService().catch(() => {});
}
