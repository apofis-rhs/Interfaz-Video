# chunkInterface — interfaz de subida y análisis de video

Frontend standalone (React + Vite + TypeScript) para subir un video desde 5
orígenes — **Local, Google Drive, OneDrive, Dropbox, YouTube** —, mostrarlo en
un `<video>` grande al terminar, y disparar un análisis rubricado con IA sobre
ese video. Sin chunking del lado del cliente: se sube el archivo completo en
una sola operación (con streaming pipe para los proveedores externos, ver
sección 6).

Este documento explica qué había en la carpeta antes de empezar, qué se creó,
qué se modificó, cómo se conecta todo, y el estado actual de cada pieza.

---

## 1. Qué existía antes vs. qué se creó

### Ya existía (solo lectura, nunca modificado)

| Archivo | Qué es | Por qué no se tocó |
|---|---|---|
| `downloader.py` | Función suelta `download_video_from_url()` que baja un video de Google Drive (vía `gdown`) o de un link directo/Dropbox (vía `httpx`) a disco **local del backend**. No es un endpoint HTTP, no sube nada a GCS. | Se pidió explícitamente no modificarlo — es material de referencia. La lógica real de YouTube que sí se implementó (sección 7) usa `yt-dlp`, no este archivo. |
| `media_ingestion_service/` (dentro de `chunkInterface/`) | Copia de 4 archivos del módulo de ingesta del backend real, solo con el endpoint `local-session`. | Es una copia de referencia para consulta, **no el código que realmente corre**. El backend real vive en un repo aparte (ver sección 7). |

Todo lo demás en `chunkInterface/` se creó desde cero en esta conversación —
la carpeta estaba vacía salvo esos dos elementos.

---

## 2. Flujo end-to-end

Los 5 botones de subida convergen en **un solo camino**: conseguir los bytes
del video en el navegador (como sea que se hayan obtenido) y subirlos a GCS
con el mismo mecanismo. Una vez el video está listo, un segundo flujo
independiente dispara el análisis rubricado.

```
Local          →  <input type=file>                                    ─┐
Google Drive   →  login Google + Picker → fetch Drive API (stream)      ─┤
OneDrive       →  login Microsoft (MSAL) + picker v8 → fetch (stream)    ─┤→ uploadToGcs(filename, contentType, size, body)
Dropbox        →  Dropbox Chooser → fetch link directo (stream)          ─┘        │
                                                                                     ▼
                                          POST /upload/local-session
                                          PUT  {upload_session_url}   (Blob o ReadableStream → GCS, con progreso)
                                          poll GET /upload/{video_id}/status  (cada 2s)
                                                     │
                                          status: ready → <video src={read_url}> + AnalysisPanel

YouTube        →  pegar URL → POST /upload/from-url (source: youtube, yt-dlp en background)
                                          poll GET /upload/{video_id}/status

── Con el video listo ──
AnalysisPanel  →  adjuntar JSON de rúbrica → POST /api/v2/iniciar-analisis {video_id, rubric}
                                          poll GET /api/v2/video/analisis/{video_id}  (cada 3s)
                                                     │
                                          status: done → tabla de criterios + score total
```

Estados de subida (`UploadPhase`): `idle → uploading → processing → ready | error`.
Estados de análisis (`AnalysisPhase`): `idle → running → completed | failed`.

---

## 3. Árbol de archivos y qué hace cada uno

