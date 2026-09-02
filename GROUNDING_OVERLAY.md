# Overlay de coordenadas visuales sobre un video — guía completa

Este documento explica, de cero, cómo funciona el sistema que dibuja
cuadros y banners de texto sincronizados sobre un `<video>`, a partir de
un JSON generado por un pipeline externo de IA (fuera de este repo). Está
escrito para que lo pueda seguir tanto una persona sin contexto previo
como una IA que necesite reimplementar la misma funcionalidad en otra
interfaz (otro framework, otro lenguaje, otro stack).

La implementación de referencia vive en un solo archivo:
[`src/components/CoordenadasPanel.tsx`](src/components/CoordenadasPanel.tsx)
(React + TypeScript), con sus estilos en
[`src/App.css`](src/App.css) (clases `.coordenadas-*`). Pero **la lógica
que importa no depende de React** — es aplicable a cualquier UI que
pueda: leer un archivo, escuchar eventos de un reproductor de video, y
dibujar rectángulos posicionados con precisión sobre él.

---

## 1. Qué problema resuelve, en una frase

Un script de Python (fuera de este repo) analiza un video y produce un
JSON que dice, para distintos tramos de tiempo, **qué se ve y dónde** —
por ejemplo "de 3s a 6s, hay manos moviéndose en esta zona del frame".
Este sistema toma ese JSON y, mientras el video se reproduce, dibuja un
cuadro sobre la zona indicada, apareciendo y desapareciendo exactamente
cuando corresponde. Es una herramienta de **inspección visual** — para
un humano poder verificar "¿el modelo detectó bien lo que dice haber
detectado?" — no es una feature pulida para usuario final.

---

## 2. Los dos tipos de cosas que dibuja

| Tipo | Tiene posición (bbox) | Cómo se ve |
|---|---|---|
| **Evento corporal** (`EventoCuerpo`) | Sí | Un cuadro con borde de color sobre la zona exacta del video, con una etiqueta arriba (categoría + descripción corta) |
| **Evento de entorno/foco** (`EventoEntorno`) | No — solo tiene una ventana de tiempo, no una posición | Una franja de texto fija arriba del video (no puede ser un cuadro porque no hay coordenadas) |

Ambos aparecen y desaparecen solos, sincronizados con el tiempo actual
del video (`currentTime`).

---

## 3. El JSON de entrada — forma exacta

Lo produce un pipeline externo. Ejemplo real (simplificado):

```json
{
  "video_id": "paso1venta",
  "visual_moments": [
    {
      "id": "vis_0042",
      "sujeto_id": "1",
      "descripcion": "El hombre gira el cuerpo hacia la mesa, mueve las manos y agarra una manzana.",
      "es_sujeto_principal": true,

      "cambio_entorno": "La cámara pasa de un plano cerrado a uno abierto de la cocina",
      "descripcion_foco": "El plato de comida en el centro de la mesa",
      "inicio": 140.0,
      "fin": 145.8,

      "desglose_corporal": {
        "momento_visual_id": "vis_0042",
        "senalamiento_objeto": null,
        "movimiento_manos": {
          "descripcion": "mueve las manos y agarra la manzana",
          "bbox": { "x1": 0.55, "y1": 0.42, "x2": 0.71, "y2": 0.6 },
          "frame_w": 854,
          "frame_h": 480,
          "t_start": 144.1,
          "t_end": 145.8,
          "confidence": 0.81
        },
        "movimiento_cabeza": null,
        "movimiento_ojos": null,
        "movimiento_boca": null,
        "cuerpo_completo": {
          "descripcion": "gira el cuerpo hacia la mesa",
          "bbox": { "x1": 0.22, "y1": 0.1, "x2": 0.78, "y2": 0.95 },
          "frame_w": 854,
          "frame_h": 480,
          "t_start": 142.6,
          "t_end": 144.1,
          "confidence": 0.88
        },
        "otro": null
      }
    }
  ]
}
```

Desglosado:

- **Nivel raíz**: `{ "visual_moments": [ ...momentos ] }`. Cada elemento
  del array es un "momento visual" — un tramo del video que el pipeline
  identificó como relevante.
