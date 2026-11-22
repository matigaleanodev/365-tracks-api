# 365-tracks-api

## Contexto de trabajo

Si existe un workspace con AGENTS.md en los directorios padre, leerlo explícitamente antes de editar y seguir sus referencias. Una raíz Git anidada puede impedir la herencia automática. Fuera de ese entorno, este archivo y el README deben ser suficientes para trabajar.

## Estructura y contratos

- TypeScript ESM estricto, Node 24, AWS CDK v2, Lambda ARM64, HTTP API, DynamoDB, EventBridge Scheduler y Middy.
- Un solo paquete npm (sin workspaces) y un lockfile.
- src/api: handler Middy, contratos HTTP (contracts.ts), errores y paginación.
- src/tracks: entidad DailyTrack, puerto TrackRepository, caso de uso generateDailyTrack y ventana del catálogo.
- src/music-selection (selector editorial; OpenAI solo propone), src/spotify (catálogo, coincidencias, autorización y playlists), src/playlist (corte de elegibilidad y sincronización), src/config (Parameter Store) y src/jobs (handlers y dependencias reales). La lógica de negocio no importa clientes de AWS ni de terceros: entran por interfaces.
- infra: stack de la API sin IAM propio (roles importados de la fundación, ver DEPLOYMENT.md); cuenta, región y nombres fijos en infra/delivery.ts; las rutas de API Gateway deben coincidir con las de src/api/routes.ts, sin comodines.
- La fecha editorial identifica a cada canción y no depende del visitante; la visibilidad sí: se calcula con el reloj del servidor y el parámetro `timezone` (IANA, UTC por defecto). Nunca exponer una fecha que aún no empezó en esa zona, ni siquiera por historial o cursor.
- El catálogo mantiene una ventana móvil de 30 fechas preparadas (`src/tracks/catalog.ts`); la reposición solo completa fechas faltantes con escritura condicional e idempotente por fecha.
- Nunca enviar datos de Spotify a OpenAI: la comparación y las reglas de repetición son locales. Una canción sin descripción válida no está preparada. La reposición es acotada y reanudable.
- La playlist anual solo incluye días ya terminados en todas las zonas (desde las 12:00 UTC de D+1), nunca la del día ni futuras; la sincronización lee la playlist real antes de escribir y es independiente de la preparación.
- La API es pública y de solo lectura. Las credenciales viven en Parameter Store; nunca exponerlas ni registrarlas, ni exponer canciones futuras en logs, endpoints o playlists.

## Desarrollo y verificación

- Usar el Node de .nvmrc e instalar con npm ci --ignore-scripts.
- npm run check ejecuta lint, formato, tipos, tests, build y ambos synth sin lookups.
- npm run invoke -- GET /api/tracks/today invoca el handler con fixtures locales.
- Los imports relativos llevan extensión .ts (Node ejecuta TypeScript sin transpilar: sin enums ni parameter properties).

## Restricciones

- No desplegar ni modificar recursos AWS como parte de las verificaciones; synth no usa lookups.
- No versionar secretos ni .env; usar .env.example sin valores reales.
- Documentación pública breve y vigente; sin historial, avances ni resultados de ejecuciones.

## Flujo Git

- `dev` es la rama predeterminada y la base de todo desarrollo. Crear desde `dev` únicamente ramas `feat/<tema>` o `fix/<tema>` y devolverlas mediante PR a `dev`.
- Para publicar una versión, crear `release/x.x.x` desde `dev` y abrir PR hacia `main`. No integrar `dev`, `feat/` ni `fix/` directamente en `main`.
- Fuera de `dev` y `main`, solo se permiten los prefijos `feat/`, `fix/` y `release/`; no usar `codex/`. Verificar el nombre antes de crear una rama.
- `dev` y `main` requieren PR, CI y el control `branch-policy` aprobados, conversaciones resueltas y merge commit. No hacer push directo, force-push ni borrar estas ramas.
- Conservar commits pequeños y descriptivos. Títulos de commits y PR semánticos en español; cuerpo del PR concreto con alcance y validación.
- Commit, push, merge, release y despliegue requieren autorización del pedido vigente; este archivo no los autoriza por sí solo.
- Tras un merge autorizado, eliminar la rama remota integrada una vez comprobado que no queden cambios ni integraciones pendientes. Conservar ramas destino, tags y ramas locales.
