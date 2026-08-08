// js/services/gmailParser.js
// Parsers de emails de movimientos financieros peruanos
// Cubre: bancos tradicionales, cajas municipales, billeteras digitales y neobancos

// ─────────────────────────────────────────────
// HELPERS COMUNES
// ─────────────────────────────────────────────
function extractAmount(text) {
    const patterns = [
        /S\/\.?\s*([\d,]+\.?\d{0,2})/i,
        /PEN\s*([\d,]+\.?\d{0,2})/i,
        /soles?\s*([\d,]+\.?\d{0,2})/i,
    ];
    for (const pat of patterns) {
        const m = text.match(pat);
        if (m) {
            const val = parseFloat(m[1].replace(/,/g, ''));
            if (!isNaN(val) && val > 0) return val;
        }
    }
    return null;
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

// ─────────────────────────────────────────────
// YAPE
// ─────────────────────────────────────────────
function parseYape({ body, subject, date, gmailId }) {
    const text = `${subject}\n${body}`;
    const received = text.match(/recibiste?\s+S\/\.?\s*([\d,]+\.?\d{0,2})\s+de\s+([^\n\r.]+)/i);
    if (received) return genericIncome(parseFloat(received[1].replace(/,/g, '')), `Yape de ${cleanName(received[2])}`, 'yape', date, gmailId, text);
    const sent = text.match(/(?:enviaste?|transferiste?)\s+S\/\.?\s*([\d,]+\.?\d{0,2})\s+a\s+([^\n\r.]+)/i);
    if (sent) return genericExpense(parseFloat(sent[1].replace(/,/g, '')), `Yape a ${cleanName(sent[2])}`, 'yape', date, gmailId, text);
    const payment = text.match(/pagaste?\s+S\/\.?\s*([\d,]+\.?\d{0,2})\s+(?:en|a)\s+([^\n\r.]+)/i);
    if (payment) return genericExpense(parseFloat(payment[1].replace(/,/g, '')), `Yape - ${cleanName(payment[2])}`, 'yape', date, gmailId, text);
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
    const sent = text.match(/env(?:iaste?|ío de)\s+S\/\.?\s*([\d,]+\.?\d{0,2})\s+a\s+([^\n\r.]+)/i);
    if (sent) return genericExpense(parseFloat(sent[1].replace(/,/g, '')), `Plin a ${cleanName(sent[2])}`, 'plin', date, gmailId, text);
    return detectTypeAndBuild(text, 'plin', `Plin - ${cleanName(subject).slice(0, 50)}`, date, gmailId);
}

// ─────────────────────────────────────────────
// BCP
// ─────────────────────────────────────────────
function parseBCP({ body, subject, date, gmailId }) {
    const text = `${subject}\n${body}`;
    const charge = text.match(/(?:cargo|pago|compra)\s+(?:de\s+)?S\/\.?\s*([\d,]+\.?\d{0,2})\s+(?:en|a)\s+([^\n\r]+)/i);
    if (charge) return genericExpense(parseFloat(charge[1].replace(/,/g, '')), `BCP - ${cleanName(charge[2]).split('.')[0]}`, 'bcp', date, gmailId, text);
    const credit = text.match(/(?:abono|depósito|deposito)\s+(?:de\s+)?S\/\.?\s*([\d,]+\.?\d{0,2})/i);
    if (credit) return genericIncome(parseFloat(credit[1].replace(/,/g, '')), `BCP - Abono`, 'bcp', date, gmailId, text);
    return detectTypeAndBuild(text, 'bcp', `BCP - ${cleanName(subject).slice(0, 50)}`, date, gmailId);
}

// ─────────────────────────────────────────────
// INTERBANK
// ─────────────────────────────────────────────
function parseInterbank({ body, subject, date, gmailId }) {
    const text = `${subject}\n${body}`;
    const charge = text.match(/(?:cargo|pago|compra)\s+(?:de\s+)?S\/\.?\s*([\d,]+\.?\d{0,2})\s+(?:en|a)\s+([^\n\r]+)/i);
    if (charge) return genericExpense(parseFloat(charge[1].replace(/,/g, '')), `Interbank - ${cleanName(charge[2]).split('.')[0]}`, 'interbank', date, gmailId, text);
    const credit = text.match(/(?:abono|depósito|deposito)\s+(?:de\s+)?S\/\.?\s*([\d,]+\.?\d{0,2})/i);
    if (credit) return genericIncome(parseFloat(credit[1].replace(/,/g, '')), `Interbank - Abono`, 'interbank', date, gmailId, text);
    return detectTypeAndBuild(text, 'interbank', `Interbank - ${cleanName(subject).slice(0, 50)}`, date, gmailId);
}

// ─────────────────────────────────────────────
// BBVA
// ─────────────────────────────────────────────
function parseBBVA({ body, subject, date, gmailId }) {
    const text = `${subject}\n${body}`;
    const charge = text.match(/(?:cargo|consumo|pago)\s+(?:de\s+)?S\/\.?\s*([\d,]+\.?\d{0,2})/i);
    if (charge) {
        const merchant = text.match(/(?:en|establecimiento[:\s]+)\s*([A-ZÁÉÍÓÚ\w\s]{3,40})/i);
        return genericExpense(parseFloat(charge[1].replace(/,/g, '')), `BBVA - ${merchant ? cleanName(merchant[1]) : 'Consumo'}`, 'bbva', date, gmailId, text);
    }
    const credit = text.match(/(?:abono|depósito|deposito|acredita)\s+(?:de\s+)?S\/\.?\s*([\d,]+\.?\d{0,2})/i);
    if (credit) return genericIncome(parseFloat(credit[1].replace(/,/g, '')), `BBVA - Abono`, 'bbva', date, gmailId, text);
    return detectTypeAndBuild(text, 'bbva', `BBVA - ${cleanName(subject).slice(0, 50)}`, date, gmailId);
}

// ─────────────────────────────────────────────
// SCOTIABANK
// ─────────────────────────────────────────────
function parseScotiabank({ body, subject, date, gmailId }) {
    const text = `${subject}\n${body}`;
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
    return detectTypeAndBuild(text, 'nacion', `Banco Nación - ${cleanName(subject).slice(0, 50)}`, date, gmailId);
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
// ROUTER — mapea remitente → parser
// ─────────────────────────────────────────────
const PARSER_MAP = [
    // Billeteras principales
    { pattern: /yape\.com\.pe/i,                fn: parseYape },
    { pattern: /plin\.pe/i,                     fn: parsePlin },
    { pattern: /izipay|tunki/i,                 fn: parseIzipay },
    { pattern: /bim\.com\.pe|banco.*nacion.*bim/i, fn: parseBim },
    { pattern: /mercadopago|mercadolibre/i,      fn: parseMercadoPago },
    { pattern: /wise\.com/i,                    fn: parseWise },
    { pattern: /payoneer/i,                     fn: parsePayoneer },

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
    { pattern: /mibanco\.com\.pe/i,             fn: makeCajasParser('mibanco', 'MiBanco') },
];

// ─────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────
export function parseEmail({ message, bodyText, sender, date, subject }) {
    const entry = PARSER_MAP.find(p => p.pattern.test(sender));
    if (!entry) return null;
    try {
        return entry.fn({ body: bodyText, subject, date, sender, gmailId: message.id });
    } catch (e) {
        console.warn('[gmailParser] Error:', message.id, e);
        return null;
    }
}

export function parseAllEmails({ rawMessages, decodeBody, getSender, getDate, getSubject, existingIds = new Set() }) {
    const results  = [];
    const seenIds  = new Set(existingIds);

    for (const msg of rawMessages) {
        if (seenIds.has(msg.id)) continue;
        const sender   = getSender(msg);
        const date     = getDate(msg);
        const subject  = getSubject(msg);
        const bodyText = decodeBody(msg);
        const tx = parseEmail({ message: msg, bodyText, sender, date, subject });
        if (tx && tx.amount > 0 && tx.amount < 1_000_000) {
            seenIds.add(msg.id);
            results.push(tx);
        }
    }

    results.sort((a, b) => new Date(b.date) - new Date(a.date));
    return results;
}