- **Cada momento** tiene:
  - `id` (string, obligatorio) — identificador único.
  - `descripcion` — resumen largo de todo lo que pasa en ese momento
    (no se muestra en los cuadros, solo internamente).
  - `cambio_entorno` / `descripcion_foco` (opcionales, strings) + `inicio`/`fin`
    (números, segundos) — dan pie al **banner de texto**. Al menos uno de
    los dos strings debe venir no-vacío para generar un banner.
  - `desglose_corporal` (objeto opcional) — hasta **7 slots fijos**, uno
    por categoría corporal: `senalamiento_objeto`, `movimiento_manos`,
    `movimiento_cabeza`, `movimiento_ojos`, `movimiento_boca`,
    `cuerpo_completo`, `otro`. Cada slot es **`null`** (esa categoría no
    se detectó en este momento) o un objeto con:
    - `bbox`: `{ x1, y1, x2, y2 }` — coordenadas normalizadas 0-1 (ver
      sección 4).
    - `frame_w`, `frame_h` — tamaño en píxeles del frame que el script
      analizó para sacar ese bbox.
    - `t_start`, `t_end` — la ventana de tiempo de **ese slot puntual**,
      que puede ser distinta a la de otros slots del mismo momento (dos
      categorías del mismo `id` no necesariamente comparten ventana).
    - `confidence` (opcional, 0-1) — qué tan seguro está el modelo.

**Importante**: no todo lo que llega en el JSON es válido o está
completo. El parser tiene que tolerar slots `null`, campos faltantes,
tipos incorrectos, momentos sin ningún slot detectado, etc. — sin nunca
romper la interfaz (ver sección 7).

---

## 4. Conceptos que hay que entender antes de tocar código

### 4.1 Bbox normalizado

`x1, y1, x2, y2` NO son píxeles — son fracciones de 0 a 1 relativas al
ancho/alto del **frame que analizó el script** (`frame_w`, `frame_h`).
`x1=0.22` significa "empieza al 22% del ancho del frame", sin importar
si ese frame medía 854px o 3840px. Esto es deliberado: así el mismo bbox
sirve sin importar en qué resolución esté corriendo el video en pantalla.

### 4.2 El frame analizado ≠ el video en pantalla

El script de Python probablemente extrajo un frame a una resolución
propia (ej. 854×480) que **no tiene por qué coincidir** con la
resolución real del archivo de video, ni mucho menos con el tamaño en
píxeles que el `<video>` ocupa en la pantalla del usuario (que cambia
según el ancho de la ventana, el zoom, el dispositivo, etc.). Por eso
cada bbox viaja siempre junto a `frame_w`/`frame_h` — son la referencia
necesaria para poder convertir "22% del frame" a "tal píxel de la
pantalla".

### 4.3 Letterboxing (por qué no alcanza con una regla de tres simple)

Si la proporción del frame analizado (`frame_w / frame_h`) no coincide
exactamente con la proporción del elemento `<video>` en pantalla, hay
que evitar "estirar" el bbox de forma desproporcionada. La técnica
estándar es la misma que usa CSS `object-fit: contain`:

1. Escalar el frame completo lo más grande posible sin que se corte
   (eligiendo el menor de los dos factores de escala posibles: por
   ancho o por alto).
2. Centrar ese frame escalado dentro del espacio disponible — sobra
   espacio a los costados o arriba/abajo (las "barras negras" o
   *letterbox*), y eso hay que compensarlo con un offset antes de
   ubicar el cuadro.

Si el `<video>` en pantalla ya tiene exactamente la misma proporción que
el frame (o no usa letterboxing porque mantiene su aspect ratio
naturalmente), la fórmula igual funciona: el offset simplemente da ~0.
Por eso conviene implementar siempre la versión completa, no una
simplificada — es segura en ambos casos.

### 4.4 Coordenadas de viewport vs. coordenadas del elemento

Para dibujar un cuadro "encima" del `<video>` sin tener que modificar el
árbol de componentes/DOM donde vive el `<video>`, la técnica usada acá
es:

