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
        // Ya está listo
        if (window.google?.accounts?.oauth2) { resolve(); return; }

        const waitForGoogle = (attempts) => {
            if (window.google?.accounts?.oauth2) { resolve(); return; }
            if (attempts <= 0) {
                reject(new Error(
                    'No se pudo conectar con Google.\n' +
                    'Posibles causas:\n' +
                    '• Extensión de bloqueo de anuncios activa (desactívala para este sitio)\n' +
                    '• Sin conexión a internet\n' +
                    '• Firewall corporativo bloqueando accounts.google.com'
                ));
                return;
            }
            setTimeout(() => waitForGoogle(attempts - 1), 200);
        };

        // Si el script ya está en el DOM (cargado desde el head), solo esperar
        const existing = document.querySelector('script[src*="gsi/client"]');
        if (existing) {
            // Esperar hasta 15 segundos (75 intentos × 200ms)
            waitForGoogle(75);
            return;
        }

        // Si no está, cargarlo dinámicamente como fallback
        const script = document.createElement('script');
        script.src = 'https://accounts.google.com/gsi/client';
        script.onload = () => waitForGoogle(75);
        script.onerror = () => reject(new Error(
            'No se pudo cargar Google Identity Services.\n' +
            'Verifica tu conexión a internet o desactiva extensiones de bloqueo.'
        ));
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
            callback: async (response) => {
                if (response.error) {
                    reject(new Error(`OAuth error: ${response.error}`));
                    return;
                }
                accessToken = response.access_token;
                tokenExpiry = Date.now() + (response.expires_in - 60) * 1000;

                // Obtener email del usuario autenticado
                try {
                    const profileRes = await fetch(
                        'https://gmail.googleapis.com/gmail/v1/users/me/profile',
                        { headers: { Authorization: `Bearer ${accessToken}` } }
                    );
                    if (profileRes.ok) {
                        const profile = await profileRes.json();
                        connectedEmail = profile.emailAddress || null;
                    }
                } catch { connectedEmail = null; }

                resolve(accessToken);
            },
        });

        tokenClient.requestAccessToken({ prompt: '' });
    });
}

let connectedEmail = null;

export function isTokenValid() {
    return !!accessToken && Date.now() < tokenExpiry;
}

export function getConnectedEmail() {
    return connectedEmail;
}

export function revokeGmailToken() {
    if (accessToken) {
        window.google?.accounts?.oauth2?.revoke(accessToken, () => {});
        accessToken    = null;
        tokenExpiry    = 0;
        connectedEmail = null;
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
    // ── Billeteras digitales ──
    'from:noreply@yape.com.pe',
    'from:notificaciones@plin.pe',
    'from:hola@izipay.pe',
    'from:notificaciones@tunki.pe',
    'from:bim@bim.com.pe',
    'from:noreply@mercadopago.com',
    'from:notification@mercadolibre.com',
    'from:noreply@wise.com',
    'from:hello@wise.com',
    'from:noreply@payoneer.com',
    'from:payoneer@payoneer.com',
    'from:hola@maximo.pe',
    // ── BCP ──
    'from:notificaciones@notificaciones.viabcp.com',
    'from:alertas@viabcp.com',
    'from:noreply@viabcp.com',
    'from:bcp@viabcp.com',
    // ── Ligo (BCP) ──
    'from:hola@ligo.pe',
    'from:notificaciones@ligo.pe',
    // ── Interbank ──
    'from:alertas@interbank.com.pe',
    'from:ibk@interbank.com.pe',
    'from:notificaciones@interbank.com.pe',
    // ── BBVA ──
    'from:alertas@bbva.pe',
    'from:bbva@bbvacontinental.com',
    'from:notificaciones@bbva.pe',
    // ── Scotiabank ──
    'from:notificaciones@scotiabank.com.pe',
    'from:alertas@scotiabank.com.pe',
    // ── BanBif ──
    'from:notificaciones@banbif.com.pe',
    'from:alertas@banbif.com.pe',
    // ── Banco Pichincha ──
    'from:notificaciones@pichincha.com.pe',
    'from:alertas@pichincha.com.pe',
    // ── Banco de la Nación ──
    'from:notificaciones@bn.com.pe',
    'from:alertas@bn.com.pe',
    // ── Banco Falabella ──
    'from:notificaciones@bancofalabella.com.pe',
    'from:transaccional@bancofalabella.com.pe',
    // ── Banco Ripley ──
    'from:notificaciones@bancoripley.com.pe',
    'from:alertas@bancoripley.com.pe',
    // ── Financiera Oh! ──
    'from:notificaciones@financieraoh.com.pe',
    'from:alertas@financieraoh.com.pe',
    // ── Nu (Nubank) ──
    'from:no-reply@nu.com.pe',
    'from:hola@nu.com.pe',
    // ── Neobancos ──
    'from:hola@b89.pe',
    'from:notificaciones@kambista.com',
    'from:hola@ual.la',
    // ── Cajas Municipales ──
    'from:notificaciones@cajaarequipa.com.pe',
    'from:notificaciones@cajahuancayo.com.pe',
    'from:notificaciones@cajapiura.com.pe',
    'from:notificaciones@cajacusco.pe',
    'from:notificaciones@cajatrujillo.com.pe',
    'from:notificaciones@cajasullana.com.pe',
    'from:notificaciones@cajatacna.com.pe',
    'from:notificaciones@cajamaynas.com.pe',
    'from:notificaciones@cmac-ica.com.pe',
    // ── MiBanco ──
    'from:notificaciones@mibanco.com.pe',
    'from:alertas@mibanco.com.pe',
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
