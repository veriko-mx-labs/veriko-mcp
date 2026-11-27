# Veriko MCP

El servidor MCP de Veriko conecta Veriko con Cursor u otro cliente compatible
con MCP. Le pides al asistente que compruebe un pago en el CEP de Banxico, que te
diga en qué quedó una validación anterior o que descargue el comprobante.

El servidor cubre como herramientas 73 de las 75 operaciones públicas de máquina
a máquina. Deja fuera las dos operaciones de purga (`prepare` y `execute`),
porque un borrado definitivo no se puede deshacer. Otras tres herramientas
esperan un resultado asíncrono: `veriko_wait_for_validation`,
`veriko_wait_for_cep_export` y `veriko_wait_for_beneficiary_import`. Con eso son
76 herramientas en el perfil `all`.

<!-- mcp-name: mx.veriko/veriko -->

## Instalación

Hay dos formas de conectar el servidor. Con la local, tu cliente arranca el
paquete en tu computadora. Con la remota, se conecta al servidor que Veriko
mantiene en `https://api.veriko.mx/mcp`, sin instalar nada.

### Local, con npx

Requiere Node.js 20 o posterior. Sin clonar nada, el cliente arranca el
servidor con `npx`:

```bash
npx -y @veriko-mx/mcp
```

En Cursor y en otros editores compatibles con MCP que leen `mcpServers` en su
archivo de configuración de MCP:

```json
{
  "mcpServers": {
    "veriko": {
      "command": "npx",
      "args": ["-y", "@veriko-mx/mcp"],
      "env": { "VERIKO_API_KEY": "veriko_..." }
    }
  }
}
```

En VS Code (`.vscode/mcp.json`), que pide la clave al arrancar en lugar de
guardarla en el archivo:

```json
{
  "inputs": [
    {
      "type": "promptString",
      "id": "veriko-api-key",
      "description": "Clave de API de Veriko",
      "password": true
    }
  ],
  "servers": {
    "veriko": {
      "command": "npx",
      "args": ["-y", "@veriko-mx/mcp"],
      "env": { "VERIKO_API_KEY": "${input:veriko-api-key}" }
    }
  }
}
```

### Remota

El servidor remoto usa Streamable HTTP en `https://api.veriko.mx/mcp`. En Claude,
ChatGPT y otros clientes que conectan con OAuth basta con la URL: el cliente te
lleva a Veriko para iniciar sesión y elegir los permisos. En los demás, cada
petición lleva tu clave de API en el encabezado `Authorization: Bearer`. Es el
mismo servidor del paquete, con las mismas herramientas, pero no lee archivos de
tu computadora: para `image_path` y `file_path` usa la instalación local.

En Cursor, con la clave en una variable de entorno:

```json
{
  "mcpServers": {
    "veriko": {
      "url": "https://api.veriko.mx/mcp",
      "headers": { "Authorization": "Bearer ${env:VERIKO_API_KEY}" }
    }
  }
}
```

En VS Code:

```json
{
  "inputs": [
    {
      "type": "promptString",
      "id": "veriko-api-key",
      "description": "Clave de API de Veriko",
      "password": true
    }
  ],
  "servers": {
    "veriko": {
      "type": "http",
      "url": "https://api.veriko.mx/mcp",
      "headers": { "Authorization": "Bearer ${input:veriko-api-key}" }
    }
  }
}
```

Otros editores compatibles con MCP aceptan una URL remota y encabezados
personalizados: usa la misma URL y el mismo encabezado `Authorization`. La
clave nunca se escribe en un archivo que subas al repositorio.

## Probarlo desde el código fuente

```bash
git clone https://github.com/veriko-mx-labs/veriko-mcp.git
cd veriko-mcp
npm ci
npm run build
```

Queda un servidor ejecutable en `dist/index.js`. Para verlo responder sin clave
de API, el perfil de planes públicos no necesita credenciales:

```bash
VERIKO_MCP_PROFILE=plans VERIKO_MCP_MAX_RISK=read node dist/index.js
```

El proceso se queda esperando mensajes MCP por stdin; lo normal es que lo
arranque tu cliente. Esta es la configuración del host, con la ruta absoluta a
la copia que acabas de construir:

```json
{
  "mcpServers": {
    "veriko": {
      "command": "node",
      "args": ["/ruta/a/veriko-mcp/dist/index.js"],
      "env": {
        "VERIKO_API_KEY": "veriko_...",
        "VERIKO_MCP_PROFILE": "core",
        "VERIKO_MCP_MAX_RISK": "write"
      }
    }
  }
}
```

