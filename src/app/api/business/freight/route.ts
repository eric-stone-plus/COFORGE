import { createBusinessPost } from "../_shared";
import { executeFreightRequest } from "../../../../lib/business/freight";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = createBusinessPost(executeFreightRequest, "Freight");
