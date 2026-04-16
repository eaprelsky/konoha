import { Hono } from "hono";
import { requireAuth } from "../../../src/middleware/auth";
import workflowsRouter from "./routes/workflows";
import { casesRouter, workitemsRouter, waitsRouter, remindersRouter } from "./routes/cases";

const app = new Hono();

// Auth middleware for workflow-engine routes
app.use("/cases/*", requireAuth);
app.use("/cases", requireAuth);
app.use("/workitems/*", requireAuth);
app.use("/workitems", requireAuth);
app.use("/waits/*", requireAuth);
app.use("/waits", requireAuth);
app.use("/reminders/*", requireAuth);
app.use("/reminders", requireAuth);

// Mount workflow-engine routers
app.route("/workflows", workflowsRouter);
app.route("/cases", casesRouter);
app.route("/workitems", workitemsRouter);
app.route("/waits", waitsRouter);
app.route("/reminders", remindersRouter);

export default app;
