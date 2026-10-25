import type {CompleteAppStep} from '../../liveuiagent/server/complete-app-evaluator.js';
type Field={target:string;label:string;tag:string;type:string;inputName?:string;inputId?:string;value?:string;disabled?:boolean;required?:boolean;options?:Array<{value:string;label:string}>};
const textTypes = new Set(['','text','search','email','url','tel']);
const escape = (text:string) => text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
function unsupported(message:string):never {throw Error(`Unsupported form interaction: ${message}`);}
export function planFormSubmission(fields:Field[],message:string,options:{explicitlyBound?:boolean}={}):CompleteAppStep[] {
  if(!message.trim() || message.length>4000)unsupported('message must contain 1..4000 characters');
  const editable=fields.filter(field=>!field.disabled && (field.tag==='textarea'||field.tag==='select'||textTypes.has(field.type)||['number','date','time'].includes(field.type)));
  if(!editable.length)unsupported('no editable fields');
  const labels=editable.map(field=>field.label.trim().toLowerCase());
  if(labels.some(label=>!label)||new Set(labels).size!==labels.length)unsupported('field labels are missing or ambiguous');
  const commandFields=options.explicitlyBound?editable.filter(field=>(field.tag==='textarea'||['','text'].includes(field.type))&&field.tag!=='select'&&/task|request|instruction|prompt/i.test([field.label,field.inputName,field.inputId].filter(Boolean).join(' '))):[];
  if(commandFields.length>1)unsupported('multiple natural-language command fields in the explicit action form');
  const commandTarget=commandFields[0]?.target;
  const plan:CompleteAppStep[]=[];
  for(const field of editable){
    const expression=new RegExp('(?:^|[;\\n])\\s*'+escape(field.label.trim())+'\\s*(?::|=|\\bis\\b)\\s*(.*?)(?=[;\\n]|$)','gi');
    const matches=[...message.matchAll(expression)];
    if(matches.length>1)unsupported(`duplicate value for ${field.label}`);
    let value=matches[0]?.[1]?.trim();
    if(value===undefined && ((editable.length===1 && (textTypes.has(field.type)||field.tag==='textarea'))||field.target===commandTarget))value=message;
    if(value===undefined){if(field.required&&!field.value)unsupported(`missing required value for ${field.label}`);continue;}
    if((value.startsWith('"')&&value.endsWith('"'))||(value.startsWith("'")&&value.endsWith("'")))value=value.slice(1,-1);
    if(field.tag==='select'){
      const choices=(field.options||[]).filter(option=>option.value.toLowerCase()===value!.toLowerCase()||option.label.toLowerCase()===value!.toLowerCase());
      if(choices.length!==1)unsupported(`unknown or ambiguous option for ${field.label}`);
      plan.push({kind:'select',target:field.target,value:choices[0].value});continue;
    }
    if(field.type==='number'&&(!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value)||!Number.isFinite(Number(value))))unsupported(`invalid number for ${field.label}`);
    if(field.type==='date'&&(!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value))unsupported(`invalid ISO date for ${field.label}`);
    if(field.type==='time'&&!/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(value))unsupported(`invalid time for ${field.label}`);
    plan.push({kind:'fill',target:field.target,value});
  }
  if(!plan.length)unsupported('no unambiguous label/value mapping; use visible labels and explicit values');
  return plan;
}
