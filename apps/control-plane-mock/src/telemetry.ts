import {
  trace,
  context,
  propagation,
  ROOT_CONTEXT,
  SpanStatusCode,
  SpanKind,
  type Tracer,
  type Meter,
  type Span,
  type Context,
  TraceFlags,
} from '@opentelemetry/api';
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
  InMemorySpanExporter,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-base';
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  InMemoryMetricExporter,
  AggregationTemporality,
} from '@opentelemetry/sdk-metrics';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { W3CTraceContextPropagator } from '@opentelemetry/core';

// [LAB] Telemetria minima para observabilidade distribuida
// Nao representa arquitetura interna da TOTVS.

const SERVICE_NAME = 'cloud-control-plane-mock';

// Exporters em memoria para garantir testes deterministicos sem depender de rede
const memorySpanExporter = new InMemorySpanExporter();
const memoryMetricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
const memoryMetricReader = new PeriodicExportingMetricReader({
  exporter: memoryMetricExporter,
  exportIntervalMillis: 60_000,
});

let tracerProvider: BasicTracerProvider;
let meterProvider: MeterProvider;
let isInitialized = false;

// Metricas QE
let httpRequestsCounter: ReturnType<Meter['createCounter']>;
let httpErrorsCounter: ReturnType<Meter['createCounter']>;
let outboxPendingGauge: ReturnType<Meter['createUpDownCounter']>;
let outboxPublishFailuresCounter: ReturnType<Meter['createCounter']>;
let messagesProcessedCounter: ReturnType<Meter['createCounter']>;
let consumerFailuresCounter: ReturnType<Meter['createCounter']>;
let messageRedeliveriesCounter: ReturnType<Meter['createCounter']>;
let recoveryDurationHistogram: ReturnType<Meter['createHistogram']>;

export function initTelemetry(options?: {
  serviceName?: string;
  enableOtlp?: boolean;
  otlpEndpoint?: string;
}): void {
  if (isInitialized) return;

  const spanProcessors = [new SimpleSpanProcessor(memorySpanExporter)];

  const enableOtlp = options?.enableOtlp ?? (process.env.OTEL_EXPORTER_OTLP_ENDPOINT !== undefined);
  const otlpEndpoint = options?.otlpEndpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318';

  if (enableOtlp) {
    try {
      const otlpTraceExporter = new OTLPTraceExporter({
        url: `${otlpEndpoint}/v1/traces`,
        timeoutMillis: 1000,
      });
      spanProcessors.push(new SimpleSpanProcessor(otlpTraceExporter));
    } catch (err) {
      // Falha na conexao OTLP nao deve propagar erro para aplicacao
      console.warn('[LAB Telemetry] Warning: Failed to configure OTLP trace exporter:', err);
    }
  }

  tracerProvider = new BasicTracerProvider({
    spanProcessors,
  });

  trace.setGlobalTracerProvider(tracerProvider);
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());

  const readers = [memoryMetricReader];
  if (enableOtlp) {
    try {
      const otlpMetricExporter = new OTLPMetricExporter({
        url: `${otlpEndpoint}/v1/metrics`,
        timeoutMillis: 1000,
      });
      readers.push(
        new PeriodicExportingMetricReader({
          exporter: otlpMetricExporter,
          exportIntervalMillis: 5000,
        }),
      );
    } catch (err) {
      console.warn('[LAB Telemetry] Warning: Failed to configure OTLP metric exporter:', err);
    }
  }

  meterProvider = new MeterProvider({ readers });

  const meter = meterProvider.getMeter(SERVICE_NAME);

  // Criacao dos instrumentos de metricas de valor direto para QE
  httpRequestsCounter = meter.createCounter('http_requests_total', {
    description: 'Total de requisicoes HTTP recebidas pela API de controle',
  });

  httpErrorsCounter = meter.createCounter('http_errors_total', {
    description: 'Total de respostas HTTP com erro (4xx/5xx)',
  });

  outboxPendingGauge = meter.createUpDownCounter('outbox_pending_count', {
    description: 'Quantidade de eventos pendentes na tabela de outbox',
  });

  outboxPublishFailuresCounter = meter.createCounter('outbox_publish_failures_total', {
    description: 'Total de falhas durante publicacao do Outbox no NATS',
  });

  messagesProcessedCounter = meter.createCounter('messages_processed_total', {
    description: 'Total de mensagens processadas com sucesso pelo consumer',
  });

  consumerFailuresCounter = meter.createCounter('consumer_failures_total', {
    description: 'Total de falhas durante processamento da mensagem no consumer',
  });

  messageRedeliveriesCounter = meter.createCounter('message_redeliveries_total', {
    description: 'Total de mensagens recebidas novamente (reentrega/duplicata)',
  });

  recoveryDurationHistogram = meter.createHistogram('recovery_duration_seconds', {
    description: 'Duracao do ciclo de recuperacao apos falha distribuida',
    unit: 's',
  });

  isInitialized = true;
}

