const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness() {
    const docs = new Map();
    let nextId = 0, queue = Promise.resolve(), collectionReads = 0;
    let queryError = null;
    const timestamp = date => ({ toDate: () => date, toMillis: () => date.getTime() });
    function ref(p) {
        return {
            path: p, id: p.split('/').at(-1), collection: name => ref(p + '/' + name),
            doc: id => ref(p + '/' + (id || 'auto-' + ++nextId)),
            get: async () => snap(p),
            set: async (data, options) => docs.set(p, options?.merge ? { ...docs.get(p), ...data } : data),
            delete: async () => docs.delete(p),
            where: () => query(p), orderBy: () => query(p), limit: () => query(p)
        };
    }
    function snap(p) { return { exists: docs.has(p), id: p.split('/').at(-1), ref: ref(p), data: () => docs.get(p) }; }
    function query(p) {
        return { where: () => query(p), orderBy: () => query(p), limit: () => query(p), get: async () => {
            collectionReads++;
            if (queryError) throw queryError;
            return { docs: [...docs.keys()].filter(k => k.startsWith(p + '/') && !k.slice(p.length + 1).includes('/')).map(snap) };
        } };
    }
    const db = { collection: name => {
        const collection = ref(name);
        const wrap = item => ({ ...item,
            collection: name => wrap(ref(item.path + '/' + name)),
            doc: id => wrap(ref(item.path + '/' + (id || 'auto-' + ++nextId))),
            get: item.path.split('/').length % 2 ? query(item.path).get : item.get
        });
        return wrap(collection);
    }, runTransaction: callback => {
        // Serial server simulation; asserts read-before-write and immutable audit.
        const run = queue.then(async () => {
            const writes = [];
            const transaction = {
                get: async reference => { assert.equal(writes.length, 0, 'read after write'); return snap(reference.path); },
                set: (reference, data) => writes.push({ reference, data }),
                update: (reference, data) => writes.push({ reference, data, update: true }),
                delete: reference => writes.push({ reference, remove: true })
            };
            const result = await callback(transaction);
            for (const { reference } of writes) {
                if (reference.path.includes('/auditLogs/') && docs.has(reference.path)) throw Object.assign(new Error('immutable audit'), { code: 'permission-denied' });
            }
            for (const { reference, data, update, remove } of writes) {
                if (remove) docs.delete(reference.path);
                else docs.set(reference.path, update ? { ...docs.get(reference.path), ...data } : data);
            }
            return result;
        });
        queue = run.catch(() => {});
        return run;
    } };
    const context = vm.createContext({
        console, Date, Intl, Map, Set, URL, Promise, setTimeout, clearTimeout,
        localStorage: { getItem: () => null, setItem: () => {} },
        window: { AbortController, __KONTEO_FIREBASE_CONFIG__: { gmailClientId: 'test' } }
    });
    const modules = new Map();
    async function load(file) {
        file = path.resolve(file);
        if (modules.has(file)) return modules.get(file);
        let module;
        if (file.endsWith(path.normalize('firebase/config.js'))) {
            module = new vm.SyntheticModule(['db', 'firebase'], function () {
                this.setExport('db', db);
                this.setExport('firebase', { firestore: { Timestamp: { fromDate: timestamp }, FieldValue: { serverTimestamp: () => timestamp(new Date()) } } });
            }, { context, identifier: file });
        } else module = new vm.SourceTextModule(fs.readFileSync(file, 'utf8'), { context, identifier: file });
        modules.set(file, module);
        await module.link((specifier, parent) => load(path.resolve(path.dirname(parent.identifier), specifier)));
        return module;
    }
    async function use(file) { const module = await load(file); if (module.status !== 'evaluated') await module.evaluate(); return module.namespace; }
    return { use, docs, context, timestamp, reads: () => collectionReads, setQueryError: error => { queryError = error; } };
}

