/** Inference harness and UI delivery are independent. Old HTML receipts did
 * not carry execution.delivery, so require their persisted package marker. */
export function actualDelivery(generated:any,artifactReplay=false):'html'|'native' {
 const pkg=generated?.appPackage;const id=pkg?.manifest?.appId;
 if(typeof id!=='string'||!id)throw Error('Missing actual delivery package identity');
 const html=pkg.manifest.intent?.kind==='complete_app';
 const surface=pkg.ui?.meta?.a2ui;const native=surface?.protocol==='a2ui'&&typeof surface.surfaceId==='string'&&Array.isArray(surface.messages)&&surface.initialData&&typeof surface.initialData==='object'&&!html;
 const declared=generated.execution?.delivery;
 if(declared!==undefined&&!['html','native'].includes(declared))throw Error('Unknown actual delivery declaration');
 if(html&&!id.startsWith('dsh_'))throw Error('HTML package delivery identity mismatch');
 if(native&&id.startsWith('dsh_'))throw Error('Native package uses reserved HTML identity');
 if(!html&&!native)throw Error('Package has no supported actual delivery surface');
 const delivery=html?'html':'native';
 if(declared&&declared!==delivery)throw Error('Declared delivery conflicts with package structure');
 if(artifactReplay&&delivery!=='html')throw Error('Artifact replay is limited to diagnostic HTML delivery');
 return delivery;
}
