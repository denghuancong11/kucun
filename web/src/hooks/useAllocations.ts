import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createAllocation, fetchAllocations } from "../api";
import type { AllocationEntry, AllocationsPayload, Role } from "../types";

export function useAllocations(role: Role, model: string | null, enabled = true) {
  const queryClient = useQueryClient();

  const query = useQuery<AllocationsPayload>({
    queryKey: ["allocations", role, model],
    queryFn: () => fetchAllocations(role, model!),
    enabled: Boolean(model) && enabled,
    staleTime: 3_000,
    refetchOnWindowFocus: true,
  });

  const createMutation = useMutation({
    mutationFn: ({
      batch,
      entry,
    }: {
      batch: { key: string; model: string; plan: string; date: string; version: string };
      entry: AllocationEntry;
    }) => createAllocation(role, batch, entry),

  });

  return {
    ...query,
    createMutation,
    refresh: () => Promise.all(["allocations", "inventory", "audit", "approvals"].map(key => queryClient.invalidateQueries({queryKey:[key]}, {throwOnError:true}))),
  };
}
