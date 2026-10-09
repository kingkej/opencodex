import { expect, test } from "bun:test";
import { handleComboCommand } from "../../src/cli/combo";

test("combo CLI creates a separately named Clef strategy with the configured targets in order", async () => {
  const writes: unknown[] = [];
  const code = await handleComboCommand([
    "set", "clef-auto", "--targets", "openai/gpt-6.1-sol,openai/gpt-6-luna", "--strategy", "clef", "--alias", "clef-auto", "--json",
  ], {
    baseUrl: "http://localhost:10100",
    fetchImpl: (async (_url, init) => {
      if (init?.method === "PUT") {
        const saved = JSON.parse(String(init.body));
        writes.push(saved);
        return Response.json({ success: true, id: saved.id, model: saved.combo.alias, combo: saved.combo,
          catalogRefresh: { status: "committed", changed: true, degraded: false, notices: [] } });
      }
      return Response.json({ combos: [] });
    }) as typeof fetch,
  });
  expect(code).toBe(0);
  expect(writes).toEqual([{
    id: "clef-auto", combo: { strategy: "clef", stickyLimit: 1, alias: "clef-auto", targets: [
      { provider: "openai", model: "gpt-6.1-sol" }, { provider: "openai", model: "gpt-6-luna" },
    ] },
  }]);
});
