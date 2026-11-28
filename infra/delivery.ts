/**
 * Modelo de entrega: cuenta, nombres fijos y permisos de cada rol.
 *
 * Ningún rol de aplicación ni de pipeline puede administrar IAM. Los roles de runtime y de
 * entrega los crea el stack de fundación (con la boundary `CEILING`, que es un prerrequisito
 * externo); el stack de la API solo referencia sus ARN.
 */
export const ACCOUNT = '650387442642';
export const REGION = 'us-east-1';

export const GITHUB_OWNER_ID = '99203645';
export const GITHUB_REPOSITORY = 'matigaleanodev/365-tracks-api';
export const GITHUB_REPOSITORY_ID = '1466117945';

// Los nombres de stack de CloudFormation no pueden empezar con un número: prefijo `tracks365`.
export const PREFIX = 'tracks365-';
export const STACK = 'tracks365-api';
export const FOUNDATION_STACK = 'tracks365-foundation';
/** Nombre de la API HTTP: lo usa el stack y la condición IAM `apigateway:Request/ApiName`. */
export const API_NAME = '365-tracks-api';
export const BUCKET = `tracks365-assets-${ACCOUNT}-${REGION}`;
export const ASSET_PREFIX = `${STACK}/`;
export const TABLE_NAME = 'tracks365-tracks';
/** Reposición del catálogo (conserva el nombre del primer despliegue). */
export const SCHEDULE_NAME = 'tracks365-daily-track';
export const PLAYLIST_SCHEDULE_NAME = 'tracks365-playlist-sync';

export const FUNCTIONS = {
  http: `${STACK}-http`,
  generate: `${STACK}-generate`,
  playlist: `${STACK}-playlist`,
} as const;

/**
 * Parámetros de Parameter Store (se crean fuera de CloudFormation: son secretos). Los valores
 * nunca pasan por este repositorio; aquí solo viven sus nombres y qué función los lee.
 */
export const SSM_PREFIX = '/tracks365';
export const SSM_PARAMETERS = {
  spotifyClientId: `${SSM_PREFIX}/spotify/client-id`,
  spotifyClientSecret: `${SSM_PREFIX}/spotify/client-secret`,
  spotifyRefreshToken: `${SSM_PREFIX}/spotify/refresh-token`,
  /** SHA-256 del último refresh token sembrado desde GitHub (SecureString como el resto; no permite reconstruir el token). */
  spotifyRefreshTokenSeed: `${SSM_PREFIX}/spotify/refresh-token-seed-sha256`,
  openaiApiKey: `${SSM_PREFIX}/openai/api-key`,
  openaiModel: `${SSM_PREFIX}/openai/model`,
  criteriaWeights: `${SSM_PREFIX}/selection/criteria-weights`,
} as const;

const parameterArn = (name: string) => `arn:aws:ssm:${REGION}:${ACCOUNT}:parameter${name}`;

/** Roles que crea la fundación y que el stack de la API solo importa. */
export const ROLE_NAMES = [
  'http',
  'generate',
  'playlist',
  'scheduler',
  'cloudformation',
  'prepare',
  'execute',
  'secrets',
] as const;
export type RoleName = (typeof ROLE_NAMES)[number];

/** Roles de la propia fundación: los crea el administrador, no el stack de fundación. */
export const FOUNDATION_ROLE_NAMES = ['foundation', 'foundation-cloudformation'] as const;

export const roleArn = (name: string) => `arn:aws:iam::${ACCOUNT}:role/${PREFIX}${name}`;
export const CEILING_NAME = `${PREFIX}ceiling`;
export const CEILING = `arn:aws:iam::${ACCOUNT}:policy/${CEILING_NAME}`;
export const OIDC_PROVIDER = `arn:aws:iam::${ACCOUNT}:oidc-provider/token.actions.githubusercontent.com`;

/**
 * Entornos de GitHub; los workflows solo corren desde `main`. `plan` y `production` no llevan
 * revisores: la autorización del despliegue es el merge del release en `main`. `secrets` tampoco:
 * su único workflow es manual. `foundation` conserva revisores porque cambia roles IAM.
 */
