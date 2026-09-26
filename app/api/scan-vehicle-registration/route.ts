import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import { normalizeSpz } from "@/lib/normalize-spz";
import { getRequestLocale } from "@/lib/i18n/request-locale";
import { translate } from "@/lib/i18n/translate";
import type { Locale } from "@/lib/i18n/locales";
import { getUserScopedSupabaseClient } from "@/lib/server-supabase-user-client";
import { finalizeAiProcessing, guardAiProcessing } from "@/lib/entitlements-server";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

const supabaseAuth = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  }
);

const MAX_IMAGE_SIZE = 8 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

const registrationFields = [
  "spz",
  "vin",
  "znacka",
  "model",
  "datumPrvejEvidencie",
  "rokVyroby",
  "kategoriaVozidla",
  "druhVozidla",
  "palivo",
  "objemMotora",
  "vykon",
  "farba",
  "prevadzkovaHmotnost",
  "najvacsiaPripustnaCelkovaHmotnost",
  "pocetMiest",
  "cisloTechnickehoPreukazu",
] as const;

class ImageValidationError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

function hasValidImageSignature(bytes: Uint8Array, type: string) {
  if (type === "image/jpeg") {
    return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }

  if (type === "image/png") {
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    return signature.every((value, index) => bytes[index] === value);
  }

  if (type === "image/webp") {
    return (
      bytes[0] === 0x52 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x46 &&
      bytes[8] === 0x57 &&
      bytes[9] === 0x45 &&
      bytes[10] === 0x42 &&
      bytes[11] === 0x50
    );
  }

  return false;
}

async function toImageDataUrl(file: File, label: string, locale: Locale) {
  if (file.size === 0) {
    throw new ImageValidationError(
      translate(locale, "inbox.errors.imageEmptyPrefixed", { label }),
      400
    );
  }

  if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
    throw new ImageValidationError(
      translate(locale, "inbox.errors.imageFormatInvalidPrefixed", { label }),
      415
    );
  }

  if (file.size > MAX_IMAGE_SIZE) {
    throw new ImageValidationError(
      translate(locale, "inbox.errors.imageTooLarge8MBPrefixed", { label }),
      413
    );
  }

  const bytes = new Uint8Array(await file.arrayBuffer());

  if (!hasValidImageSignature(bytes, file.type)) {
    throw new ImageValidationError(
      translate(locale, "inbox.errors.imageInvalidContentPrefixed", {
        label,
      }),
      400
    );
  }

  return `data:${file.type};base64,${Buffer.from(bytes).toString("base64")}`;
}

function normalizeRegistrationData(value: unknown) {
  const source =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};

  return Object.fromEntries(
    registrationFields.map((field) => {
      const fieldValue = source[field];

      if (field === "spz") {
        return [field, normalizeSpz(fieldValue)];
      }

      return [
        field,
        typeof fieldValue === "string" && fieldValue.trim()
          ? fieldValue.trim()
          : null,
      ];
    })
  );
}

