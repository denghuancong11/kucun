import { useEffect, useId, useRef, type ReactNode } from "react";

export function UpgradeDialog({title,busy,onClose,wide=false,children}:{title:string;busy:boolean;onClose:()=>void;wide?:boolean;children:ReactNode}) {
  const ref=useRef<HTMLDialogElement>(null),titleId=useId();
  useEffect(()=>{const element=ref.current!;element.showModal();return()=>element.close();},[]);
  return <dialog ref={ref} className={`dialog upgrade-dialog${wide?' upgrade-dialog-wide':''}`} aria-labelledby={titleId} onCancel={event=>{event.preventDefault();if(!busy)onClose();}}>
    <header><h3 id={titleId}>{title}</h3><button type="button" className="btn btn-ghost btn-sm" aria-label="关闭弹窗" disabled={busy} onClick={onClose}>关闭</button></header>
    {children}
  </dialog>;
}
