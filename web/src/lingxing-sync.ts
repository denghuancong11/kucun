import type { Role } from './types';
export type LingxingTarget = { action:'metrics'; documents:{kind:'allocation'|'inquiry';id:number}[] } | {action:'logistics';workId:number};
export type LingxingJob = {
  id:number; requestId:string; role:Role; target:LingxingTarget & {asins?:string[];orderNo?:string;fnsku?:string};
  state:'queued'|'running'|'succeeded'|'failed'; message:string;createdAt:string;startedAt:string|null;finishedAt:string|null;
  result:{updated:number;capturedAt:string}|null;
};
export type LingxingJobs = {ok:true;jobs:LingxingJob[];worker:{connected:boolean;host:string;message:string}};
export const canSyncLingxing = (role:Role, action:LingxingTarget['action']) => action==='metrics' ? ['admin','business'].includes(role) : !['business','alan'].includes(role);
export const lingxingTargetKey = (target:LingxingTarget) => target.action==='logistics'
  ? `logistics:${target.workId}`
  : `metrics:${target.documents.map(ref=>`${ref.kind}:${ref.id}`).sort().join(',')}`;
