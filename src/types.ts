// Shared Hono environment types — used by routers and auth middleware
export type CallerInfo = { isAdmin: boolean; agentId: string | null };

export type HonoVariables = { caller: CallerInfo };
export type HonoEnv = { Variables: HonoVariables };
