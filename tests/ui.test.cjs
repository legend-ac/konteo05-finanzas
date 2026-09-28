const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Minimal DOM for testing rendering decisions without Firebase or a browser.
class Element {
    constructor(tag) {
        this.tagName = tag;
        this.children = [];
        this.attributes = {};
        this.dataset = {};
        this.style = { setProperty: (key, value) => { this.style[key] = value; } };
        this.className = '';
        this.classList = { add: value => { this.className += ` ${value}`; }, toggle: (value, active) => { if (active) this.className += ` ${value}`; } };
    }
    set textContent(value) { this.text = value; this.children = []; }
    get textContent() { return this.text || this.children.map(el => el.textContent).join(''); }
    append(...elements) { this.children.push(...elements); }
    appendChild(element) { this.append(element); return element; }
    setAttribute(key, value) { this.attributes[key] = value; }
    querySelectorAll() { return []; }
}

async function renderer(file = 'render.js', elements = {}) {
    const context = vm.createContext({
        Date, Intl,
        document: {
            getElementById: id => elements[id],
            createElement: tag => new Element(tag),
            createElementNS: (_, tag) => new Element(tag),
            createDocumentFragment: () => new Element('fragment')
        }
    });
    const modules = new Map();
    async function load(file) {
        file = path.resolve(file);
        if (modules.has(file)) return modules.get(file);
        const module = new vm.SourceTextModule(fs.readFileSync(file, 'utf8'), { context, identifier: file });
        modules.set(file, module);
        await module.link((specifier, parent) => load(path.resolve(path.dirname(parent.identifier), specifier)));
        return module;
    }
    const module = await load(path.join(__dirname, '../js/ui/', file));
    await module.evaluate();
    return file === 'render.js' ? module.namespace.renderTransactionList : module.namespace;
}

test('entity report shows bank cards, collapsed exact days and purpose-built identification controls', async () => {
    const elements = Object.fromEntries(['expense-entity-list', 'expenses-selected-total', 'expenses-selected-meta', 'expenses-entity-selection', 'expenses-detail-list', 'btn-expenses-select-all'].map(id => [id, new Element('div')]));
    const { renderExpenseAnalysis } = await renderer('dailySpending.js', elements);
    const wallets = [{ id: 'bbva', name: 'BBVA', color: '#54799c' }, { id: 'pending', name: 'Plin · banco por identificar', unresolved: true }];
    const expenses = [
        { id: 'a', accountId: 'bbva', type: 'expense', status: 'completed', amount: 0.1, operationDate: '2026-09-25' },
        { id: 'b', accountId: 'bbva', type: 'expense', status: 'completed', amount: 0.2, operationDate: '2026-09-25' },
        { id: 'c', accountId: 'pending', type: 'expense', status: 'completed', amount: 50, operationDate: '2026-09-24' }
    ];
    renderExpenseAnalysis({ wallets, expenses, selectedEntityIds: ['bbva'], resolveIdentity: () => ({ channel: 'Plin' }) });
    assert.equal(elements['expenses-selected-total'].textContent, 'S/ 0.30');
    assert.equal(elements['expense-entity-list'].children.length, 2);
    const days = elements['expenses-detail-list'].children;
    assert.equal(days.length, 1);
    assert.equal(days[0].tagName, 'details');
    assert.ok(!days[0].open, 'Daily rows must start collapsed');
    assert.equal(days[0].children[1].children.length, 2);
    assert.doesNotMatch(days[0].textContent, /Canal: Plin/);
    renderExpenseAnalysis({ wallets, expenses, selectedEntityIds: ['pending'], resolveIdentity: () => ({ channel: 'Plin', unresolved: true }) });
    assert.match(elements['expenses-detail-list'].textContent, /Identificar banco del comprobante/);
    assert.match(elements['expenses-detail-list'].textContent, /no el destino/);
    assert.equal(elements['expenses-selected-total'].textContent, 'S/ 50.00');
});

test('empty period explains the period, keeps the complete guide and next actions', async () => {
    const render = await renderer();
    const list = new Element('div');
    render(list, []);
    const empty = list.children[0];
    assert.equal(empty.attributes.role, 'listitem');
    assert.equal(empty.children[0].children[0].src, '/images/konteo-guide-empty.jpg');
    assert.equal(empty.children[0].dataset.mascot, 'record');
    const copy = empty.children[1];
    assert.equal(copy.children[0].textContent, 'Este período aún no tiene movimientos');
    assert.match(copy.children[1].textContent, /otro período/);
    assert.equal(copy.children[2].children.length, 2);
});

