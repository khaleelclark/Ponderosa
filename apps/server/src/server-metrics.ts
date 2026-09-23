import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { existsSync, statfsSync, statSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";

type StartupProfile = {
  totalMs: number;
  recoveryMs: number;
  projectCount: number;
};

type RequestAggregate = {
  count: number;
  durationSeconds: number;
  maximumSeconds: number;
  buckets: number[];
};

const HTTP_DURATION_BUCKETS_SECONDS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10,
] as const;

const metricLabel = (value: string): string => value
  .replaceAll("\\", "\\\\")
  .replaceAll("\n", "\\n")
  .replaceAll('"', '\\"');

const finite = (value: number): number => Number.isFinite(value) ? value : 0;

/** Process-local metrics authority. Labels are drawn only from registered route
 * patterns, methods, and status classes so untrusted URLs cannot create an
 * unbounded metric-cardinality sink. */
export class ServerMetrics {
  private readonly requests = new Map<string, RequestAggregate>();
  private readonly requestStarted = new WeakMap<object, number>();
  private readonly eventLoop = monitorEventLoopDelay({ resolution: 20 });
  private sseActive = 0;
  private sseOpenedTotal = 0;
  private sseBackpressureTotal = 0;
  private sseResetTotal = 0;

  constructor(
    private readonly dataDir: string,
    private readonly startup: StartupProfile,
  ) {
    this.eventLoop.enable();
  }

  install(app: FastifyInstance): void {
    app.addHook("onRequest", async (request, reply) => {
      this.requestStarted.set(request.raw, performance.now());
      reply.header("X-Request-Id", request.id);
    });
    app.addHook("onResponse", async (request, reply) => {
      const started = this.requestStarted.get(request.raw);
      if (started === undefined) return;
      this.requestStarted.delete(request.raw);
      const route = request.routeOptions.url || "unmatched";
      const statusClass = `${Math.floor(reply.statusCode / 100)}xx`;
      const key = `${request.method}\0${route}\0${statusClass}`;
      const duration = Math.max(0, performance.now() - started) / 1_000;
      const aggregate = this.requests.get(key) ?? {
        count: 0,
        durationSeconds: 0,
        maximumSeconds: 0,
        buckets: HTTP_DURATION_BUCKETS_SECONDS.map(() => 0),
      };
      aggregate.count += 1;
      aggregate.durationSeconds += duration;
      aggregate.maximumSeconds = Math.max(aggregate.maximumSeconds, duration);
      HTTP_DURATION_BUCKETS_SECONDS.forEach((upperBound, index) => {
        if (duration <= upperBound) aggregate.buckets[index]! += 1;
      });
      this.requests.set(key, aggregate);
    });
    app.addHook("onClose", async () => this.eventLoop.disable());
  }

  openSse(reset: boolean): () => void {
    this.sseActive += 1;
    this.sseOpenedTotal += 1;
    if (reset) this.sseResetTotal += 1;
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      this.sseActive = Math.max(0, this.sseActive - 1);
    };
  }

  sseBackpressure(): void {
    this.sseBackpressureTotal += 1;
  }

  render(input: {
    activeRuns: number;
    deploymentBlockers: number;
    browserCleanupPending: number;
    browserCleanupFailed: number;
  }): string {
    const memory = process.memoryUsage();
    const filesystem = statfsSync(this.dataDir);
    const database = path.join(this.dataDir, "ponderosa.db");
    const wal = `${database}-wal`;
    const lines = [
      "# HELP ponderosa_process_uptime_seconds Process uptime.",
      "# TYPE ponderosa_process_uptime_seconds gauge",
      `ponderosa_process_uptime_seconds ${finite(process.uptime())}`,
      "# HELP ponderosa_process_memory_bytes Process memory by kind.",
      "# TYPE ponderosa_process_memory_bytes gauge",
      `ponderosa_process_memory_bytes{kind=\"rss\"} ${memory.rss}`,
      `ponderosa_process_memory_bytes{kind=\"heap_used\"} ${memory.heapUsed}`,
      `ponderosa_process_memory_bytes{kind=\"heap_total\"} ${memory.heapTotal}`,
      "# HELP ponderosa_event_loop_delay_seconds Event-loop delay sampled by Node.",
      "# TYPE ponderosa_event_loop_delay_seconds gauge",
      `ponderosa_event_loop_delay_seconds{quantile=\"0.50\"} ${finite(this.eventLoop.percentile(50) / 1e9)}`,
      `ponderosa_event_loop_delay_seconds{quantile=\"0.99\"} ${finite(this.eventLoop.percentile(99) / 1e9)}`,
      `ponderosa_event_loop_delay_seconds{quantile=\"max\"} ${finite(this.eventLoop.max / 1e9)}`,
      "# HELP ponderosa_startup_duration_seconds Startup recovery timing.",
      "# TYPE ponderosa_startup_duration_seconds gauge",
      `ponderosa_startup_duration_seconds{phase=\"total\"} ${this.startup.totalMs / 1_000}`,
      `ponderosa_startup_duration_seconds{phase=\"recovery\"} ${this.startup.recoveryMs / 1_000}`,
      `ponderosa_startup_projects ${this.startup.projectCount}`,
      "# HELP ponderosa_storage_bytes Durable database and WAL size.",
      "# TYPE ponderosa_storage_bytes gauge",
      `ponderosa_storage_bytes{kind=\"database\"} ${existsSync(database) ? statSync(database).size : 0}`,
      `ponderosa_storage_bytes{kind=\"wal\"} ${existsSync(wal) ? statSync(wal).size : 0}`,
      `ponderosa_storage_free_bytes ${Number(filesystem.bavail) * Number(filesystem.bsize)}`,
      `ponderosa_active_runs ${input.activeRuns}`,
      `ponderosa_deployment_blockers ${input.deploymentBlockers}`,
      `ponderosa_browser_cleanup_pending ${input.browserCleanupPending}`,
      `ponderosa_browser_cleanup_failed ${input.browserCleanupFailed}`,
      "# HELP ponderosa_sse_connections Active and cumulative SSE connections.",
      "# TYPE ponderosa_sse_connections gauge",
      `ponderosa_sse_connections ${this.sseActive}`,
      `ponderosa_sse_opened_total ${this.sseOpenedTotal}`,
      `ponderosa_sse_backpressure_disconnects_total ${this.sseBackpressureTotal}`,
      `ponderosa_sse_resets_total ${this.sseResetTotal}`,
    ];
    for (const [key, aggregate] of [...this.requests.entries()].sort()) {
      const [method, route, statusClass] = key.split("\0") as [string, string, string];
      const labels = `method=\"${metricLabel(method)}\",route=\"${metricLabel(route)}\",status_class=\"${metricLabel(statusClass)}\"`;
      HTTP_DURATION_BUCKETS_SECONDS.forEach((upperBound, index) => {
        lines.push(
          `ponderosa_http_request_duration_seconds_bucket{${labels},le=\"${upperBound}\"} ${aggregate.buckets[index]}`,
        );
      });
      lines.push(
        `ponderosa_http_request_duration_seconds_bucket{${labels},le=\"+Inf\"} ${aggregate.count}`,
        `ponderosa_http_requests_total{${labels}} ${aggregate.count}`,
        `ponderosa_http_request_duration_seconds_sum{${labels}} ${aggregate.durationSeconds}`,
        `ponderosa_http_request_duration_seconds_count{${labels}} ${aggregate.count}`,
        `ponderosa_http_request_duration_seconds_max{${labels}} ${aggregate.maximumSeconds}`,
      );
    }
    return `${lines.join("\n")}\n`;
  }
}