export const ENVIRONMENTS = {
  plan: 'plan',
  production: 'production',
  foundation: 'foundation',
  secrets: 'secrets',
};

type Json = Record<string, unknown>;

const stackArn = (stack: string) => `arn:aws:cloudformation:${REGION}:${ACCOUNT}:stack/${stack}/*`;
const assetArn = `arn:aws:s3:::${BUCKET}/${ASSET_PREFIX}*`;
const tableArn = `arn:aws:dynamodb:${REGION}:${ACCOUNT}:table/${TABLE_NAME}`;
const functionArn = (name: string) => `arn:aws:lambda:${REGION}:${ACCOUNT}:function:${name}`;
const logGroupArn = (name: string) =>
  `arn:aws:logs:${REGION}:${ACCOUNT}:log-group:/aws/lambda/${name}`;

export const allow = (Action: string[], Resource: string[], Condition?: Json): Json => ({
  Effect: 'Allow',
  Action,
  Resource,
  ...(Condition ? { Condition } : {}),
});

export const policy = (Statement: Json[]): Json => ({ Version: '2012-10-17', Statement });

export const serviceTrust = (service: string): Json =>
  policy([{ Effect: 'Allow', Principal: { Service: service }, Action: 'sts:AssumeRole' }]);

export const githubTrust = (environment: string): Json =>
  policy([
    {
      Effect: 'Allow',
      Principal: { Federated: OIDC_PROVIDER },
      Action: 'sts:AssumeRoleWithWebIdentity',
      Condition: {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          // Subject inmutable (owner e id de repositorio): no se reutiliza si el repo se renombra.
          'token.actions.githubusercontent.com:sub': `repo:matigaleanodev@${GITHUB_OWNER_ID}/365-tracks-api@${GITHUB_REPOSITORY_ID}:environment:${environment}`,
        },
      },
    },
  ]);

const readStack = (stack: string) =>
  allow(
    [
      'cloudformation:DescribeStacks',
      'cloudformation:DescribeStackEvents',
      'cloudformation:DescribeStackResources',
      'cloudformation:ListStackResources',
      'cloudformation:DescribeChangeSet',
      'cloudformation:GetTemplate',
      'cloudformation:GetTemplateSummary',
    ],
    [stackArn(stack)],
  );

const lambdaLogs = (name: string) =>
  allow(['logs:CreateLogStream', 'logs:PutLogEvents'], [`${logGroupArn(name)}:*`]);

