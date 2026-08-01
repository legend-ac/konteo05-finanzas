// js/ui/insights.js — Optional monthly budget controls

import { state } from '../state.js';
import { showToast } from './toast.js';
import * as dbService from '../services/dbService.js';

function setText(id, value) {
    const element = document.getElementById(id);
    if (element) element.textContent = value;
}

function money(value) {
    return `S/ ${Math.abs(value).toFixed(2)}`;
}

export function updateStrategyPanel({ totalExpenses }) {
    const expenseLimit = state.planConfig.expenseLimit;
    const status = document.getElementById('strategy-status');
    const bar = document.getElementById('budget-progress-bar');

    if (expenseLimit <= 0) {
        setText('strategy-status', 'Sin límite definido');
        setText('budget-status-label', 'Disponible');
        setText('budget-status', '—');
        if (status) status.style.color = '';
        if (bar) bar.style.width = '0%';
        return;
    }

    const remaining = expenseLimit - totalExpenses;
    const usedPercent = Math.min((totalExpenses / expenseLimit) * 100, 100);
    if (bar) {
        bar.style.width = `${Math.max(0, usedPercent)}%`;
        bar.style.background = remaining < 0 ? 'var(--expense)' : 'var(--income)';
    }

    if (remaining < 0) {
        setText('strategy-status', `Excedido por ${money(remaining)}`);
        setText('budget-status-label', 'Excedido');
        setText('budget-status', money(remaining));
        if (status) status.style.color = 'var(--expense)';
        return;
    }

    setText('strategy-status', `${Math.round(usedPercent)}% del límite usado`);
    setText('budget-status-label', 'Disponible');
    setText('budget-status', money(remaining));
    if (status) status.style.color = '';
}

export function loadPlanConfigToUi() {
    const income = document.getElementById('plan-income-target');
    const expense = document.getElementById('plan-expense-limit');
    if (income) income.value = state.planConfig.incomeTarget > 0 ? String(state.planConfig.incomeTarget) : '';
    if (expense) expense.value = state.planConfig.expenseLimit > 0 ? String(state.planConfig.expenseLimit) : '';
}

export async function savePlanConfigFromUi() {
    const incomeTarget = Number(document.getElementById('plan-income-target')?.value || 0);
    const expenseLimit = Number(document.getElementById('plan-expense-limit')?.value || 0);

    if (incomeTarget < 0 || expenseLimit < 0) {
        showToast('Los objetivos no pueden ser negativos', 'error');
        return false;
    }
    if (!state.currentUser) {
        showToast('Error de autenticación', 'error');
        return false;
    }

    state.planConfig.incomeTarget = incomeTarget;
    state.planConfig.expenseLimit = expenseLimit;

    try {
        await dbService.savePlan(state.currentUser.uid, { incomeTarget, expenseLimit });
        showToast('Plan guardado', 'success');
        return true;
    } catch (err) {
        showToast('Error guardando plan: ' + err.message, 'error');
        return false;
    }
}