La clave se obtiene en `app.veriko.mx`. Nunca es un argumento de una
herramienta: el servidor sólo la lee de `VERIKO_API_KEY`, de modo que un texto
inyectado en una página que el modelo esté leyendo no puede pedírsela. Las
herramientas que leen datos públicos (perfil `plans`, estado de Banxico,
catálogo de bancos) funcionan sin clave.

## Variables de entorno

| Variable | Descripción | Predeterminado |
|---|---|---|
| `VERIKO_API_KEY` | Clave de API del integrador (`veriko_` seguido de 64 caracteres hexadecimales) | ninguno |
| `VERIKO_MCP_PROFILE` | `core`, `all`, una familia o varias familias separadas por coma | `core` |
| `VERIKO_MCP_MAX_RISK` | Riesgo máximo que se anuncia: `read`, `write` o `destructive` | `write` |
| `VERIKO_BASE_URL` | URL base de la API (HTTPS; HTTP sólo para `localhost`) | API de producción |
| `VERIKO_TIMEOUT_MS` | Tiempo límite por petición, de 1,000 a 300,000 | 60,000 |
| `VERIKO_MAX_RETRIES` | Reintentos automáticos de fallas transitorias, de 0 a 5 | 2 |
| `VERIKO_ACCEPT_LANGUAGE` | Idioma del texto de los errores de la API: `en` o `es` | `en` |
| `VERIKO_MCP_FILE_ROOTS` | Directorios absolutos, separados por el delimitador de rutas de la plataforma, de los que pueden leer `image_path` y `file_path` (sólo stdio) | ninguno |

## Lo que consume cuota

`veriko_validate_direct` y `veriko_validate_ocr` consumen cuota del plan, que se
descuenta cuando la API acepta la petición. Cada descripción lo dice, porque un
ciclo de un agente puede vaciar una cuota mensual en minutos. El resultado
informa el saldo restante, y el texto avisa cuando queda poco. El resto del
catálogo consulta, exporta o descarga sin consumir validaciones.

Consulta antes el saldo con `veriko_get_usage_limits`, que pertenece al perfil
`core`.

## Perfiles

`VERIKO_MCP_PROFILE` acepta `core`, `all`, una familia o varias familias
separadas por coma.

| Perfil | Herramientas anunciadas |
|---|---|
| `core` | validar, validar una cuenta, listar, consultar, esperar y descargar un CEP, límites de uso |
| `validations` | ciclo completo de validaciones |
| `webhooks` | endpoints, entregas y secretos |
| `catalog` | bancos, calendario SPEI, BIN y estado de Banxico |
| `beneficiaries` | lista e importación masiva |
| `usage` | consumo, límites y exportación |
| `account` | perfil y política de reintentos |
| `dashboard` | resumen operativo |
| `plans` | planes públicos |
| `insights` | métricas agregadas |
| `finance` | resúmenes, vistas previas, descargas y exportaciones de CEP |
| `billing` | suscripción activa |
| `all` | las 76 herramientas |

El perfil decide qué familias ve el modelo. El riesgo se controla de forma
independiente con `VERIKO_MCP_MAX_RISK`:

- `read`: sólo consultas y descargas;
- `write` (predeterminado): agrega validaciones y cambios normales;
- `destructive`: agrega eliminaciones, cancelaciones, rotación de secretos y la
  confirmación de importaciones.

### Lo que cuesta anunciar cada perfil

Anunciar una herramienta gasta contexto antes de que el modelo llame a ninguna.
Estas cifras salen del propio servidor: bytes de la respuesta `tools/list`, con
`npm run measure:catalog`. Los tokens son una estimación a 3.6 bytes por token,
no una tokenización real, y sirven para comparar perfiles entre sí. Las cifras
incluyen el esquema de salida de cada herramienta.

| Perfil | Herramientas | Bytes de `tools/list` | Tokens estimados |
|---|---:|---:|---:|
| `core` | 8 | 26,735 | ~7,426 |
| `validations` | 15 | 45,433 | ~12,620 |
| `webhooks` | 10 | 29,854 | ~8,293 |
| `catalog` | 5 | 6,898 | ~1,916 |
| `beneficiaries` | 16 | 27,781 | ~7,717 |
| `usage` | 7 | 9,154 | ~2,543 |
| `account` | 3 | 4,882 | ~1,356 |
| `dashboard` | 1 | 1,253 | ~348 |
| `plans` | 2 | 2,207 | ~613 |
| `insights` | 4 | 5,094 | ~1,415 |
| `finance` | 12 | 21,220 | ~5,894 |
| `billing` | 1 | 1,087 | ~302 |
| `all` | 76 | 155,001 | ~43,056 |

