import { entitySourceKey, sourceIdentity, canAutoLink } from './entityIdentity.js';
export { entitySourceKey } from './entityIdentity.js';
// Source names are display labels, never a list of accounts to create.
const SOURCE_NAMES = {
    yape: 'Yape', plin: 'Plin', bcp: 'BCP', interbank: 'Interbank', bbva: 'BBVA',
    scotiabank: 'Scotiabank', nacion: 'Banco de la Nación', mibanco: 'MiBanco',
    banbif: 'BanBif', sip: 'SIP', binance: 'Binance', pagoefectivo: 'PagoEfectivo'
};

SOURCE_NAMES['plin-bbva'] = 'BBVA';
SOURCE_NAMES['plin-interbank'] = 'Interbank';

export function walletNeedsReview(wallet) {
    if (!wallet.systemDefault || wallet.userConfirmed || wallet.active === false) return false;
    // Preserve accounts the user already edited or funded.
    if (Number(wallet.openingBalance || 0) !== 0) return false;
    const created = wallet.createdAt?.toMillis?.();
    const updated = wallet.updatedAt?.toMillis?.();
    return created == null || updated == null || created === updated;
}

export function isActiveWallet(wallet) {
    return wallet.active !== false && !walletNeedsReview(wallet);
}

// Gmail configuration can contain custom senders and known bank rules. Both
// describe an assignment preference, never a new wallet or institution.
export function gmailWalletAssignmentRules(gmailImport = {}) {
    const custom = Array.isArray(gmailImport?.customEntities) ? gmailImport.customEntities : [];
    const known = Object.entries(gmailImport?.knownEntitySettings || {})
        .filter(([, setting]) => setting?.defaultAccountId)
        .map(([sourceKey, setting]) => ({
            id: `known-${sourceKey}`,
            sourceKey,
            defaultAccountId: String(setting.defaultAccountId || ''),
            active: setting.active !== false,
            known: true
        }));
    return [...custom, ...known];
}

export function resolveWalletAccount(tx, wallets, entities = []) {
    if (tx.accountId || tx.accountAssignmentExplicit) return tx.accountId || '';
    const source = String(tx.source || '').replace(/^gmail:/, '').toLowerCase();
    const identity = sourceIdentity(tx, entities);
    const entity = entities.find(item => (
        entitySourceKey(item) === source ||
        String(item.sourceKey || '').toLowerCase() === source ||
        (item.known === true && String(item.sourceKey || '').toLowerCase() === identity.bank)
    ));
    if (entity?.defaultAccountId) {
        const configured = wallets.find(w => w.id === entity.defaultAccountId && isActiveWallet(w));
        return configured && canAutoLink(tx, configured, entities) ? configured.id : '';
    }
    const matches = wallets.filter(w => isActiveWallet(w) && w.linkSource === true &&
        (w.sourceKey === source || w.sourceKey === identity.sourceKey || w.sourceKey === identity.bank) && canAutoLink(tx, w, entities));
    return matches.length === 1 ? matches[0].id : '';
}

export function walletSuggestions(wallets, transactions, entities = []) {
    const sources = new Map();
    entities.filter(e => e.active !== false).forEach(entity => {
        const identity = sourceIdentity({ source: entitySourceKey(entity) }, entities);
        if (identity.channel === 'Plin' && identity.unresolved) return;
        const key = identity.bank || entitySourceKey(entity);
        if (!entity.defaultAccountId) sources.set(key, {
            sourceKey: key, name: identity.bank ? identity.name : entity.name || entity.sender, configured: true, count: 0
        });
    });
    transactions.forEach(tx => {
        if (!String(tx.source || '').startsWith('gmail:') || resolveWalletAccount(tx, wallets, entities)) return;
        const identity = sourceIdentity(tx, entities);
        // Unknown Plin receipts must be identified before proposing a linked account.
        if (identity.channel === 'Plin' && identity.unresolved) return;
        const key = identity.bank || identity.sourceKey;
        if (!key) return;
        const entity = entities.find(e => entitySourceKey(e) === key);
        const entry = sources.get(key) || {
            sourceKey: key, name: entity?.name || SOURCE_NAMES[key] || tx.sourceLabel || key, count: 0
        };
        entry.count++;
        sources.set(key, entry);
    });
    return [...sources.values()].filter(source => !wallets.some(w => w.sourceKey === source.sourceKey))
        .sort((a, b) => a.name.localeCompare(b.name, 'es'));
}
