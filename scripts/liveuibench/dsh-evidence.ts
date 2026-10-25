// Consume only host-produced evidence from completed bridge actions in this turn.
// Model result text, DOM attributes and previous-turn observations are not audit evidence.
export function dshActionEvidence(bridgeResults: unknown, appId: string, visibleText: string) {
  const trace: any[] = [];
  const toolResults: Record<string, unknown> = {};
  const toolDbChanges: any[] = [];
  const acceptedJobIds = new Set<string>();
  for (const job of Array.isArray(bridgeResults) ? bridgeResults : []) {
    const e = job?.evidence;
    if (job?.status !== 'done' || typeof job?.id !== 'string' || !job.id || acceptedJobIds.has(job.id)) continue;
    if (e?.schemaVersion !== 1 || e.appId !== appId || !Array.isArray(e.trace)
      || !e.toolResults || typeof e.toolResults !== 'object' || Array.isArray(e.toolResults)
      || !Array.isArray(e.toolDbChanges)) continue;
    acceptedJobIds.add(job.id);
    trace.push(...e.trace);
    for (const [key, value] of Object.entries(e.toolResults)) toolResults[`${acceptedJobIds.size}:${key}`] = value;
    toolDbChanges.push(...e.toolDbChanges);
  }
  return { trace, toolResults, toolDbChanges, runtimeState: { intentResult: { text: visibleText } } };
}
