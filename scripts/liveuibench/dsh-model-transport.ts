import type {Transport} from './transport.js';
// Credentials remain in the trusted Node transport, never the browser DOM or report.
export type WorkflowLlm = {model?:string;apiKey?:string;apiBase?:string};
export function withDshWorkflowLlm(transport:Transport,llm?:WorkflowLlm):Transport {
  if(!llm)return transport;
  const selected=Object.fromEntries(Object.entries(llm).filter(([key,value])=>['model','apiKey','apiBase'].includes(key)&&typeof value==='string'&&value.trim()).map(([key,value])=>[key,value!.trim()])) as WorkflowLlm;
  if(!Object.keys(selected).length)return transport;
  return {user:transport.user,async request(route,body,method){
    const action=/^\/agent\/complete\/apps\/[^/]+\/action$/.test(route);
    const generate=route==='/agent/run';
    const response=await transport.request(route,(action||generate)?{...body,llm:{...(body?.llm||{}),...selected}}:body,method);
    if((action||generate)&&selected.model&&(response?.execution?.harness!=='dsh'||response?.execution?.model!==selected.model)){
      throw Error(`DSH runtime model was not confirmed for ${route}: expected ${selected.model}, received ${response?.execution?.model || 'missing'}`);
    }
    return response;
  }};
}
