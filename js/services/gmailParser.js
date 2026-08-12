// js/services/gmailParser.js
// Parsers de emails de movimientos financieros peruanos
// Cubre: bancos tradicionales, cajas municipales, billeteras digitales y neobancos

// ─────────────────────────────────────────────
// HELPERS COMUNES
// ─────────────────────────────────────────────
function extractAmount(text) {
    const patterns = [
        /S\/\.?\s*([\d,]+\.?\d{0,2})/i,
        /(?<=\s|^|[:(])([\d,]+\.\d{2})(?=\s|$|[^\d])/,  // monto bare sin S/ si está aislado
        /PEN\s*([\d,]+\.?\d{0,2})/i,
        /soles?\s*([\d,]+\.?\d{0,2})/i,
        /(?:total|importe|monto|cargo|abono|consumo)\s*[:\n]?\s*S?\/?\.?\s*([\d,]+\.?\d{0,2})/i,
    ];
    for (const pat of patterns) {
        const m = text.match(pat);
        if (m) {
            const val = parseMoney(m[1]);
            if (!isNaN(val) && val > 0) return val;
        }
    }
    return null;
}

function parseMoney(raw) {
    let value = String(raw || '').replace(/[^\d.,]/g, '');
    if (!value) return null;

    // Acepta 1,250.50, 1.250,50 y 120,50 sin convertir miles en decimales.
    if (/^\d{1,3}(?:\.\d{3})+,\d{1,2}$/.test(value)) {
        value = value.replace(/\./g, '').replace(',', '.');
    } else if (/^\d{1,3}(?:,\d{3})+\.\d{1,2}$/.test(value)) {
        value = value.replace(/,/g, '');
    } else if (/^\d+,\d{1,2}$/.test(value) && !value.includes('.')) {
        value = value.replace(',', '.');
    } else {
        value = value.replace(/,/g, '');
    }

    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function extractLabeledAmount(text, labels) {
    const labelPattern = labels.join('|');
    const match = text.match(new RegExp(
        `(?:${labelPattern})\\s*[:\\n]?\\s*(?:S\\/\\.?|PEN|SOLES?)?\\s*([\\d.,]+)`,
        'i'
    ));
    return match ? parseMoney(match[1]) : null;
}

function extractField(text, labels) {
    const labelPattern = labels.join('|');
    const nextLine = text.match(new RegExp(`(?:${labelPattern})[ \\t]*(?::|\\r?\\n)[ \\t\\r\\n]*([^\\n\\r]+)`, 'i'));
    if (nextLine) return cleanName(nextLine[1]);
    const inline = text.match(new RegExp(`(?:${labelPattern})[ \\t]{2,}([^\\n\\r]+)`, 'i'));
    return inline ? cleanName(inline[1]) : '';
}

function displayName(raw) {
    const value = cleanName(raw).replace(/[_|]+/g, ' ').replace(/\s+/g, ' ');
    if (!value) return '';
    if (value === value.toUpperCase()) {
        return value.toLowerCase().replace(/(^|[\s-])\p{L}/gu, char => char.toUpperCase());
    }
    return value;
}

function cleanName(raw) {
    return (raw || '').replace(/\s+/g, ' ').trim().slice(0, 80);
}

function todayStr(date) {
    const d = date instanceof Date && !isNaN(date) ? date : new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function genericExpense(amount, label, source, date, gmailId, text) {
    return { type: 'expense', amount, source, description: label, category: 'yellow', date: todayStr(date), gmailId, rawText: text.slice(0, 300) };
}
function genericIncome(amount, label, source, date, gmailId, text) {
    return { type: 'income', amount, source, description: label, category: 'otros', date: todayStr(date), gmailId, rawText: text.slice(0, 300) };
}
function reviewTransaction(amount, label, source, date, gmailId, text, { currency = 'PEN', reason } = {}) {
    return {
        type: 'review', amount, source, description: label, currency, reviewOnly: true,
        reviewReason: reason, date: todayStr(date), gmailId, rawText: text.slice(0, 300),
    };
}

function detectTypeAndBuild(text, source, label, date, gmailId) {
    const amount = extractAmount(text);
    if (!amount) return null;
    const isExpense = /cargo|pago|compra|débito|debito|retiro|consumo|gasto|enviaste?|transferiste?/i.test(text);
    const isIncome  = /abono|depósito|deposito|crédito|credito|recibiste?|transferencia recibida|ingreso/i.test(text);
    if (!isExpense && !isIncome) return null;
    return isExpense
        ? genericExpense(amount, label, source, date, gmailId, text)
        : genericIncome(amount, label, source, date, gmailId, text);
}

function parseCustomEntity(entity, { body, subject, date, gmailId }) {
    const text = `${subject}\n${body}`;
    const amount = extractAmount(text);
    if (!amount) return null;

    const source = `custom-${String(entity.id || entity.sender).replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;
    const label = cleanName(entity.name || entity.sender || 'Entidad manual');
    const kind = entity.defaultType || 'auto';
    let transaction;

    if (kind === 'income') transaction = genericIncome(amount, label, source, date, gmailId, text);
    else if (kind === 'expense') transaction = genericExpense(amount, label, source, date, gmailId, text);
    else transaction = detectTypeAndBuild(text, source, label, date, gmailId);

    if (!transaction) return null;
    if (transaction.type === 'expense') transaction.category = entity.defaultCategory || 'yellow';
    transaction.sourceLabel = label;
    return transaction;
}

// ─────────────────────────────────────────────
// YAPE
// ─────────────────────────────────────────────
function parseYape({ body, subject, date, gmailId }) {
    const text = `${subject}\n${body}`;

    // Recibiste S/X de Nombre
    const received = text.match(/recibiste?\s+S\/\.?\s*([\d,]+\.?\d{0,2})\s+de\s+([^\n\r.]+)/i);
    if (received) return genericIncome(parseFloat(received[1].replace(/,/g, '')), `Yape de ${cleanName(received[2])}`, 'yape', date, gmailId, text);

    // Enviaste/transferiste S/X a Nombre
    const sent = text.match(/(?:enviaste?|transferiste?)\s+S\/\.?\s*([\d,]+\.?\d{0,2})\s+a\s+([^\n\r.]+)/i);
    if (sent) return genericExpense(parseFloat(sent[1].replace(/,/g, '')), `Yape a ${cleanName(sent[2])}`, 'yape', date, gmailId, text);

    // Pagaste en X
    const payment = text.match(/pagaste?\s+S\/\.?\s*([\d,]+\.?\d{0,2})\s+(?:en|a)\s+([^\n\r.]+)/i);
    if (payment) return genericExpense(parseFloat(payment[1].replace(/,/g, '')), `Yape - ${cleanName(payment[2])}`, 'yape', date, gmailId, text);

    // Formatos "yapeo exitoso" / "yapeo a traves de" / "se realizó un yapeo"
    const isYapeo = /(?:acabas de )?yapear(?:\s+exitosamente)?|monto de yapeo|se\s+realiz[oó]\s+un\s+yapeo|yapeo\s+de\s+S/i.test(text);
    if (isYapeo) {
        const amount = extractAmount(text);
        const recipient = text.match(/(?:nombre del beneficiario|beneficiario|destinatario)\s*[:\n]\s*([^\n\r]+)/i);
        if (amount) return genericExpense(amount, `Yape a ${cleanName(recipient?.[1] || 'contacto')}`, 'yape', date, gmailId, text);
    }

    const amount = extractAmount(text);
    if (amount) return detectTypeAndBuild(text, 'yape', `Yape - ${cleanName(subject).slice(0, 50)}`, date, gmailId);
    return null;
}

// ─────────────────────────────────────────────
// PLIN
// ─────────────────────────────────────────────
function parsePlin({ body, subject, date, gmailId }) {
    const text = `${subject}\n${body}`;

    const received = text.match(/recibiste?\s+S\/\.?\s*([\d,]+\.?\d{0,2})\s+de\s+([^\n\r.]+)/i);
    if (received) return genericIncome(parseFloat(received[1].replace(/,/g, '')), `Plin de ${cleanName(received[2])}`, 'plin', date, gmailId, text);

    // Enviaste/transferiste/pago Plin a X
    const sent = text.match(/(?:env(?:iaste?|[ií]o\s+(?:de|plin))|transferiste?|pago\s+exitoso)\s+(?:S\/\.?\s*([\d,]+\.?\d{0,2})\s+a\s+)?(?:de\s+)?([^\n\r.]+)/i);
    const amountSent = extractLabeledAmount(text, ['monto\s+y\s+moneda', 'monto\s+enviado', 'monto', 'importe']) || extractAmount(text);
    if (amountSent && /enviaste?|env[ií]o|transferiste?|pago\s+(?:exitoso|realizado)|plin\s+enviado/i.test(text)) {
        const recipient = extractField(text, ['destinatario', 'beneficiario', 'titular\s+de\s+la\s+cuenta\s+destino', 'nombre']);
        return genericExpense(amountSent, `Plin a ${cleanName(recipient || sent?.[2] || 'contacto')}`, 'plin', date, gmailId, text);
    }

    return detectTypeAndBuild(text, 'plin', `Plin - ${cleanName(subject).slice(0, 50)}`, date, gmailId);
}

// ─────────────────────────────────────────────
// BCP
// ─────────────────────────────────────────────
function parseBCP({ body, subject, date, gmailId }) {
    const text = `${subject}\n${body}`;
    const cardConsumption = /(?:total\s+del\s+consumo|consumo\s+tarjeta\s+de\s+d[eé]bito)/i.test(text);
    if (cardConsumption) {
        const amount = extractLabeledAmount(text, ['total\\s+del\\s+consumo', 'monto', 'importe']) || extractAmount(text);
        const merchant = extractField(text, ['empresa', 'establecimiento', 'comercio']);
        if (amount) {
            const merchantLabel = merchant
                ? displayName(merchant).replace(/^plin[-\s]*/i, 'Plin · ')
                : 'Consumo con tarjeta';
            return genericExpense(amount, `BCP · ${merchantLabel}`, 'bcp', date, gmailId, text);
        }
    }
    const charge = text.match(/(?:cargo|pago|compra)\s+(?:de\s+)?S\/\.?\s*([\d,]+\.?\d{0,2})\s+(?:en|a)\s+([^\n\r]+)/i);
    if (charge) return genericExpense(parseMoney(charge[1]), `BCP - ${cleanName(charge[2]).split('.')[0]}`, 'bcp', date, gmailId, text);
    const credit = text.match(/(?:abono|depósito|deposito)\s+(?:de\s+)?S\/\.?\s*([\d,]+\.?\d{0,2})/i);
    if (credit) return genericIncome(parseMoney(credit[1]), `BCP - Abono`, 'bcp', date, gmailId, text);
    return detectTypeAndBuild(text, 'bcp', `BCP - ${cleanName(subject).slice(0, 50)}`, date, gmailId);
}

// ─────────────────────────────────────────────
// INTERBANK
// ─────────────────────────────────────────────
function parseInterbank({ body, subject, date, gmailId }) {
    const text = `${subject}\n${body}`;
    const merchant = extractField(text, ['empresa', 'comercio', 'establecimiento']);
    const plinReceipt = /constancia\s+de\s+pago\s+plin|\bpago\s+plin\b/i.test(text);
    if (plinReceipt) {
        const amount = extractLabeledAmount(text, ['monto\s+y\s+moneda', 'moneda\s+y\s+monto', 'importe', 'monto']) || extractAmount(text);
        const recipient = extractField(text, ['destinatario', 'beneficiario', 'titular\s+de\s+la\s+cuenta\s+destino']);
        const destination = extractField(text, ['destino']);
        if (amount) {
            const name = displayName(recipient || destination || 'contacto');
            const tx = genericExpense(amount, `Plin a ${name}`, 'plin', date, gmailId, text);
            tx.sourceLabel = 'Plin · Interbank';
            return tx;
        }
    }
    const servicePayment = /(?:constancia\s+de\s+pago|pago\s+de\s+servicio|postpago|postbitel)/i.test(text);
    if (servicePayment) {
        const amount = extractLabeledAmount(text, ['moneda\s+y\s+monto', 'monto\s+y\s+moneda', 'importe', 'monto']) || extractAmount(text);
        if (amount) {
            const isBitel = /bitel|postbitel/i.test(`${merchant}\n${text}`);
            const label = isBitel
                ? 'Bitel · línea postpago'
                : `Interbank · ${displayName(merchant || 'Pago de servicio')}`;
            return genericExpense(amount, label, 'interbank', date, gmailId, text);
        }
    }
    const charge = text.match(/(?:cargo|pago|compra)\s+(?:de\s+)?S\/\.?\s*([\d,]+\.?\d{0,2})\s+(?:en|a)\s+([^\n\r]+)/i);
    if (charge) return genericExpense(parseMoney(charge[1]), `Interbank - ${cleanName(charge[2]).split('.')[0]}`, 'interbank', date, gmailId, text);
    const credit = text.match(/(?:abono|depósito|deposito)\s+(?:de\s+)?S\/\.?\s*([\d,]+\.?\d{0,2})/i);
    if (credit) return genericIncome(parseMoney(credit[1]), `Interbank - Abono`, 'interbank', date, gmailId, text);
    return detectTypeAndBuild(text, 'interbank', `Interbank - ${cleanName(subject).slice(0, 50)}`, date, gmailId);
}

// ─────────────────────────────────────────────
// BBVA
// ─────────────────────────────────────────────
function parseBBVA({ body, subject, date, gmailId }) {
    const text = `${subject}\n${body}`;

    // Cargo / consumo — extraer monto con label primero, más preciso
    const chargeAmt = extractLabeledAmount(text, ['monto\\s+(?:del\\s+)?(?:consumo|cargo|pago)', 'importe', 'monto', 'cargo', 'consumo']) || null;
    if (chargeAmt && /cargo|consumo|pago|compra/i.test(text)) {
        const merchantMatch = text.match(/(?:en\s+el\s+establecimiento|establecimiento|comercio|tienda)\s*[:\s]+([A-ZÁÉÍÓÚ\w][A-ZÁÉÍÓÚ\w\s&.-]{2,40})/i);
        const merchant = merchantMatch ? cleanName(merchantMatch[1]).trim() : '';
        const isGeneric = !merchant || /l[ií]nea|p[aá]gina|web|internet|banca|canal|online/i.test(merchant);
        const label = isGeneric ? 'BBVA - Consumo' : `BBVA - ${displayName(merchant)}`;
        return genericExpense(chargeAmt, label, 'bbva', date, gmailId, text);
    }

    const chargeSimple = text.match(/(?:cargo|consumo|pago)\s+(?:de\s+)?S\/\.?\s*([\d,]+\.?\d{0,2})/i);
    if (chargeSimple) {
        return genericExpense(parseFloat(chargeSimple[1].replace(/,/g, '')), 'BBVA - Consumo', 'bbva', date, gmailId, text);
    }

    const credit = text.match(/(?:abono|dep[oó]sito|deposito|acredita|recibiste?)\s+(?:de\s+)?S\/\.?\s*([\d,]+\.?\d{0,2})/i);
    if (credit) return genericIncome(parseFloat(credit[1].replace(/,/g, '')), 'BBVA - Abono', 'bbva', date, gmailId, text);

    return detectTypeAndBuild(text, 'bbva', `BBVA - ${cleanName(subject).slice(0, 50)}`, date, gmailId);
}


// ─────────────────────────────────────────────
// SCOTIABANK
// ─────────────────────────────────────────────
function parseScotiabank({ body, subject, date, gmailId }) {
    const text = `${subject}\n${body}`;
    const amount = extractLabeledAmount(text, ['monto', 'importe', 'total', 'cargo', 'consumo', 'abono']) || extractAmount(text);
    if (!amount) return detectTypeAndBuild(text, 'scotiabank', `Scotiabank - ${cleanName(subject).slice(0, 50)}`, date, gmailId);
    const isCharge = /cargo|pago|compra|consumo|d[eé]bito|retiro/i.test(text);
    const isCredit = /abono|dep[oó]sito|cr[eé]dito|acredita/i.test(text);
    const merchant = extractField(text, ['establecimiento', 'comercio', 'empresa']);
    if (isCharge) return genericExpense(amount, `Scotiabank - ${displayName(merchant || 'Consumo')}`, 'scotiabank', date, gmailId, text);
    if (isCredit) return genericIncome(amount, 'Scotiabank - Abono', 'scotiabank', date, gmailId, text);
    return detectTypeAndBuild(text, 'scotiabank', `Scotiabank - ${cleanName(subject).slice(0, 50)}`, date, gmailId);
}

// ─────────────────────────────────────────────
// BANBIF
// ─────────────────────────────────────────────
function parseBanBif({ body, subject, date, gmailId }) {
    const text = `${subject}\n${body}`;
    return detectTypeAndBuild(text, 'banbif', `BanBif - ${cleanName(subject).slice(0, 50)}`, date, gmailId);
}

// ─────────────────────────────────────────────
// BANCO PICHINCHA
// ─────────────────────────────────────────────
function parsePichincha({ body, subject, date, gmailId }) {
    const text = `${subject}\n${body}`;
    return detectTypeAndBuild(text, 'pichincha', `Pichincha - ${cleanName(subject).slice(0, 50)}`, date, gmailId);
}

// ─────────────────────────────────────────────
// BANCO DE LA NACIÓN
// ─────────────────────────────────────────────
function parseNacion({ body, subject, date, gmailId }) {
    const text = `${subject}\n${body}`;
    const amount = extractLabeledAmount(text, ['importe(?:\\s+transferido)?', 'monto(?:\\s+y\\s+moneda)?', 'total']) || extractAmount(text);
    if (!amount) return null;

    if (/transferencia\s+a\s+contacto|transferencia\s+enviada|env[i.]o\s+de\s+dinero/i.test(text)) {
        const recipient = text.match(/nombre\s+del\s+beneficiario[\s:]*([^\n\r]+)/i)?.[1];
        const destination = text.match(/banco\s+destino[\s:]*([^\n\r]+)/i)?.[1] || '';
        const person = displayName(recipient || destination || 'contacto');
        const via = /yape|plin/i.test(destination) ? ` · ${displayName(destination)}` : '';
        return genericExpense(amount, `Banco de la Nación · Transferencia a ${person}${via}`, 'nacion', date, gmailId, text);
    }

    const operation = extractField(text, ['tipo\\s+de\\s+operaci.n']);
    const channel = extractField(text, ['canal\\s+de\\s+atenci.n']);
    const recipient = extractField(text, ['nombre\\s+del\\s+beneficiario', 'beneficiario', 'destinatario']);
    const destination = extractField(text, ['banco\\s+destino', 'destino']);
    const operationText = `${operation}\n${channel}\n${subject}`;

    if (/retiro|cajero\\s+autom[aá]tico|atm/i.test(operationText)) {
        return genericExpense(amount, 'Banco de la Nación · Retiro de cajero', 'nacion', date, gmailId, text);
    }
    if (/transferencia\\s+a\\s+contacto|transferencia\\s+enviada|env[ií]o\\s+de\\s+dinero/i.test(operationText)) {
        const person = displayName(recipient || destination || 'contacto');
        const via = /yape|plin/i.test(destination) ? ` · ${displayName(destination)}` : '';
        return genericExpense(amount, `Banco de la Nación · Transferencia a ${person}${via}`, 'nacion', date, gmailId, text);
    }
    if (/abono|dep[oó]sito|transferencia\\s+recibida|pago\\s+recibido/i.test(operationText)) {
        return genericIncome(amount, 'Banco de la Nación · Abono recibido', 'nacion', date, gmailId, text);
    }
    return detectTypeAndBuild(text, 'nacion', 'Banco de la Nación · Operación', date, gmailId)
        || genericExpense(amount, 'Banco de la Nación · Operación', 'nacion', date, gmailId, text);
}

function parseBinance({ body, subject, date, gmailId }) {
    const text = `${subject}\n${body}`;
    const amount = extractLabeledAmount(text, ['cantidad', 'monto']) || null;
    const currencyMatch = text.match(/(?:cantidad|monto)\s*[:\n]\s*[\d.,]+\s*([A-Z]{2,8})/i);
    const currency = currencyMatch?.[1]?.toUpperCase() || 'USDT';
    if (!amount) return null;
    return reviewTransaction(
        amount,
        `Binance Pay · ${currency}`,
        'binance',
        date,
        gmailId,
        text,
        { currency, reason: 'Konteo trabaja en soles: revisa esta operación en otra moneda antes de registrarla.' }
    );
}

function parsePagoEfectivo({ body, subject, date, gmailId }) {
    const text = `${subject}\n${body}`;
    const pending = /orden\s+pendiente|paga\s+antes|pendiente\s+de\s+pago/i.test(text);
    if (!pending) return detectTypeAndBuild(text, 'pagoefectivo', 'PagoEfectivo · Pago confirmado', date, gmailId);
    const amount = extractLabeledAmount(text, ['monto\s+a\s+pagar', 'importe', 'monto']) || extractAmount(text);
    if (!amount) return null;
    return reviewTransaction(
        amount,
        'PagoEfectivo · Orden pendiente',
        'pagoefectivo',
        date,
        gmailId,
        text,
        { reason: 'Es una orden pendiente; se importará solo cuando exista una confirmación de pago.' }
    );
}

// ─────────────────────────────────────────────
// BANCO FALABELLA
// ─────────────────────────────────────────────
function parseFalabella({ body, subject, date, gmailId }) {
    const text = `${subject}\n${body}`;
    const charge = text.match(/(?:cargo|consumo|compra)\s+(?:de\s+)?S\/\.?\s*([\d,]+\.?\d{0,2})/i);
    if (charge) return genericExpense(parseFloat(charge[1].replace(/,/g, '')), `Falabella - ${cleanName(subject).slice(0, 40)}`, 'falabella', date, gmailId, text);
    return detectTypeAndBuild(text, 'falabella', `Falabella - ${cleanName(subject).slice(0, 50)}`, date, gmailId);
}

// ─────────────────────────────────────────────
// BANCO RIPLEY
// ─────────────────────────────────────────────
function parseRipley({ body, subject, date, gmailId }) {
    const text = `${subject}\n${body}`;
    return detectTypeAndBuild(text, 'ripley', `Ripley - ${cleanName(subject).slice(0, 50)}`, date, gmailId);
}

// ─────────────────────────────────────────────
// FINANCIERA OH!
// ─────────────────────────────────────────────
function parseOh({ body, subject, date, gmailId }) {
    const text = `${subject}\n${body}`;
    return detectTypeAndBuild(text, 'oh', `Oh! - ${cleanName(subject).slice(0, 50)}`, date, gmailId);
}

// ─────────────────────────────────────────────
// CAJAS MUNICIPALES (patrón genérico)
// ─────────────────────────────────────────────
function makeCajasParser(source, label) {
    return function ({ body, subject, date, gmailId }) {
        const text = `${subject}\n${body}`;
        return detectTypeAndBuild(text, source, `${label} - ${cleanName(subject).slice(0, 50)}`, date, gmailId);
    };
}

// ─────────────────────────────────────────────
// IZIPAY YA (ex-Tunki, Interbank)
// ─────────────────────────────────────────────
function parseIzipay({ body, subject, date, gmailId }) {
    const text = `${subject}\n${body}`;
    const received = text.match(/recibiste?\s+S\/\.?\s*([\d,]+\.?\d{0,2})\s+de\s+([^\n\r.]+)/i);
    if (received) return genericIncome(parseFloat(received[1].replace(/,/g, '')), `IzipayYA de ${cleanName(received[2])}`, 'izipay', date, gmailId, text);
    return detectTypeAndBuild(text, 'izipay', `IzipayYA - ${cleanName(subject).slice(0, 50)}`, date, gmailId);
}

// ─────────────────────────────────────────────
// BIM (Banco de la Nación)
// ─────────────────────────────────────────────
function parseBim({ body, subject, date, gmailId }) {
    const text = `${subject}\n${body}`;
    return detectTypeAndBuild(text, 'bim', `Bim - ${cleanName(subject).slice(0, 50)}`, date, gmailId);
}

// ─────────────────────────────────────────────
// NU (Nubank)
// ─────────────────────────────────────────────
function parseNu({ body, subject, date, gmailId }) {
    const text = `${subject}\n${body}`;
    const charge = text.match(/(?:compra|transacción|cargo)\s+(?:de\s+)?S\/\.?\s*([\d,]+\.?\d{0,2})/i);
    if (charge) return genericExpense(parseFloat(charge[1].replace(/,/g, '')), `Nu - ${cleanName(subject).slice(0, 50)}`, 'nu', date, gmailId, text);
    return detectTypeAndBuild(text, 'nu', `Nu - ${cleanName(subject).slice(0, 50)}`, date, gmailId);
}

// ─────────────────────────────────────────────
// MERCADO PAGO
// ─────────────────────────────────────────────
function parseMercadoPago({ body, subject, date, gmailId }) {
    const text = `${subject}\n${body}`;
    const received = text.match(/recibiste?\s+(?:un pago de\s+)?S\/\.?\s*([\d,]+\.?\d{0,2})\s+de\s+([^\n\r.]+)/i);
    if (received) return genericIncome(parseFloat(received[1].replace(/,/g, '')), `MercadoPago de ${cleanName(received[2])}`, 'mercadopago', date, gmailId, text);
    const sent = text.match(/pagaste?\s+S\/\.?\s*([\d,]+\.?\d{0,2})\s+(?:en|a)\s+([^\n\r.]+)/i);
    if (sent) return genericExpense(parseFloat(sent[1].replace(/,/g, '')), `MercadoPago - ${cleanName(sent[2])}`, 'mercadopago', date, gmailId, text);
    return detectTypeAndBuild(text, 'mercadopago', `MercadoPago - ${cleanName(subject).slice(0, 50)}`, date, gmailId);
}

// ─────────────────────────────────────────────
// WISE
// ─────────────────────────────────────────────
function parseWise({ body, subject, date, gmailId }) {
    const text = `${subject}\n${body}`;
    const transfer = text.match(/(?:sent|transferred|received)\s+(?:PEN|S\/\.?)\s*([\d,]+\.?\d{0,2})/i);
    if (transfer) {
        const amount = parseFloat(transfer[1].replace(/,/g, ''));
        const isOut = /sent|transferred/i.test(transfer[0]);
        return isOut
            ? genericExpense(amount, `Wise - ${cleanName(subject).slice(0, 50)}`, 'wise', date, gmailId, text)
            : genericIncome(amount, `Wise - Recibido`, 'wise', date, gmailId, text);
    }
    return detectTypeAndBuild(text, 'wise', `Wise - ${cleanName(subject).slice(0, 50)}`, date, gmailId);
}

// ─────────────────────────────────────────────
// PAYONEER
// ─────────────────────────────────────────────
function parsePayoneer({ body, subject, date, gmailId }) {
    const text = `${subject}\n${body}`;
    const received = text.match(/(?:received|recibiste?)\s+(?:\$|USD|PEN|S\/\.?)\s*([\d,]+\.?\d{0,2})/i);
    if (received) return genericIncome(parseFloat(received[1].replace(/,/g, '')), `Payoneer - ${cleanName(subject).slice(0, 50)}`, 'payoneer', date, gmailId, text);
    return detectTypeAndBuild(text, 'payoneer', `Payoneer - ${cleanName(subject).slice(0, 50)}`, date, gmailId);
}

// ─────────────────────────────────────────────
// LIGO (BCP Neobanco)
// ─────────────────────────────────────────────
function parseLigo({ body, subject, date, gmailId }) {
    const text = `${subject}\n${body}`;
    return detectTypeAndBuild(text, 'ligo', `Ligo - ${cleanName(subject).slice(0, 50)}`, date, gmailId);
}

// ─────────────────────────────────────────────
// MÁXIMO
// ─────────────────────────────────────────────
function parseMaximo({ body, subject, date, gmailId }) {
    const text = `${subject}\n${body}`;
    return detectTypeAndBuild(text, 'maximo', `Máximo - ${cleanName(subject).slice(0, 50)}`, date, gmailId);
}

// ─────────────────────────────────────────────
// MIBANCO
// ─────────────────────────────────────────────
function parseMiBanco({ body, subject, date, gmailId }) {
    const text = `${subject}\n${body}`;
    const amount = extractLabeledAmount(text, ['monto\s+(?:enviado|operaci.n|y\s+moneda)?', 'importe', 'total']) || extractAmount(text);
    if (!amount) return null;

    const recipient = text.match(/(?:titular\s+de\s+la\s+cuenta\s+destino|destinatario|beneficiario)\s*[:\n]\s*([^\n\r]+)/i);
    const recipientName = cleanName(recipient?.[1] || 'Transferencia');

    if (/transferencia.*exitosa|enviar\s+a\s+contacto|monto\s+enviado|pago.*realizado|operaci.n\s+exitosa/i.test(text)) {
        return genericExpense(amount, `MiBanco - ${recipientName}`, 'mibanco', date, gmailId, text);
    }
    if (/abono|dep[oó]sito|monto\s+recibido|recibiste|ingreso/i.test(text)) {
        return genericIncome(amount, 'MiBanco - Abono', 'mibanco', date, gmailId, text);
    }
    return detectTypeAndBuild(text, 'mibanco', `MiBanco - ${cleanName(subject).slice(0, 50)}`, date, gmailId);
}

// ─────────────────────────────────────────────
// SIP / ÁGORA
// ─────────────────────────────────────────────
function parseSip({ body, subject, date, gmailId }) {
    const text = `${subject}\n${body}`;
    const amountMatch = text.match(/(?:monto|importe|total)\s*[:\n]?\s*S\/\.?\s*([\d.,]+)/i);
    const amount = amountMatch ? parseMoney(amountMatch[1]) : extractAmount(text);
    if (!amount) return null;

    const operation = cleanName(text.match(/operaci.n\s+realizada\s*[:\n]\s*([^\n\r]+)/i)?.[1] || subject);
    const merchant = cleanName(text.match(/(?:empresa|comercio|establecimiento)\s*[:\n]\s*([^\n\r]+)/i)?.[1] || 'Comercio');
    if (/pago|compra|env[ií]o|transferencia|retiro/i.test(`${operation}\n${subject}`)) {
        return genericExpense(amount, `SIP · ${displayName(merchant)}`, 'sip', date, gmailId, text);
    }
    if (/abono|recibido|ingreso/i.test(operation)) {
        return genericIncome(amount, `SIP - ${operation}`, 'sip', date, gmailId, text);
    }
    return null;
}

// ─────────────────────────────────────────────
// ROUTER — mapea remitente → parser
// ─────────────────────────────────────────────
const PARSER_MAP = [
    // Billeteras principales
    { pattern: /yape(?:\.com)?\.pe/i,            fn: parseYape },
    { pattern: /plin\.pe/i,                     fn: parsePlin },
    { pattern: /izipay|tunki/i,                 fn: parseIzipay },
    { pattern: /bim\.com\.pe|banco.*nacion.*bim/i, fn: parseBim },
    { pattern: /mercadopago|mercadolibre/i,      fn: parseMercadoPago },
    { pattern: /wise\.com/i,                    fn: parseWise },
    { pattern: /payoneer/i,                     fn: parsePayoneer },
    { pattern: /directmail\.binance\.com|binance\.com/i, fn: parseBinance },
    { pattern: /pagoefectivo\.pe/i,             fn: parsePagoEfectivo },

    // Bancos tradicionales
    { pattern: /viabcp\.com|bcp\.com\.pe/i,     fn: parseBCP },
    { pattern: /interbank\.com\.pe|ibk@/i,      fn: parseInterbank },
    { pattern: /bbva\.pe|bbvacontinental/i,     fn: parseBBVA },
    { pattern: /scotiabank\.com\.pe/i,          fn: parseScotiabank },
    { pattern: /banbif\.com\.pe/i,              fn: parseBanBif },
    { pattern: /pichincha\.com\.pe/i,           fn: parsePichincha },
    { pattern: /bn\.com\.pe|bancodelanacion/i,  fn: parseNacion },
    { pattern: /falabella\.com\.pe|bancofalabella/i, fn: parseFalabella },
    { pattern: /ripley\.com\.pe|bancoripley/i,  fn: parseRipley },
    { pattern: /financieraoh|oh\.com\.pe/i,     fn: parseOh },

    // Neobancos
    { pattern: /nu\.com\.pe|nubank/i,           fn: parseNu },
    { pattern: /ligo\.pe/i,                     fn: parseLigo },
    { pattern: /maximo\.pe|maximoapp/i,         fn: parseMaximo },
    { pattern: /b89\.pe/i,                      fn: makeCajasParser('b89', 'B89') },
    { pattern: /kambista/i,                     fn: makeCajasParser('kambista', 'Kambista') },
    { pattern: /ual[aá]\.com|tyba/i,            fn: makeCajasParser('uala', 'Ualá') },

    // Cajas municipales y rurales
    { pattern: /cajaarequipa/i,                 fn: makeCajasParser('caja-arequipa', 'Caja Arequipa') },
    { pattern: /cajahuancayo/i,                 fn: makeCajasParser('caja-huancayo', 'Caja Huancayo') },
    { pattern: /cajapiura/i,                    fn: makeCajasParser('caja-piura', 'Caja Piura') },
    { pattern: /cajacusco/i,                    fn: makeCajasParser('caja-cusco', 'Caja Cusco') },
    { pattern: /cajatrujillo/i,                 fn: makeCajasParser('caja-trujillo', 'Caja Trujillo') },
    { pattern: /cajasullana/i,                  fn: makeCajasParser('caja-sullana', 'Caja Sullana') },
    { pattern: /cajatacna/i,                    fn: makeCajasParser('caja-tacna', 'Caja Tacna') },
    { pattern: /cajamaynas/i,                   fn: makeCajasParser('caja-maynas', 'Caja Maynas') },
    { pattern: /cmac|crac|caja.*municipal|caja.*rural/i, fn: makeCajasParser('caja', 'Caja Municipal') },

    // Mibanco
    { pattern: /mibanco\.com\.pe/i,             fn: parseMiBanco },
    { pattern: /operaciones\.agora\.pe/i,        fn: parseSip },
];

// ─────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────
export function parseEmail({ message, bodyText, sender, date, subject, customEntities = [] }) {
    const customEntity = customEntities.find(entity => (
        entity?.active !== false &&
        String(entity.sender || '').trim() &&
        sender.includes(String(entity.sender).trim().toLowerCase())
    ));
    if (customEntity) {
        try {
            return parseCustomEntity(customEntity, { body: bodyText, subject, date, gmailId: message.id });
        } catch (e) {
            console.warn('[gmailParser] Error en entidad manual:', message.id, e);
            return null;
        }
    }
    const entry = PARSER_MAP.find(p => p.pattern.test(sender));
    if (!entry) return null;
    try {
        return entry.fn({ body: bodyText, subject, date, sender, gmailId: message.id });
    } catch (e) {
        console.warn('[gmailParser] Error:', message.id, e);
        return null;
    }
}

export function parseAllEmails({ rawMessages, decodeBody, getSender, getDate, getSubject, existingIds = new Set(), existingTxKeys = new Set(), customEntities = [] }) {
    const results  = [];
    const seenIds  = new Set(existingIds);

    for (const msg of rawMessages) {
        if (seenIds.has(msg.id)) continue;
        const sender   = getSender(msg);
        const date     = getDate(msg);
        const subject  = getSubject(msg);
        const bodyText = decodeBody(msg);
        const tx = parseEmail({ message: msg, bodyText, sender, date, subject, customEntities });
        if (tx && tx.amount > 0 && tx.amount < 1_000_000) {
            // Omitir si la transacción ya está registrada en Firestore por fecha, tipo y monto
            const key = `${tx.type}|${tx.date}|${Number(tx.amount).toFixed(2)}`;
            if (existingTxKeys.has(key)) {
                console.info('[gmailParser] Omitiendo transacción ya existente en Firestore:', key);
                seenIds.add(msg.id);
                continue;
            }
            seenIds.add(msg.id);
            results.push(tx);
        }
    }

    // Deduplicar notificaciones redundantes del mismo movimiento físico
    // Ejemplo: cargo de Interbank + comprobante de Plin/Yape del mismo monto
    const CROSS_PAIRS = [
        // billetera → banco emisor (prefer billetera = tiene nombre del destinatario)
        ['plin',        'interbank'],
        ['plin',        'bcp'],
        ['plin',        'bbva'],
        ['plin',        'scotiabank'],
        ['yape',        'bcp'],
        ['yape',        'interbank'],
        ['yape',        'bbva'],
        ['yape',        'mibanco'],
        ['yape',        'nacion'],
        ['yape',        'scotiabank'],
        ['mercadopago', 'bcp'],
        ['izipay',      'interbank'],
    ];
    const isCrossDuplicate = (s1, s2) => CROSS_PAIRS.some(([w, b]) => (s1 === w && s2 === b) || (s1 === b && s2 === w));

    const deduplicated = [];
    for (const tx of results) {
        const isDuplicate = deduplicated.find(existing => {
            if (existing.date !== tx.date) return false;
            if (Math.abs(existing.amount - tx.amount) > 0.01) return false;  // tolerancia de 1 centavo
            if (existing.type !== tx.type) return false;
            return existing.source === tx.source || isCrossDuplicate(existing.source, tx.source);
        });

        if (isDuplicate) {
            // Preferir el recibo con nombre específico (ej. 'Plin a X' o 'Yape a Y') sobre la notificación genérica del banco
            const wallets = ['plin', 'yape', 'mercadopago', 'izipay'];
            const txIsWallet = wallets.includes(tx.source);
            const existingIsBank = !wallets.includes(isDuplicate.source);
            if (txIsWallet && existingIsBank) {
                isDuplicate.description = tx.description;
                isDuplicate.source = tx.source;
                if (tx.sourceLabel) isDuplicate.sourceLabel = tx.sourceLabel;
            }
        } else {
            deduplicated.push(tx);
        }
    }

    deduplicated.sort((a, b) => new Date(b.date) - new Date(a.date));
    return deduplicated;
}
