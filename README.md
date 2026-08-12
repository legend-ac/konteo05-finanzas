# Konteo 05

Control financiero personal para registrar ingresos y gastos, revisar el saldo del período y ordenar movimientos sin depender de hojas de cálculo.

**Aplicación:** [cont-mu.vercel.app](https://cont-mu.vercel.app/)
**Repositorio:** [legend-ac/konteo05-finanzas](https://github.com/legend-ac/konteo05-finanzas)

## Qué incluye

- Registro, edición y eliminación de ingresos y gastos.
- Clasificación de gastos: fijo, necesario o antojo.
- Filtros por hoy, últimos 7 días, mes y rango personalizado; búsqueda y ordenamiento.
- Resumen de saldo, ingresos, gastos, ahorro, límite de gasto y plan financiero.
- Exportación del período activo a Excel o PDF.
- Importación opcional desde Gmail: lectura de notificaciones financieras, revisión previa y selección de entidades antes de guardar.
- Reglas para entidades financieras: activar o ignorar una fuente, y añadir entidades manualmente desde Perfil.
- Acceso por correo/contraseña y por Google.
- Protección contra duplicados al guardar manualmente: el formulario se bloquea durante el guardado y cada intento usa una operación idempotente.
- PWA instalable, tema claro/oscuro y caché versionada.

## Stack

- HTML, CSS y JavaScript modular (sin framework).
- Firebase Authentication y Cloud Firestore.
- Google Identity Services y Gmail API (`gmail.readonly`) para la importación opcional.
- Chart.js, SheetJS y jsPDF para visualización y reportes.
- Vercel para el sitio estático de producción.

## Ejecutar localmente

Requisitos: Node.js 20+ y acceso al proyecto Firebase configurado.

```bash
git clone https://github.com/legend-ac/konteo05-finanzas.git
cd konteo05-finanzas
npm install
npm run dev
```

El comando de desarrollo sirve la carpeta actual. Para usar el mismo puerto de las pruebas:

```bash
npx serve . -l 8010
```

Comprobación de calidad:

```bash
npm run lint
```

## Configuración de Firebase y Google

La configuración pública del cliente vive en `js/firebase/runtime-config.js`. Los identificadores públicos de una app web de Firebase y el Client ID OAuth se envían al navegador por diseño; **no añadas ahí claves privadas, secretos OAuth, tokens ni cuentas de servicio**.

En Firebase Console, para el proyecto de la aplicación:

1. Habilita **Email/Password** en Authentication → Sign-in method.
2. Habilita **Google** en Authentication → Sign-in method y define el correo de soporte.
3. En Authentication → Settings → Authorized domains agrega los dominios donde publiques la app, incluido `cont-mu.vercel.app`. Para desarrollo, conserva `localhost`.
4. Crea Cloud Firestore y publica las reglas de `firestore.rules` y los índices de `firestore.indexes.json`.

Para importar movimientos, habilita Gmail API en Google Cloud y configura el consentimiento OAuth para el Client ID web de la app. La importación pide el permiso `gmail.readonly` solo cuando la persona pulsa **Auto-importar**. Iniciar sesión con Google y leer Gmail son permisos separados: entrar a Konteo no da acceso a correos.

## Datos y privacidad

Los datos se separan por UID en Firestore:

- `users/{uid}`: perfil, preferencias e información de conexión.
- `transactions/{uid}/income/{id}`: ingresos.
- `transactions/{uid}/expenses/{id}`: gastos.
- `plans/{uid}`: límites y objetivos financieros.

Las reglas de Firestore limitan cada lectura y escritura al usuario autenticado dueño del UID. Los mensajes de Gmail se procesan en el navegador para mostrar una previsualización; la app guarda únicamente los movimientos que el usuario confirma. El token de Gmail se mantiene en la sesión y no se guarda como secreto en el repositorio ni en Firestore.

## Despliegue en Vercel

El proyecto ya está vinculado a Vercel. Para desplegar el estado actual desde la raíz del proyecto:

```bash
npx vercel --prod
```

Antes de publicar, comprueba que `vercel.json` conserva las cabeceras de seguridad y la política CSP que permite Firebase, Google Authentication y Gmail API. Tras un cambio en la aplicación, el Service Worker cambia de versión para evitar servir archivos JavaScript o CSS obsoletos.

Después de añadir un dominio nuevo en Vercel, agrégalo también a Firebase Authentication → Authorized domains; de lo contrario el acceso con Google será rechazado.

## Estructura

```text
.
├── css/styles.css                 # interfaz y variantes responsive
├── js/app.js                      # estado de interfaz y flujos de autenticación
├── js/firebase/                   # inicialización y configuración pública de Firebase
├── js/services/                   # Firestore, Gmail y exportaciones
├── js/ui/                         # modales, panel, gráficos e importación Gmail
├── firestore.rules                # aislamiento y validación de datos
├── firestore.indexes.json         # índices de Firestore
├── service-worker.js              # caché de la PWA
├── vercel.json                    # rutas y cabeceras de Vercel
└── index.html                     # aplicación principal
```

## Operación segura

- No subas archivos `.env*`, claves privadas, exportaciones reales ni tokens de usuarios.
- Revisa los cambios de `runtime-config.js` antes de publicar: no debe contener un secreto de servidor.
- Si cambias reglas o índices, publícalos con una cuenta que tenga permisos sobre el proyecto Firebase correcto:

  ```bash
  npx firebase deploy --only firestore:rules,firestore:indexes
  ```

## Licencia

MIT.
