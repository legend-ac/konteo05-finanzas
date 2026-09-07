// Shared dialog stack: one keyboard handler, scroll lock and focus restoration.
const dialogs = [];
let previousOverflow = '';
const focusSelector = 'button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), a[href], summary, [tabindex="0"]';

function focusable(modal) {
    return [...modal.querySelectorAll(focusSelector)].filter(element => {
        if (element.closest('.hidden, [hidden], [inert]')) return false;
        const collapsed = element.closest('details:not([open])');
        if (collapsed && element !== collapsed.querySelector('summary')) return false;
        const style = window.getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden';
    });
}

function onKeydown(event) {
    const entry = dialogs.at(-1);
    if (!entry) return;
    if (event.key === 'Escape') {
        event.preventDefault();
        closeModal(entry.modal.id);
    } else if (event.key === 'Tab') {
        const items = focusable(entry.modal);
        const index = items.indexOf(document.activeElement);
        if (!items.length) {
            event.preventDefault();
            entry.modal.focus();
        } else if (index < 0 || (event.shiftKey && index === 0) || (!event.shiftKey && index === items.length - 1)) {
            event.preventDefault();
            items[event.shiftKey ? items.length - 1 : 0].focus();
        }
    }
}

export function openModal(id) {
    const modal = document.getElementById(id);
    if (!modal || dialogs.some(entry => entry.modal === modal)) return;
    if (!dialogs.length) {
        previousOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        document.addEventListener('keydown', onKeydown);
    }
    const backdrop = event => {
        if (event.target === modal && dialogs.at(-1)?.modal === modal) closeModal(id);
    };
    const previous = dialogs.at(-1)?.modal;
    if (previous) { previous.inert = true; previous.setAttribute('aria-modal', 'false'); }
    dialogs.push({ modal, opener: document.activeElement, backdrop, zIndex: modal.style.zIndex });
    modal.inert = false;
    modal.style.zIndex = String(1000 + dialogs.length);
    modal.classList.remove('hidden');
    modal.setAttribute('aria-modal', 'true');
    modal.tabIndex = -1;
    modal.addEventListener('click', backdrop);
    (focusable(modal)[0] || modal).focus();
}

export function closeModal(id) {
    const modal = document.getElementById(id);
    if (!modal || modal.dataset.saving === 'true') return;
    const index = dialogs.findIndex(entry => entry.modal === modal);
    if (index >= 0 && index !== dialogs.length - 1) return;
    const entry = index >= 0 ? dialogs.pop() : null;
    modal.classList.add('hidden');
    modal.inert = false;
    if (entry) {
        modal.removeEventListener('click', entry.backdrop);
        modal.style.zIndex = entry.zIndex;
    }
    const parent = dialogs.at(-1)?.modal;
    if (parent) { parent.inert = false; parent.setAttribute('aria-modal', 'true'); }
    else if (entry) {
        document.body.style.overflow = previousOverflow;
        document.removeEventListener('keydown', onKeydown);
    }
    if (id === 'modal-income' || id === 'modal-expense') {
        const kind = id.slice(6);
        document.getElementById('form-' + kind)?.reset();
        const editId = document.getElementById(kind + '-edit-id');
        if (editId) editId.value = '';
    }
    if (entry?.opener?.isConnected && !entry.opener.closest('.hidden, [hidden], [inert]')) entry.opener.focus();
    else if (parent) (focusable(parent)[0] || parent).focus();
}