Medido con Node 22 y riesgo `destructive`, para no ocultar herramientas. `all`
cuesta 5.7 veces lo que `core`; por eso el perfil predeterminado es `core` y se
amplía por familia cuando hace falta. `test/tools-list-size.test.ts` falla cuando
un perfil rebasa su presupuesto.

## Comportamiento de las herramientas

- **Nombres y entradas.** Las herramientas se llaman
  `veriko_<operationId en snake_case>`. El prefijo mantiene únicos los nombres en
  un host que conecta varios servidores, y los nombres no cambian entre
  versiones. Los campos de entrada usan los nombres de la API en `snake_case`,
  cada uno con su descripción, y los enums, mínimos y máximos del contrato público.
- **Salida estructurada.** Cada herramienta declara un `outputSchema` y devuelve
  `structuredContent` más el mismo JSON como texto. Un objeto `_call` lleva el id
  de la petición, la marca `Idempotent-Replayed`, la cuota, la ventana de límite
  de frecuencia, `retry_after_seconds` y, cuando la API lo anuncia, `deprecation`
  y `sunset`. El texto se recorta a 64 KiB; `structuredContent` nunca se recorta.
- **Idempotencia.** Cada escritura envía un `Idempotency-Key` aleatorio por
  llamada. Para reintentar sin riesgo tras una respuesta perdida, repite la
  llamada con la misma `idempotency_key`; `idempotent_replayed: true` significa
  que la API devolvió la respuesta guardada.
- **Campos cortados del comprobante.** Una validación por imagen lista en
  `attributes.truncated_fields` los campos que el comprobante muestra cortados
  con puntos suspensivos (`field`, `position`, `head` y `tail`). Un `not_found`
  con `error_code` `tracking_key_truncated` significa que la clave de rastreo
  está cortada y no hay referencia: la API no consulta a Banxico ni reintenta,
  así que valida de nuevo con la clave completa. Con `other_account_exists` no
  hay pago a la cuenta enviada, pero sí a otra cuenta que muestra el
  comprobante. Las instrucciones del servidor y los prompts ya lo explican al
  asistente.
- **Resultados asíncronos.** Una validación puede responder `queued` o
  `processing`. `veriko_wait_for_validation`, `veriko_wait_for_cep_export` y
  `veriko_wait_for_beneficiary_import` consultan hasta que el recurso llega a un
  estado terminal o termina la espera (25 segundos por omisión, hasta 40).
  Respetan `next_poll_after_seconds` y `Retry-After`, y responden
  `terminal: false` con el intervalo cuando se acaba el tiempo. Las lecturas
  condicionales que devuelven `304` llegan como
  `{ "not_modified": true, "etag": ... }`, no como errores.
- **Errores.** Una llamada fallida devuelve `isError` con `code`, `status`,
  `retryable`, `retry_after_seconds`, `request_id` y la lista completa `errors`
  (`code`, `title`, `detail`, `hint`, `docs_url`, `pointer`, `meta`). Un `429` por
  cuota agotada (`kind: quota`) y uno por límite de frecuencia
  (`kind: rate_limit`) regresan de inmediato, con `retry_after_seconds`; el
  servidor no espera dormido a que pasen.
- **Confirmación.** Cuando el cliente declara la capacidad `elicitation`, el
  servidor pregunta antes de `veriko_delete_validation`, `veriko_delete_webhook`,
  `veriko_regenerate_webhook_secret`, `veriko_delete_beneficiary`,
  `veriko_delete_beneficiary_import_row`, `veriko_commit_beneficiary_import`,
  `veriko_update_validation_retry_policy` y `veriko_update_my_retry_policy`.
  Una pregunta rechazada o cerrada devuelve `executed: false` con el `reason`, y
  no se envía nada a la API. Un cliente sin la capacidad ejecuta la operación, y
  `VERIKO_MCP_MAX_RISK` sigue siendo la compuerta.
- **Avance y cancelación.** Cuando la petición trae un `progressToken`, las
  herramientas de espera envían una `notifications/progress` por consulta, y las
  descargas envían una al empezar la petición y otra cuando llega el archivo.
  Cancelar la petición aborta la llamada en curso, sus reintentos y la pausa entre
  consultas; el resultado es `cancelled`.
