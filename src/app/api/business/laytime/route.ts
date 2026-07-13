import { createBusinessPost } from "../_shared";
import { executeLaytimeRequest } from "../../../../lib/business/laytime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = createBusinessPost(executeLaytimeRequest, "Laytime");
