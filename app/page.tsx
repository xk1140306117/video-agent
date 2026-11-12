"use client";

import Image from "next/image";
import { ChangeEvent, useCallback, useEffect, useRef, useState } from "react";

type Asset = { key: string; name: string; description: string; has_ref?: boolean };
type Video = { url?: string; duration_sec?: number; size_bytes?: number };
type Job = {
  job_id: string;
  status: string;
  progress?: number;
  brief?: string;
  duration_sec?: number;
  aspect_ratio?: string;
  resolution?: string;
  video?: Video;
  assets?: Asset[];
  error?: { message?: string };
  timings?: { created_at?: string; finished_at?: string };
};
type View = "workspace" | "works";
type UploadedReference = { key: string; name: string; previewUrl: string };
type PendingReference = { id: string; file: File; previewUrl: string };

const terminal = ["done", "failed", "canceled"];
const pollIntervalMs = 4000;
const recentLimit = 4;
const referenceImageSize = { width: 96, height: 64 };
const maxReferenceCount = 8;
const allowedReferenceTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
const maxReferenceBytes = 20 * 1024 * 1024;
const label = (status: string) => ({ queued: "排队中", analyzing: "分析中", awaiting_assets: "等待素材", generating: "生成中", assembling: "合成中", done: "已完成", failed: "生成失败", canceled: "已取消" }[status] || status);
const statusText = (status: string) => ({ queued: "任务已创建，正在排队。", analyzing: "正在拆解创意和分镜。", awaiting_assets: "可上传参考图，也可以跳过直接生成。", generating: "正在生成视频，请稍候…", assembling: "正在合成成片。", done: "视频已生成完成。", failed: "生成失败，请查看服务返回的错误。", canceled: "任务已取消。" }[status] || "正在更新任务状态。");