- **Descargas.** Los archivos regresan como recursos incrustados hasta 256 KiB, y
  como enlaces `veriko://artifact/...` por encima de eso (stdio), con el tipo MIME
  correcto. El servidor infiere el tipo de una descarga `application/octet-stream`
  por la extensión y los primeros bytes.
- **Límites.** El servidor valida base64 canónico y los límites públicos antes de
  llamar al SDK: 12 MB para comprobantes OCR (imagen o PDF) y 20 MB para
  importaciones de beneficiarios. El transporte stdio admite completa una
  importación máxima.
- **Archivos locales.** Por stdio, define `VERIKO_MCP_FILE_ROOTS` y
  `veriko_validate_ocr` acepta `image_path`, y `veriko_create_beneficiary_import`
  acepta `file_path`, en lugar de base64. La ruta debe ser absoluta y, una vez
  resueltos los enlaces, estar dentro de una de las raíces. El servidor revisa los
  límites de tamaño anteriores, los primeros bytes de un comprobante (JPEG, PNG,
  WebP o PDF) y la extensión de un archivo de importación antes de enviar nada.
  Sin la variable, los argumentos no se anuncian, y el servidor HTTP nunca los
  anuncia ni los lee.
- **Autocompletado.** Los argumentos de los prompts y las variables de las
  plantillas de recursos responden `completion/complete`: los estados de
  validación, los eventos de webhook y los formatos de exportación salen de los
  enums del spec, los códigos de banco del catálogo público de bancos (por código,
  nombre o alias), y el año del calendario SPEI del año en curso.
- **User agent.** Las peticiones envían
  `veriko-mcp/<versión> (<transporte>) veriko-sdk-js/<versión> (...)`.

### Recursos

| URI | Contenido |
|---|---|
| `veriko://catalog/banks` | Catálogo de bancos SPEI |
| `veriko://catalog/banks/{code}` | Un banco SPEI por su código de 5 dígitos |
| `veriko://catalog/spei-calendar/{year}` | Días inhábiles SPEI de un año |
| `veriko://plans` | Planes públicos |
| `veriko://status/banxico` | Estado del servicio de Banxico |
| `veriko://docs` | Enlaces a la documentación en `https://docs.veriko.mx/en/` |
| `veriko://artifact/...` | Archivos descargados en la sesión actual (stdio) |

### Prompts

`check_transfer`, `reconcile_month`, `triage_failed_validations`,
`set_up_webhook`, `export_validations` e `import_beneficiaries` inician un flujo
guiado con las herramientas reales del catálogo.

## Arquitectura

- Usa el SDK oficial de JavaScript como única capa de transporte hacia la API.
  El código lo importa mediante `@veriko-mx/sdk-runtime`, un alias estable que
  permite cambiar la fuente de distribución sin reescribir el servidor.
- El SDK runtime viaja incluido en el tarball del MCP.
- Anuncia herramientas según perfil y riesgo.
- Los errores usan `error.code`, estado, puntero, id de la petición e intervalo de
  reintento cuando existen; el texto traducible de la API no es un contrato.

## Desarrollo

```bash
npm ci
npm run build
npm run typecheck
npm test
npm run check:surface
npm run measure:catalog
npm run evals
```

`check:surface` compara el catálogo completo contra el spec público del SDK y
fija su SHA-256. Las operaciones que el catálogo no anuncia, las dos operaciones
de purga, se declaran aparte en `NOT_EXPOSED_OPERATIONS`. Una operación nueva,
retirada o escondida, un esquema de autenticación distinto de la clave de API o
cualquier cambio contractual falla esta comprobación. El workflow de
sincronización deja el PR del contrato nuevo como borrador, con el CI corrido y
un resumen del cambio en el cuerpo, para revisarlo antes de aceptarlo.

Las pruebas no usan la API real. `test/server.test.ts` conecta un cliente y un
servidor MCP en memoria con un SDK falso; `test/http.test.ts` levanta el modo
HTTP en un puerto local. `npm run evals` ejecuta los escenarios de `evals/`
contra una API falsa.

## Transportes

El núcleo vive en `createVerikoServer()` y no depende del transporte. Hay dos:

- **stdio** (`veriko-mcp`): el cliente lo arranca como proceso local y la clave
  se lee de `VERIKO_API_KEY`. Las descargas son recursos `veriko://artifact/...`
  o recursos incrustados.