```
chunkInterface/
├── .env / .env.example        # Variables VITE_* (ver sección 8)
├── .gitignore
├── index.html                 # Punto de entrada de Vite
├── package.json                # react, react-dom, @azure/msal-browser + tooling de Vite/TS
├── tsconfig.json / tsconfig.node.json
├── vite.config.ts
├── downloader.py               # (referencia, sin modificar — ver sección 1)
├── media_ingestion_service/     # (referencia, sin modificar — ver sección 1)
└── src/
    ├── main.tsx                 # ReactDOM.createRoot(...).render(<App/>)
    ├── App.tsx                  # Orquestador: precarga SDKs, arma la pantalla
    ├── App.css                  # Todos los estilos (tema oscuro, sin librería de UI)
    ├── vite-env.d.ts             # Tipos de import.meta.env
    │
    ├── api/
    │   ├── config.ts             # API_BASE_URL = VITE_API_BASE_URL
    │   ├── types.ts              # Tipos compartidos de subida (UploadSource, UploadPhase, requests/responses)
    │   ├── uploadApi.ts          # fetch/XHR wrappers de los 3 endpoints de subida (v1)
    │   ├── analysisApi.ts        # v1 del análisis (/video/evaluations/links) — sin uso, se dejó a propósito
    │   └── analysisApiV2.ts      # v2 del análisis (/api/v2/video/...) — la que realmente usa AnalysisPanel
    │
    ├── hooks/
    │   ├── useVideoUpload.ts     # Máquina de estados de subida (ver sección 4)
    │   └── useVideoAnalysis.ts   # Máquina de estados del análisis v2 (ver sección 6)
    │
    ├── providers/
    │   ├── types.ts               # PickedFile = { filename, contentType, size, stream }
    │   ├── externalGlobals.d.ts   # Tipos ambiente para window.gapi/google/OneDrive/Dropbox
    │   ├── googleDrive.ts         # Google Identity Services + Picker API
    │   ├── oneDrive.ts            # OneDrive picker v8 (MSAL + postMessage)
    │   └── dropbox.ts             # Dropbox Chooser
    │
    ├── utils/
    │   ├── loadScript.ts          # Inyecta <script> una sola vez (usado por Google)
    │   ├── logger.ts              # console.info/error con prefijo + formatBytes/formatElapsed
    │   ├── sourceValidation.ts    # Labels de los 5 botones + regex de validación de URL (YouTube)
    │   └── videoContentType.ts    # Content-types permitidos + inferencia por extensión
    │
    └── components/
        ├── SourcePicker.tsx        # Los 5 botones de origen
        ├── UrlSourceModal.tsx      # Modal "pegar URL" (hoy solo lo usa YouTube)
        ├── StatusBanner.tsx        # Subiendo/Procesando/Listo/Error + barra de progreso + tiempo total
        ├── VideoPlayer.tsx         # <video controls autoPlay> cuando status === "ready"
        └── AnalysisPanel.tsx       # Adjuntar rúbrica JSON + disparar/mostrar el análisis v2
```

---

## 4. El hook de subida: `useVideoUpload.ts`

Expone:

- `startLocalUpload(file: File)` — para el botón Local.
- `startProviderPick(source: 'google_drive' | 'onedrive' | 'dropbox')` — dispara el picker nativo del proveedor.
- `startYoutubeImport(url: string)` — para el modal de YouTube.
- `reset()` — vuelve a `idle`.

Estado expuesto: `phase`, `errorMessage`, `readUrl`, `videoId` (necesario para
`AnalysisPanel`), `startedAt`, `progress` (0-100, solo durante `uploading`),
`elapsedMs` (tiempo total congelado al llegar a `ready`).

Internamente, **todo excepto YouTube converge en `uploadToGcs(filename, contentTypeHint, size, body)`**,
donde `body` es un `Blob` (Local) o un `ReadableStream<Uint8Array>` (los 3
proveedores — ver sección 6 sobre por qué):
1. Valida/infere el `content_type` con `resolveVideoContentType` (debe ser `video/mp4`, `video/quicktime` o `video/webm`).
2. `POST /upload/local-session` → `{ upload_session_url, gcs_uri, ... }`.
3. Sube el `body` a `upload_session_url` reportando progreso real (`uploadBlobWithProgress` vía XHR para Local, `uploadStreamWithProgress` vía `fetch` + `TransformStream` para los proveedores).
4. Hace polling de `GET /upload/{video_id}/status` cada 2s (timeout 10 min) hasta `ready` o `error`; al llegar a `ready` congela `elapsedMs = Date.now() - startedAt`.

