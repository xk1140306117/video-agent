import { NextResponse } from "next/server";
import { listJobs } from "@/lib/job-store";

export async function GET() {
  return NextResponse.json(await listJobs());
}