/** Permisos de cada rol precreado. Cada uno es la unión mínima de lo que su función necesita. */
export function rolePolicies(): Record<RoleName, Json[]> {
  const functionArns = Object.values(FUNCTIONS).map(functionArn);
  return {
    http: [lambdaLogs(FUNCTIONS.http), allow(['dynamodb:GetItem', 'dynamodb:Query'], [tableArn])],
    // Reposición del catálogo: lee todo el catálogo (Query) para no repetir canciones ni artistas,
    // escribe una fecha por vez (PutItem condicional) y lee las credenciales de OpenAI y Spotify.
    generate: [
      lambdaLogs(FUNCTIONS.generate),
      allow(['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:Query'], [tableArn]),
      allow(
        ['ssm:GetParameters'],
        [
          SSM_PARAMETERS.spotifyClientId,
          SSM_PARAMETERS.spotifyClientSecret,
          SSM_PARAMETERS.openaiApiKey,
          SSM_PARAMETERS.openaiModel,
          SSM_PARAMETERS.criteriaWeights,
        ].map(parameterArn),
      ),
    ],
    // Sincronización de la playlist: nunca ve las credenciales de OpenAI. Puede reescribir solo el
    // refresh token de Spotify, porque Spotify puede rotarlo al renovar el acceso.
    playlist: [
      lambdaLogs(FUNCTIONS.playlist),
      allow(['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:Query'], [tableArn]),
      allow(
        ['ssm:GetParameters'],
        [
          SSM_PARAMETERS.spotifyClientId,
          SSM_PARAMETERS.spotifyClientSecret,
          SSM_PARAMETERS.spotifyRefreshToken,
        ].map(parameterArn),
      ),
      allow(['ssm:PutParameter'], [parameterArn(SSM_PARAMETERS.spotifyRefreshToken)]),
    ],
    // Sincronización de credenciales de Spotify desde GitHub Secrets: solo estos parámetros. Lee para
    // no reescribir valores iguales y para respetar un refresh token que Spotify ya rotó.
    secrets: [
      // Historial solo del refresh token: detecta un valor de la fuente que ya fue reemplazado.
      allow(['ssm:GetParameterHistory'], [parameterArn(SSM_PARAMETERS.spotifyRefreshToken)]),
      allow(
        ['ssm:GetParameters', 'ssm:PutParameter'],
        [
          SSM_PARAMETERS.spotifyClientId,
          SSM_PARAMETERS.spotifyClientSecret,
          SSM_PARAMETERS.spotifyRefreshToken,
          SSM_PARAMETERS.spotifyRefreshTokenSeed,
        ].map(parameterArn),
      ),
    ],
    scheduler: [
      allow(
        ['lambda:InvokeFunction'],
        [functionArn(FUNCTIONS.generate), functionArn(FUNCTIONS.playlist)],
      ),
    ],
    prepare: [
      readStack(STACK),
      allow(['s3:GetObject', 's3:PutObject'], [assetArn]),
      allow(
        ['s3:ListBucket', 's3:GetBucketLocation', 's3:GetEncryptionConfiguration'],
        [`arn:aws:s3:::${BUCKET}`],
      ),
      allow(['cloudformation:CreateChangeSet'], [stackArn(STACK)], {
        StringEquals: { 'cloudformation:RoleArn': roleArn('cloudformation') },
        StringLike: { 'cloudformation:ChangeSetName': `${STACK}-*` },
      }),
      allow(['cloudformation:DeleteChangeSet'], [stackArn(STACK)]),
      allow(['iam:PassRole'], [roleArn('cloudformation')], {
        StringEquals: { 'iam:PassedToService': 'cloudformation.amazonaws.com' },
      }),
    ],
    execute: [
      readStack(STACK),
      allow(['cloudformation:ExecuteChangeSet'], [stackArn(STACK)], {
        StringLike: {
          'cloudformation:ChangeSetName': [
            `arn:aws:cloudformation:${REGION}:${ACCOUNT}:changeSet/${STACK}-*/*`,
            `${STACK}-*`,
          ],
        },
      }),
    ],
    cloudformation: [
      allow(['s3:GetObject'], [assetArn]),
      allow(
        [
          'dynamodb:CreateTable',
          'dynamodb:DescribeTable',
          'dynamodb:UpdateTable',
          'dynamodb:DeleteTable',
          'dynamodb:DescribeContinuousBackups',
          'dynamodb:UpdateContinuousBackups',
          'dynamodb:DescribeTimeToLive',
          'dynamodb:TagResource',
          'dynamodb:UntagResource',
          'dynamodb:ListTagsOfResource',
        ],
        [tableArn],
      ),
      allow(
        [
          'lambda:CreateFunction',
          'lambda:GetFunction',
          'lambda:GetFunctionConfiguration',
          'lambda:GetFunctionCodeSigningConfig',
          'lambda:GetFunctionRecursionConfig',
          'lambda:GetRuntimeManagementConfig',
          'lambda:UpdateFunctionCode',
          'lambda:UpdateFunctionConfiguration',
          'lambda:DeleteFunction',
          'lambda:AddPermission',
          'lambda:RemovePermission',
          'lambda:GetPolicy',
          'lambda:TagResource',
          'lambda:UntagResource',
          'lambda:ListTags',
        ],
        functionArns,
      ),
      allow(['iam:PassRole'], [roleArn('http'), roleArn('generate'), roleArn('playlist')], {
        StringEquals: { 'iam:PassedToService': 'lambda.amazonaws.com' },
      }),
      allow(['iam:PassRole'], [roleArn('scheduler')], {
        StringEquals: { 'iam:PassedToService': 'scheduler.amazonaws.com' },
      }),
      allow(
        [
          'scheduler:CreateSchedule',
          'scheduler:GetSchedule',
          'scheduler:UpdateSchedule',
          'scheduler:DeleteSchedule',
        ],
        [SCHEDULE_NAME, PLAYLIST_SCHEDULE_NAME].map(
          (name) => `arn:aws:scheduler:${REGION}:${ACCOUNT}:schedule/default/${name}`,
        ),
      ),
      allow(
        [
          'logs:CreateLogGroup',
          'logs:DeleteLogGroup',
          'logs:PutRetentionPolicy',
          'logs:DeleteRetentionPolicy',
          'logs:TagResource',
          'logs:UntagResource',
          'logs:ListTagsForResource',
          'logs:GetDataProtectionPolicy',
        ],
        Object.values(FUNCTIONS).flatMap((name) => [logGroupArn(name), `${logGroupArn(name)}:*`]),
      ),
      allow(['logs:DescribeLogGroups'], ['*'], {
        StringEquals: { 'aws:RequestedRegion': REGION },
      }),
      // La API HTTP se crea con este nombre fijo; el resto de acciones se limita a APIs HTTP.
      allow(['apigateway:POST'], [`arn:aws:apigateway:${REGION}::/apis`], {
        StringEquals: { 'apigateway:Request/ApiName': API_NAME },
      }),
      allow(
        [
          'apigateway:GET',
          'apigateway:POST',
          'apigateway:PATCH',
          'apigateway:PUT',
          'apigateway:DELETE',
          // El catálogo IAM de API Gateway define PATCH, POST y PUT para etiquetar; `TagResource` se conserva
          // sin evidencia de que sea necesario y debe revisarse con el primer despliegue real.
          'apigateway:TagResource',
        ],
        [`arn:aws:apigateway:${REGION}::/apis/*`],
      ),
    ],
  };
}