1. Preguntarle al navegador dónde está el `<video>` **en este instante**,
   en coordenadas de ventana (`getBoundingClientRect()` en la web: da
   `top`, `left`, `width`, `height` relativos al viewport).
2. Dibujar los cuadros como elementos posicionados en modo "fijo al
   viewport" (`position: fixed` en CSS web), usando esas mismas
   coordenadas — así calzan perfecto encima del video sin necesitar
   que el cuadro sea hijo del `<video>` en el árbol de UI.
3. Recalcular ese rectángulo cada vez que el tamaño o la posición del
   `<video>` puede haber cambiado: al cargar metadata, al hacer resize
   de ventana, al hacer scroll de la página, y cuando el propio elemento
   cambia de tamaño (`ResizeObserver` en la web).

Esto es el patrón general para "dibujar algo encima de un elemento
ajeno sin tocar su implementación" — aplica en cualquier UI framework
que exponga el equivalente a "posición absoluta en pantalla de este
elemento" y "avisame si esa posición cambió".

---

## 5. Arquitectura: 4 responsabilidades separadas

```
┌─────────────────────────────────────────────────────────────┐
│ 1. CARGA Y VALIDACIÓN                                         │
│    Archivo JSON (elegido a mano por el usuario, sin backend)  │
│    → parsear → validar shape → aplanar a listas de "eventos"  │
├─────────────────────────────────────────────────────────────┤
│ 2. SINCRONIZACIÓN TEMPORAL                                    │
│    Escuchar el tiempo actual del reproductor                  │
│    → filtrar qué eventos están "activos ahora"                │
│    → aplicar límite de simultáneos + fade in/out               │
├─────────────────────────────────────────────────────────────┤
│ 3. SEGUIMIENTO DE POSICIÓN                                     │
│    Medir dónde está el reproductor en pantalla                │
│    → recalcular en resize/scroll/cambio de tamaño              │
├─────────────────────────────────────────────────────────────┤
│ 4. CONVERSIÓN DE COORDENADAS + RENDER                          │
│    bbox normalizado + posición del reproductor                │
│    → rectángulo en píxeles de pantalla → dibujar                │
└─────────────────────────────────────────────────────────────┘
```

Estas 4 piezas son independientes entre sí — se pueden reimplementar
cada una en el lenguaje/framework que corresponda sin que las demás
cambien de forma.

---

## 6. El algoritmo, paso a paso

### 6.1 Parsear y validar el JSON

Pseudocódigo (agnóstico de lenguaje):

```
function parseGroundingJson(raw):
    si raw no es un objeto → error "El JSON no es un objeto"

    lista = raw.visual_moments
    si lista no es un array → error 'Falta el array "visual_moments"'

    # Detección de versión vieja del formato (ver sección 7.1)
    si ningún item tiene "desglose_corporal" pero alguno tiene
       "evidencia_espacial" (el campo del formato anterior):
        → error "Este JSON es de un formato viejo, regenéralo"

    eventos = []       # cuadros con bbox
    entornos = []      # banners de texto sin bbox
    momentos_sin_nada = 0

    para cada item en lista:
        si item no es objeto o no tiene "id" string → saltar

        # --- Banner de entorno/foco (independiente del bbox) ---
        si (item.cambio_entorno o item.descripcion_foco) no vacíos
           y item.inicio/item.fin son números válidos (fin > inicio):
            entornos.push({ id, t_start: inicio, t_end: fin,
                             cambioEntorno, descripcionFoco })

        # --- Cuadros corporales ---
        desglose = item.desglose_corporal
        si desglose no es un objeto → momentos_sin_nada += 1; continuar

        encontró_alguno = false
        para cada categoria en [7 categorías fijas]:
            slot = desglose[categoria]
            si slot no es objeto → saltar esta categoría
            si slot.bbox / frame_w / frame_h / t_start / t_end
               no son válidos (números finitos, frame_w>0, frame_h>0,
               t_end >= t_start) → saltar esta categoría

            eventos.push({
                eventId: item.id + ":" + categoria,   # único
                momentoId: item.id,
                categoria,
                descripcion: slot.descripcion o "(sin descripción)",
                bbox: slot.bbox,
                frame_w, frame_h, t_start, t_end,
                confidence: slot.confidence (opcional)
            })
            encontró_alguno = true

        si no encontró_alguno → momentos_sin_nada += 1

    si eventos está vacío y entornos está vacío →
        error "no se encontró contenido válido"

    devolver { eventos, entornos, momentos_sin_nada, error: null }
```

