// js/services/gmailService.js
// Gmail API integration via Google Identity Services (GIS) OAuth 2.0
// Scope: gmail.readonly — SOLO lectura, nunca envía ni modifica emails

const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

// Client ID de Google Cloud OAuth — se inyecta desde runtime-config
const getClientId = () => {
    const cfg = window.__KONTEO_FIREBASE_CONFIG__ || {};
    return cfg.gmailClientId || null;
};

let tokenClient = null;
let accessToken = null;
let tokenExpiry = 0;

// ─────────────────────────────────────────────
// INIT: Carga Google Identity Services
// ─────────────────────────────────────────────
export function initGmailService() {
    return new Promise((resolve, reject) => {
        if (window.google?.accounts?.oauth2) { resolve(); return; }
        const script = document.createElement('script');
        script.src = 'https://accounts.google.com/gsi/client';
        script.async = true;
        script.defer = true;
        script.onload = resolve;
        script.onerror = () => reject(new Error('No se pudo cargar Google Identity Services'));
        document.head.appendChild(script);
    });
}

// ─────────────────────────────────────────────
// AUTH: Solicita token OAuth Gmail readonly
// ─────────────────────────────────────────────
export function requestGmailToken() {
    return new Promise((resolve, reject) => {
        const clientId = getClientId();
        if (!clientId) {
            reject(new Error('Gmail Client ID no configurado. Agrega gmailClientId en runtime-config.js'));
            return;
        }

        tokenClient = window.google.accounts.oauth2.initTokenClient({
            client_id: clientId,
            scope: GMAIL_SCOPE,
            callback: (response) => {
                if (response.error) {
                    reject(new Error(`OAuth error: ${response.error}`));
                    return;
                }
                accessToken = response.access_token;
                tokenExpiry = Date.now() + (response.expires_in - 60) * 1000;
                resolve(accessToken);
            },
        });

        tokenClient.requestAccessToken({ prompt: '' });
    });
}

export function isTokenValid() {
    return accessToken && Date.now() < tokenExpiry;
}

export function revokeGmailToken() {
    if (accessToken) {
        window.google?.accounts?.oauth2?.revoke(accessToken, () => {});
        accessToken = null;
        tokenExpiry = 0;
    }
}

// ─────────────────────────────────────────────
// GMAIL API: llama a la REST API directamente
// ─────────────────────────────────────────────
async function gmailFetch(path, params = {}) {
    if (!isTokenValid()) throw new Error('Token de Gmail expirado. Reconecta tu cuenta.');
    const url = new URL(`https://gmail.googleapis.com/gmail/v1/${path}`);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    const res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error?.message || `Gmail API error ${res.status}`);
    }
    return res.json();
}

// ─────────────────────────────────────────────
// SEARCH: Busca emails de bancos/apps peruanas
// ─────────────────────────────────────────────

// Remitentes conocidos de notificaciones financieras peruanas
const SENDERS = [
    // Yape y Plin
    'from:noreply@yape.com.pe',
    'from:notificaciones@plin.pe',
    // BCP
    'from:notificaciones@notificaciones.viabcp.com',
    'from:alertas@viabcp.com',
    // Interbank
    'from:alertas@interbank.com.pe',
    'from:ibk@interbank.com.pe',
    // BBVA
    'from:alertas@bbva.pe',
    'from:bbva@bbvacontinental.com',
    // Scotiabank
    'from:notificaciones@scotiabank.com.pe',
    // BanBif
    'from:notificaciones@banbif.com.pe',
    // MiBanco
    'from:notificaciones@mibanco.com.pe',
];

/**
 * Busca emails de transacciones en los últimos N días.
 * @param {number} daysBack - Cuántos días hacia atrás buscar (máx. 90)
 * @returns {Promise<Array>} Lista de mensajes parseados
 */
export async function fetchTransactionEmails(daysBack = 30) {
    const afterDate = Math.floor((Date.now() - daysBack * 86400000) / 1000);
    const senderQuery = SENDERS.join(' OR ');
    const query = `(${senderQuery}) after:${afterDate}`;

    // Buscar IDs de mensajes
    const searchResult = await gmailFetch('users/me/messages', {
        q: query,
        maxResults: 100,
    });

    const messages = searchResult.messages || [];
    if (messages.length === 0) return [];

    // Obtener contenido de cada mensaje en paralelo (lotes de 10)
    const rawMessages = [];
    for (let i = 0; i < messages.length; i += 10) {
        const batch = messages.slice(i, i + 10);
        const fetched = await Promise.all(
            batch.map(m => gmailFetch(`users/me/messages/${m.id}`, { format: 'full' }))
        );
        rawMessages.push(...fetched);
    }

    return rawMessages;
}

// ─────────────────────────────────────────────
// DECODE: Decodifica el body de un email
// ─────────────────────────────────────────────
export function decodeEmailBody(message) {
    const payload = message.payload;
    if (!payload) return '';

    const extractText = (part) => {
        if (!part) return '';
        if (part.mimeType === 'text/plain' && part.body?.data) {
            return atob(part.body.data.replace(/-/g, '+').replace(/_/g, '/'));
        }
        if (part.mimeType === 'text/html' && part.body?.data) {
            const html = atob(part.body.data.replace(/-/g, '+').replace(/_/g, '/'));
            // Extrae texto plano del HTML
            const tmp = document.createElement('div');
            tmp.innerHTML = html;
            return tmp.innerText || tmp.textContent || '';
        }
        if (part.parts) {
            return part.parts.map(extractText).join('\n');
        }
        return '';
    };

    if (payload.body?.data) {
        const raw = atob(payload.body.data.replace(/-/g, '+').replace(/_/g, '/'));
        if (payload.mimeType === 'text/html') {
            const tmp = document.createElement('div');
            tmp.innerHTML = raw;
            return tmp.innerText || tmp.textContent || '';
        }
        return raw;
    }

    return (payload.parts || []).map(extractText).join('\n');
}

export function getEmailSender(message) {
    const headers = message.payload?.headers || [];
    const from = headers.find(h => h.name.toLowerCase() === 'from');
    return from?.value?.toLowerCase() || '';
}

export function getEmailDate(message) {
    const headers = message.payload?.headers || [];
    const date = headers.find(h => h.name.toLowerCase() === 'date');
    return date ? new Date(date.value) : new Date(message.internalDate * 1);
}

export function getEmailSubject(message) {
    const headers = message.payload?.headers || [];
    const subject = headers.find(h => h.name.toLowerCase() === 'subject');
    return subject?.value || '';
}