export const roleTrust = (name: RoleName): Json => {
  switch (name) {
    case 'http':
    case 'generate':
    case 'playlist':
      return serviceTrust('lambda.amazonaws.com');
    case 'scheduler':
      return serviceTrust('scheduler.amazonaws.com');
    case 'cloudformation':
      return serviceTrust('cloudformation.amazonaws.com');
    case 'prepare':
      return githubTrust(ENVIRONMENTS.plan);
    case 'execute':
      return githubTrust(ENVIRONMENTS.production);
    case 'secrets':
      return githubTrust(ENVIRONMENTS.secrets);
  }
};

/** Cuota de IAM para una política administrada, medida sin espacios. */
export const MANAGED_POLICY_MAX_CHARS = 6144;

type Grant = { Action: string[]; Resource: string[]; Condition?: Json };

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, inner: unknown) =>
    inner && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => a.localeCompare(b)))
      : inner,
  );

/** Agrupa `items` por el conjunto ordenado de valores asociados a cada uno. */
const groupBySet = (pairs: [string, string][]): [string[], string[]][] => {
  const byItem = new Map<string, Set<string>>();
  for (const [item, value] of pairs) {
    byItem.set(item, (byItem.get(item) ?? new Set()).add(value));
  }
  const bySet = new Map<string, [string[], string[]]>();
  for (const [item, values] of byItem) {
    const sorted = [...values].sort();
    const key = sorted.join('\n');
    const entry = bySet.get(key) ?? [sorted, []];
    entry[1].push(item);
    bySet.set(key, entry);
  }
  return [...bySet.values()];
};

/**
 * Reescribe sentencias Allow con exactamente los mismos pares acción/recurso/condición, sin
 * comodines nuevos: por condición y servicio elige la agrupación más corta (por recurso o por acción).
 */
