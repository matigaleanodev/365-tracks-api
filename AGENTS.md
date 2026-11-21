# 365-tracks-api

## Contexto de trabajo

Si existe un workspace con AGENTS.md en los directorios padre, leerlo explícitamente antes de editar y seguir sus referencias. Una raíz Git anidada puede impedir la herencia automática. Fuera de ese entorno, este archivo y el README deben ser suficientes para trabajar.

## Estructura y contratos

- TypeScript ESM estricto, Node 24, AWS CDK v2, Lambda ARM64, HTTP API, DynamoDB, EventBridge Scheduler y Middy.
- Un solo paquete npm (sin workspaces) y un lockfile.
- src/api: handler Middy, contratos HTTP (contracts.ts), errores y paginación.
- src/tracks: entidad DailyTrack, puerto TrackRepository y caso de uso generateDailyTrack.
- src/music-selection y src/spotify: puertos sin implementar; la lógica de negocio no importa clientes de AWS ni de terceros.
- infra: stack CDK independiente y agnóstico de cuenta y región; las rutas de API Gateway deben coincidir con las de src/api/routes.ts, sin comodines.
- La fecha editorial es la fecha UTC; el proceso diario debe seguir siendo idempotente por fecha.
- La API es pública y de solo lectura. Nunca exponer credenciales de Spotify ni de OpenAI al frontend.

## Desarrollo y verificación

- Usar el Node de .nvmrc e instalar con npm ci --ignore-scripts.
- npm run check ejecuta lint, formato, tipos, tests, build y synth sin lookups.
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
