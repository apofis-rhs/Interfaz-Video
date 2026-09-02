// Un ReadableStream en vez de un Blob a propósito: permite encadenar la
// descarga del proveedor directo al PUT de subida a GCS (fetch con body
// streaming), en vez de bufferear el archivo completo en memoria antes de
// empezar a subirlo. Para un video de 1-2 horas eso corta el tiempo total
// aproximadamente a la mitad (descarga y subida corren en paralelo en vez
// de una después de la otra).
export interface PickedFile {
  filename: string
  contentType: string
  size: number
  stream: ReadableStream<Uint8Array>
}
