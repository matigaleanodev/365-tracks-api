import type middy from '@middy/core';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { ErrorResponse } from './contracts.ts';
import { ApiError } from './errors.ts';
import { jsonResponse } from './http.ts';

type ApiMiddleware = middy.MiddlewareObj<APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2>;

/** Convierte cualquier error en el contrato ErrorResponse sin filtrar detalles internos. */
export function errorMiddleware(): ApiMiddleware {
  return {
    onError: (request) => {
      const requestId = request.event.requestContext?.requestId;
      const error = request.error;

      let apiError: ApiError;
      if (error instanceof ApiError) {
        apiError = error;
      } else {
        apiError = new ApiError('INTERNAL_ERROR', 500, 'Internal server error');
        console.error(
          JSON.stringify({
            event: 'unhandled-error',
            requestId,
            name: error instanceof Error ? error.name : typeof error,
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      }

      const body: ErrorResponse = {
        error: {
          code: apiError.code,
          message: apiError.message,
          ...(requestId ? { requestId } : {}),
        },
      };
      request.response = jsonResponse(apiError.statusCode, body);
    },
  };
}
