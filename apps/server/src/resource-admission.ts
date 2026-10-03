import { open } from "node:fs/promises";
import path from "node:path";
import type { ResourceAdmissionDto } from "@ponderosa/core";

const MiB = 1024 * 1024;
export const RESOURCE_ADMISSION_DEFAULTS = { enabled: true, reserveBytes: 2048 * MiB, startupBytes: 256 * MiB,
  sampleMs: 2000, maxAgeMs: 10_000, deadlineMs: 500, recoverySamples: 2 } as const;
export interface ResourceSample { availableBytes: number; memoryFullPercent: number; ioFullPercent: number; source: "linux_host_and_cgroup" | "linux_host" }
export type ResourceAdmissionOptions = Partial<{ enabled: boolean; reserveBytes: number; startupBytes: number }>;

/** Read small kernel counters only, never start a diagnostic process. */
async function boundedRead(filename: string): Promise<string> {
  const file = await open(filename, "r");
  try { const buffer = Buffer.alloc(16 * 1024); const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead === buffer.length) throw Error("resource counter exceeded its bound");
    return buffer.toString("utf8", 0, bytesRead);
  } finally { await file.close(); }
}
function pressure(text: string): number {
  const match = text.match(/^full avg10=([\d.]+) /mu);
  if (!match || !Number.isFinite(Number(match[1])) || Number(match[1]) > 100) throw Error("invalid pressure counter");
  return Number(match[1]);
}
export async function sampleLinuxResources(): Promise<ResourceSample> {
  const [memory, memoryPressure, ioPressure, group] = await Promise.all([
    boundedRead("/proc/meminfo"), boundedRead("/proc/pressure/memory"), boundedRead("/proc/pressure/io"), boundedRead("/proc/self/cgroup")]);
  const available = memory.match(/^MemAvailable:\s+(\d+) kB$/mu);
  if (!available) throw Error("memory availability counter missing");
  let availableBytes = Number(available[1]) * 1024;
  let memoryFullPercent = pressure(memoryPressure), ioFullPercent = pressure(ioPressure);
  const relative = group.match(/^0::(\/[^\n]*)$/mu)?.[1];
  if (relative?.split("/").includes("..")) throw Error("unsupported cgroup namespace path");
  let hasCgroup = false;
  const slice = process.env.PONDEROSA_AGENT_WORKLOAD_SLICE ?? "ponderosa-agent-workloads.slice";
  if (slice.length > 255 || !/^[a-zA-Z0-9_.-]+\.slice$/u.test(slice)) throw Error("invalid workload slice");
  const names = slice.slice(0, -6).split("-");
  const slicePath = names.map((_, index) => `${names.slice(0, index + 1).join("-")}.slice`).join("/");
  const roots = relative ? [path.resolve("/sys/fs/cgroup", `.${relative}`), `/sys/fs/cgroup/user.slice/user-${process.getuid!()}.slice/user@${process.getuid!()}.service/${slicePath}`] : [];
  const seen = new Set<string>();
  for (const root of roots) {
    let current = root;
    for (let depth = 0; depth < 16 && (current === "/sys/fs/cgroup" || current.startsWith("/sys/fs/cgroup/")); depth++, current = path.dirname(current)) {
      if (seen.has(current)) continue; seen.add(current);
      try {
        const [maximum, high, used, mp, ip] = await Promise.all([boundedRead(`${current}/memory.max`), boundedRead(`${current}/memory.high`), boundedRead(`${current}/memory.current`), boundedRead(`${current}/memory.pressure`), boundedRead(`${current}/io.pressure`)]);
        const usage = Number(used.trim()); if (!Number.isSafeInteger(usage) || usage < 0) throw Error("invalid cgroup usage");
        for (const ceiling of [maximum.trim(), high.trim()]) if (ceiling !== "max") {
          const limit = Number(ceiling); if (!Number.isSafeInteger(limit) || limit <= 0) throw Error("invalid cgroup ceiling");
          availableBytes = Math.min(availableBytes, Math.max(0, limit - usage));
        }
        memoryFullPercent = Math.max(memoryFullPercent, pressure(mp)); ioFullPercent = Math.max(ioFullPercent, pressure(ip)); hasCgroup = true;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  }
  if (!Number.isSafeInteger(availableBytes) || availableBytes < 0) throw Error("invalid memory measurement");
  return { availableBytes, memoryFullPercent, ioFullPercent, source: hasCgroup ? "linux_host_and_cgroup" : "linux_host" };
}

/** One shared, coalesced observation. Unknown protection fails open explicitly;
 * an unresolved sampler cannot create a new sampler or strand accepted work. */
export class ResourceAdmission {
  private pending?: Promise<void>;
  private lastStarted = -Infinity;
  private held = false;
  private recovery = 0;
  private sample?: ResourceSample;
  private sampledAt?: number;
  private value: ResourceAdmissionDto;
  readonly config: { enabled: boolean; reserveBytes: number; startupBytes: number; sampleMs: number; maxAgeMs: number; deadlineMs: number; recoverySamples: number };
  constructor(options: ResourceAdmissionOptions = {}, private readonly load = sampleLinuxResources,
    private readonly now = Date.now, private readonly platform = process.platform,
    private readonly changed: () => void = () => {}) {
    this.config = { ...RESOURCE_ADMISSION_DEFAULTS, ...options };
    for (const key of ["reserveBytes", "startupBytes"] as const) if (!Number.isSafeInteger(this.config[key]) || this.config[key] < MiB || this.config[key] > 1024 ** 4) throw Error(`invalid resource admission ${key}`);
    this.value = { state: !this.config.enabled ? "disabled" : platform === "linux" ? "unavailable" : "unsupported", reason: this.config.enabled ? "measurement_unavailable" : "operator_disabled", protected: false };
  }
  snapshot(activeRuns = 0): ResourceAdmissionDto {
    if (this.sampledAt !== undefined && this.now() - this.sampledAt > this.config.maxAgeMs) return { state: "unavailable", reason: "measurement_stale", protected: false, observedAt: new Date(this.sampledAt).toISOString() };
    if (this.value.state === "ready" && this.sample && activeRuns >= Math.max(0, Math.floor((this.sample.availableBytes - this.config.reserveBytes) / this.config.startupBytes))) {
      return { ...this.value, state: "held", reason: "host_resource_pressure" };
    }
    return { ...this.value };
  }
  capacity(): number {
    if (!this.snapshot().protected || !this.sample) return Infinity;
    return this.held ? 0 : Math.max(0, Math.floor((this.sample.availableBytes - this.config.reserveBytes) / this.config.startupBytes));
  }
  async observe(): Promise<ResourceAdmissionDto> {
    if (!this.config.enabled || this.platform !== "linux") return this.snapshot();
    if (!this.pending && this.now() - this.lastStarted >= this.config.sampleMs) {
      this.lastStarted = this.now();
      const sampleStartedAt = this.lastStarted;
      const operation = Promise.resolve().then(this.load).then(sample => {
        if (!Number.isSafeInteger(sample.availableBytes) || sample.availableBytes < 0 ||
            ![sample.memoryFullPercent, sample.ioFullPercent].every(value => Number.isFinite(value) && value >= 0 && value <= 100)) throw Error("invalid resource observation");
        const previousCapacity = this.capacity();
        if (this.now() - sampleStartedAt > this.config.maxAgeMs) {
          const old = this.value.state;
          this.sample = undefined; this.sampledAt = sampleStartedAt; this.recovery = 0;
          this.value = { state: "unavailable", reason: "measurement_stale", protected: false, observedAt: new Date(sampleStartedAt).toISOString() };
          // Retain the last confirmed hold, but advertise no current protection.
          // Expired counters cannot count toward its healthy-sample recovery.
          if (old !== this.value.state || previousCapacity !== this.capacity()) this.changed();
          return;
        }
        this.sample = sample; this.sampledAt = sampleStartedAt;
        const minimum = this.config.reserveBytes + this.config.startupBytes;
        const pressured = sample.availableBytes < minimum || sample.memoryFullPercent >= 5 || sample.ioFullPercent >= 10;
        const recovered = sample.availableBytes >= minimum * 1.25 && sample.memoryFullPercent <= 1 && sample.ioFullPercent <= 2;
        if (pressured) { this.held = true; this.recovery = 0; }
        else if (this.held) { this.recovery = recovered ? this.recovery + 1 : 0; if (this.recovery >= this.config.recoverySamples) this.held = false; }
        const old = this.value.state;
        this.value = { state: this.held ? "held" : "ready", protected: true, reason: this.held ? "host_resource_pressure" : "within_budget",
          observedAt: new Date(this.sampledAt).toISOString(), source: sample.source, availableBytes: sample.availableBytes,
          reserveBytes: this.config.reserveBytes, startupBytes: this.config.startupBytes, memoryFullPercent: sample.memoryFullPercent, ioFullPercent: sample.ioFullPercent };
        if (old !== this.value.state || previousCapacity !== this.capacity()) this.changed();
      }).catch(() => { const old = this.value.state; this.sample = undefined; this.held = false; this.recovery = 0;
        this.value = { state: "unavailable", protected: false, reason: "measurement_unavailable" }; if (old !== this.value.state) this.changed();
      }).finally(() => { if (this.pending === operation) this.pending = undefined; });
      this.pending = operation;
    }
    if (this.pending) { let timer: NodeJS.Timeout | undefined; await Promise.race([this.pending, new Promise<void>(resolve => { timer = setTimeout(resolve, this.config.deadlineMs); })]); if (timer) clearTimeout(timer); }
    return this.snapshot();
  }
}
