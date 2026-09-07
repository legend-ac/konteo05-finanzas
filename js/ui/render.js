// js/ui/render.js — Compact ledger rows, income source visible, no meta noise

import { formatBusinessDate, transactionBusinessDate } from './helpers.js';

const CAT_LABEL = { green: 'Fijo', yellow: 'Necesario', red: 'Antojo' };
const SVG_NS = 'http://www.w3.org/2000/svg';
const SOURCE_LABEL = {
    salario: 'Salario', freelance: 'Freelance',
    negocio: 'Negocio', otros: null
};

function makeLineIcon(paths) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    paths.forEach(d => {
        const path = document.createElementNS(SVG_NS, 'path');
        path.setAttribute('d', d);
        svg.appendChild(path);
    });
    return svg;
}
function createRow(item, index) {
    const isIncome = item.type === 'income';
    const isTransfer = Boolean(item.isTransfer || item.transferId);
    const dateStr  = formatBusinessDate(transactionBusinessDate(item));

    let metaParts = [dateStr];
    if (isIncome) {
        const srcLabel = SOURCE_LABEL[item.source];
        if (srcLabel) metaParts.push(srcLabel);
    } else {
        const catLabel = CAT_LABEL[item.category];
        if (catLabel) metaParts.push(catLabel);
    }
    if (isTransfer) metaParts.push('Transferencia');

    const el = document.createElement('div');
    el.className = 'item';
    el.setAttribute('role', 'listitem');
    el.dataset.id = item.id;
    el.dataset.type = isIncome ? 'income' : 'expense';
    el.tabIndex = 0;
    el.setAttribute('aria-label', `Ver detalle de ${item.note || (isIncome ? 'ingreso' : 'gasto')}`);
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

    const detailBtn = document.createElement('button');
    detailBtn.className = 'detail-btn';
    detailBtn.dataset.id = item.id;
    detailBtn.dataset.type = isIncome ? 'income' : 'expense';
    detailBtn.setAttribute('aria-label', 'Ver detalle');
    detailBtn.appendChild(makeLineIcon([
        'M12 16v-4',
        'M12 8h.01',
        'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z'
    ]));

    const delBtn = document.createElement('button');
    delBtn.className = 'delete-btn';
    delBtn.dataset.id   = item.id;
    delBtn.dataset.type = isIncome ? 'income' : 'expense';
    delBtn.setAttribute('aria-label', isTransfer ? 'Eliminar transferencia' : 'Eliminar');
    delBtn.textContent  = '✕';

    actions.append(detailBtn);
    if (!isTransfer) {
        const editBtn = document.createElement('button');
        editBtn.className = 'edit-btn';
        editBtn.dataset.id   = item.id;
        editBtn.dataset.type = isIncome ? 'income' : 'expense';
        editBtn.setAttribute('aria-label', 'Editar');
        editBtn.textContent  = '✎';
        actions.append(editBtn);
    }
    actions.append(delBtn);
    right.append(amt, actions);

    el.append(left, right);
    return el;
}

export function renderTransactionList(listEl, filtered) {
    if (!listEl) return;
    listEl.textContent = '';

    if (!filtered.length) {
        const p = document.createElement('section');
        p.className = 'empty empty-state';
        p.style.marginTop = '32px';
        p.textContent = '';
        const icon = document.createElement('span');
        icon.className = 'empty-state-icon';
        icon.setAttribute('aria-hidden', 'true');
        // #7 — Billetera vacía: más semántico que recibo con rayas
        icon.appendChild(makeLineIcon([
            'M21 7H3a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h18a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1z',
            'M2 11h20',
            'M16 15h2'
        ]));
        const title = document.createElement('h3');
        title.textContent = 'Empieza con tu primer movimiento';
        const copy = document.createElement('p');
        copy.textContent = 'Registra un ingreso o gasto para convertir este panel en tu historial financiero.';
        const actions = document.createElement('div');
        actions.className = 'empty-state-actions';
        // #1 — Mismo texto y clases que la tarjeta de saldo
        const income = document.createElement('button');
        income.type = 'button';
        income.className = 'btn-balance-action btn-balance-income btn-open-income';
        income.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg><span>+ Ingreso</span>`;
        const expense = document.createElement('button');
        expense.type = 'button';
        expense.className = 'btn-balance-action btn-balance-expense btn-open-expense';
        expense.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><line x1="5" y1="12" x2="19" y2="12"/></svg><span>− Gasto</span>`;
        actions.append(income, expense);
        p.append(icon, title, copy, actions);
        listEl.appendChild(p);
        return;
    }

    const frag = document.createDocumentFragment();
    filtered.forEach((item, i) => frag.appendChild(createRow(item, i)));
    listEl.appendChild(frag);
}
