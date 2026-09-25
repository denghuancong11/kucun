import type { RequirementKey } from "./types";

export interface RequirementNav {
  key: RequirementKey;
  label: string;
  title: string;
}

export const requirements: RequirementNav[] = [
  {
    key: "req1",
    label: "库存汇总",
    title: "公司库存汇总",
  },
  {
    key: "req3",
    label: "在途库存",
    title: "在途库存",
  },
  {
    key: "approvals",
    label: "审批中心",
    title: "审批中心",
  },
  {
    key: "req4",
    label: "升级库存",
    title: "升级库存",
  },
  {
    key: "audit",
    label: "库存流水",
    title: "库存流水",
  },
];
