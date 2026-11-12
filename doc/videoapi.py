"""AI 视频生成服务 · Python SDK（零第三方依赖，只用标准库）

用法：
    from videoapi import VideoAPI

    api = VideoAPI("https://video.awesomeimg.cn", api_key="sk-d7427676cf0b80d204e2c89882f619e0", api_secret="0e12731a5d2fd89605434571efa8c569774eba6578782b6b4ff9050be3b8ee6d")
    job = api.run("雨夜天台上两个人对峙", duration_sec=8, image="./hero.jpg")

    print(job["video"]["url"])

签名规则（与后端一致）：
    BODY_SHA256 = sha256(body)
    payload     = METHOD\nPATH\nTIMESTAMP\nNONCE\nBODY_SHA256
    signature   = hmac_sha256(api_secret, payload)

每次请求都换新的时间戳和 nonce，nonce 不能重复（后端防重放）。
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from typing import Callable

__all__ = ["VideoAPI", "VideoAPIError", "QuotaError", "TERMINAL"]

TERMINAL = ("done", "failed", "canceled")


class VideoAPIError(Exception):
    """接口返回的错误。code 是机器可读的错误码，message 是给人看的。"""

    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(f"[{status}] {code}: {message}")
        self.status = status
        self.code = code
        self.message = message


class QuotaError(VideoAPIError):
    """次数用完了（每日上限 / 并发上限）。稍后重试或联系服务方。"""


class VideoAPI:
    def __init__(
        self,
        base_url: str,
        api_key: str,
        api_secret: str,
        timeout: float = 120.0,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.api_secret = api_secret
        self.timeout = timeout

    # ---------------- 底层 ----------------
    def _sign(self, method: str, path: str, ts: str, nonce: str, body: bytes) -> str:
        body_hash = hashlib.sha256(body or b"").hexdigest()
        payload = "\n".join([method.upper(), path, ts, nonce, body_hash])
        return hmac.new(self.api_secret.encode(), payload.encode(), hashlib.sha256).hexdigest()

    def _request(
        self,
        method: str,
        path: str,
        *,
        body: bytes | None = None,
        content_type: str | None = None,
        query: dict | None = None,
        extra_headers: dict | None = None,
        signed: bool = True,
    ) -> tuple[int, bytes]:
        url = f"{self.base_url}{path}"
        if query:
            url += "?" + urllib.parse.urlencode(query)

        headers: dict[str, str] = {"Accept": "application/json"}
        if content_type:
            headers["Content-Type"] = content_type
        if body:
            headers["Content-Length"] = str(len(body))
        if extra_headers:
            headers.update(extra_headers)

        if signed:
            ts = str(int(time.time()))
            nonce = uuid.uuid4().hex
            headers.update(
                {
                    "X-Api-Key": self.api_key,
                    "X-Timestamp": ts,
                    "X-Nonce": nonce,
                    # 注意：签名用不带 query 的 path，和后端 request.url.path 一致
                    "X-Signature": self._sign(method, path, ts, nonce, body or b""),
                }
            )

        req = urllib.request.Request(url, data=body, headers=headers, method=method.upper())
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                return resp.status, resp.read()
        except urllib.error.HTTPError as exc:
            raw = exc.read()
            raise self._to_error(exc.code, raw) from None
        except urllib.error.URLError as exc:
            raise VideoAPIError(0, "network_error", f"连不上服务：{exc.reason}") from None

    @staticmethod
    def _to_error(status: int, raw: bytes) -> VideoAPIError:
        code, message = "http_error", raw[:300].decode("utf-8", "replace")
        try:
            data = json.loads(raw)
            detail = data.get("detail") if isinstance(data, dict) else None
            if isinstance(detail, dict):
                code = detail.get("code") or code
                message = detail.get("message") or message
            elif isinstance(data, dict):
                code = data.get("code") or code
                message = data.get("message") or message
        except Exception:
            pass
        cls = QuotaError if code in ("quota_exceeded", "too_many_active") else VideoAPIError
        return cls(status, code, message)

    def _json(self, method: str, path: str, payload: dict | None = None,
              query: dict | None = None, extra_headers: dict | None = None) -> dict:
        body = json.dumps(payload, ensure_ascii=False).encode() if payload is not None else None
        _, raw = self._request(
            method, path, body=body,
            content_type="application/json" if body else None,
            query=query, extra_headers=extra_headers,
        )
        if not raw:
            return {}
        return json.loads(raw)

    # ---------------- 业务 ----------------
    def create_job(
        self,
        brief: str,
        duration_sec: int = 8,
        aspect_ratio: str = "16:9",
        style: str = "",
        resolution: str = "",
        idempotency_key: str | None = None,
    ) -> dict:
        """提交一句需求，立刻返回 job_id（异步出片）。

        duration_sec 只支持 4 / 6 / 8 / 15 / 20 / 30（服务端会就近吸附）。
        idempotency_key 相同则返回同一条任务，网络抖动重试时务必带上。
        """
        payload = {
            "brief": brief,
            "duration_sec": duration_sec,
            "aspect_ratio": aspect_ratio,
            "style": style,
        }
        if resolution:
            payload["resolution"] = resolution
        headers = {"Idempotency-Key": idempotency_key} if idempotency_key else None
        return self._json("POST", "/v1/jobs", payload, extra_headers=headers)

    def get_job(self, job_id: str) -> dict:
        return self._json("GET", f"/v1/jobs/{job_id}")

    def get_storyboard(self, job_id: str) -> dict:
        return self._json("GET", f"/v1/jobs/{job_id}/storyboard")

    def list_assets(self, job_id: str) -> dict:
        return self._json("GET", f"/v1/jobs/{job_id}/assets")

    def upload_image(self, job_id: str, asset_key: str, image: str | bytes) -> dict:
        """给某个资产传参考图（20MB 以内，JPG/PNG/WEBP）。一个资产一张，重传即替换。"""
        data = image if isinstance(image, bytes) else open(image, "rb").read()
        ctype = _sniff_mime(data)
        if ctype is None:
            raise ValueError("只支持 JPG / PNG / WEBP")
        _, raw = self._request(
            "POST", f"/v1/jobs/{job_id}/assets/{asset_key}",
            body=data, content_type=ctype,
        )
        return json.loads(raw) if raw else {}

    def set_first_frame(self, job_id: str, asset_key: str, enabled: bool = True) -> dict:
        """标记这张图是否作为开场画面（首帧模式才用；多参考模式无需调用）。"""
        return self._json(
            "PATCH", f"/v1/jobs/{job_id}/assets/{asset_key}",
            {"use_as_first_frame": enabled},
        )

    def start(self, job_id: str) -> dict:
        """素材传完就调这个开始出片（不传图也要调）。"""
        return self._json("POST", f"/v1/jobs/{job_id}/start")

    def cancel(self, job_id: str) -> dict:
        return self._json("POST", f"/v1/jobs/{job_id}/cancel")

    def wait(
        self,
        job_id: str,
        interval: float = 3.0,
        timeout: float = 1800.0,
        stop_at: tuple[str, ...] = TERMINAL,
        on_progress: Callable[[dict], None] | None = None,
    ) -> dict:
        """轮询到终态（或命中 stop_at 里的状态）。

        stop_at 默认等 done/failed/canceled；
        传 ("awaiting_assets",) + TERMINAL 可以等到"该传图了"就返回。
        """
        deadline = time.time() + timeout
        while True:
            job = self.get_job(job_id)
            if on_progress:
                on_progress(job)
            if job.get("status") in stop_at:
                return job
            if time.time() > deadline:
                raise TimeoutError(f"等待超时（{timeout:.0f}s），最后状态 {job.get('status')}")
            time.sleep(interval)

    def download(self, job_id: str, out_path: str) -> str:
        """下载成片到本地。返回文件路径。"""
        job = self.get_job(job_id)
        video = job.get("video") or {}
        url = video.get("url")
        if not url:
            raise VideoAPIError(0, "no_video", f"任务状态是 {job.get('status')}，还没有成片")
        os.makedirs(os.path.dirname(os.path.abspath(out_path)) or ".", exist_ok=True)
        if url.startswith(self.base_url):
            # 本站文件：走同一套底层请求（/files 是公开的，不需要签名）
            _, raw = self._request("GET", urllib.parse.urlparse(url).path, signed=False)
        else:
            _, raw = self._fetch_absolute(url)
        with open(out_path, "wb") as f:
            f.write(raw)
        return out_path

    def _fetch_absolute(self, url: str) -> tuple[int, bytes]:
        with urllib.request.urlopen(url, timeout=self.timeout) as resp:
            return resp.status, resp.read()

    # ---------------- 一步到位 ----------------
    def run(
        self,
        brief: str,
        duration_sec: int = 8,
        aspect_ratio: str = "16:9",
        style: str = "",
        image: str | bytes | None = None,
        asset_key: str | None = None,
        on_progress: Callable[[dict], None] | None = None,
        save_to: str | None = None,
    ) -> dict:
        """提交 → （可选传图）→ 开始 → 等出片 → 可选下载。

        image 给了但没给 asset_key 时，自动挂到第一个"人物"资产上
        （没有人物类型就挂到第一个资产）。
        """
        job = self.create_job(brief, duration_sec, aspect_ratio, style)
        job_id = job["job_id"]

        # 等分镜出来（要么该传图，要么已经直接开始生成）
        job = self.wait(job_id, stop_at=("awaiting_assets",) + TERMINAL, on_progress=on_progress)
        if job["status"] == "awaiting_assets":
            if image is not None:
                key = asset_key or _pick_character_key(job.get("assets") or [])
                if key:
                    self.upload_image(job_id, key, image)
            self.start(job_id)

        job = self.wait(job_id, on_progress=on_progress)
        if job.get("status") == "done" and save_to:
            self.download(job_id, save_to)
            job["saved_to"] = save_to
        return job


def _pick_character_key(assets: list[dict]) -> str | None:
    for a in assets:
        if a.get("type") == "character":
            return a.get("key")
    return assets[0].get("key") if assets else None


def _sniff_mime(data: bytes) -> str | None:
    if data.startswith(b"\x89PNG"):
        return "image/png"
    if data.startswith(b"\xff\xd8"):
        return "image/jpeg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None