export default function Home() {
  const [view, setView] = useState<View>("workspace");
  const [brief, setBrief] = useState("生成一段 8 秒的风景短视频：清晨的山间云海，阳光从云层中洒下，镜头缓慢推进至山脊，画面清新、治愈、具有电影感。");
  const [duration, setDuration] = useState("8");
  const [ratio, setRatio] = useState("16:9");
  const [resolution, setResolution] = useState("1080P");
  const [job, setJob] = useState<Job | null>(null);
  const [works, setWorks] = useState<Job[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [references, setReferences] = useState<UploadedReference[]>([]);
  const [pendingReferences, setPendingReferences] = useState<PendingReference[]>([]);
  const [referenceHint, setReferenceHint] = useState("可选，创建任务后会按服务返回的素材槽位自动上传。");
  const automaticUploadJob = useRef<string | null>(null);
  const jobId = job?.job_id;
  const jobStatus = job?.status;
  const taskInProgress = Boolean(job && !terminal.includes(job.status));

  const upsertWork = useCallback((next: Job) => {
    setWorks((current) => {
      const existing = current.find((work) => work.job_id === next.job_id);
      const merged = { ...existing, ...next, assets: next.assets || existing?.assets, video: next.video || existing?.video, error: next.error || existing?.error, timings: next.timings || existing?.timings };
      return [merged, ...current.filter((work) => work.job_id !== next.job_id)];
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function loadHistory() {
      const response = await fetch("/api/jobs/history");
      if (!response.ok) return;
      const saved = (await response.json()) as Job[];
      if (cancelled) return;
      setWorks(saved);
      const active = saved.find((work) => !terminal.includes(work.status));
      if (active) {
        setJob(active);
        setMessage(active.error?.message || statusText(active.status));
      }
      await Promise.all(saved.map(async (work) => {
        const latest = await fetch(`/api/jobs/${work.job_id}`);
        if (!latest.ok || cancelled) return;
        const next = (await latest.json()) as Job;
        upsertWork(next);
        if (active?.job_id === next.job_id) {
          setJob(next);
          setMessage(next.error?.message || statusText(next.status));
        }
      }));
    }
    void loadHistory();
    return () => { cancelled = true; };
  }, [upsertWork]);

  useEffect(() => {
    if (!jobId || !jobStatus || terminal.includes(jobStatus)) return;
    const timer = setInterval(async () => {
      const response = await fetch(`/api/jobs/${jobId}`);
      if (!response.ok) {
        setMessage("状态更新失败，正在重试。");
        return;
      }
      const next = (await response.json()) as Job;
      setJob(next);
      upsertWork(next);
      setMessage(next.error?.message || statusText(next.status));
    }, pollIntervalMs);
    return () => clearInterval(timer);
  }, [jobId, jobStatus, upsertWork]);

  async function create() {
    if (!brief.trim()) return;
    setBusy(true);
    setMessage("正在提交创意…");
    try {
      const response = await fetch("/api/jobs", {
        method: "POST",
        headers: { "content-type": "application/json", "x-idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ brief, duration_sec: Number(duration), aspect_ratio: ratio, resolution }),
      });
      const next = await response.json() as Job;
      if (!response.ok) throw new Error(next.error?.message || "创建任务失败。");
      setReferences([]);
      automaticUploadJob.current = null;
      setJob(next);
      upsertWork(next);
      setMessage(statusText(next.status));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "创建任务失败。");
    } finally {
      setBusy(false);
    }
  }

  async function start() {
    if (!job) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/jobs/${job.job_id}/start`, { method: "POST" });
      const next = await response.json() as Job;
      if (!response.ok) throw new Error(next.error?.message || "启动生成失败。");
      setJob(next);
      upsertWork(next);
      setMessage(statusText(next.status));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "启动生成失败。");
    } finally {
      setBusy(false);
    }
  }

  const uploadFile = useCallback(async (targetJob: Job, asset: Asset, file: File, previewUrl: string) => {
    const form = new FormData();
    form.set("file", file);
    const response = await fetch(`/api/jobs/${targetJob.job_id}/assets/${asset.key}`, { method: "POST", body: form });
    const next = await response.json() as Job;
    if (!response.ok) throw new Error(next.error?.message || "上传失败。");
    setJob(next);
    upsertWork(next);
    setReferences((current) => [...current.filter((reference) => reference.key !== asset.key), { key: asset.key, name: asset.name, previewUrl }]);
    return next;
  }, [upsertWork]);

  async function upload(asset: Asset, event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file || !job) return;
    setBusy(true);
    try {
      await uploadFile(job, asset, file, URL.createObjectURL(file));
      setMessage(`已上传 ${asset.name} 参考图。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "上传失败。");
    } finally {
      setBusy(false);
    }
  }

  function selectReferences(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files || []);
    const valid = files.filter((file) => allowedReferenceTypes.has(file.type) && file.size <= maxReferenceBytes);
    const available = maxReferenceCount - pendingReferences.length;
    const accepted = valid.slice(0, Math.max(available, 0));
    if (accepted.length) {
      setPendingReferences((current) => [...current, ...accepted.map((file) => ({ id: crypto.randomUUID(), file, previewUrl: URL.createObjectURL(file) }))]);
      setReferenceHint(`已选择 ${pendingReferences.length + accepted.length} 张参考图，生成任务后会自动上传。`);
    } else {
      setReferenceHint(`仅支持 ${maxReferenceCount} 张以内、单张 20MB 以内的 JPG、PNG 或 WEBP。`);
    }
    event.target.value = "";
  }

  function removePendingReference(id: string) {
    setPendingReferences((current) => current.filter((reference) => reference.id !== id));
  }

  useEffect(() => {
    if (!job || job.status !== "awaiting_assets" || !pendingReferences.length || automaticUploadJob.current === job.job_id) return;
    const slots = job.assets?.filter((asset) => !asset.has_ref) || [];
    if (!slots.length) return;
    automaticUploadJob.current = job.job_id;
    const queue = pendingReferences.slice(0, slots.length);
    void (async () => {
      setBusy(true);
      try {
        for (const [index, reference] of queue.entries()) await uploadFile(job, slots[index], reference.file, reference.previewUrl);
        setPendingReferences((current) => current.filter((reference) => !queue.some((item) => item.id === reference.id)));
        setMessage(`已自动上传 ${queue.length} 张参考图。`);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "参考图上传失败。");
      } finally {
        setBusy(false);
      }
    })();
  }, [job, pendingReferences, uploadFile]);

  const progress = job ? (job.progress ?? (job.status === "done" ? 100 : 0)) : 0;
  const estimate = Number(job?.duration_sec || duration) === 15 ? "预计 8–15 分钟" : "预计 2–5 分钟";

  return <main className="shell">
    <aside aria-label="主导航">{([ ["workspace", "⌂", "工作台"], ["works", "▷", "我的作品"] ] as const).map(([key, icon, name]) => <button key={key} className={view === key ? "active" : ""} onClick={() => setView(key)}>{icon} {name}</button>)}</aside>
    <section className="main">
      {view === "workspace" && <>
        <div className="top">
          <article className="panel create">
            <h1>新建视频</h1>
            <label>创意描述 <span>（用中文描述你想生成的视频内容）</span></label>
            <textarea value={brief} onChange={(event) => setBrief(event.target.value)} />
            <section className="reference-picker" aria-labelledby="reference-picker-title">
              <div className="reference-picker-heading"><div><strong id="reference-picker-title">参考图（可选）</strong><small>{referenceHint}</small></div><label className="reference-add">上传参考图<input type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={selectReferences} /></label></div>
              {pendingReferences.length > 0 && <div className="pending-reference-grid">{pendingReferences.map((reference, index) => <article className="pending-reference" key={reference.id}><Image unoptimized src={reference.previewUrl} alt={`待上传参考图 ${index + 1}`} width={referenceImageSize.width} height={referenceImageSize.height} /><button type="button" onClick={() => removePendingReference(reference.id)} aria-label={`移除待上传参考图 ${index + 1}`}>移除</button></article>)}</div>}
            </section>
            <div className="params">
              <Pick label="视频时长" value={duration} set={setDuration} options={["4", "6", "8", "15"]} />
              <Pick label="画面比例" value={ratio} set={setRatio} options={["16:9", "9:16"]} />
              <Pick label="清晰度" value={resolution} set={setResolution} options={["480P", "720P", "768P", "1080P"]} />
            </div>
            <button className="primary" disabled={busy || taskInProgress || !brief.trim()} onClick={create}>{busy ? "提交中…" : "开始生成"}</button>
          </article>
          <article className="panel task">
            <h1>本次任务</h1>
            {job && <>
              <div className="status" role="status" aria-live="polite">
                {!terminal.includes(job.status) && <i className="spin" aria-hidden="true" />}
                <b>{label(job.status)}{progress ? ` ${progress}%` : ""}</b>
                <div className="bar" aria-label={`当前进度 ${progress}%`}><span style={{ width: `${progress}%` }} /></div>
                <p>{message}</p>
                {taskInProgress && job.status !== "awaiting_assets" && <small className="estimate">{estimate}</small>}
              </div>
              {job.status === "awaiting_assets" && <>
                <h2>可选参考图</h2>
                {job.assets?.map((asset) => <label className="upload" key={asset.key}>{asset.name}：{asset.description}<input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => upload(asset, event)} /></label>)}
                <button className="secondary" disabled={busy} onClick={start}>跳过参考图并开始生成</button>
              </>}
              {references.length > 0 && <section className="reference-info">
                <h2>参考信息</h2>
                {references.map((reference) => <div className="ref" key={reference.key}><Image unoptimized src={reference.previewUrl} alt={`${reference.name}参考图`} width={referenceImageSize.width} height={referenceImageSize.height} /><div><strong>{reference.name}</strong><small>已上传并用于本次任务</small></div></div>)}
              </section>}
              {job.video?.url && <a className="download" href={job.video.url} target="_blank" rel="noreferrer">查看成片</a>}
            </>}
          </article>
        </div>
        <Recent works={works} />
      </>}
      {view === "works" && <section className="panel standalone"><h1>我的作品</h1><WorkGallery works={works} emptyText="还没有生成视频。" /></section>}
    </section>
  </main>;
}

