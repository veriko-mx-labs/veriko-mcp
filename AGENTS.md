# AGENTS.md — Veriko MCP

Reglas para cualquier agente que trabaje en este repositorio:

1. El SDK oficial de JavaScript es la única capa de transporte hacia la API y
   se importa mediante el alias estable `@veriko-mx/sdk-runtime`. No dupliques
   HTTP, autenticación, reintentos, polling, descargas ni errores.
2. La superficie es exactamente la pública M2M del spec.
3. Todo `operationId` soportado por el SDK debe tener un adaptador en
   `src/catalog.ts`. `known_gaps` no es una solución permanente.
4. La clave de API sólo entra por `VERIKO_API_KEY`. Nunca es argumento de herramienta,
   log, fixture, error, ejemplo real ni metadato MCP.
5. Descargas y binarios se entregan como recursos MCP. No escribas en el
   workspace ni metas base64 en contenido textual.
6. Mantén separadas la selección por perfil y la política de riesgo.
7. Conserva la idempotencia determinista y versionada. Para binarios se resume
   el contenido, nunca una ruta local.
8. Las pruebas usan un SDK falso o recordings sanitizados; nunca la API real.
9. Antes de empujar: `npm run check`, `npm run check:surface` y `npm pack --dry-run`.
10. No publiques npm, tags o el MCP Registry sin aprobación explícita y CI verde.
