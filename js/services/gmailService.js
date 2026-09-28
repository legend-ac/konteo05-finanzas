// js/services/gmailService.js
// Gmail API integration via Google Identity Services (GIS) OAuth 2.0
// Scope: gmail.readonly — SOLO lectura, nunca envía ni modifica emails
import { withDeadline } from './asyncControl.js';

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
    return withDeadline(() => new Promise((resolve, reject) => {
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
    }), 10000);
}

// ─────────────────────────────────────────────
// AUTH: Solicita token OAuth Gmail readonly
// ─────────────────────────────────────────────
export function requestGmailToken() {
    return withDeadline(() => new Promise((resolve, reject) => {
        const clientId = getClientId();
        if (!clientId) {
            reject(new Error('Gmail Client ID no configurado. Agrega gmailClientId en runtime-config.js'));
            return;
        }

        if (window.google?.accounts?.oauth2) {
            tokenClient = window.google.accounts.oauth2.initTokenClient({
                client_id: clientId,
                scope: GMAIL_SCOPE,
                error_callback: error => reject(new Error(error.type === 'popup_closed' ? 'Cerraste la autorización de Gmail.' : 'Google no pudo abrir la autorización. Permite las ventanas emergentes.')),
                callback: async (response) => {
                    if (response.error) {
                        reject(new Error(`OAuth error: ${response.error}`));
                        return;
                    }
                    accessToken = response.access_token;
                    tokenExpiry = Date.now() + (response.expires_in - 60) * 1000;
                    // Obtener email del usuario autenticado
                    try {
                        const profile = await gmailFetch('users/me/profile');
                        connectedEmail = profile.emailAddress || null;
                    } catch { connectedEmail = null; }
                    resolve(accessToken);
                },
            });
            // La conexión empieza por una acción explícita del usuario. No
            // forzar `prompt: 'consent'`: Google conserva el consentimiento
            // por usuario y Client ID. Así las conexiones posteriores reutilizan
            // el permiso ya concedido y no repiten el diálogo.
            tokenClient.requestAccessToken();
        } else {
            reject(new Error('Google Identity Services no está disponible. Actualiza la página y vuelve a intentarlo.'));
        }
    }), 120000);
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
    const token = accessToken;
    for (let attempt = 0; attempt < 3; attempt++) {
        const controller = new window.AbortController();
        const timeout = setTimeout(() => controller.abort(), 25000); // Bug 6: 15s era insuficiente para emails pesados (BCP/IBK HTML+imágenes)
        try {
            const res = await fetch(url.toString(), {
                headers: { Authorization: `Bearer ${token}` }, signal: controller.signal
            });
            if ([429, 500, 502, 503, 504].includes(res.status) && attempt < 2) {
                clearTimeout(timeout);
                await new Promise(resolve => setTimeout(resolve, Math.min(3000, 500 * 2 ** attempt)));
                continue;
            }
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                const failure = new Error(err.error?.message || `Gmail API error ${res.status}`);
                failure.code = `gmail-${res.status}`;
                if (res.status === 401 && accessToken === token) tokenExpiry = 0;
                throw failure;
            }
            return await res.json();
        } catch (error) {
            if (error.name === 'AbortError') throw new Error('Gmail no respondió en 15 segundos. Comprueba la conexión y reintenta.');
            throw error;
        } finally { clearTimeout(timeout); }
    }
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
    'from:servicioalcliente@netinterbank.com.pe',
    'from:ib14680.interbank.com',
    // ── BBVA ──
    'from:alertas@bbva.pe',
    'from:bbva@bbvacontinental.com',
    'from:notificaciones@bbva.pe',
    'from:procesos@bbva.com.pe',
    'from:noreply@bbva.pe',
    'from:notificaciones-gateway@bbva.com.pe',
    'from:notifications-gateway-mail-us.bbva.com.pe',
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

