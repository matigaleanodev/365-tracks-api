import middy from '@middy/core';
import httpRouterHandler from '@middy/http-router';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { errorMiddleware } from './error-middleware.ts';
import { routeNotFound } from './errors.ts';
import { createRoutes, type ApiDependencies } from './routes.ts';

export function createApiHandler(dependencies: ApiDependencies) {
  return middy<APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2>()
    .use(errorMiddleware())
    .handler(
      httpRouterHandler<APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2>({
        routes: createRoutes(dependencies),
        notFoundResponse: () => {
          throw routeNotFound();
        },
      }),
    );
}
