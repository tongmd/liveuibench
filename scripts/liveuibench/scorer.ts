// Deterministic LiveUIBench scorer, ported from the legacy AppWorld runner.
// Assertions consume only observed responses; expected values never enter app prompts.
export type Assertion = { type: string; target?: string; value: unknown };
export type Episode = { id: string; kind: string; userMessage?: string; actionOrdinal?: number; assertions: Assertion[] };
export type BenchCase = { id: string; split: string; intentions: Array<{ intention: string; expectedBehavior?: string; horizonTurns?: number }>; episodes: Episode[]; episodeGroups?: Array<{intentionIndex: number; episodes: Episode[]}>; quarantined?: boolean; episodesPending?: boolean; fixturesRef?: unknown };
function flatten(components: any[]): any[] { return components.flatMap(c => [c, ...flatten(Array.isArray(c.children) ? c.children : [])]); }
function pages(pkg: any): any[][] { return (pkg?.ui?.pages || []).map((p: any) => flatten(p.components || [])); }
function pkgHasEditableInput(pkg: any) { const ps=pages(pkg);return ps.length>0 && ps.every(cs=>cs.some(c=>['form','input','textarea','select','checkbox','switch','file_upload'].includes(c.type))); }
function pkgHasActionBoundInteraction(pkg: any) { const ps=pages(pkg);return ps.length>0 && ps.every(cs=>cs.some(c=>['button','icon_button','form','card','data_list'].includes(c.type) && Object.values(c.events||{}).some(v=>String(v).startsWith('actions.')))); }
function routes(pkg: any) { return (pkg?.ui?.meta?.agentWorkflow || []).flatMap((w: any)=>w.actionRoutes||[]).filter((r: any)=>pkg?.actions?.actions?.[String(r.actionId).replace(/^actions\./,'')]); }
function pkgHasWorkflowRoute(pkg: any) { return routes(pkg).length>0; }
export function executableActionByOrdinal(pkg: any, ordinal=1) {
 const unique = [...new Map<string,any>(routes(pkg).map((r:any)=>[String(r.actionId).replace(/^actions\./,''),r] as [string,any])).entries()];
 const ordered=unique.map(([id,route],i)=>({id,route,order:/agent_turn_(\d+)/.test(id)?Number(/agent_turn_(\d+)/.exec(id)![1]):1e9+i})).sort((a,b)=>a.order-b.order);
 if(!Number.isInteger(ordinal)||ordinal<1||ordinal>ordered.length) throw new Error(`action ordinal ${ordinal} out of range: ${ordered.length} executable controls`);
 return {actionId:ordered[ordinal-1].id,route:ordered[ordinal-1].route};
}
export function payloadForRoute(route: any, message: string) {
 const payload={...Object.fromEntries((route.payloadFields||[]).map((f:string,i:number)=>[f,`${message} ${f} ${i+1}`])),prompt:message,context:`${message} context`,state:'active',nextStep:'继续输入',result:`${message} result`};
 const key=route.payloadSource==='event.formData'?'formData':route.payloadSource==='event.patch'?'patch':'payload';
 return {[key]:payload,sourceComponentId:route.componentId};
}

function lc(v: unknown): string {
  return JSON.stringify(v ?? '').toLowerCase();
}
export function includesAll(hay: unknown, needle: unknown): boolean {
  const text = lc(hay);
  const values = Array.isArray(needle) ? needle : [needle];
  return values.every((v) => text.includes(String(v).toLowerCase()));
}
function traceHasOrchestrator(trace: unknown): boolean {
  return Array.isArray(trace) && trace.some((t: any) => String(t?.agent || '').toLowerCase().includes('orchestrator'));
}

// The bridge names capabilities by OpenAPI operationId (search_songs_songs_get),
// while benchmark assertions use AppWorld's clean api names (search_songs).
// FastAPI operationIds are `{api}{path with /{}→_}_{method}`, so the clean name
// is recoverable exactly from the recorded call's tool descriptor — no prefix
// guessing (which would collide show_product with show_product_reviews).
export function cleanApiName(tool: any): string {
  const op = String(tool?.operationId ?? tool?.apiName ?? '').toLowerCase().trim();
  if (!op) return '';
  const path = String(tool?.path ?? '');
  const method = String(tool?.method ?? '').toLowerCase().trim();
  if (!path || !method) return op;
  const suffix = `${path.replace(/[/{}]/g, '_')}_${method}`.toLowerCase();
  return op.endsWith(suffix) ? op.slice(0, -suffix.length) : op;
}

