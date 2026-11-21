import { App } from 'aws-cdk-lib';
import { FoundationStack } from './foundation-stack.ts';

const app = new App();
new FoundationStack(app, 'Tracks365Foundation');
