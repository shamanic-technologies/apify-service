import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

// ─── Mocks: replace the DB + external clients so the routes run end-to-end
// without a live Postgres / chat-service / Apify. The refine loop, persistence
// shape, and round-trip are exercised against an in-memory store. ──────────────

// Operators return inspectable predicate descriptors the fake db can evaluate.
vi.mock("drizzle-orm", () => ({
  eq: (col: unknown, val: unknown) => ({ op: "eq", col, val }),
  and: (...conds: unknown[]) => ({ op: "and", conds }),
  gte: (col: unknown, val: unknown) => ({ op: "gte", col, val }),
  inArray: (col: unknown, vals: unknown[]) => ({ op: "inArray", col, vals }),
}));

vi.mock("../../src/db/index.js", async () => {
  const { randomUUID } = await import("node:crypto");
  const store = new Map<object, Record<string, any>[]>();
  const rowsFor = (t: object) => {
    if (!store.has(t)) store.set(t, []);
    return store.get(t)!;
  };
  const keyForCol = (table: any, col: unknown) =>
    Object.keys(table).find((k) => table[k] === col);
  const evalCond = (cond: any, row: Record<string, any>, table: any): boolean => {
    if (!cond) return true;
    if (cond.op === "and") return cond.conds.every((c: any) => evalCond(c, row, table));
    const k = keyForCol(table, cond.col);
    const v = k ? row[k] : undefined;
    if (cond.op === "eq") return v === cond.val;
    if (cond.op === "gte") return v >= cond.val;
    if (cond.op === "inArray") return cond.vals.includes(v);
    return true;
  };

  const db = {
    insert(table: object) {
      return {
        values(vals: any) {
          const arr = Array.isArray(vals) ? vals : [vals];
          const inserted = arr.map((v: any) => ({
            id: v.id ?? randomUUID(),
            count: 0,
            status: "ready",
            ...v,
            createdAt: v.createdAt ?? new Date(),
            updatedAt: v.updatedAt ?? new Date(),
          }));
          rowsFor(table).push(...inserted);
          return {
            returning: async () => inserted,
            onConflictDoNothing: async () => undefined,
            then: (resolve: (v: any) => any) => resolve(inserted),
          };
        },
      };
    },
    select(_proj?: unknown) {
      let table: any;
      let cond: any;
      const builder: any = {
        from(t: object) {
          table = t;
          return builder;
        },
        where(c: any) {
          cond = c;
          return builder;
        },
        limit(_n: number) {
          return builder;
        },
        then(resolve: (v: any) => any, reject: (e: any) => any) {
          try {
            return Promise.resolve(
              rowsFor(table).filter((r) => evalCond(cond, r, table))
            ).then(resolve, reject);
          } catch (e) {
            return Promise.reject(e).then(resolve, reject);
          }
        },
      };
      return builder;
    },
    update(table: object) {
      let setVals: any;
      const builder: any = {
        set(v: any) {
          setVals = v;
          return builder;
        },
        where(cond: any) {
          for (const r of rowsFor(table)) {
            if (evalCond(cond, r, table)) Object.assign(r, setVals);
          }
          return Promise.resolve();
        },
      };
      return builder;
    },
  };

  return { db, getSql: () => { throw new Error("no sql in tests"); }, __store: store };
});

vi.mock("../../src/lib/keys-client.js", () => ({
  getPlatformKey: vi.fn().mockResolvedValue("test-token"),
}));

vi.mock("../../src/lib/chat-client.js", () => ({
  complete: vi.fn().mockResolvedValue({
    json: { titles: ["CMO"], seniorities: ["c_suite"], industries: ["Banking"] },
    content: "",
    tokensInput: 10,
    tokensOutput: 20,
    model: "gemini-test",
  }),
}));

vi.mock("../../src/lib/waterfall.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, countMatches: vi.fn().mockResolvedValue(1000) };
});

const { default: app } = await import("../../src/index.js");

const ORG = "org_test_1";
const USER = "user_test_1";

describe("POST /audiences/suggest-from-segment", () => {
  it("builds, counts, persists, and returns the faithful audience", async () => {
    const res = await request(app)
      .post("/audiences/suggest-from-segment")
      .set("x-org-id", ORG)
      .set("x-user-id", USER)
      .send({ name: "Bank CMOs", description: "CMOs at banks", brandId: null });

    expect(res.status).toBe(200);
    expect(typeof res.body.apifyAudienceId).toBe("string");
    expect(res.body.count).toBe(1000);
    expect(res.body.filters.titles).toEqual(["CMO"]);
    expect(res.body.filters.industries).toEqual(["Banking"]);
  });

  it("rejects an empty segment (fail-loud, no silent default)", async () => {
    const res = await request(app)
      .post("/audiences/suggest-from-segment")
      .set("x-org-id", ORG)
      .set("x-user-id", USER)
      .send({ name: "", description: "" });
    expect(res.status).toBe(400);
  });

  it("requires x-user-id", async () => {
    const res = await request(app)
      .post("/audiences/suggest-from-segment")
      .set("x-org-id", ORG)
      .send({ name: "x", description: "y" });
    expect(res.status).toBe(400);
  });
});

describe("GET + dry-run round-trip", () => {
  let id: string;

  beforeEach(async () => {
    const res = await request(app)
      .post("/audiences/suggest-from-segment")
      .set("x-org-id", ORG)
      .set("x-user-id", USER)
      .send({ name: "Bank CMOs", description: "CMOs at banks", brandId: null });
    id = res.body.apifyAudienceId;
  });

  it("GET returns the persisted audience by id (x-org-id only)", async () => {
    const res = await request(app).get(`/audiences/${id}`).set("x-org-id", ORG);
    expect(res.status).toBe(200);
    expect(res.body.apifyAudienceId).toBe(id);
    expect(res.body.status).toBe("ready");
    expect(res.body.count).toBe(1000);
    expect(typeof res.body.createdAt).toBe("string");
    expect(res.body.filters.titles).toEqual(["CMO"]);
  });

  it("GET is org-scoped (other org cannot read it)", async () => {
    const res = await request(app)
      .get(`/audiences/${id}`)
      .set("x-org-id", "org_other");
    expect(res.status).toBe(404);
  });

  it("GET 404s on an unknown id", async () => {
    const res = await request(app)
      .get("/audiences/00000000-0000-0000-0000-000000000000")
      .set("x-org-id", ORG);
    expect(res.status).toBe(404);
  });

  it("dry-run re-counts the audience live", async () => {
    const res = await request(app)
      .post(`/audiences/${id}/dry-run`)
      .set("x-org-id", ORG)
      .set("x-user-id", USER);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1000);
  });

  it("dry-run 404s on an unknown id", async () => {
    const res = await request(app)
      .post("/audiences/00000000-0000-0000-0000-000000000000/dry-run")
      .set("x-org-id", ORG)
      .set("x-user-id", USER);
    expect(res.status).toBe(404);
  });
});
