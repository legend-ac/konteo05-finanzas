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
        this.style = {};
        this.className = '';
        this.classList = { add: value => { this.className += ` ${value}`; } };
    }
    set textContent(value) { this.text = value; this.children = []; }
    get textContent() { return this.text || this.children.map(el => el.textContent).join(''); }
    append(...elements) { this.children.push(...elements); }
    appendChild(element) { this.append(element); return element; }
    setAttribute(key, value) { this.attributes[key] = value; }
}

async function renderer() {
    const context = vm.createContext({
        Date, Intl,
        document: {
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
    const module = await load(path.join(__dirname, '../js/ui/render.js'));
    await module.evaluate();
    return module.namespace.renderTransactionList;
}

test('empty period explains the period, keeps the complete guide and next actions', async () => {
    const render = await renderer();
    const list = new Element('div');
    render(list, []);
    const empty = list.children[0];
    assert.equal(empty.attributes.role, 'listitem');
    assert.equal(empty.children[0].src, '/images/konteo-guide-empty.jpg');
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
