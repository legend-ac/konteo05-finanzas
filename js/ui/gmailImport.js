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
    KNOWN_GMAIL_ENTITIES,
} from '../services/gmailService.js';

import { parseAllEmails } from '../services/gmailParser.js';
import { db, firebase }   from '../firebase/config.js';
import { saveIncome, saveExpense, getImportedGmailIds, getWallets } from '../services/dbService.js';
import { isActiveWallet, resolveWalletAccount, gmailWalletAssignmentRules } from '../services/walletPolicy.js';
import { sourceIdentity } from '../services/entityIdentity.js';
import { businessDateToDate } from './helpers.js';
import { mountMascots, reactMascot, releaseMascots } from './mascot.js';
import { runLimited, withDeadline } from '../services/asyncControl.js';

// ─────────────────────────────────────────────
// ESTADO
// ─────────────────────────────────────────────
let currentUid        = null;
let pendingTxs        = [];
let selectedIds       = new Set();
let importedGmailIds  = new Set();
let gmailPreference   = null;
let walletOptions     = [];
let initializedUid    = null;
let initialization    = null;
let sourceWorkspaceBound = false;
let editingCustomEntityId = null;
window.addEventListener('konteo:wallets-changed', event => {
    if (event.detail?.uid !== currentUid) return;
    walletOptions = event.detail.wallets;
    renderSourcesWorkspace();
});

let isSearching       = false;  // guard: evita búsquedas paralelas por doble-click

// ─────────────────────────────────────────────
// FIRESTORE: preferencia del usuario
// ─────────────────────────────────────────────
async function getGmailPref() {
    try {
        const doc = await withDeadline(() => db.collection('users').doc(currentUid).get());
        gmailPreference = doc.exists ? (doc.data().gmailImport || null) : null;
        // This switch belonged to the retired import modal.  The source
        // workspace now owns the scope, so keeping it true would make a
        // legacy preference contradict the visible bank toggles.
        if (gmailPreference?.onlyConfiguredEntities === true) {
            gmailPreference = { ...gmailPreference, onlyConfiguredEntities: false };
            db.collection('users').doc(currentUid).set({
                gmailImport: {
                    ...gmailPreference,
                    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
                }
            }, { merge: true }).catch(error => {
                console.warn('[gmailImport] No se pudo migrar una preferencia antigua:', error);
            });
        }
        return gmailPreference;
    } catch {
        gmailPreference = null;
        return null;
    }
}

async function saveGmailPref(data) {
    const previous = gmailPreference;
    try {
        gmailPreference = { ...(gmailPreference || {}), ...data };
        await db.collection('users').doc(currentUid).set(
            { gmailImport: { ...gmailPreference, updatedAt: firebase.firestore.FieldValue.serverTimestamp() } },
            { merge: true }
        );
    } catch (e) {
        gmailPreference = previous;
        console.warn('[gmailImport] No se pudo guardar preferencia:', e);
        throw e;
    }
}

