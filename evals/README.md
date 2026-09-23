# Evaluaciones del catálogo

Diez escenarios para decidir con datos qué perfil conviene por omisión, en vez
de fijarlo por preferencia.

## Qué mide hoy

`npm run evals` corre el **oráculo**: para cada escenario ejecuta la operación
de referencia contra el servidor MCP con un SDK falso, y comprueba que la
respuesta satisface la regla del escenario.

Eso no evalúa a ningún modelo. Comprueba que los diez escenarios **son
medibles**: que el conjunto de datos todavía responde la pregunta, que la
operación conserva su forma y que la regla de corrección sigue decidiendo. Un
escenario roto daría una cifra sin sentido al comparar perfiles, y es el modo de
fallo que nadie nota. Por eso también corre en la suite (`test/evals.test.ts`).

No usa modelos, no cuesta y no necesita claves.

## Limitaciones actuales

La comparativa real entre `core`, las familias y `all`: aciertos, llamadas
equivocadas, tokens de catálogo y reintentos. Necesita un cliente y una clave
del proveedor, y cuesta por corrida. La interfaz está declarada en
`ClienteDeModelo`, dentro de `runner.ts`; la decisión de ejecutarla es de
Veriko.

El coste en contexto de cada perfil, que es la otra mitad de esa comparación, ya
está medido: `npm run measure:catalog`.

## Reglas de los escenarios

Todos cumplen lo mismo, y es lo que los hace comparables:

- **Sólo lectura.** Ninguno consume cuota ni modifica nada, así que una corrida
  contra un modelo real no gasta validaciones.
- **Independientes.** Ninguno depende de otro; pueden correr en cualquier orden.
- **Verificables.** `comprobar` decide con una regla, no con un juicio de
  parecido.
- **Con camino esperado.** Se mide también por dónde se llegó: un acierto por la
  herramienta equivocada es un acierto frágil.

## Los datos

`datos.json` es ficticio y está versionado junto a los escenarios, de modo que
una corrida de hoy y otra dentro de seis meses parten de lo mismo. No sale de
ninguna respuesta de producción: ninguna cifra, cuenta, clave de rastreo ni
nombre corresponde a un cliente. La API real no se toca en ningún modo.
