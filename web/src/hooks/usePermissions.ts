import { useQuery } from "@tanstack/react-query";
import { fetchEffectivePermissions } from "../api";
import type { EffectivePermissions, Role } from "../types";

export function useEffectivePermissions(role: Role) {
  return useQuery<EffectivePermissions>({
    queryKey: ["permissions", "effective", role],
    queryFn: () => fetchEffectivePermissions(role),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}
