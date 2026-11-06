# Veriko MCP

Este servidor MCP conecta Veriko a Claude, Cursor u otro cliente MCP compatible: le pides al asistente,
por ejemplo, que compruebe un pago en el CEP de Banxico, que te diga en qué quedó una
validación anterior o que descargue el comprobante.

Cubre 72 de las 74 operaciones públicas de máquina a máquina. Lo que el asistente puede
hacer aquí es lo que puede hacer una clave de API, salvo el borrado definitivo de una
validación: no se anuncia como herramienta porque no se puede deshacer.

<!-- mcp-name: io.github.veriko-mx-labs/veriko -->

## Instalación

Requiere Node.js 20 o posterior. Sin clonar nada, el cliente arranca el servidor con `npx`:

```bash
npx -y @veriko-mx/mcp
```

En un host que acepta configuración JSON (Claude Desktop, Cursor y similares):

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
arranque tu cliente, no tú. Esta es la configuración del host, con la ruta
absoluta a la copia que acabas de construir:

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

La clave se obtiene en `app.veriko.mx`. Nunca se pasa como argumento de una
herramienta: el servidor sólo la lee de `VERIKO_API_KEY`, de modo que un texto
inyectado en una página que el modelo esté leyendo no puede pedírsela.

## Lo que consume cuota

`veriko_validate_direct` y `veriko_validate_ocr` consumen cuota del plan y se
descuentan al aceptar la petición. Lo dice su propia descripción, porque un
bucle de un agente puede vaciar una cuota mensual en minutos. El resto del
catálogo consulta, exporta o descarga sin consumir validaciones.

## Perfiles

`VERIKO_MCP_PROFILE` acepta `core`, `all`, una familia o varias familias
separadas por coma.

| Perfil | Herramientas anunciadas |
|---|---|
| `core` | validar, listar, consultar y descargar CEP |
| `validations` | ciclo completo de validaciones |
| `webhooks` | endpoints y entregas |
| `catalog` | bancos, calendario SPEI, BIN y estado de Banxico |
| `beneficiaries` | lista e importación masiva |
| `usage` | consumo, límites y exportación |
| `account` | perfil y política de reintentos |
| `dashboard` | resumen operativo |
| `plans` | planes públicos |
| `insights` | métricas agregadas |
| `finance` | resúmenes, vistas previas y descargas |
| `billing` | suscripción activa |
| `all` | las 72 herramientas disponibles |

El perfil decide qué familias ve el modelo. El riesgo se controla de forma
independiente con `VERIKO_MCP_MAX_RISK`:

- `read`: sólo consultas y descargas;
- `write` (predeterminado): incluye validaciones y cambios normales;
- `destructive`: agrega eliminaciones, cancelaciones, rotación de secretos y la
  confirmación de importaciones.

### Lo que cuesta anunciar cada perfil

Anunciar una herramienta gasta contexto antes de que el modelo llame a ninguna.
Estas cifras salen del propio servidor: bytes de la respuesta `tools/list`, con
`npm run measure:catalog`. Los tokens son una estimación a 3.6 bytes por token,
no una tokenización real, y sirven para comparar perfiles entre sí.

| Perfil | Herramientas | Bytes de `tools/list` | Tokens estimados |
|---|---:|---:|---:|
| `core` | 5 | 6,645 | ~1,846 |
| `validations` | 14 | 15,761 | ~4,378 |
| `webhooks` | 10 | 18,945 | ~5,263 |
| `catalog` | 5 | 2,845 | ~790 |
| `beneficiaries` | 14 | 10,343 | ~2,873 |
| `usage` | 7 | 3,756 | ~1,043 |
| `account` | 3 | 1,953 | ~543 |
| `dashboard` | 1 | 557 | ~155 |
| `plans` | 2 | 1,017 | ~283 |
| `insights` | 4 | 2,337 | ~649 |
| `finance` | 11 | 9,609 | ~2,669 |
| `billing` | 1 | 503 | ~140 |
| `all` | 72 | 67,616 | ~18,782 |

Medido con Node 22 y riesgo `destructive`, para no ocultar herramientas. `all`
cuesta 9.7 veces lo que `core`; por eso el perfil predeterminado es `core` y se
amplía por familia cuando hace falta.

## Arquitectura

- Usa el SDK oficial de JavaScript como única capa de transporte hacia la API.
  El código lo importa mediante `@veriko-mx/sdk-runtime`, un alias estable que
  permite cambiar la fuente de distribución sin reescribir el servidor.