export async function POST(request: Request) {
  const locale = getRequestLocale(request);

  try {
    const authorization = request.headers.get("authorization");
    const accessToken = authorization?.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length).trim()
      : "";

    if (!accessToken) {
      return Response.json(
        {
          success: false,
          error: translate(locale, "inbox.errors.aiLoginRequired"),
        },
        { status: 401 }
      );
    }

    const {
      data: { user },
      error: authError,
    } = await supabaseAuth.auth.getUser(accessToken);

    if (authError || !user) {
      return Response.json(
        {
          success: false,
          error: translate(locale, "inbox.errors.sessionExpired"),
        },
        { status: 401 }
      );
    }

    const formData = await request.formData();
    const frontValue = formData.get("front");
    const backValue = formData.get("back");

    if (!(frontValue instanceof File)) {
      return Response.json(
        {
          success: false,
          error: translate(locale, "inbox.errors.frontSideMissing"),
        },
        { status: 400 }
      );
    }

    if (backValue !== null && !(backValue instanceof File)) {
      return Response.json(
        {
          success: false,
          error: translate(locale, "inbox.errors.backSideMustBeImage"),
        },
        { status: 400 }
      );
    }

    const frontImage = await toImageDataUrl(
      frontValue,
      translate(locale, "inbox.errors.frontSideLabel"),
      locale
    );
    const backImage =
      backValue instanceof File && backValue.size > 0
        ? await toImageDataUrl(
            backValue,
            translate(locale, "inbox.errors.backSideLabel"),
            locale
          )
        : null;

    const content: Array<
      | { type: "input_text"; text: string }
      | { type: "input_image"; image_url: string; detail: "high" }
    > = [
      {
        type: "input_text",
        text: `
Analyzuj prednú a prípadne zadnú stranu technického preukazu vozidla.

Vráť iba údaje, ktoré sú na priložených stranách jasne čitateľné. Nejasné,
chýbajúce alebo iba predpokladané údaje vráť ako null. Údaje nevymýšľaj.

Pravidlá:
- spz vráť veľkými písmenami bez medzier a pomlčiek,
- VIN vráť veľkými písmenami bez medzier,
- datumPrvejEvidencie vráť ako YYYY-MM-DD iba pri jednoznačnom dátume,
- rokVyroby vráť iba ak je priamo uvedený alebo jednoznačne odvoditeľný
  z údaja, ktorý výslovne označuje výrobu; neodvodzuj ho automaticky z dátumu
  prvej evidencie,
- objemMotora vráť ako číslo v cm3 bez jednotky,
- vykon vráť ako číslo v kW bez jednotky,
- hmotnosti vráť ako čísla v kg bez jednotky,
- pocetMiest vráť ako číslo bez doplňujúceho textu,
- model môže byť obchodný názov vozidla,
- ak si nie si istý významom poľa alebo hodnotou, vráť null.

Prvý obrázok je predná strana technického preukazu. Ak je priložený druhý
obrázok, je to zadná strana toho istého technického preukazu.
        `.trim(),
      },
      {
        type: "input_image",
        image_url: frontImage,
        detail: "high",
      },
    ];

    if (backImage) {
      content.push({
        type: "input_image",
        image_url: backImage,
        detail: "high",
      });
    }

    // Firma, abuse limit a AI kvóta (nárok ai_documents) — až po validácii
    // oboch strán, pred volaním modelu. Predtým tento endpoint overoval iba
    // platný JWT (bez firmy a bez stropu).
    const db = getUserScopedSupabaseClient(accessToken);
    const guard = await guardAiProcessing(
      db,
      request,
      locale,
      "scan-vehicle-registration",
      new TextEncoder().encode(`${frontImage}|${backImage ?? ""}`)
    );
    if (!guard.ok) return guard.response;

    let response;
    try {
      response = await client.responses.create({
      model: "gpt-4.1-mini",
      store: false,
      input: [{ role: "user", content }],
      text: {
        format: {
          type: "json_schema",
          name: "vehicle_registration_data",
          description:
            "Údaje bezpečne načítané z technického preukazu vozidla.",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: Object.fromEntries(
              registrationFields.map((field) => [
                field,
                { type: ["string", "null"] },
              ])
            ),
            required: [...registrationFields],
          },
        },
      },
    });
    } catch (aiError) {
      await finalizeAiProcessing(db, guard.usageId, false);
      throw aiError;
    }
    await finalizeAiProcessing(db, guard.usageId, true);

    if (!response.output_text) {
      return Response.json(
        {
          success: false,
          error: translate(locale, "inbox.errors.aiNoDataReturned"),
        },
        { status: 502 }
      );
    }

    const data = normalizeRegistrationData(JSON.parse(response.output_text));

    return Response.json({ success: true, data });
  } catch (error) {
    if (error instanceof ImageValidationError) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status }
      );
    }

    console.error("VEHICLE REGISTRATION SCAN ERROR:", error);

    return Response.json(
      {
        success: false,
        error: translate(locale, "inbox.errors.registrationAiFailedGeneric"),
      },
      { status: 500 }
    );
  }
}
