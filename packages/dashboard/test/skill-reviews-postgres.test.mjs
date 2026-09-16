import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  skillFingerprint,
  compareSkillFiles,
} from "../lib/skill-fingerprint.ts";

test(
  "skill review baselines migrate additively and preserve review history",
  { skip: !process.env.EVESTACK_TEST_POSTGRES_URL },
  async (t) => {
    const admin = new pg.Client({
      connectionString: process.env.EVESTACK_TEST_POSTGRES_URL,
    });
    await admin.connect();
    const name = `skill_review_test_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(process.env.EVESTACK_TEST_POSTGRES_URL);
    url.pathname = `/${name}`;
    const previous = process.env.WORKFLOW_POSTGRES_URL;
    process.env.WORKFLOW_POSTGRES_URL = url.href;
    const { getPool, closePool } = await import("../lib/db.ts");
    t.after(async () => {
      await closePool();
      if (previous === undefined) delete process.env.WORKFLOW_POSTGRES_URL;
      else process.env.WORKFLOW_POSTGRES_URL = previous;
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.end();
    });
    const db = getPool();
    await db.query(`CREATE SCHEMA evestack; CREATE TABLE evestack.skill_reviews (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,name text NOT NULL,source_hash text NOT NULL,content_hash text NOT NULL,
    verdict text NOT NULL,note text NOT NULL,actor text,actor_via text NOT NULL,created_at timestamptz DEFAULT now());
    INSERT INTO evestack.skill_reviews(name,source_hash,content_hash,verdict,note,actor,actor_via) VALUES('legacy','old-source',repeat('a',64),'reviewed','Historical review','original','basic')`);
    const reviews = await import("../lib/skill-reviews.ts");
    await t.test(
      "legacy reviews stay readable without an invented file baseline",
      async () => {
        const old = await reviews.readSkillReview("legacy", "old-source");
        assert.equal(old.note, "Historical review");
        assert.equal(old.file_manifest, null);
        assert.equal(compareSkillFiles([], old.file_manifest).available, false);
      },
    );
    const skill = {
      name: "fixture",
      kind: "package",
      rootPath: "/fixture",
      problems: [],
      files: [
        {
          path: "SKILL.md",
          kind: "text",
          text: "PRIVATE FILE BODY",
          bytes: 17,
        },
      ],
    };
    const original = skillFingerprint(skill);
    await t.test(
      "a new review stores generated file fingerprints without source text",
      async () => {
        await reviews.recordSkillReview(
          skill.name,
          original.source,
          original.hash,
          "reviewed",
          "Inspected the exact fixture.",
          { approver: "operator", via: "basic" },
          original.manifest,
        );
        const saved = await reviews.readSkillReview(
          skill.name,
          original.source,
        );
        assert.deepEqual(saved.file_manifest, original.manifest);
        assert.doesNotMatch(JSON.stringify(saved), /PRIVATE FILE BODY/);
        assert.equal(
          await reviews.readSkillReview(skill.name, "different-source"),
          null,
        );
      },
    );
    await t.test(
      "later reviews append while original fingerprints remain available",
      async () => {
        const changed = skillFingerprint({
          ...skill,
          files: [
            { ...skill.files[0], text: "Updated instructions", bytes: 20 },
          ],
        });
        const before = await reviews.readSkillReview(
          skill.name,
          original.source,
        );
        assert.deepEqual(
          compareSkillFiles(changed.manifest, before.file_manifest).changed,
          ["SKILL.md"],
        );
        await reviews.recordSkillReview(
          skill.name,
          changed.source,
          changed.hash,
          "needs_changes",
          "Investigate these new instructions.",
          { approver: "reviewer", via: "basic" },
          changed.manifest,
        );
        const current = await reviews.readSkillReview(
          skill.name,
          original.source,
        );
        assert.equal(current.content_hash, changed.hash);
        assert.equal(current.verdict, "needs_changes");
        const rows = (
          await db.query(
            "SELECT content_hash,file_manifest FROM evestack.skill_reviews WHERE name='fixture' ORDER BY id",
          )
        ).rows;
        assert.equal(rows.length, 2);
        assert.equal(rows[0].content_hash, original.hash);
        assert.deepEqual(rows[0].file_manifest, original.manifest);
      },
    );
  },
);