test('institution identity separates banks from Plin and merges bank account aliases', async () => {
    const h = harness(), { movementIdentity } = await h.use('js/services/entityIdentity.js');
    const wallets = [{ id: 'ib', name: 'Cuenta Interbank', institution: 'Interbank' }, { id: 'bcp', name: 'Cuenta BCP' }];
    const bbva = movementIdentity({ source: 'gmail:plin-bbva', accountId: 'ib' }, wallets);
    assert.equal(bbva.id, 'institution:bbva');
    assert.equal(bbva.channel, 'Plin');
    assert.equal(bbva.accountConflict, true);
    assert.equal(movementIdentity({ source: 'gmail:plin-interbank' }).id, 'institution:interbank');
    assert.equal(movementIdentity({ source: 'gmail:bcp' }).id, movementIdentity({ accountId: 'bcp' }, wallets).id);
    assert.equal(movementIdentity({ source: 'gmail:plin', accountId: 'ib', accountAssignmentExplicit: true }, wallets).id, 'unresolved:plin');
    const incoming = movementIdentity({ source: 'gmail:plin', sourceSender: 'BBVA <procesos@bbva.com.pe>', note: 'Destino: Yape Interbank' });
    assert.equal(incoming.id, 'institution:bbva');
    assert.equal(movementIdentity({ source: 'gmail:plin', sourceRawText: 'Detalles de tu plineo\nEl equipo de BBVA\nwww.bbva.pe' }).id, 'institution:bbva');
    assert.equal(movementIdentity({ source: 'gmail:plin', sourceRawText: 'Constancia de Pago Plin\nInterbank Servicio al Cliente\nnetinterbank.com.pe\nDestino: BBVA' }).id, 'institution:interbank');
    assert.equal(movementIdentity({ source: 'gmail:plin', sourceRawText: 'Destino Interbank · Recibe con BBVA' }).id, 'unresolved:plin');
    assert.equal(movementIdentity({ source: 'gmail:plin', sourceSender: 'x@bbva.com.pe.evil.test' }).id, 'unresolved:plin');
});

test('Plin cannot link across banks or to an unidentified shared wallet', async () => {
    const h = harness(), { resolveWalletAccount, walletSuggestions } = await h.use('js/services/walletPolicy.js');
    const wallets = [
        { id: 'bbva', name: 'BBVA', sourceKey: 'bbva', active: true, linkSource: true },
        { id: 'ib', name: 'Interbank', sourceKey: 'interbank', active: true, linkSource: true },
        { id: 'plin', name: 'Plin', sourceKey: 'plin', active: true, linkSource: true }
    ];
    assert.equal(resolveWalletAccount({ source: 'gmail:plin-bbva' }, wallets), 'bbva');
    assert.equal(resolveWalletAccount({ source: 'gmail:plin-interbank' }, wallets), 'ib');
    assert.equal(resolveWalletAccount({ source: 'gmail:plin' }, wallets), '');
    const custom = [{ id: 'bbva', sender: 'procesos@bbva.com.pe', defaultAccountId: 'ib' }];
    assert.equal(resolveWalletAccount({ source: 'gmail:custom-bbva' }, wallets, custom), '');
    assert.equal(resolveWalletAccount({ source: 'gmail:plin-bbva' }, [{ ...wallets[1], sourceKey: 'plin-bbva' }]), '');
    assert.equal(walletSuggestions([], [{ source: 'gmail:plin' }]).length, 0);
    const suggestions = walletSuggestions([], [{ source: 'gmail:bbva' }, { source: 'gmail:plin-bbva' }]);
    assert.equal(suggestions.length, 1);
    assert.equal(suggestions[0].sourceKey, 'bbva');
    assert.equal(suggestions[0].count, 2);
});

test('known bank parser wins over a generic configured Plin entity and preserves late receipt time', async () => {
    const h = harness(), { parseAllEmails } = await h.use('js/services/gmailParser.js');
    const [tx] = parseAllEmails({
        rawMessages: [{ id: 'plin-late' }],
        decodeBody: () => 'Plineaste S/ 50.00 a Ana Ruiz\nDetalles de tu plineo\nDestino: Yape\nFecha y hora: 25 de septiembre, 2026 23:12',
        getSender: () => 'BBVA <procesos@bbva.com.pe>',
        getDate: () => new Date('2026-09-27T10:00:00Z'),
        getSubject: () => 'Constancia de operación transferencia PLIN',
        customEntities: [{ id: 'plin', name: 'Plin', sender: 'procesos@bbva.com.pe', active: true }]
    });
    assert.equal(tx.source, 'bbva');
    assert.equal(tx.sourceSender, 'BBVA <procesos@bbva.com.pe>');
    assert.equal(tx.amount, 50);
    assert.equal(tx.date, '2026-09-25');
    assert.equal(tx.occurredAt.toISOString(), '2026-09-26T04:12:00.000Z');
});

