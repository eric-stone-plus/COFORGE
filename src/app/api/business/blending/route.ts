import { createBusinessPost } from "../_shared";
import { executeBlendingRequest } from "../../../../lib/business/blending";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = createBusinessPost(executeBlendingRequest, "Blending");
