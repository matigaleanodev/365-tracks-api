import { fileURLToPath } from 'node:url';
import {
  CfnOutput,
  CfnParameter,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
} from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import type { Construct } from 'constructs';
import type { StackConfig } from './config.ts';

export interface LambdaCode {
  api: lambda.Code;
  generateDailyTrack: lambda.Code;
}

export interface Tracks365ApiStackProps extends StackProps {
  config: StackConfig;
  /** Solo para tests; por defecto empaqueta el resultado de `npm run build` (dist/). */
  code?: LambdaCode;
}

const API_ROUTES = ['/api/tracks/today', '/api/tracks/{date}', '/api/tracks'] as const;
const THROTTLE = { rateLimit: 50, burstLimit: 100 };

function builtCode(directory: string): lambda.Code {
  return lambda.Code.fromAsset(fileURLToPath(new URL(`../dist/${directory}`, import.meta.url)));
}

export class Tracks365ApiStack extends Stack {
  constructor(scope: Construct, id: string, props: Tracks365ApiStackProps) {
    super(scope, id, props);
    const { config } = props;
    const code = props.code ?? {
      api: builtCode('api'),
      generateDailyTrack: builtCode('generate-daily-track'),
    };

    // La boundary la crea y revisa un paso de administración previo; este stack solo la referencia.
    // Se aplica a todos los roles del stack, incluidos los que se agreguen más adelante.
    const boundaryArn = new CfnParameter(this, 'RuntimePermissionsBoundaryArn', {
      type: 'String',
      allowedPattern: '^arn:aws:iam::[0-9]{12}:policy/[A-Za-z0-9+=,.@_/-]+$',
      description: 'ARN de la permissions boundary de runtime, creada previamente.',
    });
    iam.PermissionsBoundary.of(this).apply(
      iam.ManagedPolicy.fromManagedPolicyArn(this, 'RuntimeBoundary', boundaryArn.valueAsString),
    );

    // Un ítem por fecha: pk constante + sk = fecha. Permite GetItem por fecha, Query ordenado
    // para el historial y PutItem condicional (idempotencia). Escala de sobra: ~365 ítems/año.
    const table = new dynamodb.Table(this, 'TracksTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'date', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const commonFunctionProps = {
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      memorySize: 256,
      environment: {
        TRACKS_TABLE_NAME: table.tableName,
        NODE_OPTIONS: '--enable-source-maps',
      },
    };

    const apiLogs = this.logGroup('ApiLogs');
    const apiFunction = new lambda.Function(this, 'ApiFunction', {
      ...commonFunctionProps,
      code: code.api,
      timeout: Duration.seconds(10),
      role: this.runtimeRole('ApiRole', apiLogs),
      logGroup: apiLogs,
    });
    table.grant(apiFunction, 'dynamodb:GetItem', 'dynamodb:Query');

    const generateLogs = this.logGroup('GenerateDailyTrackLogs');
    const generateFunction = new lambda.Function(this, 'GenerateDailyTrackFunction', {
      ...commonFunctionProps,
      code: code.generateDailyTrack,
      timeout: Duration.seconds(60),
      role: this.runtimeRole('GenerateDailyTrackRole', generateLogs),
      logGroup: generateLogs,
    });
    table.grant(generateFunction, 'dynamodb:GetItem', 'dynamodb:PutItem');

    const httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      apiName: '365-tracks-api',
      createDefaultStage: false,
      ...(config.corsAllowedOrigins.length > 0 && {
        corsPreflight: {
          allowOrigins: config.corsAllowedOrigins,
          allowMethods: [apigwv2.CorsHttpMethod.GET],
          allowHeaders: ['content-type'],
          maxAge: Duration.days(1),
        },
      }),
    });
    const integration = new HttpLambdaIntegration('ApiIntegration', apiFunction);
    for (const path of API_ROUTES) {
      httpApi.addRoutes({ path, methods: [apigwv2.HttpMethod.GET], integration });
    }
    const stage = new apigwv2.HttpStage(this, 'DefaultStage', {
      httpApi,
      stageName: '$default',
      autoDeploy: true,
      throttle: THROTTLE,
    });

    const schedulerRole = new iam.Role(this, 'SchedulerRole', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
    });
    generateFunction.grantInvoke(schedulerRole);

    const { hour, minute } = config.publishTime;
    new scheduler.CfnSchedule(this, 'DailyTrackSchedule', {
      description: 'Dispara la generación de la canción diaria (hora UTC configurable).',
      scheduleExpression: `cron(${minute} ${hour} * * ? *)`,
      scheduleExpressionTimezone: 'UTC',
      flexibleTimeWindow: { mode: 'OFF' },
      state: config.scheduleEnabled ? 'ENABLED' : 'DISABLED',
      target: {
        arn: generateFunction.functionArn,
        roleArn: schedulerRole.roleArn,
        input: JSON.stringify({ source: 'eventbridge-scheduler' }),
        // El proceso es idempotente: reintentar es seguro, pero se acota el default (24 h).
        retryPolicy: { maximumRetryAttempts: 2, maximumEventAgeInSeconds: 3600 },
      },
    });

    new CfnOutput(this, 'ApiUrl', { value: stage.url });
    new CfnOutput(this, 'TracksTableName', { value: table.tableName });
  }

  /** Rol propio y mínimo: solo escribe en su log group (sin AWSLambdaBasicExecutionRole). */
  private runtimeRole(id: string, logGroup: logs.LogGroup): iam.Role {
    const role = new iam.Role(this, id, {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });
    logGroup.grantWrite(role);
    return role;
  }

  private logGroup(id: string): logs.LogGroup {
    return new logs.LogGroup(this, id, {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });
  }
}
