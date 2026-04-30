import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { runI18nGuard, scanFrontendI18nLiterals } from "../scripts/i18n-hardcoded-copy-guard";

const ROOT = "/tmp/konoha-i18n-guard-test";

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

function writeFixture(rel: string, content: string) {
  const path = join(ROOT, rel);
  mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  writeFileSync(path, content, "utf-8");
}

describe("i18n hardcoded-copy guard", () => {
  test("detects cyrillic JSX and string literals", () => {
    writeFixture("frontend/src/pages/Demo.tsx", `
      export function Demo() {
        const title = "Прогоны";
        return <button title={\`Служебные \${1}\`}>Сбросить</button>;
      }
    `);

    const findings = scanFrontendI18nLiterals(join(ROOT, "frontend/src"));

    expect(findings.map(f => f.text).sort()).toEqual([
      "Прогоны",
      "Сбросить",
      "Служебные",
    ].sort());
  });

  test("ignores translations and tests", () => {
    writeFixture("frontend/src/i18n/translations.ts", `export const ru = { title: "Прогоны" };`);
    writeFixture("frontend/src/__tests__/copy.test.tsx", `expect("Прогоны").toBeTruthy();`);

    expect(scanFrontendI18nLiterals(join(ROOT, "frontend/src"))).toEqual([]);
  });

  test("fails strings in guarded files", () => {
    writeFixture("frontend/src/pages/Demo.tsx", `export const Demo = () => <h1>Прогоны</h1>;`);

    const result = runI18nGuard({
      root: join(ROOT, "frontend/src"),
      files: ["pages/Demo.tsx"],
    });

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].text).toBe("Прогоны");
  });

  test("ignores legacy strings outside the scoped guarded files", () => {
    writeFixture("frontend/src/pages/Legacy.tsx", `export const Legacy = () => <h1>Прогоны</h1>;`);
    writeFixture("frontend/src/pages/Demo.tsx", `export const Demo = () => <h1>{title}</h1>;`);

    const result = runI18nGuard({
      root: join(ROOT, "frontend/src"),
      files: ["pages/Demo.tsx"],
    });

    expect(result.violations).toEqual([]);
  });
});
