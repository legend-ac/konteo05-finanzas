// Expense analysis by entity. It counts purchases only: transfers, pending and
// cancelled records never become spending, even when they look like a debit.
import { fmt, formatBusinessDate, transactionBusinessDate, BUSINESS_TIME_ZONE } from './helpers.js';
import { isPosted, sumAmounts } from '../services/financialMath.js';

export const UNASSIGNED_ENTITY_ID = '__unassigned__';

function itemTime(item) {
    // A document date stored at midnight is a business-day marker, not an
    // actual operation time. Do not present it as the false precision "12 AM".
    // `createdAt` identifies when this app saved the document. It is not the
    // operation time and can be a midnight placeholder, so never show it as
    // if it came from the bank or Gmail notification.
    const value = item?.occurredAt?.toDate?.();
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) return '';
    return new Intl.DateTimeFormat('es-PE', {
        timeZone: BUSINESS_TIME_ZONE, hour: '2-digit', minute: '2-digit', hour12: true
    }).format(value);
}

export function isRealExpense(item) {
    return item?.type === 'expense' && isPosted(item) && !item.isTransfer && !item.transferId && item.operationType !== 'transfer_out';
}

export function isRealIncome(item) {
    return item?.type === 'income' && isPosted(item) && !item.isTransfer && !item.transferId && item.operationType !== 'transfer_in';
}

function isRealMovement(item, movementType) {
    return movementType === 'income' ? isRealIncome(item) : isRealExpense(item);
}

export function buildDailySpendGroups(expenses = [], selectedEntityIds = null, resolveEntityId = item => item?.accountId || UNASSIGNED_ENTITY_ID) {
    return buildDailyMovementGroups(expenses, selectedEntityIds, resolveEntityId, 'expense');
}

export function buildDailyMovementGroups(items = [], selectedEntityIds = null, resolveEntityId = item => item?.accountId || UNASSIGNED_ENTITY_ID, movementType = 'expense') {
    const selected = selectedEntityIds === null ? null : new Set(selectedEntityIds);
    const days = new Map();
    items.filter(item => isRealMovement(item, movementType)).forEach(item => {
        const entityId = resolveEntityId(item) || UNASSIGNED_ENTITY_ID;
        if (selected && !selected.has(entityId)) return;
        const date = transactionBusinessDate(item);
        if (!date) return;
        const group = days.get(date) || { date, items: [] };
        group.items.push({ ...item, dailyEntityId: entityId });
        days.set(date, group);
    });
    return [...days.values()].map(group => ({
        ...group,
        total: sumAmounts(group.items),
        items: [...group.items].sort((a, b) => (b?.occurredAt?.toMillis?.() || b?.date?.toMillis?.() || 0) - (a?.occurredAt?.toMillis?.() || a?.date?.toMillis?.() || 0))
    })).sort((a, b) => b.date.localeCompare(a.date));
}

export function entitySelectionText(options = [], selectedEntityIds = null) {
    if (selectedEntityIds === null) return 'Todas las entidades';
    if (selectedEntityIds.length === 0) return 'Ninguna entidad';
    if (selectedEntityIds.length === 1) return options.find(option => option.id === selectedEntityIds[0])?.name || '1 entidad';
    return `${selectedEntityIds.length} entidades`;
}

// Entities appear only after they have a real expense in the chosen period.
export function expenseEntityOptions(expenses = [], wallets = [], resolveEntityId = item => item?.accountId || UNASSIGNED_ENTITY_ID, movementType = 'expense') {
    const walletById = new Map(wallets.filter(wallet => wallet?.id).map(wallet => [wallet.id, wallet]));
    const totals = new Map();
    expenses.filter(item => isRealMovement(item, movementType)).forEach(item => {
        const id = resolveEntityId(item) || UNASSIGNED_ENTITY_ID;
        const current = totals.get(id) || { id, count: 0, total: 0 };
        current.count += 1;
        current.total += Number(item.amount) || 0;
        totals.set(id, current);
    });
    return [...totals.values()].map(item => {
        const wallet = walletById.get(item.id);
        return {
            ...item,
            name: item.id === UNASSIGNED_ENTITY_ID ? 'Sin entidad asignada' : (wallet?.name || 'Entidad no disponible'),
            detail: item.id === UNASSIGNED_ENTITY_ID ? 'Revisa estos movimientos para asignarlos' : `${item.count} ${movementType === 'income' ? 'ingreso' : 'gasto'}${item.count !== 1 ? 's' : ''} confirmado${item.count !== 1 ? 's' : ''}`,
            color: wallet?.color || wallet?.bankColor || ''
        };
    }).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, 'es'));
}

