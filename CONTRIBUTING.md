# Contribuir

Los issues y los pull requests son bienvenidos.

## Reportar un error o pedir un cambio

Abre un issue con el formulario de [reporte de error](https://github.com/veriko-mx-labs/veriko-mcp/issues/new?template=bug_report.yml) o de [solicitud de mejora](https://github.com/veriko-mx-labs/veriko-mcp/issues/new?template=feature_request.yml). Antes, busca entre los issues abiertos.

Un reporte de error necesita las versiones que usas, los pasos para reproducirlo y, cuando la API respondió con un error, su `request_id` (el campo `request_id` del resultado de la herramienta). Quita las claves de API, los comprobantes, los números de cuenta y los datos de clientes de todo lo que pegues.

No abras un issue público por una vulnerabilidad de seguridad. Sigue [SECURITY.md](SECURITY.md).

## Proponer un cambio

1. Si el cambio es más grande que una corrección, abre antes un issue para acordarlo antes de escribirlo.
2. Haz un fork del repositorio y crea una rama desde `main`.
3. Haz el cambio. Agrega o actualiza las pruebas en `test/`.
4. Ejecuta las comprobaciones de este repositorio:

   ```bash
   npm ci
   npm run typecheck
   npm test
   npm run build
   npm run check:surface
   ```

   `npm test` usa una API falsa y nunca llega a la real. `npm run evals` ejecuta los escenarios de `evals/`. Usa Node.js 20 o posterior.

5. Actualiza README.md y CHANGELOG.md cuando cambie el comportamiento que ven las personas usuarias.
6. Abre un pull request contra `main` y llena la plantilla.

Escribe los mensajes de commit en español, en imperativo, y deja un solo cambio en cada commit.

El servidor llega a la API sólo mediante el SDK oficial de JavaScript. No agregues código HTTP a una herramienta. `npm run check:surface` compara las herramientas con la superficie pública del spec.

Cuando cambie una herramienta o un perfil, actualiza el README. `npm run measure:catalog` regenera el costo por perfil.

## El contrato de la API

El contrato de la API es el spec público en <https://docs.veriko.mx/openapi.yaml>. `spec/openapi.yaml` es una copia que sincroniza un workflow programado. No la edites a mano. Cuando la API se comporte distinto del spec, abre un issue.
