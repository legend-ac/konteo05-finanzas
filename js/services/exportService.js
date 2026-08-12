// js/services/exportService.js — Excel & PDF export
// Usa el período activo del dashboard: Hoy | Semana | Mes | Rango personalizado

import { state } from '../state.js';
import { showToast } from '../ui/toast.js';
import { getAllTransactionsOrdered } from './dbService.js';

// ─────────────────────────────────────────────
// CDN FALLBACK (las libs ya están en el <head>)
// ─────────────────────────────────────────────
function loadScript(src) {
    return new Promise((resolve, reject) => {
        if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
        const script = document.createElement('script');
        script.src = src;
        script.onload = resolve;
        script.onerror = () => reject(new Error(`No se pudo cargar: ${src}`));
        document.head.appendChild(script);
    });
}

async function ensureSheetJS() {
    if (!window.XLSX) {
        await loadScript('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js');
        if (!window.XLSX) throw new Error('No se pudo cargar la librería de Excel. Revisa tu conexión.');
    }
}

async function ensureJsPDF() {
    if (!window.jspdf) {
        await loadScript('https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js');
        if (!window.jspdf) throw new Error('No se pudo cargar la librería de PDF. Revisa tu conexión.');
    }
}

// ─────────────────────────────────────────────
// FILTRO POR PERÍODO — soporta todos los modos
// ─────────────────────────────────────────────
function txDate(item) {
    return item?.date?.toDate?.() || item?.createdAt?.toDate?.() || new Date(0);
}