async function disconnectGmail() {
    revokeGmailToken();
    await saveGmailPref({ enabled: false, email: null });
    importedGmailIds.clear();
    try { sessionStorage.removeItem(`konteo_gmail_${currentUid}`); } catch {}
    try { sessionStorage.removeItem('konteo_gmail_imported'); } catch {}
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
// HELPERS UI
// ─────────────────────────────────────────────
const SOURCE_ICONS  = { yape:'💜', plin:'🔵', bcp:'🔴', interbank:'🟢', bbva:'🔵', scotiabank:'🔴', banbif:'🟡', nacion:'🔴', mibanco:'🟠', sip:'🔷', binance:'🟡', pagoefectivo:'🟨' };
const SOURCE_LABELS = { yape:'Yape', plin:'Plin', bcp:'BCP', interbank:'Interbank', bbva:'BBVA', scotiabank:'Scotiabank', banbif:'BanBif', nacion:'Banco de la Nación', mibanco:'MiBanco', sip:'SIP', binance:'Binance', pagoefectivo:'PagoEfectivo' };
// Legacy records may keep an old source key; the visible entity remains the bank.
SOURCE_ICONS['plin-bbva'] = '\u{1F537}';
SOURCE_ICONS['plin-interbank'] = '\u{1F7E6}';
SOURCE_LABELS['plin-bbva'] = 'BBVA';
SOURCE_LABELS['plin-interbank'] = 'Interbank';

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

function walletOptionsHtml(selected = '', includeEmpty = true) {
    const empty = includeEmpty ? '<option value="">Sin asignar por ahora</option>' : '';
    return empty + walletOptions
        .filter(isActiveWallet)
        .map(wallet => `<option value="${escapeHtml(wallet.id)}" ${wallet.id === selected ? 'selected' : ''}>${escapeHtml(wallet.institution ? `${wallet.institution} · ${wallet.name}` : wallet.name)}</option>`)
        .join('');
}

function renderAccountControl(tx, idx) {
    if (tx.reviewOnly || !walletOptions.some(isActiveWallet)) return '';
    const accountId = resolveWalletAccount(tx, walletOptions, getWalletAssignmentRules());
    return `<label class="gmail-account-control" for="gmail-account-${idx}"><span>Billetera</span><select id="gmail-account-${idx}" class="gmail-tx-account" data-idx="${idx}" aria-label="Billetera para este movimiento">${walletOptionsHtml(accountId)}</select></label>`;
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
    const reason    = (isReview || tx.possibleDuplicate) && tx.reviewReason ? `<div class="gmail-tx-reason">${escapeHtml(tx.reviewReason)}</div>` : '';
    const controls  = `${renderCategoryControl(tx, idx)}${renderAccountControl(tx, idx)}`;
    const protection = isReview ? '<div class="gmail-review-protection">No se importará hasta que indiques qué representa.</div>' : '';
    const reviewActions = isReview ? `
        <div class="gmail-review-actions" aria-label="Clasificar movimiento pendiente">
            <span>Solo si no es una transferencia entre tus propias cuentas:</span>
            <button type="button" class="gmail-review-choice gmail-review-income" data-review-classification="income" data-idx="${idx}">Clasificar como ingreso</button>
            <button type="button" class="gmail-review-choice gmail-review-expense" data-review-classification="expense" data-idx="${idx}">Clasificar como gasto</button>
        </div>` : '';
    return `
    <article class="gmail-tx-card ${typeClass}${isReview ? ' is-review' : ''}" data-idx="${idx}" data-source="${escapeHtml(tx.source)}">
        <input type="checkbox" class="gmail-tx-check" data-idx="${idx}" ${checked} ${disabled}>
        <div class="gmail-tx-body">
            <div class="gmail-tx-header">
                <span class="gmail-tx-source">${icon} ${escapeHtml(label)}</span>
                <span class="gmail-tx-badge gmail-badge-${tx.type}">${typeLabel}</span>
            </div>
            <div class="gmail-tx-desc">${escapeHtml(tx.description)}</div>
            <div class="gmail-tx-meta">
                <span class="gmail-tx-date">${escapeHtml(tx.date)}</span>
                ${controls}
            </div>
            ${reason}
            ${protection}
            ${reviewActions}
        </div>
        <div class="gmail-tx-amount ${typeClass}-amount">${sign} ${fmtAmt(tx.amount, tx.currency)}</div>
    </article>`;
}

/* Legacy source-selection controls lived inside the import modal. Kept out
   of runtime while older deployments finish migrating to source settings. */
/*
function getIgnoredSources() {
    return new Set(Array.isArray(gmailPreference?.ignoredSources) ? gmailPreference.ignoredSources : []);
}

function getSourceEntries() {
    const counts = new Map();
    pendingTxs.forEach((tx, index) => {
        if (tx.reviewOnly) return;
        const entry = counts.get(tx.source) || { source: tx.source, label: sourceLabel(tx.source), indexes: [] };
        entry.indexes.push(index);
        counts.set(tx.source, entry);
    });
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
                <span class="gmail-results-kicker">Movimientos listos · Fuentes detectadas</span>
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
            <span>Preseleccionar estas fuentes para importar</span>
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
    document.querySelectorAll('.gmail-tx-check').forEach(check => {
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
*/
function buildModal() {
    const old = document.getElementById('modal-gmail-import');
    if (old) { releaseMascots(old); old.remove(); }
    const el = document.createElement('div');
    el.id        = 'modal-gmail-import';
    el.className = 'modal hidden';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-labelledby', 'gmail-modal-title');
    el.innerHTML = `
    <div class="modal-content gmail-modal-content">
        <div class="modal-handle"></div>
        <div class="gmail-modal-header">
            <div>
                <h3 id="gmail-modal-title">Centro de revisión Gmail</h3>
                <p class="gmail-modal-sub" id="gmail-modal-sub">Revisa notificaciones financieras y decide qué movimientos registrar.</p>
            </div>
            <button id="gmail-modal-close" class="gmail-close-btn" aria-label="Cerrar">✕</button>
        </div>
        <div id="gmail-state-consent" class="gmail-state">
            <div class="gmail-consent-box">
                <details class="companion-help import-companion">
                    <summary><span class="mascot-scene" data-mascot="review"><img src="/images/konteo-guide-gmail.jpg" width="88" height="88" alt=""></span><span><strong>Tú revisas, tú decides</strong><span class="companion-link">¿Qué se guarda desde Gmail?</span></span></summary>
                    <p>Primero verás los movimientos detectados. Revisa monto, tipo y cuenta antes de seleccionarlos. Solo se guardan los que confirmas al importar; si falta información, debes revisarla antes.</p>
                </details>
                <h4>Configura primero tus fuentes de correo</h4>
                <p>Conecta Gmail y elige las entidades que deseas leer desde Fuentes Gmail. La importacion queda solo para revisar y confirmar operaciones.</p>
                <div class="gmail-consent-features">
                    <div class="gmail-cf-item">Solo lectura: nunca envía ni borra correos.</div>
                    <div class="gmail-cf-item">Tú decides qué importar antes de guardar.</div>
                    <div class="gmail-cf-item">Puedes desconectar en cualquier momento.</div>
                    <div class="gmail-cf-item">El token no se almacena en nuestros servidores.</div>
                </div>
                <div class="gmail-consent-sources">
                    <span>Yape</span><span>Plin</span><span>BCP</span>
                    <span>Interbank</span><span>BBVA</span><span>Scotiabank</span>
                </div>
                <div class="gmail-days-row" style="justify-content:center;margin-top:8px" hidden>
                    <label for="gmail-days-select">Período a revisar:</label>
                    <select id="gmail-days-select">
                        <option value="7">7 días</option>
                        <option value="30" selected>30 días</option>
                        <option value="60">60 días</option>
                        <option value="90">90 días</option>
                    </select>
                </div>
            </div>
            <div class="gmail-consent-actions">
                <button id="gmail-btn-go-sources" class="gmail-btn-primary">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                        <path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4-8 5-8-5V6l8 5 8-5v2z"/>
                    </svg>
                    Abrir Fuentes Gmail
                </button>
            </div>
        </div>
        <div id="gmail-state-connected" class="gmail-state hidden">
            <div class="gmail-connected-box">
                <span class="gmail-connected-kicker">Cuenta conectada</span>
                <div class="gmail-connected-email" id="gmail-connected-email-label">
                    <span class="gmail-dot"></span>
                    <span id="gmail-email-display">Cargando…</span>
                </div>
                <div class="gmail-days-row" style="margin-top:12px">
                    <label for="gmail-days-select2">Período a revisar:</label>
                    <select id="gmail-days-select2">
                        <option value="7">7 días</option>
                        <option value="30" selected>30 días</option>
                        <option value="60">60 días</option>
                        <option value="90">90 días</option>
                    </select>
                </div>
            </div>
            <div class="gmail-consent-actions">
                <button id="gmail-btn-sync" class="gmail-btn-primary">Revisar correos</button>
            </div>
        </div>
        <div id="gmail-state-loading" class="gmail-state hidden">
            <div class="gmail-spinner-wrap">
                <div class="gmail-spinner"></div>
                <p id="gmail-loading-msg">Conectando con Gmail…</p>
            </div>
        </div>
        <div id="gmail-state-results" class="gmail-state gmail-results-state hidden">
            <div class="gmail-results-toolbar">
                <div class="gmail-results-summary">
                    <span class="gmail-results-kicker">Movimientos encontrados</span>
                    <strong id="gmail-found-count" class="gmail-found-count"></strong>
                    <span id="gmail-selection-summary" class="gmail-selection-summary" aria-live="polite"></span>
                    <span id="gmail-review-summary" class="gmail-review-summary" aria-live="polite"></span>
                </div>
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
        <div id="gmail-state-success" class="gmail-state hidden">
            <div class="gmail-success-wrap">
                <span class="mascot-scene" data-mascot="confirmed"><img src="/images/konteo-guide-gmail.jpg" width="112" height="112" alt=""></span>
                <h4 id="gmail-success-title">¡Listo!</h4>
                <p id="gmail-success-msg"></p>
                <button id="gmail-btn-done" class="gmail-btn-primary" style="align-self:center;width:auto;padding:0 32px">Ver movimientos</button>
            </div>
        </div>
        <div id="gmail-state-error" class="gmail-state hidden">
            <div class="gmail-error-wrap">
                <div class="gmail-error-icon" aria-hidden="true">!</div>
                <p id="gmail-error-msg"></p>
                <div class="gmail-consent-actions" style="margin-top:4px">
                    <button id="gmail-btn-retry" class="gmail-btn-secondary">Reintentar</button>
                    <button id="gmail-btn-err-close" class="gmail-btn-primary">Cerrar</button>
                </div>
            </div>
        </div>
    </div>`;
    document.body.appendChild(el);
    mountMascots(el);
    return el;
}

function getCustomEntities() {
    return Array.isArray(gmailPreference?.customEntities) ? gmailPreference.customEntities : [];
}

function getActiveCustomEntities() {
    return getCustomEntities().filter(entity => entity?.active !== false);
}

function getWalletAssignmentRules() {
    return gmailWalletAssignmentRules({
        customEntities: getCustomEntities(),
        knownEntitySettings: gmailPreference?.knownEntitySettings || {}
    });
}

/* Legacy modal-based entity management. Settings now live in the workspace. */
/*
function isRestrictedToConfiguredEntities() {
    return gmailPreference?.onlyConfiguredEntities === true;
}

function renderReadingRule() {
    const checkbox = document.getElementById('gmail-only-configured-entities');
    const summary = document.getElementById('gmail-reading-rule-summary');
    if (!checkbox || !summary) return;
    const active = getActiveCustomEntities();
    checkbox.disabled = active.length === 0 && !isRestrictedToConfiguredEntities();
    checkbox.checked = isRestrictedToConfiguredEntities();
    summary.textContent = active.length
        ? `${active.length} remitente${active.length !== 1 ? 's' : ''} activo${active.length !== 1 ? 's' : ''}: ${active.map(entity => entity.name).join(', ')}`
        : 'Aún no configuraste remitentes propios; se usarán las fuentes reconocidas.';
}

function normalizeEntitySender(value) {
    return String(value || '').trim().toLowerCase().replace(/^from:/, '');
}

function renderEntitiesList() {
    const list = document.getElementById('gmail-entities-list');
    if (!list) return;
    const entities = getCustomEntities();
    if (!entities.length) {
        list.innerHTML = '<p class="gmail-entities-empty">Aún no agregaste remitentes propios. Las fuentes reconocidas seguirán disponibles al revisar correos.</p>';
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
                <small>${entity.defaultType === 'income' ? 'Ingreso' : entity.defaultType === 'expense' ? 'Gasto' : 'Detectar según correo'}${entity.defaultType !== 'income' ? ` · ${EXPENSE_CATEGORIES.find(([value]) => value === entity.defaultCategory)?.[1] || 'Necesario'}` : ''}${entity.defaultAccountId ? ` · ${escapeHtml(walletOptions.find(wallet => wallet.id === entity.defaultAccountId)?.name || 'Billetera asignada')}` : ''}</small>
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
                    <h3 id="gmail-entities-title">Remitentes de Gmail</h3>
                    <p class="gmail-modal-sub">Agrega correos oficiales que quieras revisar y asígnalos a una billetera si corresponde.</p>
                </div>
                <button type="button" id="gmail-entities-close" class="gmail-close-btn" aria-label="Cerrar">×</button>
            </div>
            <form id="gmail-entity-form" class="gmail-entity-form">
                <input id="gmail-entity-name" type="text" maxlength="50" placeholder="Nombre visible: Caja Ejemplo" required>
                <input id="gmail-entity-sender" type="email" maxlength="120" placeholder="Correo del remitente: alertas@entidad.pe" required>
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
                <label>Destino predeterminado
                    <select id="gmail-entity-account">${walletOptionsHtml('', true)}</select>
                </label>
                <button type="submit" class="gmail-btn-primary">Agregar remitente</button>
            </form>
            <p id="gmail-entity-feedback" class="gmail-entity-feedback" aria-live="polite"></p>
            <div class="gmail-entities-list-header">
                <span class="gmail-results-kicker">Tus remitentes</span>
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

// The source workspace owns configuration. The import modal only reviews
// individual operations; it never asks people to decide their Gmail scope.
*/
function normalizeEntitySender(value) {
    return String(value || '').trim().toLowerCase().replace(/^from:/, '');
}

function getKnownEntitySettings() {
    const stored = gmailPreference?.knownEntitySettings || {};
    const legacyIgnored = new Set(Array.isArray(gmailPreference?.ignoredSources) ? gmailPreference.ignoredSources : []);
    const aliases = { 'plin-bbva': 'bbva', 'plin-interbank': 'interbank' };
    return KNOWN_GMAIL_ENTITIES.map(entity => {
        const saved = stored[entity.id] || {};
        const legacyIgnoredForEntity = legacyIgnored.has(entity.id) || [...legacyIgnored].some(source => (
            (aliases[source] || source) === entity.id
        ));
        return {
            ...entity,
            active: saved.active !== false && !legacyIgnoredForEntity,
            defaultAccountId: String(saved.defaultAccountId || '')
        };
    });
}

function getEnabledKnownEntityIds() {
    return getKnownEntitySettings().filter(entity => entity.active).map(entity => entity.id);
}

function knownEntityKeyForTransaction(tx) {
    const source = String(tx?.source || '').replace(/^gmail:/, '').toLowerCase();
    const direct = {
        'plin-bbva': 'bbva', 'plin-interbank': 'interbank',
        ligo: 'bcp', izipay: 'wallets', tunki: 'wallets', bim: 'wallets',
        mercadopago: 'wallets', maximo: 'wallets', wise: 'international',
        payoneer: 'international', falabella: 'cards', ripley: 'cards',
        oh: 'cards', nu: 'cards', b89: 'digital', kambista: 'digital', uala: 'digital'
    };
    if (direct[source]) return direct[source];
    if (KNOWN_GMAIL_ENTITIES.some(entity => entity.id === source)) return source;
    if (source.startsWith('caja')) return 'cajas';
    return '';
}

function isTransactionFromEnabledKnownEntity(tx) {
    const enabled = new Set(getEnabledKnownEntityIds());
    // The issuer is determined from the sender and voucher signature, never
    // from a recipient or destination shown inside the receipt. This keeps an
    // Interbank Plin payment to BBVA under Interbank, for example.
    const identity = sourceIdentity(tx, getWalletAssignmentRules());
    if (identity.bank && KNOWN_GMAIL_ENTITIES.some(entity => entity.id === identity.bank)) {
        return enabled.has(identity.bank);
    }
    const direct = knownEntityKeyForTransaction(tx);
    if (direct) return enabled.has(direct);
    return true;
}

function knownAccountOptionsHtml(selected = '') {
    return walletOptionsHtml(selected, true);
}

function sourceWorkspaceFeedback(message = '', state = '') {
    const target = document.getElementById('gmail-sources-feedback');
    if (!target) return;
    target.textContent = message;
    target.hidden = !message;
    if (state) target.dataset.state = state;
    else delete target.dataset.state;
}

function customEntityRowsHtml() {
    const entities = getCustomEntities();
    if (!entities.length) {
        return '<p class="gmail-entities-empty">Aun no agregaste remitentes propios. Puedes hacerlo cuando una entidad no aparezca en la lista reconocida.</p>';
    }
    return entities.map(entity => `
        <article class="gmail-entity-row" data-entity-id="${escapeHtml(entity.id)}">
            <label class="gmail-entity-active">
                <input type="checkbox" class="gmail-source-custom-toggle" data-entity-id="${escapeHtml(entity.id)}" ${entity.active !== false ? 'checked' : ''}>
                <span>${entity.active !== false ? 'Activa' : 'Pausada'}</span>
            </label>
            <div class="gmail-entity-info">
                <strong>${escapeHtml(entity.name)}</strong>
                <span>${escapeHtml(entity.sender)}</span>
                <small>${entity.defaultType === 'income' ? 'Ingreso' : entity.defaultType === 'expense' ? 'Gasto' : 'Detectar segun el correo'}${entity.defaultAccountId ? ` · ${escapeHtml(walletOptions.find(wallet => wallet.id === entity.defaultAccountId)?.name || 'Cuenta asignada')}` : ''}</small>
            </div>
            <div class="gmail-entity-row-actions">
                <button type="button" class="gmail-entity-edit" data-entity-id="${escapeHtml(entity.id)}">Editar</button>
                <button type="button" class="gmail-entity-delete" data-entity-id="${escapeHtml(entity.id)}">Eliminar</button>
            </div>
        </article>`).join('');
}

function renderSourcesWorkspace() {
    const host = document.getElementById('gmail-sources-workspace');
    if (!host) return;
    const connected = Boolean(gmailPreference?.enabled && gmailPreference?.email);
    const knownEntities = getKnownEntitySettings();
    const activeCount = knownEntities.filter(entity => entity.active).length;
    const editing = getCustomEntities().find(entity => entity.id === editingCustomEntityId) || null;
    if (!editing) editingCustomEntityId = null;
    host.innerHTML = `
        <div class="gmail-sources-layout">
            <section class="gmail-source-card">
                <div class="gmail-source-card-heading">
                    <div><h2>Conexion</h2><p>La autorizacion se usa solo para revisar correos financieros.</p></div>
                </div>
                <div class="gmail-source-connection${connected ? ' is-connected' : ''}">
                    <div class="gmail-source-connection-head"><span aria-hidden="true"></span><strong>${connected ? escapeHtml(gmailPreference.email) : 'Gmail no conectado'}</strong></div>
                    <small>${connected ? 'Puedes revisar operaciones cuando quieras; ningun movimiento se guarda sin confirmacion.' : 'Conecta Gmail antes de revisar operaciones.'}</small>
                    <div class="gmail-source-actions">
                        <button type="button" class="gmail-btn-primary" data-gmail-source-action="connect">${connected ? 'Reconectar Gmail' : 'Conectar Gmail'}</button>
                        ${connected ? '<button type="button" class="gmail-btn-secondary" data-gmail-source-action="disconnect">Desconectar</button>' : ''}
                    </div>
                </div>
                <p id="gmail-sources-feedback" class="gmail-entity-feedback" aria-live="polite" hidden></p>
            </section>
            <section class="gmail-source-card">
                <div class="gmail-source-card-heading">
                    <div><h2>Fuentes reconocidas</h2><p>${activeCount} de ${knownEntities.length} activas. BBVA e Interbank se mantienen separados aunque sus comprobantes usen Plin.</p></div>
                </div>
                <div class="gmail-known-sources-list">
                    ${knownEntities.map(entity => `
                        <label class="gmail-source-setting" data-known-entity="${escapeHtml(entity.id)}">
                            <input class="gmail-known-entity-toggle" type="checkbox" data-entity-id="${escapeHtml(entity.id)}" ${entity.active ? 'checked' : ''}>
                            <span><strong>${escapeHtml(entity.name)}</strong><small>${escapeHtml(entity.detail)}</small></span>
                            <select class="gmail-known-entity-account" data-entity-id="${escapeHtml(entity.id)}" aria-label="Cuenta predeterminada para ${escapeHtml(entity.name)}" ${entity.active ? '' : 'disabled'}>${knownAccountOptionsHtml(entity.defaultAccountId)}</select>
                        </label>`).join('')}
                </div>
            </section>
        </div>
        <section class="gmail-source-card gmail-source-card--wide">
            <div class="gmail-source-card-heading">
                <div><h2>Remitentes propios</h2><p>Agrega solo correos oficiales que no esten cubiertos arriba. Puedes editar el nombre, el tipo, el destino o pausarlos sin borrar la regla.</p></div>
            </div>
            <form id="gmail-source-entity-form" class="gmail-entity-form">
                <input id="gmail-source-entity-name" type="text" maxlength="50" placeholder="Nombre visible: Caja Ejemplo" value="${escapeHtml(editing?.name || '')}" required>
                <input id="gmail-source-entity-sender" type="email" maxlength="120" placeholder="Correo del remitente: alertas@entidad.pe" value="${escapeHtml(editing?.sender || '')}" required>
                <div class="gmail-entity-form-grid">
                    <label>Tipo por defecto<select id="gmail-source-entity-type"><option value="auto" ${(!editing || editing.defaultType === 'auto') ? 'selected' : ''}>Detectar segun el correo</option><option value="expense" ${editing?.defaultType === 'expense' ? 'selected' : ''}>Gasto</option><option value="income" ${editing?.defaultType === 'income' ? 'selected' : ''}>Ingreso</option></select></label>
                    <label>Categoria de gasto<select id="gmail-source-entity-category"><option value="green" ${editing?.defaultCategory === 'green' ? 'selected' : ''}>Fijo</option><option value="yellow" ${(!editing || editing.defaultCategory === 'yellow') ? 'selected' : ''}>Necesario</option><option value="red" ${editing?.defaultCategory === 'red' ? 'selected' : ''}>Antojo</option></select></label>
                </div>
                <label>Destino predeterminado<select id="gmail-source-entity-account">${knownAccountOptionsHtml(editing?.defaultAccountId || '')}</select></label>
                <div class="gmail-entity-form-actions">
                    ${editing ? '<button type="button" class="gmail-btn-secondary" data-gmail-source-action="cancel-edit">Cancelar edicion</button>' : ''}
                    <button type="submit" class="gmail-btn-primary">${editing ? 'Guardar cambios' : 'Agregar remitente'}</button>
                </div>
            </form>
            <div class="gmail-entities-list-header"><span class="gmail-results-kicker">Tus remitentes</span><span>Activa o pausa cada uno sin afectar las entidades reconocidas.</span></div>
            <div id="gmail-sources-custom-list" class="gmail-entities-list">${customEntityRowsHtml()}</div>
        </section>`;
    bindSourcesWorkspace(host);
}

function bindSourcesWorkspace(host) {
    if (sourceWorkspaceBound || !host) return;
    sourceWorkspaceBound = true;
    host.addEventListener('change', async event => {
        const knownToggle = event.target.closest('.gmail-known-entity-toggle');
        const knownAccount = event.target.closest('.gmail-known-entity-account');
        const customToggle = event.target.closest('.gmail-source-custom-toggle');
        try {
            if (knownToggle || knownAccount) {
                const id = (knownToggle || knownAccount).dataset.entityId;
                // Persist the complete effective state on the first edit so
                // older ignoredSources preferences migrate without silently
                // reactivating a bank the person had paused.
                const settings = Object.fromEntries(getKnownEntitySettings().map(entity => [entity.id, {
                    active: entity.active,
                    defaultAccountId: entity.defaultAccountId
                }]));
                settings[id] = {
                    ...(settings[id] || {}),
                    ...(knownToggle ? { active: knownToggle.checked } : {}),
                    ...(knownAccount ? { defaultAccountId: knownAccount.value } : {})
                };
                await saveGmailPref({ knownEntitySettings: settings, ignoredSources: [], rememberSources: false, onlyConfiguredEntities: false });
                renderSourcesWorkspace();
                sourceWorkspaceFeedback('Configuracion guardada.', 'success');
                return;
            }
            if (customToggle) {
                const entities = getCustomEntities().map(entity => entity.id === customToggle.dataset.entityId
                    ? { ...entity, active: customToggle.checked } : entity);
                await saveGmailPref({ customEntities: entities });
                renderSourcesWorkspace();
                sourceWorkspaceFeedback('Remitente actualizado.', 'success');
            }
        } catch (error) {
            console.warn('gmail source setting error:', error);
            sourceWorkspaceFeedback('No se pudo guardar el cambio. Revisa tu conexion e intentalo de nuevo.', 'error');
        }
    });
    host.addEventListener('click', async event => {
        const action = event.target.closest('[data-gmail-source-action]')?.dataset.gmailSourceAction;
        const edit = event.target.closest('.gmail-entity-edit');
        const remove = event.target.closest('.gmail-entity-delete');
        try {
            if (action === 'connect') {
                sourceWorkspaceFeedback('Abriendo autorizacion de Google...', 'progress');
                await initGmailService();
                await requestGmailToken();
                const email = getConnectedEmail();
                await saveGmailPref({ enabled: true, email });
                renderSourcesWorkspace();
                sourceWorkspaceFeedback('Gmail conectado. Ya puedes revisar operaciones.', 'success');
                return;
            }
            if (action === 'disconnect') {
                await disconnectGmail();
                renderSourcesWorkspace();
                sourceWorkspaceFeedback('Gmail se desconecto de este dispositivo.', 'success');
                return;
            }
            if (action === 'cancel-edit') {
                editingCustomEntityId = null;
                renderSourcesWorkspace();
                return;
            }
            if (edit) {
                editingCustomEntityId = edit.dataset.entityId;
                renderSourcesWorkspace();
                document.getElementById('gmail-source-entity-name')?.focus();
                return;
            }
            if (remove) {
                const entity = getCustomEntities().find(item => item.id === remove.dataset.entityId);
                if (!entity || !window.confirm(`Eliminar ${entity.name}? Ya no se buscara ese remitente.`)) return;
                await saveGmailPref({ customEntities: getCustomEntities().filter(item => item.id !== entity.id) });
                if (editingCustomEntityId === entity.id) editingCustomEntityId = null;
                renderSourcesWorkspace();
                sourceWorkspaceFeedback('Remitente eliminado.', 'success');
            }
        } catch (error) {
            console.warn('gmail source action error:', error);
            sourceWorkspaceFeedback(error.message || 'No se pudo completar la accion.', 'error');
        }
    });
    host.addEventListener('submit', async event => {
        const form = event.target.closest('#gmail-source-entity-form');
        if (!form) return;
        event.preventDefault();
        const name = String(document.getElementById('gmail-source-entity-name')?.value || '').trim();
        const sender = normalizeEntitySender(document.getElementById('gmail-source-entity-sender')?.value);
        if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sender)) {
            sourceWorkspaceFeedback('Ingresa un nombre y un correo oficial valido.', 'error');
            return;
        }
        const duplicate = getCustomEntities().find(entity => entity.sender === sender && entity.id !== editingCustomEntityId);
        if (duplicate) {
            sourceWorkspaceFeedback('Ese correo ya esta registrado en tus remitentes.', 'error');
            return;
        }
        const previousEntity = getCustomEntities().find(entity => entity.id === editingCustomEntityId);
        const payload = {
            name, sender,
            defaultType: document.getElementById('gmail-source-entity-type')?.value || 'auto',
            defaultCategory: document.getElementById('gmail-source-entity-category')?.value || 'yellow',
            defaultAccountId: document.getElementById('gmail-source-entity-account')?.value || '',
            active: previousEntity?.active !== false
        };
        try {
            const entities = editingCustomEntityId
                ? getCustomEntities().map(entity => entity.id === editingCustomEntityId ? { ...entity, ...payload } : entity)
                : [...getCustomEntities(), { id: `entity-${Date.now().toString(36)}`, ...payload }];
            await saveGmailPref({ customEntities: entities });
            const wasEditing = Boolean(editingCustomEntityId);
            editingCustomEntityId = null;
            renderSourcesWorkspace();
            sourceWorkspaceFeedback(wasEditing ? 'Remitente actualizado.' : 'Remitente agregado. Se incluira en la proxima revision.', 'success');
        } catch (error) {
            console.warn('gmail custom entity error:', error);
            sourceWorkspaceFeedback('No se pudo guardar el remitente. Intentalo de nuevo.', 'error');
        }
    });
}

