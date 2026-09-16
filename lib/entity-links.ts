import { IS_MOBILE_BUILD } from "@/lib/build-target";

// -----------------------------------------------------------------------------
// Zdieľaný helper na generovanie odkazov na detail vozidla/stroja/skladovej
// položky. TOTO NIE JE React hook — je to čistá funkcia vracajúca string, takže
// jej použitie na oboch stranách (web aj mobile) NEPORUŠUJE Rules of Hooks
// (na rozdiel od čítania ID parametra vnútri stránky — to rieši samostatný
// web/mobile route wrapper, každý volajúci presne jeden hook, pozri
// app/vozidla/[id]/page.tsx vs. mobile/app/vozidla/detail/page.tsx).
//
// - web    → /vozidla/<id>            (existujúca dynamická App Router routa,
//                                       BEZ ZMENY)
// - mobile → /vozidla/detail?id=<id>  (statická routa, kompatibilná s
//                                       `next build` output: "export")
// -----------------------------------------------------------------------------

export function vehicleDetailHref(id: string): string {
  return IS_MOBILE_BUILD ? `/vozidla/detail?id=${id}` : `/vozidla/${id}`;
}

export function machineDetailHref(id: string): string {
  return IS_MOBILE_BUILD ? `/stroje/detail?id=${id}` : `/stroje/${id}`;
}

export function inventoryItemDetailHref(id: string): string {
  return IS_MOBILE_BUILD ? `/sklad/detail?id=${id}` : `/sklad/${id}`;
}

export function invoiceDetailHref(id: string): string {
  return IS_MOBILE_BUILD ? `/faktury/detail?id=${id}` : `/faktury/${id}`;
}
