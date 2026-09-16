"use client";

import { useEffect, useRef, useState } from "react";

const channels = {
  telegram: {
    name: "Telegram",
    credentials: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET_TOKEN"],
    access:
      "Set TELEGRAM_ALLOWED_USER_IDS to your numeric user ID. Unset allows nobody. Group messages also need a mention or reply.",
    setup:
      "Create a bot with BotFather, expose the agent through HTTPS and register its webhook with the secret token. The template uses webhooks; it does not poll for messages.",
    send: "Send this to your bot in a private Telegram chat from the allowed account.",
  },
  slack: {
    name: "Slack",
    credentials: ["SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET"],
    access:
      "Set SLACK_ALLOWED_USER_IDS to your Slack member ID. Unset allows nobody. Invite the bot to the intended channel.",
    setup:
      "Install your Slack app with the guide's scopes, event subscriptions and interactivity endpoint. Configure a public HTTPS route to the agent.",
    send: "DM your installed app, or mention the bot in a channel it has joined, followed by this message.",
  },
  discord: {
    name: "Discord",
    credentials: ["DISCORD_PUBLIC_KEY", "DISCORD_APPLICATION_ID"],
    access:
      "Set DISCORD_ALLOWED_USER_IDS for specific people or DISCORD_ALLOWED_GUILD_IDS for allowed servers. An allowed server admits its users. Unset allows nobody; DMs require a user entry.",
    setup:
      "Configure the application's HTTPS interactions endpoint and register the ask command. DISCORD_BOT_TOKEN is also needed for command registration and proactive posts; it is not required for a normal interaction reply.",
    send: "Use /ask in the installed server or permitted DM and paste this into its message option.",
  },
} as const;
type Channel = keyof typeof channels;
type TaskChoice = { id: string; title: string | null; outcome: string };
const STORAGE = "evestack-channel-check-v1";