export function compactStatements(statements: Json[]): Json[] {
  const partitions = new Map<string, { condition?: Json; pairs: [string, string][] }>();
  for (const statement of statements as Grant[]) {
    for (const action of statement.Action) {
      const key = `${canonical(statement.Condition ?? null)} ${action.split(':')[0]}`;
      const partition = partitions.get(key) ?? { condition: statement.Condition, pairs: [] };
      for (const resource of statement.Resource) partition.pairs.push([action, resource]);
      partitions.set(key, partition);
    }
  }
  const size = (list: Json[]) => JSON.stringify(list).length;
  return [...partitions.values()].flatMap(({ condition, pairs }) => {
    const byResource = groupBySet(pairs.map(([a, r]) => [r, a])).map(([actions, resources]) =>
      allow(actions, resources, condition),
    );
    const byAction = groupBySet(pairs).map(([resources, actions]) =>
      allow([...actions].sort(), resources, condition),
    );
    return size(byResource) <= size(byAction) ? byResource : byAction;
  });
}

/** Techo de permisos de todos los roles de la fundación: la unión de sus políticas, compactada. */
export function ceilingPolicy(): Json {
  return policy(compactStatements(Object.values(rolePolicies()).flat()));
}

/** Rol que asume el workflow de fundación (entorno `foundation`): solo gestiona su change set. */
export function foundationPipelinePolicy(): Json {
  return policy([
    readStack(FOUNDATION_STACK),
    allow(['cloudformation:CreateChangeSet'], [stackArn(FOUNDATION_STACK)], {
      StringEquals: { 'cloudformation:RoleArn': roleArn('foundation-cloudformation') },
      StringLike: { 'cloudformation:ChangeSetName': `${FOUNDATION_STACK}-*` },
    }),
    allow(
      ['cloudformation:ExecuteChangeSet', 'cloudformation:DeleteChangeSet'],
      [stackArn(FOUNDATION_STACK)],
    ),
    allow(['iam:PassRole'], [roleArn('foundation-cloudformation')], {
      StringEquals: { 'iam:PassedToService': 'cloudformation.amazonaws.com' },
    }),
  ]);
}

/** Rol que usa CloudFormation para el stack de fundación: crea roles solo bajo la boundary. */
export function foundationCloudformationPolicy(): Json {
  const roles = ROLE_NAMES.map(roleArn);
  return policy([
    allow(['iam:CreateRole', 'iam:PutRolePermissionsBoundary'], roles, {
      StringEquals: { 'iam:PermissionsBoundary': CEILING },
    }),
    allow(
      [
        'iam:GetRole',
        'iam:DeleteRole',
        'iam:PutRolePolicy',
        'iam:GetRolePolicy',
        'iam:DeleteRolePolicy',
        'iam:ListRolePolicies',
        'iam:ListAttachedRolePolicies',
        'iam:UpdateAssumeRolePolicy',
        'iam:TagRole',
        'iam:UntagRole',
      ],
      roles,
    ),
    allow(
      [
        's3:CreateBucket',
        's3:DeleteBucket',
        's3:GetBucketPolicy',
        's3:PutBucketPolicy',
        's3:DeleteBucketPolicy',
        's3:GetBucketPublicAccessBlock',
        's3:PutBucketPublicAccessBlock',
        's3:GetBucketOwnershipControls',
        's3:PutBucketOwnershipControls',
        's3:GetEncryptionConfiguration',
        's3:PutEncryptionConfiguration',
        's3:GetBucketVersioning',
        's3:PutBucketVersioning',
        's3:GetBucketTagging',
        's3:PutBucketTagging',
        's3:GetBucketLocation',
        's3:ListBucket',
        's3:GetLifecycleConfiguration',
        's3:PutLifecycleConfiguration',
      ],
      [`arn:aws:s3:::${BUCKET}`],
    ),
  ]);
}

export const foundationTrust = (name: (typeof FOUNDATION_ROLE_NAMES)[number]): Json =>
  name === 'foundation'
    ? githubTrust(ENVIRONMENTS.foundation)
    : serviceTrust('cloudformation.amazonaws.com');
