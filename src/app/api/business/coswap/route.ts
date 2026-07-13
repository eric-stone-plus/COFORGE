import { createBusinessPost } from "../_shared";
import { executeCoswapRequest } from "../../../../lib/business/coswap";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = createBusinessPost(executeCoswapRequest, "COSWAP");
