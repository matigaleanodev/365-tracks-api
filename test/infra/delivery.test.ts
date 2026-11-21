import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { adminDocuments } from '../../infra/admin-documents.ts';
import {
  BUCKET,
  CEILING,
  ceilingPolicy,
  foundationCloudformationPolicy,
  foundationPipelinePolicy,
  githubTrust,
  ROLE_NAMES,
  rolePolicies,
  roleArn,
} from '../../infra/delivery.ts';
import { FoundationStack } from '../../infra/foundation-stack.ts';

type Statement = { Action: string[]; Resource: string[]; Condition?: unknown };
const statements = (document: unknown) => (document as { Statement: Statement[] }).Statement;

describe('modelo de entrega', () => {
  it('ningún rol de aplicación o pipeline administra IAM salvo PassRole acotado', () => {
    for (const [name, list] of Object.entries(rolePolicies())) {
      for (const statement of list as Statement[]) {
        for (const action of statement.Action) {
          if (action.startsWith('iam:')) {
            expect(action, name).toBe('iam:PassRole');
            expect(statement.Condition, name).toBeDefined();
          }
        }
        // Solo `logs:DescribeLogGroups` admite comodín (no soporta recurso), acotado por región.
        if (statement.Resource.includes('*')) {
          expect(statement.Action, name).toEqual(['logs:DescribeLogGroups']);
          expect(statement.Condition, name).toBeDefined();
        }
      }
    }
  });

  it('el ceiling es exactamente la unión de las políticas de los roles', () => {
    const union = Object.values(rolePolicies()).flat();
    expect(statements(ceilingPolicy())).toEqual(union);
  });

  it('los roles de pipeline solo los asumen entornos de GitHub distintos', () => {
    const subject = (name: 'prepare' | 'execute') =>
      JSON.stringify(rolePolicies()[name]) && roleTrustSubject(name);
    expect(subject('prepare')).toMatch(/@1466117945:environment:plan$/);
    expect(subject('execute')).toMatch(/@1466117945:environment:production$/);
  });

  it('la fundación crea solo roles bajo boundary y un bucket privado retenido', () => {
    const template = Template.fromStack(new FoundationStack(new App(), 'Foundation'));
    const roles = Object.values(template.findResources('AWS::IAM::Role'));
    expect(roles).toHaveLength(ROLE_NAMES.length);
    for (const role of roles) {
      expect(role.Properties.PermissionsBoundary).toBe(CEILING);
    }
    template.hasResource('AWS::S3::Bucket', {
      Properties: {
        BucketName: BUCKET,
        PublicAccessBlockConfiguration: { BlockPublicPolicy: true, RestrictPublicBuckets: true },
      },
      DeletionPolicy: 'Retain',
    });
    expect(JSON.stringify(template.toJSON()).length).toBeLessThan(51_200);
  });

  it('el rol de CloudFormation de la fundación solo crea roles con la boundary', () => {
    const create = statements(foundationCloudformationPolicy()).find((statement) =>
      statement.Action.includes('iam:CreateRole'),
    );
    expect(create?.Resource).toEqual(ROLE_NAMES.map(roleArn));
    expect(create?.Condition).toEqual({ StringEquals: { 'iam:PermissionsBoundary': CEILING } });
    expect(
      statements(foundationPipelinePolicy()).some((s) => s.Action.includes('iam:CreateRole')),
    ).toBe(false);
  });

  it('los documentos de administración versionados están al día (npm run admin:policies)', () => {
    for (const [name, document] of Object.entries(adminDocuments())) {
      const file = fileURLToPath(new URL(`../../deploy/admin/${name}`, import.meta.url));
      expect(JSON.parse(readFileSync(file, 'utf8')), name).toEqual(document);
    }
  });
});

function roleTrustSubject(name: 'prepare' | 'execute'): string {
  const environment = name === 'prepare' ? 'plan' : 'production';
  const trust = githubTrust(environment) as {
    Statement: { Condition: { StringEquals: Record<string, string> } }[];
  };
  return trust.Statement[0]!.Condition.StringEquals['token.actions.githubusercontent.com:sub']!;
}
