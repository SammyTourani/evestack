import { fmt, parseMessages, payload } from "../format";
import styles from "../traces.module.css";

/**
 * The blocks that render span content: prompts, message history, tool
 * arguments, tool results.
 *
 * Server components with no client bundle. Collapsing is a native <details>,
 * which means the whole trace viewer works with JavaScript disabled and, more
 * usefully, that Cmd-F finds text inside a block that is closed in browsers
 * that support it. Everything is scrollable inside its own box rather than
 * pushing the rest of the page down — a single bash result is routinely longer
 * than the entire screen.
 */

/** A payload of unknown length. Absent values are stated, never omitted. */
export function PayloadBlock({
  label,
  value,
  open = false,
  absent = "not recorded",
}: {
  label: string;
  value: string | null;
  open?: boolean;
  absent?: string;
}) {
  if (value === null) {
    return (
      <div className={styles.block}>
        <div className={styles.absent}>
          <span className={styles.factLabel}>{label}</span> — {absent}
        </div>
      </div>
    );
  }

  const { text, truncatedFrom } = payload(value);
  return (
    <details className={styles.block} open={open}>
      <summary>
        {label}
        <span className={styles.blockCount}>{fmt(value.length)} chars</span>
      </summary>
      <pre className={truncatedFrom ? `${styles.pre} ${styles.preClamped}` : styles.pre}>
        {text}
      </pre>
      {truncatedFrom !== null && (
        <p className={styles.clampNote}>
          Clamped to {fmt(text.length)} of {fmt(truncatedFrom)} characters. The full value is on
          the span — query <code>evestack.spans</code> directly to read the rest.
        </p>
      )}
    </details>
  );
}

/**
 * Message history, one box per message.
 *
 * Falls back to printing the raw attribute when the value is not an array of
 * messages, and to a single message's raw JSON when that message's shape has no
 * text this knows how to pull out. Both vocabularies encode this differently
 * and the AI SDK's part shapes change between versions, so guessing wrong has
 * to degrade to "here is what was recorded", never to a blank box.
 */
export function MessagesBlock({ value }: { value: string | null }) {
  if (value === null) {
    return (
      <div className={styles.block}>
        <div className={styles.absent}>
          <span className={styles.factLabel}>Messages</span> — not recorded
        </div>
      </div>
    );
  }

  const messages = parseMessages(value);
  if (messages === null) return <PayloadBlock label="Messages" value={value} />;

  return (
    <details className={styles.block}>
      <summary>
        Messages
        <span className={styles.blockCount}>
          {fmt(messages.length)} · {fmt(value.length)} chars
        </span>
      </summary>
      <ol className={styles.messages}>
        {messages.map((message, index) => {
          const body = message.text ?? message.raw;
          const { text, truncatedFrom } = payload(body);
          return (
            <li className={styles.message} key={index}>
              <div className={styles.messageRole}>
                {message.role}
                {message.text === null && " · raw"}
              </div>
              <pre className={styles.messageBody}>{text}</pre>
              {truncatedFrom !== null && (
                <p className={styles.clampNote}>
                  Clamped to {fmt(text.length)} of {fmt(truncatedFrom)} characters.
                </p>
              )}
            </li>
          );
        })}
      </ol>
    </details>
  );
}

export function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span className={styles.fact}>
      <span className={styles.factLabel}>{label}</span> {children}
    </span>
  );
}
