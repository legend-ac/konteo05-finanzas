// js/services/dbService.js — Firestore CRUD operations

import { db, firebase } from '../firebase/config.js';

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
 * Filtra a los últimos 90 días para evitar consultas masivas y usa UTC para consistencia de fechas.
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
        // Generar clave de dedup usando UTC para evitar desfase de timezone
        const dateObj = data.date?.toDate ? data.date.toDate() : (data.createdAt?.toDate ? data.createdAt.toDate() : null);
        if (dateObj && data.amount) {
            // UTC para coincidir con el parser (que usa la fecha del email, que Gmail reporta en UTC)
            const dateStr = `${dateObj.getUTCFullYear()}-${String(dateObj.getUTCMonth() + 1).padStart(2, '0')}-${String(dateObj.getUTCDate()).padStart(2, '0')}`;
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
export async function saveIncome(uid, data, editId = null, requestId = null) {
    const colRef = db.collection('transactions').doc(uid).collection('income');
    if (editId) {
        await colRef.doc(editId).update(data);
    } else {
        const payload = { ...data, createdAt: firebase.firestore.FieldValue.serverTimestamp() };
        // Si hay requestId (ej: gmail_<id>), se usa .set con merge para evitar documentos duplicados en Firestore
        if (requestId) await colRef.doc(requestId).set(payload, { merge: true });
        else await colRef.add(payload);
    }
}

/**
 * Guarda o actualiza un gasto.
 */
export async function saveExpense(uid, data, editId = null, requestId = null) {
    const colRef = db.collection('transactions').doc(uid).collection('expenses');
    if (editId) {
        await colRef.doc(editId).update(data);
    } else {
        const payload = { ...data, createdAt: firebase.firestore.FieldValue.serverTimestamp() };
        if (requestId) await colRef.doc(requestId).set(payload, { merge: true });
        else await colRef.add(payload);
    }
}

/**
 * Elimina una transacción.
 */
export async function deleteTransaction(uid, type, id) {
    const collection = type === 'income' ? 'income' : 'expenses';
    await db.collection('transactions').doc(uid).collection(collection).doc(id).delete();
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
    const toMs = (item) => item.date?.toDate?.()?.getTime?.() || item.createdAt?.toDate?.()?.getTime?.() || 0;
    txs.sort((a, b) => toMs(b) - toMs(a));
    return txs;
}
