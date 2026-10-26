import {parsePlanningRecovery,planningInputBinding,type PlanningRecovery} from './planning-recovery.js';
import {validateNativeActionNotStartedProof,nativeActionPayloadSha256,type NativeActionNotStartedProof} from '../../liveuiagent/server/native-action-not-started.js';
import {request as httpRequest} from 'node:http';
import {request as httpsRequest} from 'node:https';

const planningRecoveries=new WeakMap<object,{proof:PlanningRecovery;binding:string}>();
export function verifiedNativePlanningRecovery(error:unknown,user:string,body:any){const x=error&&typeof error==='object'?planningRecoveries.get(error):undefined;return x&&x.binding===planningInputBinding(user,body)?structuredClone(x.proof):undefined;}
const verifiedNotStarted=new WeakMap<object,NativeActionNotStartedProof>();
export function verifiedNativeActionNotStarted(error:unknown,binding:{appId:string;actionId:string;eventPayload:unknown}){const proof=error&&typeof error==='object'?verifiedNotStarted.get(error):undefined;return proof&&validateNativeActionNotStartedProof(proof,binding)?proof:undefined;}

export type Transport = { request(route: string, body?: any, method?: string, options?:{deadlineAt?:number}): Promise<any>; user: string; requestTimeoutMs?:number };

// One deadline covers headers, the entire response body and asynchronous job polling.
// Node's HTTP client has no separate implicit fetch/Undici headers timeout.
function readResponse(url: URL, method: string, headers: Record<string,string>, body: string | undefined, deadline: number): Promise<{status:number;raw:string}> {
  return new Promise((resolve,reject) => {
    const remaining=deadline-Date.now();
    const timeout=()=>Object.assign(new Error('HTTP request deadline exceeded'),{code:'ETIMEDOUT'});
    if(remaining<=0){reject(timeout());return;}
    const request=(url.protocol==='https:'?httpsRequest:httpRequest)(url,{method,headers},response=>{
      const chunks:Buffer[]=[];
      response.on('data',chunk=>chunks.push(Buffer.from(chunk)));
      response.on('error',reject);
      response.on('end',()=>resolve({status:response.statusCode||0,raw:Buffer.concat(chunks).toString('utf8')}));
    });
    const timer=setTimeout(()=>request.destroy(timeout()),remaining);
    request.on('error',reject);
    request.on('close',()=>clearTimeout(timer));
    if(body!==undefined)request.write(body);
    request.end();
  });
}

function inferenceMetrics(value:any){
 if(!value||typeof value!=='object')return undefined;
 const keys=['providerRequests','responseBytes','upstreamStatus','prompt_tokens','completion_tokens','total_tokens','reasoning_tokens'];
 return Object.fromEntries(keys.filter(k=>Number.isSafeInteger(value[k])&&value[k]>=0).map(k=>[k,value[k]]));
}

