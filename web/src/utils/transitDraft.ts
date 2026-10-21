import type { PendingBusinessRequest } from "../api";
import { updateSavedSessionDraft } from "../hooks/useSessionDraft";
import type { TransitImportPreview, TransitStatusPreview } from "../types";

type PendingRequest = { previewToken: string; payloadKey: string; requestId: string };
export type TransitDraft = { preview: TransitImportPreview | null; statusPreview: TransitStatusPreview | null; importRequest: PendingRequest | null; statusRequest: PendingRequest | null; uncertainImport: boolean; uncertainStatus: boolean; importYear?: string; importYearRequired?: boolean; importFileName?: string };

export function settleConfirmedTransitDraft(record: PendingBusinessRequest, result: unknown) {
  const importing = record.url === "/api/transit/import";
  if (!importing && record.url !== "/api/transit/status/apply") return;
  if ((result as { sync?: { databaseId?: string } })?.sync?.databaseId !== record.databaseId) return;
  const { requestId, ...payload } = JSON.parse(record.body);
  if (requestId !== record.requestId) return;
  const payloadKey = JSON.stringify({ role: record.role, payload });
  updateSavedSessionDraft<TransitDraft>(record.role, "transit-preview", record.databaseId, current => {
    const pending = importing ? current.importRequest : current.statusRequest;
    const preview = importing ? current.preview : current.statusPreview;
    if (pending?.requestId !== record.requestId || pending.payloadKey !== payloadKey
      || pending.previewToken !== payload.previewToken || preview?.previewToken !== payload.previewToken) return current;
    return importing
      ? { ...current, preview: null, importRequest: null, uncertainImport: false, importYear: "", importYearRequired: false, importFileName: "" }
      : { ...current, statusPreview: null, statusRequest: null, uncertainStatus: false };
  });
}
