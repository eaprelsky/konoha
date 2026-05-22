import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { createHash } from 'crypto';
import Redis from 'ioredis';

const AUTONOMY_KEY = 'konoha:config:autonomy';
const RUNTIME_EFFECT_KEY_PREFIX = 'runtime:effect:';
const RUNTIME_EFFECT_IDEMPOTENCY_KEY_PREFIX = 'runtime:effect:idempotency:';
const RUNTIME_EFFECT_STATUS_INDEX_PREFIX = 'runtime:effect:index:status:';
const RUNTIME_EFFECT_CASE_INDEX_PREFIX = 'runtime:effect:index:case:';
const RUNTIME_EFFECT_WORK_ITEM_INDEX_PREFIX = 'runtime:effect:index:work-item:';
const RUN = `browser-golden-${Date.now()}`;
const WORKFLOW_ID = `${RUN}-workflow`;
const ROLE_ID = `${RUN}-reviewer`;
const CHAT_ID = `${RUN}-chat`;
const RUN_SUBJECT = 'Browser golden run';

const redis = new Redis({
  host: '127.0.0.1',
  port: 6379,
  db: Number(process.env.REDIS_DB ?? '0'),
  maxRetriesPerRequest: 3,
});

const savedAutonomy: Record<string, string | null> = {};
const touchedWorkflows = new Set<string>();
const touchedRoles = new Set<string>();
const touchedCases = new Set<string>();
let adminToken = process.env.KONOHA_TOKEN ?? 'konoha-dev-token';
let apiBaseUrl = 'http://127.0.0.1:3202';

function workflowDefinition() {
  return {
    id: WORKFLOW_ID,
    version: '1.0.0',
    name: `Browser golden ${WORKFLOW_ID}`,
    elements: [
      { id: 'start', type: 'event', label: 'Start', x: 120, y: 140, trigger: { kind: 'manual', manual_override: true } },
      { id: 'review', type: 'function', label: 'Review request', x: 360, y: 140, role: ROLE_ID },
      { id: 'done', type: 'event', label: 'Done', x: 600, y: 140, trigger: { kind: 'manual', manual_override: true } },
    ],
    flow: [['start', 'review'], ['review', 'done']],
  };
}

function fixtureResponse(): string {
  return JSON.stringify({
    reply: 'Создала процесс, проверила готовность и открыла его в редакторе.',
    action_sequence: [
      {
        action: 'role.create',
        args: {
          role_id: ROLE_ID,
          name: 'Browser golden reviewer',
          assignees: [],
          strategy: 'manual',
        },
      },
      { action: 'workflow.create', args: { ...workflowDefinition(), draft: false } },
      { action: 'workflow.validate', args: { id: WORKFLOW_ID } },
    ],
  });
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function normalizeBaseUrl(raw: string | undefined): string {
  return (raw || 'http://127.0.0.1:3202').replace(/\/$/, '');
}

async function act(action: string, args: Record<string, unknown>) {
  const response = await fetch(`${apiBaseUrl}/api/act`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      action,
      category: 'act',
      args,
      meta: {
        session_id: `${RUN}-e2e`,
        agent_chain: 'browser-golden-path',
      },
    }),
  });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

async function cleanupRuntimeEffectsForCase(caseId: string) {
  const caseIndexKey = `${RUNTIME_EFFECT_CASE_INDEX_PREFIX}${caseId}`;
  const effectIds = await redis.zrange(caseIndexKey, 0, -1).catch(() => [] as string[]);
  const pipe = redis.pipeline();
  for (const effectId of effectIds) {
    const raw = await redis.get(`${RUNTIME_EFFECT_KEY_PREFIX}${effectId}`).catch(() => null);
    if (!raw) {
      pipe.zrem(caseIndexKey, effectId);
      continue;
    }

    let record: any;
    try {
      record = JSON.parse(raw);
    } catch {
      pipe.del(`${RUNTIME_EFFECT_KEY_PREFIX}${effectId}`);
      pipe.zrem(caseIndexKey, effectId);
      continue;
    }

    pipe.del(`${RUNTIME_EFFECT_KEY_PREFIX}${effectId}`);
    if (typeof record.idempotency_key === 'string') {
      pipe.del(`${RUNTIME_EFFECT_IDEMPOTENCY_KEY_PREFIX}${digest(record.idempotency_key)}`);
    }
    if (typeof record.status === 'string') {
      pipe.zrem(`${RUNTIME_EFFECT_STATUS_INDEX_PREFIX}${record.status}`, effectId);
    }
    if (typeof record.links?.work_item_id === 'string') {
      pipe.zrem(`${RUNTIME_EFFECT_WORK_ITEM_INDEX_PREFIX}${record.links.work_item_id}`, effectId);
    }
    pipe.zrem(caseIndexKey, effectId);
    pipe.del(`runtime:effect:lock:${effectId}`);
    pipe.del(`workitem:dispatch:delivered:${effectId}`);
  }
  pipe.del(caseIndexKey);
  await pipe.exec();
}

