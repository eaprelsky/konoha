import { Hono } from "hono";
import { resolveFeatureFlags } from "../feature-flags";

const app = new Hono();

app.get("/", (c) => c.json(resolveFeatureFlags()));

export default app;
