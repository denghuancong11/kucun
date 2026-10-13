import { useMutation, useQueryClient } from "@tanstack/react-query";
import { markTransitOnShelf } from "../api";
import type { Role } from "../types";

export function useTransit(role: Role) {
  const queryClient = useQueryClient();
  const onShelfMutation = useMutation({
    mutationFn: ({ id, expectedRevision, yes, requestId, context }: { id: number; expectedRevision: number; yes: string; requestId: string; context: string }) =>
      markTransitOnShelf(role, id, { expectedRevision, yes, requestId }, context),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["audit"] });
    },
  });
  return { onShelfMutation };
}
