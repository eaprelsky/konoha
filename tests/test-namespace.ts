let seq = 0;

function sanitize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "test";
}

export interface TestNamespace {
  readonly value: string;
  id(name: string): string;
  matches(id: string | undefined | null): boolean;
}

export function createTestNamespace(prefix: string): TestNamespace {
  seq += 1;
  const value = `${sanitize(prefix)}-${process.pid}-${Date.now().toString(36)}-${seq}`;
  return {
    value,
    id(name: string) {
      return `${sanitize(name)}-${value}`;
    },
    matches(id: string | undefined | null) {
      return typeof id === "string" && id.endsWith(`-${value}`);
    },
  };
}
