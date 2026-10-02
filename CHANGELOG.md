# Changelog

## [No publicado]

- `validateDirect` exige `cuentaBeneficiaria`: la API no la busca entre los beneficiarios
  guardados.
- `validateDirect`, `validateOcr`, `listValidations`, `validationStats` y `exportValidations`
  aceptan `clientRef`, una referencia propia de 1 a 64 caracteres. En las dos primeras vuelve en la
  validación y en los webhooks; en las otras tres filtra por coincidencia exacta.

## [0.1.7] - 2026-09-29

- Usa el SDK JavaScript `0.4.10` (contrato público `1.60.0`): sus tipos documentan los códigos por
  campo del `422` de la validación (`clabe_receptor_mismatch`, `tarjeta_receptor_mismatch` y
  `clave_longitud_invalida`) y aclaran que ningún rechazo `preflight_failed` de esa ruta consume
  cuota.

## [0.1.6] - 2026-09-28

- Usa el SDK JavaScript `0.4.9` (contrato público `1.60.0`): el resumen de uso distingue una cuota
  de prueba (`quota_kind`) y si se repone (`renews`).

## [0.1.5] - 2026-09-27

- `validateOcr` acepta el comprobante en PDF, y `getValidationImage` lo devuelve como recurso con
  su tipo `application/pdf`.
- Usa el SDK JavaScript `0.4.8` (contrato público `1.60.0`).

## [0.1.4] - 2026-09-26

- Usa el SDK JavaScript `0.4.7` (contrato público `1.60.0`).

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