// Exact-match the tool-id segment: split toolResults keys on '.'/'#'/':' and
// compare the final (non-counter) segment — and the full key — case-insensitively.
// 'service.api' qualified values match the trailing two segments. This kills
// substring collisions like like_song matching unlike_song. When the key's
// segment is an operationId, fall back to the recorded call value's tool
// descriptor and compare clean api names exactly.
export function apiWasCalled(actionResult: any, apiName: unknown): boolean {
  const tr = actionResult?.toolResults;
  if (!tr || typeof tr !== 'object') return false;
  const want = String(apiName).toLowerCase().trim();
  if (!want) return false;
  const wantParts = want.split('.').filter(Boolean);
  return Object.entries(tr).some(([key, value]) => {
    const lower = key.toLowerCase();
    // Step-executed calls are keyed by capability (may be 'tool.mcp.call') and
    // carry their descriptor under .appworld instead of .tool — inspect any
    // entry that has an appworld descriptor, not just appworld-prefixed keys.
    const descriptor = (value as any)?.tool ?? (value as any)?.appworld;
    if (!lower.includes('appworld') && !descriptor) return false;
    if (lower === want) return true;
    // grounding call keys carry a '#<n>' occurrence counter — drop numeric segments
    const segments = lower.split(/[.#:]/).filter((segment) => segment && !/^\d+$/.test(segment));
    if (segments.length) {
      if (wantParts.length === 2) {
        if (segments.length >= 2
          && segments[segments.length - 2] === wantParts[0]
          && segments[segments.length - 1] === wantParts[1]) return true;
      } else if (segments[segments.length - 1] === want) return true;
    }
    const tool = descriptor;
    if (!tool) return false;
    const clean = cleanApiName(tool);
    if (!clean) return false;
    if (wantParts.length === 2) {
      return String(tool.appName ?? '').toLowerCase() === wantParts[0] && clean === wantParts[1];
    }
    return clean === want;
  });
}

const KNOWN_SERVICES = new Set([
  'spotify', 'amazon', 'gmail', 'phone', 'venmo', 'splitwise', 'todoist', 'simple_note', 'file_system',
]);

// 'simple_note' / 'file_system' are real single-service names containing '_';
// only a value that splits into TWO known services (e.g. 'amazon_venmo') is the
// deprecated AND form.
export function dbChangeTargets(appName: string): string[] {
  const want = appName.toLowerCase().trim();
  if (KNOWN_SERVICES.has(want) || !want.includes('_')) return [want];
  for (let i = want.indexOf('_'); i !== -1; i = want.indexOf('_', i + 1)) {
    const left = want.slice(0, i);
    const right = want.slice(i + 1);
    if (KNOWN_SERVICES.has(left) && KNOWN_SERVICES.has(right)) {
      console.warn(`[appworld-bench] deprecated appworld_db_changed value '${appName}': interpreted as AND over '${left}' + '${right}'; use one assertion per service`);
      return [left, right];
    }
  }
  return [want];
}

// Exact-match appName equality (case-insensitive) — no substring 'includes',
// so 'venmo' no longer matches an asserted 'amazon_venmo' and vice versa.
export function dbChanged(actionResult: any, appName: unknown): boolean {
  const changes = actionResult?.toolDbChanges;
  if (!Array.isArray(changes)) return false;
  const targets = dbChangeTargets(String(appName));
  return targets.every((target) =>
    changes.some((c: any) => String(c?.appName || '').toLowerCase() === target && Number(c?.delta || 0) > 0));
}

// Echo exclusion for state_persists: the runtimeState echoes the submitted
// payload back through lastIntentPayload/lastActionPayload/workflowPrompt/
// workflowContext/sourcePrompt — asserting against those keys would score the
// echo of the user's own message, not persisted app state.
// lastVisibleSummary/lastVisibleResult are display echoes rebuilt from the raw
// payload every turn (businessPayloadSummary), and intentResult bullets embed a
// compacted copy of the message ('已结合最近上下文：…') — all found leaking by
// the 2026-07-26 scorer audit, so key-level exclusion alone is not enough.
const ECHO_KEYS = ['lastIntentPayload', 'lastActionPayload', 'workflowPrompt', 'workflowContext', 'sourcePrompt',
  'lastVisibleSummary', 'lastVisibleResult'];

// A scope string is a payload echo if it reproduces the leading chunk of a
// user message verbatim (the runtime compacts the raw message into summaries,
// bullets and record fields, always from the head). Genuine app output quotes
// entities from mid-message; only echoes reproduce the exact head.
const ECHO_CHUNK = 20;
export function isEchoString(value: string, messages: string[]): boolean {
  if (value.startsWith('已结合最近上下文')) return true;
  for (const m of messages) {
    const msg = String(m ?? '').trim();
    if (msg.length >= ECHO_CHUNK) {
      if (value.includes(msg.slice(0, ECHO_CHUNK))) return true;
    } else if (msg.length >= 12 && value.includes(msg)) {
      return true;
    }
  }
  return false;
}
export function stripEchoDeep(node: any, messages: string[]): any {
  if (typeof node === 'string') return isEchoString(node, messages) ? undefined : node;
  if (Array.isArray(node)) return node.map((x) => stripEchoDeep(x, messages)).filter((x) => x !== undefined);
  if (node && typeof node === 'object') {
    const out: Record<string, any> = {};
    for (const [key, v] of Object.entries(node)) {
      if (ECHO_KEYS.includes(key)) continue;
      const s = stripEchoDeep(v, messages);
      if (s !== undefined) out[key] = s;
    }
    return out;
  }
  return node;
}
export function sanitizedReopenState(reopenState: unknown, messages: string[] = []): unknown {
  if (!reopenState || typeof reopenState !== 'object') return reopenState;
  return stripEchoDeep(JSON.parse(JSON.stringify(reopenState)), messages);
}

export function checkAssertion(a: Assertion, ctx: { pkg?: any; actionResult?: any; reopenState?: any; reopenData?: any; caseMessages?: string[] }): { passed: boolean; message?: string } {
  try {
    switch (a.type) {
      case 'input_available': {
        const ok = pkgHasEditableInput(ctx.pkg);
        return { passed: ok, message: ok ? undefined : 'no editable input in package UI' };
      }
      case 'action_available': {
        const ok = pkgHasActionBoundInteraction(ctx.pkg);
        return { passed: ok, message: ok ? undefined : 'no action-bound interaction in package UI' };
      }
      case 'route_exists': {
        const ok = pkgHasWorkflowRoute(ctx.pkg);
        return { passed: ok, message: ok ? undefined : 'no executable workflow route in package' };
      }
      case 'route_enters_orchestrator': {
        const ok = traceHasOrchestrator(ctx.actionResult?.trace);
        return { passed: ok, message: ok ? undefined : 'trace missing orchestrator' };
      }
      case 'appworld_api_called': {
        const ok = apiWasCalled(ctx.actionResult, a.value);
        return { passed: ok, message: ok ? undefined : `appworld api ${a.value} not called` };
      }
      case 'appworld_db_changed': {
        const ok = dbChanged(ctx.actionResult, a.value);
        return { passed: ok, message: ok ? undefined : `appworld db ${a.value} not changed` };
      }
      case 'visible_result_grounded': {
        // Assert ONLY against the intent result (plus grounded entities/stats).
        // The whole-runtimeState fallback scored payload echoes as grounding,
        // and intentResult bullets embed a compacted message echo — strip both.
        const rs = ctx.actionResult?.runtimeState;
        const scope = stripEchoDeep({
          intentResult: rs?.intentResult,
          ...(rs?.entities !== undefined ? { entities: rs.entities } : {}),
          ...(rs?.entityStats !== undefined ? { entityStats: rs.entityStats } : {}),
        }, ctx.caseMessages ?? []);
        const ok = includesAll(scope, a.value);
        return { passed: ok, message: ok ? undefined : 'visible result missing grounded entity (echoes excluded)' };
      }
      case 'state_persists': {
        // Persisted state = runtimeState PLUS the app's data collections —
        // records live in stored.data and runtimeState.entities is replaced
        // per turn, so runtimeState alone false-fails earlier-turn values.
        // Both surfaces get the same echo strip.
        const scope = {
          state: sanitizedReopenState(ctx.reopenState, ctx.caseMessages ?? []),
          ...(ctx.reopenData !== undefined ? { data: stripEchoDeep(JSON.parse(JSON.stringify(ctx.reopenData)), ctx.caseMessages ?? []) } : {}),
        };
        const ok = includesAll(scope, a.value);
        return { passed: ok, message: ok ? undefined : 'state not persisted after reopen (echoes excluded)' };
      }
      default:
        return { passed: false, message: `unsupported assertion ${a.type}` };
    }
  } catch (e) {
    return { passed: false, message: (e as Error).message };
  }
}