// ─────────────────────────────────────────────
// NAVEGACIÓN DE ESTADOS
// ─────────────────────────────────────────────
function showState(name) {
    ['consent','connected','loading','results','success','error'].forEach(s => {
        const el = document.getElementById(`gmail-state-${s}`);
        if (el) el.classList.toggle('hidden', s !== name);
    });
    if (name === 'success') reactMascot(document.getElementById('gmail-state-success'));
}

function openModal()  {
    const m = document.getElementById('modal-gmail-import');
    if (m) { m.classList.remove('hidden'); document.body.style.overflow = 'hidden'; }
}
function closeModal() {
    const m = document.getElementById('modal-gmail-import');
    if (m?.dataset.saving === 'true') return;
    if (m) { m.classList.add('hidden'); document.body.style.overflow = ''; }
}

// ─────────────────────────────────────────────
// FLUJO: conectar y buscar
// ─────────────────────────────────────────────
async function connectAndSearch(daysBack) {
    if (isSearching) return;
    isSearching = true;
    const btnConnect = document.getElementById('gmail-btn-connect');
    const btnSync    = document.getElementById('gmail-btn-sync');
    if (btnConnect) btnConnect.disabled = true;
    if (btnSync)    btnSync.disabled    = true;
    showState('loading');
    try {
        document.getElementById('gmail-loading-msg').textContent = 'Iniciando conexión con Google…';
        await initGmailService();
        document.getElementById('gmail-loading-msg').textContent = 'Esperando autorización de Google…';
        await requestGmailToken();
        const connectedEmail = getConnectedEmail();
        await saveGmailPref({ enabled: true, email: connectedEmail });
        await doSearch(daysBack);
    } catch (err) {
        handleError(err);
    } finally {
        isSearching = false;
        if (btnConnect) btnConnect.disabled = false;
        if (btnSync)    btnSync.disabled    = false;
    }
}