YouTube usa `startYoutubeImport` → `POST /upload/from-url` (el backend baja el
video con `yt-dlp`, no hay bytes que pasen por el navegador) → mismo polling
de `/status`.

**Logging**: cada paso relevante (origen elegido, archivo seleccionado,
sesión creada, progreso cada 10%, subida completa, cambios de estado,
tiempo total, errores) se imprime con `console.info`/`console.error`
prefijado `[chunkInterface]` — **en la consola del navegador (F12 → Console),
no en la terminal de `npm run dev`**.

---

## 5. Cómo funciona cada proveedor (`src/providers/`)

Cada archivo expone dos funciones: `preload*()` (carga el SDK externo al
montar `App`, sin abrir nada) y `pick*()` (dispara el login/selector, resuelve
con un `PickedFile = { filename, contentType, size, stream }`).

**¿Por qué precargar?** El popup de login debe abrirse de forma *síncrona*
dentro del `onClick` — si hay un `await` de por medio (p. ej. cargando el
script del SDK), el navegador bloquea el popup. `App.tsx` llama a los 3
`preload*()` en un `useEffect` al montar, así el `onClick` puede invocar la
API del picker de inmediato.

**¿Por qué `stream` y no `blob`?** Ver sección 6 — permite encadenar la
descarga del proveedor directo a la subida a GCS sin bufferear el archivo
completo en memoria primero.

### Google Drive (`googleDrive.ts`)
- Carga `apis.google.com/js/api.js` (gapi + Picker) y `accounts.google.com/gsi/client` (Google Identity Services).
- `preloadGoogleDrive()` arma un `tokenClient` con scope `drive.file` (solo da acceso a los archivos que el usuario elige, no a todo su Drive).
- `pickGoogleDriveFile()` pide el access token, abre el Picker restringido a los 3 mime types soportados, y al elegir un archivo pide metadata (`name,size,mimeType`) y abre la descarga (`?alt=media`) devolviendo `contentRes.body` directo, sin esperar a que termine.
- **Requiere `setAppId()`** (número de proyecto de Cloud, no el Client ID) — sin esto, el scope `drive.file` no le da al token visibilidad sobre el archivo elegido y la API responde 404 "File not found" aunque el archivo exista.
- Variables: `VITE_GOOGLE_CLIENT_ID`, `VITE_GOOGLE_API_KEY`, `VITE_GOOGLE_APP_ID`.

### Dropbox (`dropbox.ts`)
- Carga `dropins.js` con `data-app-key`, usa el widget **Dropbox Chooser** (`Dropbox.choose`) con `linkType: "direct"` (no requiere OAuth completo, solo el App key). El resultado incluye `bytes` (tamaño), usado para la sesión de GCS.
- Descarga con `fetch(picked.link)` y devuelve `res.body` directo.
- Variable: `VITE_DROPBOX_APP_KEY`. En el Dropbox App Console hay que agregar `localhost` en "Chooser / Saver / Embedder domains" (no viene habilitado por defecto).

