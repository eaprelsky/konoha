import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "crypto";
import { dirname } from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { config } from "./config";

const AUTH_FILE = process.env.KONOHA_DASHBOARD_AUTH_FILE || "/opt/shared/.dashboard-auth.json";
const SESSION_COOKIE = "konoha_dash_session";
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

type DashboardAuthFile = {
  username: string;
  password_hash: string;
  updated_at: string;
};

type SessionPayload = {
  sub: string;
  exp: number;
  nonce: string;
};

export function dashboardSessionCookieName(): string {
  return SESSION_COOKIE;
}

export function dashboardAuthUsername(): string {
  return config.dashboard.user;
}

function sessionSecret(): string {
  if (!config.auth.adminToken || config.auth.adminToken === "konoha-dev-token") {
    throw new Error("KONOHA_TOKEN must be set to a strong value before dashboard sessions can be used");
  }
  return process.env.KONOHA_SESSION_SECRET || config.auth.adminToken;
}

function hashPassword(password: string, salt = randomBytes(16).toString("base64url")): string {
  const hash = scryptSync(password, salt, 64).toString("base64url");
  return `scrypt:${salt}:${hash}`;
}

function verifyHash(password: string, encoded: string): boolean {
  const [algo, salt, expected] = encoded.split(":");
  if (algo !== "scrypt" || !salt || !expected) return false;
  const actual = scryptSync(password, salt, 64);
  const expectedBuffer = Buffer.from(expected, "base64url");
  return actual.length === expectedBuffer.length && timingSafeEqual(actual, expectedBuffer);
}

function readAuthFile(): DashboardAuthFile | null {
  try {
    if (!existsSync(AUTH_FILE)) return null;
    return JSON.parse(readFileSync(AUTH_FILE, "utf-8")) as DashboardAuthFile;
  } catch {
    return null;
  }
}

function writeAuthFile(file: DashboardAuthFile): void {
  mkdirSync(dirname(AUTH_FILE), { recursive: true });
  writeFileSync(AUTH_FILE, JSON.stringify(file, null, 2), { mode: 0o600 });
}

export async function verifyDashboardPassword(username: string, password: string): Promise<boolean> {
  const expectedUser = dashboardAuthUsername();
  if (username !== expectedUser) return false;

  const file = readAuthFile();
  if (file?.password_hash) return verifyHash(password, file.password_hash);

  const bootstrapPassword = process.env.KONOHA_DASHBOARD_PASSWORD;
  if (!bootstrapPassword) return false;
  const ok = password === bootstrapPassword;
  if (ok) await setDashboardPassword(password);
  return ok;
}

export async function setDashboardPassword(password: string): Promise<void> {
  if (password.length < 12) throw new Error("Password must be at least 12 characters");
  writeAuthFile({
    username: dashboardAuthUsername(),
    password_hash: hashPassword(password),
    updated_at: new Date().toISOString(),
  });
}

export function createDashboardSession(username: string): string {
  const payload: SessionPayload = {
    sub: username,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
    nonce: randomBytes(16).toString("base64url"),
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", sessionSecret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyDashboardSessionToken(token: string | undefined): SessionPayload | null {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", sessionSecret()).update(body).digest("base64url");
  const actualBuffer = Buffer.from(sig);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf-8")) as SessionPayload;
    if (!payload.sub || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export function verifyDashboardCookie(cookieHeader: string | undefined): SessionPayload | null {
  const cookie = cookieHeader ?? "";
  const token = cookie
    .split(";")
    .map(part => part.trim())
    .find(part => part.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);
  return verifyDashboardSessionToken(token);
}

export const DASHBOARD_SESSION_TTL_SECONDS = SESSION_TTL_SECONDS;
