# Veriko MCP

Este servidor MCP conecta Veriko a Claude, ChatGPT o Cursor: le pides al asistente,
por ejemplo, que compruebe un pago en el CEP de Banxico, que te diga en qué quedó una
validación anterior o que descargue el comprobante.

Cubre las 66 operaciones públicas de máquina a máquina. Lo que el asistente puede
hacer aquí es exactamente lo que puede hacer una clave de API.

<!-- mcp-name: io.github.veriko-mx-labs/veriko -->

## Probarlo ahora

Requiere Node.js 20 o posterior.

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
| `catalog` | bancos, BIN y estado de Banxico |
| `beneficiaries` | lista e importación masiva |
| `usage` | consumo, límites y exportación |
| `account` | perfil y política de reintentos |
| `dashboard` | resumen operativo |
| `plans` | planes públicos |
| `insights` | métricas agregadas |
| `finance` | resúmenes, vistas previas y descargas |
| `billing` | suscripción activa |
| `all` | las 66 operaciones disponibles |

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
| `core` | 5 | 5,651 | ~1,570 |
| `validations` | 13 | 13,306 | ~3,696 |
| `webhooks` | 10 | 9,795 | ~2,721 |
| `catalog` | 4 | 2,204 | ~612 |
| `beneficiaries` | 14 | 10,060 | ~2,794 |
| `usage` | 7 | 3,756 | ~1,043 |
| `account` | 3 | 1,953 | ~543 |
| `dashboard` | 1 | 558 | ~155 |
| `plans` | 2 | 1,017 | ~283 |
| `insights` | 4 | 2,365 | ~657 |
| `finance` | 7 | 6,470 | ~1,797 |
| `billing` | 1 | 503 | ~140 |
| `all` | 66 | 51,977 | ~14,438 |

Medido con Node 22 y riesgo `destructive`, para no ocultar herramientas. `all`
cuesta 9.2 veces lo que `core`; por eso el perfil predeterminado es `core` y se
amplía por familia cuando hace falta.

## Arquitectura

- Usa el SDK oficial de JavaScript como única capa de transporte hacia la API.
  El código lo importa mediante `@veriko-mx/sdk-runtime`, un alias estable que
  permite cambiar la fuente de distribución sin reescribir el servidor.
- El SDK runtime viaja incluido en el tarball del MCP.
- Anuncia herramientas según perfil y riesgo, pero conserva adaptadores para
  las 66 operaciones.
- Las descargas se devuelven como recursos `veriko://artifact/...`; nunca como
  base64 dentro de texto ni como escrituras automáticas en el workspace.
- Valida base64 canónico y los límites públicos antes de invocar el SDK: 12 MB
  para imágenes OCR y 20 MB para importaciones de beneficiarios. El transporte
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

`check:surface` compara el catálogo completo contra el spec público del
SDK y fija su SHA-256. Una operación nueva, retirada o escondida, un esquema de
autenticación distinto de la clave de API o cualquier cambio contractual deja el
workflow de sincronización en rojo para revisión.

La API real no se usa en las pruebas. `test/server.test.ts` conecta cliente y
servidor MCP en memoria con un SDK falso.

## Transportes

La entrada publicada es `stdio`. El núcleo vive en `createVerikoServer()` y
no depende del transporte, de modo que un futuro Streamable HTTP puede reutilizar
catálogo, políticas, errores y recursos. Un endpoint remoto requerirá
autenticación por usuario y no se presentará como equivalente al paquete local.

## Seguridad

Consulta [SECURITY.md](SECURITY.md). Nunca abras issues con claves de API, payloads
reales, comprobantes, números de cuenta o respuestas sin sanitizar.

## Licencia

MIT.
