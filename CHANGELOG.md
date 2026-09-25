# Changelog

## [0.1.3] - 2026-09-24

- Los parámetros de las herramientas aplican los límites del contrato público:
  longitud máxima de los textos, formato de cuentas y claves de banco, y topes
  de `limit`. Un valor fuera de rango se rechaza antes de llamar a la API.
- `format` es obligatorio al descargar la plantilla de importación de
  beneficiarios (`downloadBeneficiaryImportTemplate`), como en la API.
- Usa el SDK JavaScript `0.4.6` (contrato público `1.60.0`).

## [0.1.2] - 2026-09-23

Sin cambios en la API. Actualiza documentación y metadatos.

## [0.1.1] - 2026-09-20

Sin cambios de superficie.

## [0.1.0] - 2026-09-20

Primera versión en npm.

- Catálogo de 66 operaciones públicas M2M sobre el SDK JavaScript, importado
  mediante el alias estable `@veriko-mx/sdk-runtime`.
- El SDK se consume desde npm (`npm:@veriko-mx/sdk@0.4.4`) con su integridad en
  el lockfile.
- Perfiles por familia y política de riesgo independiente.
- Idempotencia determinista para operaciones compatibles.
- Descargas como recursos MCP efímeros.
- Transporte local `stdio` sobre el SDK MCP oficial v2.
- Límites binarios verificados extremo a extremo: 12 MB para OCR y 20 MB para
  importaciones, con un buffer stdio de 32 MB.
