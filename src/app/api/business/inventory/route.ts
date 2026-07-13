import { createBusinessPost } from "../_shared";
import { executeInventoryRequest } from "../../../../lib/business/inventory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = createBusinessPost(executeInventoryRequest, "Inventory");
