export {}

// Los SDKs de Google, OneDrive y Dropbox se cargan en runtime vía <script>
// (ver src/utils/loadScript.ts y los providers), no como paquetes npm con
// tipos propios — se declaran como `any` a propósito.
declare global {
  interface Window {
    gapi: any
    google: any
    OneDrive: any
    Dropbox: any
  }
}
