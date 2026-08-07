// js/firebase/runtime-config.js
// If a config was already injected (for example by hosting env), keep it.
// Otherwise, expose placeholders for local setup.

window.__KONTEO_FIREBASE_CONFIG__ = window.__KONTEO_FIREBASE_CONFIG__ || {
    apiKey: 'AIzaSyAk8GkeImptx01NsSW9KbP7FnCRfv8BW30',
    authDomain: 'control-financiero-andy.firebaseapp.com',
    projectId: 'control-financiero-andy',
    storageBucket: 'control-financiero-andy.firebasestorage.app',
    messagingSenderId: '320231487787',
    appId: '1:320231487787:web:8d9d35e74c51bb0b8ded6e',
    measurementId: 'G-NG7DYTW26G',
    // Gmail OAuth Client ID — obtenlo en console.cloud.google.com
    // APIs > Credenciales > Crear ID de cliente OAuth > Aplicación web
    gmailClientId: 'REPLACE_WITH_YOUR_GMAIL_OAUTH_CLIENT_ID'
};