// Registro unico de fuentes conocidas. Cada grupo controla exactamente los
// remitentes que se consultan; asi una entidad desactivada no queda escondida
// dentro de una busqueda global. Plin es un canal: BBVA e Interbank mantienen
// sus propias fuentes y recibos, mientras que Plin sin banco queda separado.
export const KNOWN_GMAIL_ENTITIES = [
    { id: 'yape', name: 'Yape', detail: 'Billetera digital', senders: ['from:noreply@yape.com.pe', 'from:notificaciones@yape.pe'] },
    { id: 'plin', name: 'Plin sin banco confirmado', detail: 'Solo recibos sin banco de origen', senders: ['from:notificaciones@plin.pe'] },
    { id: 'bcp', name: 'BCP', detail: 'Incluye Ligo', senders: ['from:notificaciones@notificaciones.viabcp.com', 'from:alertas@viabcp.com', 'from:noreply@viabcp.com', 'from:bcp@viabcp.com', 'from:notificaciones@notificacionesbcp.com.pe', 'from:hola@ligo.pe', 'from:notificaciones@ligo.pe'] },
    { id: 'interbank', name: 'Interbank', detail: 'Incluye comprobantes Plin de Interbank', senders: ['from:alertas@interbank.com.pe', 'from:ibk@interbank.com.pe', 'from:notificaciones@interbank.com.pe', 'from:servicioalcliente@interbank.com.pe', 'from:servicioalcliente@netinterbank.com.pe', 'from:ib14680.interbank.com'] },
    { id: 'bbva', name: 'BBVA', detail: 'Incluye comprobantes Plin de BBVA', senders: ['from:alertas@bbva.pe', 'from:bbva@bbvacontinental.com', 'from:notificaciones@bbva.pe', 'from:procesos@bbva.com.pe', 'from:noreply@bbva.pe', 'from:notificaciones-gateway@bbva.com.pe', 'from:notifications-gateway-mail-us.bbva.com.pe'] },
    { id: 'scotiabank', name: 'Scotiabank', detail: 'Banco', senders: ['from:notificaciones@scotiabank.com.pe', 'from:alertas@scotiabank.com.pe'] },
    { id: 'banbif', name: 'BanBif', detail: 'Banco', senders: ['from:notificaciones@banbif.com.pe', 'from:alertas@banbif.com.pe'] },
    { id: 'pichincha', name: 'Banco Pichincha', detail: 'Banco', senders: ['from:notificaciones@pichincha.com.pe', 'from:alertas@pichincha.com.pe'] },
    { id: 'nacion', name: 'Banco de la Nacion', detail: 'Banco', senders: ['from:notificaciones@bn.com.pe', 'from:alertas@bn.com.pe', 'from:comunicaciones_BN@bn.com.pe', 'from:BancaMovil_BN@bn.com.pe'] },
    { id: 'mibanco', name: 'MiBanco', detail: 'Banco', senders: ['from:notificaciones@mibanco.com.pe', 'from:alertas@mibanco.com.pe', 'from:mibanco_digital@mibanco.com.pe'] },
    { id: 'sip', name: 'SIP / Agora', detail: 'Pagos', senders: ['from:no-reply@operaciones.agora.pe', 'from:operaciones.agora.pe'] },
    { id: 'pagoefectivo', name: 'PagoEfectivo', detail: 'Pagos', senders: ['from:no-reply@pagoefectivo.pe'] },
    { id: 'binance', name: 'Binance', detail: 'Activo digital', senders: ['from:do-not-reply@directmail.binance.com'] },
    { id: 'wallets', name: 'Otras billeteras', detail: 'Izipay, Tunki, BIM y Mercado Pago', senders: ['from:hola@izipay.pe', 'from:notificaciones@tunki.pe', 'from:bim@bim.com.pe', 'from:noreply@mercadopago.com', 'from:notification@mercadolibre.com', 'from:hola@maximo.pe'] },
    { id: 'international', name: 'Wise y Payoneer', detail: 'Servicios internacionales', senders: ['from:noreply@wise.com', 'from:hello@wise.com', 'from:noreply@payoneer.com', 'from:payoneer@payoneer.com'] },
    { id: 'cards', name: 'Tarjetas y consumo', detail: 'Falabella, Ripley, Oh! y Nu', senders: ['from:notificaciones@bancofalabella.com.pe', 'from:transaccional@bancofalabella.com.pe', 'from:notificaciones@bancoripley.com.pe', 'from:alertas@bancoripley.com.pe', 'from:notificaciones@financieraoh.com.pe', 'from:alertas@financieraoh.com.pe', 'from:no-reply@nu.com.pe', 'from:hola@nu.com.pe'] },
    { id: 'digital', name: 'Finanzas digitales', detail: 'B89, Kambista y Uala', senders: ['from:hola@b89.pe', 'from:notificaciones@kambista.com', 'from:hola@ual.la'] },
    { id: 'cajas', name: 'Cajas municipales', detail: 'Arequipa, Huancayo, Piura y otras', senders: ['from:notificaciones@cajaarequipa.com.pe', 'from:notificaciones@cajahuancayo.com.pe', 'from:notificaciones@cajapiura.com.pe', 'from:notificaciones@cajacusco.pe', 'from:notificaciones@cajatrujillo.com.pe', 'from:notificaciones@cajasullana.com.pe', 'from:notificaciones@cajatacna.com.pe', 'from:notificaciones@cajamaynas.com.pe', 'from:notificaciones@cmac-ica.com.pe'] }
];