Puntos clave de robustez:
- **Nunca asumir que un campo existe** — todo objeto intermedio (`item`,
  `desglose`, `slot`, `bbox`) se valida antes de leer sus propiedades.
- Un slot inválido o `null` se **descarta silenciosamente**, no aborta
  el parseo completo.
- Solo se corta todo el proceso con un error visible cuando **no queda
  nada útil** para mostrar, o cuando se detecta que el JSON es de un
  formato completamente distinto al esperado (ver 7.1).

### 6.2 "Aplanar" — por qué cada momento se convierte en 0-7 eventos

El JSON anida los bboxes dentro de `desglose_corporal`, con hasta 7
slots por momento. Para la lógica de sincronización/dibujo conviene
trabajar con una **lista plana de "eventos"**, cada uno con su propio
`t_start`/`t_end` — porque dos categorías del mismo momento pueden tener
ventanas de tiempo totalmente distintas (en el ejemplo de la sección 3,
`movimiento_manos` va de 144.1s a 145.8s, pero `cuerpo_completo` va de
142.6s a 144.1s — **no se solapan**). Si se tratara el momento como una
sola unidad, se perdería esa granularidad y ambos cuadros aparecerían/
desaparecerían juntos, lo cual sería incorrecto.

Cada evento aplanado necesita un **id único** — acá se arma como
`"{id_del_momento}:{categoria}"` (ej. `"vis_0042:movimiento_manos"`) —
para poder trackearlo individualmente durante el fade in/out (sección
6.4) y como `key` en el render.

### 6.3 Sincronización temporal (qué mostrar en cada instante)

Cada vez que el tiempo del video cambia (evento nativo `timeupdate`, y
también `seeked` para el caso de que el usuario salte de posición sin
que dispare `timeupdate` a tiempo):

```
t = video.currentTime

activos = eventos.filter(ev => t >= ev.t_start AND t <= ev.t_end)
```

Ese filtro es intencionalmente simple: solo compara el tiempo actual
contra el rango del evento. No hay tolerancia/margen — un evento
"aparece" en el frame exacto donde arranca su ventana.

`timeupdate` en un `<video>` HTML nativo dispara con una frecuencia
limitada (unas pocas veces por segundo, no en cada frame) — suficiente
para esta herramienta de inspección, no para un uso frame-perfect.

### 6.4 Límite de eventos simultáneos

Si en un instante dado hay más de **3** eventos activos a la vez (varias
categorías/momentos superpuestos), se recorta a los 3 de mayor
`confidence` y se loguea cuántos quedaron ocultos — para no saturar la
pantalla de cuadros:

```
si activos.length > 3:
    activos = ordenar_por_confidence_descendente(activos).slice(0, 3)
    log("N eventos ocultos por límite de 3 simultáneos en t=...")
```

Es un tope simple, no una heurística sofisticada de layout — el
objetivo es legibilidad para un humano inspeccionando, no cobertura
completa.

### 6.5 Fade in / fade out

Un evento no debería aparecer/desaparecer de golpe. La técnica:

- Se mantiene un mapa `mostrados: { eventId → { evento, activo: bool } }`.
- Cuando un evento pasa a estar "activo" (dentro de su ventana de
  tiempo), se agrega/actualiza en el mapa con `activo = true`.
- Cuando un evento que estaba en el mapa deja de estar activo, **no se
  borra al instante** — se marca `activo = false` (lo que dispara, vía
  CSS, una transición de opacidad de "visible" a "invisible" durante
  ~300ms) y recién después de ese tiempo se elimina del mapa.
