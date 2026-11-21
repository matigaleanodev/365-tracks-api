import { App, CliCredentialsStackSynthesizer } from 'aws-cdk-lib';
import { resolveStackConfig } from './config.ts';
import { ACCOUNT, ASSET_PREFIX, BUCKET, REGION, STACK } from './delivery.ts';
import { Tracks365ApiStack } from './tracks-api-stack.ts';

const app = new App();

// Sin bootstrap de CDK: los assets van al bucket de la fundación, bajo el prefijo del stack,
// con las credenciales del CLI (rol `prepare`). Cuenta y región fijas para no depender del perfil.
new Tracks365ApiStack(app, 'Tracks365ApiStack', {
  stackName: STACK,
  env: { account: ACCOUNT, region: REGION },
  synthesizer: new CliCredentialsStackSynthesizer({
    fileAssetsBucketName: BUCKET,
    bucketPrefix: ASSET_PREFIX,
  }),
  description: '365 Tracks API: canción diaria pública (API Gateway, Lambda, DynamoDB, Scheduler)',
  config: resolveStackConfig((key) => app.node.tryGetContext(key), process.env),
});
