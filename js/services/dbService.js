// js/services/dbService.js — Firestore CRUD operations

import { db, firebase } from '../firebase/config.js';
import { businessDateString, transactionBusinessDate } from '../ui/helpers.js';
import { withDeadline } from './asyncControl.js';

const planCache = new Map();
const transactionSchemaMode = new Map();
const PLAN_CACHE_TTL_MS = 60_000;
const pendingReads = new Map();

function sharedRead(key, operation) {
    if (pendingReads.has(key)) return pendingReads.get(key);
    const pending = withDeadline(operation, 20000).finally(() => pendingReads.delete(key));
    pendingReads.set(key, pending);
    return pending;
}

function isMissingIndex(error) {
    return String(error?.code || '').replace('firestore/', '') === 'failed-precondition';
}

function transactionSchemaStorageKey(uid) {
    return `konteo.transaction-schema.${uid}`;
}

function getTransactionSchemaMode(uid) {
    if (transactionSchemaMode.has(uid)) return transactionSchemaMode.get(uid);
    try {
        const mode = localStorage.getItem(transactionSchemaStorageKey(uid));
        if (mode === 'modern' || mode === 'legacy') {
            transactionSchemaMode.set(uid, mode);
            return mode;
        }
    } catch (_) { }
    return null;
}

function setTransactionSchemaMode(uid, mode) {
    transactionSchemaMode.set(uid, mode);
    try { localStorage.setItem(transactionSchemaStorageKey(uid), mode); } catch (_) { }
}

function uniqueDocs(docs) {
    const map = new Map();
    docs.forEach(doc => map.set(doc.id, doc));
    return [...map.values()];
}

function periodQuery(reference, field, startTs, endTs) {
    let query = reference.where(field, '>=', startTs);
    if (endTs) query = query.where(field, '<=', endTs);
    return query;
}

/**
 * Obtiene el perfil de usuario.
 */
export async function getUserProfile(uid) {
    const doc = await db.collection('users').doc(uid).get();
    return doc.exists ? doc.data() : null;
}

/**
 * Guarda el perfil de usuario con merge.
 */
export async function saveUserProfile(uid, profileData) {
    profileData.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
    await db.collection('users').doc(uid).set(profileData, { merge: true });
}

/**
 * Carga el plan financiero.
 */
export async function getPlan(uid) {
    const cached = planCache.get(uid);
    if (cached && Date.now() - cached.savedAt < PLAN_CACHE_TTL_MS) return cached.value;

    try {
        const doc = await db.collection('plans').doc(uid).get();
        if (doc.exists) {
            const value = doc.data();
            planCache.set(uid, { value, savedAt: Date.now() });
            return value;
        }
    } catch (_) { }

    // Fallback for environments where /plans rules are not deployed yet.
    const userDoc = await db.collection('users').doc(uid).get();
    const userData = userDoc.exists ? userDoc.data() : {};
    const planConfig = userData.planConfig || {};
    const value = {
        incomeTarget: Number(planConfig.incomeTarget || 0),
        expenseLimit: Number(planConfig.expenseLimit || 0)
    };
    planCache.set(uid, { value, savedAt: Date.now() });
    return value;
}

/**
 * Guarda el plan financiero.
 */
