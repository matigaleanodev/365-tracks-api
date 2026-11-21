import { fileURLToPath } from 'node:url';
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import type { Construct } from 'constructs';
import type { StackConfig } from './config.ts';
import {
  API_NAME,
  FUNCTIONS,
  PLAYLIST_SCHEDULE_NAME,
  roleArn,
  SCHEDULE_NAME,
  SSM_PREFIX,
  TABLE_NAME,
  type RoleName,
} from './delivery.ts';

export interface LambdaCode {
  api: lambda.Code;
  generateDailyTrack: lambda.Code;
  syncPlaylist: lambda.Code;
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
      syncPlaylist: builtCode('sync-playlist'),
    };

    // Un ítem por fecha: pk constante + sk = fecha. Permite GetItem por fecha, Query ordenado
    // para el historial y PutItem condicional (idempotencia). Escala de sobra: ~365 ítems/año.
    const table = new dynamodb.Table(this, 'TracksTable', {
      tableName: TABLE_NAME,
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

    // Los roles los crea la fundación (con sus permisos mínimos y la boundary); este stack no
    // crea ni modifica IAM: los importa como inmutables, así que ningún `grant*` agrega nada.
    const apiFunction = new lambda.Function(this, 'ApiFunction', {
      ...commonFunctionProps,
      functionName: FUNCTIONS.http,
      code: code.api,
      timeout: Duration.seconds(10),
      role: this.importRole('ApiRole', 'http'),
      logGroup: this.logGroup('ApiLogs', FUNCTIONS.http),
    });

    // Reposición del catálogo. Cada fecha requiere llamadas a OpenAI y a Spotify con reintentos,
    // así que una invocación no intenta las 30: procesa un tope de fechas (CATALOG_MAX_NEW_PER_RUN)
    // y corta antes de vencer. 300 s deja margen para varias fechas con reintentos.
    const generateFunction = new lambda.Function(this, 'GenerateDailyTrackFunction', {
      ...commonFunctionProps,
      functionName: FUNCTIONS.generate,
      code: code.generateDailyTrack,
      timeout: Duration.seconds(300),
      environment: {
        ...commonFunctionProps.environment,
        SSM_PARAMETER_PREFIX: SSM_PREFIX,
        CATALOG_MAX_NEW_PER_RUN: '5',
      },
      role: this.importRole('GenerateDailyTrackRole', 'generate'),
      logGroup: this.logGroup('GenerateDailyTrackLogs', FUNCTIONS.generate),
    });

    // Sincronización de la playlist histórica: proceso independiente, con su propio rol.
    const playlistFunction = new lambda.Function(this, 'SyncPlaylistFunction', {
      ...commonFunctionProps,
      functionName: FUNCTIONS.playlist,
      code: code.syncPlaylist,
      timeout: Duration.seconds(120),
      environment: { ...commonFunctionProps.environment, SSM_PARAMETER_PREFIX: SSM_PREFIX },
      role: this.importRole('SyncPlaylistRole', 'playlist'),
      logGroup: this.logGroup('SyncPlaylistLogs', FUNCTIONS.playlist),
    });

    const httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      apiName: API_NAME,
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

    const { hour, minute } = config.publishTime;
    new scheduler.CfnSchedule(this, 'DailyTrackSchedule', {
      name: SCHEDULE_NAME,
      description:
        'Repone las fechas sin canción de la ventana de 30 días (hora UTC configurable).',
      scheduleExpression: `cron(${minute} ${hour} * * ? *)`,
      scheduleExpressionTimezone: 'UTC',
      flexibleTimeWindow: { mode: 'OFF' },
      state: config.scheduleEnabled ? 'ENABLED' : 'DISABLED',
      target: {
        arn: generateFunction.functionArn,
        roleArn: roleArn('scheduler'),
        input: JSON.stringify({ source: 'eventbridge-scheduler' }),
        // El proceso es idempotente: reintentar es seguro, pero se acota el default (24 h).
        retryPolicy: { maximumRetryAttempts: 2, maximumEventAgeInSeconds: 3600 },
      },
    });

    const playlistTime = config.playlistSyncTime;
    new scheduler.CfnSchedule(this, 'PlaylistSyncSchedule', {
      name: PLAYLIST_SCHEDULE_NAME,
      description:
        'Agrega a la playlist anual las canciones de días ya terminados en todas las zonas (>= 12:00 UTC).',
      scheduleExpression: `cron(${playlistTime.minute} ${playlistTime.hour} * * ? *)`,
      scheduleExpressionTimezone: 'UTC',
      flexibleTimeWindow: { mode: 'OFF' },
      state: config.playlistScheduleEnabled ? 'ENABLED' : 'DISABLED',
      target: {
        arn: playlistFunction.functionArn,
        roleArn: roleArn('scheduler'),
        input: JSON.stringify({ source: 'eventbridge-scheduler' }),
        // Sincronizar es idempotente (lee la playlist antes de agregar): reintentar es seguro.
        retryPolicy: { maximumRetryAttempts: 2, maximumEventAgeInSeconds: 3600 },
      },
    });

    new CfnOutput(this, 'ApiUrl', { value: stage.url });
    new CfnOutput(this, 'TracksTableName', { value: table.tableName });
  }

  private importRole(id: string, name: RoleName): iam.IRole {
    return iam.Role.fromRoleArn(this, id, roleArn(name), { mutable: false });
  }

  private logGroup(id: string, functionName: string): logs.LogGroup {
    return new logs.LogGroup(this, id, {
      logGroupName: `/aws/lambda/${functionName}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });
  }
}
