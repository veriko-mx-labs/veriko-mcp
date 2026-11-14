# Changelog

## [0.2.0] - 2026-11-13

### Agregado

- Herramientas `veriko_validate_account`, `veriko_wait_for_validation`, `veriko_wait_for_cep_export`
  y `veriko_wait_for_beneficiary_import`. Las herramientas de espera consultan hasta que el recurso
  llega a un estado terminal, respetan `next_poll_after_seconds` y `Retry-After`, y usan `ETag`
  para que un recurso sin cambios cueste un `304`.
- Cubre 73 de las 75 operaciones públicas de máquina a máquina. Las dos operaciones de purga siguen
  sin exponerse.
- `outputSchema` y `structuredContent` en cada herramienta, con un objeto `_call` que lleva el id de
  la petición, `Idempotent-Replayed` y los encabezados de cuota.
- `idempotency_key` opcional en cada escritura, e `idempotent_replayed` en el resultado.
- `immediate` en `veriko_regenerate_webhook_secret`, y `recipient_is_bank` en la validación por OCR.
- Recursos `veriko://catalog/banks`, `veriko://catalog/spei-calendar/{year}`, `veriko://plans`,
  `veriko://status/banxico` y `veriko://docs`.
- Prompts `check_transfer`, `reconcile_month`, `triage_failed_validations`, `set_up_webhook` e
  `import_beneficiaries`.
- Las descargas devuelven recursos incrustados hasta 256 KiB y `resource_link` por encima de eso, con
  un tipo MIME inferido para `application/octet-stream`.
- Variables de entorno `VERIKO_TIMEOUT_MS`, `VERIKO_MAX_RETRIES` y `VERIKO_ACCEPT_LANGUAGE`.
- Confirmación mediante elicitation antes de `veriko_delete_validation`, `veriko_delete_webhook`,
  `veriko_regenerate_webhook_secret`, `veriko_delete_beneficiary`,
  `veriko_delete_beneficiary_import_row`, `veriko_commit_beneficiary_import` y los dos cambios de
  política de reintentos, cuando el cliente declara la capacidad `elicitation`. Una pregunta
  rechazada devuelve `executed: false` y no envía nada a la API.
- Notificaciones de avance de las herramientas de espera y de las descargas cuando la petición trae
  un `progressToken`, y cancelación que aborta la llamada en curso, sus reintentos y la pausa entre
  consultas. Una llamada cancelada devuelve el código `cancelled`.
- Autocompletado de argumentos para códigos de banco, estados de validación, eventos de webhook,
  formatos de exportación y el año del calendario SPEI. Nueva plantilla de recurso
  `veriko://catalog/banks/{code}` y nuevo prompt `export_validations`.
- `image_path` en `veriko_validate_ocr` y `file_path` en `veriko_create_beneficiary_import`, sólo por
  stdio y dentro de los directorios de `VERIKO_MCP_FILE_ROOTS`.
- `rate_limit`, `deprecation` y `sunset` en `_call`, leídos de los metadatos de la respuesta del SDK.
- Encabezados HTTP `X-Veriko-Profile`, `X-Veriko-Max-Risk` (los dos sólo pueden acotar la
  configuración del servidor) y `Accept-Language` (`en` o `es`).
- `artifact_too_large` lleva `size`, `limit` y un `hint` que nombra los argumentos que reducen el
  archivo.

### Cambiado

- Los campos de entrada usan los nombres de la API en `snake_case` (`validation_id`,
  `with_deleted`, `retry_policy`, etcétera). Los nombres de las herramientas no cambian.
- Cada campo de entrada tiene descripción, y los enums, mínimos, máximos y campos obligatorios
  siguen el contrato público. `with_deleted` y `with_archived` toman `0` o `1`, como en la API.
- Las claves de idempotencia son aleatorias en cada llamada. Ya no se derivan de los argumentos, así
  que repetir la misma llamada es un intento nuevo, salvo que envíes la misma `idempotency_key`.
- Los errores devuelven `isError` con la lista completa `errors`, el estado, `retryable`,
  `retry_after_seconds` y `request_id`. Un `304` no es un error. Una cuota agotada o un límite de
  frecuencia devuelven de inmediato `retry_after_seconds`.
- `veriko_get_usage_limits` pertenece al perfil `core`.
- Las anotaciones son coherentes en cada operación: `readOnlyHint`, `destructiveHint`,
  `idempotentHint` y `openWorldHint`.
- El `User-Agent` es `veriko-mcp/<versión> (<transporte>) veriko-sdk-js/<versión> (...)`.
- El transporte HTTP valida el encabezado `Host` contra una lista (nueva variable
  `VERIKO_MCP_ALLOWED_HOSTS`, obligatoria si el servidor escucha fuera de `127.0.0.1`) y, con
  `VERIKO_MCP_ALLOWED_ORIGINS` vacía, rechaza toda petición que llegue con `Origin`.
- El transporte HTTP responde 401 a una clave que no tiene la forma de una clave de Veriko antes de
  procesar la petición, y 413 a un cuerpo declarado mayor que el tope, sin leerlo.

### Corregido