- Si un evento vuelve a activarse mientras todavía estaba "desvaneciendo"
  (por ejemplo el usuario retrocedió el video), se cancela ese timer de
  desaparición y vuelve a `activo = true` sin saltos raros.

Esto requiere que el elemento visual siga existiendo en el árbol de UI
durante el fade-out (no se puede desmontar de inmediato), y que el
cambio de opacidad esté gobernado por una transición CSS (o el
equivalente de animación en el framework de destino) en vez de un
salto instantáneo.

### 6.6 Conversión de coordenadas — la fórmula exacta

Dado:
- `bbox = {x1, y1, x2, y2}` (normalizados 0-1, relativos al frame)
- `frame_w`, `frame_h` (tamaño del frame que analizó el script)
- `videoRect = {left, top, width, height}` (posición/tamaño actual del
  `<video>` en pantalla, en coordenadas de viewport)

```
scale   = min(videoRect.width / frame_w, videoRect.height / frame_h)
offsetX = (videoRect.width  - frame_w * scale) / 2
offsetY = (videoRect.height - frame_h * scale) / 2

left   = videoRect.left + offsetX + bbox.x1 * frame_w * scale
top    = videoRect.top  + offsetY + bbox.y1 * frame_h * scale
width  = (bbox.x2 - bbox.x1) * frame_w * scale
height = (bbox.y2 - bbox.y1) * frame_h * scale
```

**Ejemplo numérico concreto** (usando el `movimiento_manos` de la
sección 3):

```
bbox = { x1: 0.55, y1: 0.42, x2: 0.71, y2: 0.60 }
frame_w = 854, frame_h = 480

Supongamos que el <video> en pantalla mide 1280×720px,
y está pegado arriba a la izquierda de la ventana: videoRect = { left: 0, top: 100, width: 1280, height: 720 }

scale = min(1280/854, 720/480) = min(1.499, 1.5) = 1.499
offsetX = (1280 - 854*1.499) / 2 ≈ (1280 - 1279.9) / 2 ≈ 0.05
offsetY = (720  - 480*1.499) / 2 ≈ (720  - 719.5) / 2 ≈ 0.25

left   = 0   + 0.05 + 0.55*854*1.499 ≈ 704.0px
top    = 100 + 0.25 + 0.42*480*1.499 ≈ 402.4px
width  = (0.71-0.55)*854*1.499 ≈ 204.8px
height = (0.60-0.42)*480*1.499 ≈ 129.5px
```

→ el cuadro se dibuja en `left: 704px, top: 402px, width: 205px, height: 130px` de la ventana del navegador, mientras `t_start <= currentTime <= t_end`.

### 6.7 Mantener `videoRect` actualizado

`videoRect` no se calcula una sola vez — el tamaño/posición del
`<video>` puede cambiar por: la ventana se redimensiona, la página hace
scroll, el layout cambia por cualquier motivo (responsive, sidebar que
se abre, etc.), o el propio video carga sus metadata y ajusta su alto.
Por eso hay que recalcularlo en todos esos disparadores — no alcanza
con medirlo una sola vez al montar el componente.

---

## 7. Casos raros que hay que contemplar (para no romper la UI)

### 7.1 Formato viejo del JSON

Este pipeline tuvo una versión anterior donde cada momento tenía un
único bbox directo (`evidencia_espacial`) en vez de los 7 slots de
`desglose_corporal`. Si alguien carga sin querer un JSON de esa versión
vieja, **no debe fallar en silencio ni mostrar "0 eventos" sin
explicación** — hay que detectarlo explícitamente (mirando si el shape
coincide con el formato viejo) y mostrar un mensaje claro pidiendo
regenerar el archivo con el pipeline actualizado.

### 7.2 Slot con datos incompletos o de tipo incorrecto

Cualquier slot cuyo `bbox`, `frame_w`, `frame_h`, `t_start` o `t_end`
falte, no sea numérico, o sea geométricamente inválido (`frame_w <= 0`,
`t_end < t_start`, etc.) se descarta — no se dibuja, no se cuenta como
error fatal, solo se resta de la cuenta de "eventos encontrados".

