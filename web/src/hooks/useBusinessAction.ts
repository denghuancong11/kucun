import { useRef, useState } from "react";
import type { ApiError } from "../api";

// 重试使用原请求参数与幂等键；刷新失败不改变已成功的业务结果。
export function useBusinessAction(onRefresh: () => Promise<unknown>, onSuccess: (message: string) => void) {
  const pending = useRef<{ execute: () => Promise<unknown>; message: string } | null>(null);
  const running = useRef(false);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const perform = async (action?: { execute: () => Promise<unknown>; message: string }) => {
    if (running.current) return;
    const request = pending.current ?? action;
    if (!request) return;
    pending.current = request; running.current = true; setBusy(true); setError(null);
    try {
      await request.execute();
      pending.current = null; setUncertain(false);
      let message = request.message;
      try { await onRefresh(); } catch { message += " 页面刷新失败，请刷新页面。"; }
      onSuccess(message);
    } catch (failure) {
      const e = failure as ApiError;
      // 只有明确的 4xx 拒绝才能丢弃幂等键；2xx 坏回执仍可能已保存。
      const unknown = !(e.status !== undefined && e.status >= 400 && e.status < 500);
      if (!unknown) pending.current = null;
      setUncertain(unknown); setError(unknown ? "本次操作结果尚未确认，请点击“重试确认”。" : e.message);
    } finally { running.current = false; setBusy(false); }
  };
  return { perform, busy, uncertain, error, setError, disabled: busy || uncertain };
}
