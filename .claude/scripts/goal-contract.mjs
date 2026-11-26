// Structured task goals and worker reports. These checks validate shape, not truth.
const string={type:'string'};
const strings={type:'array',items:string};
const object=properties=>({type:'object',additionalProperties:false,required:Object.keys(properties),properties});
export const contractSchema=object({
  kind:{type:'string',enum:['investigate','modify','investigate-and-modify']},
  deliverables:{type:'array',items:object({id:string,description:string})},
  allowedChanges:strings,excludedChanges:strings,acceptanceCriteria:strings
});
const outcome={type:'string',enum:['completed','partial','blocked']};
export const executionSchema=object({
  outcome,
  deliverables:{type:'array',items:object({id:string,status:outcome,summary:string,evidence:strings})},
  verification:{type:'array',items:object({description:string,status:{type:'string',enum:['passed','failed','blocked','not-applicable']},evidence:strings})},
  unfinished:strings,changeExplanation:string,report:string
});
const text=v=>{if(typeof v!=='string'||!v.trim())throw Error('需要非空文本');return v;};
function shape(v,keys){
  if(!v||typeof v!=='object'||Array.isArray(v)||keys.some(k=>!Object.hasOwn(v,k))||Object.keys(v).some(k=>!keys.includes(k)))throw Error('字段缺失或包含未知字段');
}
function texts(v,required=false){if(!Array.isArray(v)||(required&&!v.length))throw Error('需要文本列表');v.forEach(text);return v;}
export function validateContract(v){
  try{
    shape(v,Object.keys(contractSchema.properties));
    if(!contractSchema.properties.kind.enum.includes(v.kind))throw Error('未知任务类型');
    if(!Array.isArray(v.deliverables)||!v.deliverables.length)throw Error('deliverables 不得为空');
    const ids=new Set();const deliverables=v.deliverables.map(d=>{
      shape(d,['id','description']);if(typeof d.id!=='string'||!(/^[A-Za-z0-9_-]{1,64}$/).test(d.id)||ids.has(d.id))throw Error('交付项 ID 必须唯一且有效');
      ids.add(d.id);return {id:d.id,description:text(d.description)};
    });
    texts(v.allowedChanges,v.kind!=='investigate');
    if(v.kind==='investigate'&&v.allowedChanges.length)throw Error('调查报告任务不得授权业务文件修改；如需修改项目文档，请选择 modify');
    return {kind:v.kind,deliverables,allowedChanges:v.allowedChanges,excludedChanges:texts(v.excludedChanges),acceptanceCriteria:texts(v.acceptanceCriteria,true)};
  }catch(e){throw Error(`交付目标 contract 无效：${e.message}`);}
}
export const kindLabels={investigate:'调查报告',modify:'修改交付物','investigate-and-modify':'调查后完成修改'};
export function renderPlan(contract,body){
  return ['# 交付目标',`任务类型：${kindLabels[contract.kind]}`,'','## 最终交付物',
    ...contract.deliverables.map(d=>`- ${d.id}：${d.description}`),'','## 执行阶段允许修改',
    ...(contract.allowedChanges.length?contract.allowedChanges.map(v=>`- ${v}`):['- 不修改业务文件；原因报告由宿主保存在任务工作流目录。']),
    '','## 排除范围',...(contract.excludedChanges.length?contract.excludedChanges.map(v=>`- ${v}`):['- 未额外声明；仍受任务范围和正常权限限制。']),
    '','## 验收要求',...contract.acceptanceCriteria.map(v=>`- ${v}`),'','---','',body].join('\n');
}
export function parseExecution(raw,contract){
  try{
    const v=JSON.parse(raw);shape(v,Object.keys(executionSchema.properties));
    if(!outcome.enum.includes(v.outcome))throw Error('未知完成状态');
    if(!Array.isArray(v.deliverables))throw Error('缺少交付结果');
    const expected=new Set(contract.deliverables.map(d=>d.id)),seen=new Set();
    for(const d of v.deliverables){
      shape(d,['id','status','summary','evidence']);
      if(!expected.has(d.id)||seen.has(d.id))throw Error('未知或重复交付项');seen.add(d.id);
      if(!outcome.enum.includes(d.status))throw Error('未知交付项状态');text(d.summary);texts(d.evidence,d.status==='completed');
    }
    if(seen.size!==expected.size)throw Error('交付项覆盖不完整');
    if(!Array.isArray(v.verification)||!v.verification.length)throw Error('必须记录验证，包括受阻或不适用的原因');
    for(const item of v.verification){
      shape(item,['description','status','evidence']);text(item.description);
      if(!executionSchema.properties.verification.items.properties.status.enum.includes(item.status))throw Error('未知验证状态');texts(item.evidence,true);
    }
    texts(v.unfinished);text(v.changeExplanation);text(v.report);
    if(v.outcome==='completed'&&(v.unfinished.length||v.deliverables.some(d=>d.status!=='completed')||v.verification.some(c=>['failed','blocked'].includes(c.status))))throw Error('自报完成与未完成交付或受阻验证冲突');
    if(v.outcome!=='completed'&&!v.unfinished.length)throw Error('部分完成或受阻必须说明未完成事项');
    return v;
  }catch(e){throw Error(`执行结果待核对：${e.message}`);}
}
