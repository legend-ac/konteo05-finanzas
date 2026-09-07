// DOM/event regression tests. These do not substitute for browser visual QA.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const postcss = require('postcss');

test('Frontend navigation, dialogs and existing Gmail workflow', async t => {
    const dom = new JSDOM(fs.readFileSync('index.html', 'utf8'), { url: 'http://localhost', runScripts: 'outside-only' });
    const { window } = dom;
    const document = window.document;
    t.after(() => window.close());
    const errors = [];
    window.addEventListener('error', event => errors.push(event.error));
    window.matchMedia = () => ({ matches: true });
    window.scrollTo = () => {};
    const context = dom.getInternalVMContext();
    const modules = new Map();
    const wallets = [{ id: 'bcp', name: 'BCP', active: true, openingBalance: 0 }];
    let preference = { enabled: true, email: 'demo@example.com', customEntities: [] };
    const saves = [];
    let releaseSave;
    const dbService = {
        getWallets: async () => wallets,
        seedDefaultWallets: async () => wallets,
        getAllTransactionsOrdered: async () => [],
        getTransactions: async () => ({ incomeItems: [], expenseItems: [] }),
        getPlan: async () => null,
        getImportedGmailIds: async () => ({ gmailIds: new Set(), existingTxKeys: new Set() }),
        saveExpense: async (_uid, data) => { saves.push(data); await new Promise(resolve => { releaseSave = resolve; }); },
        saveIncome: async () => {}
    };
    const gmailFixtures = [{ gmailId: 'mail-1', source: 'bcp', sourceLabel: 'BCP', type: 'expense', category: 'yellow', amount: 12, description: 'Compra de prueba', date: '2026-09-01', currency: 'PEN' }];
    const timestamp = { fromDate: date => ({ toDate: () => date, toMillis: () => date.getTime() }) };
    const config = {
        auth: { onAuthStateChanged: () => {}, getRedirectResult: async () => null },
        firebase: { firestore: { Timestamp: timestamp, FieldValue: { serverTimestamp: () => null } } },
        db: { collection: () => ({ doc: () => ({
            get: async () => ({ exists: true, data: () => ({ gmailImport: preference }) }),
            set: async data => { preference = data.gmailImport; }
        }) }) }
    };
    const gmailService = {
        initGmailService: async () => {}, requestGmailToken: async () => 'token', isTokenValid: () => true,
        revokeGmailToken: () => {}, fetchTransactionEmails: async () => [],
        decodeEmailBody: () => '', getEmailSender: () => '', getEmailDate: () => '', getEmailSubject: () => '',
        getConnectedEmail: () => 'demo@example.com'
    };
    function synthetic(identifier, values) {
        return new vm.SyntheticModule(Object.keys(values), function () {
            for (const [name, value] of Object.entries(values)) this.setExport(name, value);
        }, { context, identifier });
    }
    async function load(identifier) {
        identifier = path.resolve(identifier);
        if (modules.has(identifier)) return modules.get(identifier);
        const normalized = identifier.replaceAll('\\', '/');
        let module;
        if (normalized.endsWith('/firebase/config.js')) module = synthetic(identifier, config);
        else if (normalized.endsWith('/services/gmailService.js')) module = synthetic(identifier, gmailService);
        else if (normalized.endsWith('/services/gmailParser.js')) module = synthetic(identifier, { parseAllEmails: () => gmailFixtures });
        else if (normalized.endsWith('/services/dbService.js')) module = synthetic(identifier, dbService);
        else if (normalized.endsWith('/ui/charts.js')) module = synthetic(identifier, { renderCharts: () => {} });
        else if (normalized.endsWith('/ui/insights.js')) module = synthetic(identifier, { updateStrategyPanel: () => {}, loadPlanConfigToUi: () => {}, savePlanConfigFromUi: async () => {} });
        else if (normalized.endsWith('/services/exportService.js')) module = synthetic(identifier, { exportToExcel: async () => {}, exportToPDF: async () => {} });
        else module = new vm.SourceTextModule(fs.readFileSync(identifier, 'utf8'), { context, identifier });
        modules.set(identifier, module);
        await module.link((specifier, parent) => load(path.resolve(path.dirname(parent.identifier), specifier)));
        return module;
    }
    const app = await load('js/app.js');
    await app.evaluate();
    const state = (await load('js/state.js')).namespace.state;
    const modals = (await load('js/ui/modals.js')).namespace;
    const gmail = (await load('js/ui/gmailImport.js')).namespace;
    const render = (await load('js/ui/render.js')).namespace;
    const click = selector => {
        const button = document.querySelector(selector);
        assert.ok(button, selector);
        // JSDOM's .click() does not focus controls as pointer interaction does.
        button.focus();
        button.click();
    };
    const settle = () => new Promise(resolve => setImmediate(resolve));
    const escape = () => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    document.getElementById('dashboard-page').classList.remove('hidden');

    await t.test('single navigation per layout, no duplicated header/action bar, valid IDs', () => {
        const ids = [...document.querySelectorAll('[id]')].map(node => node.id);
        assert.equal(new Set(ids).size, ids.length);
        assert.equal(document.querySelectorAll('.desktop-nav .app-nav-link').length, 4);
        assert.equal(document.querySelectorAll('.mobile-nav .app-nav-link').length, 4);
        assert.equal(document.querySelector('.app-header [data-action="gmail"]'), null);
        assert.equal(document.getElementById('btn-gmail-import'), null);
        assert.equal(document.querySelector('.action-bar-mobile'), null);
        assert.equal(document.querySelector('.ledger-card footer'), null);
        assert.equal(document.querySelector('.mobile-nav [data-action="profile"]').textContent.trim(), 'Perfil');
        assert.ok(document.getElementById('category-filter').closest('details'));
    });
    await t.test('date drafts never change totals until Apply; invalid ranges are rejected', async () => {
        click('[data-filter="custom"]');
        assert.equal(state.currentFilter, 'today');
        document.getElementById('range-start').value = '2026-08-01';
        document.getElementById('range-end').value = '2026-08-07';
        click('#btn-apply-range');
        await settle();
        assert.equal(state.currentFilter, 'custom');
        assert.equal(state.customRangeStart, '2026-08-01');
        document.getElementById('range-start').value = '2026-08-20';
        click('#btn-apply-range');
        assert.equal(state.customRangeStart, '2026-08-01');
        click('[data-filter="week"]');
        assert.equal(state.currentFilter, 'week');
        assert.ok(document.getElementById('custom-range-panel').classList.contains('hidden'));
        assert.equal(document.querySelector('[data-filter="custom"]').getAttribute('aria-expanded'), 'false');
    });
    await t.test('empty search is not presented as first-time onboarding', () => {
        const list = document.getElementById('list');
        render.renderTransactionList(list, [], { hasFilters: true });
        assert.match(list.textContent, /No hay coincidencias/);
        assert.equal(list.querySelectorAll('.btn-open-income, .btn-open-expense').length, 0);
        render.renderTransactionList(list, []);
        assert.match(list.textContent, /Sin movimientos en este período/);
    });
    await t.test('wallet navigation retains accounts and supports mobile detail/back', async () => {
        state.currentUser = { uid: 'demo' };
        click('.mobile-nav [data-view="wallets"]');
        await settle();
        assert.equal(document.querySelectorAll('.wallet-list-item').length, 1);
        assert.equal(document.querySelector('.mobile-nav [data-view="wallets"]').getAttribute('aria-current'), 'page');
        click('[data-wallet-id="bcp"]');
        assert.ok(document.querySelector('.wallets-layout').classList.contains('is-detail-open'));
        click('[data-wallet-action="back"]');
        assert.ok(!document.querySelector('.wallets-layout').classList.contains('is-detail-open'));
        assert.equal(document.activeElement.dataset.walletId, 'bcp');
        click('.mobile-nav [data-view="home"]');
        state.currentUser = null;
    });
    await t.test('Gmail opens directly, nested settings close only the top dialog', async () => {
        await gmail.initGmailImport('demo');
        click('.mobile-nav [data-action="gmail"]');
        await settle();
        assert.ok(!document.getElementById('modal-gmail-import').classList.contains('hidden'));
        assert.equal(document.getElementById('gmail-btn-manage-entities').closest('.gmail-settings-link')?.className, 'gmail-settings-link');
        click('#gmail-btn-manage-entities');
        await settle();
        escape();
        assert.ok(document.getElementById('modal-gmail-entities').classList.contains('hidden'));
        assert.ok(!document.getElementById('modal-gmail-import').classList.contains('hidden'));
        assert.equal(document.body.style.overflow, 'hidden');
        assert.equal(document.activeElement.id, 'gmail-btn-manage-entities');
        escape();
        assert.equal(document.body.style.overflow, '');
        assert.equal(document.activeElement.dataset.action, 'gmail');
    });
    await t.test('Gmail preview retains category/account fields and guards duplicate clicks', async () => {
        await gmail.openGmailImport();
        click('#gmail-btn-sync');
        await settle();
        assert.equal(document.querySelectorAll('.gmail-tx-card').length, 1);
        assert.equal(document.querySelectorAll('.gmail-tx-fields select').length, 2);
        assert.ok(document.querySelector('.gmail-tx-check').getAttribute('aria-label'));
        click('#gmail-btn-import');
        click('#gmail-btn-import');
        escape();
        assert.equal(saves.length, 1);
        assert.ok(!document.getElementById('modal-gmail-import').classList.contains('hidden'));
        releaseSave();
        await settle();
        assert.equal(document.getElementById('modal-gmail-import').dataset.saving, 'false');
        assert.equal(document.getElementById('modal-gmail-import').dataset.state, 'success');
        modals.closeModal('modal-gmail-import');
    });
    await t.test('dialog traps Tab and restores focus after closing', () => {
        click('.mobile-nav [data-action="profile"]');
        const modal = document.getElementById('modal-profile');
        modal.focus();
        document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
        assert.ok(modal.contains(document.activeElement));
        escape();
        assert.equal(document.activeElement.dataset.action, 'profile');
        assert.equal(document.body.style.overflow, '');
    });
    await t.test('styles parse and the application stylesheet is cached for offline use', () => {
        postcss.parse(fs.readFileSync('css/styles.css', 'utf8'));
        const css = fs.readFileSync('css/workspace.css', 'utf8');
        postcss.parse(css);
        assert.ok(document.querySelector('link[href="css/workspace.css"]'));
        assert.match(fs.readFileSync('service-worker.js', 'utf8'), /'\/css\/workspace\.css'/);
        assert.match(css, /@media \(min-width: 768px\)/);
        assert.match(css, /\.wallets-layout\.is-detail-open/);
    });
    assert.deepEqual(errors, []);
});