- Las herramientas de finanzas ya no aceptan el `userId` exclusivo de administradores.
- El texto JSON de un resultado se recorta a 64 KiB; `structuredContent` nunca se recorta.
- Las herramientas de espera marcan el ritmo de sus consultas con `meta.next_poll_after_seconds` del
  cuerpo de la respuesta, y no sólo con `Retry-After`.

## [0.1.14] - 2026-11-09

- Una clave de API que no sea `veriko_` seguida de 64 hexadecimales en minúscula falla antes de
  salir a la red, sin incluir la clave en el mensaje.
- `validateDirect` rechaza un monto de más de 13 dígitos enteros, como el contrato.

## [0.1.13] - 2026-11-08

- Transporte Streamable HTTP sin estado, además de stdio (nuevo ejecutable `veriko-mcp-http`). La
  clave de API del integrador viaja como `Authorization: Bearer` en cada petición y no se guarda.
  En HTTP las descargas se incrustan en la respuesta (tope de 8 MB) en lugar de usar enlaces
  `veriko://artifact/` que dependen de la memoria del proceso. El modo stdio no cambia.
- La versión que anuncia el servidor sale de `package.json` (antes reportaba `0.1.1`).
- Herramientas para exportar CEP en segundo plano: `createFinanceCepExport`,
  `listFinanceCepExports`, `getFinanceCepExport` y `downloadFinanceCepExport`.
- `validateDirect` acepta la validación sin fecha de envío: si falta o no se puede usar, la API prueba
  fechas candidatas contra Banxico.

## [0.1.12] - 2026-10-27

- `myProfile` sigue el contrato `1.111.0`: ya no devuelve `role`, agrega `platform_access` y
  `roles`, y las claves de `permissions` tienen la forma `validations.records.read`.

## [0.1.11] - 2026-10-15

- `createBeneficiary` devuelve `reactivated`: `true` cuando el alta reactivó una cuenta archivada con
  el mismo número, y `false` en un alta nueva.

## [0.1.10] - 2026-10-15

- Herramienta `getSpeiCalendar`: devuelve los días inhábiles SPEI de un año y la disposición oficial
  de la que salen. Admite `ifNoneMatch`. No consume cuota.
- `validateOcr` acepta los códigos de banco emisor y receptor: la clave SPEI de 4 o 5 dígitos
  sustituye al banco leído del comprobante antes de consultar a Banxico.
- `listValidations`, `validationStats` y `exportValidations` aceptan `banks`, hasta 50 claves
  SPEI; filtra por banco emisor o receptor.
- Las cuatro herramientas de entregas aceptan `responseStatus`, `validationId`, `q`, `from`, `to`,
  `minAttempt` y `minResponseTimeMs`, y `status`, `eventType` y `responseStatus` admiten una
  lista. `listAllDeliveries` y `exportAllDeliveries` aceptan `endpointIds`, hasta 20 endpoints.

## [0.1.9] - 2026-10-02

- Herramienta `recheckValidation`: vuelve a consultar a Banxico el estado de pago de una
  validación `valid` creada hace 72 horas como máximo, y la pasa a `returned` si el pago se
  devolvió. No consume cuota.
- `validateDirect` y `validateOcr` aceptan `candidate_accounts`, varias cuentas en una sola
  validación y con una sola unidad de cuota, en lugar de `beneficiary_account`. `validateDirect`
  exige una de las dos formas, no las dos.
- `validateOcr` acepta `retainImage`; con `false`, la plataforma no conserva el archivo del
  comprobante.
- Los webhooks admiten suscribirse al evento `validation.returned`.

## [0.1.8] - 2026-10-01

- `validateDirect` exige `beneficiary_account`: la API no la busca entre los beneficiarios
  guardados.
- `validateDirect`, `validateOcr`, `listValidations`, `validationStats` y `exportValidations`
  aceptan `clientRef`, una referencia propia de 1 a 64 caracteres. En las dos primeras vuelve en la
  validación y en los webhooks; en las otras tres filtra por coincidencia exacta.

## [0.1.6] - 2026-09-28

- El resumen de uso distingue una cuota de prueba (`quota_kind`) y si se repone (`renews`).

## [0.1.5] - 2026-09-27

- `validateOcr` acepta el comprobante en PDF, y `getValidationImage` lo devuelve como recurso con
  su tipo `application/pdf`.

## [0.1.3] - 2026-09-24

- Los parámetros de las herramientas aplican los límites del contrato público:
  longitud máxima de los textos, formato de cuentas y claves de banco, y topes
  de `limit`. Un valor fuera de rango se rechaza antes de llamar a la API.
- `format` es obligatorio al descargar la plantilla de importación de
  beneficiarios (`downloadBeneficiaryImportTemplate`), como en la API.

## [0.1.0] - 2026-09-20

Primera versión en npm.

- Catálogo de 66 operaciones públicas de máquina a máquina.
- Perfiles por familia y una política de riesgo independiente.
- Idempotencia determinista para las operaciones compatibles.
- Descargas como recursos MCP efímeros.
- Transporte local `stdio`.
- Límites binarios verificados de punta a punta: 12 MB para OCR y 20 MB para
  importaciones.