test('manual bank identification is narrow, audited, correctable and cannot replace known provenance', async () => {
    const h = harness(), api = await h.use('js/services/dbService.js');
    const ref = 'transactions/u/expenses/old-plin';
    const original = { source: 'gmail:plin', amount: 50, accountId: 'legacy', date: h.timestamp(new Date('2026-09-25T05:00:00Z')), note: 'Pago' };
    h.docs.set(ref, original);
    await api.identifyMovementInstitution('u', 'expense', 'old-plin', 'bbva');
    assert.equal(h.docs.get(ref).sourceInstitutionOverride, 'bbva');
    assert.equal(h.docs.get(ref).amount, original.amount);
    assert.equal(h.docs.get(ref).accountId, original.accountId);
    assert.equal(h.docs.get(ref).date, original.date);
    await api.identifyMovementInstitution('u', 'expense', 'old-plin', 'interbank');
    assert.equal(h.docs.get(ref).sourceInstitutionOverride, 'interbank');
    assert.equal([...h.docs.keys()].filter(key => key.includes('/auditLogs/')).length, 2);
    h.docs.set(ref, { ...original, source: 'gmail:plin-bbva' });
    await assert.rejects(api.identifyMovementInstitution('u', 'expense', 'old-plin', 'interbank'), /ya tiene un banco/);
    await assert.rejects(api.identifyMovementInstitution('u', 'expense', 'old-plin', 'invalid'), /válido/);
});

test('import retains automatic assignment flag instead of declaring it a user decision', async () => {
    const h = harness(), api = await h.use('js/services/dbService.js');
    await api.saveExpense('u', { amount: 5, category: 'yellow', date: h.timestamp(new Date('2026-09-25')), accountId: '', accountAssignmentExplicit: false }, null, 'automatic');
    assert.equal(h.docs.get('transactions/u/expenses/automatic').accountAssignmentExplicit, false);
});

test('concurrent Gmail saves create one movement and one immutable audit', async () => {
    const h = harness(), api = await h.use('js/services/dbService.js');
    const payload = { amount: 12, category: 'yellow', date: h.timestamp(new Date('2026-01-01')), gmailId: 'abc' };
    await Promise.all(Array.from({ length: 8 }, () => api.saveExpense('u', payload, null, 'gmail_abc')));
    assert.equal([...h.docs.keys()].filter(k => k.includes('/expenses/')).length, 1);
    assert.equal([...h.docs.keys()].filter(k => k.includes('/auditLogs/')).length, 1);
    await api.saveIncome('u', payload, null, 'gmail_abc');
    assert.equal([...h.docs.keys()].filter(k => k.includes('/income/')).length, 0);
});
test('reimport after deletion appends audit without changing original event', async () => {
    const h = harness(), api = await h.use('js/services/dbService.js');
    const payload = { amount: 12, category: 'yellow', date: h.timestamp(new Date('2026-01-01')), gmailId: 'abc' };
    await api.saveExpense('u', payload, null, 'gmail_abc');
    const original = h.docs.get('users/u/auditLogs/create_gmail_abc');
    h.docs.delete('transactions/u/expenses/gmail_abc');
    await api.saveExpense('u', payload, null, 'gmail_abc');
    assert.equal(h.docs.get('users/u/auditLogs/create_gmail_abc'), original);
    assert.equal([...h.docs.keys()].filter(k => k.includes('/auditLogs/')).length, 2);
});
test('edits do not resurrect deleted records, invalid amounts never write', async () => {
    const h = harness(), api = await h.use('js/services/dbService.js');
    const valid = { amount: 12, category: 'yellow', date: h.timestamp(new Date('2026-01-01')) };
    await assert.rejects(api.saveExpense('u', valid, 'missing'), /ya no existe/);
    await assert.rejects(api.saveExpense('u', { ...valid, amount: Infinity }), /monto/);
    assert.equal(h.docs.size, 0);
});
test('transfers are atomic and reject same-account or cross-currency operations', async () => {
    const h = harness(), api = await h.use('js/services/dbService.js');
    h.docs.set('users/u/wallets/a', { currency: 'PEN', active: true });
    h.docs.set('users/u/wallets/b', { currency: 'PEN', active: true });
    const payload = { amount: 15, date: h.timestamp(new Date('2026-01-01')), fromAccountId: 'a', toAccountId: 'b' };
    await Promise.all([api.saveTransfer('u', payload, 'one'), api.saveTransfer('u', payload, 'one')]);
    assert.equal([...h.docs.keys()].filter(k => k.startsWith('transactions/')).length, 2);
    await assert.rejects(api.saveTransfer('u', { ...payload, toAccountId: 'a' }, 'bad'), /distintas/);
    h.docs.set('users/u/wallets/b', { currency: 'USD' });
    await assert.rejects(api.saveTransfer('u', payload, 'two'), /monedas/);
});
test('simultaneous account loads share reads and never create unsolicited accounts', async () => {
    const h = harness(), api = await h.use('js/services/dbService.js');
    h.docs.set('users/u/wallets/system-yape', { name: 'Mi Yape', openingBalance: 150, active: false });
    await Promise.all([api.getWallets('u'), api.getWallets('u'), api.getWallets('u')]);
    assert.equal(h.reads(), 1);
    assert.equal(h.docs.get('users/u/wallets/system-yape').openingBalance, 150);
    assert.equal(h.docs.get('users/u/wallets/system-yape').active, false);
    assert.equal([...h.docs.keys()].filter(k => k.includes('/wallets/')).length, 1);
});
test('permission failures do not trigger unbounded fallback queries', async () => {
    const h = harness(), api = await h.use('js/services/dbService.js');
    h.setQueryError(Object.assign(new Error('denied'), { code: 'permission-denied' }));
    await assert.rejects(api.getImportedGmailIds('u'), /denied/);
    assert.equal(h.reads(), 2);
});

