import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ApiError, ControlPlaneStoreInterface, CreateInstanceRequest } from './domain.js';
import { ControlPlaneStore } from './store.js';
import {
  getTracer,
  extractContextFromTraceparent,
  createTraceparent,
  recordHttpRequest,
  recordHttpError,
  SpanKind,
  SpanStatusCode,
} from './telemetry.js';

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

interface RequestContext {
  correlationId: string;
  requestId: string;
}

function contextFor(request: IncomingMessage): RequestContext {
  const rawCorrelationId = request.headers['x-correlation-id'];
  const correlationId = Array.isArray(rawCorrelationId)
    ? rawCorrelationId[0]
    : rawCorrelationId;
  return {
    correlationId: correlationId?.slice(0, 128) || randomUUID(),
    requestId: randomUUID(),
  };
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  context: RequestContext,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, {
    'content-type': JSON_CONTENT_TYPE,
    'x-correlation-id': context.correlationId,
    'x-request-id': context.requestId,
    ...headers,
  });
  response.end(JSON.stringify(body));
}

function sendError(
  response: ServerResponse,
  status: number,
  code: string,
  message: string,
  context: RequestContext,
  details?: ApiError['details'],
  method = 'UNKNOWN',
  route = 'UNKNOWN',
): void {
  recordHttpError(method, route, status, code);
  const body: ApiError = {
    code,
    message,
    correlationId: context.correlationId,
    requestId: context.requestId,
    ...(details ? { details } : {}),
  };
  sendJson(response, status, body, context);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 16_384) throw new Error('PAYLOAD_TOO_LARGE');
    chunks.push(buffer);
  }
  const source = Buffer.concat(chunks).toString('utf8');
  if (!source) throw new Error('EMPTY_BODY');
  return JSON.parse(source) as unknown;
}

function validateCreatePayload(value: unknown): {
  payload?: CreateInstanceRequest;
  details: Array<{ field: string; issue: string }>;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { details: [{ field: 'body', issue: 'must be a JSON object' }] };
  }

  const candidate = value as Record<string, unknown>;
  const details: Array<{ field: string; issue: string }> = [];
  const allowed = new Set(['name', 'region', 'image', 'flavor']);
  for (const key of Object.keys(candidate)) {
    if (!allowed.has(key)) details.push({ field: key, issue: 'is not allowed' });
  }

  if (typeof candidate.name !== 'string' || !/^[a-z][a-z0-9-]{2,39}$/.test(candidate.name)) {
    details.push({ field: 'name', issue: 'must match ^[a-z][a-z0-9-]{2,39}$' });
  }
  for (const [field, maximum] of [
    ['region', 64],
    ['image', 128],
    ['flavor', 64],
  ] as const) {
    const fieldValue = candidate[field];
    if (typeof fieldValue !== 'string' || fieldValue.length < 1 || fieldValue.length > maximum) {
      details.push({ field, issue: `must be a non-empty string up to ${maximum} characters` });
    }
  }

  if (details.length > 0) return { details };
  return {
    payload: {
      name: candidate.name as string,
      region: candidate.region as string,
      image: candidate.image as string,
      flavor: candidate.flavor as string,
    },
    details,
  };
}

export function createRequestHandler(store: ControlPlaneStoreInterface = new ControlPlaneStore()) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const context = contextFor(request);
    const url = new URL(request.url ?? '/', 'http://localhost');
    const method = request.method ?? 'GET';
    const route = url.pathname;

    const rawTraceparent = request.headers['traceparent'];
    const traceparentHeader = Array.isArray(rawTraceparent) ? rawTraceparent[0] : rawTraceparent;
    const parentContext = extractContextFromTraceparent(traceparentHeader);

    const tracer = getTracer();
    const span = tracer.startSpan(
      'http.request',
      {
        kind: SpanKind.SERVER,
        attributes: {
          'http.method': method,
          'http.route': route,
          correlation_id: context.correlationId,
          x_request_id: context.requestId,
        },
      },
      parentContext,
    );

    const spanContext = span.spanContext();
    const currentTraceparent = createTraceparent(spanContext.traceId, spanContext.spanId);

    response.on('finish', () => {
      span.setAttribute('http.status_code', response.statusCode);
      recordHttpRequest(method, route, response.statusCode);
      if (response.statusCode >= 400) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: `HTTP ${response.statusCode}` });
      } else {
        span.setStatus({ code: SpanStatusCode.OK });
      }
      span.end();
    });

    if (method === 'GET' && route === '/health') {
      sendJson(
        response,
        200,
        {
          status: 'ok',
          service: 'cloud-control-plane-mock',
          version: '0.2.0',
          timestamp: new Date().toISOString(),
        },
        context,
        { traceparent: currentTraceparent },
      );
      return;
    }

    if (method === 'POST' && route === '/v1/instances') {
      const rawIdempotencyKey = request.headers['idempotency-key'];
      const idempotencyKey = Array.isArray(rawIdempotencyKey)
        ? rawIdempotencyKey[0]
        : rawIdempotencyKey;
      if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 128) {
        sendError(
          response,
          400,
          'INVALID_REQUEST',
          'Request validation failed',
          context,
          [{ field: 'Idempotency-Key', issue: 'must contain between 8 and 128 characters' }],
          method,
          route,
        );
        return;
      }

      let rawPayload: unknown;
      try {
        rawPayload = await readJson(request);
      } catch (error) {
        const code = error instanceof Error && error.message === 'PAYLOAD_TOO_LARGE'
          ? 'PAYLOAD_TOO_LARGE'
          : 'INVALID_JSON';
        sendError(response, 400, code, 'Request body is not valid JSON', context, undefined, method, route);
        return;
      }

      const validation = validateCreatePayload(rawPayload);
      if (!validation.payload) {
        sendError(
          response,
          400,
          'INVALID_REQUEST',
          'Request validation failed',
          context,
          validation.details,
          method,
          route,
        );
        return;
      }

      const result = await store.createInstance(
        validation.payload,
        idempotencyKey,
        context.correlationId,
        currentTraceparent,
      );
      if (result.kind === 'conflict') {
        sendError(
          response,
          409,
          'IDEMPOTENCY_CONFLICT',
          'Idempotency-Key was already used with a different payload',
          context,
          undefined,
          method,
          route,
        );
        return;
      }

      sendJson(response, 202, result.operation, context, {
        location: `/v1/operations/${result.operation.id}`,
        'idempotency-replayed': result.kind === 'replayed' ? 'true' : 'false',
        traceparent: currentTraceparent,
      });
      return;
    }

    const instanceMatch = route.match(/^\/v1\/instances\/([^/]+)$/);
    if (method === 'GET' && instanceMatch) {
      const instance = await store.getInstance(decodeURIComponent(instanceMatch[1]!));
      if (!instance) {
        sendError(response, 404, 'INSTANCE_NOT_FOUND', 'Instance was not found', context, undefined, method, route);
        return;
      }
      sendJson(response, 200, instance, context, { traceparent: currentTraceparent });
      return;
    }

    const operationMatch = route.match(/^\/v1\/operations\/([^/]+)$/);
    if (method === 'GET' && operationMatch) {
      const operation = await store.getOperation(decodeURIComponent(operationMatch[1]!));
      if (!operation) {
        sendError(response, 404, 'OPERATION_NOT_FOUND', 'Operation was not found', context, undefined, method, route);
        return;
      }
      sendJson(response, 200, operation, context, { traceparent: currentTraceparent });
      return;
    }

    sendError(response, 404, 'ROUTE_NOT_FOUND', 'Route was not found', context, undefined, method, route);
  };
}
