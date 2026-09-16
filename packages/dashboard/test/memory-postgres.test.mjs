import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

test(
  "memory ownership, reviews and atomic removal on PostgreSQL",
  { skip: !process.env.EVESTACK_TEST_POSTGRES_URL },
  async (t) => {
    const admin = new pg.Client({
      connectionString: process.env.EVESTACK_TEST_POSTGRES_URL,
    });
    await admin.connect();
    const name = `memory_test_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(process.env.EVESTACK_TEST_POSTGRES_URL);
    url.pathname = `/${name}`;
    const original = process.env.WORKFLOW_POSTGRES_URL;
    process.env.WORKFLOW_POSTGRES_URL = url.href;
    const { getPool, closePool } = await import("../lib/db.ts");
    const memory = await import("../lib/memories.ts");
    const reviews = await import("../lib/memory-reviews.ts");
    const actor = { approver: "fixture-operator", via: "basic" };
    t.after(async () => {
      await closePool();
      if (original === undefined) delete process.env.WORKFLOW_POSTGRES_URL;
      else process.env.WORKFLOW_POSTGRES_URL = original;
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.end();
    });
    const db = getPool();
    const row = async (id) =>
      (await memory.listMemories()).rows.find((item) => item.id === String(id));
    await db.query(
      "CREATE SCHEMA evestack; CREATE TABLE evestack.memories(id bigserial PRIMARY KEY,content text NOT NULL,tags text[] NOT NULL DEFAULT '{}',session_id text,embedding text NOT NULL DEFAULT 'original-vector',created_at timestamptz NOT NULL DEFAULT now())",
    );
    const add = async (content = "Original remembered fact") =>
      (
        await db.query(
          "INSERT INTO evestack.memories(content,session_id) VALUES($1,'source-task') RETURNING id",
          [content],
        )
      ).rows[0].id;

    await t.test(
      "legacy rows stay explicitly unowned, and an added owner becomes visible",
      async () => {
        const id = await add();
        const legacy = await row(id);
        assert.equal(legacy.principalId, null);
        assert.equal(legacy.sessionId, "source-task");
        assert.match(legacy.hash, /^[a-f0-9]{64}$/);
        await db.query(
          "ALTER TABLE evestack.memories ADD COLUMN principal_id text",
        );
        await db.query(
          "UPDATE evestack.memories SET principal_id='telegram:alice',tags=ARRAY['shared'] WHERE id=$1",
          [id],
        );
        const owned = await row(id);
        assert.equal(owned.principalId, "telegram:alice");
        assert.deepEqual(owned.tags, ["shared"]);
        assert.notEqual(owned.hash, legacy.hash);
      },
    );

    await t.test(
      "a correction proposal retains provenance without changing recall text, vector or owner",
      async () => {
        const id = await add();
        const before = await row(id);
        const saved = await reviews.reviewMemory(
          String(id),
          {
            hash: before.hash,
            verdict: "correction_proposed",
            note: "The original date is stale; source is the current invoice.",
            proposedContent: "The invoice is due next Friday.",
          },
          actor,
        );
        assert.equal(saved.verdict, "correction_proposed");
        assert.equal(saved.actor, actor.approver);
        const after = await row(id);
        assert.deepEqual(after, before);
        assert.equal(
          (
            await db.query(
              "SELECT embedding FROM evestack.memories WHERE id=$1",
              [id],
            )
          ).rows[0].embedding,
          "original-vector",
        );
        const snapshot = (
          await db.query(
            "SELECT snapshot FROM evestack.memory_reviews WHERE id=$1",
            [saved.id],
          )
        ).rows[0].snapshot;
        assert.equal(snapshot.content, before.content);
        assert.equal(snapshot.principalId, before.principalId);
        assert.equal(snapshot.hash, before.hash);
        assert.equal(
          (await reviews.memoryReviewHistory(String(id)))[0].proposedContent,
          "The invoice is due next Friday.",
        );
      },
    );

    await t.test(
      "a stale screen cannot delete or review an updated record, including vector-only changes",
      async () => {
        const id = await add();
        const before = await row(id);
        await db.query(
          "UPDATE evestack.memories SET embedding='new-vector' WHERE id=$1",
          [id],
        );
        assert.notEqual((await row(id)).hash, before.hash);
        await assert.rejects(
          memory.deleteMemory(String(id), actor, before.hash),
          memory.MemoryConflictError,
        );
        await assert.rejects(
          reviews.reviewMemory(
            String(id),
            {
              hash: before.hash,
              verdict: "stale",
              note: "The old value needs review.",
            },
            actor,
          ),
          memory.MemoryConflictError,
        );
        assert.ok(await row(id));
      },
    );

    await t.test(
      "deletion and owner-aware audit commit once under competing requests",
      async () => {
        const id = await add();
        await db.query(
          "UPDATE evestack.memories SET principal_id='telegram:bob' WHERE id=$1",
          [id],
        );
        const before = await row(id);
        const deleted = await Promise.all([
          memory.deleteMemory(String(id), actor, before.hash),
          memory.deleteMemory(String(id), actor, before.hash),
        ]);
        assert.equal(deleted.filter(Boolean).length, 1);
        const audits = (await memory.listMemoryDeletions()).filter(
          (item) => item.memoryId === String(id),
        );
        assert.equal(audits.length, 1);
        assert.equal(audits[0].principalId, "telegram:bob");
        assert.equal(audits[0].content, before.content);
      },
    );

    await t.test("a failed audit write rolls removal back", async () => {
      const id = await add();
      const before = await row(id);
      await db.query(
        "CREATE FUNCTION evestack.reject_fixture_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture audit failure'; END $$; CREATE TRIGGER fixture_audit_failure BEFORE INSERT ON evestack.memory_deletions FOR EACH ROW EXECUTE FUNCTION evestack.reject_fixture_audit()",
      );
      try {
        await assert.rejects(
          memory.deleteMemory(String(id), actor, before.hash),
          /fixture audit failure/,
        );
      } finally {
        await db.query(
          "DROP TRIGGER fixture_audit_failure ON evestack.memory_deletions",
        );
      }
      assert.deepEqual(await row(id), before);
      assert.equal(
        (await memory.listMemoryDeletions()).filter(
          (item) => item.memoryId === String(id),
        ).length,
        0,
      );
    });

    await t.test(
      "review history survives removal and identifies changed versions",
      async () => {
        const id = await add();
        const before = await row(id);
        const saved = await reviews.reviewMemory(
          `00${id}`,
          {
            hash: before.hash,
            verdict: "conflicting",
            note: "The invoice and the contract give different dates.",
          },
          actor,
        );
        assert.equal(saved.memoryId, String(id));
        await db.query(
          "UPDATE evestack.memories SET content='Revised fact' WHERE id=$1",
          [id],
        );
        const after = await row(id);
        const latest = (await reviews.latestMemoryReviews([String(id)]))[0];
        assert.notEqual(latest.memoryHash, after.hash);
        await memory.deleteMemory(String(id), actor, after.hash);
        assert.equal(
          (await reviews.memoryReviewHistory(String(id)))[0].id,
          saved.id,
        );
      },
    );
  },
);
