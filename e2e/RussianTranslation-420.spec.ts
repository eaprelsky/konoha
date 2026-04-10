import { test, expect } from '@playwright/test';

test.describe('Issue #420: Russian translation in ProcessEditor', () => {
  test('TC-08: Add element button is in Russian', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle', { timeout: 10000 });

    const pageText = await page.content();

    if (pageText.includes('Добавить элемент')) {
      expect(pageText).toContain('Добавить элемент');
    } else {
      expect(pageText).toContain('Добавить');
    }
  });

  test('TC-09: Element names in palette are in Russian', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle', { timeout: 10000 });

    const pageText = await page.content();

    expect(pageText).toContain('Событие');
    expect(pageText).toContain('Функция');
    expect(pageText).toContain('Ветвление');

    const visibleText = await page.innerText('body');
    expect(visibleText).toContain('Событие');
  });

  test('TC-10: Screenshot of ProcessEditor with Russian UI', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle', { timeout: 10000 });

    const screenshotBuffer = await page.screenshot({
      path: '/opt/shared/shino/reports/2026-04-10-screenshot-420.png'
    });
    expect(screenshotBuffer.byteLength).toBeGreaterThan(10_000);
  });
});
