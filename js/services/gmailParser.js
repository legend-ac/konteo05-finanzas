// js/services/gmailParser.js
// Parsers de emails de transacciones financieras peruanas
// Cada parser recibe { sender, subject, body, date } y retorna una transacción o null

/**
 * Estructura de transacción normalizada:
 * {
 *   type:        'income' | 'expense'
 *   amount:      number
 *   description: string
 *   category:    string  (para income: 'otros' | 'sueldo' | etc.)
 *               (para expense: 'yellow' | 'red' | 'green')
 *   source:      string  ('yape' | 'bcp' | 'interbank' | etc.)
 *   date:        Date
 *   rawText:     string  (texto original para auditoría)
 *   gmailId:     string  (ID del email — para deduplicación)
 * }
 */

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

function extractAmount(text) {
    // Captura patrones como: S/ 150.00 | S/150 | S/. 250.50 | 1,200.00
    const patterns = [
        /S\/\.?\s*([\d,]+\.?\d{0,2})/i,
        /PEN\s*([\d,]+\.?\d{0,2})/i,
        /soles?\s*([\d,]+\.?\d{0,2})/i,
    ];
    for (const pat of patterns) {
        const m = text.match(pat);
        if (m) {
            const clean = m[1].replace(/,/g, '');
            const val = parseFloat(clean);
            if (!isNaN(val) && val > 0) return val;
        }
    }
    return null;
}

function cleanName(raw) {
    return (raw || '').replace(/\s+/g, ' ').trim().slice(0, 80);
}

