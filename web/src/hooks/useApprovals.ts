import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchApprovals } from "../api";
import type { Role } from "../types";

export function useApprovals(role: Role) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["approvals", role],
    queryFn: () => fetchApprovals(role),
    refetchOnWindowFocus: true,
  });

  const refresh = () => Promise.all(
    ["approvals", "allocations", "inventory", "upgrades", "audit"].map((key) =>
      queryClient.invalidateQueries({ queryKey: [key] })),
  );
  return { ...query, refresh };
}
