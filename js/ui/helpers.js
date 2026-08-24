// js/ui/helpers.js — Shared utility functions

export function showPage(page) {
    const pages = ['home', 'login', 'register', 'dashboard'];
    pages.forEach((name) => document.getElementById(`${name}-page`)?.classList.add('hidden'));

    const nextPage = pages.includes(page) ? page : 'home';
    document.getElementById(`${nextPage}-page`)?.classList.remove('hidden');
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
}

export function fmt(n) {
    return n.toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Konteo operates on Peru time. Keep this in one place: timestamps remain UTC
// in Firestore, while calendar dates and every displayed value use this zone.
export const BUSINESS_TIME_ZONE = 'America/Lima';

const BUSINESS_DATE_PARTS = new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit'
});

function partsToObject(parts) {
    return parts.reduce((result, part) => {
        if (part.type !== 'literal') result[part.type] = part.value;
        return result;
    }, {});
}

export function businessDateString(value = new Date()) {
    const date = value?.toDate?.() || value;
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
    const parts = partsToObject(BUSINESS_DATE_PARTS.formatToParts(date));
    return `${parts.year}-${parts.month}-${parts.day}`;
}

export function isBusinessDate(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

// A date selected by the user is a calendar date, not a browser-local instant.
// It is anchored at the start of that day in Lima. The exact operation time is
// stored separately in `occurredAt`, so this value is safe for calendar filters
// and never becomes a future timestamp during the morning.
export function businessDateToDate(dateString, { endOfDay = false } = {}) {
    if (!isBusinessDate(dateString)) return new Date(NaN);
    return new Date(`${dateString}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}-05:00`);
}

export function startOfBusinessDate(dateString) {
    if (!isBusinessDate(dateString)) return new Date(NaN);
    return new Date(`${dateString}T00:00:00.000-05:00`);
}

export function endOfBusinessDate(dateString) {
    if (!isBusinessDate(dateString)) return new Date(NaN);
    return new Date(`${dateString}T23:59:59.999-05:00`);
}

export function transactionBusinessDate(item) {
    if (isBusinessDate(item?.operationDate)) return item.operationDate;
    const fallback = item?.date?.toDate?.() || item?.createdAt?.toDate?.() || item;
    return businessDateString(fallback);
}

export function formatBusinessDate(value, options = { day: 'numeric', month: 'short', year: 'numeric' }) {
    const date = isBusinessDate(value) ? businessDateToDate(value) : (value?.toDate?.() || value);
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '—';
    return new Intl.DateTimeFormat('es-PE', { timeZone: BUSINESS_TIME_ZONE, ...options }).format(date);
}

export function formatBusinessDateTime(value) {
    const date = value?.toDate?.() || value;
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '—';
    return new Intl.DateTimeFormat('es-PE', {
        timeZone: BUSINESS_TIME_ZONE,
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit', hour12: true,
        timeZoneName: 'short'
    }).format(date);
}

export function median(values) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const half = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[half] : (sorted[half - 1] + sorted[half]) / 2;
}

export function normalizeText(rawValue, max = 100) {
    return (rawValue || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function normalizeNote(rawValue) {
    return normalizeText(rawValue, 100);
}

export function normalizeTags(rawValue) {
    return normalizeText(rawValue, 100)
        .split(',').map(t => t.trim()).filter(Boolean).slice(0, 5).join(', ');
}

export function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export function sortTransactions(items, currentSort) {
    const toDateMs = (item) => {
        const d = item?.occurredAt?.toDate?.() || item?.date?.toDate?.() || item?.createdAt?.toDate?.();
        return d instanceof Date && !Number.isNaN(d.getTime()) ? d.getTime() : 0;
    };
    const toAmount = (item) => {
        const n = Number(item?.amount);
        return Number.isFinite(n) ? n : 0;
    };

    const sorted = [...items];
    sorted.sort((a, b) => {
        if (currentSort === 'amount_desc') return toAmount(b) - toAmount(a);
        if (currentSort === 'amount_asc') return toAmount(a) - toAmount(b);
        if (currentSort === 'date_asc') return toDateMs(a) - toDateMs(b);
        return toDateMs(b) - toDateMs(a);
    });
    return sorted;
}

export function calculateProfileCompletion(profile) {
    const fields = [
        profile.name, profile.phone, profile.birthday, profile.city,
        profile.country, profile.occupation, profile.currency,
        profile.bio, profile.recoveryEmail, profile.emergencyContact
    ];
    const completed = fields.filter(v => typeof v === 'string' ? v.trim() : !!v).length;
    return Math.round((completed / fields.length) * 100);
}

export function todayString() {
    return businessDateString(new Date());
}

export function toggleCustomRangePanel(currentFilter) {
    const panel = document.getElementById('custom-range-panel');
    if (panel) panel.classList.toggle('hidden', currentFilter !== 'custom');
}
