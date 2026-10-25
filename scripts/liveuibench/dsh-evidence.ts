import {stripEchoDeep} from './scorer.js';

// Consume only host-produced evidence from completed bridge actions in this turn.
// Model result text, DOM attributes and previous-turn observations are not audit evidence.
export function dshActionEvidence(bridgeResults: unknown, appId: string, visibleText: string, caseMessages: string[] = []) {
  const trace: any[] = [];
  const toolResults: Record<string, unknown> = {};
  const toolDbChanges: any[] = [];
  const visibleHostFragments: string[] = [];
  const normalized=(value:string)=>value.replace(/\s+/g,' ').trim();
  const visible=normalized(visibleText);
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
    const result=job.result;
    const hostText=typeof result?.text==='string'?result.text:'';
    // A whole verified host response must be visible before considering its scalar
    // projections. Never split a prompt/DOM echo into shorter scoring fragments.
    if(result?.ok===true && normalized(hostText) && visible.includes(normalized(hostText))
      && typeof stripEchoDeep(hostText,caseMessages)==='string') {
      const candidates=[hostText,...(Array.isArray(result.data?.entities)?result.data.entities:[]).flatMap((entity:any)=>
        ['name','id','detail','group'].map(key=>entity?.[key])),
        ...(Array.isArray(result.data?.stats)?result.data.stats:[]).flatMap((stat:any)=>[stat?.label,stat?.value])];
      for(const value of candidates){
        const candidate=typeof value==='string'?value:typeof value==='number'&&Number.isFinite(value)?String(value):'';
        if(normalized(candidate)
        && visible.includes(normalized(candidate)) && typeof stripEchoDeep(candidate,caseMessages)==='string')
        visibleHostFragments.push(candidate);
      }
    }
  }
  return { trace, toolResults, toolDbChanges, runtimeState: { intentResult: { text: visibleText, visibleHostFragments: [...new Set(visibleHostFragments)] } } };
}
