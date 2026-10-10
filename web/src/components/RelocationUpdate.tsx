import {useState} from 'react';
import {downloadRelocationTemplate,previewRelocationUpdate,importRelocationUpdate,type RelocationUpdatePreview} from '../api';
import {useBusinessAction} from '../hooks/useBusinessAction';
import {createRequestId} from '../utils/ids';
import type {Role} from '../types';
import {Panel} from './ui';
export function RelocationUpdate({role,onRefresh}:{role:Role;onRefresh:()=>Promise<unknown>}) {
  const [preview,setPreview]=useState<RelocationUpdatePreview|null>(null),[reading,setReading]=useState(false),[notice,setNotice]=useState('');
  const action=useBusinessAction(onRefresh,message=>{setPreview(null);setNotice(message);});
  async function upload(file?:File){if(!file)return;setReading(true);setPreview(null);setNotice('');action.setError(null);try{setPreview(await previewRelocationUpdate(role,file));}catch(e){action.setError((e as Error).message);}finally{setReading(false);}}
  return <Panel title="物流批量更新">
    <p>下载当前待物流办理的移仓单，仅填写 RMA 和供应商原始移仓地址。预览加工结果后确认更新。</p>
    <div className="transit-toolbar"><button className="btn btn-ghost" disabled={action.disabled||reading} onClick={()=>void downloadRelocationTemplate(role).catch(e=>action.setError(e.message))}>下载移仓更新模板</button><label className="btn btn-ghost" htmlFor="relocation-update-file">导入更新RMA和地址</label><input className="visually-hidden" id="relocation-update-file" type="file" accept=".xlsx" disabled={action.disabled||reading} onChange={e=>{void upload(e.target.files?.[0]);e.target.value='';}}/></div>
    {notice&&<p role="status">{notice}</p>}{action.error&&<p role="alert" className="dialog-error">{action.error}</p>}
    {preview&&<><div className="dialog-error" role="alert">{preview.errors.map(e=><p key={e.sourceRow}>{e.message}</p>)}</div><div className="table-wrap"><table className="data-table"><thead><tr><th>模板行</th><th>移仓单号</th><th>RMA</th><th>原始移仓地址</th><th>加工结果</th></tr></thead><tbody>{preview.rows.map(r=><tr key={r.sourceRow}><td>{r.sourceRow}</td><td>{r.data.workNo}</td><td>{r.data.rma}</td><td style={{whiteSpace:'pre-wrap'}}>{r.data.relocationAddress}</td><td style={{whiteSpace:'pre-wrap'}}>{r.processedAddress}</td></tr>)}</tbody></table></div><button className="btn btn-primary" disabled={action.disabled||!preview.previewToken||preview.errors.length>0} onClick={()=>{const payload={previewToken:preview.previewToken,fileName:preview.fileName,fileHash:preview.fileSha256,templateHash:preview.templateSha256,rows:preview.rows,requestId:createRequestId('relocation-update')};void action.perform({execute:()=>importRelocationUpdate(role,payload),message:'已更新 '+preview.rows.length+' 单，待运营填写订单号。'});}}>确认更新移仓资料</button></>}
    {action.uncertain&&<button className="btn btn-primary" disabled={action.busy} onClick={()=>void action.perform()}>重试确认</button>}
  </Panel>;
}
