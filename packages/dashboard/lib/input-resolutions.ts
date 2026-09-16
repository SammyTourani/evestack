/** Only explicitly resolved request IDs leave the pending decision queue. */
export function resolvedInputIds(data: Record<string, unknown>): Set<string> {
  if (!Array.isArray(data.resolutions)) return new Set();
  const ids = data.resolutions.flatMap((entry: unknown) => {
    if (!entry || typeof entry !== "object") return [];
    const id = (entry as { requestId?: unknown }).requestId;
    return typeof id === "string" && id.length > 0 ? [id] : [];
  });
  return new Set(ids);
}
