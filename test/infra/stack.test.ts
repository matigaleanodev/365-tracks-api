import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Code } from 'aws-cdk-lib/aws-lambda';
import { describe, expect, it } from 'vitest';
import type { StackConfig } from '../../infra/config.ts';
import {
  API_NAME,
  FUNCTIONS,
  roleArn,
  rolePolicies,
  SCHEDULE_NAME,
  TABLE_NAME,
} from '../../infra/delivery.ts';
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
  it('crea la API con el nombre que la política IAM de CloudFormation permite', () => {
    const apiNames = Object.values(synth().findResources('AWS::ApiGatewayV2::Api')).map(
      (resource) => (resource.Properties as { Name: string }).Name,
    );
    const allowed = rolePolicies().cloudformation.flatMap((statement) => {
      const condition = (statement as { Condition?: { StringEquals?: Record<string, string> } })
        .Condition;
      const name = condition?.StringEquals?.['apigateway:Request/ApiName'];
      return name ? [name] : [];
    });

    expect(allowed).toHaveLength(1);
    expect(apiNames).toEqual(allowed);
    expect(apiNames).toEqual([API_NAME]);
  });

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

  it('no crea ni modifica IAM: usa los roles precreados por la fundación', () => {
    const template = synth();
    for (const type of ['AWS::IAM::Role', 'AWS::IAM::Policy', 'AWS::IAM::ManagedPolicy']) {
      template.resourceCountIs(type, 0);
    }
    const roles = Object.values(template.findResources('AWS::Lambda::Function')).map(
      (fn) => fn.Properties.Role,
    );
    expect(roles.sort()).toEqual([roleArn('generate'), roleArn('http')]);
    template.hasResourceProperties('AWS::Scheduler::Schedule', {
      Name: SCHEDULE_NAME,
      Target: Match.objectLike({ RoleArn: roleArn('scheduler') }),
    });
  });

  it('usa nombres fijos que coinciden con los permisos de los roles', () => {
    const template = synth();
    template.hasResourceProperties('AWS::DynamoDB::Table', { TableName: TABLE_NAME });
    const names = Object.values(template.findResources('AWS::Lambda::Function'))
      .map((fn) => fn.Properties.FunctionName)
      .sort();
    expect(names).toEqual([FUNCTIONS.generate, FUNCTIONS.http].sort());
    const groups = Object.values(template.findResources('AWS::Logs::LogGroup'))
      .map((group) => group.Properties.LogGroupName)
      .sort();
    expect(groups).toEqual([`/aws/lambda/${FUNCTIONS.generate}`, `/aws/lambda/${FUNCTIONS.http}`]);
  });
});
