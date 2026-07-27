import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/server/domains/identity/auth";

export const { GET, POST } = toNextJsHandler(auth);
