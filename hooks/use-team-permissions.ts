"use client";

import { useEffect, useState } from "react";
import { getMyActiveMembership, type CompanyMemberRole } from "@/lib/company";
import { can as canWith, type TeamPermission } from "@/lib/team-permissions";
import { getMyPermissions } from "@/lib/team-permissions-client";

/**
 * Rola + efektívne oprávnenia v aktívnej firme. Kým sa načítavajú, `can`
 * vracia false (žiadne bliknutie tlačidla, ktoré by potom zmizlo).
 */
export function useTeamPermissions() {
  const [state, setState] = useState<{ ready: boolean; role: CompanyMemberRole | null; granted: Set<TeamPermission> | null }>({
    ready: false,
    role: null,
    granted: null,
  });

  useEffect(() => {
    let cancelled = false;
    void Promise.all([getMyActiveMembership(), getMyPermissions()]).then(([membership, granted]) => {
      if (!cancelled) setState({ ready: true, role: membership?.role ?? null, granted });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const can = (permission: TeamPermission) => state.ready && canWith(permission, state.role, state.granted);
  return { ...state, can };
}
