// Contextual help uses the same local values as the screen. No model, network
// request or automatic change to financial data is involved.
const amount = value => new Intl.NumberFormat('es-PE', {
    style: 'currency', currency: 'PEN'
}).format(value);

export function budgetGuide(expenseLimit, totalExpenses) {
    if (!(expenseLimit > 0)) return {
        title: 'Dale un límite a este período',
        hint: 'Cómo empezar con tu presupuesto',
        body: 'Escribe cuánto quieres permitirte gastar en el período que estás viendo. El disponible será ese límite menos los gastos registrados. Solo se guarda cuando pulsas Guardar.',
        action: 'Escribir mi límite', target: 'plan-expense-limit'
    };
    if (totalExpenses > expenseLimit) return {
        title: 'Revisa qué explica el exceso',
        hint: 'Compara tu límite con tus registros',
        body: `Registraste ${amount(totalExpenses)} en gastos frente a un límite de ${amount(expenseLimit)}. Revisa los movimientos y el período antes de modificar el presupuesto. Esta cifra no es tu saldo bancario.`,
        action: 'Revisar movimientos', target: 'search-input'
    };
    return {
        title: 'Así se calcula lo disponible',
        hint: 'Entiende tu presupuesto',
        body: `${amount(expenseLimit)} de límite − ${amount(totalExpenses)} de gastos = ${amount(expenseLimit - totalExpenses)} disponibles en el presupuesto. El límite guardado se aplica al período que selecciones; no representa el dinero real de tus cuentas.`,
        action: 'Revisar mi límite', target: 'plan-expense-limit'
    };
}

export function accountGuide(hasActiveAccounts) {
    return hasActiveAccounts ? {
        title: 'Una cuenta, un origen claro', hint: 'Cómo organizar bancos y billeteras',
        body: 'Elige una cuenta y revisa si participa en el saldo total y qué fuente tiene vinculada. Plin · BBVA y Plin · Interbank son fuentes distintas: asígnalas al banco que corresponda. Editar la configuración no mueve dinero entre bancos.',
        action: 'Revisar cuenta seleccionada', actionName: 'edit-account'
    } : {
        title: 'Empieza por una cuenta que uses', hint: 'Te acompaño a configurarla',
        body: 'Ponle un nombre reconocible, elige banco, billetera o efectivo y revisa el saldo inicial. Decide si debe entrar en tu total. Si ya hay cuentas pendientes abajo, revísalas antes de crear otra.',
        action: 'Configurar una cuenta', actionName: 'new-account'
    };
}

export function updateContextGuide(id, guide) {
    const root = document.getElementById(id);
    if (!root) return;
    for (const key of ['title', 'hint', 'body', 'action']) {
        const element = root.querySelector(`[data-guide-${key}]`);
        if (element) element.textContent = guide[key];
    }
    const action = root.querySelector('[data-guide-action]');
    if (action) {
        action.dataset.guideAction = guide.actionName || 'focus';
        action.dataset.guideTarget = guide.target || '';
    }
}

export function initContextGuides({ onNewAccount, onEditAccount } = {}) {
    document.addEventListener('click', event => {
        const button = event.target.closest('[data-guide-action]');
        if (!button) return;
        if (button.dataset.guideAction === 'new-account') return onNewAccount?.();
        if (button.dataset.guideAction === 'edit-account') return onEditAccount?.();
        const targetId = button.dataset.guideTarget;
        if (!['plan-expense-limit', 'search-input'].includes(targetId)) return;
        const target = document.getElementById(targetId);
        if (!target) return;
        target.focus({ preventScroll: true });
        target.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
    });
}