function appendEntityButton(container, option, selected) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `expense-entity-card${selected ? ' is-selected' : ''}`;
    button.dataset.expenseEntityId = option.id;
    button.setAttribute('aria-pressed', String(selected));
    const marker = document.createElement('span');
    marker.className = 'expense-entity-marker';
    if (option.color) marker.style.setProperty('--entity-color', option.color);
    const copy = document.createElement('span');
    copy.className = 'expense-entity-copy';
    const name = document.createElement('strong'); name.textContent = option.name;
    const detail = document.createElement('small'); detail.textContent = option.detail;
    copy.append(name, detail);
    const amount = document.createElement('span');
    amount.className = 'expense-entity-amount';
    amount.textContent = `S/ ${fmt(option.total)}`;
    button.append(marker, copy, amount);
    container.appendChild(button);
}

function appendMovement(container, item, entityName, movementType) {
    const row = document.createElement('div'); row.className = 'expense-detail-movement';
    const copy = document.createElement('div');
    const title = document.createElement('strong'); title.textContent = item.note || item.counterparty || (movementType === 'income' ? 'Ingreso registrado' : 'Gasto registrado');
    const meta = document.createElement('small');
    meta.textContent = [entityName, item.sourceLabel || item.counterparty, itemTime(item)].filter(Boolean).join(' · ');
    copy.append(title, meta);
    const amount = document.createElement('b'); amount.textContent = `${movementType === 'income' ? '+' : '−'} S/ ${fmt(Number(item.amount) || 0)}`;
    row.classList.toggle('is-income', movementType === 'income');
    row.append(copy, amount); container.appendChild(row);
}

export function renderExpenseAnalysis({ wallets = [], expenses = [], incomes = [], selectedEntityIds = null, resolveEntityId = item => item?.accountId || UNASSIGNED_ENTITY_ID, movementType = 'expense' } = {}) {
    const entitiesEl = document.getElementById('expense-entity-list');
    const totalEl = document.getElementById('expenses-selected-total');
    const metaEl = document.getElementById('expenses-selected-meta');
    const selectionEl = document.getElementById('expenses-entity-selection');
    const listEl = document.getElementById('expenses-detail-list');
    const selectAllEl = document.getElementById('btn-expenses-select-all');
    if (!entitiesEl || !totalEl || !metaEl || !selectionEl || !listEl) return;

    const sourceItems = movementType === 'income' ? incomes : expenses;
    const movementLabel = movementType === 'income' ? 'ingreso' : 'gasto';
    const options = expenseEntityOptions(sourceItems, wallets, resolveEntityId, movementType);
    const selected = selectedEntityIds === null ? null : new Set(selectedEntityIds);
    const visibleOptions = selected === null ? options : options.filter(option => selected.has(option.id));
    const groups = buildDailyMovementGroups(sourceItems, selectedEntityIds, resolveEntityId, movementType);
    const items = groups.flatMap(group => group.items);
    totalEl.textContent = `S/ ${fmt(sumAmounts(items))}`;
    selectionEl.textContent = entitySelectionText(options, selectedEntityIds);
    metaEl.textContent = `${visibleOptions.length} entidad${visibleOptions.length !== 1 ? 'es' : ''} · ${items.length} ${movementLabel}${items.length !== 1 ? 's' : ''} confirmado${items.length !== 1 ? 's' : ''}`;
    if (selectAllEl) {
        selectAllEl.disabled = !options.length;
        selectAllEl.textContent = 'Seleccionar todas';
    }

    entitiesEl.textContent = '';
    if (!options.length) {
        const empty = document.createElement('p'); empty.className = 'expenses-empty-copy';
        empty.textContent = `Las entidades aparecerán aquí cuando tengan ${movementLabel}s confirmados en este período.`;
        entitiesEl.appendChild(empty);
    } else options.forEach(option => appendEntityButton(entitiesEl, option, selected === null || selected.has(option.id)));

    listEl.textContent = '';
    if (!groups.length) {
        const empty = document.createElement('p'); empty.className = 'expenses-empty-copy';
        empty.textContent = selectedEntityIds?.length === 0 ? `Selecciona una o más entidades para ver su ${movementLabel} exacto.` : `No hay ${movementLabel}s confirmados para las entidades elegidas en este período.`;
        listEl.appendChild(empty); return;
    }
    const names = new Map(options.map(option => [option.id, option.name]));
    groups.forEach(group => {
        const day = document.createElement('section'); day.className = 'expense-detail-day';
        const header = document.createElement('div'); header.className = 'expense-detail-day-header';
        const date = document.createElement('h3');
        date.textContent = formatBusinessDate(group.date, { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' });
        const amount = document.createElement('strong'); amount.textContent = `S/ ${fmt(group.total)}`;
        header.append(date, amount);
        const count = document.createElement('small'); count.className = 'expense-detail-count';
        count.textContent = `${group.items.length} ${movementLabel}${group.items.length !== 1 ? 's' : ''} confirmado${group.items.length !== 1 ? 's' : ''}`;
        day.append(header, count);
        group.items.forEach(item => appendMovement(day, item, names.get(item.dailyEntityId) || 'Sin entidad asignada', movementType));
        listEl.appendChild(day);
    });
}
