import {request as httpRequest} from 'node:http';
import {request as httpsRequest} from 'node:https';

export type Transport = { request(route: string, body?: any, method?: string): Promise<any>; user: string };

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
    await onResponse?.({route,method,status:response.status,elapsedMs:Date.now()-started,response:data});
    if (response.status<200||response.status>=300) throw Object.assign(new Error(`${route}: HTTP ${response.status}: ${data.error || data.message || 'request failed'}`),route==='/evaluator/interaction-step'&&Number.isInteger(data.plannerModelCalls)&&data.plannerModelCalls>=0&&data.plannerModelCalls<=1?{plannerModelCalls:data.plannerModelCalls}:{});
    if(response.status===202 && (data.id || data.jobId)) {
      const jobId=data.id || data.jobId;let job={status:'queued',...data};
      while(['queued','running'].includes(job.status)) {
        const remaining=deadline-Date.now();
        if(remaining<=0)throw new Error(`Job ${jobId} timed out`);
        await new Promise(r=>setTimeout(r,Math.min(500,remaining)));
        if(Date.now()>=deadline)throw new Error(`Job ${jobId} timed out`);
        job=await request('/agent/complete/jobs/'+encodeURIComponent(jobId),undefined,'GET',deadline);
      }
      if(job.status!=='done') throw new Error(`Job ${jobId} ${job.status}: ${job.error||'incomplete'}`);
      return job;
    }
    return data;
  }
  return {user,request(route,body,method=body===undefined?'GET':'POST'){return request(route,body,method,Date.now()+timeoutMs);}};
}
