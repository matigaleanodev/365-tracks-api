import {
  BootstraplessSynthesizer,
  CfnOutput,
  RemovalPolicy,
  Stack,
  type StackProps,
} from 'aws-cdk-lib';
import { CfnRole } from 'aws-cdk-lib/aws-iam';
import { CfnBucket, CfnBucketPolicy } from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';
import {
  ACCOUNT,
  BUCKET,
  CEILING,
  FOUNDATION_STACK,
  policy,
  PREFIX,
  REGION,
  roleTrust,
  rolePolicies,
  ROLE_NAMES,
} from './delivery.ts';

/**
 * Fundación de entrega: bucket de assets y roles de runtime/pipeline. Sin assets ni bootstrap.
 * La IAM queda acotada por una boundary externa que este stack no puede editar.
 */
export class FoundationStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, {
      ...props,
      env: { account: ACCOUNT, region: REGION },
      stackName: FOUNDATION_STACK,
      description: '365 Tracks: bucket de assets y roles de entrega (sin recursos de aplicación)',
      synthesizer: new BootstraplessSynthesizer(),
    });

    const bucket = new CfnBucket(this, 'Assets', {
      bucketName: BUCKET,
      publicAccessBlockConfiguration: {
        blockPublicAcls: true,
        ignorePublicAcls: true,
        blockPublicPolicy: true,
        restrictPublicBuckets: true,
      },
      ownershipControls: { rules: [{ objectOwnership: 'BucketOwnerEnforced' }] },
      bucketEncryption: {
        serverSideEncryptionConfiguration: [
          { serverSideEncryptionByDefault: { sseAlgorithm: 'AES256' } },
        ],
      },
      versioningConfiguration: { status: 'Enabled' },
      lifecycleConfiguration: {
        rules: [
          {
            id: 'BoundPreviousVersions',
            status: 'Enabled',
            noncurrentVersionExpiration: { noncurrentDays: 30 },
            abortIncompleteMultipartUpload: { daysAfterInitiation: 1 },
          },
        ],
      },
    });
    bucket.applyRemovalPolicy(RemovalPolicy.RETAIN);
    new CfnBucketPolicy(this, 'AssetsPolicy', {
      bucket: bucket.ref,
      policyDocument: policy([
        {
          Effect: 'Deny',
          Principal: '*',
          Action: 's3:*',
          Resource: [`arn:aws:s3:::${BUCKET}`, `arn:aws:s3:::${BUCKET}/*`],
          Condition: { Bool: { 'aws:SecureTransport': 'false' } },
        },
      ]),
    });

    const policies = rolePolicies();
    for (const name of ROLE_NAMES) {
      const role = new CfnRole(this, `${name}Role`, {
        roleName: `${PREFIX}${name}`,
        permissionsBoundary: CEILING,
        assumeRolePolicyDocument: roleTrust(name),
        policies: [{ policyName: 'project', policyDocument: policy(policies[name]) }],
      });
      new CfnOutput(this, `${name}RoleArn`, { value: role.attrArn });
    }
    new CfnOutput(this, 'DeploymentBucket', { value: bucket.ref });
  }
}