### OneDrive (`oneDrive.ts`) — migrado de v7.2 a v8
- **Historial**: se implementó primero con el SDK legacy v7.2 (`OneDrive.js`), pero Chrome bloquea el sondeo de `window.closed` que usa ese SDK vía `Cross-Origin-Opener-Policy` (produce `errorCode: "badResponse"`). Se migró a la **v8 oficial** (Microsoft la mantiene activamente, no depende de `window.closed`).
- v8 es una página hosteada por Microsoft con la que se habla por `postMessage`/`MessageChannel`. `pickOneDriveFile()`:
  1. Abre un popup en blanco **y primero consigue un token vía MSAL** (`acquireToken`) — importante: si en vez de esto se pedía el token de forma reactiva al recibir el comando `authenticate` del picker, el popup de login de MSAL quedaba demasiado lejos del gesto de clic original y el navegador lo bloqueaba en silencio (bug ya corregido).
  2. Con el token en mano, hace `POST` a un form apuntando a `https://onedrive.live.com/picker/_layouts/15/FilePicker.aspx`, mandando el token como campo oculto.
  3. Escucha `initialize`, activa el `MessagePort`, responde a `authenticate` (vía `acquireTokenSilent`, ya no necesita popup tras el login inicial), `pick`, `close`.
  4. El archivo elegido solo trae `{id, parentReference.driveId, "@sharePoint.endpoint"}` — se pide un token para ese endpoint y se hace `GET .../items/{id}?select=...,@microsoft.graph.downloadUrl` para conseguir la URL real, devolviendo el stream de esa descarga.
- Usa `@azure/msal-browser` (`PublicClientApplication`, `authority: https://login.microsoftonline.com/consumers` — cuentas **personales**; ajustar si se necesitan cuentas de trabajo/escuela). `loginPopup` se llama con `overrideInteractionInProgress: true` — sin esto, un intento anterior sin limpiar bien (popup cerrado a mano) deja el flag interno de MSAL trabado y todo login posterior falla con `interaction_in_progress`.
- Variable: `VITE_MS_CLIENT_ID`. Requiere en Azure AD una plataforma **"Single-page application"** con redirect URI `http://localhost:5173`.

### YouTube (`UrlSourceModal.tsx`, sin provider propio)
- Sigue siendo "pegar URL". `sourceValidation.ts` valida con una regex simple (`youtube.com` / `youtu.be`) antes de enviar. La descarga real ocurre en el backend (sección 7).

---

## 6. Optimización de subida: streaming pipe + progreso

**El problema**: para Drive/OneDrive/Dropbox, la primera versión descargaba el
archivo completo a un `Blob` en memoria (`await response.blob()`) y *después*
arrancaba el `PUT` a GCS — dos transferencias secuenciales, y sin ninguna
señal de progreso más que un cronómetro.

**El cambio**: `PickedFile` pasó de `{ blob, filename }` a
`{ filename, contentType, size, stream }`. Cada proveedor devuelve el
`ReadableStream` de su propia respuesta de descarga (`contentRes.body`) sin
consumirlo. `uploadToGcs` encadena ese stream directo como `body` del `PUT`
de subida (`uploadStreamWithProgress`, en `uploadApi.ts`):

```ts
fetch(uploadUrl, {
  method: 'PUT',
  headers: { 'Content-Type': contentType, 'Content-Length': String(sizeBytes) },
  body: trackedStream,   // ReadableStream, pasado por un TransformStream que cuenta bytes
  duplex: 'half',        // requerido por la spec de fetch para mandar un stream como body
})
```

Descarga y subida corren en paralelo en vez de una después de la otra, y ya
no se acumulan varios GB en memoria del navegador antes de subir. Local no
necesitó este cambio — ya era una sola transferencia óptima (usa
`uploadBlobWithProgress` vía `XMLHttpRequest`, que da progreso nativo con
soporte universal en navegadores; el streaming vía `fetch` con `duplex: 'half'`
solo tiene soporte confiable en navegadores basados en Chromium).

**Qué tanto ayuda en la práctica — verificado con datos reales**: con un
video de Drive de 1.4-1.5 GB, la versión secuencial tardaba ~900s y la
versión con streaming pipe ~730s. Haciendo el despeje
(`descarga + subida = 600 s/GB` vs `max(descarga, subida) ≈ 521 s/GB`), la
descarga de Drive resultó ser rápida (~79 s/GB) comparada con la subida a GCS
(~521 s/GB, ≈15 mbps) — es decir, **el cuello de botella real es el ancho de
banda de subida del usuario a internet**, no algo que el pipe pueda resolver
del todo: cuando una de las dos fases ya es rápida, superponerlas ahorra poco
porque casi todo el tiempo lo consumía solo la fase lenta. El pipe sí ayuda
proporcionalmente más cuanto más parejas sean las dos velocidades.