### 7.3 Momento sin nada que mostrar

Si los 7 slots de `desglose_corporal` son `null` (o el campo falta
directamente) **y** tampoco hay `cambio_entorno`/`descripcion_foco`
válidos, ese momento simplemente no genera nada visual — se cuenta
aparte (para poder loguear "N momentos sin contenido detectado") pero
no bloquea el resto.

### 7.4 JSON válido pero completamente vacío de contenido útil

Si tras procesar todo el array no se juntó ni un solo evento con bbox
ni un solo banner de entorno, ahí sí se considera un error a mostrar en
la interfaz (distinto del error de "formato viejo" — este es más
genérico: "no se encontró contenido válido").

### 7.5 El reproductor de video todavía no existe

Si el componente que dibuja overlays intenta engancharse al
reproductor antes de que este exista en la pantalla (por ejemplo el
video todavía no terminó de subir), hay que esperar sin fallar —
simplemente no hacer nada hasta que el reproductor esté disponible.

---

## 8. Checklist para reimplementar esto en otra interfaz/stack

1. **Definí los tipos de datos**: un "evento con posición" (bbox +
   frame_w/h + t_start/t_end + categoria + confidence opcional) y un
   "evento sin posición" (solo texto + t_start/t_end).
2. **Escribí el parser/validador** del JSON tal como en 6.1 — tolerante
   a campos faltantes/inválidos, con detección explícita del formato
   viejo (7.1) y de "no hay nada que mostrar" (7.4).
3. **Enganchate a los eventos de tiempo** del reproductor de video que
   uses (`timeupdate`/`seeked` en HTML5 `<video>`, o el equivalente en
   el player que corresponda) y filtrá eventos activos con la
   comparación simple de 6.3.
4. **Aplicá el tope de simultáneos** (6.4) y el **fade in/out** (6.5) —
   ambos son independientes del resto de la lógica, se pueden portar
   tal cual.
5. **Medí la posición del reproductor en pantalla** (equivalente a
   `getBoundingClientRect`) y recalculala en resize/scroll/cambios de
   layout (6.7).
6. **Aplicá la fórmula de conversión de coordenadas** de 6.6 exactamente
   como está — es la parte más fácil de romper si se simplifica de más
   (ver 4.3 sobre por qué no alcanza una regla de tres simple).
7. **Dibujá el rectángulo** con la posición/tamaño resultante, usando
   el mecanismo de "capa flotante encima de otro elemento sin tocar su
   DOM/árbol" que ofrezca tu framework (en la web: `position: fixed` +
   coordenadas de viewport; en otros stacks, el equivalente — un
   "overlay layer" con z-index alto y sin capturar eventos de puntero,
   para no bloquear los controles nativos del video).
8. **Dale un color consistente por categoría** y una etiqueta con
   nombre de categoría + descripción corta — no la descripción larga
   del momento completo.
9. **Marcá visualmente la confianza baja** (< 0.5) con algún indicador
   claro (ej. borde punteado + opacidad reducida) sin ocultar el color
   de categoría.

---

## 9. Resumen de una línea por cada pieza

- **Input**: JSON externo con momentos → cada uno puede aportar 0-7
  "eventos con posición" (uno por categoría corporal) y 0-1 "evento sin
  posición" (banner de entorno/foco).
- **Validación**: tolerante, nunca rompe la UI, pero avisa claro cuando
  el JSON es del formato viejo o no tiene nada útil.
- **Sincronización**: en cada tick de tiempo del video, filtrar por
  `t_start <= currentTime <= t_end`, topear a 3 simultáneos por
  confidence, loguear los ocultos.
- **Fade**: los elementos no se montan/desmontan de golpe — se marcan
  inactivos y se quitan recién tras la transición CSS.
- **Posición**: se mide el rectángulo real del `<video>` en pantalla y
  se mantiene actualizado ante cualquier cambio de layout.
- **Conversión**: bbox normalizado (0-1, relativo al frame analizado)
  → píxeles de pantalla, con la misma matemática que `object-fit:
  contain` para no deformar ni desalinear el cuadro.