test('wallet choices include configured entities and imported Banco de la Nacion, without creating accounts', async () => {
    const h = harness(), policy = await h.use('js/services/walletPolicy.js');
    const entities = [{ id: 'bn', name: 'Banco de la Nación', sender: 'bn@test.pe', active: true }];
    const transactions = [{ source: 'gmail:nacion', amount: 38.85 }, { source: 'gmail:custom-bn', amount: 10 }];
    const choices = policy.walletSuggestions([], transactions, entities);
    assert.equal(choices.length, 2);
    assert.ok(choices.every(choice => choice.name === 'Banco de la Nación'));
    assert.equal(choices.find(choice => choice.sourceKey === 'nacion').count, 1);
    assert.equal(policy.resolveWalletAccount(transactions[0], []), '');
    assert.equal(h.docs.size, 0);
    assert.equal(policy.walletSuggestions([], [], []).length, 0);
});

test('legacy automatic accounts require a choice, while edited and funded accounts remain active', async () => {
    const h = harness(), policy = await h.use('js/services/walletPolicy.js');
    const original = { id: 'system-bcp', systemDefault: true, sourceKey: 'bcp', active: true,
        createdAt: h.timestamp(new Date(0)), updatedAt: h.timestamp(new Date(0)) };
    assert.equal(policy.isActiveWallet(original), false);
    assert.equal(policy.resolveWalletAccount({ source: 'gmail:bcp' }, [original]), '');
    assert.equal(policy.isActiveWallet({ ...original, userConfirmed: true }), true);
    assert.equal(policy.isActiveWallet({ ...original, openingBalance: 100 }), true);
    assert.equal(policy.isActiveWallet({ ...original, updatedAt: h.timestamp(new Date(1)) }), true);
    assert.equal(policy.isActiveWallet({ ...original, active: false }), false);
    assert.equal(policy.walletSuggestions([original], [{ source: 'gmail:bcp' }]).length, 0);
});

