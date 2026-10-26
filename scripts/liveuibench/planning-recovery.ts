import{createHash}from'node:crypto';
export type PlanningRecovery={schema:'native-gui-pure-planning-recovery-v1';token:string;effectiveDeadlineAt:number;initialInvocationId:string;kind:'transport_eof'|'contract_invalid';remainingRecoveries:1};
const canonical=(v:any):any=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
export const planningInputBinding=(user:string,body:any)=>createHash('sha256').update(JSON.stringify(canonical({user,appId:body?.appId,harness:body?.harness,model:body?.model,userMessage:body?.userMessage,snapshot:body?.snapshot,observations:body?.observations}))).digest('hex');
/** Called only by trusted configured HTTP transport after a complete JSON body.
 * A JSON-looking Error or network EOF is never a locally verified host proof. */
export function parsePlanningRecovery(response:any,status:number):PlanningRecovery|undefined{
 const p=response?.planningRecovery;if(!p||typeof p!=='object'||Object.keys(p).sort().join(',')!=='effectiveDeadlineAt,initialInvocationId,kind,remainingRecoveries,schema,token'||p.schema!=='native-gui-pure-planning-recovery-v1'||typeof p.token!=='string'||!/^([0-9a-f]{64})$/.test(p.token)||!Number.isSafeInteger(p.effectiveDeadlineAt)||p.effectiveDeadlineAt<=Date.now()||typeof p.initialInvocationId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(p.initialInvocationId)||!['transport_eof','contract_invalid'].includes(p.kind)||p.remainingRecoveries!==1||response.plannerModelCalls!==1)return;
 if(p.kind==='contract_invalid'&&!(status===400&&response.code==='invalid_gui_interaction'&&response.planningContractInvalid===true))return;
 // The frozen host issuer permits only this exact transport error. A shaped
 // ticket cannot override cancellation, deadline, authentication or quota errors.
 if(p.kind==='transport_eof'&&!(status===500&&response.code==='dsh_native_upstream_transport'))return;
 return structuredClone(p);
}
