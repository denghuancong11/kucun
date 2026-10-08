import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchLingxingJobs, requestLingxingSync, type ApiError } from '../api';
import { canSyncLingxing, lingxingTargetKey, type LingxingTarget } from '../lingxing-sync';
import type { Role } from '../types';
import { createRequestId } from '../utils/ids';

type Props = {role:Role;target:LingxingTarget;sourceKey?:string;disabled?:boolean;onSynced:()=>Promise<unknown>};

export function LingxingSync(props: Props) {
  if (!canSyncLingxing(props.role, props.target.action)) return null;
  const key = `${props.role}:${lingxingTargetKey(props.target)}${props.sourceKey ? `:${props.sourceKey}` : ''}`;
  return <SyncButton key={key} {...props} storageKey={`aster-lingxing-request:${key}`} />;
}

function SyncButton({role,target,disabled,onSynced,storageKey}: Props & {storageKey:string}) {
  // 各按钮持有自己提交的请求；其他窗口的新任务不会覆盖当前按钮。
  // 本机保留请求编号，重新打开时向服务器查询该任务的真实结果。
  const [initial] = useState(() => {
    try { return {requestId:sessionStorage.getItem(storageKey) || localStorage.getItem(storageKey),error:''}; }
    catch { return {requestId:null,error:'浏览器无法读取同步请求记录，暂未发起新同步。请恢复浏览器存储后重试。'}; }
  });
  const [requestId,setRequestId] = useState(initial.requestId);
  const [submitting,setSubmitting] = useState(false);
  const [submitError,setSubmitError] = useState(initial.error);
  const [refreshError,setRefreshError] = useState('');
  const sending = useRef(false);
  const storageRecovery = useRef(Boolean(initial.error));
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
    void onSynced().catch(()=>setRefreshError('数据已保存，页面刷新失败，请重新加载页面。'));
  }, [job?.id,job?.state,onSynced]);

  async function sync() {
    if (sending.current || active) return;
    sending.current=true;setSubmitting(true);setSubmitError('');setRefreshError('');
    let id = requestId;
    let sent = false;
    try {
      const savedId = sessionStorage.getItem(storageKey) || localStorage.getItem(storageKey);
      if (!requestId && savedId && storageRecovery.current) {
        storageRecovery.current=false;
        setRequestId(savedId);setSubmitError('已找回原同步编号，尚未取得结果，请重试确认。');
        return;
      }
      id = uncertain ? requestId! : createRequestId('lingxing');
      sessionStorage.setItem(storageKey,id);localStorage.setItem(storageKey,id);setRequestId(id);
      storageRecovery.current=false;
      sent = true;
      const result = await requestLingxingSync(role,target,id);
      await queryClient.cancelQueries({queryKey:queryKey(id)});
      queryClient.setQueryData(queryKey(id),{ok:true,jobs:[result.job]});
      void queryClient.invalidateQueries({queryKey:queryKey(id)});
    } catch(cause) {
      const failure=cause as ApiError;
      if (!sent) {
        storageRecovery.current=true;
        setSubmitError('浏览器无法读取或保存同步请求编号，本次未发送。请恢复浏览器存储后重试。');
      } else if (failure.status && failure.status>=400 && failure.status<500 && !uncertain) {
        try {
          if (localStorage.getItem(storageKey)===id) localStorage.removeItem(storageKey);
          if (sessionStorage.getItem(storageKey)===id) sessionStorage.removeItem(storageKey);
          setRequestId(null);setSubmitError(failure.message);
        } catch {
          setSubmitError(`${failure.message}；浏览器无法清除请求编号，请恢复浏览器存储后重试确认。`);
        }
      } else if (failure.status && failure.status>=400 && failure.status<500) {
        // 重放的权限或范围拒绝不能证明原任务未保存，继续持有原编号。
        setSubmitError(`${failure.message}；原同步结果仍未核对，请恢复办理条件后重试确认。`);
      } else {
        setSubmitError(failure.status ? '库存服务暂时未返回同步结果，请重试确认。'
          : failure.message.includes('超时') ? '等待库存服务响应超时，尚未取得结果，请重试确认。'
          : '与库存服务连接中断，尚未取得结果，请重试确认。');
      }
    } finally {sending.current=false;setSubmitting(false);}
  }
  const busy = submitting || active || checking;
  const label = busy ? '同步中' : job?.state==='succeeded' ? '同步完成'
    : job?.state==='failed' || (!requestId && submitError) ? '同步失败'
    : uncertain ? '重试确认' : target.action==='metrics' ? '同步领星指标' : '同步领星物流';
  const error = submitting ? '' : job?.state==='failed' ? job.message
    : uncertain ? submitError || '尚未取得同步结果，请重试确认。'
    : active && jobs.isError ? '暂时无法读取同步进度，尚未取得结果。'
    : !job ? submitError : refreshError;
  return <div className="lingxing-sync">
    <button className="btn btn-primary btn-sm" type="button" disabled={busy || disabled} onClick={()=>void sync()}>{label}</button>
    {error && <p className="dialog-error" role="alert">{error}</p>}
  </div>;
}
