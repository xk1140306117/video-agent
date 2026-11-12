import { promises as fs } from "node:fs";
import path from "node:path";

const storeDirectory = path.join(process.cwd(), ".video-agent");
const storeFile = path.join(storeDirectory, "jobs.json");
const historyLimit = 20;

export type StoredJob = {
  job_id: string;
  status: string;
  progress?: number;
  brief: string;
  duration_sec?: number;
  aspect_ratio?: string;
  resolution?: string;
  video?: { url?: string; duration_sec?: number; size_bytes?: number };
  error?: { message?: string };
  timings?: { created_at?: string; finished_at?: string };
};

type JobFallback = Pick<StoredJob, "brief" | "duration_sec" | "aspect_ratio" | "resolution">;
let writeQueue = Promise.resolve();

function compactJob(value: unknown, fallback?: Partial<JobFallback>): StoredJob | null {
  if (!value || typeof value !== "object") return null;
  const job = value as Record<string, unknown>;
  if (typeof job.job_id !== "string" || typeof job.status !== "string") return null;
  const video = job.video && typeof job.video === "object" ? job.video as StoredJob["video"] : undefined;
  const error = job.error && typeof job.error === "object" ? job.error as StoredJob["error"] : undefined;
  const timings = job.timings && typeof job.timings === "object" ? job.timings as StoredJob["timings"] : undefined;
  return {
    job_id: job.job_id,
    status: job.status,
    progress: typeof job.progress === "number" ? job.progress : undefined,
    brief: typeof job.brief === "string" ? job.brief : fallback?.brief || "未命名视频",
    duration_sec: typeof job.duration_sec === "number" ? job.duration_sec : fallback?.duration_sec,
    aspect_ratio: typeof job.aspect_ratio === "string" ? job.aspect_ratio : fallback?.aspect_ratio,
    resolution: typeof job.resolution === "string" ? job.resolution : fallback?.resolution,
    video,
    error,
    timings,
  };
}

async function readStore(): Promise<StoredJob[]> {
  try {
    const source = await fs.readFile(storeFile, "utf8");
    const parsed = JSON.parse(source) as unknown;
    return Array.isArray(parsed) ? parsed.map((job) => compactJob(job)).filter((job): job is StoredJob => job !== null) : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function listJobs(): Promise<StoredJob[]> {
  await writeQueue;
  return readStore();
}

export function recordJob(value: unknown, fallback?: Partial<JobFallback>): Promise<StoredJob | null> {
  const record = compactJob(value, fallback);
  if (!record) return Promise.resolve(null);
  const operation = writeQueue.then(async () => {
    const current = await readStore();
    const existing = current.find((job) => job.job_id === record.job_id);
    const merged = { ...existing, ...record, video: record.video || existing?.video, error: record.error || existing?.error, timings: record.timings || existing?.timings };
    const next = [merged, ...current.filter((job) => job.job_id !== record.job_id)].slice(0, historyLimit);
    await fs.mkdir(storeDirectory, { recursive: true });
    await fs.writeFile(storeFile, JSON.stringify(next, null, 2), "utf8");
    return merged;
  });
  writeQueue = operation.then(() => undefined, () => undefined);
  return operation;
}