function safeNum(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

/**
 * filter: 'today' | 'week' | 'month' | 'custom'
 * startDate / endDate: strings 'YYYY-MM-DD' (solo para 'custom')
 */
function inPeriod(date, filter, startDate, endDate) {
    const now = new Date();
    switch (filter) {
        case 'today': {
            const s = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
            const e = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
            return date >= s && date <= e;
        }
        case 'week': {
            const s = new Date(now);
            s.setDate(s.getDate() - 6);
            s.setHours(0, 0, 0, 0);
            return date >= s;
        }
        case 'month': {
            const s = new Date(now.getFullYear(), now.getMonth(), 1);
            return date >= s;
        }
        case 'custom': {
            if (!startDate || !endDate) return true;
            const s = new Date(`${startDate}T00:00:00`);
            const e = new Date(`${endDate}T23:59:59`);
            return date >= s && date <= e;
        }
        default:
            return true; // sin filtro: todo
    }
}

function getPeriodLabel(filter, startDate, endDate) {
    switch (filter) {
        case 'today':  return 'Diario';
        case 'week':   return 'Semanal (7 días)';
        case 'month':  return 'Mensual';
        case 'custom': return startDate && endDate ? `${startDate}  →  ${endDate}` : 'Personalizado';
        default:       return 'Todos los movimientos';
    }
}

function getFileLabel(filter, startDate, endDate) {
    switch (filter) {
        case 'today':  return 'Diario';
        case 'week':   return 'Semanal';
        case 'month':  return 'Mensual';
        case 'custom': return startDate ? `${startDate}_${endDate}` : 'Rango';
        default:       return 'Completo';
    }
}

async function getFilteredData(uid, filter, startDate, endDate) {
    const txs = await getAllTransactionsOrdered(uid);
    const selected = txs.filter(t => inPeriod(txDate(t), filter, startDate, endDate));
    return {
        all:      selected,
        income:   selected.filter(t => t.type === 'income'),
        expenses: selected.filter(t => t.type === 'expense'),
    };
}

// ─────────────────────────────────────────────
// EXCEL SHEETS
// ─────────────────────────────────────────────
function createSummarySheet(data, periodLabel, email) {
    const totalIncome   = data.income.reduce((s, i) => s + safeNum(i.amount), 0);
    const totalExpenses = data.expenses.reduce((s, e) => s + safeNum(e.amount), 0);
    const balance       = totalIncome - totalExpenses;
    const greenExp  = data.expenses.filter(e => e.category === 'green').reduce((s, e) => s + safeNum(e.amount), 0);
    const yellowExp = data.expenses.filter(e => e.category === 'yellow').reduce((s, e) => s + safeNum(e.amount), 0);
    const redExp    = data.expenses.filter(e => e.category === 'red').reduce((s, e) => s + safeNum(e.amount), 0);
    const savingsRate = totalIncome > 0 ? ((balance / totalIncome) * 100).toFixed(1) : '0.0';

    return [
        [`KONTEO 05 — REPORTE FINANCIERO`],
        ['Período:', periodLabel],
        ['Generado:', new Date().toLocaleString('es-PE')],
        ['Usuario:', email],
        [],
        ['RESUMEN'],
        [],
        ['Concepto', 'Monto (S/)'],
        ['Total Ingresos',  totalIncome.toFixed(2)],
        ['Total Gastos',    totalExpenses.toFixed(2)],
        ['Balance',         balance.toFixed(2)],
        [],
        ['DISTRIBUCIÓN DE GASTOS'],
        [],
        ['Categoría',  'Monto (S/)'],
        ['Fijo',       greenExp.toFixed(2)],
        ['Necesario',  yellowExp.toFixed(2)],
        ['Antojo',     redExp.toFixed(2)],
        [],
        ['Tasa de ahorro', savingsRate + '%'],
        ['Total movimientos', data.income.length + data.expenses.length],
    ];
}

function createIncomeSheet(income) {
    const days = ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'];
    const rows = income
        .map(item => { const d = txDate(item); return { ts: d.getTime(), row: [d.toLocaleDateString('es-PE'), safeNum(item.amount).toFixed(2), item.note || '-', days[d.getDay()]] }; })
        .sort((a, b) => b.ts - a.ts)
        .map(x => x.row);
    return [['INGRESOS'], [], ['Fecha','Monto','Nota','Día'], ...rows, [], ['TOTAL', income.reduce((s, i) => s + safeNum(i.amount), 0).toFixed(2)]];
}

function createExpenseSheet(expenses) {
    const catNames = { green:'Fijo', yellow:'Necesario', red:'Antojo' };
    const days = ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'];
    const rows = expenses
        .map(item => { const d = txDate(item); return { ts: d.getTime(), row: [d.toLocaleDateString('es-PE'), safeNum(item.amount).toFixed(2), catNames[item.category] || item.category, item.note || '-', days[d.getDay()]] }; })
        .sort((a, b) => b.ts - a.ts)
        .map(x => x.row);
    return [['GASTOS'], [], ['Fecha','Monto','Categoría','Nota','Día'], ...rows, [], ['TOTAL', expenses.reduce((s, e) => s + safeNum(e.amount), 0).toFixed(2)]];
}

function createCategorySheet(expenses) {
    const cats = {
        green:  { name: 'Fijo',      items: [] },
        yellow: { name: 'Necesario', items: [] },
        red:    { name: 'Antojo',    items: [] },
    };
    expenses.forEach(e => { if (cats[e.category]) cats[e.category].items.push(e); });
    const result = [['ANÁLISIS POR CATEGORÍA'], []];
    Object.values(cats).forEach(cat => {
        const total = cat.items.reduce((s, i) => s + safeNum(i.amount), 0);
        result.push([cat.name], ['Total:', 'S/ ' + total.toFixed(2)], ['Cantidad:', cat.items.length], []);
    });
    return result;
}

// ─────────────────────────────────────────────
// EXPORT: EXCEL
// ─────────────────────────────────────────────
export async function exportToExcel({ filter, startDate, endDate } = {}) {
    if (!state.currentUser) return;

    // Si no se pasa contexto, usar el activo del dashboard
    const f   = filter    ?? state.currentFilter    ?? 'week';
    const sd  = startDate ?? state.customRangeStart ?? '';
    const ed  = endDate   ?? state.customRangeEnd   ?? '';

    try {
        showToast('Preparando Excel…', 'info');
        await ensureSheetJS();

        const data        = await getFilteredData(state.currentUser.uid, f, sd, ed);
        const periodLabel = getPeriodLabel(f, sd, ed);
        const fileLabel   = getFileLabel(f, sd, ed);

        const wb = XLSX.utils.book_new();

        const ws1 = XLSX.utils.aoa_to_sheet(createSummarySheet(data, periodLabel, state.currentUser.email));
        ws1['!cols'] = [{ wch: 30 }, { wch: 20 }];
        XLSX.utils.book_append_sheet(wb, ws1, 'Resumen');

        const ws2 = XLSX.utils.aoa_to_sheet(createIncomeSheet(data.income));
        ws2['!cols'] = [{ wch: 15 }, { wch: 12 }, { wch: 30 }, { wch: 10 }];
        XLSX.utils.book_append_sheet(wb, ws2, 'Ingresos');

        const ws3 = XLSX.utils.aoa_to_sheet(createExpenseSheet(data.expenses));
        ws3['!cols'] = [{ wch: 15 }, { wch: 12 }, { wch: 14 }, { wch: 30 }, { wch: 10 }];
        XLSX.utils.book_append_sheet(wb, ws3, 'Gastos');

        const ws4 = XLSX.utils.aoa_to_sheet(createCategorySheet(data.expenses));
        ws4['!cols'] = [{ wch: 30 }, { wch: 15 }];
        XLSX.utils.book_append_sheet(wb, ws4, 'Análisis');

        XLSX.writeFile(wb, `Konteo05_${fileLabel}_${new Date().toISOString().split('T')[0]}.xlsx`);
        showToast(`✅ Excel descargado — ${periodLabel}`, 'success');
    } catch (err) {
        showToast('Error Excel: ' + err.message, 'error');
        console.error('[exportService]', err);
    }
}

// ─────────────────────────────────────────────
// EXPORT: PDF
// ─────────────────────────────────────────────
export async function exportToPDF({ filter, startDate, endDate } = {}) {
    if (!state.currentUser) return;

    const f   = filter    ?? state.currentFilter    ?? 'week';
    const sd  = startDate ?? state.customRangeStart ?? '';
    const ed  = endDate   ?? state.customRangeEnd   ?? '';

    try {
        showToast('Preparando PDF…', 'info');
        await ensureJsPDF();

        const { jsPDF }   = window.jspdf;
        const doc         = new jsPDF();
        const data        = await getFilteredData(state.currentUser.uid, f, sd, ed);
        const periodLabel = getPeriodLabel(f, sd, ed);
        const fileLabel   = getFileLabel(f, sd, ed);

        const totalInc = data.income.reduce((s, t) => s + safeNum(t.amount), 0);
        const totalExp = data.expenses.reduce((s, t) => s + safeNum(t.amount), 0);
        const bal      = totalInc - totalExp;

        // ── Encabezado ──
        doc.setFontSize(20);
        doc.setTextColor(109, 91, 255);
        doc.text('Konteo 05 — Reporte Financiero', 105, 18, { align: 'center' });

        doc.setFontSize(11);
        doc.setTextColor(100);
        doc.text(`Período: ${periodLabel}`, 105, 26, { align: 'center' });
        doc.text(`Generado: ${new Date().toLocaleDateString('es-PE')}`, 105, 32, { align: 'center' });
        doc.text(`Usuario: ${state.currentUser.email}`, 105, 38, { align: 'center' });

        // ── Línea separadora ──
        doc.setDrawColor(200);
        doc.line(15, 42, 195, 42);

        // ── Balance ──
        doc.setFontSize(14);
        doc.setTextColor(0);
        doc.text('Balance:', 15, 52);
        doc.setTextColor(bal >= 0 ? 34 : 239, bal >= 0 ? 197 : 68, bal >= 0 ? 94 : 68);
        doc.text(`S/ ${bal.toFixed(2)}`, 55, 52);

        doc.setFontSize(11);
        doc.setTextColor(34, 197, 94);
        doc.text(`Ingresos totales:  S/ ${totalInc.toFixed(2)}`, 15, 62);
        doc.setTextColor(239, 68, 68);
        doc.text(`Gastos totales:    S/ ${totalExp.toFixed(2)}`, 15, 70);

        // ── Estadísticas ──
        doc.setTextColor(0);
        doc.setFontSize(10);
        const savingsRate = totalInc > 0 ? ((bal / totalInc) * 100).toFixed(1) : '0.0';
        doc.text(`Movimientos: ${data.all.length}   |   Tasa de ahorro: ${savingsRate}%`, 15, 80);

        doc.setDrawColor(200);
        doc.line(15, 84, 195, 84);

        // ── Transacciones ──
        doc.setFontSize(12);
        doc.setTextColor(0);
        doc.text('Detalle de movimientos:', 15, 92);

        let yPos = 100;

        if (data.all.length === 0) {
            doc.setFontSize(10);
            doc.setTextColor(150);
            doc.text('No hay movimientos en este período.', 15, yPos);
        } else {
            const catMark = { green: 'Fijo', yellow: 'Necesario', red: 'Antojo' };
            doc.setFontSize(8.5);

            // Encabezado de tabla
            doc.setTextColor(100);
            doc.text('Fecha',      15,  yPos);
            doc.text('Tipo',       50,  yPos);
            doc.text('Nota',       78,  yPos);
            doc.text('Categoría',  145, yPos);
            doc.text('Monto',      175, yPos);
            yPos += 4;
            doc.setDrawColor(180);
            doc.line(15, yPos, 195, yPos);
            yPos += 5;

            // Ordenar por fecha desc
            const sorted = [...data.all].sort((a, b) => txDate(b) - txDate(a));

            for (const t of sorted) {
                if (yPos > 270) {
                    doc.addPage();
                    yPos = 20;
                }
                const d    = txDate(t);
                const tipo = t.type === 'income' ? 'Ingreso' : 'Gasto';
                const cat  = t.type === 'income' ? (t.category || 'otros') : (catMark[t.category] || t.category || '-');
                const nota = (t.note || 'Sin nota').slice(0, 38);

                if (t.type === 'income') doc.setTextColor(34, 197, 94);
                else doc.setTextColor(239, 68, 68);

                doc.text(d.toLocaleDateString('es-PE'), 15,  yPos);
                doc.text(tipo,                          50,  yPos);
                doc.setTextColor(40, 40, 40);
                doc.text(nota,                          78,  yPos);
                doc.setTextColor(100);
                doc.text(cat,                           145, yPos);
                if (t.type === 'income') doc.setTextColor(34, 197, 94);
                else doc.setTextColor(239, 68, 68);
                doc.text(`S/ ${safeNum(t.amount).toFixed(2)}`, 175, yPos);

                yPos += 6.5;
            }
        }

        // ── Pie de página ──
        const pageCount = doc.internal.getNumberOfPages();
        for (let i = 1; i <= pageCount; i++) {
            doc.setPage(i);
            doc.setFontSize(7);
            doc.setTextColor(160);
            doc.text(`Pág. ${i}/${pageCount}`, 105, 291, { align: 'center' });
            doc.text('Konteo 05 © 2026', 15, 291);
        }

        doc.save(`Konteo05_${fileLabel}_${new Date().toISOString().split('T')[0]}.pdf`);
        showToast(`✅ PDF generado — ${periodLabel}`, 'success');
    } catch (err) {
        showToast('Error PDF: ' + err.message, 'error');
        console.error('[exportService]', err);
    }
}
