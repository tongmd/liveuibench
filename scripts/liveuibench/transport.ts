export type Transport = { request(route: string, body?: any, method?: string): Promise<any>; user: string };
export function httpTransport(base: string, user: string, timeoutMs = 900_000, onResponse?: (record:any)=>Promise<void>, authorization = process.env.LIVEUIBENCH_AUTHORIZATION): Transport {
  if (authorization && (!/^(Basic|Bearer) [^\r\n]+$/.test(authorization))) throw new Error('LIVEUIBENCH_AUTHORIZATION must be a Basic or Bearer header without line breaks');
  const url = new URL(base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('api-base must be an HTTP(S) URL without credentials/query/fragment');
  return { user, async request(route, body, method = body === undefined ? 'GET' : 'POST') {
    const started = Date.now();
    const response = await fetch(base.replace(/\/$/,'') + route, {method, headers:{'Content-Type':'application/json','X-Guios-User':user,...(authorization?{Authorization:authorization}:{})},body:body === undefined ? undefined : JSON.stringify(body),signal:AbortSignal.timeout(timeoutMs)});
    const raw = await response.text();
    let data:any;try { data=JSON.parse(raw); } catch { throw new Error(`${route}: non-JSON HTTP ${response.status}`); }
    await onResponse?.({route,method,status:response.status,elapsedMs:Date.now()-started,response:data});
    if (!response.ok) throw new Error(`${route}: HTTP ${response.status}: ${data.error || data.message || 'request failed'}`);
    if(response.status===202 && (data.id || data.jobId)) {
      const jobId=data.id || data.jobId;let job={status:'queued',...data};
      while(['queued','running'].includes(job.status)) {
        if(Date.now()-started>=timeoutMs) throw new Error(`Job ${jobId} timed out`);
        await new Promise(r=>setTimeout(r,500));
        job=await this.request('/agent/complete/jobs/'+encodeURIComponent(jobId));
      }
      if(job.status!=='done') throw new Error(`Job ${jobId} ${job.status}: ${job.error||'incomplete'}`);
      return job;
    }
    return data;
  }};
}