async function doSearch(daysBack) {
    // Si se llama directamente (ej. desde btn-sync), aplicar guard también
    if (!isSearching) {
        isSearching = true;
        const btnSync = document.getElementById('gmail-btn-sync');
        if (btnSync) btnSync.disabled = true;
    }
    try {
        document.getElementById('gmail-loading-msg').textContent = `Buscando emails de los últimos ${daysBack} días…`;
        const customEntities = getActiveCustomEntities();

        const { gmailIds: dbGmailIds, existingTxKeys } = await withDeadline(() => getImportedGmailIds(currentUid));

        // Si Firestore está vacío (usuario limpió su cuenta), limpiar también el caché local
        if (dbGmailIds.size === 0 && existingTxKeys.size === 0 && importedGmailIds.size > 0) {
            console.info('[gmailImport] Firestore vacío — limpiando caché local para permitir reimportación completa');
            importedGmailIds = new Set();
            try { sessionStorage.removeItem(`konteo_gmail_${currentUid}`); } catch {}
        }

        // allExistingIds se usa en parseAllEmails para deduplicación visual en pantalla.
        const allExistingIds = new Set([...importedGmailIds, ...dbGmailIds]);

        // BUG 7 FIX: fetchTransactionEmails solo excluye dbGmailIds (lo ya guardado en Firestore).
        // Así, emails vistos pero no importados en sesión anterior reaparecen al ampliar el período.
        const rawMessages = await fetchTransactionEmails(daysBack, customEntities, {
            enabledKnownEntityIds: getEnabledKnownEntityIds(), existingIds: dbGmailIds
        });

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

        showResults(txs.filter(isTransactionFromEnabledKnownEntity));
    } catch (err) {
        handleError(err);
    } finally {
        isSearching = false;
        const btnSync = document.getElementById('gmail-btn-sync');
        if (btnSync) btnSync.disabled = false;
    }
}

