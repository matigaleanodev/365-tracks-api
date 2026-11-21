import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Code } from 'aws-cdk-lib/aws-lambda';
import { describe, expect, it } from 'vitest';
import type { StackConfig } from '../../infra/config.ts';
import { Tracks365ApiStack } from '../../infra/tracks-api-stack.ts';

const baseConfig: StackConfig = {
  corsAllowedOrigins: ['https://365tracks.example'],
  publishTime: { hour: 0, minute: 5 },
  scheduleEnabled: false,
};

function synth(config: StackConfig = baseConfig): Template {
  const app = new App();
  const stack = new Tracks365ApiStack(app, 'TestStack', {
    config,
    code: { api: Code.fromInline('x'), generateDailyTrack: Code.fromInline('x') },
  });
  return Template.fromStack(stack);
}

describe('Tracks365ApiStack', () => {
  it('define la tabla con clave por fecha, on-demand, PITR y retención', () => {
    const template = synth();
    template.hasResource('AWS::DynamoDB::Table', {
      Properties: {
        KeySchema: [
          { AttributeName: 'pk', KeyType: 'HASH' },
          { AttributeName: 'date', KeyType: 'RANGE' },
        ],
        BillingMode: 'PAY_PER_REQUEST',
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      },
      DeletionPolicy: 'Retain',
    });
  });

  it('crea dos Lambdas ARM64 con Node.js 24', () => {
    const template = synth();
    template.resourceCountIs('AWS::Lambda::Function', 2);
    template.allResourcesProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs24.x',
      Architectures: ['arm64'],
    });
  });

  it('expone solo las tres rutas GET, sin comodines', () => {
    const template = synth();
    const routes = template.findResources('AWS::ApiGatewayV2::Route');
    const keys = Object.values(routes)
      .map((route) => route.Properties.RouteKey)
      .sort();
    expect(keys).toEqual(['GET /api/tracks', 'GET /api/tracks/today', 'GET /api/tracks/{date}']);
    for (const route of Object.values(routes)) {
      expect(route.Properties.AuthorizationType).toBe('NONE');
    }
  });

  it('configura CORS desde la configuración y lo omite si está vacía', () => {
    synth().hasResourceProperties('AWS::ApiGatewayV2::Api', {
      CorsConfiguration: Match.objectLike({
        AllowOrigins: ['https://365tracks.example'],
        AllowMethods: ['GET'],
      }),
    });
    synth({ ...baseConfig, corsAllowedOrigins: [] }).hasResourceProperties(
      'AWS::ApiGatewayV2::Api',
      {
        CorsConfiguration: Match.absent(),
      },
    );
  });

  it('programa la generación en UTC y permite deshabilitarla', () => {
    synth().hasResourceProperties('AWS::Scheduler::Schedule', {
      ScheduleExpression: 'cron(5 0 * * ? *)',
      ScheduleExpressionTimezone: 'UTC',
      State: 'DISABLED',
      FlexibleTimeWindow: { Mode: 'OFF' },
    });
    synth({ ...baseConfig, scheduleEnabled: true }).hasResourceProperties(
      'AWS::Scheduler::Schedule',
      {
        State: 'ENABLED',
      },
    );
  });

  it('otorga permisos mínimos sobre la tabla a cada Lambda', () => {
    const template = synth();
    const actions = Object.values(template.findResources('AWS::IAM::Policy')).flatMap((policy) =>
      policy.Properties.PolicyDocument.Statement.flatMap(
        (statement: { Action: string | string[] }) => [statement.Action].flat(),
      ),
    );
    expect(actions).toContain('dynamodb:PutItem');
    expect(actions).toContain('dynamodb:Query');
    expect(actions).not.toContain('dynamodb:*');
    expect(actions).not.toContain('dynamodb:DeleteItem');
  });

  it('exige la boundary de runtime como parámetro y la aplica a todos los roles', () => {
    const template = synth();
    const parameter = template.toJSON().Parameters.RuntimePermissionsBoundaryArn;
    expect(parameter.Type).toBe('String');
    expect(parameter.Default).toBeUndefined();
    expect(parameter.AllowedPattern).toContain('arn:aws:iam::');

    const roles = Object.values(template.findResources('AWS::IAM::Role'));
    expect(roles).toHaveLength(3);
    for (const role of roles) {
      expect(role.Properties.PermissionsBoundary).toEqual({ Ref: 'RuntimePermissionsBoundaryArn' });
    }
  });

  it('los roles de Lambda no usan managed policies y escriben solo en su log group', () => {
    const template = synth();
    const lambdaRoles = Object.values(template.findResources('AWS::IAM::Role')).filter(
      (role) =>
        role.Properties.AssumeRolePolicyDocument.Statement[0].Principal.Service ===
        'lambda.amazonaws.com',
    );
    expect(lambdaRoles).toHaveLength(2);
    for (const role of lambdaRoles) {
      expect(role.Properties.ManagedPolicyArns).toBeUndefined();
    }

    const statements = Object.values(template.findResources('AWS::IAM::Policy')).flatMap(
      (policy) =>
        policy.Properties.PolicyDocument.Statement as {
          Action: string | string[];
          Resource: unknown;
        }[],
    );
    const logStatements = statements.filter((statement) =>
      [statement.Action].flat().some((action) => action.startsWith('logs:')),
    );
    expect(logStatements).toHaveLength(2);
    for (const statement of logStatements) {
      expect([statement.Action].flat().sort()).toEqual([
        'logs:CreateLogStream',
        'logs:PutLogEvents',
      ]);
      expect(statement.Resource).not.toBe('*');
    }
  });
});