test('wallet source linking requires consent and preserves explicit assignments and ambiguity', async () => {
    const h = harness(), policy = await h.use('js/services/walletPolicy.js');
    const wallet = { id: 'bn', sourceKey: 'nacion', userConfirmed: true, active: true };
    const tx = { source: 'gmail:nacion', accountId: '' };
    assert.equal(policy.resolveWalletAccount(tx, [wallet]), '');
    wallet.linkSource = true;
    assert.equal(policy.resolveWalletAccount(tx, [wallet]), 'bn');
    assert.equal(policy.resolveWalletAccount({ ...tx, accountId: 'other' }, [wallet]), 'other');
    assert.equal(policy.resolveWalletAccount({ ...tx, accountAssignmentExplicit: true }, [wallet]), '');
    assert.equal(policy.resolveWalletAccount(tx, [wallet, { ...wallet, id: 'second' }]), '');
    assert.equal(policy.resolveWalletAccount(tx, [{ ...wallet, active: false }]), '');
    const entities = [{ id: 'custom', defaultAccountId: 'bn' }];
    assert.equal(policy.resolveWalletAccount({ source: 'gmail:custom-custom' }, [wallet], entities), 'bn');
    assert.equal(policy.resolveWalletAccount({ source: 'custom-custom' }, [wallet], entities), 'bn');
});