function Pick({ label, value, set, options }: { label: string; value: string; set: (value: string) => void; options: string[] }) {
  return <label className="select">{label}<select value={value} onChange={(event) => set(event.target.value)}>{options.map((option) => <option key={option}>{option}{label === "视频时长" ? " 秒" : ""}</option>)}</select></label>;
}

function WorkGallery({ works, emptyText }: { works: Job[]; emptyText: string }) {
  if (!works.length) return <div className="empty">{emptyText}</div>;
  return <div className="work-gallery">{works.map((work, index) => <article className="work-card" key={work.job_id}>
    {work.video?.url ? <video className="work-video" controls preload="metadata" aria-label={`作品 ${index + 1}`}><source src={work.video.url} type="video/mp4" />当前浏览器不支持视频播放。</video> : <div className="work-placeholder">{label(work.status)}</div>}
    <div className="work-card-meta"><b>作品 {String(index + 1).padStart(2, "0")}</b><span className="work-meta">{label(work.status)} · {work.duration_sec || "–"} 秒 · {work.aspect_ratio || "–"}</span></div>
  </article>)}</div>;
}

function Recent({ works }: { works: Job[] }) {
  return <section className="recent"><h1>最近的视频</h1><WorkGallery works={works.slice(0, recentLimit)} emptyText="尚无本地作品记录。生成后会直接显示在这里。" /></section>;
}
