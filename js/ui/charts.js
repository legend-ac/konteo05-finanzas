// js/ui/charts.js — Chart.js rendering

const charts = { incomeExpense: null, category: null };

/** Returns theme-aware colors for Chart.js */
function getChartColors() {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    return {
        tick: isDark ? '#9ca3af' : '#64748b',
        grid: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.07)',
        legend: isDark ? '#9ca3af' : '#64748b'
    };
}

export function renderCharts(totalIncome, totalExpenses, expenseItems) {
    if (typeof Chart === 'undefined') return;

    const colors = getChartColors();

    const ctx1 = document.getElementById('incomeExpenseChart');
    if (ctx1) {
        if (charts.incomeExpense) charts.incomeExpense.destroy();
        charts.incomeExpense = new Chart(ctx1, {
            type: 'bar',
            data: {
                labels: ['Ingresos', 'Gastos'],
                datasets: [{
                    label: 'Monto (S/)',
                    data: [totalIncome, totalExpenses],
                    backgroundColor: ['#34d399', '#f87171'],
                    borderRadius: 8
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: true,
                plugins: { legend: { display: false } },
                scales: {
                    y: {
                        beginAtZero: true,
                        ticks: { color: colors.tick },
                        grid: { color: colors.grid }
                    },
                    x: {
                        ticks: { color: colors.tick },
                        grid: { display: false }
                    }
                }
            }
        });
    }

    const categoryTotals = { green: 0, yellow: 0, red: 0 };
    expenseItems.forEach(item => {
        if (categoryTotals[item.category] !== undefined) {
            categoryTotals[item.category] += Number(item.amount) || 0;
        }
    });

    const ctx2 = document.getElementById('categoryChart');
    if (ctx2) {
        if (charts.category) charts.category.destroy();
        charts.category = new Chart(ctx2, {
            type: 'doughnut',
            data: {
                labels: ['🟢 Fijo', '🟡 Necesario', '🔴 Antojo'],
                datasets: [{
                    data: [categoryTotals.green, categoryTotals.yellow, categoryTotals.red],
                    backgroundColor: ['#34d399', '#fbbf24', '#f87171'],
                    borderWidth: 0
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: true,
                plugins: {
                    legend: {
                        position: 'bottom',
                        labels: { color: colors.legend, padding: 16 }
                    }
                }
            }
        });
    }
}
