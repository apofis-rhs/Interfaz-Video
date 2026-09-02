# Workflow: de abrir la página a tener el video listo

Este documento explica, paso a paso, qué pasa en el código desde que se
carga `chunkInterface` en el navegador hasta que un video queda subido y
reproducible. Para detalle de arquitectura completa (backend, providers,
streaming, análisis), ver [README.md](README.md).

---

## 1. Se abre la página (`npm run dev` → `localhost:5173`)

1. `index.html` carga `src/main.tsx`, que monta `<App />` con
   `ReactDOM.createRoot`.
2. `App.tsx` corre un `useEffect` al montar que **precarga** los SDKs de
   Google Drive, OneDrive y Dropbox (`preloadGoogleDrive/OneDrive/Dropbox`)
   sin abrir ningún popup todavía.
   - Por qué: el popup de login de cada proveedor tiene que abrirse de
     forma *síncrona* dentro del `onClick` del botón. Si el SDK recién se
     cargara en ese momento (con un `await` de por medio), el navegador
     bloquea el popup por no venir de un gesto de usuario directo.
3. Se renderiza `SourcePicker` con los 5 botones de origen: **Local,
   Google Drive, OneDrive, Dropbox, YouTube**.

En este punto el estado de subida (`useVideoUpload`) está en `idle` — no
hay nada en pantalla más que los botones.

---

## 2. El usuario elige un origen

Todo converge en el mismo hook, `useVideoUpload.ts`, que expone una
máquina de estados (`UploadPhase`):

```
idle → uploading → processing → ready
                 ↘ error (desde cualquier punto)
```

### 2a. Local (`<input type=file>`)
- `startLocalUpload(file)` toma el `File` directo del input.
- No hay red hasta el paso 3 — el archivo ya está en memoria como `Blob`.

### 2b. Google Drive / OneDrive / Dropbox
- `startProviderPick(source)` llama al `pick*()` del provider
  correspondiente (`src/providers/googleDrive.ts`, `oneDrive.ts`,
  `dropbox.ts`).
- Cada uno abre su login/selector nativo (Google Identity Services + 
  Picker, MSAL + OneDrive picker v8, Dropbox Chooser) y, al elegir un
  archivo, **no lo descarga entero a memoria**: devuelve un
  `PickedFile = { filename, contentType, size, stream }` donde `stream`
  es el `ReadableStream` de la respuesta de descarga sin consumir.
  - Esto es lo que permite, en el paso 3, encadenar la descarga del
    proveedor directo a la subida a GCS en paralelo (streaming pipe) en
    vez de esperar la descarga completa antes de subir.

### 2c. YouTube
- Es el único que no baja bytes por el navegador. `SourcePicker` abre
  `UrlSourceModal`, el usuario pega una URL, se valida con una regex
  simple (`sourceValidation.ts`) y dispara `startYoutubeImport(url)`.
- Este camino salta directo al backend (paso 4) — no hay `PickedFile`.

---

## 3. Subida a GCS (`uploadToGcs`, dentro de `useVideoUpload.ts`)

Para Local + los 3 providers, `uploadToGcs(filename, contentType, size, body)`
hace 4 cosas en orden:

1. **Valida/infere el content type** (`resolveVideoContentType`) — tiene
   que resolver a `video/mp4`, `video/quicktime` o `video/webm`, si no,
   pasa a `error`.
2. `POST /upload/local-session` al backend → devuelve
   `{ upload_session_url, gcs_uri, video_id, ... }`. Fase pasa a
   `uploading`.
3. Sube `body` directo a `upload_session_url` (GCS, sin pasar de nuevo
   por el backend):
   - Local usa `XMLHttpRequest` (`uploadBlobWithProgress`) — progreso
     nativo vía `xhr.upload.onprogress`.
   - Los 3 providers usan `fetch` con `duplex: 'half'`
     (`uploadStreamWithProgress`) pasando el `ReadableStream` por un
     `TransformStream` que cuenta bytes para el progreso.
   - `StatusBanner` muestra la barra de progreso en tiempo real con este
     dato.
4. Al terminar el `PUT`, fase pasa a `processing` y arranca el
   **polling**: `GET /upload/{video_id}/status` cada 2s (timeout 10 min).

## 3b. YouTube (camino alterno)

`POST /upload/from-url { source: "youtube", url }` — el backend descarga
el video con `yt-dlp` en background (no hay `PUT` desde el navegador).
Fase pasa directo a `processing` y arranca el mismo polling de
`/status`.

---

## 4. Polling hasta `ready`

- El backend responde `processing` mientras no encuentra el objeto en
  GCS bajo `raw/{video_id}/`.
- Cuando el objeto aparece, genera una **signed URL v4** (1h) y responde
  `ready` con esa `read_url`.
- El hook detecta `ready`, congela `elapsedMs = Date.now() - startedAt`
  (tiempo total de la operación) y guarda `readUrl` + `videoId`.
- Si algo falla en cualquier punto (content-type inválido, error de red,
  timeout, error del backend), fase pasa a `error` con `errorMessage`, y
  `App.tsx` muestra un botón "Intentar de nuevo" que llama a `reset()`.

---

## 5. Video listo → reproducción + análisis

Cuando `phase === 'ready'`:

1. `VideoPlayer` monta un `<video controls autoPlay src={readUrl}>`.
2. `AnalysisPanel` aparece debajo, recibe `videoId`, y permite:
   - Adjuntar un JSON de rúbrica (`{ "rubric": { "id", "criteria": [...] } }`).
   - Disparar `POST /api/v2/video/iniciar-analisis { video_id, rubric }`.
   - Hacer polling cada 3s a `GET /api/v2/video/analisis/{video_id}`
     hasta `done` (tabla de criterios + score) o `error`/`not_found`
     (terminal).

Este segundo flujo (análisis) es independiente del de subida — corre en
su propio hook, `useVideoAnalysis.ts`, con su propia máquina de estados
(`AnalysisPhase`).

---

## Resumen visual

```
[abrir página] → preload SDKs (sin popup) → 5 botones visibles
        │
        ▼
[elegir origen] ──Local──────────────┐
        │                             │ Blob directo
        ├──Drive/OneDrive/Dropbox──┐  │
        │   login + picker nativo  │  │
        │   → ReadableStream       │  │
        │                          ▼  ▼
        │                    uploadToGcs()
        │                    1. content-type
        │                    2. POST /upload/local-session
        │                    3. PUT a GCS (progreso real)
        │                    4. poll GET /status cada 2s
        │                          │
        └──YouTube──────────────► POST /upload/from-url
                                   (yt-dlp en backend)
                                   → poll GET /status cada 2s
                                          │
                                    status: ready
                                          │
                                          ▼
                            <video src={readUrl}> + AnalysisPanel
                                          │
                              (opcional) subir rúbrica JSON
                              → POST /iniciar-analisis
                              → poll GET /analisis/{id} cada 3s
                              → tabla de criterios + score
```

**Dónde mirar los logs**: consola del navegador (F12 → Console, prefijo
`[chunkInterface]`) — no la terminal de `npm run dev`, ahí solo se ve el
log propio de Vite.
