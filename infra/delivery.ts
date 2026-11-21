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
export const SCHEDULE_NAME = 'tracks365-daily-track';

export const FUNCTIONS = { http: `${STACK}-http`, generate: `${STACK}-generate` } as const;

/** Roles que crea la fundación y que el stack de la API solo importa. */
export const ROLE_NAMES = [
  'http',
  'generate',
  'scheduler',
  'cloudformation',
  'prepare',
  'execute',
] as const;
export type RoleName = (typeof ROLE_NAMES)[number];

/** Roles de la propia fundación: los crea el administrador, no el stack de fundación. */
export const FOUNDATION_ROLE_NAMES = ['foundation', 'foundation-cloudformation'] as const;

export const roleArn = (name: string) => `arn:aws:iam::${ACCOUNT}:role/${PREFIX}${name}`;
export const CEILING_NAME = `${PREFIX}ceiling`;
export const CEILING = `arn:aws:iam::${ACCOUNT}:policy/${CEILING_NAME}`;
export const OIDC_PROVIDER = `arn:aws:iam::${ACCOUNT}:oidc-provider/token.actions.githubusercontent.com`;

/** Entornos de GitHub: `plan` sin aprobación, `production` y `foundation` con revisores. */
export const ENVIRONMENTS = { plan: 'plan', production: 'production', foundation: 'foundation' };

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
    generate: [
      lambdaLogs(FUNCTIONS.generate),
      allow(['dynamodb:GetItem', 'dynamodb:PutItem'], [tableArn]),
    ],
    scheduler: [allow(['lambda:InvokeFunction'], [functionArn(FUNCTIONS.generate)])],
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
      allow(['iam:PassRole'], [roleArn('http'), roleArn('generate')], {
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
        [`arn:aws:scheduler:${REGION}:${ACCOUNT}:schedule/default/${SCHEDULE_NAME}`],
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
      return serviceTrust('lambda.amazonaws.com');
    case 'scheduler':
      return serviceTrust('scheduler.amazonaws.com');
    case 'cloudformation':
      return serviceTrust('cloudformation.amazonaws.com');
    case 'prepare':
      return githubTrust(ENVIRONMENTS.plan);
    case 'execute':
      return githubTrust(ENVIRONMENTS.production);
  }
};

/** Techo de permisos de todos los roles de la fundación: la unión de sus políticas. */
export function ceilingPolicy(): Json {
  return policy(Object.values(rolePolicies()).flat());
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