export function httpTransport(base: string, user: string, timeoutMs = 900_000, onResponse?: (record:any)=>Promise<void>, authorization = process.env.LIVEUIBENCH_AUTHORIZATION): Transport {
  if (authorization && (!/^(Basic|Bearer) [^\r\n]+$/.test(authorization))) throw new Error('LIVEUIBENCH_AUTHORIZATION must be a Basic or Bearer header without line breaks');
  const url = new URL(base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('api-base must be an HTTP(S) URL without credentials/query/fragment');
  if(!Number.isFinite(timeoutMs)||timeoutMs<=0)throw new Error('HTTP timeout must be a positive finite number');
  async function request(route:string,body:any,method:string,deadline:number):Promise<any>{
    const started=Date.now();
    let response:{status:number;raw:string};
    try{
      response=await readResponse(new URL(base.replace(/\/$/,'')+route),method,{'Content-Type':'application/json','X-LiveUIAgent-User':user,...(authorization?{Authorization:authorization}:{})},body===undefined?undefined:JSON.stringify(body),deadline);
    }catch(cause){
      const error=cause as NodeJS.ErrnoException;
      // Preserve diagnosis without retaining a ClientRequest, headers or provider settings.
      const diagnostic=Object.assign(new Error(error.message),{...(error.code?{code:error.code}:{})});
      throw new Error(`${route}: HTTP transport failed${error.code?' ['+error.code+']':''}: ${error.message}`,{cause:diagnostic});
    }
    let data:any;try { data=JSON.parse(response.raw); } catch { throw new Error(`${route}: non-JSON HTTP ${response.status}`); }
    const actionFailure=route==='/agent/action'&&(response.status<200||response.status>=300);
    let proofValid=false;try{proofValid=actionFailure&&data.workflowExecution?.status==='failed'&&data.workflowExecution?.externalEffectsMayHaveOccurred===false&&data.workflowExecution?.executionId===data.nativeActionNotStarted?.executionId&&validateNativeActionNotStartedProof(data.nativeActionNotStarted,{appId:body?.appId,actionId:body?.actionId,eventPayload:body?.eventPayload});}catch{/* Malformed or absent binding is not proof. */}
    const proofAudit=actionFailure?{present:data.nativeActionNotStarted!==undefined,valid:proofValid,...(proofValid?{executionId:data.nativeActionNotStarted.executionId,eventPayloadSha256:nativeActionPayloadSha256(body.eventPayload)}:{})}:undefined;
    await onResponse?.({route,method,status:response.status,elapsedMs:Date.now()-started,response:data,...(proofAudit?{nativeActionNotStartedValidation:proofAudit}:{})});
    if (response.status<200||response.status>=300) {const error=Object.assign(new Error(`${route}: HTTP ${response.status}: ${data.error || data.message || 'request failed'}`),route==='/evaluator/interaction-step'&&Number.isInteger(data.plannerModelCalls)&&data.plannerModelCalls>=0&&data.plannerModelCalls<=1?{plannerModelCalls:data.plannerModelCalls,status:response.status,...(typeof data.code==='string'?{code:data.code}:{}),...(data.planningContractInvalid===true?{planningContractInvalid:true}:{}),planningError:typeof data.error==='string'?data.error.slice(0,500):'Planning contract rejected'}:{});if(route==='/evaluator/interaction-step'){const metrics=inferenceMetrics(data.nativeInference);if(metrics)Object.assign(error,{nativeInference:metrics});const proof=parsePlanningRecovery(data,response.status);if(proof)planningRecoveries.set(error,{proof,binding:planningInputBinding(user,body)});}if(proofValid){verifiedNotStarted.set(error,data.nativeActionNotStarted);Object.assign(error,{nativeActionNotStarted:data.nativeActionNotStarted,nativeActionNotStartedValidation:proofAudit});}throw error;}
    if(response.status===202 && (data.id || data.jobId)) {
      const jobId=data.id || data.jobId;let job={status:'queued',...data};
      while(['queued','running'].includes(job.status)) {
        const remaining=deadline-Date.now();
        if(remaining<=0)throw Object.assign(new Error(`Job ${jobId} timed out`),{code:'ETIMEDOUT'});
        await new Promise(r=>setTimeout(r,Math.min(500,remaining)));
        if(Date.now()>=deadline)throw Object.assign(new Error(`Job ${jobId} timed out`),{code:'ETIMEDOUT'});
        job=await request('/agent/complete/jobs/'+encodeURIComponent(jobId),undefined,'GET',deadline);
      }
      if(job.status!=='done') throw new Error(`Job ${jobId} ${job.status}: ${job.error||'incomplete'}`);
      return job;
    }
    return data;
  }
  return {user,requestTimeoutMs:timeoutMs,request(route,body,method=body===undefined?'GET':'POST',options){const deadline=Math.min(Date.now()+timeoutMs,options?.deadlineAt??Infinity);if(!Number.isFinite(deadline))throw Error('Invalid HTTP deadline');return request(route,body,method,deadline);}};
}