export async function savePlan(uid, planData) {
    const payload = {
        ...planData,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    };

    try {
        await db.collection('plans').doc(uid).set(payload);
    } catch (_) {
        // Fallback for environments where /plans rules are not deployed yet.
        await db.collection('users').doc(uid).set({
            planConfig: {
                incomeTarget: Number(planData.incomeTarget || 0),
                expenseLimit: Number(planData.expenseLimit || 0)
            },
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
    }
    planCache.set(uid, { value: { ...planData }, savedAt: Date.now() });
}

// ─────────────────────────────────────────────────────────────────────────────
// BILLETERAS / CUENTAS
// A wallet is deliberately separate from Gmail senders. Transactions reference
// a wallet with accountId; old records without it remain valid and appear as
// "Sin asignar" until the user chooses to classify them.
// ─────────────────────────────────────────────────────────────────────────────
function walletsRef(uid) {
    return db.collection('users').doc(uid).collection('wallets');
}

export async function getWallets(uid) {
    return sharedRead(`wallets:${uid}`, async () => {
    const snapshot = await walletsRef(uid).get();
    return snapshot.docs
        .map(doc => ({ id: doc.id, ...doc.data() }))
        .sort((a, b) => {
            if ((a.active !== false) !== (b.active !== false)) return a.active === false ? 1 : -1;
            return String(a.name || '').localeCompare(String(b.name || ''), 'es');
        });
    });
}

export async function saveWallet(uid, wallet, editId = null) {
    const ref = editId ? walletsRef(uid).doc(editId) : walletsRef(uid).doc();
    const payload = cleanObject({
        name: String(wallet.name || '').trim(),
        institution: String(wallet.institution || '').trim(),
        type: wallet.type || 'bank',
        currency: wallet.currency || 'PEN',
        openingBalance: Number(wallet.openingBalance || 0),
        color: wallet.color || 'gold',
        includeInTotal: wallet.includeInTotal !== false,
        active: wallet.active !== false,
        userConfirmed: true,
        sourceKey: wallet.sourceKey,
        linkSource: wallet.linkSource,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    if (!editId) payload.createdAt = firebase.firestore.FieldValue.serverTimestamp();
    await ref.set(payload, { merge: true });
    return ref.id;
}

export async function archiveWallet(uid, id) {
    await walletsRef(uid).doc(id).set({
        active: false,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
}

/**
 * One atomic transfer makes two linked account movements. They are marked as
 * transfers, therefore they update each wallet but never inflate the general
 * income/expense totals.
 */
export async function saveTransfer(uid, data, requestId = null) {
    const transferId = requestId || db.collection('_ids').doc().id;
    const outRef = db.collection('transactions').doc(uid).collection('expenses').doc(`transfer_out_${transferId}`);
    const inRef = db.collection('transactions').doc(uid).collection('income').doc(`transfer_in_${transferId}`);
    validateMovement(data);
    if (!data.fromAccountId || !data.toAccountId || data.fromAccountId === data.toAccountId) throw new Error('Selecciona dos cuentas distintas.');
    const deadline = Date.now() + 30000;

    const amount = Number(data.amount || 0);
    const operationDate = data.operationDate || businessDateString(data.date?.toDate?.() || new Date());
    const common = cleanObject({
        amount,
        date: data.date,
        operationDate,
        occurredAt: data.occurredAt || firebase.firestore.Timestamp.fromDate(new Date()),
        actorUid: data.actorUid || uid,
        actorEmail: data.actorEmail || '',
        status: 'completed',
        transferId,
        isTransfer: true,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    return withDeadline(() => db.runTransaction(async batch => {
    if (Date.now() >= deadline) throw new Error('Se agotó el tiempo de transferencia.');
    const [outCurrent, inCurrent, fromWallet, toWallet] = await Promise.all([
        batch.get(outRef), batch.get(inRef),
        batch.get(walletsRef(uid).doc(data.fromAccountId)), batch.get(walletsRef(uid).doc(data.toAccountId))
    ]);
    if (outCurrent.exists && inCurrent.exists) return transferId;
    if (outCurrent.exists || inCurrent.exists) throw new Error('Transferencia incompleta existente. Revisa sus movimientos antes de reintentar.');
    if (!fromWallet.exists || !toWallet.exists || fromWallet.data().active === false || toWallet.data().active === false) throw new Error('Ambas cuentas deben existir y estar activas.');
    if ((fromWallet.data().currency || 'PEN') !== (toWallet.data().currency || 'PEN')) throw new Error('No se admite transferir entre monedas distintas sin conversión.');
    if (Date.now() >= deadline) throw new Error('Se agotó el tiempo de transferencia.');
    batch.set(outRef, {
        ...common, accountId: data.fromAccountId, operationType: 'transfer_out',
        category: 'yellow', method: 'transferencia', note: data.note || 'Transferencia entre billeteras',
        counterparty: data.toName || '', reference: `TRF-${transferId}`
    });
    batch.set(inRef, {
        ...common, accountId: data.toAccountId, operationType: 'transfer_in',
        source: 'transferencia', note: data.note || 'Transferencia entre billeteras',
        counterparty: data.fromName || '', reference: `TRF-${transferId}`
    });
    return transferId;
    }), 30000, 'commit-unconfirmed');
}

/**
 * Obtiene transacciones desde una fecha de inicio.
 */
export async function getTransactions(uid, startTs, endTs = null) {
    const incomeRef = db.collection('transactions').doc(uid).collection('income');
    const expenseRef = db.collection('transactions').doc(uid).collection('expenses');

    try {
        // All current records have `date`. This is two reads instead of four
        // after the one-time legacy check, and custom periods are bounded on
        // the server instead of downloading newer transactions to discard.
        const [incomeByDate, expenseByDate] = await Promise.all([
            periodQuery(incomeRef, 'date', startTs, endTs).get(),
            periodQuery(expenseRef, 'date', startTs, endTs).get()
        ]);

        const schemaMode = getTransactionSchemaMode(uid);
        if (schemaMode === 'modern') {
            return {
                incomeItems: incomeByDate.docs.map(doc => ({ id: doc.id, type: 'income', ...doc.data() })),
                expenseItems: expenseByDate.docs.map(doc => ({ id: doc.id, type: 'expense', ...doc.data() }))
            };
        }

        // Compatibility check only once per user. The first scan covers the
        // account history, so selecting an old custom period later cannot hide
        // an old record that only has `createdAt`.
        const scanWholeHistory = schemaMode === null;
        const legacyStartTs = scanWholeHistory
            ? firebase.firestore.Timestamp.fromDate(new Date('2000-01-01T00:00:00.000Z'))
            : startTs;
        const legacyEndTs = scanWholeHistory ? null : endTs;
        const [incomeByCreatedAt, expenseByCreatedAt] = await Promise.all([
            periodQuery(incomeRef, 'createdAt', legacyStartTs, legacyEndTs).get(),
            periodQuery(expenseRef, 'createdAt', legacyStartTs, legacyEndTs).get()
        ]);
        const incomeDocs = uniqueDocs([...incomeByDate.docs, ...incomeByCreatedAt.docs]);
        const expenseDocs = uniqueDocs([...expenseByDate.docs, ...expenseByCreatedAt.docs]);
        const hasLegacyOnlyDocs = [...incomeDocs, ...expenseDocs]
            .some(doc => !doc.data().date && doc.data().createdAt);
        setTransactionSchemaMode(uid, hasLegacyOnlyDocs ? 'legacy' : 'modern');

        return {
            incomeItems: incomeDocs.map(doc => ({ id: doc.id, type: 'income', ...doc.data() })),
            expenseItems: expenseDocs.map(doc => ({ id: doc.id, type: 'expense', ...doc.data() }))
        };
    } catch (error) {
        if (!isMissingIndex(error)) throw error;
        // Only an unavailable index justifies a compatibility scan.
        const [incomeSnap, expenseSnap] = await Promise.all([
            incomeRef.get(),
            expenseRef.get()
        ]);
        return {
            incomeItems: incomeSnap.docs.map(doc => ({ id: doc.id, type: 'income', ...doc.data() })),
            expenseItems: expenseSnap.docs.map(doc => ({ id: doc.id, type: 'expense', ...doc.data() }))
        };
    }
}

/**
 * Obtiene todos los IDs de Gmail e identificadores de transacciones previamente guardados en Firestore.
 * Filtra a los últimos 90 días para evitar consultas masivas y compara usando
 * el día operativo oficial de Konteo (America/Lima).
 */
export async function getImportedGmailIds(uid) {
    // Bug 9: cutoff de 95 días (en vez de 90) para dar margen y evitar que emails
    // del día 91 reaparezcan como nuevos porque su ID ya no está en Firestore.
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 95);
    const cutoffTs = firebase.firestore.Timestamp.fromDate(cutoff);

    let incDocs = [];
    let expDocs = [];
    try {
        const [incSnap, expSnap] = await Promise.all([
            db.collection('transactions').doc(uid).collection('income')
              .where('date', '>=', cutoffTs).get(),
            db.collection('transactions').doc(uid).collection('expenses')
              .where('date', '>=', cutoffTs).get(),
        ]);
        incDocs = incSnap.docs;
        expDocs = expSnap.docs;
    } catch (error) {
        if (!isMissingIndex(error)) throw error;
        // Fallback sin filtro solo si el índice no está disponible
        const [incSnap, expSnap] = await Promise.all([
            db.collection('transactions').doc(uid).collection('income').get(),
            db.collection('transactions').doc(uid).collection('expenses').get(),
        ]);
        incDocs = incSnap.docs;
        expDocs = expSnap.docs;
    }

    const gmailIds = new Set();
    const existingTxKeys = new Set();

    const processDoc = (doc, type) => {
        const data = doc.data();
        if (data.gmailId) gmailIds.add(data.gmailId);
        // El docId gmail_<msgId> también contiene el ID de Gmail
        if (doc.id && doc.id.startsWith('gmail_')) {
            gmailIds.add(doc.id.slice(6)); // 'gmail_'.length === 6
        }
        const dateStr = transactionBusinessDate(data);
        if (dateStr && data.amount) {
            existingTxKeys.add(`${type}|${dateStr}|${Number(data.amount).toFixed(2)}`);
        }
    };

    incDocs.forEach(doc => processDoc(doc, 'income'));
    expDocs.forEach(doc => processDoc(doc, 'expense'));

    return { gmailIds, existingTxKeys };
}

/**
 * Guarda o actualiza un ingreso.
 */
function cleanObject(value) {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function auditSnapshot(payload) {
    const snapshot = { ...payload };
    delete snapshot.createdAt;
    delete snapshot.updatedAt;
    return snapshot;
}

function auditRef(uid) {
    return db.collection('users').doc(uid).collection('auditLogs');
}

function validateMovement(data) {
    if (!Number.isFinite(Number(data.amount)) || Number(data.amount) <= 0 || Number(data.amount) > 999999999) {
        throw new Error('El monto debe ser mayor que cero y estar dentro del límite permitido.');
    }
    const date = data.date?.toDate?.();
    // Bug 10: tolerancia de +24h para emails de bancos con reloj del servidor desfasado.
    // Sin esto, un email con fecha de mañana (error del banco) rechazaba todo el lote.
    if (!(date instanceof Date) || !Number.isFinite(date.getTime()) || date.getTime() > Date.now() + 86_400_000) {
        throw new Error('La fecha del movimiento no es válida.');
    }
}

async function saveTransaction(uid, type, data, editId = null, requestId = null) {
    if (!uid) throw new Error('Inicia sesión para guardar.');
    validateMovement(data);
    if (type === 'expense' && !['green', 'yellow', 'red'].includes(data.category)) throw new Error('Categoría de gasto no válida.');
    const collection = type === 'income' ? 'income' : 'expenses';
    const txRef = db.collection('transactions').doc(uid).collection(collection)
        .doc(editId || requestId || db.collection('_ids').doc().id);
    const createAudit = auditRef(uid).doc(`create_${txRef.id}`);
    // Stable for every automatic retry of this transaction.
    const newAudit = auditRef(uid).doc();
    const deadline = Date.now() + 30000;
    const operationDate = data.operationDate || businessDateString(data.date.toDate());
    const reference = data.reference || `${type === 'income' ? 'ING' : 'GAS'}-${txRef.id}`;
    const base = cleanObject({
        ...data, amount: Number(data.amount), operationDate, reference,
        accountAssignmentExplicit: Object.prototype.hasOwnProperty.call(data, 'accountId') ? true : data.accountAssignmentExplicit,
        operationType: data.operationType || type, status: data.status || 'completed',
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });

    return withDeadline(() => db.runTransaction(async transaction => {
        // Firestore can retry the callback; never start a new attempt after our deadline.
        if (Date.now() >= deadline) throw new Error('Se agotó el tiempo de guardado.');
        const current = await transaction.get(txRef);
        if (!editId && current.exists) return txRef.id;
        if (editId && !current.exists) throw new Error('Este movimiento ya no existe. Actualiza la lista.');
        let originalAudit = null;
        if (!editId) {
            if (data.gmailId) {
                const otherCollection = type === 'income' ? 'expenses' : 'income';
                const other = await transaction.get(db.collection('transactions').doc(uid).collection(otherCollection).doc(txRef.id));
                if (other.exists) return txRef.id;
            }
            originalAudit = await transaction.get(createAudit);
        }
        if (Date.now() >= deadline) throw new Error('Se agotó el tiempo de guardado.');
        if (editId) {
            const update = { ...base };
            delete update.occurredAt;
            transaction.update(txRef, update);
            transaction.set(newAudit, cleanObject({
                eventType: 'updated', movementId: txRef.id, operationType: type,
                operationDate, reference, actorUid: data.actorUid || uid,
                recordedAt: firebase.firestore.FieldValue.serverTimestamp(),
                before: auditSnapshot(current.data()), after: auditSnapshot(update)
            }));
        } else {
            const created = { ...base, createdAt: firebase.firestore.FieldValue.serverTimestamp() };
            transaction.set(txRef, created);
            // Account cleanup deliberately retains immutable audit logs. Reimporting
            // must append an event, never overwrite create_<id> (which rules deny).
            transaction.set(originalAudit.exists ? newAudit : createAudit, cleanObject({
                eventType: 'created', movementId: txRef.id, operationType: type,
                operationDate, reference, actorUid: data.actorUid || uid,
                actorEmail: data.actorEmail || '',
                occurredAt: data.occurredAt || firebase.firestore.Timestamp.fromDate(new Date()),
                recordedAt: firebase.firestore.FieldValue.serverTimestamp(),
                snapshot: auditSnapshot(created)
            }));
        }
        return txRef.id;
    }), 30000, 'commit-unconfirmed');
}

/** Guarda o actualiza un ingreso con trazabilidad inmutable. */
export async function saveIncome(uid, data, editId = null, requestId = null) {
    return saveTransaction(uid, 'income', data, editId, requestId);
}

/**
 * Guarda o actualiza un gasto.
 */
export async function saveExpense(uid, data, editId = null, requestId = null) {
    return saveTransaction(uid, 'expense', data, editId, requestId);
}

/**
 * Elimina una transacción.
 */
export async function deleteTransaction(uid, type, id) {
    const collection = type === 'income' ? 'income' : 'expenses';
    const txRef = db.collection('transactions').doc(uid).collection(collection).doc(id);
    const current = await txRef.get();
    if (!current.exists) return;
    const batch = db.batch();
    batch.set(auditRef(uid).doc(`delete_${id}_${Date.now()}`), {
        eventType: 'deleted', movementId: id, operationType: type,
        operationDate: transactionBusinessDate(current.data()),
        reference: current.data().reference || `${type}-${id}`,
        actorUid: uid, recordedAt: firebase.firestore.FieldValue.serverTimestamp(),
        snapshot: auditSnapshot(current.data())
    });
    batch.delete(txRef);
    await batch.commit();
}

/** Deletes both legs of a transfer so balances can never be left inconsistent. */
export async function deleteTransfer(uid, transferId) {
    if (!transferId) return;
    const root = db.collection('transactions').doc(uid);
    const [outgoing, incoming] = await Promise.all([
        root.collection('expenses').where('transferId', '==', transferId).get(),
        root.collection('income').where('transferId', '==', transferId).get()
    ]);
    const docs = [...outgoing.docs, ...incoming.docs];
    if (!docs.length) return;
    const batch = db.batch();
    docs.forEach(doc => batch.delete(doc.ref));
    await batch.commit();
}

/**
 * Elimina TODOS los datos de la cuenta de un usuario de forma aislada.
 */
export async function deleteAllUserData(uid) {
    if (!uid) return;
    const [incSnap, expSnap, walletsSnap] = await Promise.all([
        db.collection('transactions').doc(uid).collection('income').get(),
        db.collection('transactions').doc(uid).collection('expenses').get(),
        walletsRef(uid).get()
    ]);

    // Eliminar documentos en lotes
    const docsToDelete = [...incSnap.docs, ...expSnap.docs, ...walletsSnap.docs];
    for (let i = 0; i < docsToDelete.length; i += 400) {
        const batch = db.batch();
        docsToDelete.slice(i, i + 400).forEach(doc => batch.delete(doc.ref));
        await batch.commit();
    }

    // Resetear SOLO el plan financiero — NO tocar gmailImport para que el usuario no pierda su conexión Gmail
    try {
        await db.collection('plans').doc(uid).delete();
    } catch (_) {}

    await db.collection('users').doc(uid).set({
        monthlyTarget: 0,
        planConfig: { incomeTarget: 0, expenseLimit: 0 },
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    planCache.delete(uid);
}


/**
 * Lee una única transacción.
 */
export async function getTransactionById(uid, type, id) {
    const collection = type === 'income' ? 'income' : 'expenses';
    const doc = await db.collection('transactions').doc(uid).collection(collection).doc(id).get();
    return doc.exists ? doc.data() : null;
}

/** Historial inmutable asociado a un movimiento, para la vista de auditoría. */
export async function getTransactionAudit(uid, movementId) {
    let snapshot;
    try {
        // Server-side order and cap: opening one movement never downloads an
        // unbounded audit history as the account grows.
        snapshot = await auditRef(uid)
            .where('movementId', '==', movementId)
            .orderBy('recordedAt', 'desc')
            .limit(50)
            .get();
    } catch (error) {
        if (!isMissingIndex(error)) throw error;
        // Existing projects can continue working while Firestore builds the
        // composite index declared below.
        snapshot = await auditRef(uid).where('movementId', '==', movementId).get();
    }
    return snapshot.docs
        .map(doc => ({ id: doc.id, ...doc.data() }))
        .sort((a, b) => {
            const ams = a.recordedAt?.toDate?.()?.getTime?.() || 0;
            const bms = b.recordedAt?.toDate?.()?.getTime?.() || 0;
            return bms - ams;
        });
}

/**
 * Obtiene todas las transacciones ordenadas por fecha (para exportación).
 */
export async function getAllTransactionsOrdered(uid) {
    return sharedRead(`history:${uid}`, async () => {
    const [incSnap, expSnap] = await Promise.all([
        db.collection('transactions').doc(uid).collection('income').get(),
        db.collection('transactions').doc(uid).collection('expenses').get()
    ]);
    const txs = [];
    incSnap.docs.forEach(doc => txs.push({ id: doc.id, type: 'income', ...doc.data() }));
    expSnap.docs.forEach(doc => txs.push({ id: doc.id, type: 'expense', ...doc.data() }));
    const toMs = (item) => item.occurredAt?.toDate?.()?.getTime?.() || item.date?.toDate?.()?.getTime?.() || item.createdAt?.toDate?.()?.getTime?.() || 0;
    txs.sort((a, b) => toMs(b) - toMs(a));
    return txs;
    });
}
