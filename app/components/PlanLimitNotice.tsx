"use client";

import { type PlanResource } from "@/lib/plan-limits";
import { useLocale } from "@/lib/i18n/LocaleProvider";

type PlanLimitNoticeProps = {
  resource?: PlanResource;
  usage?: number;
  limit?: number | null;
  className?: string;
};

export default function PlanLimitNotice({
  resource,
  usage,
  limit,
  className = "",
}: PlanLimitNoticeProps) {
  const { t } = useLocale();
  const hasUsage =
    typeof usage === "number" && typeof limit === "number" && limit > 0;
  const resourceLabels: Record<PlanResource, string> = {
    ai_evidence: t("common.planResourceLabels.ai_evidence"),
    vehicles: t("common.planResourceLabels.vehicles"),
    inventory_items: t("common.planResourceLabels.inventory_items"),
    machines: t("common.planResourceLabels.machines"),
  };

  return (
    <aside
      role="status"
      className={`badge-warning rounded-doc border border-amber-400/25 p-3 sm:p-4 ${className}`.trim()}
    >
      <div className="flex items-start gap-2.5">
        <span
          aria-hidden="true"
          className="badge-warning flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[13px] font-bold"
        >
          !
        </span>

        <div className="min-w-0">
          <p className="text-sm font-semibold">
            {resource
              ? t("common.planLimitNotice.moduleLimit", {
                  module: resourceLabels[resource],
                })
              : t("common.planLimitNotice.planLimit")}
          </p>
          {hasUsage && (
            <p className="mt-0.5 text-[13px] font-medium">
              {t("common.planLimitNotice.usage", { usage, limit })}
            </p>
          )}
          <p className="mt-1 text-[13px] leading-5 text-secondary">
            {t("common.planLimitMessage")}
          </p>
        </div>
      </div>
    </aside>
  );
}
