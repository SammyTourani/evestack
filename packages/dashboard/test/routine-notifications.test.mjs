import assert from "node:assert/strict";
import { test } from "node:test";
import { routineNotificationBody } from "../lib/routine-notifications.ts";

const notice = {
  source: "evestack", type: "routine", runId: "run", routineId: "routine",
  name: "<!channel> <@123> @everyone & report", outcome: "awaiting_approval",
  revision: 2, sessionId: "session", href: "/chat?session=session",
};

test("routine names cannot turn Slack or Discord deliveries into broadcast mentions", () => {
  const slack = JSON.parse(routineNotificationBody(notice, "slack", "delivery", "https://dashboard.example.test"));
  assert.ok(slack.text.includes("&lt;!channel&gt;"));
  assert.ok(!slack.text.includes("<@123>"));
  assert.equal(slack.unfurl_links, false);
  const discord = JSON.parse(routineNotificationBody(notice, "discord", "delivery", "https://dashboard.example.test"));
  assert.deepEqual(discord.allowed_mentions, { parse: [] });
});

test("generic routine notifications expose a stable identity without accepting credential-bearing dashboard links", () => {
  const valid = JSON.parse(routineNotificationBody(notice, "webhook", "delivery", "https://dashboard.example.test"));
  assert.equal(valid.notificationId, "delivery");
  assert.equal(valid.url, "https://dashboard.example.test/chat?session=session");
  for (const base of ["https://user:secret@dashboard.example.test", "javascript:alert(1)", "not a URL"]) {
    const body = JSON.parse(routineNotificationBody(notice, "webhook", "delivery", base));
    assert.equal(body.url, null);
    assert.ok(!JSON.stringify(body).includes("secret"));
  }
});