async function cleanup(request: APIRequestContext) {
  for (const caseId of touchedCases) {
    await cleanupRuntimeEffectsForCase(caseId).catch(() => {});
  }
  for (const workflowId of touchedWorkflows) {
    await request.delete(`/api/workflows/${encodeURIComponent(workflowId)}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    }).catch(() => {});
  }
  for (const roleId of touchedRoles) {
    await request.delete(`/api/roles/${encodeURIComponent(roleId)}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    }).catch(() => {});
  }
}

async function resolveAdminToken(request: APIRequestContext): Promise<string> {
  const candidates = Array.from(new Set([
    process.env.KONOHA_TOKEN,
    'konoha-dev-token',
  ].filter((value): value is string => Boolean(value))));

  for (const token of candidates) {
    const response = await request.get('/api/act', {
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => null);
    if (response?.ok()) return token;
  }

  throw new Error('No working admin token for local E2E /api/act route');
}

async function expandAssistant(page: Page) {
  await page.locator('.aw-trigger').click();
  await expect(page.locator('.aw-panel')).toBeVisible({ timeout: 10_000 });
}

test.describe.configure({ mode: 'serial' });

test.describe('Issue #747 browser golden path through AssistantWidget and ProcessEditor', () => {
  test.beforeAll(async ({ request, baseURL }) => {
    apiBaseUrl = normalizeBaseUrl(baseURL);
    adminToken = await resolveAdminToken(request);
    for (const action of ['role.create', 'workflow.create', 'workflow.validate']) {
      savedAutonomy[action] = await redis.hget(AUTONOMY_KEY, action);
      await redis.hset(AUTONOMY_KEY, action, 'auto');
    }
  });

  test.afterAll(async ({ request }) => {
    await cleanup(request);
    for (const [action, value] of Object.entries(savedAutonomy)) {
      if (value == null) await redis.hdel(AUTONOMY_KEY, action);
      else await redis.hset(AUTONOMY_KEY, action, value);
    }
    redis.disconnect();
  });

  test('creates, validates, deploys, runs, and monitors a workflow through visible UI flows', async ({ page }) => {
    test.setTimeout(60_000);
    touchedWorkflows.add(WORKFLOW_ID);
    touchedRoles.add(ROLE_ID);

    await page.addInitScript(() => {
      localStorage.setItem('konoha_dash_auth', '1');
      localStorage.setItem('konoha_dash_user', 'eaprelsky');
    });

    await page.route('**/api/**', async route => {
      const url = route.request().url();
      if (url.includes('/api/auth/me')) {
        await route.fulfill({
          status: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ authenticated: true, username: 'eaprelsky', isAdmin: true }),
        });
        return;
      }

      if (url.includes('/api/ai/chat')) {
        const invoke = await act('assistant.invoke', {
          assistant_id: 'tsunade',
          message: 'Create a deterministic review process',
          conversation_id: CHAT_ID,
          persist_history: false,
          fixture_response: fixtureResponse(),
        });
        expect(invoke.response.ok, JSON.stringify(invoke.body)).toBe(true);
        expect(invoke.body.ok, JSON.stringify(invoke.body)).toBe(true);

        const normalized = invoke.body.data.normalized_response;
        const parsedEvent = { type: 'parsed', ...normalized };
        await route.fulfill({
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'X-Chat-Id': CHAT_ID,
          },
          body: [
            `data: ${JSON.stringify({ type: 'chat_id', chat_id: CHAT_ID })}`,
            '',
            `data: ${JSON.stringify(parsedEvent)}`,
            '',
            'data: [DONE]',
            '',
          ].join('\n'),
        });
        return;
      }

      await route.continue({
        headers: {
          ...route.request().headers(),
          authorization: `Bearer ${adminToken}`,
        },
      });
    });

    await page.goto('/ui/');
    await expandAssistant(page);
    const assistantInput = page.getByPlaceholder(/Напишите/);
    await assistantInput.fill('Создай процесс проверки заявки');
    await expect(assistantInput).toHaveValue('Создай процесс проверки заявки');
    await expect(page.locator('.aw-send')).toBeEnabled();
    await page.locator('.aw-send').click();

    await expect(page.locator('.aw-msg.user', { hasText: 'Создай процесс проверки заявки' })).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.aw-msg.assistant', { hasText: 'Создала процесс' })).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.aw-msg.system', { hasText: '[succeeded]' }).first()).toBeVisible({ timeout: 15_000 });
    await expect(page).toHaveURL(new RegExp(`/ui/editor/${WORKFLOW_ID}$`), { timeout: 15_000 });
    await page.reload();
    await expect(page.locator('.ipe-canvas')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.ipe-canvas')).toContainText('Review request', { timeout: 10_000 });

    await page.reload();
    await expect(page.locator('.ipe-canvas')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.ipe-canvas')).toContainText('Review request', { timeout: 10_000 });
    await expect(page.locator('.workflow-lifecycle-badge')).toContainText(/Validated|Проверен|Готов/i, { timeout: 10_000 });

    const deployResponse = page.waitForResponse(response =>
      response.url().includes('/api/act')
      && response.request().method() === 'POST'
      && (response.request().postData() ?? '').includes('"workflow.deploy"'),
    );
    await page.getByRole('button', { name: 'Deploy' }).click();
    const deployed = await deployResponse;
    const deployedBody = await deployed.json();
    expect(deployed.ok(), JSON.stringify(deployedBody)).toBe(true);
    expect(deployedBody).toMatchObject({
      ok: true,
      action: 'workflow.deploy',
      data: {
        id: WORKFLOW_ID,
        lifecycle_state: 'executable',
      },
    });
    await page.reload();
    await expect(page.locator('.workflow-lifecycle-badge')).toContainText(/Executable|Исполн/i, { timeout: 10_000 });
    await expect(page.getByRole('button', { name: 'Run' })).toBeEnabled({ timeout: 10_000 });

    page.once('dialog', async dialog => {
      expect(dialog.message()).toContain('Тема нового прогона');
      await dialog.accept(RUN_SUBJECT);
    });
    const runResponse = page.waitForResponse(response =>
      response.url().includes('/api/act')
      && response.request().method() === 'POST'
      && (response.request().postData() ?? '').includes('"case.start"'),
    );
    await page.getByRole('button', { name: 'Run' }).click();
    const started = await runResponse;
    const startedBody = await started.json();
    expect(started.ok(), JSON.stringify(startedBody)).toBe(true);
    expect(startedBody).toMatchObject({
      ok: true,
      action: 'case.start',
      data: {
        process_id: WORKFLOW_ID,
        subject: RUN_SUBJECT,
        status: 'running',
        position: 'review',
      },
    });
    const caseId = startedBody.data.case_id;
    expect(caseId).toEqual(expect.any(String));
    touchedCases.add(caseId);

    await page.goto('/ui/workitems');
    await page.locator('#filterProcess').selectOption(WORKFLOW_ID, { timeout: 15_000 });
    const workItemRow = page.locator('#itemsBody tr').filter({ hasText: 'Review request' }).first();
    await expect(workItemRow).toBeVisible({ timeout: 15_000 });
    await expect(workItemRow).toContainText('Browser golden reviewer');
    await expect(workItemRow).toContainText(`#${caseId.slice(0, 6).toUpperCase()}`);
  });
});
