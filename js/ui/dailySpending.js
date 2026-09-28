// Exact daily spending view. It deliberately counts only posted expenses and
// excludes transfers: moving money between two of your own entities is not a
// purchase.
import { fmt, formatBusinessDate, transactionBusinessDate, BUSINESS_TIME_ZONE } from './helpers.js';
import { isPosted, sumAmounts } from '../services/financialMath.js';

export const UNASSIGNED_ENTITY_ID = '__unassigned__';

function itemTime(item) {
    const value = item?.occurredAt?.toDate?.() || item?.date?.toDate?.() || item?.createdAt?.toDate?.();
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) return '';
    return new Intl.DateTimeFormat('es-PE', {
        timeZone: BUSINESS_TIME_ZONE, hour: '2-digit', minute: '2-digit', hour12: true
    }).format(value);
}

function isRealExpense(item) {
    return item?.type === 'expense' && isPosted(item) && !item.isTransfer && !item.transferId && item.operationType !== 'transfer_out';
}

export function buildDailySpendGroups(expenses = [], selectedEntityIds = null, resolveEntityId = item => item?.accountId || UNASSIGNED_ENTITY_ID) {
    const selected = selectedEntityIds === null ? null : new Set(selectedEntityIds);
    const days = new Map();

    expenses.filter(isRealExpense).forEach(item => {
        const entityId = resolveEntityId(item) || UNASSIGNED_ENTITY_ID;
        if (selected && !selected.has(entityId)) return;
        const date = transactionBusinessDate(item);
        if (!date) return;
        const group = days.get(date) || { date, items: [] };
        group.items.push({ ...item, dailyEntityId: entityId });
        days.set(date, group);
    });

    return [...days.values()]
        .map(group => ({
            ...group,
            total: sumAmounts(group.items),
            items: [...group.items].sort((a, b) => {
                const left = a?.occurredAt?.toMillis?.() || a?.date?.toMillis?.() || 0;
                const right = b?.occurredAt?.toMillis?.() || b?.date?.toMillis?.() || 0;
                return right - left;
            })
        }))
        .sort((a, b) => b.date.localeCompare(a.date));
}

export function entitySelectionText(options = [], selectedEntityIds = null) {
    if (selectedEntityIds === null) return 'Todas las entidades';
    const count = selectedEntityIds.length;
    if (count === 0) return 'Ninguna entidad';
    if (count === 1) {
        const selected = options.find(option => option.id === selectedEntityIds[0]);
        return selected?.name || '1 entidad';
    }
    return `${count} entidades`;
}

function appendOption(container, option, checked) {
    const label = document.createElement('label');
    label.className = 'daily-entity-option';

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.name = 'daily-entity';
    input.value = option.id;
    input.checked = checked;

    const text = document.createElement('span');
    const strong = document.createElement('strong');
    strong.textContent = option.name;
    text.appendChild(strong);
    if (option.detail) {
        const detail = document.createElement('small');
        detail.textContent = option.detail;
        text.appendChild(detail);
    }
    label.append(input, text);
    container.appendChild(label);
}

function appendMovement(container, item, entityName) {
    const row = document.createElement('div');
    row.className = 'daily-movement';

    const copy = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = item.note || item.counterparty || 'Gasto registrado';
    const meta = document.createElement('small');
    const metadata = [entityName, item.sourceLabel || item.counterparty, itemTime(item)].filter(Boolean);
    meta.textContent = metadata.join(' · ');
    copy.append(title, meta);

    const amount = document.createElement('b');
    amount.textContent = `− S/ ${fmt(Number(item.amount) || 0)}`;
    row.append(copy, amount);
    container.appendChild(row);
}

export function renderDailySpending({ wallets = [], expenses = [], selectedEntityIds = null, resolveEntityId = item => item?.accountId || UNASSIGNED_ENTITY_ID } = {}) {
    const optionsEl = document.getElementById('daily-entity-options');
    const summaryEl = document.getElementById('daily-entity-summary');
    const selectedEl = document.getElementById('daily-spend-selection');
    const listEl = document.getElementById('daily-spend-list');
    const totalEl = document.getElementById('daily-spend-total');
    if (!optionsEl || !summaryEl || !selectedEl || !listEl || !totalEl) return;

    const assignedIds = new Set(expenses.filter(isRealExpense).map(item => resolveEntityId(item) || UNASSIGNED_ENTITY_ID));
    const options = wallets
        // Keep active entities selectable even when their total is zero. An
        // archived entity remains selectable only if it has history here.
        .filter(wallet => wallet?.id && (wallet.active !== false || assignedIds.has(wallet.id)))
        .map(wallet => ({
            id: wallet.id,
            name: wallet.name || 'Entidad sin nombre',
            detail: `${wallet.type === 'wallet' ? 'Billetera' : 'Cuenta bancaria'}${wallet.active === false ? ' · Archivada' : ''}`
        }));
    if (assignedIds.has(UNASSIGNED_ENTITY_ID)) {
        options.push({ id: UNASSIGNED_ENTITY_ID, name: 'Sin entidad asignada', detail: 'Revisa el movimiento para asignarlo' });
    }

    const selectedSet = selectedEntityIds === null ? null : new Set(selectedEntityIds);
    optionsEl.textContent = '';
    options.forEach(option => appendOption(optionsEl, option, selectedSet === null || selectedSet.has(option.id)));

    const selectionText = entitySelectionText(options, selectedEntityIds);
    summaryEl.textContent = selectionText;
    selectedEl.textContent = selectionText;

    const groups = buildDailySpendGroups(expenses, selectedEntityIds, resolveEntityId);
    const total = sumAmounts(groups.flatMap(group => group.items));
    totalEl.textContent = `S/ ${fmt(total)}`;
    listEl.textContent = '';

    if (!options.length) {
        const empty = document.createElement('p');
        empty.className = 'daily-spend-empty';
        empty.textContent = 'Registra gastos con una entidad para ver el detalle por día.';
        listEl.appendChild(empty);
        return;
    }
    if (!groups.length) {
        const empty = document.createElement('p');
        empty.className = 'daily-spend-empty';
        empty.textContent = selectedEntityIds?.length === 0
            ? 'Selecciona al menos una entidad.'
            : 'No hay gastos confirmados para las entidades elegidas en este período.';
        listEl.appendChild(empty);
        return;
    }

    const names = new Map(options.map(option => [option.id, option.name]));
    groups.forEach(group => {
        const day = document.createElement('section');
        day.className = 'daily-spend-day';
        const header = document.createElement('div');
        header.className = 'daily-spend-day-header';
        const date = document.createElement('h3');
        date.textContent = formatBusinessDate(group.date, { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' });
        const total = document.createElement('strong');
        total.textContent = `S/ ${fmt(group.total)}`;
        header.append(date, total);
        const detail = document.createElement('span');
        detail.className = 'daily-spend-count';
        detail.textContent = `${group.items.length} gasto${group.items.length !== 1 ? 's' : ''} confirmado${group.items.length !== 1 ? 's' : ''}`;
        day.append(header, detail);
        group.items.forEach(item => appendMovement(day, item, names.get(item.dailyEntityId) || 'Sin entidad asignada'));
        listEl.appendChild(day);
    });
}
