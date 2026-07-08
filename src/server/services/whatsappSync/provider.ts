/**
 * WhatsApp Business Cloud API provider — ALL Meta-specific payload
 * shapes live here. OBV business logic (bridge.ts) consumes normalized
 * messages only. Errors are sanitized to categories; tokens never leave
 * this module; raw provider bodies are never propagated.
 */
import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { DATA_DIR } from "../../db/index";
import { WHATSAPP_CONFIG } from "./config";
import type { MessageAttachment, MessageLocation } from "../../../shared/types";

export class WhatsAppSyncError extends Error {
  constructor(
    public category:
      | "not-configured"
      | "auth"
      | "timeout"
      | "network"
      | "provider-4xx"
      | "provider-5xx"
      | "media-rejected"
      | "invalid-response",
    public transient: boolean
  ) {
    super(`whatsapp-sync:${category}`);
  }
}

export type WhatsAppInboundType =
  | "TEXT" | "IMAGE" | "VIDEO" | "AUDIO" | "VOICE_NOTE" | "DOCUMENT"
  | "LOCATION" | "CONTACT" | "UNSUPPORTED";

/** Normalized inbound WhatsApp message — the only shape the bridge sees. */
export interface WhatsAppInbound {
  externalMessageId: string;
  fromPhone: string; // wa_id
  profileName: string;
  type: WhatsAppInboundType;
  text: string;
  mediaId: string | null;
  mimeType: string | null;
  filename: string | null;
  location: MessageLocation | null;
  timestamp: string; // ISO
}

export interface WhatsAppStatusUpdate {
  externalMessageId: string;
  status: "sent" | "delivered" | "read" | "failed";
}

// ------------------------------------------------------------ webhook

/** Verify Meta's X-Hub-Signature-256 over the RAW body (timing-safe). */
export function verifySignature(rawBody: Buffer, signatureHeader: string | undefined): boolean {
  const secret = WHATSAPP_CONFIG.appSecret();
  if (!secret || !signatureHeader?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const given = signatureHeader.slice("sha256=".length);
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Parse a webhook payload into normalized messages + status updates. */
export function parseWebhook(payload: unknown): {
  messages: WhatsAppInbound[];
  statuses: WhatsAppStatusUpdate[];
} {
  const messages: WhatsAppInbound[] = [];
  const statuses: WhatsAppStatusUpdate[] = [];
  const entries = (payload as { entry?: unknown[] })?.entry;
  if (!Array.isArray(entries)) throw new WhatsAppSyncError("invalid-response", false);
  for (const entry of entries) {
    const changes = (entry as { changes?: unknown[] }).changes ?? [];
    for (const change of changes as Array<{ value?: Record<string, unknown> }>) {
      const value = change.value ?? {};
      const contacts = (value.contacts ?? []) as Array<{ wa_id?: string; profile?: { name?: string } }>;
      const names = new Map(contacts.map((c) => [c.wa_id ?? "", c.profile?.name ?? ""]));
      for (const m of (value.messages ?? []) as Array<Record<string, any>>) {
        const from = String(m.from ?? "");
        const tsSec = Number(m.timestamp ?? 0);
        const base: WhatsAppInbound = {
          externalMessageId: String(m.id ?? ""),
          fromPhone: from,
          profileName: String(names.get(from) || from).slice(0, 120),
          type: "UNSUPPORTED",
          text: "",
          mediaId: null,
          mimeType: null,
          filename: null,
          location: null,
          timestamp: tsSec > 0 ? new Date(tsSec * 1000).toISOString() : new Date().toISOString(),
        };
        switch (m.type) {
          case "text":
            base.type = "TEXT";
            base.text = String(m.text?.body ?? "").slice(0, 4000);
            break;
          case "image":
            base.type = "IMAGE";
            base.mediaId = String(m.image?.id ?? "");
            base.mimeType = String(m.image?.mime_type ?? "");
            base.text = String(m.image?.caption ?? "").slice(0, 4000);
            break;
          case "video":
            base.type = "VIDEO";
            base.mediaId = String(m.video?.id ?? "");
            base.mimeType = String(m.video?.mime_type ?? "");
            base.text = String(m.video?.caption ?? "").slice(0, 4000);
            break;
          case "audio":
            base.type = m.audio?.voice ? "VOICE_NOTE" : "AUDIO";
            base.mediaId = String(m.audio?.id ?? "");
            base.mimeType = String(m.audio?.mime_type ?? "");
            break;
          case "document":
            base.type = "DOCUMENT";
            base.mediaId = String(m.document?.id ?? "");
            base.mimeType = String(m.document?.mime_type ?? "");
            base.filename = String(m.document?.filename ?? "document").slice(0, 200);
            base.text = String(m.document?.caption ?? "").slice(0, 4000);
            break;
          case "location": {
            base.type = "LOCATION";
            const lat = Number(m.location?.latitude);
            const lng = Number(m.location?.longitude);
            if (Number.isFinite(lat) && Number.isFinite(lng)) {
              base.location = {
                latitude: lat,
                longitude: lng,
                ...(m.location?.name ? { name: String(m.location.name).slice(0, 120) } : {}),
              };
            }
            break;
          }
          case "contacts":
            base.type = "CONTACT";
            base.text = "(contact card shared)";
            break;
          default:
            base.type = "UNSUPPORTED";
        }
        if (base.externalMessageId) messages.push(base);
      }
      for (const st of (value.statuses ?? []) as Array<Record<string, any>>) {
        const status = String(st.status ?? "");
        if (["sent", "delivered", "read", "failed"].includes(status)) {
          statuses.push({
            externalMessageId: String(st.id ?? ""),
            status: status as WhatsAppStatusUpdate["status"],
          });
        }
      }
    }
  }
  return { messages, statuses };
}

// ------------------------------------------------------------ API calls

async function apiFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WHATSAPP_CONFIG.timeoutMs());
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    throw new WhatsAppSyncError(
      (err as Error).name === "AbortError" ? "timeout" : "network",
      true
    );
  } finally {
    clearTimeout(timer);
  }
}

