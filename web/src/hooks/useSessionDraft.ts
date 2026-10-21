import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react";
import { fetchSync } from "../api";
import type { Role } from "../types";
import { createRequestId } from "../utils/ids";

type DraftInstance = { token: symbol; databaseId: () => string | null; recover: (value: unknown, id: string) => void; reportError: (message: string) => void };
const latestDraftInstances = new Map<string, DraftInstance>();

// 草稿只在当前浏览器会话、原数据库和原角色内恢复，不作为业务提交结果。
export function useSessionDraft<T>(role: Role, name: string, initialValue: T, recoveryErrorMessage = "未保存内容无法恢复，请重新核对并填写。") {
  const key = `aster-draft:${role}:${name}`;
  const initial = useRef(initialValue);
  const instance = useRef({ key, token: Symbol(key) });
  if (instance.current.key !== key) {
    instance.current = { key, token: Symbol(key) };
    initial.current = initialValue;
  }
  const token = instance.current.token;
  const ownsDraft = useCallback(() => latestDraftInstances.get(key)?.token === token && instance.current.token === token, [key, token]);
  const current = useRef(initialValue);
  const databaseId = useRef<string | null>(null);
  const edited = useRef(false);
  const [value, setValue] = useState(initialValue);
  const [ready, setReady] = useState(false);
  const [storageError, setStorageError] = useState<string | null>(null);
  const save = useCallback((next: T, id: string) => {
    if (!ownsDraft()) return null;
    try {
      const raw = JSON.stringify({ databaseId: id, value: next, writeId: createRequestId("draft") });
      sessionStorage.setItem(key, raw);
      setStorageError(null);
      return raw;
    } catch {
      setStorageError("未保存内容无法暂存，请保持当前页面，完成后再切页或刷新。");
      return null;
    }
  }, [key, ownsDraft]);
  useEffect(() => {
    let cancelled = false;
    latestDraftInstances.set(key, {
      token,
      databaseId: () => ownsDraft() ? databaseId.current : null,
      recover: (restored, id) => {
        if (!ownsDraft() || databaseId.current !== id) return;
        edited.current = true;
        current.current = restored as T;
        setValue(restored as T);
        setStorageError(null);
      },
      reportError: message => { if (ownsDraft()) setStorageError(message); },
    });
    databaseId.current = null;
    edited.current = false;
    current.current = initial.current;
    setValue(initial.current);
    setReady(false);
    void fetchSync(role).then(sync => {
      if (cancelled || !ownsDraft()) return;
      databaseId.current = sync.databaseId;
      if (edited.current) save(current.current, sync.databaseId);
      else {
        try {
          const raw = sessionStorage.getItem(key);
          const saved = raw ? JSON.parse(raw) as { databaseId: string; value: T } : null;
          if (saved?.databaseId === sync.databaseId) {
            current.current = saved.value;
            setValue(saved.value);
          }
        } catch {
          setStorageError(recoveryErrorMessage);
        }
      }
    }).catch(() => {
      if (!cancelled) setStorageError("暂存内容尚未恢复，请恢复连接后刷新页面。");
    }).finally(() => { if (!cancelled) setReady(true); });
    // 离页后仍可保存原响应；同一草稿重新挂载后，只允许新实例保存。
    return () => { cancelled = true; };
  }, [key, role, save, token, ownsDraft, recoveryErrorMessage]);
  const setDraft = useCallback((next: SetStateAction<T>) => {
    if (!ownsDraft()) return;
    const updated = typeof next === "function" ? (next as (value: T) => T)(current.current) : next;
    edited.current = true;
    current.current = updated;
    setValue(updated);
    if (databaseId.current) save(updated, databaseId.current);
  }, [save, ownsDraft]);
  const persist = useCallback((next: T, updateVisible = false) => {
    const id = databaseId.current;
    if (!ownsDraft() || !id) return () => {};
    const previous = current.current;
    const saved = save(next, id);
    if (saved && updateVisible) {
      edited.current = true;
      current.current = next;
      setValue(next);
    }
    // 明确拒绝可恢复原稿；任何后续写入（包括编辑后再次清空）都会令本回调失效。
    return () => {
      if (!saved) return;
      try {
        const latest = latestDraftInstances.get(key);
        const currentId = latest?.databaseId();
        if (currentId && currentId !== id || sessionStorage.getItem(key) !== saved) return;
        sessionStorage.setItem(key, JSON.stringify({ databaseId: id, value: previous, writeId: createRequestId("draft") }));
        latest?.recover(previous, id);
      } catch {
        latestDraftInstances.get(key)?.reportError(recoveryErrorMessage);
      }
    };
  }, [key, save, ownsDraft, recoveryErrorMessage]);
  return [value, setDraft, { ready, storageError, persist }] as const;
}