export function ChannelSetup() {
  const [channel, setChannel] = useState<Channel>("telegram");
  const [token, setToken] = useState("");
  const [search, setSearch] = useState("");
  const [choices, setChoices] = useState<TaskChoice[]>([]);
  const [selected, setSelected] = useState("");
  const [observed, setObserved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [looked, setLooked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copyNote, setCopyNote] = useState<string | null>(null);
  const pending = useRef<AbortController | null>(null);
  const config = channels[channel];
  const message = token
    ? `Reply with exactly ${token} and nothing else. Do not call tools or change files.`
    : "";

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(STORAGE);
      const saved = raw && raw.length < 500 ? JSON.parse(raw) : null;
      if (
        saved &&
        Object.hasOwn(channels, saved.channel) &&
        /^EVESTACK-CHECK-[a-f0-9-]{36}$/.test(saved.token)
      ) {
        setChannel(saved.channel);
        setToken(saved.token);
      }
    } catch {
      /* A blocked storage API does not prevent a fresh check. */
    }
    return () => pending.current?.abort();
  }, []);

  function chooseChannel(next: Channel) {
    pending.current?.abort();
    pending.current = null;
    setChannel(next);
    setToken("");
    setChoices([]);
    setSelected("");
    setObserved(false);
    setError(null);
    setCopyNote(null);
    setLooked(false);
    setBusy(false);
    setSearch("");
    try {
      sessionStorage.removeItem(STORAGE);
    } catch {
      /* Optional draft retention. */
    }
  }

  function createMessage() {
    pending.current?.abort();
    pending.current = null;
    setChoices([]);
    setLooked(false);
    setBusy(false);
    setError(null);
    const next = `EVESTACK-CHECK-${crypto.randomUUID()}`;
    setToken(next);
    setObserved(false);
    setSelected("");
    setCopyNote(null);
    try {
      sessionStorage.setItem(STORAGE, JSON.stringify({ channel, token: next }));
    } catch {
      setCopyNote(
        "This browser cannot retain the test message after navigation. Copy it before leaving.",
      );
    }
  }

  async function findTasks() {
    pending.current?.abort();
    const request = new AbortController();
    pending.current = request;
    setBusy(true);
    setError(null);
    setSelected("");
    setObserved(false);
    setChoices([]);
    const timer = setTimeout(() => request.abort(), 10000);
    try {
      const response = await fetch(
        `/api/tasks?limit=20&q=${encodeURIComponent(search)}`,
        { signal: request.signal },
      );
      const body = await response.json();
      if (!response.ok || body.ok !== true || !Array.isArray(body.tasks))
        throw new Error(
          "Task history is unavailable. Check storage and try again.",
        );
      if (pending.current !== request) return;
      setChoices(
        body.tasks
          .slice(0, 20)
          .filter(
            (task: TaskChoice) =>
              task &&
              typeof task.id === "string" &&
              task.id.length > 0 &&
              task.id.length <= 300 &&
              (task.title === null || typeof task.title === "string") &&
              typeof task.outcome === "string",
          ),
      );
      setLooked(true);
    } catch {
      if (pending.current === request)
        setError(
          "Could not load tasks. Your test message is retained; retry the history check.",
        );
    } finally {
      clearTimeout(timer);
      if (pending.current === request) {
        setBusy(false);
        pending.current = null;
      }
    }
  }

  return (
    <section
      className="workspace-section channel-setup"
      aria-labelledby="channel-setup-title"
    >
      <h2 id="channel-setup-title">Chat channels</h2>
      <p>
        Send work from a channel and follow the result here. Channel credentials
        and sender access are configured in your agent project.
      </p>
      <label htmlFor="inbound-channel">Choose a channel</label>
      <select
        id="inbound-channel"
        value={channel}
        onChange={(event) => chooseChannel(event.target.value as Channel)}
      >
        {Object.entries(channels).map(([id, value]) => (
          <option key={id} value={id}>
            {value.name}
          </option>
        ))}
      </select>
      <details>
        <summary>1. Configure {config.name}</summary>
        <p>{config.setup}</p>
        <p>
          Agent route: <code>/eve/v1/{channel}</code>. Use the channel&apos;s
          signature or secret verification on this route; the channel cannot
          supply the dashboard&apos;s Basic credentials.
        </p>
        <p>
          Required settings:{" "}
          {config.credentials.map((key, index) => (
            <span key={key}>
              {index ? ", " : ""}
              <code>{key}</code>
            </span>
          ))}
          .
        </p>
        <p>{config.access} A wildcard admits everyone in its scope.</p>
        <p>
          In the project terminal, use{" "}
          <code>evestack configure --from-file=/private/settings.json</code> to
          preview supported settings and make a protected backup when applying.
          Restart the agent after saving, then run <code>evestack verify</code>.
        </p>
        <a
          href={`https://github.com/SammyTourani/evestack/blob/main/docs/channels/${channel}.mdx`}
          target="_blank"
          rel="noreferrer"
        >
          Open the {config.name} setup guide ↗
        </a>
        <p className="page-sub">
          The dashboard cannot verify secrets loaded by a separate agent or the
          behavior of custom channel code.
        </p>
      </details>
      <h3>2. Send a small test</h3>
      <p>
        {config.send} Sending it starts a real task and can incur model cost.
      </p>
      <button type="button" onClick={createMessage}>
        {token ? "Create a new test message" : "Create a test message"}
      </button>
      {message && (
        <>
          <label htmlFor="channel-test-message">Test message</label>
          <textarea
            id="channel-test-message"
            value={message}
            readOnly
            rows={4}
          />
          <button
            type="button"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(message);
                setCopyNote(
                  "Test message copied. Send it from the allowed account.",
                );
              } catch {
                setCopyNote(
                  "Copy was unavailable. Select and copy the message above.",
                );
              }
            }}
          >
            Copy test message
          </button>
        </>
      )}
      {copyNote && <p role="status">{copyNote}</p>}
      <h3>3. Match the reply to its task</h3>
      <p>
        Check the channel for the exact marker, then find the corresponding
        task. Title search may not contain the marker; use recent tasks or
        search its title.
      </p>
      <label htmlFor="channel-task-search">Search task titles or IDs</label>
      <input
        id="channel-task-search"
        value={search}
        maxLength={200}
        onChange={(event) => setSearch(event.target.value)}
      />
      <button
        type="button"
        disabled={busy || !token}
        onClick={() => void findTasks()}
      >
        {busy ? "Loading tasks…" : "Find test task"}
      </button>
      {error && <p role="alert">{error}</p>}
      {looked && !busy && !choices.length && !error && (
        <p role="status">
          No matching task found. Clear the search to see recent work; check the
          agent&apos;s channel refusal log if nothing arrived.
        </p>
      )}
      {!!choices.length && (
        <>
          <label htmlFor="channel-test-task">Choose the matching task</label>
          <select
            id="channel-test-task"
            value={selected}
            onChange={(event) => {
              setSelected(event.target.value);
              setObserved(false);
            }}
          >
            <option value="">Select a task…</option>
            {choices.map((task) => (
              <option key={task.id} value={task.id}>
                {(task.title ?? task.id).slice(0, 100)} · {task.outcome}
              </option>
            ))}
          </select>
          <p className="page-sub">
            Up to 20 most recent matches. Selecting a task does not verify its
            originating channel.
          </p>
        </>
      )}
      {selected && (
        <>
          <p>
            <a
              href={`/chat?session=${encodeURIComponent(selected)}`}
              target="_blank"
              rel="noreferrer"
            >
              Inspect the selected task ↗
            </a>
          </p>
          <label>
            <input
              type="checkbox"
              checked={observed}
              onChange={(event) => setObserved(event.target.checked)}
            />{" "}
            I received the matching reply in {config.name} and inspected this
            task.
          </label>
        </>
      )}
      {observed && (
        <p role="status">
          You recorded a successful check in this browser view. This is your
          observation, not an automated receipt or an audit record. Check an
          unauthorized sender separately; a successful allowed request does not
          verify the access restriction.
        </p>
      )}
      <p className="page-sub">
        No message is sent by these controls. The marker is retained in this tab
        for navigation; receipt observations are not saved. Inbound channels,
        routine notifications and code-authored heartbeats use separate delivery
        paths.
      </p>
    </section>
  );
}
