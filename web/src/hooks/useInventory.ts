import { useQuery } from "@tanstack/react-query";
import { fetchInventoryCatalog } from "../api";
import type { InventoryCatalogPayload, Role } from "../types";

export function useInventoryCatalog(role: Role) {
  return useQuery<InventoryCatalogPayload>({
    queryKey: ["inventory", "catalog", role],
    queryFn: () => fetchInventoryCatalog(role),
    staleTime: 5_000,
    refetchOnWindowFocus: true,
  });
}