function updateResultsSummary() {
    const countEl = document.getElementById('gmail-found-count');
    const reviewEl = document.getElementById('gmail-review-summary');
    const importableCount = pendingTxs.filter(tx => !tx.reviewOnly).length;
    const reviewCount = pendingTxs.length - importableCount;
    if (reviewEl) {
        reviewEl.textContent = reviewCount > 0
            ? `${reviewCount} pendiente${reviewCount === 1 ? '' : 's'}: clasifica o déjalo sin importar.`
            : 'Todo está clasificado. Revisa los detalles antes de confirmar.';
    }
    if (!countEl) return;
    const importableText = importableCount > 0
        ? `${importableCount} movimiento${importableCount !== 1 ? '' : 's'} listo${importableCount !== 1 ? '' : 's'} para importar`
        : 'No hay movimientos listos para importar';
    countEl.textContent = reviewCount > 0
        ? `${importableText} · ${reviewCount} necesita${reviewCount === 1 ? '' : 'n'} una decisión`
        : importableText;
}

function renderTransactionResults() {
    const listEl = document.getElementById('gmail-tx-list');
    if (!listEl) return;
    const ready = pendingTxs.flatMap((tx, index) => tx.reviewOnly ? [] : [{ tx, index }]);
    const review = pendingTxs.flatMap((tx, index) => tx.reviewOnly ? [{ tx, index }] : []);
    const readyCards = ready.map(({ tx, index }) => renderTxCard(tx, index)).join('');
    const reviewCards = review.map(({ tx, index }) => renderTxCard(tx, index)).join('');
    listEl.innerHTML = `
        ${ready.length ? `<div class="gmail-list-section-heading"><span>Listos para importar</span><small>${ready.length} clasificado${ready.length === 1 ? '' : 's'} y disponible${ready.length === 1 ? '' : 's'} para confirmar.</small></div>${readyCards}` : ''}
        ${review.length ? `<details class="gmail-review-queue">
            <summary><span>Decisiones pendientes</span><small>${review.length} movimiento${review.length === 1 ? '' : 's'} necesita${review.length === 1 ? '' : 'n'} tu criterio</small></summary>
            <p>Los dejamos fuera porque el correo no confirma si es ingreso, gasto o una transferencia propia. Una transferencia entre tus cuentas no se debe importar como gasto ni ingreso.</p>
            <div class="gmail-review-list">${reviewCards}</div>
        </details>` : ''}`;
}

