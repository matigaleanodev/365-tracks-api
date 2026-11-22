# Pruebas

[English](TESTING.md)

## Tests unitarios

```bash
npm test
```

Vitest ejecuta todo lo que está en `test/` con repositorios en memoria y dobles de prueba para DynamoDB, Spotify, OpenAI y Parameter Store. No necesita Docker ni red, y es la suite que corre `npm run check`. Los archivos de `test-integration/` nunca se incluyen.

## Pruebas de integración (DynamoDB Local)

```bash
npm run test:integration
```

Ejecuta el código real del repositorio, con los clientes reales del SDK de AWS, contra DynamoDB Local en un contenedor, y lo elimina al terminar. Es independiente de `npm test` y de `npm run check`.

Requisitos:

- Docker Desktop o Docker Engine. El runner detecta `docker` o `docker.exe` en el `PATH`; `DOCKER_BIN` sirve para un binario en otra ruta (por ejemplo `DOCKER_BIN=/ruta/docker.exe` en WSL sin integración con Docker).
- Solo se aceptan daemons Docker locales (`unix://` o `npipe://`); los daemons `tcp` y `ssh` se rechazan.
- `DYNAMODB_LOCAL_ENDPOINT` (opcional) para usar una instancia ya levantada. Solo se aceptan endpoints loopback.

Si el runner muere abruptamente, los contenedores restantes se identifican con `docker ps --filter label=365-tracks-api.integration=true`.

DynamoDB Local no equivale al servicio administrado: no reproduce throttling, latencia, límites de capacidad, IAM ni todos los comportamientos del servicio. Pasar aquí no reemplaza las verificaciones de [DEPLOYMENT.es.md](DEPLOYMENT.es.md). No se usa ninguna cuenta ni credencial de AWS.

## Preview de selección

```bash
npm run preview:selection -- --date=AAAA-MM-DD --simulate
npm run preview:selection -- --help
```

Recorre el camino de selección (OpenAI propone, Spotify resuelve, reglas locales validan) sobre un catálogo en memoria. No guarda ni publica nada. El modo es obligatorio: sin `--simulate` ni `--live` no hace ninguna llamada de red y termina con código 1. Las opciones solo admiten la forma `--opción=valor`.

| Opción              | Descripción                                                                         |
| ------------------- | ----------------------------------------------------------------------------------- |
| `--date=AAAA-MM-DD` | Primera fecha a preparar (por defecto `2027-01-01`)                                 |
| `--count=N`         | Fechas consecutivas, acumuladas en memoria (1 a 10, por defecto 1)                  |
| `--simulate`        | Respuestas HTTP simuladas y deterministas: sin red ni credenciales                  |
| `--live`            | Llamadas reales a OpenAI y Spotify; solo con autorización explícita                 |
| `--catalog=FILE`    | Arreglo JSON de canciones preparadas (`DailyTrack[]`), validado (por defecto vacío) |
| `--budget-ms=N`     | Presupuesto de tiempo por fecha (por defecto 180000)                                |
| `--json`            | Informe en JSON                                                                     |

Códigos de salida: `0` todas las fechas seleccionadas, `2` alguna sin selección válida, `1` error.

`--live` necesita credenciales de cliente de Spotify (sin cuenta de usuario ni scopes de playlist) y una API key de OpenAI con el modelo elegido, que se leen de `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `OPENAI_API_KEY` y `OPENAI_MODEL`, más `CRITERIA_WEIGHTS` opcional. No requiere AWS. Se definen solo en el shell.

El preview no lee el catálogo real. Para considerarlo más adelante, se exporta el catálogo a un archivo JSON con el formato anterior (un export de solo lectura) y se pasa con `--catalog`; el preview nunca se conecta a DynamoDB.

El preview nunca debe:

- escribir en DynamoDB ni crear registros `CLAIM` o `ARTIST`;
- tocar playlists, Parameter Store, Schedulers ni despliegues;
- enviar datos de Spotify a OpenAI;
- guardar credenciales ni respuestas de los proveedores, ni imprimir tokens en logs.

## Riesgos que persisten

Los tests unitarios y el preview no garantizan el comportamiento de los servicios externos: Spotify (resultados de búsqueda, cuotas, límites, expiración de tokens, escrituras ambiguas), OpenAI (propuestas, cuota, latencia) y AWS (límites de Lambda, DynamoDB, IAM, Scheduler). Las condiciones de alerta del catálogo están en [DEPLOYMENT.es.md](DEPLOYMENT.es.md#señales-de-salud-del-catálogo).
