# Evals del catálogo

Dieciocho escenarios para decidir con datos qué perfil conviene por omisión, en
lugar de fijarlo por preferencia. Cubren lecturas (`E*`), escrituras y flujos
asíncronos (`W*`) y resultados de error (`X*`).

## Lo que mide hoy

`npm run evals` ejecuta el **oráculo**: para cada escenario ejecuta los pasos de
referencia contra el servidor MCP con un SDK falso, y comprueba que la respuesta
cumpla la regla del escenario y que la marca de error coincida con `expectsError`.

Esto no evalúa ningún modelo. Comprueba que los escenarios **son medibles**: el
conjunto de datos sigue respondiendo la pregunta, la operación conserva su forma
y la regla de corrección sigue decidiendo. Un escenario roto daría un número sin
sentido al comparar perfiles, y es la falla que nadie nota. Por eso también corre
en la suite (`test/evals.test.ts`).

No usa modelos, no cuesta nada y no necesita claves.

## Limitaciones actuales

La comparación real entre `core`, las familias y `all` (aciertos, llamadas
equivocadas, tokens del catálogo y reintentos) necesita un cliente y una clave de
un proveedor, y cuesta dinero por corrida. La interfaz está declarada en
`ModelClient`, dentro de `runner.ts`; la decisión de correrla es de Veriko.

El costo en contexto de cada perfil, la otra mitad de esa comparación, ya se mide
con `npm run measure:catalog`.

## Reglas de los escenarios

- **Sin cuota real.** Todos corren contra `fake-api.ts`, así que una corrida con
  un modelo real no gasta validaciones. Los escenarios de escritura (`W*`) y los
  de error (`X*`) usan el mismo falso.
- **Confirmación.** Un escenario con `confirms` corre con un cliente que declara
  la capacidad de elicitation y responde con esa acción la pregunta de
  confirmación de una herramienta destructiva. `forbiddenMethods` lista las
  llamadas al SDK que el camino no debe hacer, por ejemplo una eliminación que la
  persona rechazó.
- **Independientes.** Ninguno depende de otro; corren en cualquier orden.
- **Comprobables.** `check` decide con una regla, no con un juicio de similitud.
- **Con camino esperado.** También se mide el camino: una respuesta correcta por
  la herramienta equivocada es una respuesta correcta frágil.

## Los datos

`data.json` es ficticio y está versionado junto a los escenarios, así que una
corrida de hoy y una de dentro de seis meses parten del mismo lugar. Ninguna
cifra, cuenta, clave de rastreo ni nombre viene de una respuesta de producción.
La API real nunca se toca.
