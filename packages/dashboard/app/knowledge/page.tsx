export default function KnowledgePage() {
  return (
    <>
      <h1>Knowledge</h1>
      <p className="page-sub">
        Review the facts and instructions your agent can use.
      </p>
      <div className="workspace-grid">
        <a className="workspace-section" href="/memory">
          <h2>Remembered facts</h2>
          <p>
            Search saved memories, inspect source tasks and remove facts from
            recall.
          </p>
        </a>
        <a className="workspace-section" href="/skills">
          <h2>Skills &amp; safety review</h2>
          <p>
            Inspect installed instructions and review scanner findings against
            their source.
          </p>
        </a>
      </div>
      <section className="workspace-section">
        <h2>Know what is retained</h2>
        <p>
          Removing a memory from recall retains its text in the deletion audit.
          A memory is separate from a source document; this installation does
          not provide a document upload library.
        </p>
        <a href="/settings">Data destinations &amp; configuration</a>
      </section>
    </>
  );
}
