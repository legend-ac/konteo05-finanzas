// js/ui/gmailImport.js
// UI completa para importación de movimientos desde Gmail

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
} from '../services/gmailService.js';

import { parseAllEmails } from '../services/gmailParser.js';
import { saveIncome, saveExpense } from '../services/dbService.js';
import { firebase } from '../firebase/config.js';

// ─────────────────────────────────────────────
// ESTADO DEL MÓDULO
// ─────────────────────────────────────────────
let pendingTransactions = [];
let selectedIds = new Set();
let importedGmailIds = new Set(); // persistido en sessionStorage

function loadImportedIds() {
    try {
        const raw = sessionStorage.getItem('konteo_gmail_imported') || '[]';
        importedGmailIds = new Set(JSON.parse(raw));
    } catch { importedGmailIds = new Set(); }
}

function saveImportedId(id) {
    importedGmailIds.add(id);
    try {
        sessionStorage.setItem('konteo_gmail_imported', JSON.stringify([...importedGmailIds]));
    } catch { }
}

// ─────────────────────────────────────────────
// ICONOS DE FUENTE
// ─────────────────────────────────────────────
const SOURCE_ICONS = {
    yape:       '💜',
    plin:       '🔵',
    bcp:        '🔴',
    interbank:  '🟢',
    bbva:       '🔵',
    scotiabank: '🔴',
    banbif:     '🟡',
    mibanco:    '🟠',
};

const SOURCE_LABELS = {
    yape: 'Yape', plin: 'Plin', bcp: 'BCP',
    interbank: 'Interbank', bbva: 'BBVA',
    scotiabank: 'Scotiabank', banbif: 'BanBif', mibanco: 'MiBanco',
};

function fmtAmt(n) {
    return `S/ ${Number(n).toFixed(2)}`;
}