function showResults(txs) {
    pendingTxs  = txs;
    selectedIds = new Set(txs.flatMap((tx, i) => (
        tx.reviewOnly || tx.possibleDuplicate ? [] : [i]
    )));

    const countEl   = document.getElementById('gmail-found-count');
    const listEl    = document.getElementById('gmail-tx-list');
    const importBtn = document.getElementById('gmail-btn-import');

    if (txs.length === 0) {
        if (countEl) countEl.textContent = 'No se encontraron movimientos nuevos.';
        const selectionEl = document.getElementById('gmail-selection-summary');
        if (selectionEl) selectionEl.textContent = '';
        if (listEl)  listEl.innerHTML = '<p class="gmail-empty">Todos los movimientos ya fueron importados o no hay emails bancarios en ese período.</p>';
        if (importBtn) importBtn.disabled = true;
        showState('results');
        return;
    }

    updateResultsSummary();
    renderTransactionResults();
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
    const modal = document.getElementById('modal-gmail-import');
    if (modal.dataset.saving === 'true' || !selectedIds.size) return;
    if (navigator.onLine === false) {
        handleError(new Error('No hay conexión. Conéctate a internet y vuelve a intentar; tu selección se conserva.'));
        return;
    }
    const uid = currentUid;
    const toImport = pendingTxs.flatMap((tx, index) => selectedIds.has(index) && !tx.reviewOnly ? [{ tx, index }] : []);
    let confirmed = 0;
    modal.dataset.saving = 'true';
    showState('loading');
    const message = document.getElementById('gmail-loading-msg');
    const updateProgress = () => { message.textContent = `Confirmados ${confirmed} de ${toImport.length}. Guardando hasta 4 a la vez…`; };
    updateProgress();
    try {
        // BUG 8 FIX: stopOnError:false — un error de Firestore en una transacción no
        // cancela el guardado de las demás. Cada error se reporta individualmente.
        const results = await runLimited(toImport, async ({ tx }) => {
            const occurredAtDate = tx.occurredAt instanceof Date && !Number.isNaN(tx.occurredAt.getTime())
                ? tx.occurredAt : businessDateToDate(tx.date);
            const receiptDescription = String(tx.receiptDescription || tx.description || '').trim().slice(0, 500);
            const payload = {
                amount: tx.amount, note: receiptDescription,
                description: receiptDescription, receiptDescription,
                date: firebase.firestore.Timestamp.fromDate(businessDateToDate(tx.date)), operationDate: tx.date,
                occurredAt: firebase.firestore.Timestamp.fromDate(occurredAtDate),
                ...(tx.emailReceivedAt instanceof Date && !Number.isNaN(tx.emailReceivedAt.getTime())
                    ? { emailReceivedAt: firebase.firestore.Timestamp.fromDate(tx.emailReceivedAt) } : {}),
                receiptDateSource: tx.receiptDateSource || 'email_received_fallback',
                sourceRawText: String(tx.rawText || '').slice(0, 4000),
                sourceSender: tx.sourceSender || '', sourceLabel: tx.sourceLabel || '',
                paymentChannel: tx.paymentChannel || '',
                accountAssignmentExplicit: tx.accountAssignmentExplicit === true,
                actorUid: uid, status: 'completed', source: `gmail:${tx.source}`, gmailId: tx.gmailId,
                counterparty: receiptDescription,
                accountId: resolveWalletAccount(tx, walletOptions, getWalletAssignmentRules())
            };
            if (!tx.gmailId) throw new Error('Un movimiento no tiene identificador de correo; no se guardó.');
            const save = tx.type === 'income' ? saveIncome : saveExpense;
            return withDeadline(() => save(uid, {
                ...payload, category: tx.category || (tx.type === 'income' ? 'otros' : 'yellow'),
                ...(tx.type === 'income' ? {} : { method: 'otro' })
            }, null, `gmail_${tx.gmailId}`), 32000, 'commit-unconfirmed');
        }, {
            concurrency: 4,
            stopOnError: false,
            onProgress: (result, index) => {
                if (result.status === 'fulfilled') {
                    confirmed++;
                    if (currentUid === uid) {
                        persistImportedId(toImport[index].tx.gmailId);
                        selectedIds.delete(toImport[index].index);
                    }
                }
                updateProgress();
            }
        });
        if (currentUid !== uid) return;
        updateImportBtn();
        modal.querySelectorAll('.gmail-tx-check').forEach(check => { check.checked = selectedIds.has(Number(check.dataset.idx)); });
        const failed = results.find(result => result?.status === 'rejected');
        if (failed) {
            const code = String(failed.reason?.code || '');
            const detail = code.includes('permission-denied')
                ? 'Firebase rechazó el guardado. Revisa las reglas publicadas y la sesión.'
                : code.includes('commit-unconfirmed')
                    ? 'No llegó la confirmación de Firebase. Algunos envíos podrían completarse; el reintento verifica sus identificadores antes de guardar.'
                    : code.includes('unavailable')
                        ? 'Firebase no está disponible. Comprueba la conexión.'
                        : failed.reason?.message || 'No se pudo completar el guardado.';
            handleError(new Error(`${confirmed} de ${toImport.length} confirmados. ${detail} Tu selección pendiente se conserva.`));
        } else {
            document.getElementById('gmail-success-title').textContent = 'Importación confirmada';
            document.getElementById('gmail-success-msg').textContent = `${confirmed} movimiento${confirmed === 1 ? '' : 's'} confirmado${confirmed === 1 ? '' : 's'} en tu cuenta. Los ya existentes no se duplican.`;
            showState('success');
        }
    } catch (error) {
        if (currentUid === uid) handleError(error);
    } finally {
        modal.dataset.saving = 'false';
        if (currentUid === uid && confirmed) window.dispatchEvent(new CustomEvent('konteo:refresh'));
    }
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
    document.getElementById('gmail-modal-close')?.addEventListener('click', closeModal);
    modal.addEventListener('click', event => { if (event.target === modal) closeModal(); });
    /* Legacy modal listeners removed: source configuration lives in the workspace.
    const entitiesModal = document.getElementById('modal-gmail-entities');

    document.getElementById('gmail-modal-close')?.addEventListener('click', closeModal);
    modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });

    document.getElementById('gmail-entities-close')?.addEventListener('click', closeEntitiesModal);
    entitiesModal?.addEventListener('click', e => { if (e.target === entitiesModal) closeEntitiesModal(); });
    document.getElementById('gmail-btn-manage-entities')?.addEventListener('click', async () => {
        await getGmailPref();
        openEntitiesModal();
    });
    document.getElementById('gmail-only-configured-entities')?.addEventListener('change', async e => {
        const enabled = e.target.checked;
        if (enabled && getActiveCustomEntities().length === 0) {
            e.target.checked = false;
            window.alert('Primero agrega y activa al menos una entidad.');
            return;
        }
        await saveGmailPref({ onlyConfiguredEntities: enabled });
        renderReadingRule();
    });
    document.getElementById('gmail-entity-form')?.addEventListener('submit', async e => {
        e.preventDefault();
        const name = String(document.getElementById('gmail-entity-name')?.value || '').trim();
        const sender = normalizeEntitySender(document.getElementById('gmail-entity-sender')?.value);
        const defaultType = document.getElementById('gmail-entity-type')?.value || 'auto';
        const defaultCategory = document.getElementById('gmail-entity-category')?.value || 'yellow';
        const defaultAccountId = document.getElementById('gmail-entity-account')?.value || '';
        const feedback = document.getElementById('gmail-entity-feedback');
        if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sender)) {
            if (feedback) feedback.textContent = 'Ingresa un nombre y un correo oficial válido.';
            return;
        }
        if (getCustomEntities().some(entity => entity.sender === sender)) {
            if (feedback) feedback.textContent = 'Ese correo ya está registrado.';
            return;
        }
        const entity = { id: `entity-${Date.now().toString(36)}`, name, sender, defaultType, defaultCategory, defaultAccountId, active: true };
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

    */
    document.getElementById('gmail-btn-decline')?.addEventListener('click', async () => {
        await saveGmailPref({ enabled: false, email: null });
        closeModal();
    });
    document.getElementById('gmail-btn-go-sources')?.addEventListener('click', () => {
        closeModal();
        window.dispatchEvent(new CustomEvent('konteo:open-gmail-sources'));
    });
    document.getElementById('gmail-btn-connect')?.addEventListener('click', () => {
        const days = parseInt(document.getElementById('gmail-days-select')?.value || '30', 10);
        connectAndSearch(days);
    });
    document.getElementById('gmail-btn-sync')?.addEventListener('click', async () => {
        const days = parseInt(document.getElementById('gmail-days-select2')?.value || '30', 10);
        showState('loading');
        if (!isTokenValid()) {
            await connectAndSearch(days);
        } else {
            await doSearch(days);
        }
    });
    document.getElementById('gmail-btn-disconnect')?.addEventListener('click', async () => {
        await disconnectGmail();
        showState('consent');
    });
    document.getElementById('gmail-select-all')?.addEventListener('click', () => {
        selectedIds = new Set(pendingTxs.flatMap((tx, i) => tx.reviewOnly ? [] : [i]));
        modal.querySelectorAll('.gmail-tx-check').forEach(cb => { if (!cb.disabled) cb.checked = true; });
        updateImportBtn();
    });
    document.getElementById('gmail-deselect-all')?.addEventListener('click', () => {
        selectedIds.clear();
        modal.querySelectorAll('.gmail-tx-check').forEach(cb => { if (!cb.disabled) cb.checked = false; });
        updateImportBtn();
    });
    document.getElementById('gmail-tx-list')?.addEventListener('change', e => {
        const categorySelect = e.target.closest('.gmail-tx-category');
        if (categorySelect) {
            const idx = Number.parseInt(categorySelect.dataset.idx, 10);
            if (pendingTxs[idx]?.type === 'expense') pendingTxs[idx].category = categorySelect.value;
            return;
        }
        const accountSelect = e.target.closest('.gmail-tx-account');
        if (accountSelect) {
            const idx = Number.parseInt(accountSelect.dataset.idx, 10);
            if (pendingTxs[idx]) {
                pendingTxs[idx].accountAssignmentExplicit = true;
                pendingTxs[idx].accountId = accountSelect.value;
            }
            return;
        }
        const cb = e.target.closest('.gmail-tx-check');
        if (!cb) return;
        const idx = parseInt(cb.dataset.idx, 10);
        if (pendingTxs[idx]?.reviewOnly) return;
        if (cb.checked) selectedIds.add(idx); else selectedIds.delete(idx);
        updateImportBtn();
    });
    document.getElementById('gmail-tx-list')?.addEventListener('click', e => {
        const button = e.target.closest('[data-review-classification]');
        if (!button) return;
        const idx = Number.parseInt(button.dataset.idx, 10);
        const tx = pendingTxs[idx];
        const type = button.dataset.reviewClassification;
        if (!tx?.reviewOnly || !['income', 'expense'].includes(type)) return;
        tx.type = type;
        tx.reviewOnly = false;
        tx.reviewReason = '';
        tx.category = type === 'expense' ? 'yellow' : 'otros';
        selectedIds.add(idx);
        updateResultsSummary();
        renderTransactionResults();
        updateImportBtn();
    });
    /* Import no longer owns source selection; it only handles individual operations.
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
    */
    document.getElementById('gmail-btn-import')?.addEventListener('click', doImport);
    document.getElementById('gmail-btn-back')?.addEventListener('click', () => {
        showState(pref?.enabled ? 'connected' : 'consent');
    });
    document.getElementById('gmail-btn-retry')?.addEventListener('click', () => {
        showState(pendingTxs.length && selectedIds.size ? 'results' : gmailPreference?.enabled ? 'connected' : 'consent');
    });
    document.getElementById('gmail-btn-err-close')?.addEventListener('click', closeModal);
    document.getElementById('gmail-btn-done')?.addEventListener('click', () => {
        closeModal();
    });
}

