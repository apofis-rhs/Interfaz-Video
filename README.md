# chunkInterface — interfaz de subida y análisis de video

Frontend standalone (React + Vite + TypeScript) para subir un video desde 5
orígenes — **Local, Google Drive, OneDrive, Dropbox, YouTube** —, mostrarlo en
un `<video>` grande al terminar, y disparar un análisis rubricado con IA sobre
ese video (pipeline v3, con tabs de Score/Transcripción/Momentos visuales —
ver sección 7), además de un overlay opcional de coordenadas visuales sobre
el propio `<video>` (ver [GROUNDING_OVERLAY.md](GROUNDING_OVERLAY.md)). Sin
chunking del lado del cliente: se sube el archivo completo en una sola
operación (con streaming pipe para los proveedores externos, ver sección 6).

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
CoordenadasPanel → (opcional) cargar JSON de coordenadas → cuadros/banners dibujados
                    sobre el <video> en vivo (ver GROUNDING_OVERLAY.md, sin backend)

AnalysisPanel  →  adjuntar JSON de rúbrica → POST /api/v3/video/iniciar-analisis {video_id, rubric}
                                          poll GET /api/v3/video/analisis/{video_id}  (cada 3s)
                                                     │
                                          status: done → tab "Score": árbol de criterios + score total
                                                          tab "Transcripción": GET /api/v3/video/{id}/transcripcion
                                                          tab "Momentos visuales": GET /api/v3/video/{id}/momentos-visuales
              →  alternativa sin backend: cargar una carpeta de corrida ya
                 calificada (evaluation_tree.json + visuals.json +
                 transcripcion_es.json) y ver los 3 tabs sin disparar nada
