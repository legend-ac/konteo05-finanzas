// Amounts are accumulated in cents. Pending/voided/cancelled entries stay in
// the ledger but must not change posted balances or spending charts.
export function isPosted(item) {
    return !item.status || item.status === 'completed';
}

export function sumAmounts(items) {
    return items.reduce((cents, item) => cents + Math.round((Number(item.amount) || 0) * 100), 0) / 100;
}

export function summarizeCashflow(incomeItems, expenseItems) {
    const realIncomeItems = incomeItems.filter(item => isPosted(item) && !item.isTransfer && !item.transferId && item.operationType !== 'transfer_in');
    const realExpenseItems = expenseItems.filter(item => isPosted(item) && !item.isTransfer && !item.transferId && item.operationType !== 'transfer_out');
    const totalIncome = sumAmounts(realIncomeItems);
    const totalExpenses = sumAmounts(realExpenseItems);
    return { realIncomeItems, realExpenseItems, totalIncome, totalExpenses, balance: (Math.round(totalIncome * 100) - Math.round(totalExpenses * 100)) / 100 };
}
