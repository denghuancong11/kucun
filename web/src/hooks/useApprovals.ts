import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchApprovals } from "../api";
import type { Role } from "../types";

export function useApprovals(role: Role, includeHiddenCompletedAllocations = false) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: includeHiddenCompletedAllocations ? ["approvals", role, "hidden-completed-allocations"] : ["approvals", role],
    queryFn: () => fetchApprovals(role, includeHiddenCompletedAllocations),
    refetchOnWindowFocus: true,
  });

  const refresh = () => Promise.all(
    ["approvals", "approval-history", "allocations", "inventory", "upgrades", "audit"].map((key) =>
      queryClient.invalidateQueries({ queryKey: [key] }, {throwOnError:true})),
  );
  return { ...query, refresh };
}
