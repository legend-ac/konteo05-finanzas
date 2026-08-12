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
                    'Google no pudo abrir la autorización.\n' +
                    'Actualiza la página y vuelve a intentarlo. Si continúa, revisa que ' +
                    'accounts.google.com no esté bloqueado en tu red o navegador.'
                ));
                return;
            }
            setTimeout(() => waitForGoogle(attempts - 1), 200);
        };

        // Si el script ya está en el DOM (cargado desde el head), solo esperar
        const existing = document.querySelector('script[src*="gsi/client"]');
        if (existing) {
            // El script se carga desde el <head>. No esperamos de más si una
            // política del navegador o una extensión lo bloquea.
            waitForGoogle(40);
            return;
        }

        // Si no está, cargarlo dinámicamente como fallback
        const script = document.createElement('script');
        script.src = 'https://accounts.google.com/gsi/client';
        script.onload = () => waitForGoogle(40);
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

        if (window.google?.accounts?.oauth2) {
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
            // La conexión empieza por una acción explícita del usuario.
            // Pedir consentimiento evita que el primer acceso falle sin abrir
            // el selector de cuenta cuando todavía no existe un permiso previo.
            tokenClient.requestAccessToken({ prompt: 'consent' });
        } else {
            reject(new Error('Google Identity Services no está disponible. Actualiza la página y vuelve a intentarlo.'));
        }
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
    'from:notificaciones@yape.pe',
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
    'from:notificaciones@notificacionesbcp.com.pe',
    // ── Ligo (BCP) ──
    'from:hola@ligo.pe',
    'from:notificaciones@ligo.pe',
    // ── Interbank ──
    'from:alertas@interbank.com.pe',
    'from:ibk@interbank.com.pe',
    'from:notificaciones@interbank.com.pe',
    'from:servicioalcliente@interbank.com.pe',
    'from:ib14680.interbank.com',
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
    'from:comunicaciones_BN@bn.com.pe',
    'from:BancaMovil_BN@bn.com.pe',
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
    'from:mibanco_digital@mibanco.com.pe',
    // ── SIP / Agora ──
    'from:no-reply@operaciones.agora.pe',
    'from:operaciones.agora.pe',
    // ── Pagos y activos digitales (se muestran para revisión si no son PEN) ──
    'from:do-not-reply@directmail.binance.com',
    'from:no-reply@pagoefectivo.pe',
];

/**
 * Busca emails de transacciones en los últimos N días.
 * @param {number} daysBack - Cuántos días hacia atrás buscar (máx. 90)
 * @returns {Promise<Array>} Lista de mensajes parseados
 */
function getCustomSenders(customEntities) {
    if (!Array.isArray(customEntities)) return [];
    return customEntities
        .filter(entity => entity?.active !== false)
        .map(entity => String(entity.sender || '').trim().toLowerCase())
        .filter(sender => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sender))
        .map(sender => `from:${sender}`);
}

function chunk(items, size) {
    return Array.from({ length: Math.ceil(items.length / size) }, (_, index) => (
        items.slice(index * size, index * size + size)
    ));
}

function labelledQuery(label, query) {
    return { label, query };
}

export async function fetchTransactionEmails(daysBack = 30, customEntities = []) {
    const safeDays = Math.max(1, Math.min(90, Number.parseInt(daysBack, 10) || 30));
    const senders = [...new Set([...SENDERS, ...getCustomSenders(customEntities)])];
    // Gmail puede devolver resultados incompletos cuando una consulta OR contiene
    // demasiados remitentes. Buscamos grupos pequeños y unimos los IDs.
    const groupedQueries = chunk(senders, 8).map((group, index) => (
        labelledQuery(`grupo-${index + 1}`, `(${group.join(' OR ')}) newer_than:${safeDays}d`)
    ));
    // Estas fuentes suelen emitir desde subdominios variables o agrupar correos
    // en conversaciones. Las consultas directas evitan que queden fuera del OR.
    const priorityQueries = [
        labelledQuery('sip', `from:no-reply@operaciones.agora.pe newer_than:${safeDays}d`),
        labelledQuery('sip-dominio', `from:operaciones.agora.pe newer_than:${safeDays}d`),
        labelledQuery('plin-interbank', `from:servicioalcliente@interbank.com.pe newer_than:${safeDays}d`),
        labelledQuery('plin-interbank-subdominio', `from:ib14680.interbank.com newer_than:${safeDays}d`),
        labelledQuery('asunto-sip', `subject:"Realizaste una operación" newer_than:${safeDays}d`),
        labelledQuery('asunto-plin', `subject:"Constancia de Pago Plin" newer_than:${safeDays}d`),
    ];
    const queries = [...groupedQueries, ...priorityQueries];
    const results = [];
    for (const batch of chunk(queries, 4)) {
        const batchResults = await Promise.all(batch.map(async ({ label, query }) => {
            const result = await gmailFetch('users/me/messages', {
                q: query,
                maxResults: 100,
            });
            return { label, result };
        }));
        console.info('[gmailImport] Resultados de búsqueda', batchResults.map(({ label, result }) => ({
            fuente: label,
            encontrados: (result.messages || []).length,
        })));
        results.push(...batchResults.map(({ result }) => result));
    }

    const messages = [...new Map(
        results.flatMap(result => result.messages || []).map(message => [message.id, message])
    ).values()];
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