async function graphCall(pathname: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  if (!WHATSAPP_CONFIG.configured()) throw new WhatsAppSyncError("not-configured", false);
  const res = await apiFetch(
    `${WHATSAPP_CONFIG.baseUrl()}/${WHATSAPP_CONFIG.apiVersion()}${pathname}`,
    {
      ...init,
      headers: {
        authorization: `Bearer ${WHATSAPP_CONFIG.accessToken()}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
    }
  );
  if (res.status === 401 || res.status === 403) throw new WhatsAppSyncError("auth", false);
  if (!res.ok) {
    throw new WhatsAppSyncError(res.status >= 500 ? "provider-5xx" : "provider-4xx", res.status >= 500);
  }
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (json === null) throw new WhatsAppSyncError("invalid-response", false);
  return json;
}

/** Send a free-form text message; returns the provider message id. */
export async function sendText(toPhone: string, text: string): Promise<string> {
  const result = await graphCall(`/${WHATSAPP_CONFIG.phoneNumberId()}/messages`, {
    method: "POST",
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: toPhone,
      type: "text",
      text: { body: text.slice(0, 4000) },
    }),
  });
  const id = (result.messages as Array<{ id?: string }> | undefined)?.[0]?.id;
  if (!id) throw new WhatsAppSyncError("invalid-response", false);
  return id;
}

/** Send an approved template message (outside the service window). */
export async function sendTemplate(
  toPhone: string,
  templateName: string,
  bodyParams: string[]
): Promise<string> {
  const result = await graphCall(`/${WHATSAPP_CONFIG.phoneNumberId()}/messages`, {
    method: "POST",
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: toPhone,
      type: "template",
      template: {
        name: templateName,
        language: { code: "en" },
        components: [
          { type: "body", parameters: bodyParams.map((t) => ({ type: "text", text: t.slice(0, 500) })) },
        ],
      },
    }),
  });
  const id = (result.messages as Array<{ id?: string }> | undefined)?.[0]?.id;
  if (!id) throw new WhatsAppSyncError("invalid-response", false);
  return id;
}

/** Credential/phone diagnostic probe (no message is sent). */
export async function probePhoneNumber(): Promise<{ displayPhone: string | null }> {
  const info = await graphCall(`/${WHATSAPP_CONFIG.phoneNumberId()}?fields=display_phone_number`);
  return { displayPhone: (info.display_phone_number as string) ?? null };
}

// ---------------------------------------------------- media service

/** Communication-media storage root (NOT WORM evidence storage). */
export const COMM_MEDIA_DIR = path.join(DATA_DIR, "comm-media");

const ALLOWED_MEDIA: Record<string, { ext: string; kind: MessageAttachment["kind"] }> = {
  "image/jpeg": { ext: "jpg", kind: "IMAGE" },
  "image/png": { ext: "png", kind: "IMAGE" },
  "image/webp": { ext: "webp", kind: "IMAGE" },
  "video/mp4": { ext: "mp4", kind: "VIDEO" },
  "audio/ogg": { ext: "ogg", kind: "AUDIO" },
  "audio/mpeg": { ext: "mp3", kind: "AUDIO" },
  "audio/mp4": { ext: "m4a", kind: "AUDIO" },
  "application/pdf": { ext: "pdf", kind: "DOCUMENT" },
};

/** Seam for a future malware/content scanner; the mock passes. */
export interface MediaScanService {
  scan(bytes: Buffer, mimeType: string): Promise<{ clean: boolean; reason?: string }>;
}
export const mediaScanner: MediaScanService = {
  // TODO: production implementation via an AV/scanning provider.
  async scan() {
    return { clean: true };
  },
};

/**
 * Download inbound media via the provider media API and store it as a
 * communication artifact. Content-type allowlisted, size-capped, safe
 * random filename (no path components from the provider are ever used),
 * never executed, never written to evidence/WORM storage.
 */
export async function downloadMedia(
  mediaId: string,
  declaredMime: string | null
): Promise<MessageAttachment> {
  const meta = await graphCall(`/${mediaId}`);
  const mime = String(meta.mime_type ?? declaredMime ?? "").split(";")[0].trim();
  const allowed = ALLOWED_MEDIA[mime];
  if (!allowed) throw new WhatsAppSyncError("media-rejected", false);
  const size = Number(meta.file_size ?? 0);
  if (size > WHATSAPP_CONFIG.maxMediaBytes()) throw new WhatsAppSyncError("media-rejected", false);
  const mediaUrl = String(meta.url ?? "");
  if (!mediaUrl) throw new WhatsAppSyncError("invalid-response", false);
  const res = await apiFetch(mediaUrl, {
    headers: { authorization: `Bearer ${WHATSAPP_CONFIG.accessToken()}` },
  });
  if (!res.ok) throw new WhatsAppSyncError(res.status >= 500 ? "provider-5xx" : "provider-4xx", res.status >= 500);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length === 0 || bytes.length > WHATSAPP_CONFIG.maxMediaBytes()) {
    throw new WhatsAppSyncError("media-rejected", false);
  }
  const scan = await mediaScanner.scan(bytes, mime);
  if (!scan.clean) throw new WhatsAppSyncError("media-rejected", false);
  fs.mkdirSync(COMM_MEDIA_DIR, { recursive: true });
  const filename = `${randomUUID()}.${allowed.ext}`; // never provider-supplied names
  fs.writeFileSync(path.join(COMM_MEDIA_DIR, filename), bytes, { flag: "wx" });
  return {
    name: filename,
    url: `/comm-media/${filename}`,
    kind: allowed.kind,
    externalMediaId: mediaId,
    mimeType: mime,
  };
}

/**
 * Optional speech transcription seam. No provider is configured in this
 * build — voice notes remain fully usable as audio; chat never depends
 * on transcription, and a transcript could never constitute approval.
 */
export interface SpeechTranscriptionService {
  configured(): boolean;
  transcribe(audio: Buffer, mimeType: string): Promise<{ text: string; provenance: string }>;
}
export const speechTranscription: SpeechTranscriptionService = {
  configured: () => false,
  async transcribe(): Promise<never> {
    throw new WhatsAppSyncError("not-configured", false);
  },
};
