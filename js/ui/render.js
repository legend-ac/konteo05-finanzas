// js/ui/render.js — Compact ledger rows, income source visible, no meta noise

const CAT_LABEL = { green: 'Fijo', yellow: 'Necesario', red: 'Antojo' };
const SOURCE_LABEL = {
    salario: 'Salario', freelance: 'Freelance',
    negocio: 'Negocio', otros: null
};
const MONTHS = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];

function shortDate(d) {
    return `${d.getDate()} ${MONTHS[d.getMonth()]}. ${d.getFullYear()}`;
}

function createRow(item, index) {
    const isIncome = item.type === 'income';
    const rawDate  = item?.date?.toDate?.() || new Date(0);
    const dateStr  = shortDate(rawDate);

    let metaParts = [dateStr];
    if (isIncome) {
        const srcLabel = SOURCE_LABEL[item.source];
        if (srcLabel) metaParts.push(srcLabel);
    } else {
        const catLabel = CAT_LABEL[item.category];
        if (catLabel) metaParts.push(catLabel);
    }

    const el = document.createElement('div');
    el.className = 'item';
    el.setAttribute('role', 'listitem');
    el.style.animationDelay = `${Math.min(index * 25, 250)}ms`;

    const left = document.createElement('div');
    left.className = 'item-left';

    const dot = document.createElement('span');
    dot.className = `cat-dot ${isIncome ? 'income' : (item.category || 'yellow')}`;
    dot.setAttribute('aria-hidden', 'true');

    const info = document.createElement('div');
    info.className = 'item-info';

    const desc = document.createElement('div');
    desc.className = 'item-desc';
    desc.textContent = item.note || (isIncome ? 'Ingreso' : 'Gasto');

    const meta = document.createElement('div');
    meta.className = 'item-meta';
    meta.textContent = metaParts.join(' · ');

    info.append(desc, meta);
    left.append(dot, info);

    const right = document.createElement('div');
    right.className = 'item-right';

    const amt = document.createElement('span');
    amt.className = `item-amount ${isIncome ? 'income' : 'expense'}`;
    const n = Number(item.amount);
    amt.textContent = `${isIncome ? '+' : '−'} S/ ${(Number.isFinite(n) ? n : 0).toFixed(2)}`;

    const actions = document.createElement('div');
    actions.className = 'item-actions';

    const editBtn = document.createElement('button');
    editBtn.className = 'edit-btn';
    editBtn.dataset.id   = item.id;
    editBtn.dataset.type = isIncome ? 'income' : 'expense';
    editBtn.setAttribute('aria-label', 'Editar');
    editBtn.textContent  = '✎';

    const delBtn = document.createElement('button');
    delBtn.className = 'delete-btn';
    delBtn.dataset.id   = item.id;
    delBtn.dataset.type = isIncome ? 'income' : 'expense';
    delBtn.setAttribute('aria-label', 'Eliminar');
    delBtn.textContent  = '✕';

    actions.append(editBtn, delBtn);
    right.append(amt, actions);

    el.append(left, right);
    return el;
}

export function renderTransactionList(listEl, filtered) {
    if (!listEl) return;
    listEl.textContent = '';

    if (!filtered.length) {
        const p = document.createElement('p');
        p.className = 'empty';
        p.textContent = 'Sin movimientos en este período';
        listEl.appendChild(p);
        return;
    }

    const frag = document.createDocumentFragment();
    filtered.forEach((item, i) => frag.appendChild(createRow(item, i)));
    listEl.appendChild(frag);
}
