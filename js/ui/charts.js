// js/ui/charts.js — análisis visual basado en movimientos reales

const charts = { cashflow: null, category: null };

const CATEGORY_LABELS = {
    green: 'Fijo',
    yellow: 'Necesario',
    red: 'Antojo'
};

function chartColors() {
    const styles = window.getComputedStyle(document.documentElement);
    const token = name => styles.getPropertyValue(name).trim();
    return {
        muted: token('--text-3'),
        grid: token('--line'),
        income: token('--income'),
        expense: token('--expense'),
        green: token('--cat-green'),
        yellow: token('--cat-yellow'),
        red: token('--cat-red')
    };
}

function amount(value) {
    return Number(value) || 0;
}

function compactAmount(value) {
    return new Intl.NumberFormat('es-PE', {
        notation: Math.abs(value) >= 1000 ? 'compact' : 'standard',
        maximumFractionDigits: 0
    }).format(value);
}

function money(value) {
    return `S/ ${new Intl.NumberFormat('es-PE', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    }).format(value)}`;
}

function businessDate(item) {
    if (item?.operationDate) return String(item.operationDate).slice(0, 10);
    const date = item?.date?.toDate?.() || item?.date;
    if (date instanceof Date && !Number.isNaN(date.getTime())) return date.toISOString().slice(0, 10);
    return '';
}

function dayLabel(date) {
    return new Intl.DateTimeFormat('es-PE', {
        day: 'numeric', month: 'short', timeZone: 'America/Lima'
    }).format(new Date(`${date}T12:00:00-05:00`));
}

function destroyChart(name) {
    if (charts[name]) {
        charts[name].destroy();
        charts[name] = null;
    }
}

function showEmptyState(canvas, message) {
    const parent = canvas?.parentElement;
    if (!parent) return;
    let placeholder = parent.querySelector('.chart-empty');
    if (!placeholder) {
        placeholder = document.createElement('p');
        placeholder.className = 'chart-empty';
        parent.appendChild(placeholder);
    }
    placeholder.textContent = message;
    canvas.style.opacity = '0';
}

function clearEmptyState(canvas) {
    const parent = canvas?.parentElement;
    parent?.querySelector('.chart-empty')?.remove();
    if (canvas) canvas.style.opacity = '';
}

function setInsight(text) {
    const summary = document.getElementById('insight-summary');
    if (summary) summary.textContent = text;
}

function renderCashflow(incomeItems, expenseItems, colors) {
    const canvas = document.getElementById('cashflowChart');
    if (!canvas) return;
    destroyChart('cashflow');

    const daily = new Map();
    [...incomeItems, ...expenseItems].forEach(item => {
        const date = businessDate(item);
        if (!date) return;
        const current = daily.get(date) || { income: 0, expense: 0 };
        current[item.type === 'income' ? 'income' : 'expense'] += amount(item.amount);
        daily.set(date, current);
    });

    const dates = [...daily.keys()].sort();
    if (!dates.length) {
        showEmptyState(canvas, 'Aún no hay movimientos en este período.');
        return;
    }

    clearEmptyState(canvas);
    charts.cashflow = new Chart(canvas, {
        type: 'bar',
        data: {
            labels: dates.map(dayLabel),
            datasets: [
                {
                    label: 'Ingresos', data: dates.map(date => daily.get(date).income),
                    backgroundColor: colors.income, borderRadius: 5, borderSkipped: false, maxBarThickness: 28
                },
                {
                    label: 'Gastos', data: dates.map(date => daily.get(date).expense),
                    backgroundColor: colors.expense, borderRadius: 5, borderSkipped: false, maxBarThickness: 28
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: { color: colors.muted, boxWidth: 9, boxHeight: 9, padding: 14, usePointStyle: true }
                },
                tooltip: { callbacks: { label: context => `${context.dataset.label}: ${money(context.parsed.y)}` } }
            },
            scales: {
                x: {
                    ticks: { color: colors.muted, maxRotation: 0, autoSkip: true, maxTicksLimit: 6 },
                    grid: { display: false }, border: { display: false }
                },
                y: {
                    beginAtZero: true,
                    ticks: { color: colors.muted, maxTicksLimit: 4, callback: value => `S/ ${compactAmount(value)}` },
                    grid: { color: colors.grid }, border: { display: false }
                }
            }
        }
    });
}

function renderCategories(categoryTotals, colors) {
    const canvas = document.getElementById('categoryChart');
    if (!canvas) return;
    destroyChart('category');

    const entries = Object.entries(categoryTotals).filter(([, value]) => value > 0);
    if (!entries.length) {
        showEmptyState(canvas, 'Aún no hay gastos para clasificar.');
        return;
    }

    clearEmptyState(canvas);
    charts.category = new Chart(canvas, {
        type: 'doughnut',
        data: {
            labels: entries.map(([category]) => CATEGORY_LABELS[category]),
            datasets: [{
                data: entries.map(([, value]) => value),
                backgroundColor: entries.map(([category]) => colors[category]),
                borderWidth: 0, spacing: 3, hoverOffset: 4
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: '68%',
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: { color: colors.muted, boxWidth: 9, boxHeight: 9, padding: 14, usePointStyle: true }
                },
                tooltip: { callbacks: { label: context => `${context.label}: ${money(context.parsed)}` } }
            }
        }
    });
}

function updateInsight({ totalIncome, totalExpenses, categoryTotals, expenseLimit }) {
    const top = Object.entries(categoryTotals).sort(([, a], [, b]) => b - a)[0];
    if (!totalIncome && !totalExpenses) {
        setInsight('Registra movimientos para ver tendencias útiles.');
    } else if (expenseLimit > 0 && totalExpenses >= expenseLimit) {
        setInsight(`Tu límite de gasto ya fue alcanzado: llevas ${money(totalExpenses)}.`);
    } else if (totalIncome > 0 && totalExpenses > totalIncome) {
        setInsight(`Tus gastos superan tus ingresos por ${money(totalExpenses - totalIncome)} en este período.`);
    } else if (top && totalExpenses > 0) {
        const share = Math.round((top[1] / totalExpenses) * 100);
        setInsight(`${CATEGORY_LABELS[top[0]]} concentra ${share}% de tus gastos (${money(top[1])}).`);
    } else {
        setInsight(`Tus ingresos suman ${money(totalIncome)} en este período.`);
    }
}

export function renderCharts({ incomeItems = [], expenseItems = [], totalIncome = 0, totalExpenses = 0, expenseLimit = 0 } = {}) {
    const categoryTotals = { green: 0, yellow: 0, red: 0 };
    expenseItems.forEach(item => {
        if (Object.hasOwn(categoryTotals, item.category)) categoryTotals[item.category] += amount(item.amount);
    });

    // Empty visualizations should not reserve a large, unexplained column in
    // the dashboard. The analysis card keeps its useful summary and expands
    // into charts only when the selected period has data to explain.
    const insights = document.querySelector('.insights-section');
    const hasCashflow = incomeItems.length > 0 || expenseItems.length > 0;
    const hasCategories = Object.values(categoryTotals).some(value => value > 0);
    insights?.classList.toggle('has-cashflow-data', hasCashflow);
    insights?.classList.toggle('has-category-data', hasCategories);

    updateInsight({ totalIncome, totalExpenses, categoryTotals, expenseLimit });
    if (typeof Chart === 'undefined') return;

    const colors = chartColors();
    renderCashflow(incomeItems, expenseItems, colors);
    renderCategories(categoryTotals, colors);
}
