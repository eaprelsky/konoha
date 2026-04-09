import { Hono } from "hono";
import { requireAuth } from "../../../src/middleware/auth";
import workflowsRouter from "./routes/workflows";
import { casesRouter, workitemsRouter, remindersRouter } from "./routes/cases";

const app = new Hono();

// Auth middleware for workflow-engine routes
app.use("/cases/*", requireAuth);
app.use("/cases", requireAuth);
app.use("/workitems/*", requireAuth);
app.use("/workitems", requireAuth);
app.use("/reminders/*", requireAuth);
app.use("/reminders", requireAuth);

// Mount workflow-engine routers
app.route("/workflows", workflowsRouter);
app.route("/cases", casesRouter);
app.route("/workitems", workitemsRouter);
app.route("/reminders", remindersRouter);

export default app;