```

Estados de subida (`UploadPhase`): `idle → selecting → uploading → processing → ready | error`
(`selecting` solo para Drive/OneDrive/Dropbox, mientras el usuario hace login/elige archivo en el picker nativo — Local y YouTube saltan directo a `uploading`).
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
    │   ├── analysisApiV2.ts      # v2 del análisis (/api/v2/video/...) — reemplazada por v3, sin uso, se dejó a propósito
    │   ├── analysisApiV3.ts      # v3 del análisis (/api/v3/video/...) — la que realmente usa AnalysisPanel (ver sección 7)
    │   ├── rawContentApiV3.ts    # GET .../transcripcion y .../momentos-visuales (tabs de TranscriptView/VisualMomentsView)
    │   └── offlineResultsV3.ts   # Arma un resultado v3 completo a partir de 3 JSON de una corrida ya calificada (sin backend)
    │
    ├── hooks/
    │   ├── useVideoUpload.ts     # Máquina de estados de subida (ver sección 4)
    │   └── useVideoAnalysis.ts   # Máquina de estados del análisis v3 (ver sección 7)
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
    │   ├── videoContentType.ts    # Content-types permitidos + inferencia por extensión
    │   └── formatTimestamp.ts     # segundos ↔ "MM:SS"/"H:MM:SS", usado por transcripción/momentos visuales/evidencia
    │
    └── components/
        ├── SourcePicker.tsx        # Los 5 botones de origen
        ├── UrlSourceModal.tsx      # Modal "pegar URL" (hoy solo lo usa YouTube)
        ├── StatusBanner.tsx        # Subiendo/Procesando/Listo/Error + barra de progreso + tiempo total
        ├── VideoPlayer.tsx         # <video controls autoPlay> cuando status === "ready"
        ├── CoordenadasPanel.tsx    # Overlay de cuadros/banners sobre el <video> a partir de un JSON aparte (ver GROUNDING_OVERLAY.md)
        ├── AnalysisPanel.tsx       # Adjuntar rúbrica JSON + disparar/mostrar el análisis v3, con 3 tabs (ver sección 7)
        ├── TranscriptView.tsx      # Tab "Transcripción" (en vivo o desde carga offline)
        └── VisualMomentsView.tsx   # Tab "Momentos visuales" (en vivo o desde carga offline)
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

`phase` (`UploadPhase`) pasa por `idle → selecting → uploading → processing →
ready | error`. `selecting` es exclusiva de Drive/OneDrive/Dropbox — cubre el
tiempo de login + elegir archivo en el picker nativo del proveedor, que
controla el usuario, no la red; por eso `startedAt`/`elapsedMs` arrancan
recién al entrar a `uploading` (ver comentario en `uploadToGcs`), y no
incluyen ese tiempo. Local y YouTube no tienen picker externo que esperar,
así que saltan directo de `idle` a `uploading`.

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
2. **"Empezar análisis"** — deshabilitado hasta que haya rúbrica adjunta (o
   si hay un resultado offline cargado, ver 7.2). Llama a
   `POST /api/v3/video/iniciar-analisis { video_id, rubric }`.

Después hace polling cada 3s a `GET /api/v3/video/analisis/{video_id}` hasta
`done` (guarda `resultado.evaluation_tree`, ver 7.1) o `error`/`not_found`
(terminal, con botón de reintento).

**Importante sobre el pipeline v3**: el backend detrás de estos endpoints
(`app/services/video_v3/`, en `ia-microservice2`) reemplazó al pipeline v2
(chunking + análisis multimodal por chunk + scoring + consolidación).
Registro de estado del análisis: en memoria en el proceso del backend, se
pierde si el backend se reinicia — por eso `not_found` se trata como error
terminal en el frontend, no como algo para reintentar el polling.

Quedaron como código muerto, sin usarlos ningún componente hoy (se dejaron
sin borrar a propósito, como referencia de contratos anteriores):
`src/api/analysisApi.ts` (v1, `/api/v1/video/evaluations/links`) y
`src/api/analysisApiV2.ts` (v2, `/api/v2/video/...`, reemplazada por v3 —
ver el comentario al tope de `analysisApiV3.ts` para el diff de contrato
exacto entre ambas).

### 7.1 El árbol de criterios (`FinalEvaluationTreeV3`)

A diferencia de v2, v3 mezcla escalas en el mismo árbol (`formatScore` en
`AnalysisPanel.tsx`):

- Hojas `type_criteria: "primary"` puntúan `0-10` (`score`, con `nivel`:
  `EXC | BUE | REG | BAJ | NULO`).
- Nodos intermedios y raíces puntúan `0-100`.
- Hojas `type_criteria: "secondary"` no tienen `score` numérico — solo
  `detected` (booleano, se muestra como "✓ Detectado" / "✗ No detectado").

Cada nodo trae su evidencia en **dos listas separadas por modalidad**
(nunca una sola lista mixta): `evidencia_visual` (con `chunk_number`, `id`,
`inicio`/`fin` en segundos ya resueltos, `explicación`) y
`evidencia_auditiva` (además `cita_textual`, `palabra_exacta` opcional,
`longitud_evidencia: 'seccion' | 'momento' | 'palabra'`). Cada línea de
evidencia en la tabla tiene un botón con el rango de tiempo que hace
`onSeek(inicio)` — mueve el `<video>` real (montado en `VideoPlayer`, vía la
`ref` que `App.tsx` puentea hacia `AnalysisPanel`/`CoordenadasPanel`) a ese
punto y lo reproduce.

### 7.2 Los 3 tabs: Score / Transcripción / Momentos visuales

`GET /api/v3/video/analisis/{video_id}` no devuelve el árbol directo — el
`status.resultado` es un `VideoV3Result` completo (`transcript` + `subjects`
+ `momentos_visuales` + `evaluation_tree` + `merged_timeline` +
`time_elapsed_seconds`); `useVideoAnalysis` solo guarda `evaluation_tree`
para el tab **Score**. Los otros dos tabs piden sus propios datos, en vivo,
por endpoints aparte (`rawContentApiV3.ts`):

- **Transcripción** (`TranscriptView.tsx`) → `GET /api/v3/video/{id}/transcripcion`.
  Timestamps como string `"MM:SS"` (`parseTimestampToSeconds` los convierte
  para el botón de seek).
- **Momentos visuales** (`VisualMomentsView.tsx`) → `GET /api/v3/video/{id}/momentos-visuales`.
  Timestamps ya en segundos (número). **No es el mismo formato que
  transcripción** — no asumir uno por el otro.

Ambos tabs tienen su propio botón "Actualizar" (no dependen del polling del
tab Score) y toleran "todavía no hay nada" sin romperse mientras el análisis
sigue corriendo.

### 7.3 Cargar un resultado ya calificado, sin backend (`offlineResultsV3.ts`)

Debajo de los dos botones de rúbrica hay un tercer selector, **"Cargar
carpeta de resultado ya calificado"** (`multiple`, acepta varios `.json` a
la vez): sirve para revisar sin volver a analizar un video que ya se corrió
antes con `video_v3/test.py` en el backend. Se identifican por *substring*
del nombre de archivo (no por orden de selección) los 3 que hacen falta de
esa carpeta —`evaluation_tree.json`, `visuals.json`, `transcripcion_es.json`
— y se ignora cualquier otro archivo que venga junto (ej.
`transcription.json`, `resumen.json`). `buildOfflineResult` cruza los 3 (los
IDs de evidencia en `evaluation_tree.json` son solo referencias sin
inicio/fin; hay que resolverlos contra `visuals.json`/`transcripcion_es.json`
por `id`, mismo trabajo que en producción hace `tree_reconstruction.py` del
lado del backend) y arma el mismo shape que ya consumen los 3 tabs cuando
vienen del backend en vivo — mientras haya un resultado offline cargado,
reemplaza al análisis en vivo en los 3 tabs sin tocar el video ni disparar
ningún análisis nuevo (mismo criterio client-side que ya usa
`CoordenadasPanel.tsx` con su propio JSON). Un botón "Quitar resultado
cargado" vuelve al modo en vivo.

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
| `POST /api/v3/video/iniciar-analisis` | Pipeline `video_v3` (reemplazó a v2) | `AnalysisPanel`, tab Score |
| `GET /api/v3/video/analisis/{video_id}` | Pipeline `video_v3` | Polling del tab Score |
| `GET /api/v3/video/{video_id}/transcripcion` | Pipeline `video_v3` | Tab Transcripción (`TranscriptView`) |
| `GET /api/v3/video/{video_id}/momentos-visuales` | Pipeline `video_v3` | Tab Momentos visuales (`VisualMomentsView`) |

El backend sigue exponiendo `/api/v2/video/...` (pipeline `video_v2`), pero
el frontend ya no lo llama — `analysisApiV2.ts` quedó como código muerto de
referencia (ver sección 7).

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