function knownSendersFor(enabledIds) {
    if (!Array.isArray(enabledIds)) return SENDERS;
    const enabled = new Set(enabledIds);
    return KNOWN_GMAIL_ENTITIES
        .filter(entity => enabled.has(entity.id))
        .flatMap(entity => entity.senders);
}

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

export async function fetchTransactionEmails(daysBack = 30, customEntities = [], options = {}) {
    const safeDays = Math.max(1, Math.min(90, Number.parseInt(daysBack, 10) || 30));
    const customSenders = getCustomSenders(customEntities);
    const onlyConfiguredEntities = options.onlyConfiguredEntities === true;
    const enabledKnownEntityIds = Array.isArray(options.enabledKnownEntityIds)
        ? options.enabledKnownEntityIds : null;
    if (onlyConfiguredEntities && customSenders.length === 0) {
        throw new Error('Activa al menos una entidad antes de limitar la lectura de Gmail.');
    }
    const knownSenders = onlyConfiguredEntities ? [] : knownSendersFor(enabledKnownEntityIds);
    const senders = [...new Set([...knownSenders, ...customSenders])];
    if (!senders.length) throw new Error('Activa al menos una fuente de correo antes de revisar Gmail.');
    const enabledKnown = enabledKnownEntityIds ? new Set(enabledKnownEntityIds) : null;
    const isKnownEnabled = id => !enabledKnown || enabledKnown.has(id);
    // Gmail puede devolver resultados incompletos cuando una consulta OR contiene
    // demasiados remitentes. Buscamos grupos pequeños y unimos los IDs.
    const groupedQueries = chunk(senders, 8).map((group, index) => (
        labelledQuery(`grupo-${index + 1}`, `(${group.join(' OR ')}) newer_than:${safeDays}d`)
    ));
    // Estas fuentes suelen emitir desde subdominios variables o agrupar correos
    // en conversaciones. Las consultas directas evitan que queden fuera del OR.
    const priorityQueries = onlyConfiguredEntities ? [] : [
        // BBVA PLIN receipts can be grouped differently by Gmail; query this
        // sender directly so they are not lost inside a large OR search.
        labelledQuery('plin-bbva', `from:procesos@bbva.com.pe newer_than:${safeDays}d`),
        labelledQuery('plin-bbva-gateway', `from:notifications-gateway-mail-us.bbva.com.pe newer_than:${safeDays}d`),
        labelledQuery('plin-bbva-qr', `(from:procesos@bbva.com.pe OR from:notificaciones@bbva.pe OR from:alertas@bbva.pe) (plin OR "pago con QR" OR "constancia de pago a comercios") newer_than:${safeDays}d`),
        labelledQuery('plin-bbva-subject', `(subject:"Constancia de pago a comercios con QR" OR subject:"Constancia de operacion transferencia PLIN") newer_than:${safeDays}d`),
        // Fallback for BBVA's mail gateway: Gmail sometimes indexes the
        // delivered-by address rather than the visible From header. These
        // subjects are then filtered again by the parser before any import.
        labelledQuery('plin-bbva-receipt-text', `("Plineaste" OR "Constancia de operación transferencia PLIN") newer_than:${safeDays}d`),
        labelledQuery('plin-bbva-detail-text', `in:anywhere "Detalles de tu plineo" newer_than:${safeDays}d`),
        labelledQuery('sip', `from:no-reply@operaciones.agora.pe newer_than:${safeDays}d`),
        labelledQuery('sip-dominio', `from:operaciones.agora.pe newer_than:${safeDays}d`),
        labelledQuery('plin-interbank', `(from:servicioalcliente@interbank.com.pe OR from:servicioalcliente@netinterbank.com.pe) newer_than:${safeDays}d`),
        labelledQuery('plin-interbank-subdominio', `from:ib14680.interbank.com newer_than:${safeDays}d`),
        labelledQuery('asunto-sip', `subject:"Realizaste una operación" newer_than:${safeDays}d`),
        labelledQuery('asunto-plin', `subject:"Constancia de Pago Plin" newer_than:${safeDays}d`),
    ];
    const priorityEntityByLabel = {
        'plin-bbva': 'bbva', 'plin-bbva-gateway': 'bbva', 'plin-bbva-qr': 'bbva',
        'plin-bbva-subject': 'bbva', 'plin-bbva-receipt-text': 'bbva', 'plin-bbva-detail-text': 'bbva',
        sip: 'sip', 'sip-dominio': 'sip', 'asunto-sip': 'sip',
        'plin-interbank': 'interbank', 'plin-interbank-subdominio': 'interbank',
        'asunto-plin': 'plin'
    };
    const genericPriorityLabels = new Set([
        'plin-bbva-subject', 'plin-bbva-receipt-text', 'plin-bbva-detail-text',
        'asunto-sip', 'asunto-plin'
    ]);
    const enabledPriorityQueries = priorityQueries.filter(item => (
        !genericPriorityLabels.has(item.label) && isKnownEnabled(priorityEntityByLabel[item.label] || '')
    ));
    const queries = [...groupedQueries, ...enabledPriorityQueries];
    const results = [];
    for (const batch of chunk(queries, 4)) {
        const batchResults = await Promise.all(batch.map(async ({ label, query }) => {
            const messages = [];
            const pages = new Set();
            let pageToken = '';
            do {
                const result = await gmailFetch('users/me/messages', {
                    q: query, maxResults: 500, ...(pageToken ? { pageToken } : {})
                });
                messages.push(...(result.messages || []));
                pageToken = result.nextPageToken || '';
                if (pageToken && pages.has(pageToken)) throw new Error('Gmail repitió una página de resultados. Vuelve a intentar.');
                pages.add(pageToken);
            } while (pageToken);
            return { label, result: { messages } };
        }));
        console.info('[gmailImport] Resultados de búsqueda', batchResults.map(({ label, result }) => ({
            fuente: label,
            encontrados: (result.messages || []).length,
        })));
        results.push(...batchResults.map(({ result }) => result));
    }

    const messages = [...new Map(
        results.flatMap(result => result.messages || []).map(message => [message.id, message])
    ).values()].filter(message => !options.existingIds?.has(message.id));
    if (messages.length === 0) return [];

    // Obtener contenido de cada mensaje en paralelo (lotes de 5)
    // Bug 6: reducir de 10 a 5 para evitar que los emails pesados agoten el timeout de red
    const rawMessages = [];
    for (let i = 0; i < messages.length; i += 5) {
        const batch = messages.slice(i, i + 5);
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
function decodeBase64UrlUtf8(value) {
    const input = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
    const padded = input + '='.repeat((4 - input.length % 4) % 4);
    const binary = atob(padded);
    // atob returns byte-like Latin-1. Financial receipts regularly contain
    // accents and names, so decode those bytes as UTF-8 before parsing them.
    const Decoder = globalThis.TextDecoder;
    if (!Decoder) return binary;
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    return new Decoder('utf-8', { fatal: false }).decode(bytes);
}

function htmlReceiptText(html) {
    const tmp = document.createElement('div');
    // Tables in voucher emails often keep labels and amounts in separate cells.
    // Preserve their boundaries instead of concatenating e.g. "MontoS/50.00".
    tmp.innerHTML = String(html || '')
        .replace(/<br\s*\/?\s*>/gi, '\n')
        .replace(/<\/(?:p|div|li|tr|td|th|h[1-6])\s*>/gi, '\n');
    return tmp.innerText || tmp.textContent || '';
}

export function decodeEmailBody(message) {
    const payload = message.payload;
    if (!payload) return '';

    const extractText = (part) => {
        if (!part) return '';
        if (part.mimeType === 'text/plain' && part.body?.data) {
            return decodeBase64UrlUtf8(part.body.data);
        }
        if (part.mimeType === 'text/html' && part.body?.data) {
            return htmlReceiptText(decodeBase64UrlUtf8(part.body.data));
        }
        if (part.parts) {
            // Bug 5: en multipart/alternative anidado, priorizar text/plain para evitar que
            // se concatenen el texto y el HTML (que incluye tags basura) en el mismo body.
            const plain = part.parts.find(p => p.mimeType === 'text/plain');
            if (plain) return extractText(plain);
            const html = part.parts.find(p => p.mimeType === 'text/html');
            if (html) return extractText(html);
            // Otros sub-tipos (embedded, adjuntos): recursivo pero sin duplicar contenido
            return part.parts.map(extractText).filter(Boolean).join('\n');
        }
        return '';
    };

    if (payload.body?.data) {
        const raw = decodeBase64UrlUtf8(payload.body.data);
        if (payload.mimeType === 'text/html') {
            return htmlReceiptText(raw);
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
    const headerDate = date ? new Date(date.value) : null;
    if (headerDate instanceof Date && Number.isFinite(headerDate.getTime())) return headerDate;
    const internalDate = Number(message.internalDate);
    const fallback = Number.isFinite(internalDate) ? new Date(internalDate) : null;
    return fallback instanceof Date && Number.isFinite(fallback.getTime()) ? fallback : null;
}

export function getEmailSubject(message) {
    const headers = message.payload?.headers || [];
    const subject = headers.find(h => h.name.toLowerCase() === 'subject');
    return subject?.value || '';
}
