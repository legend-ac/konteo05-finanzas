// A bank, a payment channel and a personal account are different identities.
// Never infer an origin bank from a beneficiary, destination or advertising text.
const INSTITUTIONS = {
    bbva: ['BBVA', '#54799c'], interbank: ['Interbank', '#578571'],
    bcp: ['BCP', '#596f97'], mibanco: ['MiBanco', '#9a7846'],
    nacion: ['Banco de la Nación', '#a26969'], scotiabank: ['Scotiabank', '#a36d70'],
    banbif: ['BanBif', '#548b97'], yape: ['Yape', '#89709e'],
    binance: ['Binance', '#a78a49'], pagoefectivo: ['PagoEfectivo', '#7c8574'], sip: ['SIP', '#78868c'],
    pichincha: ['Banco Pichincha', '#938544'], falabella: ['Banco Falabella', '#74864f'],
    ripley: ['Banco Ripley', '#80768b'], oh: ['Financiera Oh!', '#947a57'], nu: ['Nu', '#89709e'],
    ligo: ['Ligo', '#5b8b81'], maximo: ['Máximo', '#7f8597'], b89: ['B89', '#857578'],
    kambista: ['Kambista', '#78868c'], uala: ['Ualá', '#847996'],
    'caja-arequipa': ['Caja Arequipa', '#937160'], 'caja-huancayo': ['Caja Huancayo', '#967265'],
    'caja-piura': ['Caja Piura', '#77799a'], 'caja-cusco': ['Caja Cusco', '#977568'],
    'caja-trujillo': ['Caja Trujillo', '#907454'], 'caja-sullana': ['Caja Sullana', '#687f9a'],
    'caja-tacna': ['Caja Tacna', '#987075'], 'caja-maynas': ['Caja Maynas', '#648875']
};

export const INSTITUTION_CHOICES = Object.entries(INSTITUTIONS)
    .map(([value, [label]]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label, 'es'));

export function isKnownInstitution(value) {
    return Boolean(institutionKey(value));
}

export function entitySourceKey(entity) {
    return `custom-${String(entity.id || entity.sender || '').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;
}

function normalize(value) {
    return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

function institutionKey(value) {
    const key = normalize(value).replace(/^gmail:/, '').replace(/^cuenta\s+(?:de\s+)?/, '').replace(/[\s_·]+/g, '-');
    if (INSTITUTIONS[key]) return key;
    if (/^plin-(bbva|interbank)$/.test(key)) return key.slice(5);
    if (['banco-de-la-nacion', 'banco-nacion'].includes(key)) return 'nacion';
    if (['banco-de-credito', 'banco-de-credito-del-peru'].includes(key)) return 'bcp';
    if (['mi-banco'].includes(key)) return 'mibanco';
    return '';
}

function senderInstitution(sender) {
    const email = normalize(sender).match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@([a-z0-9.-]+\.[a-z]{2,})/);
    const domain = email?.[1] || '';
    const domains = { 'bbva.com.pe': 'bbva', 'bbva.pe': 'bbva', 'interbank.pe': 'interbank', 'interbank.com.pe': 'interbank', 'netinterbank.com.pe': 'interbank', 'bcp.com.pe': 'bcp', 'viabcp.com': 'bcp', 'mibanco.com.pe': 'mibanco' };
    return Object.entries(domains).find(([host]) => domain === host || domain.endsWith(`.${host}`))?.[1] || '';
}

export function walletInstitution(wallet = {}) {
    return institutionKey(wallet.institution) || institutionKey(wallet.name) || institutionKey(wallet.sourceKey);
}

export function sourceIdentity(tx = {}, entities = []) {
    const source = normalize(tx.source).replace(/^gmail:/, '');
    const configured = entities.find(entity => entitySourceKey(entity) === source);
    const senderBank = senderInstitution(tx.sourceSender || '');
    const sourceBank = institutionKey(source);
    const conflict = !!(senderBank && sourceBank && senderBank !== sourceBank);
    const channel = /^plin(?:-|$)/.test(source) || normalize(configured?.name) === 'plin' ? 'Plin' : source === 'yape' ? 'Yape' : ['Plin', 'QR'].includes(tx.paymentChannel) ? tx.paymentChannel : '';
    // An explicit, audited correction is allowed only when the original bank
    // is unknown. Sender provenance takes precedence over old source aliases.
    const corrected = institutionKey(tx.sourceInstitutionOverride);
    const bank = senderBank || sourceBank || senderInstitution(configured?.sender) || corrected;
    const unresolved = !bank;
    const name = bank ? INSTITUTIONS[bank][0] : channel === 'Plin' ? 'Banco por identificar' : configured?.name || tx.sourceLabel || 'Origen por identificar';
    return {
        bank, channel, unresolved, conflict, name,
        id: bank ? `institution:${bank}` : `unresolved:${source || 'unknown'}`,
        sourceKey: bank ? (channel === 'Plin' ? `plin-${bank}` : bank) : source,
        color: bank ? INSTITUTIONS[bank][1] : '#918572',
        manuallyIdentified: !!corrected && !senderBank && !sourceBank
    };
}

export function movementIdentity(tx = {}, wallets = [], entities = []) {
    const wallet = wallets.find(item => item.id === tx.accountId);
    const imported = !!tx.gmailId || String(tx.source || '').startsWith('gmail:');
    if (imported) {
        const identity = sourceIdentity(tx, entities);
        const accountBank = walletInstitution(wallet);
        return { ...identity, accountName: wallet?.name || '', accountConflict: !!(identity.bank && accountBank && identity.bank !== accountBank) };
    }
    const bank = walletInstitution(wallet);
    if (bank) return { id: `institution:${bank}`, bank, name: INSTITUTIONS[bank][0], color: INSTITUTIONS[bank][1], channel: '', accountName: wallet.name };
    return { id: wallet ? `account:${wallet.id}` : '__unassigned__', name: wallet?.name || 'Sin entidad asignada', color: '#918572', channel: '', accountName: wallet?.name || '' };
}

export function canAutoLink(tx, wallet, entities = []) {
    const identity = sourceIdentity(tx, entities);
    if (identity.conflict || (identity.channel === 'Plin' && identity.unresolved)) return false;
    const bank = walletInstitution(wallet);
    if (normalize(wallet.sourceKey) === 'plin' && !bank) return false;
    return !(bank && identity.bank && bank !== identity.bank);
}