// Inicializa telemetria padrao imediatamente
initTelemetry();

export function getTracer(): Tracer {
  return trace.getTracer(SERVICE_NAME);
}

export function getMeter(): Meter {
  return meterProvider.getMeter(SERVICE_NAME);
}

// Helpers para inspecao em testes QE
export function getRecordedSpans(): ReadableSpan[] {
  return memorySpanExporter.getFinishedSpans();
}

export function clearRecordedSpans(): void {
  memorySpanExporter.reset();
}

export interface MetricSummary {
  name: string;
  value: number;
  attributes: Record<string, unknown>;
}

export async function getRecordedMetrics(): Promise<MetricSummary[]> {
  const collection = await memoryMetricReader.collect();
  const summaries: MetricSummary[] = [];

  const scopeMetrics = collection?.resourceMetrics?.scopeMetrics ?? [];
  for (const scope of scopeMetrics) {
    for (const metric of scope.metrics) {
      for (const dataPoint of metric.dataPoints) {
        summaries.push({
          name: metric.descriptor.name,
          value: typeof dataPoint.value === 'number' ? dataPoint.value : 1,
          attributes: (dataPoint.attributes as Record<string, unknown>) ?? {},
        });
      }
    }
  }

  return summaries;
}

export function clearRecordedMetrics(): void {
  memoryMetricExporter.reset();
}

// Helpers para propagacao de contexto W3C TraceContext
export function createTraceparent(traceId: string, spanId: string): string {
  return `00-${traceId}-${spanId}-01`;
}

export function parseTraceparent(traceparent?: string): { traceId: string; spanId: string } | undefined {
  if (!traceparent) return undefined;
  const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/i.exec(traceparent);
  if (!match) return undefined;
  return {
    traceId: match[1]!,
    spanId: match[2]!,
  };
}

export function extractContextFromTraceparent(traceparent?: string): Context {
  if (!traceparent) return ROOT_CONTEXT;
  const parsed = parseTraceparent(traceparent);
  if (!parsed) return ROOT_CONTEXT;

  return trace.setSpanContext(ROOT_CONTEXT, {
    traceId: parsed.traceId,
    spanId: parsed.spanId,
    traceFlags: TraceFlags.SAMPLED,
    isRemote: true,
  });
}

// Funcoes seguras de registro de metricas (resilientes, nunca lancam erro)
export function recordHttpRequest(method: string, route: string, statusCode: number): void {
  try {
    httpRequestsCounter?.add(1, { method, route, status_code: statusCode });
  } catch (err) {
    console.warn('[LAB Telemetry] Failed to record http request metric:', err);
  }
}

export function recordHttpError(
  method: string,
  route: string,
  statusCode: number,
  errorCode: string,
): void {
  try {
    httpErrorsCounter?.add(1, {
      method,
      route,
      status_code: statusCode,
      error_code: errorCode,
    });
  } catch (err) {
    console.warn('[LAB Telemetry] Failed to record http error metric:', err);
  }
}

export function recordOutboxPending(delta: number): void {
  try {
    outboxPendingGauge?.add(delta);
  } catch (err) {
    console.warn('[LAB Telemetry] Failed to record outbox pending metric:', err);
  }
}

export function recordOutboxPublishFailure(reason: string): void {
  try {
    outboxPublishFailuresCounter?.add(1, { reason });
  } catch (err) {
    console.warn('[LAB Telemetry] Failed to record outbox publish failure metric:', err);
  }
}

export function recordMessageProcessed(eventType: string, status: 'processed' | 'already_processed'): void {
  try {
    messagesProcessedCounter?.add(1, {
      event_type: eventType,
      status,
    });
  } catch (err) {
    console.warn('[LAB Telemetry] Failed to record message processed metric:', err);
  }
}

export function recordConsumerFailure(reason: string): void {
  try {
    consumerFailuresCounter?.add(1, { reason });
  } catch (err) {
    console.warn('[LAB Telemetry] Failed to record consumer failure metric:', err);
  }
}

export function recordMessageRedelivery(eventType: string): void {
  try {
    messageRedeliveriesCounter?.add(1, { event_type: eventType });
  } catch (err) {
    console.warn('[LAB Telemetry] Failed to record message redelivery metric:', err);
  }
}

export function recordRecoveryDuration(durationSeconds: number, scenario: string): void {
  try {
    recoveryDurationHistogram?.record(durationSeconds, { scenario });
  } catch (err) {
    console.warn('[LAB Telemetry] Failed to record recovery duration metric:', err);
  }
}

export { SpanStatusCode, SpanKind };
