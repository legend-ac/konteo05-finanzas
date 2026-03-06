// js/firebase/config.js - Firebase initialization (Compat SDK from CDN)

const firebaseConfig = window.__KONTEO_FIREBASE_CONFIG__;
const firebase = window.firebase;

const isPlaceholderConfig = (cfg) => {
    if (!cfg || typeof cfg !== 'object') return true;
    const requiredKeys = ['apiKey', 'authDomain', 'projectId', 'appId'];
    return requiredKeys.some((key) => {
        const value = String(cfg[key] || '');
        return !value || value.includes('REPLACE_WITH_');
    });
};

if (!firebase) {
    throw new Error('Firebase SDK no esta cargado en window.firebase');
}

if (!firebaseConfig || typeof firebaseConfig !== 'object') {
    throw new Error('Falta la configuracion de Firebase en window.__KONTEO_FIREBASE_CONFIG__');
}

if (isPlaceholderConfig(firebaseConfig)) {
    throw new Error('Configuracion de Firebase incompleta. Edita js/firebase/runtime-config.js con credenciales reales.');
}

if (!firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
}

export const auth = firebase.auth();
export const db = firebase.firestore();
export { firebase };

db.enablePersistence({ synchronizeTabs: true }).catch(() => { });
