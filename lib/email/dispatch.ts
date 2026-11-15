import { Resend } from "resend";
import type { AuditResponse } from "../types";

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const DEFAULT_FROM = "Mapergy Audits <audits@resend.dev>";

export function buildAuditEmail(to: string, subject: string, brief: string) {
  const lines = brief.split("\n");
  const html = `<div style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;line-height:1.65;color:#0E1420;white-space:pre-wrap">${lines
    .map((line) => escapeHtml(line))
    .join("\n")}</div>`;
  return { to, subject, html, text: brief };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export async function dispatchAudit(
  to: string,
  subject: string,
  brief: string,
): Promise<AuditResponse> {
  const sentAt = new Date().toISOString();
  const apiKey = process.env.RESEND_API_KEY;

  if (!apiKey) {
    return {
      delivered: false,
      mode: "simulated",
      provider_id: null,
      to,
      subject,
      detail:
        "Simulated dispatch — RESEND_API_KEY is not set, so no mail left the machine. Add the key and a verified sender domain to deliver for real.",
      sent_at: sentAt,
    };
  }

  const from = process.env.AUDIT_FROM_EMAIL || DEFAULT_FROM;
  const mail = buildAuditEmail(to, subject, brief);

  try {
    const resend = new Resend(apiKey);
    const { data, error } = await resend.emails.send({
      from,
      to: [mail.to],
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
    });

    if (error) {
      return {
        delivered: false,
        mode: "live",
        provider_id: null,
        to,
        subject,
        detail: `Resend rejected the message: ${error.message}. Check the verified sender domain.`,
        sent_at: sentAt,
      };
    }

    return {
      delivered: true,
      mode: "live",
      provider_id: data?.id ?? null,
      to,
      subject,
      detail: `Delivered via Resend from ${from}. Without a verified domain, Resend only delivers to the account owner's address.`,
      sent_at: sentAt,
    };
  } catch (err) {
    return {
      delivered: false,
      mode: "live",
      provider_id: null,
      to,
      subject,
      detail: `Dispatch failed: ${err instanceof Error ? err.message : "unknown error"}.`,
      sent_at: sentAt,
    };
  }
}
