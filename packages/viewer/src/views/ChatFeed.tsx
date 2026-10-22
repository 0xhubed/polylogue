import type { ViewState } from "../state.ts";

export function ChatFeed({ s }: { s: ViewState }) {
  return (
    <section className="panel" data-testid="chat-feed" aria-label="Messages">
      <h2>Messages</h2>
      {s.chat.length === 0 ? <p className="empty">No messages yet.</p> : (
        <ol className="chat">
          {s.chat.map((m) => (
            <li key={m.id}>
              <span className="who">{m.from} → {typeof m.to === "string" ? m.to : `#${m.to.topic}`}</span>
              {m.urgent && <span className="urgent">urgent</span>}
              <span className="text">{m.text}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
