<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/jzszdznzzl/localdb/main/assets/logo-dark.svg">
  <img alt="localdb" src="https://raw.githubusercontent.com/jzszdznzzl/localdb/main/assets/logo-light.svg" width="360">
</picture>

**Documentos JSON tipados, validados con zod y guardados en un solo archivo.**
<br>
Una base de datos de documentos embebida para Node.js y Bun: sin servidor, sin módulos nativos y sin SQL.

[![npm](https://img.shields.io/npm/v/@jzszdznzzl/localdb?color=4f46e5&label=npm)](https://www.npmjs.com/package/@jzszdznzzl/localdb)
[![licencia](https://img.shields.io/badge/licencia-MIT-0891b2)](./LICENSE)
![node](https://img.shields.io/badge/node-%E2%89%A524-339933?logo=nodedotjs&logoColor=white)
![bun](https://img.shields.io/badge/bun-compatible-000000?logo=bun&logoColor=white)
![tipos](https://img.shields.io/badge/tipos-incluidos-3178c6?logo=typescript&logoColor=white)
![zod](https://img.shields.io/badge/zod-4-3e67b1?logo=zod&logoColor=white)
![esm](https://img.shields.io/badge/m%C3%B3dulo-solo%20ESM-f7df1e)

[English](./README.md) · **Español**

</div>

---

## ¿Por qué localdb?

Los bots, las herramientas de línea de comandos, los servidores chicos y las apps de escritorio necesitan guardar datos entre ejecuciones, pero levantar MongoDB o Redis para eso es demasiado. La respuesta habitual es un archivo JSON, y ahí empiezan los problemas:

- **Cada guardado reescribe el archivo entero.** Si cambias un campo en una base de 100.000 documentos, se vuelve a escribir todo el archivo, y el proceso se congela mientras tanto.
- **Nadie revisa los datos.** Un error de tipeo, una edición a mano o un documento con un formato viejo llegan directo a tu programa, con tipos que dicen que todo está bien.
- **Se pierden los tipos.** Un `Date` vuelve como string, un `Map` como `{}`, y un `BigInt` ni siquiera se puede guardar.
- **Si el proceso se cae a mitad de una escritura, el archivo puede quedar corrupto.**

localdb mantiene la simplicidad de un archivo JSON y resuelve esos cuatro problemas:

|                                       | Archivo JSON común        | SQLite            | MongoDB / Redis       | **localdb**                         |
| ------------------------------------- | ------------------------- | ----------------- | --------------------- | ----------------------------------- |
| Corre dentro de tu proceso            | ✅                        | ✅                | ❌ servidor aparte    | ✅                                  |
| Guardar un cambio                     | reescribe todo el archivo | escribe una fila  | escribe un documento  | **agrega una línea**                |
| Valida los datos                      | ❌                        | restricciones SQL | opcional              | **zod, en cada escritura y carga**  |
| `Date`, `Map` y `BigInt` se conservan | ❌                        | a mano            | en parte              | ✅                                  |
| Consultas                             | JS común                  | SQL               | lenguaje de consultas | **funciones comunes de TypeScript** |
| Archivo legible                       | ✅                        | ❌ binario        | lo maneja el servidor | ✅ JSON Lines                       |

## Características

- 🛡️ **Validado.** Cada colección tiene un schema de zod. Los documentos se revisan al insertarlos, al actualizarlos y al cargar el archivo.
- ⚡ **Guardados rápidos.** Un guardado agrega solo lo que cambió. Guardar un cambio tarda unos 2 ms, incluso con un millón de documentos.
- 🧊 **Seguro por defecto.** Los documentos están congelados por completo, las escrituras son atómicas, una caída nunca corrompe el archivo, y los errores esperables se devuelven como valores en vez de lanzarse.
- 🔍 **Consultas simples.** `users.find((user) => user.level > 20)`. No hay un lenguaje de consultas que aprender, y todo está tipado.
- 🆔 **Ids ordenables.** `Id` guarda su fecha de creación y se ordena por ella, como el `ObjectId` de MongoDB.
- 🧩 **Tipos ricos.** `Date`, `Map`, `Set`, `BigInt`, `Buffer`, `URL`, `RegExp` e `Id` vuelven tal cual.
- 🔁 **Transacciones.** Varios cambios se aplican juntos, o no se aplica ninguno.
- 📄 **Archivo legible.** Un objeto JSON por línea, fácil de revisar, comparar y respaldar.

## Instalación

```bash
pnpm add @jzszdznzzl/localdb zod
```

- **zod 4** es una dependencia par (`peerDependency`), así tus schemas y localdb comparten la misma copia.
- Requiere **Node.js 24** o superior, o **Bun**. El paquete es solo ESM.

## Inicio rápido

```ts
import { z } from 'zod';

import { LocalDB } from '@jzszdznzzl/localdb';

const User = z.object({
  name: z.string().min(1),
  level: z.number().int(),
  tags: z.array(z.string()).default([]),
});

const db = new LocalDB('data/app.jsonl', { autosave: true });
const users = db.collection('users', User);

const loaded = await db.load();

if (loaded.error) {
  throw new Error(loaded.error.message);
}

const created = users.insert({ name: 'Jxsx', level: 50 });

if (created.error) {
  console.error(created.error.message);
} else {
  users.update(created.data.id, (user) => ({ ...user, level: user.level + 1 }));
}

const veterans = users.find((user) => user.level >= 30);

await db.close();
```

## Rendimiento

localdb comparado con [lowdb](https://github.com/typicode/lowdb) 7, una base de datos en archivo JSON muy usada, haciendo las mismas operaciones en Node.js 24, Linux x64:

| 1.000.000 documentos               | localdb    | lowdb       |                         |
| ---------------------------------- | ---------- | ----------- | ----------------------- |
| Guardar después de un cambio       | **2,5 ms** | 2,9 s       | ~1.200 veces más rápido |
| Buscar (recorrido completo)        | **18 ms**  | 1,3 s       | ~75 veces más rápido    |
| Actualizar varios (1 % coincide)   | **47 ms**  | 1,6 s       | ~33 veces más rápido    |
| Insertar                           | **2,5 s**  | 4,6 s       | 1,8 veces más rápido    |
| Congelamiento más largo al guardar | **159 ms** | 2,1 s       |                         |
| Obtener por id                     | 0,73 µs    | **0,33 µs** | 2,2 veces más lento     |
| Cargar                             | 6,1 s      | **2,7 s**   | 2,3 veces más lento     |
| Tamaño del archivo                 | **170 MB** | 229 MB      |                         |

| 100.000 documentos           | localdb    | lowdb      |                      |
| ---------------------------- | ---------- | ---------- | -------------------- |
| Guardar después de un cambio | **2,2 ms** | 174 ms     | ~78 veces más rápido |
| Buscar (recorrido completo)  | **1,6 ms** | 91 ms      | ~57 veces más rápido |
| Insertar                     | **249 ms** | 458 ms     | 1,8 veces más rápido |
| Cargar                       | 517 ms     | **172 ms** | 3 veces más lento    |

lowdb hace menos trabajo por operación: no valida, no congela los documentos y no conserva los `Date`. Puedes correr el benchmark con `pnpm bench`, o con `pnpm bench 100000 --only=localdb` para una prueba rápida.

## Cuándo no usarlo

localdb mantiene todos los documentos en memoria (unos 500 bytes cada uno) y espera que un solo proceso escriba el archivo. Conviene usar SQLite, MongoDB o Redis cuando:

- los datos no entran cómodos en memoria, o pasan de unos pocos millones de documentos;
- varios procesos o máquinas escriben los mismos datos;
- necesitas índices sobre campos, joins o consultas complejas.

## Guía

### Resultados en vez de excepciones

Las operaciones que pueden fallar como parte del uso normal devuelven un `Result` en vez de lanzar un error:

```ts
type Result<T, E> = { data: T; error: null } | { data: null; error: E };
```

El error es un `DbFailure`: `{ code, message, issues }`, donde `code` es `DbError.NotFound`, `DbError.InvalidDocument` o `DbError.InvalidFile`, e `issues` trae los problemas que encontró zod cuando falló la validación.

Los errores de programación sí se lanzan: usar una colección antes de `load()`, declarar dos veces la misma colección o guardar un valor que no se puede guardar, como una función.

### Documentos

Un documento guardado es la salida del schema más dos campos que maneja localdb:

- `id`: un `Id`, creado al insertar y que nunca cambia.
- `updatedAt`: un `Date`, que se actualiza en cada inserción y actualización.

Los documentos están congelados por completo. Para cambiar uno, llama a `update`, que valida la nueva versión y la guarda en lugar de la anterior. Los valores que pases como `id` o `updatedAt` se ignoran.

### `Id`

`Id` es el equivalente de localdb al `ObjectId` de MongoDB: 26 caracteres en base32 de Crockford, como `01JBCX9Q4ZK3T7M2V8N5RWEYHD`. Guarda 48 bits con el momento de creación en milisegundos y 80 bits aleatorios.

- **Ordenable:** los ids se ordenan por fecha de creación, y los creados en el mismo milisegundo por un proceso también quedan en orden.
- **Legible:** el alfabeto no usa `I`, `L`, `O` ni `U`, y al parsear no importan las mayúsculas.

```ts
import { Id } from '@jzszdznzzl/localdb';

const id = new Id();
id.timestamp; // Date en que se creó el id
id.equals('01jbcx9q4zk3t7m2v8n5rweyhd'); // compara la forma en texto

const parsed = Id.parse(input); // Result<Id, string>, para strings que vienen de afuera
new Id('no es un id'); // lanza un TypeError
```

Puedes guardar ids dentro de documentos para referenciar otros documentos. Vuelven como instancias de `Id`:

```ts
const Post = z.object({ authorId: z.instanceof(Id), text: z.string() });
```

### Transacciones

`db.transaction(fn)` ejecuta una función síncrona y deshace todos sus cambios si lanza un error. Todo lo que cambió se guarda en una sola línea, así que si el proceso se cae se conserva todo o nada:

```ts
db.transaction(() => {
  wallets.update(from.id, { coins: from.coins - 10 });
  wallets.update(to.id, { coins: to.coins + 10 });
});
```

## API

### `new LocalDB(path, options?)`

| Opción     | Por defecto     | Descripción                                                                     |
| ---------- | --------------- | ------------------------------------------------------------------------------- |
| `autosave` | `false`         | `true` guarda 500 ms después de un cambio; `{ delay }` elige la espera en ms.   |
| `onError`  | `console.error` | Recibe los errores del autosave. El siguiente cambio vuelve a intentar guardar. |

| Miembro                    | Descripción                                                                                              |
| -------------------------- | -------------------------------------------------------------------------------------------------------- |
| `collection(name, schema)` | Declara una colección. Declara cada una una sola vez y compártela.                                       |
| `load()`                   | Lee el archivo. Si no existe, la base empieza vacía. Se aplica todo o nada.                              |
| `save()`                   | Agrega los cambios pendientes, o reescribe el archivo si creció demasiado. Las llamadas corren de a una. |
| `compact()`                | Reescribe el archivo solo con los documentos actuales.                                                   |
| `transaction(fn)`          | Ejecuta `fn` (síncrona) y deshace sus cambios si lanza un error.                                         |
| `close()`                  | Detiene el autosave, guarda lo pendiente y cierra la instancia.                                          |
| `path`                     | Ruta absoluta del archivo.                                                                               |
| `collections`              | Nombres de las colecciones declaradas y de las demás que haya en el archivo.                             |
| `hasUnsavedChanges`        | Si la memoria tiene cambios que no están en el archivo.                                                  |

### Colección

| Método                          | Devuelve                                      |
| ------------------------------- | --------------------------------------------- |
| `insert(value)`                 | `Result<Document, DbFailure>`                 |
| `insertMany(values)`            | `Result<Document[], DbFailure>`, todos o nada |
| `get(id)` / `has(id)`           | `Document \| null` / `boolean`                |
| `find(predicate?)`              | `Document[]`                                  |
| `findOne(predicate)`            | `Document \| null`                            |
| `count(predicate?)` / `size`    | `number`                                      |
| `update(id, change)`            | `Result<Document, DbFailure>`                 |
| `updateMany(predicate, change)` | `Result<Document[], DbFailure>`, todos o nada |
| `remove(id)`                    | `boolean`                                     |
| `removeMany(predicate)`         | `number`                                      |

`change` es un cambio parcial (`{ level: 2 }`) o una función que recibe el documento actual y devuelve la nueva versión. Las colecciones también se pueden recorrer: `for (const user of users)`.

## Cómo guarda los datos

El archivo es [JSON Lines](https://jsonlines.org): un encabezado y después una operación por línea. Un guardado agrega solo los documentos que cambiaron desde el último guardado, así que su costo depende de los cambios, no del tamaño de la base:

```jsonl
{"version":2}
{"col":"users","id":"01JBCX9Q4ZK3T7M2V8N5RWEYHD","at":1793112869668,"doc":{"name":"Jxsx","level":50,"tags":[]}}
{"col":"users","id":"01JBCX9Q4ZK3T7M2V8N5RWEYHD","at":1793112870012,"doc":{"name":"Jxsx","level":51,"tags":[]}}
[{"col":"users","id":"01JBCXA0B4…","at":1793112871000,"doc":{…}},{"col":"users","id":"01JBCX9Q4Z…","del":true}]
```

- **Operaciones:** `doc` tiene los campos del documento, `at` su `updatedAt` en milisegundos, y `del` marca un borrado. Al cargar se aplican las líneas en orden, así que gana la última línea de cada id.
- **Una línea por guardado:** cuando un guardado escribe varias operaciones, van en la misma línea, así que si el proceso se cae se conservan todas o ninguna. Eso incluye todo lo que cambió una transacción.
- **Caídas:** una última línea cortada por una caída se ignora al cargar, y el siguiente guardado reescribe el archivo.
- **Compactación:** cuando el archivo tiene más del doble de operaciones que documentos vivos (más 1.000), o un guardado trae más de 10.000 cambios, el guardado reescribe el archivo solo con los documentos actuales en vez de agregar líneas. `compact()` hace lo mismo cuando lo pidas. La reescritura va a un archivo temporal que después reemplaza al anterior, y se escribe por partes, así que no bloquea el proceso.
- **Archivos grandes:** el archivo se lee y se escribe por partes, así que nunca se arma como un solo string en memoria.
- **Tipos extra:** `Date`, `Map`, `Set`, `BigInt`, `Buffer`, `Uint8Array`, `URL`, `RegExp`, `Id`, `NaN`, `Infinity` y `undefined` dentro de arrays se guardan con una etiqueta `__type` y vuelven con el mismo tipo. Las fechas se escriben en milisegundos (`{"__type":"Date","value":1793112869668}`), que es mucho más rápido que el texto ISO; al leer también se acepta texto ISO. Un objeto tuyo que tenga su propia clave `__type` se envuelve, así nunca se confunde con una etiqueta.
- **Colecciones no declaradas:** las colecciones del archivo que tu programa no declara se conservan y se vuelven a escribir sin cambios.
- **Transformaciones:** al cargar, los documentos se validan con el mismo schema, así que las transformaciones de un schema tienen que aceptar su propia salida.

## Migrar desde 1.x (`@imjxsx/localdb`)

La versión 2 es una reescritura, con otra API y otro formato de archivo:

- **Formato:** los archivos son JSON Lines en vez de BSON.
- **Schemas:** cada colección recibe un schema de zod.
- **Consultas:** los filtros son funciones en vez de objetos.
- **Ids:** los documentos tienen un `id` (`Id`) en vez de `__uuid`, y `createdAt` se reemplaza por `id.timestamp`.
- **Nombres:** los nombres de colección se usan tal cual, sin pasarlos a minúsculas ni agregarles una `s`.

## Contribuir

La configuración, los scripts y el flujo de trabajo están en [CONTRIBUTING.md](./CONTRIBUTING.md). Las reglas de código, para personas y asistentes de IA, están en [AGENTS.md](./AGENTS.md).

## Licencia

[MIT](./LICENSE) © José Daniel Cristaldo Vera
