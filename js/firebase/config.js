// js/firebase/config.js — Firebase initialization (Compat SDK from CDN)

const firebaseConfig = {
    apiKey: "AIzaSyAk8GkeImptx01NsSW9KbP7FnCRfv8BW30",
    authDomain: "control-financiero-andy.firebaseapp.com",
    projectId: "control-financiero-andy",
    storageBucket: "control-financiero-andy.firebasestorage.app",
    messagingSenderId: "320231487787",
    appId: "1:320231487787:web:8d9d35e74c51bb0b8ded6e",
    measurementId: "G-NG7DYTW26G"
};

const firebase = window.firebase;
if (!firebase) {
    throw new Error('Firebase SDK no está cargado en window.firebase');
}

if (!firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
}

export const auth = firebase.auth();
export const db = firebase.firestore();
export { firebase };

db.enablePersistence({ synchronizeTabs: true }).catch(() => { });
