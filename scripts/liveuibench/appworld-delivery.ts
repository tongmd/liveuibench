import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import Database from 'better-sqlite3';

export type DeliveryRequest={orderId:number;deliveredAt?:string};
// Official AppWorld stores delivery on order_items, not orders.
// This helper edits only a freshly exported full snapshot, never base_dbs.
export function patchDeliverySnapshot(dbFile:string, requests:DeliveryRequest[]){
 const db=new Database(dbFile,{fileMustExist:true});
 try{return db.transaction(()=>requests.map(({orderId,deliveredAt})=>{
  if(!Number.isSafeInteger(orderId)||orderId<1)throw new Error('Invalid delivery fixture order ID');
  if(deliveredAt&&Number.isNaN(Date.parse(deliveredAt)))throw new Error('Invalid deliveredAt fixture timestamp');
  const rows=db.prepare('SELECT id, delivered_at, expected_delivery_at FROM order_items WHERE order_id=?').all(orderId) as any[];
  if(!rows.length)throw new Error(`Delivery fixture order ${orderId} has no order_items`);
  for(const row of rows){const timestamp=deliveredAt||row.expected_delivery_at;if(!timestamp||Number.isNaN(Date.parse(String(timestamp))))throw new Error(`Order item ${row.id} has no valid delivery timestamp`);db.prepare('UPDATE order_items SET delivered_at=? WHERE id=? AND order_id=?').run(timestamp,row.id,orderId);}
  const after=db.prepare('SELECT id, delivered_at FROM order_items WHERE order_id=?').all(orderId) as any[];
  if(after.some(row=>!row.delivered_at))throw new Error('Delivery snapshot verification failed');
  return {orderId,items:after};
 }))();}finally{db.close();}
}

export async function deliverOrdersInManagedWorld(api:string,requests:DeliveryRequest[],stateDir=process.env.LIVEUIBENCH_WORLD_STATE_DIR){
 if(!requests.length)return;
 const url=new URL(api);
 if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||!stateDir)throw new Error('Delivery fixtures require the local isolated AppWorld prepare hook and LIVEUIBENCH_WORLD_STATE_DIR');
 const state=await fs.realpath(stateDir);const processRecord=JSON.parse(await fs.readFile(path.join(state,'process.json'),'utf8'));
 if(Number(url.port||80)!==processRecord.port||!Number.isSafeInteger(processRecord.pid))throw new Error('Delivery fixture API does not match the managed AppWorld process');
 process.kill(processRecord.pid,0);
 async function call(route:string,body?:any){const response=await fetch(api.replace(/\/$/,'')+route,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(120000)});const text=await response.text();if(!response.ok)throw new Error(`AppWorld ${route}: HTTP ${response.status}`);return JSON.parse(text);}
 const homes=await call('/dbs') as Record<string,string>;const appNames=Object.keys(homes);const uniqueHomes=[...new Set(Object.values(homes))];
 if(!appNames.includes('amazon')||uniqueHomes.length!==1||!uniqueHomes[0].startsWith(':memory:'))throw new Error('Delivery preparation requires one isolated in-memory world; refusing disk/base database paths');
 const directory=path.join(state,'delivery-'+randomUUID());await fs.mkdir(directory);const snapshot=path.join(directory,'snapshot');
 await call('/dbs/save',{from_db_home_path:uniqueHomes[0],to_db_home_path:snapshot,format:'full',app_names:appNames,delete_if_exists:false});
 // Retain an unmodified Amazon backup; all other app snapshots remain byte-identical.
 const amazon=path.join(snapshot,'amazon.db');await fs.copyFile(amazon,path.join(directory,'amazon-before.db'));
 const untouched:Record<string,string>={};for(const name of appNames.filter(x=>x!=='amazon'))untouched[name]=createHash('sha256').update(await fs.readFile(path.join(snapshot,name+'.db'))).digest('hex');
 const changed=patchDeliverySnapshot(amazon,requests);
 for(const [name,digest] of Object.entries(untouched)){const actual=createHash('sha256').update(await fs.readFile(path.join(snapshot,name+'.db'))).digest('hex');if(actual!==digest)throw new Error(`Unrelated ${name} snapshot changed during delivery patch`);}
 // A fresh memory key is essential: AppWorld caches engines by destination path.
 const destination=':memory:liveuibench-delivery-'+randomUUID();
 await call('/dbs',{from_db_home_path:snapshot,to_db_home_path:destination,create:false});
 const loaded=await call('/dbs') as Record<string,string>;
 if(appNames.some(name=>loaded[name]!==destination))throw new Error('AppWorld did not load the full patched world');
 const verification=path.join(directory,'verification');await call('/dbs/save',{from_db_home_path:destination,to_db_home_path:verification,format:'full',app_names:['amazon'],skip_mandatory_apps:true,delete_if_exists:false});
 const db=new Database(path.join(verification,'amazon.db'),{readonly:true,fileMustExist:true});
 try{for(const order of changed)for(const item of order.items){const actual=db.prepare('SELECT delivered_at FROM order_items WHERE id=? AND order_id=?').get(item.id,order.orderId) as any;if(actual?.delivered_at!==item.delivered_at)throw new Error('Live AppWorld delivery read-back did not match patched snapshot');}}finally{db.close();}
 const report={api,orders:changed,preservedApps:Object.keys(untouched),snapshot,loadedMemoryHome:destination};await fs.writeFile(path.join(directory,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(`  delivered ${changed.length} order(s); full-world snapshot and verification: ${directory}`);return report;
}
