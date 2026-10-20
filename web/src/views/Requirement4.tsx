import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchUpgradeDashboard } from "../api";
import { EmptyState, FeedbackButton, Notice, Panel, Segmented, SkeletonTable } from "../components/ui";
import { DirectUpgradeBoard } from "../components/DirectUpgrade";
import { RelocationUpgradeBoard } from "../components/RelocationUpgrade";
import { TransferUpgradeList } from "../components/TransferUpgrade";
import type { DirectUpgrade, NoticeMessage, Role } from "../types";

export function Requirement4View({role}:{role:Role}) {
  const [mode,setMode]=useState<'relocation'|'direct'|'transfer'>('relocation');
  const [notice,setNotice]=useState<NoticeMessage|null>(null);
  const client=useQueryClient();
  const query=useQuery({queryKey:['upgrades',role],queryFn:()=>fetchUpgradeDashboard(role)});
  const refresh=async()=>{await Promise.all(['upgrades','inventory','allocations','audit','approvals'].map(key=>client.invalidateQueries({queryKey:[key]},{throwOnError:true})));};
  const saved=async(text:string)=>{
    try{await refresh();setNotice({kind:'success',text});}
    catch(error){setNotice({kind:'warning',text:text+' 升级库存刷新失败：'+(error as Error).message});}
  };
  if(query.isLoading&&!query.isFetched)return <Panel><SkeletonTable rows={7} cols={8}/></Panel>;
  if(!query.data)return <Panel><Notice notice={notice} onClose={()=>setNotice(null)}/><EmptyState title="升级库存加载失败" hint={query.error instanceof Error?query.error.message:'未能读取升级库存，请点击“重试”。'} action={<FeedbackButton label="重试" pendingLabel="正在刷新…" doneLabel="刷新完成" onAction={()=>query.refetch({throwOnError:true})} onResult={setNotice}/>}/></Panel>;
  return <div className="upgrade-page">
    {query.isError&&<div className="callout callout-danger" role="alert">升级库存刷新失败。{query.error.message}</div>}
    <Panel><Segmented role="tablist" ariaLabel="升级业务类型" value={mode} onChange={setMode} items={[{value:'relocation',label:'移仓升级'},{value:'direct',label:'在库升级'},{value:'transfer',label:'转仓升级'}]}/></Panel>
    <RelocationUpgradeBoard role={role} active={mode==='relocation'} dashboard={query.data} onRefresh={refresh} onNotice={setNotice}/>
    <DirectUpgradeBoard role={role} active={mode==='direct'} sources={query.data.directSources} jobs={query.data.upgrades.filter((job):job is DirectUpgrade=>job.kind==='direct')} warehouses={query.data.overseasWarehouses} onBegin={()=>setNotice(null)} onSaved={saved}/>
    <TransferUpgradeList role={role} active={mode==='transfer'}/>
    <Notice notice={notice} onClose={()=>setNotice(null)}/>
  </div>;
}