function todayStr(date) {
    // Retorna YYYY-MM-DD en hora local
    const d = date || new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ─────────────────────────────────────────────
// PARSERS POR FUENTE
// ─────────────────────────────────────────────

// YAPE
function parseYape(ctx) {
    const { body, subject, date, gmailId } = ctx;
    const text = `${subject}\n${body}`;

    // Transferencia recibida
    const received = text.match(/recibiste\s+S\/\.?\s*([\d,]+\.?\d{0,2})\s+de\s+([^\n\r.]+)/i);
    if (received) {
        const amount = parseFloat(received[1].replace(/,/g, ''));
        const from = cleanName(received[2]);
        return {
            type: 'income', amount, source: 'yape',
            description: `Yape de ${from}`,
            category: 'otros',
            date: todayStr(date), gmailId, rawText: text.slice(0, 300)
        };
    }

    // Transferencia enviada
    const sent = text.match(/enviaste?\s+S\/\.?\s*([\d,]+\.?\d{0,2})\s+a\s+([^\n\r.]+)/i)
        || text.match(/transferiste?\s+S\/\.?\s*([\d,]+\.?\d{0,2})\s+a\s+([^\n\r.]+)/i);
    if (sent) {
        const amount = parseFloat(sent[1].replace(/,/g, ''));
        const to = cleanName(sent[2]);
        return {
            type: 'expense', amount, source: 'yape',
            description: `Yape a ${to}`,
            category: 'yellow',
            date: todayStr(date), gmailId, rawText: text.slice(0, 300)
        };
    }

    // Pago en comercio con Yape
    const payment = text.match(/pagaste?\s+S\/\.?\s*([\d,]+\.?\d{0,2})\s+(?:en|a)\s+([^\n\r.]+)/i);
    if (payment) {
        const amount = parseFloat(payment[1].replace(/,/g, ''));
        const merchant = cleanName(payment[2]);
        return {
            type: 'expense', amount, source: 'yape',
            description: `Yape - ${merchant}`,
            category: 'yellow',
            date: todayStr(date), gmailId, rawText: text.slice(0, 300)
        };
    }

    // Recarga de saldo
    const topup = text.match(/recarga\s+de\s+S\/\.?\s*([\d,]+\.?\d{0,2})/i);
    if (topup) {
        const amount = parseFloat(topup[1].replace(/,/g, ''));
        return {
            type: 'income', amount, source: 'yape',
            description: 'Recarga Yape',
            category: 'otros',
            date: todayStr(date), gmailId, rawText: text.slice(0, 300)
        };
    }

    return null;
}

// PLIN
function parsePlin(ctx) {
    const { body, subject, date, gmailId } = ctx;
    const text = `${subject}\n${body}`;

    const received = text.match(/recibiste?\s+S\/\.?\s*([\d,]+\.?\d{0,2})\s+de\s+([^\n\r.]+)/i);
    if (received) {
        const amount = parseFloat(received[1].replace(/,/g, ''));
        const from = cleanName(received[2]);
        return {
            type: 'income', amount, source: 'plin',
            description: `Plin de ${from}`,
            category: 'otros',
            date: todayStr(date), gmailId, rawText: text.slice(0, 300)
        };
    }

    const sent = text.match(/env(?:iaste?|ío de)\s+S\/\.?\s*([\d,]+\.?\d{0,2})\s+a\s+([^\n\r.]+)/i);
    if (sent) {
        const amount = parseFloat(sent[1].replace(/,/g, ''));
        const to = cleanName(sent[2]);
        return {
            type: 'expense', amount, source: 'plin',
            description: `Plin a ${to}`,
            category: 'yellow',
            date: todayStr(date), gmailId, rawText: text.slice(0, 300)
        };
    }

    return null;
}

// BCP (Banco de Crédito del Perú)
function parseBCP(ctx) {
    const { body, subject, date, gmailId } = ctx;
    const text = `${subject}\n${body}`;

    // Cargo / pago con tarjeta
    const charge = text.match(/(?:cargo|pago|compra)\s+(?:de\s+)?S\/\.?\s*([\d,]+\.?\d{0,2})\s+(?:en|a|para)\s+([^\n\r]+)/i);
    if (charge) {
        const amount = parseFloat(charge[1].replace(/,/g, ''));
        const merchant = cleanName(charge[2]).replace(/\..*/,'').trim();
        return {
            type: 'expense', amount, source: 'bcp',
            description: `BCP - ${merchant}`,
            category: 'yellow',
            date: todayStr(date), gmailId, rawText: text.slice(0, 300)
        };
    }

    // Abono / depósito
    const credit = text.match(/(?:abono|depósito|deposito|transferencia recibida)\s+(?:de\s+)?S\/\.?\s*([\d,]+\.?\d{0,2})/i);
    if (credit) {
        const amount = parseFloat(credit[1].replace(/,/g, ''));
        // intenta extraer remitente
        const fromMatch = text.match(/(?:de|proveniente de)\s+([A-ZÁÉÍÓÚ][^\n\r]{2,40})/);
        const from = fromMatch ? cleanName(fromMatch[1]) : 'Transferencia BCP';
        return {
            type: 'income', amount, source: 'bcp',
            description: `BCP - ${from}`,
            category: 'otros',
            date: todayStr(date), gmailId, rawText: text.slice(0, 300)
        };
    }

    // Monto genérico en asunto
    const generic = extractAmount(text);
    if (generic) {
        const isExpense = /cargo|pago|retiro|débito|debito/i.test(text);
        const isIncome = /abono|depósito|deposito|crédito|credito/i.test(text);
        if (isExpense || isIncome) {
            return {
                type: isExpense ? 'expense' : 'income',
                amount: generic, source: 'bcp',
                description: `BCP - ${cleanName(subject).slice(0, 60)}`,
                category: isExpense ? 'yellow' : 'otros',
                date: todayStr(date), gmailId, rawText: text.slice(0, 300)
            };
        }
    }

    return null;
}

// INTERBANK
function parseInterbank(ctx) {
    const { body, subject, date, gmailId } = ctx;
    const text = `${subject}\n${body}`;

    const charge = text.match(/(?:cargo|pago|compra)\s+(?:de\s+)?S\/\.?\s*([\d,]+\.?\d{0,2})\s+(?:en|a|para)\s+([^\n\r]+)/i);
    if (charge) {
        const amount = parseFloat(charge[1].replace(/,/g, ''));
        const merchant = cleanName(charge[2]).replace(/\..*/,'').trim();
        return {
            type: 'expense', amount, source: 'interbank',
            description: `Interbank - ${merchant}`,
            category: 'yellow',
            date: todayStr(date), gmailId, rawText: text.slice(0, 300)
        };
    }

    const credit = text.match(/(?:abono|depósito|deposito)\s+(?:de\s+)?S\/\.?\s*([\d,]+\.?\d{0,2})/i);
    if (credit) {
        const amount = parseFloat(credit[1].replace(/,/g, ''));
        return {
            type: 'income', amount, source: 'interbank',
            description: 'Abono Interbank',
            category: 'otros',
            date: todayStr(date), gmailId, rawText: text.slice(0, 300)
        };
    }

    return null;
}

// BBVA
function parseBBVA(ctx) {
    const { body, subject, date, gmailId } = ctx;
    const text = `${subject}\n${body}`;

    const charge = text.match(/(?:cargo|consumo|pago)\s+(?:de\s+)?S\/\.?\s*([\d,]+\.?\d{0,2})/i);
    if (charge) {
        const amount = parseFloat(charge[1].replace(/,/g, ''));
        const merchantMatch = text.match(/(?:en|establecimiento[:\s]+)\s*([A-ZÁÉÍÓÚ\w\s]{3,40})/i);
        const merchant = merchantMatch ? cleanName(merchantMatch[1]) : 'BBVA';
        return {
            type: 'expense', amount, source: 'bbva',
            description: `BBVA - ${merchant}`,
            category: 'yellow',
            date: todayStr(date), gmailId, rawText: text.slice(0, 300)
        };
    }

    const credit = text.match(/(?:abono|depósito|deposito|acredita)\s+(?:de\s+)?S\/\.?\s*([\d,]+\.?\d{0,2})/i);
    if (credit) {
        const amount = parseFloat(credit[1].replace(/,/g, ''));
        return {
            type: 'income', amount, source: 'bbva',
            description: 'Abono BBVA',
            category: 'otros',
            date: todayStr(date), gmailId, rawText: text.slice(0, 300)
        };
    }

    return null;
}

// SCOTIABANK
function parseScotiabank(ctx) {
    const { body, subject, date, gmailId } = ctx;
    const text = `${subject}\n${body}`;
    const amount = extractAmount(text);
    if (!amount) return null;

    const isExpense = /cargo|pago|débito|debito|consumo/i.test(text);
    const isIncome = /abono|depósito|deposito|crédito|credito/i.test(text);

    if (!isExpense && !isIncome) return null;

    return {
        type: isExpense ? 'expense' : 'income',
        amount, source: 'scotiabank',
        description: `Scotiabank - ${cleanName(subject).slice(0, 50)}`,
        category: isExpense ? 'yellow' : 'otros',
        date: todayStr(date), gmailId, rawText: text.slice(0, 300)
    };
}

// ─────────────────────────────────────────────
// ROUTER: elige el parser según el remitente
// ─────────────────────────────────────────────
const PARSER_MAP = [
    { pattern: /yape\.com\.pe/i,          fn: parseYape },
    { pattern: /plin\.pe/i,               fn: parsePlin },
    { pattern: /viabcp\.com/i,            fn: parseBCP },
    { pattern: /interbank\.com\.pe/i,     fn: parseInterbank },
    { pattern: /bbva\.pe|bbvacontinental/i, fn: parseBBVA },
    { pattern: /scotiabank\.com\.pe/i,    fn: parseScotiabank },
];

/**
 * Parsea un mensaje de Gmail y retorna una transacción normalizada o null.
 * @param {object} message   - Mensaje completo de Gmail API
 * @param {string} bodyText  - Cuerpo decodificado del email
 * @param {string} sender    - Dirección del remitente
 * @param {Date}   date      - Fecha del email
 * @param {string} subject   - Asunto del email
 * @returns {object|null}
 */
export function parseEmail({ message, bodyText, sender, date, subject }) {
    const entry = PARSER_MAP.find(p => p.pattern.test(sender));
    if (!entry) return null;

    try {
        return entry.fn({
            body: bodyText,
            subject,
            date,
            sender,
            gmailId: message.id,
        });
    } catch (e) {
        console.warn('[gmailParser] Error parseando email:', message.id, e);
        return null;
    }
}

/**
 * Clasifica el array de mensajes crudos de Gmail y retorna transacciones válidas.
 * @param {Array}  rawMessages  - Array de mensajes de Gmail API
 * @param {Function} decodeBody - Función para decodificar el body
 * @param {Function} getSender  - Función para obtener el remitente
 * @param {Function} getDate    - Función para obtener la fecha
 * @param {Function} getSubject - Función para obtener el asunto
 * @param {Set}    existingIds  - gmailIds ya importados (deduplicación)
 * @returns {Array} transacciones normalizadas
 */
export function parseAllEmails({ rawMessages, decodeBody, getSender, getDate, getSubject, existingIds = new Set() }) {
    const results = [];
    const seenIds = new Set(existingIds);

    for (const msg of rawMessages) {
        if (seenIds.has(msg.id)) continue; // ya importado

        const sender  = getSender(msg);
        const date    = getDate(msg);
        const subject = getSubject(msg);
        const bodyText = decodeBody(msg);

        const tx = parseEmail({ message: msg, bodyText, sender, date, subject });
        if (tx && tx.amount > 0 && tx.amount < 1_000_000) {
            seenIds.add(msg.id);
            results.push(tx);
        }
    }

    // Ordena por fecha descendente
    results.sort((a, b) => new Date(b.date) - new Date(a.date));
    return results;
}