La única forma de ir más allá de ese límite sería mover la descarga+subida de
Drive/OneDrive/Dropbox al backend (que corre en un datacenter con mucho más
ancho de banda hacia ambos lados) en vez de rutear los bytes por la conexión
residencial del usuario — cambio de arquitectura grande, no implementado.

**Progreso y tiempo total**: `StatusBanner` muestra una barra con el
porcentaje exacto durante `uploading` (bytes reales transferidos / total,
vía `xhr.upload.onprogress` para Local o el conteo del `TransformStream` para
los proveedores) y, al llegar a `ready`, el tiempo total que tardó
(`elapsedMs`, congelado desde que arrancó hasta que el backend confirmó el
objeto en GCS).

---

## 7. Análisis rubricado (`AnalysisPanel.tsx` + `useVideoAnalysis.ts`)

Debajo del `<video>`, una vez `status === 'ready'`, aparece un panel con dos
botones:

1. **"Agregar JSON"** — abre el selector de archivos, valida que sea JSON
   parseable y que tenga el wrapper esperado por el backend
   (`{ "rubric": { "id": ..., "criteria": [...] } }`) antes de aceptarlo.
2. **"Empezar análisis"** — deshabilitado hasta que haya rúbrica adjunta.
   Llama a `POST /api/v2/video/iniciar-analisis { video_id, rubric }`.

Después hace polling cada 3s a `GET /api/v2/video/analisis/{video_id}` hasta
`done` (muestra tabla recursiva de criterios con score/feedback y el score
total) o `error`/`not_found` (terminal, con botón de reintento).

**Importante sobre el pipeline v2**: el backend detrás de estos dos
endpoints (`app/services/video_v2/`, chunking + embeddings + retrieval +
análisis multimodal) **ya existía en `ia-microservice2` y no fue construido
en esta conversación** — solo se verificó su contrato real
(`app/services/video_v2/analysis_api/router.py`) y se conectó el frontend
contra él. Registro de estado del análisis: en memoria en el proceso del
backend (`_analysis_registry`), se pierde si el backend se reinicia — por
eso `not_found` se trata como error terminal en el frontend, no como algo
para reintentar el polling.

Existe también `src/api/analysisApi.ts`, un cliente para el endpoint v1
(`/api/v1/video/evaluations/links`) que sí existía antes y que se probó
funcional — **no lo usa ningún componente hoy**, se dejó sin borrar a
petición explícita.

---

## 8. Backend: qué existe, qué implementé, qué falta

**El backend real NO vive en `chunkInterface/`** — está en un proyecto aparte,
`/home/rebe/ia-microservice2/` (FastAPI). Lo que hay en
`chunkInterface/media_ingestion_service/` es solo la copia de referencia
mencionada en la sección 1.

### Cambios que hice en `ia-microservice2/`

| Cambio | Archivo | Por qué |
|---|---|---|
| Venv roto → recreado + deps instaladas | `venv/` | Le faltaban `python`/`pip`/`uvicorn` |
| Typo en `.env` | `.env` | `VERTEX_LOCATION` → `VERTEX_AI_LOCATION` (así lo espera `app/core/config.py`) |
| CORS agregado | `app/main.py` | No existía `CORSMiddleware`. Permite `http://localhost:5173` y `http://127.0.0.1:5173` |
| **Endpoint** `GET /api/v1/upload/{video_id}/status` | `upload/status.py` (nuevo) + wiring en `schemas.py`/`router.py` | Busca el objeto en GCS bajo `raw/{video_id}/`; si existe, genera signed URL v4 (1h) y responde `ready`; si no, `processing` |
| **Endpoint** `POST /api/v1/upload/from-url` | `upload/youtube.py` (nuevo) + wiring en `schemas.py`/`router.py` | Solo para `source: "youtube"` — descarga con `yt-dlp` (subprocess, formato `mp4/bestvideo+bestaudio/best`) a un temp dir y sube a GCS con el mismo patrón `raw/{video_id}/{filename}`. Estado del job en memoria (`_job_errors`), consultado por `/status` |