- El SDK runtime viaja incluido en el tarball del MCP.
- Anuncia herramientas según perfil y riesgo.
- Las descargas se devuelven como recursos `veriko://artifact/...`; nunca como
  base64 dentro de texto ni como escrituras automáticas en el workspace.
- Valida base64 canónico y los límites públicos antes de invocar el SDK: 12 MB
  para comprobantes OCR (imagen o PDF) y 20 MB para importaciones de beneficiarios. El transporte
  stdio admite completa una importación máxima.
- Los errores usan `error.code`, estado, puntero, `requestId` y `retryAfter`
  cuando existen; el texto traducible de la API no se usa como contrato.

## Idempotencia

Si se pasa `idempotencyKey`, se conserva. Si falta, el servidor calcula
`veriko_mcp_v1_<sha256>` sobre el `operationId` y los argumentos canónicos. En
entradas binarias usa el hash del contenido, no una ruta local. La misma acción
produce la misma clave; cambiar un dato relevante produce otra.

## Desarrollo

```bash
npm install
npm run check
npm run check:surface
npm run measure:catalog
```

`check:surface` compara el catálogo completo contra el spec público del SDK y
fija su SHA-256. Las operaciones que el catálogo no anuncia, el borrado definitivo de una
validación, se declaran aparte en `NOT_EXPOSED_OPERATIONS`. Una operación nueva, retirada o escondida, un esquema de
autenticación distinto de la clave de API o cualquier cambio contractual falla
esta comprobación. El workflow de sincronización deja el PR del contrato nuevo
como borrador, con el CI corrido y un resumen del cambio en el cuerpo, para
revisión antes de aceptarlo.

La API real no se usa en las pruebas. `test/server.test.ts` conecta cliente y
servidor MCP en memoria con un SDK falso; `test/http.test.ts` levanta el modo HTTP
en un puerto local.

## Transportes

El núcleo vive en `createVerikoServer()` y no depende del transporte. Hay dos:

- **stdio** (`veriko-mcp`): el cliente lo arranca como proceso local y la clave
  se lee de `VERIKO_API_KEY`. Las descargas son recursos `veriko://artifact/...`.
- **Streamable HTTP sin estado** (`veriko-mcp-http`): un endpoint que se puede
  poner detrás de un proxy. No hay sesiones ni memoria entre peticiones.

### Modo HTTP

```bash
npm run build
VERIKO_MCP_HTTP_PORT=3000 node dist/http-index.js
```

Escucha en `127.0.0.1:3000/mcp`; `GET /healthz` responde sin autenticación.

- **Autenticación.** Cada petición lleva la clave de API del integrador como
  `Authorization: Bearer <clave>`. Sin ella, responde 401. El servidor crea un
  cliente nuevo por petición, no guarda ni registra la clave e ignora
  `VERIKO_API_KEY` del entorno, para que nunca se use una clave del servidor en
  nombre de otro.
- **Descargas.** Como la siguiente petición puede caer en otro proceso, el
  archivo no se guarda: viaja incrustado en la respuesta como recurso con
  `blob` en base64, con un tope de 8 MB. Más allá devuelve el error
  `artifact_too_large`; para archivos grandes usa stdio o la API.
- **Perfiles y riesgo.** Valen `VERIKO_MCP_PROFILE` y `VERIKO_MCP_MAX_RISK` para
  todo el servidor, igual que en stdio.

| Variable | Descripción | Predeterminado |
|---|---|---|
| `VERIKO_MCP_HTTP_PORT` | Puerto | `3000` |
| `VERIKO_MCP_HTTP_HOST` | Dirección de escucha | `127.0.0.1` |
| `VERIKO_MCP_HTTP_PATH` | Ruta del endpoint | `/mcp` |
| `VERIKO_MCP_ALLOWED_ORIGINS` | Orígenes permitidos, separados por coma; vacío no restringe | vacío |
| `VERIKO_MCP_HTTP_MAX_BODY_BYTES` | Tamaño máximo del cuerpo | 32 MiB |
| `VERIKO_MCP_HTTP_MAX_INLINE_BYTES` | Tope de un archivo incrustado | 8 MiB |

El servidor no termina TLS: se despliega detrás de un proxy HTTPS. Hasta que
exista OAuth para cuentas de cliente, la clave de API es la única credencial.

## Seguridad

Consulta [SECURITY.md](SECURITY.md). Nunca abras issues con claves de API, payloads
reales, comprobantes, números de cuenta o respuestas sin sanitizar.

## Licencia

MIT.
