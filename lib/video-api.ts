import crypto from "node:crypto";
const baseUrl = process.env.VIDEO_API_BASE_URL || "https://video.awesomeimg.cn";
const key = process.env.VIDEO_API_KEY;
const secret = process.env.VIDEO_API_SECRET;
export type CreateInput={brief:string;duration_sec:number;aspect_ratio:"16:9"|"9:16";resolution?:string;style?:string};
export async function videoRequest<T>(method:string,path:string,body?:BodyInit,headers:Record<string,string>={}):Promise<T>{
 if(!key||!secret) throw new Error("视频服务尚未配置：请设置 VIDEO_API_KEY 和 VIDEO_API_SECRET。");
 const bytes=body instanceof Uint8Array?Buffer.from(body):Buffer.from(typeof body==="string"?body:""); const ts=Math.floor(Date.now()/1000).toString(),nonce=crypto.randomUUID().replaceAll("-","");
 const payload=[method,path,ts,nonce,crypto.createHash("sha256").update(bytes).digest("hex")].join("\n");
 const signature=crypto.createHmac("sha256",secret).update(payload).digest("hex");
 const response=await fetch(baseUrl+path,{method,body,headers:{Accept:"application/json","X-Api-Key":key,"X-Timestamp":ts,"X-Nonce":nonce,"X-Signature":signature,...headers},cache:"no-store"});
 const data=await response.json().catch(()=>({})); if(!response.ok) throw new Error(data?.detail?.message||`视频服务错误 (${response.status})`); return data as T;
}