test('saving a reviewed wallet persists consent and archiving does not recreate defaults', async () => {
    const h = harness(), api = await h.use('js/services/dbService.js');
    h.docs.set('users/u/wallets/system-bcp', { systemDefault: true, sourceKey: 'bcp', name: 'Cuenta BCP', openingBalance: 0 });
    await api.saveWallet('u', { name: 'Mi BCP', linkSource: true }, 'system-bcp');
    const saved = h.docs.get('users/u/wallets/system-bcp');
    assert.equal(saved.userConfirmed, true);
    assert.equal(saved.sourceKey, 'bcp');
    assert.equal(saved.linkSource, true);
    await api.archiveWallet('u', 'system-bcp');
    const wallets = await api.getWallets('u');
    assert.equal(wallets.length, 1);
    assert.equal(wallets[0].active, false);
});
test('import worker bounds concurrency, stops scheduling after failure and preserves unstarted items', async () => {
    const h = harness(), { runLimited, withDeadline } = await h.use('js/services/asyncControl.js');
    let active = 0, peak = 0, calls = 0;
    const results = await runLimited(Array.from({ length: 120 }, (_, i) => i), async value => {
        active++; calls++; peak = Math.max(peak, active);
        await new Promise(resolve => setTimeout(resolve, 1));
        active--;
        if (value === 0) throw new Error('offline');
        return value;
    });
    assert.ok(peak <= 4);
    assert.equal(calls, 4);
    assert.equal(results.filter(Boolean).length, 4);
    await assert.rejects(withDeadline(() => new Promise(() => {}), 5, 'commit-unconfirmed'), error => error.code === 'commit-unconfirmed');
});
test('parser keeps different payments of equal amount and flags them instead of deleting', async () => {
    const h = harness(), { parseAllEmails } = await h.use('js/services/gmailParser.js');
    const options = {
        rawMessages: [{ id: 'one' }, { id: 'two' }, { id: 'one' }],
        decodeBody: () => 'Pago realizado. Monto S/ 12.00', getSender: () => 'bank@test.pe',
        getDate: () => new Date('2026-01-01T15:00:00Z'), getSubject: () => 'Pago realizado',
        customEntities: [{ id: 'bank', name: 'Banco', sender: 'bank@test.pe', defaultType: 'expense', active: true }]
    };
    const results = parseAllEmails(options);
    assert.equal(results.length, 2);
    assert.equal(results[1].possibleDuplicate, true);
    assert.equal(parseAllEmails({ ...options, existingIds: new Set(['one']) }).length, 1);
});
test('parser prioritizes receipt date and preserves the receipt reason', async () => {
    const h = harness(), { parseAllEmails } = await h.use('js/services/gmailParser.js');
    const results = parseAllEmails({
        rawMessages: [{ id: 'receipt-1' }],
        decodeBody: () => [
            'Pago realizado',
            'Fecha de operación: 14/02/2026 18:30',
            'Monto: S/ 25.90',
            'Motivo: Cena con amigos'
        ].join('\n'),
        getSender: () => 'bank@test.pe',
        getDate: () => new Date('2026-02-20T23:45:00Z'),
        getSubject: () => 'Confirmación de pago',
        customEntities: [{ id: 'bank', name: 'Banco', sender: 'bank@test.pe', defaultType: 'expense', active: true }]
    });
    assert.equal(results.length, 1);
    assert.equal(results[0].date, '2026-02-14');
    assert.equal(results[0].description, 'Cena con amigos');
    assert.equal(results[0].receiptDescription, 'Cena con amigos');
    assert.equal(results[0].receiptDateSource, 'receipt');
    assert.equal(results[0].emailReceivedAt.toISOString(), '2026-02-20T23:45:00.000Z');
    assert.equal(results[0].occurredAt.toISOString(), '2026-02-14T23:30:00.000Z');
});
test('BBVA PLIN QR receipts from procesos are imported as outgoing PLIN payments', async () => {
    const h = harness(), { parseAllEmails } = await h.use('js/services/gmailParser.js');
    const results = parseAllEmails({
        rawMessages: [{ id: 'bbva-plin-1' }],
        decodeBody: () => [
            'Plineaste S/ 16.00 a Liz N Poma M',
            'Tipo de operacion: Pago con QR',
            'Destino: Yape',
            'Fecha y hora: 26 de septiembre, 2026 00:43'
        ].join('\n'),
        getSender: () => 'BBVA <procesos@bbva.com.pe>',
        getDate: () => new Date('2026-09-26T05:43:00Z'),
        getSubject: () => 'Constancia de operacion transferencia PLIN con QR'
    });
    assert.equal(results.length, 1);
    assert.equal(results[0].type, 'expense');
    assert.equal(results[0].source, 'bbva');
    assert.equal(results[0].sourceLabel, 'BBVA');
    assert.equal(results[0].paymentChannel, 'Plin');
    assert.equal(results[0].amount, 16);
    assert.equal(results[0].description, 'Pago a Liz N Poma M');
    assert.equal(results[0].date, '2026-09-26');
    assert.equal(results[0].receiptDateSource, 'receipt');
});
test('BBVA QR merchant receipts retain the bank without inventing a Plin channel', async () => {
    const h = harness(), { parseAllEmails } = await h.use('js/services/gmailParser.js');
    const results = parseAllEmails({
        rawMessages: [{ id: 'bbva-qr-merchant-1' }],
        decodeBody: () => [
            'Constancia de pago a comercios con QR',
            'Comercio: Bodega Central',
            'Monto: S/ 42.50',
            'Fecha y hora: 27/09/2026 19:21'
        ].join('\n'),
        getSender: () => 'BBVA <procesos@bbva.com.pe>',
        getDate: () => new Date('2026-09-28T00:21:00Z'),
        getSubject: () => 'Constancia de pago a comercios con QR'
    });
    assert.equal(results.length, 1);
    assert.equal(results[0].type, 'expense');
    assert.equal(results[0].source, 'bbva');
    assert.equal(results[0].sourceLabel, 'BBVA');
    assert.equal(results[0].paymentChannel, 'QR');
    assert.equal(results[0].amount, 42.5);
    assert.equal(results[0].date, '2026-09-27');
});
test('Plin advertising does not change a BBVA card operation into a Plin payment', async () => {
    const h = harness(), { parseEmail } = await h.use('js/services/gmailParser.js');
    const tx = parseEmail({ message: { id: 'card' }, sender: 'procesos@bbva.com.pe', date: new Date('2026-09-25T15:00:00Z'),
        subject: 'Consumo con tu tarjeta', bodyText: 'Monto del consumo: S/ 20.00\nComercio: Tienda Central\n¿Necesitas pagar tus servicios? Hazlo con Plin BBVA.' });
    assert.equal(tx.source, 'bbva');
    assert.equal(tx.amount, 20);
});

