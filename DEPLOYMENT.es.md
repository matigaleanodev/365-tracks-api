# Despliegue

Guía para el primer despliegue y los siguientes. Nada se despliega solo: los workflows son manuales y el repositorio no necesita bootstrap de CDK.

## Modelo

- Cuenta `650387442642`, región `us-east-1` (fijas en `infra/delivery.ts`).
- Dos stacks: **`tracks365-foundation`** (bucket de assets y roles) y **`tracks365-api`** (la aplicación).
- El stack de la API **no crea ni modifica IAM**: importa los roles que crea la fundación. Los assets van al bucket de la fundación (`CliCredentialsStackSynthesizer`).
- Todos los roles de la fundación llevan la boundary `tracks365-ceiling`, que es la unión de sus permisos y que crea un administrador (prerrequisito, el pipeline no puede editarla).
- Autenticación con OIDC de GitHub y subject inmutable (owner e id de repositorio). Sin claves de larga duración y sin variables de GitHub.

| Rol                                                           | Lo asume                                     | Para qué                                          |
| ------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------- |
| `tracks365-foundation`                                        | workflow `foundation` (entorno `foundation`) | Gestiona el change set de la fundación            |
| `tracks365-foundation-cloudformation`                         | CloudFormation                               | Crea los roles (solo con la boundary) y el bucket |
| `tracks365-prepare`                                           | job `plan` (entorno `plan`)                  | Sube assets y crea el change set                  |
| `tracks365-execute`                                           | job `execute` (entorno `production`)         | Ejecuta el change set revisado                    |
| `tracks365-cloudformation`                                    | CloudFormation                               | Crea los recursos de la API                       |
| `tracks365-http`, `tracks365-generate`, `tracks365-scheduler` | Lambda / Scheduler                           | Runtime, con permisos mínimos                     |

## Prerrequisitos (una vez, con permisos de administración)

Los documentos están generados en `deploy/admin/` (`npm run admin:policies` los regenera; un test verifica que estén al día).

1. Provider OIDC `token.actions.githubusercontent.com` en la cuenta (ya existe si otro repo lo usa).
2. Política gestionada `tracks365-ceiling`:
   ```bash
   aws --profile PERFIL_ADMIN --region us-east-1 iam create-policy --policy-name tracks365-ceiling \
     --policy-document file://deploy/admin/tracks365-ceiling.policy.json
   ```
3. Rol de CloudFormation de la fundación:
   ```bash
   aws --profile PERFIL_ADMIN --region us-east-1 iam create-role --role-name tracks365-foundation-cloudformation \
     --assume-role-policy-document file://deploy/admin/tracks365-foundation-cloudformation.trust.json
   aws --profile PERFIL_ADMIN --region us-east-1 iam put-role-policy --role-name tracks365-foundation-cloudformation --policy-name project \
     --policy-document file://deploy/admin/tracks365-foundation-cloudformation.policy.json
   ```
4. Rol del pipeline de la fundación:
   ```bash
   aws --profile PERFIL_ADMIN --region us-east-1 iam create-role --role-name tracks365-foundation \
     --assume-role-policy-document file://deploy/admin/tracks365-foundation.trust.json
   aws --profile PERFIL_ADMIN --region us-east-1 iam put-role-policy --role-name tracks365-foundation --policy-name project \
     --policy-document file://deploy/admin/tracks365-foundation.policy.json
   ```
5. Entornos de GitHub (Settings → Environments), todos limitados a la rama `main`:
   - `foundation`: revisores requeridos.
   - `plan`: sin revisores.
   - `production`: revisores requeridos.

En cada comando, reemplazá `PERFIL_ADMIN` por un perfil local de AWS CLI con los permisos de administración necesarios. Antes de cada mutación, verificá la identidad y comprobá la cuenta y la región de destino:

```bash
aws sts get-caller-identity --profile PERFIL_ADMIN --region us-east-1
```

La cuenta debe ser `650387442642` y la región `us-east-1`; si no coinciden, no continuar.

## Primer despliegue

Los workflows solo corren desde `main`, así que primero hace falta un release (`release/x.x.x` → `main`).

1. Ejecutar el workflow **foundation** y aprobar el entorno `foundation`. Crea el bucket y los seis roles.
2. Ejecutar el workflow **deploy**. El job `plan` valida, empaqueta, sube los assets y crea el change set (queda resumido en la página del run); el job `execute` espera la aprobación del entorno `production` y ejecuta ese mismo change set.

El job `plan` se detiene si el change set toca IAM o si elimina o reemplaza la tabla.

## Configuración de la aplicación

`CORS_ALLOWED_ORIGINS`, `PUBLISH_TIME_UTC` y `SCHEDULE_ENABLED` se leen en el synth (contexto de CDK o variables de entorno). El workflow no las define: con los defaults, **CORS queda sin configurar y el schedule queda deshabilitado**. Hasta que exista el selector de canciones y la integración con Spotify, dejalo deshabilitado.

## Limitaciones conocidas

- El rol `tracks365-cloudformation` puede modificar cualquier API HTTP de la cuenta (`/apis/*`): API Gateway no permite acotar por nombre después de la creación. Se puede acotar al id de la API una vez creada (como hace Foodly).
- Los permisos se derivan de la síntesis local. Si CloudFormation informa un permiso faltante, se ajusta `infra/delivery.ts` y se regeneran los documentos con `npm run admin:policies`.
- Faltan permisos de Parameter Store: se agregan cuando exista la integración con Spotify.
- Sin alarma ni DLQ para el job diario.
