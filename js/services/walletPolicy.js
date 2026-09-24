// Source names are display labels, never a list of accounts to create.
const SOURCE_NAMES = {
    yape: 'Yape', plin: 'Plin', bcp: 'BCP', interbank: 'Interbank', bbva: 'BBVA',
    scotiabank: 'Scotiabank', nacion: 'Banco de la Nación', mibanco: 'MiBanco',
    banbif: 'BanBif', sip: 'SIP', binance: 'Binance', pagoefectivo: 'PagoEfectivo'
};

export function entitySourceKey(entity) {
    return `custom-${String(entity.id || entity.sender || '').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;
}

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

export function resolveWalletAccount(tx, wallets, entities = []) {
    if (tx.accountId || tx.accountAssignmentExplicit) return tx.accountId || '';
    const source = String(tx.source || '').replace(/^gmail:/, '').toLowerCase();
    const entity = entities.find(item => entitySourceKey(item) === source);
    if (entity?.defaultAccountId && wallets.some(w => w.id === entity.defaultAccountId && isActiveWallet(w))) {
        return entity.defaultAccountId;
    }
    const matches = wallets.filter(w => isActiveWallet(w) && w.linkSource === true && w.sourceKey === source);
    return matches.length === 1 ? matches[0].id : '';
}

export function walletSuggestions(wallets, transactions, entities = []) {
    const sources = new Map();
    entities.filter(e => e.active !== false).forEach(entity => {
        if (!entity.defaultAccountId) sources.set(entitySourceKey(entity), {
            sourceKey: entitySourceKey(entity), name: entity.name || entity.sender, configured: true, count: 0
        });
    });
    transactions.forEach(tx => {
        if (!String(tx.source || '').startsWith('gmail:') || resolveWalletAccount(tx, wallets, entities)) return;
        const key = tx.source.slice(6).toLowerCase();
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
