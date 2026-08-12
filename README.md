# Konteo 05 — Control Financiero Personal

Aplicación Web Progresiva (PWA) moderna para el control financiero personal. Permite registrar e importar ingresos y gastos, analizar el saldo por períodos, generar reportes detallados en Excel y PDF, e importar automáticamente comprobantes bancarios desde Gmail.

[![Sitio Web](https://img.shields.io/badge/Sitio_Web-cont--mu.vercel.app-6d5bff?style=flat-square&logo=vercel)](https://cont-mu.vercel.app/)
[![Licencia](https://img.shields.io/badge/Licencia-MIT-green.svg?style=flat-square)](LICENSE)

---

## 🚀 Características Principales

### 📊 Gestión Financiera
- **Registro de Movimientos**: Agrega, edita y elimina ingresos y gastos en tiempo real con actualización instantánea de balance.
- **Categorización Intuitiva**:
  - 🟢 **Fijo**: Gastos recurrentes obligatorios (alquiler, servicios, suscripciones).
  - 🟡 **Necesario**: Gastos esenciales variables (comida, transporte, salud).
  - 🔴 **Antojo**: Gastos prescindibles o de entretenimiento.
- **Filtros de Período**:
  - Hoy (Diario)
  - Últimos 7 días (Semanal)
  - Este mes (Mensual)
  - Rango de fechas personalizado (con selector interactivo)
- **Estrategia e Insights**: Cálculo automático de tasa de ahorro, regla 50/30/20 y metas financieras mensuales.

### 📥 Importación Automática desde Gmail
- **Auto-importación Bancaria**: Escanea notificaciones de transferencias y pagos en correos de entidades financieras (BCP, Yape, Plin, Interbank, BBVA Perú, Scotiabank, BanBif, Banco Pichincha, Banco de la Nación, Falabella, Ripley, Financiera Oh!, Cajas Municipales, entre otros).
- **Previsualización y Confirmación**: Revisa el monto, la fecha, el comercio/nota y la categoría antes de guardar las transacciones.
- **Reglas de Entidades**: Activa, desactiva o añade fuentes de importación según tus preferencias.

### 📄 Exportación de Reportes
- **Excel (.xlsx)**: Genera cuadernos de trabajo multí-hoja (Resumen, Ingresos, Gastos y Análisis por Categoría) adaptados al período activo filtrado en el dashboard.
- **PDF (.pdf)**: Exporta reportes visuales listos para imprimir con encabezado, métricas del período, tabla detallada de movimientos y paginación.

### 🔒 Autenticación y Seguridad
- **Inicio de sesión múltiple**: Soporte para acceso por correo/contraseña y **Continuar con Google** mediante Google Identity Services (GIS) y credenciales directas de Firebase (`signInWithCredential`).
- **Seguridad en Firestore**: Las reglas de seguridad aíslan estrictamente los datos de cada usuario según su UID.

### 📱 Experiencia de Usuario y PWA
- **Modo Oscuro / Claro**: Detección del tema del sistema y conmutador manual guardado en preferencia local.
- **PWA Instalable**: Service Worker configurado con estrategia de almacenamiento en caché para carga ultra rápida e instalación como app nativa en móvil y escritorio.

---

## 🛠️ Tecnologías Utilizadas

- **Frontend**: HTML5 Semántico, Vanilla JavaScript (ES Modules), CSS3 nativo (Glassmorphism, Variables CSS, Diseño Adaptativo).
- **Backend / BaaS**: Firebase Authentication, Cloud Firestore.
- **Google Cloud APIs**: Google Identity Services (GIS), Gmail API (`gmail.readonly`) vía OAuth 2.0.
- **Librerías Client-side**:
  - [Chart.js](https://www.chartjs.org/) — Gráficos financieros interactivos.
  - [SheetJS (xlsx)](https://sheetjs.com/) — Exportación a hojas de cálculo Excel.
  - [jsPDF](https://github.com/parallax/jsPDF) — Generación de documentos PDF.
- **Hosting & CI/CD**: Vercel.

---

## 📁 Estructura del Proyecto

```text
.
├── css/
│   └── styles.css                 # Sistema de diseño, temas y responsive layout
├── js/
│   ├── app.js                      # Orquestador principal de la app y autenticación
│   ├── state.js                   # Estado reactivo global de la aplicación
│   ├── firebase/
│   │   ├── config.js              # Inicialización de Firebase Compat SDK
│   │   └── runtime-config.js      # Configuración pública del cliente Firebase/Google
│   ├── services/
│   │   ├── dbService.js           # Consultas y escrituras en Firestore
│   │   ├── exportService.js       # Generador de reportes Excel y PDF
│   │   └── gmailService.js        # Integración y parsing de correos con Gmail API
│   └── ui/
│       ├── charts.js              # Renderizado de gráficos con Chart.js
│       ├── gmailImport.js         # Modal e interfaz de previsualización de Gmail
│       ├── helpers.js             # Formateadores, ordenamiento y utilidades
│       ├── insights.js            # Análisis estratégico y reglas financieras
│       ├── modals.js              # Control de ventanas modales y vistas
│       ├── render.js              # Renderizado de listas de transacciones
│       └── toast.js               # Notificaciones flotantes (Toast)
├── firestore.rules                # Reglas de seguridad de Cloud Firestore
├── firestore.indexes.json         # Índices compuestos de Firestore
├── index.html                     # Maqueta principal de la SPA
├── oauth-callback.html            # Receptor de callbacks OAuth 2.0 para popups
├── service-worker.js              # Service Worker para PWA y soporte offline
├── manifest.json                  # Manifiesto de la Web App instalable
├── vercel.json                    # Cabeceras de seguridad y redirecciones en Vercel
└── package.json                   # Scripts y configuración del proyecto
```

---

## 💻 Desarrollo Local

### Requisitos Previos
- Node.js 18 o superior.
- Un proyecto en [Firebase Console](https://console.firebase.google.com/).

### Instalación

1. Clona el repositorio:
   ```bash
   git clone https://github.com/legend-ac/konteo05-finanzas.git
   cd konteo05-finanzas
   ```

2. Instala las dependencias:
   ```bash
   npm install
   ```

3. Inicia el servidor de desarrollo local:
   ```bash
   npm run dev
   ```
   *La aplicación estará disponible en `http://localhost:3000` (o el puerto asignado).*

---

## ⚙️ Configuración de Firebase y Google Cloud

### 1. Firebase Authentication
En la consola de Firebase (**Authentication** → **Sign-in method**):
- Habilita **Correo electrónico/contraseña**.
- Habilita **Google** y selecciona un correo de asistencia para el proyecto.
- En **Settings** → **Authorized domains**, añade tus dominios (ej. `cont-mu.vercel.app` y `localhost`).

### 2. Configuración en la App (`js/firebase/runtime-config.js`)
Reemplaza los valores de configuración pública en `js/firebase/runtime-config.js`:

```javascript
window.__KONTEO_FIREBASE_CONFIG__ = window.__KONTEO_FIREBASE_CONFIG__ || {
    apiKey: "TU_API_KEY_PUBLIC_FIREBASE",
    authDomain: "tu-proyecto.firebaseapp.com",
    projectId: "tu-proyecto-id",
    storageBucket: "tu-proyecto.firebasestorage.app",
    messagingSenderId: "1234567890",
    appId: "1:1234567890:web:abcdef123456",
    measurementId: "G-XXXXXXXXXX",
    gmailClientId: "1234567890-abcdef.apps.googleusercontent.com"
};
```

> [!IMPORTANT]
> **Seguridad**: Estos identificadores corresponden al cliente web público de Firebase. Nunca subas claves privadas de servicio (`service-account.json`) ni secretos cliente de OAuth al repositorio.

### 3. Google Cloud Console (OAuth 2.0)
Para que el inicio de sesión con Google y la importación de Gmail funcionen correctamente en producción:
- Ve a [Google Cloud Console Credentials](https://console.cloud.google.com/apis/credentials).
- En el ID de cliente OAuth 2.0 Web, añade en **Orígenes de JavaScript autorizados**:
  - `https://cont-mu.vercel.app`
  - `http://localhost:3000`
- En **URIs de redireccionamiento autorizados**, añade:
  - `https://cont-mu.vercel.app/__/auth/handler`
  - `https://cont-mu.vercel.app/oauth-callback.html`

### 4. Firestore (Base de Datos)
Despliega las reglas e índices de la base de datos usando Firebase CLI:
```bash
npx firebase deploy --only firestore:rules,firestore:indexes
```

---

## 🔒 Privacidad de Datos y Seguridad

- **Aislamiento por usuario**: Todas las transacciones se almacenan bajo la ruta `users/{uid}` o `transactions/{uid}/...` en Firestore. Las reglas de seguridad impiden que un usuario acceda a la información de otro.
- **Permisos de Gmail**: El acceso a Gmail solicita el alcance exclusivo de lectura (`gmail.readonly`) únicamente cuando el usuario presiona voluntariamente **Auto-importar**. Los correos se procesan de forma privada en el navegador del usuario y no se envían a servidores de terceros.
- **Sin datos sensibles en Git**: El proyecto está configurado para ignorar tokens de autenticación, archivos temporales e información de entornos locales.

---

## 📄 Licencia

Este proyecto está bajo la Licencia [MIT](LICENSE).