// ─────────────────────────────────────────────
// EXPORT: punto de entrada
// ─────────────────────────────────────────────
export async function initGmailImport(uid) {
    if (!uid) return;
    if (initializedUid === uid && document.getElementById('modal-gmail-import')) return;
    if (initialization?.uid === uid) return initialization.promise;

    const promise = (async () => {
    currentUid = uid;
    loadImportedIds();
    const pref = await getGmailPref();
    walletOptions = await getWallets(uid).catch(() => []);
    buildModal();
    wireListeners(pref);
    renderSourcesWorkspace();
    initGmailService().catch(() => {});
    initializedUid = uid;
    })();
    initialization = { uid, promise };
    try {
        await promise;
    } finally {
        if (initialization?.promise === promise) initialization = null;
    }
}

// Gmail reads are intentionally deferred until the person opens this feature.
// A normal dashboard visit does not need its preferences or wallet list.
export async function openGmailImport(uid) {
    await initGmailImport(uid);
    if (!uid || currentUid !== uid) return;
    const emailEl = document.getElementById('gmail-email-display');
    if (gmailPreference?.enabled && gmailPreference?.email) {
        if (emailEl) emailEl.textContent = gmailPreference.email;
        showState('connected');
    } else {
        showState('consent');
    }
    openModal();
}

export async function openGmailEntities(uid) {
    await initGmailImport(uid);
    if (!uid || currentUid !== uid) return;
    await getGmailPref();
    walletOptions = await getWallets(uid).catch(() => walletOptions);
    renderSourcesWorkspace();
}

/**
 * Limpia el caché local de IDs de Gmail importados (sessionStorage + memoria).
 * Llamar después de borrar todos los datos del usuario para permitir reimportar sin falsos positivos.
 */
export function clearGmailImportCache() {
    importedGmailIds = new Set();
    pendingTxs = [];
    selectedIds = new Set();
    isSearching = false;
    if (currentUid) {
        try { sessionStorage.removeItem(`konteo_gmail_${currentUid}`); } catch {}
    }
    try { sessionStorage.removeItem('konteo_gmail_imported'); } catch {}
}