test('empty filters offer reset, not a misleading first transaction or mascot', async () => {
    const render = await renderer();
    const list = new Element('div');
    render(list, [], { hasFilters: true });
    const empty = list.children[0];
    assert.equal(empty.children.length, 1);
    const copy = empty.children[0];
    assert.equal(copy.children[0].textContent, 'No hay coincidencias');
    assert.equal(copy.children[2].dataset.resetLedgerFilters, '');
    assert.equal(copy.children[2].textContent, 'Limpiar filtros');
});

test('render replaces the previous empty state, and tolerates a missing list', async () => {
    const render = await renderer();
    const list = new Element('div');
    render(list, []);
    render(list, [], { hasFilters: true });
    assert.equal(list.children.length, 1);
    assert.doesNotThrow(() => render(null, []));
});

test('budget help follows no limit, available and exceeded states without changing data', async () => {
    const { budgetGuide } = await renderer('guides.js');
    assert.equal(budgetGuide(0, 200).target, 'plan-expense-limit');
    const available = budgetGuide(100, 40);
    assert.match(available.body, /60[.,]00/);
    assert.equal(available.target, 'plan-expense-limit');
    const exceeded = budgetGuide(100, 120);
    assert.equal(exceeded.target, 'search-input');
    assert.match(exceeded.body, /no es tu saldo bancario/);
    assert.equal(budgetGuide(100, 100).target, 'plan-expense-limit');
});

test('account help offers creation only without active accounts, otherwise configuration', async () => {
    const { accountGuide } = await renderer('guides.js');
    assert.equal(accountGuide(false).actionName, 'new-account');
    assert.match(accountGuide(false).body, /pendientes/);
    assert.equal(accountGuide(true).actionName, 'edit-account');
    assert.match(accountGuide(true).body, /BBVA e Interbank/);
});

test('mascot scenes preserve artwork and have distinct task cues, not interactive fake progress', async () => {
    const { createMascotScene } = await renderer('mascot.js');
    const scenes = ['welcome', 'record', 'review', 'confirmed'].map(createMascotScene);
    for (const scene of scenes) {
        assert.equal(scene.attributes['aria-hidden'], 'true');
        assert.equal(scene.children.length, 2);
        assert.equal(scene.children[0].alt, '');
        assert.equal(scene.children[0].loading, 'lazy');
    }
    assert.match(scenes[1].children[1].innerHTML, /mascot-pencil/);
    assert.match(scenes[2].children[1].innerHTML, /mascot-scan/);
    assert.match(scenes[3].children[1].innerHTML, /mascot-tick/);
});

test('daily spending groups only posted purchases by business day and selected entity', async () => {
    const { buildDailySpendGroups, buildDailyMovementGroups, entitySelectionText, expenseEntityOptions } = await renderer('dailySpending.js');
    const expenses = [
        { id: 'a', type: 'expense', amount: 10.10, operationDate: '2026-09-27', accountId: 'bcp' },
        { id: 'b', type: 'expense', amount: 4.25, operationDate: '2026-09-27', accountId: 'bbva' },
        { id: 'c', type: 'expense', amount: 8, operationDate: '2026-09-26', accountId: 'bcp' },
        { id: 'pending', type: 'expense', amount: 99, operationDate: '2026-09-27', accountId: 'bcp', status: 'pending' },
        { id: 'transfer', type: 'expense', amount: 50, operationDate: '2026-09-27', accountId: 'bcp', transferId: 't-1' }
    ];
    const all = buildDailySpendGroups(expenses);
    assert.equal(JSON.stringify(all.map(day => [day.date, day.total, day.items.length])), JSON.stringify([
        ['2026-09-27', 14.35, 2], ['2026-09-26', 8, 1]
    ]));
    const bcp = buildDailySpendGroups(expenses, ['bcp']);
    assert.equal(JSON.stringify(bcp.map(day => [day.date, day.total])), JSON.stringify([['2026-09-27', 10.1], ['2026-09-26', 8]]));
    assert.equal(entitySelectionText([{ id: 'bcp', name: 'Cuenta BCP' }], ['bcp']), 'Cuenta BCP');
    assert.equal(entitySelectionText([], []), 'Ninguna entidad');
    const entities = expenseEntityOptions(expenses, [
        { id: 'bcp', name: 'Cuenta BCP' },
        { id: 'bbva', name: 'Cuenta BBVA' },
        { id: 'empty', name: 'Cuenta sin gastos' }
    ]);
    assert.equal(JSON.stringify(entities.map(entity => entity.id)), JSON.stringify(['bcp', 'bbva']));
    assert.equal(entities[0].total, 18.1);
    const incomes = buildDailyMovementGroups([
        { id: 'income', type: 'income', amount: 500, operationDate: '2026-09-27', accountId: 'bcp' },
        { id: 'transfer-income', type: 'income', amount: 10, operationDate: '2026-09-27', accountId: 'bcp', transferId: 'x' }
    ], null, item => item.accountId, 'income');
    assert.equal(incomes[0].total, 500);
});
