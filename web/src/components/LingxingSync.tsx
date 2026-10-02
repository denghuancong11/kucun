import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchLingxingJobs, requestLingxingSync, type ApiError } from '../api';
import { canSyncLingxing, lingxingTargetKey, type LingxingTarget } from '../lingxing-sync';
import type { Role } from '../types';
import { createRequestId } from '../utils/ids';

type Props = {role:Role;target:LingxingTarget;sourceKey?:string;disabled?:boolean;displayedTask?:{id:number;message:string}|null;onSynced:()=>Promise<unknown>};

export function LingxingSync(props: Props) {
  if (!canSyncLingxing(props.role, props.target.action)) return null;
  const key = `${props.role}:${lingxingTargetKey(props.target)}${props.sourceKey ? `:${props.sourceKey}` : ''}`;
  return <SyncButton key={key} {...props} storageKey={`aster-lingxing-request:${key}`} />;
}

function SyncButton({role,target,disabled,displayedTask,onSynced,storageKey}: Props & {storageKey:string}) {
  // 各按钮持有自己提交的请求；其他窗口的新任务不会覆盖当前按钮。
  // 本机保留请求编号，重新打开时向服务器查询该任务的真实结果。
  const [requestId,setRequestId] = useState(() => sessionStorage.getItem(storageKey) || localStorage.getItem(storageKey));
  const [submitting,setSubmitting] = useState(false);
  const [submitError,setSubmitError] = useState('');
  const [refreshError,setRefreshError] = useState('');
  const sending = useRef(false);
  const refreshed = useRef<number | null>(null);
  const queryClient = useQueryClient();
  const queryKey = (id:string|null) => ['lingxing-jobs',role,lingxingTargetKey(target),id];
  const jobs = useQuery({queryKey:queryKey(requestId),
    queryFn:()=>fetchLingxingJobs(role,target,requestId!),enabled:requestId!==null,
    refetchInterval:query=>query.state.data?.jobs.some(job=>job.state==='succeeded'||job.state==='failed')?false:2000,
    refetchOnWindowFocus:true,retry:false});
  const job = jobs.data?.jobs.find(item=>item.requestId===requestId);
  const active = job?.state==='queued' || job?.state==='running';
  const checking = !!requestId && !job && jobs.isLoading;
  const uncertain = !!requestId && !job && !submitting && !checking;

  useEffect(() => {
    if (job?.state!=='succeeded' || refreshed.current===job.id) return;
    refreshed.current=job.id;
    void onSynced().catch(()=>setRefreshError('数据已保存，页面刷新失败，请刷新页面。'));
  }, [job?.id,job?.state,onSynced]);

  async function sync() {
    if (sending.current || active) return;
    sending.current=true;setSubmitting(true);setSubmitError('');setRefreshError('');
    const id = uncertain ? requestId! : createRequestId('lingxing');
    sessionStorage.setItem(storageKey,id);localStorage.setItem(storageKey,id);setRequestId(id);
    try {
      const result = await requestLingxingSync(role,target,id);
      await queryClient.cancelQueries({queryKey:queryKey(id)});
      queryClient.setQueryData(queryKey(id),{ok:true,jobs:[result.job]});
      void queryClient.invalidateQueries({queryKey:queryKey(id)});
    } catch(cause) {
      const failure=cause as ApiError;
      if (failure.status && failure.status>=400 && failure.status<500) {
        if (localStorage.getItem(storageKey)===id) localStorage.removeItem(storageKey);
        if (sessionStorage.getItem(storageKey)===id) sessionStorage.removeItem(storageKey);
        setRequestId(null);setSubmitError(failure.message);
      } else {
        setSubmitError('同步结果尚未确认，请点击“重试确认”。');
      }
    } finally {sending.current=false;setSubmitting(false);}
  }

  const busy = submitting || active || checking;
  const label = busy ? '同步中' : job?.state==='succeeded' ? target.action==='logistics' && job.result?.businessApplied===false ? '数量未更新' : '同步完成'
    : job?.state==='failed' || (!requestId && submitError) ? '同步失败'
    : uncertain ? '重试确认' : target.action==='metrics' ? '同步领星指标' : '同步领星物流';
  const error = submitting ? '' : job?.state==='failed' ? displayedTask?.id===job.id && displayedTask.message===job.message ? '' : job.message
    : uncertain ? submitError || '同步结果尚未确认，请点击“重试确认”。'
    : active && jobs.isError ? '暂时无法读取同步进度，尚未取得结果。'
    : !job ? submitError : refreshError;
  return <div className="lingxing-sync">
    <button className="btn btn-primary btn-sm" type="button" disabled={busy || disabled} onClick={()=>void sync()}>{label}</button>
    {error && <p className="dialog-error" role="alert">{error}</p>}
  </div>;
}
