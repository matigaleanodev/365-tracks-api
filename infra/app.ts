import { App } from 'aws-cdk-lib';
import { resolveStackConfig } from './config.ts';
import { Tracks365ApiStack } from './tracks-api-stack.ts';

const app = new App();

// Sin `env`: el stack es agnóstico de cuenta y región; las define el perfil al desplegar.
new Tracks365ApiStack(app, 'Tracks365ApiStack', {
  description: '365 Tracks API: canción diaria pública (API Gateway, Lambda, DynamoDB, Scheduler)',
  config: resolveStackConfig((key) => app.node.tryGetContext(key), process.env),
});