Lo que **no toqué**: `requirements.txt`, `Dockerfile`, los endpoints de
audio/texto/imagen/documento/rúbrica, y todo el pipeline `video_v2/` (ya
existía, ver sección 7).

### Endpoints completos

| Endpoint | Estado | Uso |
|---|---|---|
| `POST /api/v1/upload/local-session` | Ya existía | Los 4 orígenes que suben bytes |
| `PUT {upload_session_url}` | GCS directo, sin backend de por medio | Idem |
| `GET /api/v1/upload/{video_id}/status` | Implementado | Los 5 orígenes hacen polling aquí hasta `ready` |
| `POST /api/v1/upload/from-url` | Implementado | Solo YouTube — descarga vía `yt-dlp` |
| `POST /api/v2/video/iniciar-analisis` | Ya existía (pipeline video_v2) | `AnalysisPanel` |
| `GET /api/v2/video/analisis/{video_id}` | Ya existía (pipeline video_v2) | Polling de `AnalysisPanel` |

### Limitación conocida de YouTube

En pruebas, la descarga con `yt-dlp` falló consistentemente con
`HTTP 429: Too Many Requests` / "Sign in to confirm you're not a bot" —
bloqueo anti-bot de YouTube a la IP del servidor, no un bug del código
(el plumbing completo — encolar, job en background, `/status` reportando
el error real — se verificó funcional). Actualizar `yt-dlp` no lo resolvió.
La única salida real es usar cookies de una sesión real de YouTube
(`--cookies-from-browser`), no implementado por el riesgo de atar una cuenta
personal a peticiones automatizadas del servidor.

### Estado actual del servidor

```bash
cd /home/rebe/ia-microservice2
./venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

---

## 9. Variables de entorno (`.env`)

```bash
VITE_API_BASE_URL=http://127.0.0.1:8000

# Google Drive picker
VITE_GOOGLE_CLIENT_ID=       # Cloud Console → OAuth Client ID (Web application)
VITE_GOOGLE_API_KEY=         # Cloud Console → API key (restringida a Picker API + Drive API)
VITE_GOOGLE_APP_ID=          # Cloud Console → página principal → "Project number" (NO el Client ID)

# Dropbox Chooser
VITE_DROPBOX_APP_KEY=        # Dropbox App Console → App key

# OneDrive picker v8
VITE_MS_CLIENT_ID=           # Azure AD → App registration → plataforma "Single-page application"

# Análisis rubricado (v1, sin uso actualmente — analysisApiV2 no necesita configuración)
VITE_ANALYSIS_PROVIDER=
VITE_ANALYSIS_MODEL=
```

Requisitos de configuración externa por proveedor:
- **Google**: habilitar "Google Picker API" **y** "Google Drive API" (dos APIs separadas) en el mismo proyecto de Cloud.
- **Dropbox**: agregar `localhost` en "Chooser / Saver / Embedder domains" del App Console.
- **Azure/OneDrive**: registrar `http://localhost:5173` como redirect URI bajo plataforma "Single-page application".

---

## 10. Cómo correr todo

```bash
# Backend (repo aparte)
cd /home/rebe/ia-microservice2
./venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload

# Frontend (este repo)
cd /home/rebe/chunkInterface
npm install
npm run dev   # http://localhost:5173
```

Verificación de tipos: `npx tsc --noEmit` (sin errores al momento de escribir esto).

Logs de la app en tiempo real: consola del navegador (F12 → Console), no la
terminal de `npm run dev` — ahí solo se ve el log propio de Vite.
