// Compact in-product feedback. Toasts are reserved for results or recoverable
// errors; navigation events such as signing out do not need an interruption.
const ICON_PATHS = {
    success: ['M5 12l4 4L19 6'],
    error: ['M6 6l12 12', 'M18 6L6 18'],
    warning: ['M12 8v5', 'M12 16h.01'],
    info: ['M12 16v-4', 'M12 8h.01']
};

function normalizeType(type) {
    if (type === 'warn') return 'warning';
    return Object.hasOwn(ICON_PATHS, type) ? type : 'success';
}

function createIcon(type) {
    const icon = document.createElement('span');
    icon.className = 'toast-icon';
    icon.setAttribute('aria-hidden', 'true');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2.2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    ICON_PATHS[type].forEach(d => {
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', d);
        svg.appendChild(path);
    });
    icon.appendChild(svg);
    return icon;
}

function cleanMessage(message) {
    return String(message || '').replace(/^(?:[\u2705\u274c\u26a0\u2139]\ufe0f?\s*)+/iu, '');
}

export function showToast(message, type = 'success') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const notificationType = normalizeType(type);
    const text = cleanMessage(message);
    const key = `${notificationType}:${text}`;
    const existing = [...container.children].find(item => item.dataset.toastKey === key);
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = `toast toast-${notificationType}`;
    toast.dataset.toastKey = key;
    toast.setAttribute('role', notificationType === 'error' || notificationType === 'warning' ? 'alert' : 'status');

    const content = document.createElement('div');
    content.className = 'toast-content';
    const messageElement = document.createElement('p');
    messageElement.className = 'toast-message';
    messageElement.textContent = text;
    content.appendChild(messageElement);

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'toast-close';
    close.setAttribute('aria-label', 'Cerrar aviso');
    close.textContent = '×';
    close.addEventListener('click', () => toast.remove());

    toast.append(createIcon(notificationType), content, close);
    container.appendChild(toast);

    window.setTimeout(() => {
        if (!toast.isConnected) return;
        toast.classList.add('hiding');
        window.setTimeout(() => toast.remove(), 180);
    }, notificationType === 'error' || notificationType === 'warning' ? 5600 : 3200);
}