- **Streamable HTTP sin estado** (`veriko-mcp-http`): un endpoint que se puede
  poner detrás de un proxy. No hay sesiones ni memoria entre peticiones.

### Modo HTTP

```bash
npm run build
VERIKO_MCP_HTTP_PORT=3000 node dist/http-index.js
```

Escucha en `127.0.0.1:3000/mcp`; `GET /healthz` responde sin autenticación.

- **Autenticación.** Cada petición lleva la clave de API del integrador o un token
  de acceso OAuth (un JWT con `typ: at+jwt`) como `Authorization: Bearer <token>`.
  Sin él, o si no tiene ninguna de las dos formas, la respuesta es 401; con
  `VERIKO_MCP_RESOURCE_METADATA_URL`, el 401 anuncia los metadatos del recurso en
  `WWW-Authenticate`. Un token OAuth se verifica antes de leer el cuerpo: firma
  con la clave de su `kid` en el JWKS del servidor de autorización, `iss`, `exp`
  y `aud` igual al `resource` de esos metadatos. Todo sale por descubrimiento desde
  esa URL; sin ella no se aceptan tokens OAuth. Un token que no pasa recibe 401 con
  `error="invalid_token"`, y si no se pudo leer el JWKS la respuesta es 503. La
  credencial sólo viaja a `VERIKO_BASE_URL`: una petición a otra URL sale sin
  `Authorization`. El servidor crea un cliente nuevo por petición,
  no guarda ni registra la clave e ignora `VERIKO_API_KEY` del entorno, para que
  nunca se use una clave del servidor en nombre de otra persona.
- **Descargas.** Como la siguiente petición puede caer en otro proceso, el
  archivo no se guarda: viaja incrustado en la respuesta como recurso con `blob`
  en base64, con un tope de 8 MB. Más allá devuelve el error `artifact_too_large`
  con el tamaño, el límite y un `hint`: baja `limit`, acota `from` y `to`, agrega
  un filtro, o usa stdio o la API.
- **Host y Origin.** El encabezado `Host` debe estar en `VERIKO_MCP_ALLOWED_HOSTS`;
  sin configurarla sólo se admiten `localhost`, `127.0.0.1` y `[::1]`, y el
  servidor no arranca si escucha en otra dirección. Una petición con `Origin`
  (las de un navegador) sólo pasa si ese origen está en
  `VERIKO_MCP_ALLOWED_ORIGINS`; los clientes que no son navegador no lo envían.
- **Tamaño del cuerpo.** Un cuerpo declarado mayor que el tope se rechaza con 413
  sin leerlo.
- **Perfiles y riesgo.** `VERIKO_MCP_PROFILE` y `VERIKO_MCP_MAX_RISK` valen para
  todo el servidor, igual que en stdio. Una petición puede acotarlos con
  `X-Veriko-Profile` y `X-Veriko-Max-Risk`; un valor más amplio responde 403 y
  uno desconocido 400. Las comprobaciones corren después de las de `Host`,
  `Origin` y clave.
- **Idioma.** `Accept-Language` (`en` o `es`) fija el idioma del texto de los
  errores de la API para esa petición.

| Variable | Descripción | Predeterminado |
|---|---|---|
| `VERIKO_MCP_HTTP_PORT` | Puerto | `3000` |
| `VERIKO_MCP_HTTP_HOST` | Dirección de escucha | `127.0.0.1` |
| `VERIKO_MCP_HTTP_PATH` | Ruta del endpoint | `/mcp` |
| `VERIKO_MCP_ALLOWED_HOSTS` | Nombres de host admitidos en `Host`, sin puerto, separados por coma; obligatoria si escucha fuera de `127.0.0.1` | `localhost`, `127.0.0.1`, `[::1]` |
| `VERIKO_MCP_ALLOWED_ORIGINS` | Orígenes de navegador permitidos (`https://app.ejemplo.com`), separados por coma; vacío rechaza toda petición con `Origin` | vacío |
| `VERIKO_MCP_HTTP_MAX_BODY_BYTES` | Tamaño máximo del cuerpo | 32 MiB |
| `VERIKO_MCP_HTTP_MAX_INLINE_BYTES` | Tope de un archivo incrustado | 8 MiB |

El servidor no termina TLS: se despliega detrás de un proxy HTTPS.

## Seguridad

Consulta [SECURITY.md](SECURITY.md). Nunca abras issues con claves de API, payloads
reales, comprobantes, números de cuenta o respuestas sin sanitizar.

## Licencia

MIT.
