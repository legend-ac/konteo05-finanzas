// js/services/dbService.js — Firestore CRUD operations

import { db, firebase } from '../firebase/config.js';
import { businessDateString, transactionBusinessDate } from '../ui/helpers.js';

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
    try {
        const doc = await db.collection('plans').doc(uid).get();
        if (doc.exists) return doc.data();
    } catch (_) { }

    // Fallback for environments where /plans rules are not deployed yet.
    const userDoc = await db.collection('users').doc(uid).get();
    const userData = userDoc.exists ? userDoc.data() : {};
    const planConfig = userData.planConfig || {};
    return {
        incomeTarget: Number(planConfig.incomeTarget || 0),
        expenseLimit: Number(planConfig.expenseLimit || 0)
    };
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
}

/**
 * Obtiene transacciones desde una fecha de inicio.
 */
export async function getTransactions(uid, startTs) {
    const incomeRef = db.collection('transactions').doc(uid).collection('income');
    const expenseRef = db.collection('transactions').doc(uid).collection('expenses');

    let incomeDocs = [];
    let expenseDocs = [];

    try {
        // Query by `date` for current schema and by `createdAt` for legacy docs.
        const [incomeByDate, incomeByCreatedAt, expenseByDate, expenseByCreatedAt] = await Promise.all([
            incomeRef.where('date', '>=', startTs).get(),
            incomeRef.where('createdAt', '>=', startTs).get(),
            expenseRef.where('date', '>=', startTs).get(),
            expenseRef.where('createdAt', '>=', startTs).get()
        ]);
        incomeDocs = [...incomeByDate.docs, ...incomeByCreatedAt.docs];
        expenseDocs = [...expenseByDate.docs, ...expenseByCreatedAt.docs];
    } catch (_) {
        // Safe fallback if indexed queries are not available yet.
        const [incomeSnap, expenseSnap] = await Promise.all([
            incomeRef.get(),
            expenseRef.get()
        ]);
        incomeDocs = incomeSnap.docs;
        expenseDocs = expenseSnap.docs;
    }

    const uniqueById = (docs) => {
        const map = new Map();
        docs.forEach((doc) => map.set(doc.id, doc));
        return [...map.values()];
    };

    return {
        incomeItems: uniqueById(incomeDocs).map(doc => ({ id: doc.id, type: 'income', ...doc.data() })),
        expenseItems: uniqueById(expenseDocs).map(doc => ({ id: doc.id, type: 'expense', ...doc.data() }))
    };
}

/**
 * Obtiene todos los IDs de Gmail e identificadores de transacciones previamente guardados en Firestore.
 * Filtra a los últimos 90 días para evitar consultas masivas y compara usando
 * el día operativo oficial de Konteo (America/Lima).
 */
export async function getImportedGmailIds(uid) {
    // Limitar a 90 días — mismo máximo que fetchTransactionEmails
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 90);
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
    } catch (_) {
        // Fallback sin filtro si el índice no está disponible
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

async function saveTransaction(uid, type, data, editId = null, requestId = null) {
    const collection = type === 'income' ? 'income' : 'expenses';
    const txRef = db.collection('transactions').doc(uid).collection(collection)
        .doc(editId || requestId || db.collection('_ids').doc().id);
    const current = await txRef.get();

    // A repeated click/network retry must be a no-op, never an extra movement
    // nor a second audit event.
    if (!editId && current.exists) return txRef.id;

    const operationDate = data.operationDate || businessDateString(data.date?.toDate?.() || new Date());
    const reference = data.reference || `${type === 'income' ? 'ING' : 'GAS'}-${txRef.id}`;
    const base = cleanObject({
        ...data,
        operationDate,
        reference,
        operationType: data.operationType || type,
        status: data.status || 'completed',
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    const batch = db.batch();

    if (current.exists) {
        // occurredAt describes the original operation, not the time someone
        // corrected a note/category later. Updates are tracked by updatedAt.
        delete base.occurredAt;
        batch.update(txRef, base);
        const eventRef = auditRef(uid).doc(`update_${txRef.id}_${Date.now()}`);
        batch.set(eventRef, cleanObject({
            eventType: 'updated', movementId: txRef.id, operationType: type,
            operationDate, reference, actorUid: data.actorUid || uid,
            recordedAt: firebase.firestore.FieldValue.serverTimestamp(),
            before: auditSnapshot(current.data()), after: auditSnapshot(base)
        }));
    } else {
        const created = { ...base, createdAt: firebase.firestore.FieldValue.serverTimestamp() };
        batch.set(txRef, created);
        batch.set(auditRef(uid).doc(`create_${txRef.id}`), cleanObject({
            eventType: 'created', movementId: txRef.id, operationType: type,
            operationDate, reference, actorUid: data.actorUid || uid,
            actorEmail: data.actorEmail || '',
            occurredAt: data.occurredAt || firebase.firestore.Timestamp.fromDate(new Date()),
            recordedAt: firebase.firestore.FieldValue.serverTimestamp(),
            snapshot: auditSnapshot(created)
        }));
    }

    await batch.commit();
    return txRef.id;
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

/**
 * Elimina TODOS los datos de la cuenta de un usuario de forma aislada.
 */
export async function deleteAllUserData(uid) {
    if (!uid) return;
    const [incSnap, expSnap] = await Promise.all([
        db.collection('transactions').doc(uid).collection('income').get(),
        db.collection('transactions').doc(uid).collection('expenses').get()
    ]);

    // Eliminar documentos en lotes
    const docsToDelete = [...incSnap.docs, ...expSnap.docs];
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
    const snapshot = await auditRef(uid).where('movementId', '==', movementId).get();
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
}