// ─────────────────────────────────────────────
// RENDER: tarjeta de transacción en el modal
// ─────────────────────────────────────────────
function renderTxCard(tx, idx) {
    const icon = SOURCE_ICONS[tx.source] || '💳';
    const label = SOURCE_LABELS[tx.source] || tx.source;
    const typeClass = tx.type === 'income' ? 'gmail-tx-income' : 'gmail-tx-expense';
    const typeLabel = tx.type === 'income' ? 'Ingreso' : 'Gasto';
    const sign = tx.type === 'income' ? '+' : '−';
    const checked = selectedIds.has(idx) ? 'checked' : '';

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
// MODAL: estructura HTML
// ─────────────────────────────────────────────
function createModal() {
    const existing = document.getElementById('modal-gmail-import');
    if (existing) existing.remove();

    const el = document.createElement('div');
    el.id = 'modal-gmail-import';
    el.className = 'modal hidden';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-labelledby', 'gmail-modal-title');
    el.innerHTML = `
    <div class="modal-content gmail-modal-content">
        <div class="modal-handle"></div>
        <div class="gmail-modal-header">
            <div>
                <h3 id="gmail-modal-title">
                    <span class="gmail-icon">✉️</span> Importar desde Gmail
                </h3>
                <p class="gmail-modal-sub" id="gmail-modal-sub">Conecta tu Gmail para importar movimientos automáticamente.</p>
            </div>
            <button id="gmail-modal-close" class="gmail-close-btn" aria-label="Cerrar">✕</button>
        </div>

        <!-- Estado: inicial -->
        <div id="gmail-state-connect" class="gmail-state">
            <div class="gmail-connect-info">
                <div class="gmail-banks-list">
                    <span>💜 Yape</span><span>🔵 Plin</span><span>🔴 BCP</span>
                    <span>🟢 Interbank</span><span>🔵 BBVA</span><span>🔴 Scotiabank</span>
                </div>
                <p class="gmail-connect-note">
                    Solo lectura — nunca enviamos ni modificamos tus emails.
                    Usamos OAuth 2.0 de Google.
                </p>
                <div class="gmail-days-row">
                    <label for="gmail-days-select">Buscar en los últimos:</label>
                    <select id="gmail-days-select">
                        <option value="7">7 días</option>
                        <option value="30" selected>30 días</option>
                        <option value="60">60 días</option>
                        <option value="90">90 días</option>
                    </select>
                </div>
            </div>
            <button id="gmail-btn-connect" class="gmail-btn-primary">
                <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
                    <path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4-8 5-8-5V6l8 5 8-5v2z"/>
                </svg>
                Conectar Gmail
            </button>
        </div>

        <!-- Estado: cargando -->
        <div id="gmail-state-loading" class="gmail-state hidden">
            <div class="gmail-spinner-wrap">
                <div class="gmail-spinner"></div>
                <p id="gmail-loading-msg">Buscando movimientos en tu Gmail…</p>
            </div>
        </div>

        <!-- Estado: resultados -->
        <div id="gmail-state-results" class="gmail-state hidden">
            <div class="gmail-results-toolbar">
                <span id="gmail-found-count" class="gmail-found-count"></span>
                <div class="gmail-select-btns">
                    <button id="gmail-select-all" class="gmail-btn-sm">Seleccionar todo</button>
                    <button id="gmail-deselect-all" class="gmail-btn-sm">Deseleccionar</button>
                </div>
            </div>
            <div id="gmail-tx-list" class="gmail-tx-list"></div>
            <div class="gmail-actions-row">
                <button id="gmail-btn-cancel" class="gmail-btn-secondary">Cancelar</button>
                <button id="gmail-btn-import" class="gmail-btn-primary" disabled>
                    Importar seleccionados
                </button>
            </div>
        </div>

        <!-- Estado: éxito -->
        <div id="gmail-state-success" class="gmail-state hidden">
            <div class="gmail-success-wrap">
                <div class="gmail-success-icon">✅</div>
                <h4 id="gmail-success-title">¡Importados!</h4>
                <p id="gmail-success-msg"></p>
                <button id="gmail-btn-done" class="gmail-btn-primary">Listo</button>
            </div>
        </div>

        <!-- Estado: error -->
        <div id="gmail-state-error" class="gmail-state hidden">
            <div class="gmail-error-wrap">
                <div class="gmail-error-icon">⚠️</div>
                <p id="gmail-error-msg"></p>
                <button id="gmail-btn-retry" class="gmail-btn-secondary">Reintentar</button>
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
    ['connect','loading','results','success','error'].forEach(s => {
        const el = document.getElementById(`gmail-state-${s}`);
        if (el) el.classList.toggle('hidden', s !== name);
    });
}

function openGmailModal() {
    const modal = document.getElementById('modal-gmail-import');
    if (modal) modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
}

function closeGmailModal() {
    const modal = document.getElementById('modal-gmail-import');
    if (modal) modal.classList.add('hidden');
    document.body.style.overflow = '';
}

// ─────────────────────────────────────────────
// FLUJO PRINCIPAL
// ─────────────────────────────────────────────
async function startImport() {
    showState('loading');
    const daysBack = parseInt(document.getElementById('gmail-days-select')?.value || '30', 10);

    try {
        // Solicitar token OAuth (abre popup de Google)
        document.getElementById('gmail-loading-msg').textContent = 'Autorizando con Google…';
        await requestGmailToken();

        document.getElementById('gmail-loading-msg').textContent = `Buscando emails de los últimos ${daysBack} días…`;
        const rawMessages = await fetchTransactionEmails(daysBack);

        if (rawMessages.length === 0) {
            showFoundResults([]);
            return;
        }

        document.getElementById('gmail-loading-msg').textContent = `Analizando ${rawMessages.length} emails…`;

        const transactions = parseAllEmails({
            rawMessages,
            decodeBody: decodeEmailBody,
            getSender: getEmailSender,
            getDate: getEmailDate,
            getSubject: getEmailSubject,
            existingIds: importedGmailIds,
        });

        showFoundResults(transactions);
    } catch (err) {
        console.error('[gmailImport] Error:', err);
        const errorEl = document.getElementById('gmail-error-msg');
        if (errorEl) errorEl.textContent = err.message || 'Error al conectar con Gmail.';
        showState('error');
    }
}

function showFoundResults(transactions) {
    pendingTransactions = transactions;
    selectedIds = new Set(transactions.map((_, i) => i)); // todos seleccionados por defecto

    const countEl = document.getElementById('gmail-found-count');
    const listEl  = document.getElementById('gmail-tx-list');
    const importBtn = document.getElementById('gmail-btn-import');

    if (transactions.length === 0) {
        if (countEl) countEl.textContent = 'No se encontraron movimientos nuevos.';
        if (listEl) listEl.innerHTML = '<p class="gmail-empty">Todos los movimientos ya fueron importados o no hay emails de bancos/Yape en el período seleccionado.</p>';
        if (importBtn) { importBtn.disabled = true; }
        showState('results');
        return;
    }

    if (countEl) countEl.textContent = `${transactions.length} movimiento${transactions.length !== 1 ? 's' : ''} encontrado${transactions.length !== 1 ? 's' : ''}`;
    if (listEl) listEl.innerHTML = transactions.map((tx, i) => renderTxCard(tx, i)).join('');
    updateImportButton();
    showState('results');
}

function updateImportButton() {
    const btn = document.getElementById('gmail-btn-import');
    if (!btn) return;
    const n = selectedIds.size;
    btn.disabled = n === 0;
    btn.textContent = n > 0 ? `Importar ${n} movimiento${n !== 1 ? 's' : ''}` : 'Selecciona al menos uno';
}

async function doImport(uid) {
    showState('loading');
    document.getElementById('gmail-loading-msg').textContent = 'Guardando movimientos…';

    const toImport = pendingTransactions.filter((_, i) => selectedIds.has(i));
    let imported = 0;
    let errors = 0;

    for (const tx of toImport) {
        try {
            const now = firebase.firestore.Timestamp.fromDate(new Date());
            const dateTs = firebase.firestore.Timestamp.fromDate(new Date(tx.date + 'T12:00:00'));

            if (tx.type === 'income') {
                await saveIncome(uid, {
                    amount: tx.amount,
                    note: tx.description,
                    category: tx.category || 'otros',
                    date: dateTs,
                    createdAt: now,
                    source: `gmail:${tx.source}`,
                    gmailId: tx.gmailId,
                });
            } else {
                await saveExpense(uid, {
                    amount: tx.amount,
                    note: tx.description,
                    category: tx.category || 'yellow',
                    method: 'otro',
                    date: dateTs,
                    createdAt: now,
                    source: `gmail:${tx.source}`,
                    gmailId: tx.gmailId,
                });
            }

            saveImportedId(tx.gmailId);
            imported++;
        } catch (e) {
            console.error('[gmailImport] Error guardando tx:', e);
            errors++;
        }
    }

    const title = document.getElementById('gmail-success-title');
    const msg = document.getElementById('gmail-success-msg');
    if (title) title.textContent = imported > 0 ? '¡Importación completa!' : 'Sin cambios';
    if (msg) {
        msg.textContent = [
            imported > 0 ? `${imported} movimiento${imported !== 1 ? 's' : ''} importado${imported !== 1 ? 's' : ''} correctamente.` : '',
            errors > 0 ? `${errors} no pudieron guardarse.` : '',
        ].filter(Boolean).join(' ');
    }

    showState('success');
}

// ─────────────────────────────────────────────
// WIRE: listeners del modal
// ─────────────────────────────────────────────
function wireModal(uid) {
    const modal = document.getElementById('modal-gmail-import');
    if (!modal) return;

    // Cerrar
    modal.querySelector('#gmail-modal-close')?.addEventListener('click', closeGmailModal);
    modal.addEventListener('click', e => { if (e.target === modal) closeGmailModal(); });

    // Conectar Gmail
    modal.querySelector('#gmail-btn-connect')?.addEventListener('click', startImport);

    // Reintentar
    modal.querySelector('#gmail-btn-retry')?.addEventListener('click', () => {
        showState('connect');
    });

    // Cancelar en resultados
    modal.querySelector('#gmail-btn-cancel')?.addEventListener('click', closeGmailModal);

    // Seleccionar/deseleccionar todo
    modal.querySelector('#gmail-select-all')?.addEventListener('click', () => {
        selectedIds = new Set(pendingTransactions.map((_, i) => i));
        modal.querySelectorAll('.gmail-tx-check').forEach(cb => { cb.checked = true; });
        updateImportButton();
    });
    modal.querySelector('#gmail-deselect-all')?.addEventListener('click', () => {
        selectedIds.clear();
        modal.querySelectorAll('.gmail-tx-check').forEach(cb => { cb.checked = false; });
        updateImportButton();
    });

    // Checkboxes individuales (delegación)
    modal.querySelector('#gmail-tx-list')?.addEventListener('change', e => {
        const cb = e.target.closest('.gmail-tx-check');
        if (!cb) return;
        const idx = parseInt(cb.dataset.idx, 10);
        if (cb.checked) selectedIds.add(idx); else selectedIds.delete(idx);
        updateImportButton();
    });

    // Importar
    modal.querySelector('#gmail-btn-import')?.addEventListener('click', () => doImport(uid));

    // Listo (tras éxito)
    modal.querySelector('#gmail-btn-done')?.addEventListener('click', () => {
        closeGmailModal();
        // Recarga los movimientos en el dashboard
        window.dispatchEvent(new CustomEvent('konteo:refresh'));
    });
}

// ─────────────────────────────────────────────
// EXPORT: inicializar la feature completa
// ─────────────────────────────────────────────
export function initGmailImport(uid) {
    loadImportedIds();

    // Crea el modal en el DOM
    createModal();
    wireModal(uid);

    // Inicializa el SDK de Google Identity Services en background
    initGmailService().catch(err => {
        console.warn('[gmailImport] GIS no disponible:', err.message);
    });

    // Expone el botón de abrir en el header
    const triggerBtn = document.getElementById('btn-gmail-import');
    if (triggerBtn) {
        triggerBtn.addEventListener('click', () => {
            showState('connect');
            openGmailModal();
        });
    }
}