test('BBVA PLIN receipt delivered by the BBVA gateway remains importable', async () => {
    const h = harness(), { parseAllEmails } = await h.use('js/services/gmailParser.js');
    const results = parseAllEmails({
        rawMessages: [{ id: 'bbva-gateway-plin-1' }],
        decodeBody: () => [
            'Plineaste S/ 50.00 a Andy J Cordova E',
            'Detalles de tu plineo',
            'Destino: Yape',
            'ITF: S/ 0.00',
            'Fecha y hora: 25 de setiembre, 2026 23:12',
            'Número de operación: BA53EF0A1DF1'
        ].join('\n'),
        // Some Gmail deliveries expose the gateway address instead of the
        // visible BBVA From header. Both must route to the BBVA parser.
        getSender: () => 'notifications-gateway-mail-us.bbva.com.pe',
        getDate: () => new Date('2026-09-26T04:12:00Z'),
        getSubject: () => 'Constancia de operación transferencia PLIN'
    });
    assert.equal(results.length, 1);
    assert.equal(results[0].type, 'expense');
    assert.equal(results[0].source, 'bbva');
    assert.equal(results[0].paymentChannel, 'Plin');
    assert.equal(results[0].amount, 50);
    assert.equal(results[0].description, 'Pago a Andy J Cordova E');
    assert.equal(results[0].date, '2026-09-25');
});
test('Interbank Plin receipts are identified as Interbank even when their destination is BBVA', async () => {
    const h = harness(), { parseAllEmails } = await h.use('js/services/gmailParser.js');
    const results = parseAllEmails({
        rawMessages: [{ id: 'interbank-plin-1' }],
        decodeBody: () => [
            'Constancia de Pago Plin',
            'Monto y moneda: S/ 23.50',
            'Destinatario: Ana Ruiz',
            'Destino: BBVA',
            'Fecha y hora: 25/09/2026 13:45'
        ].join('\n'),
        getSender: () => 'Interbank Servicio al Cliente <servicioalcliente@netinterbank.com.pe>',
        getDate: () => new Date('2026-09-25T18:45:00Z'),
        getSubject: () => 'Constancia de Pago Plin'
    });
    assert.equal(results.length, 1);
    assert.equal(results[0].source, 'interbank');
    assert.equal(results[0].sourceLabel, 'Interbank');
    assert.equal(results[0].paymentChannel, 'Plin');
    assert.equal(results[0].amount, 23.5);
});
test('Gmail follows page tokens and avoids downloading previously imported messages', async () => {
    const h = harness();
    const urls = [];
    h.context.window.google = { accounts: { oauth2: { initTokenClient: config => ({ requestAccessToken: () => config.callback({ access_token: 'test', expires_in: 3600 }) }) } } };
    h.context.fetch = async url => {
        const parsed = new URL(url); urls.push(parsed);
        const result = parsed.pathname.endsWith('/profile') ? { emailAddress: 'test@example.com' }
            : parsed.pathname.endsWith('/messages') ? (parsed.searchParams.has('pageToken')
                ? { messages: [{ id: 'new' }] } : { messages: [{ id: 'old' }], nextPageToken: 'page2' })
                : { id: parsed.pathname.split('/').at(-1) };
        return { ok: true, status: 200, json: async () => result };
    };
    const api = await h.use('js/services/gmailService.js');
    await api.requestGmailToken();
    const messages = await api.fetchTransactionEmails(30, [{ sender: 'bank@test.pe' }], { onlyConfiguredEntities: true, existingIds: new Set(['old']) });
    assert.equal(messages.length, 1);
    assert.equal(messages[0].id, 'new');
    assert.ok(urls.some(url => url.searchParams.get('pageToken') === 'page2'));
    assert.ok(!urls.some(url => url.pathname.endsWith('/messages/old')));
});

test('Gmail decoder preserves UTF-8 names and table boundaries in HTML receipts', async () => {
    const h = harness();
    h.context.TextDecoder = TextDecoder;
    h.context.Uint8Array = Uint8Array;
    h.context.atob = value => Buffer.from(value, 'base64').toString('latin1');
    h.context.document = { createElement: () => ({
        set innerHTML(value) { this.value = value; },
        get innerText() { return this.value.replace(/<[^>]+>/g, '').replace(/\n\s+/g, '\n'); },
        get textContent() { return this.innerText; }
    }) };
    const { decodeEmailBody } = await h.use('js/services/gmailService.js');
    const html = '<table><tr><td>Plineaste</td><td>S/ 50.00</td></tr><tr><td>Destinatario</td><td>José Núñez</td></tr></table>';
    const encoded = Buffer.from(html, 'utf8').toString('base64url');
    const result = decodeEmailBody({ payload: { mimeType: 'text/html', body: { data: encoded } } });
    assert.match(result, /Plineaste\s+S\/ 50\.00/);
    assert.match(result, /José Núñez/);
});
