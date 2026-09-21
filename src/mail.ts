export interface Attachment {
  content: string; // base64
  filename: string;
  type: string;
  disposition: "attachment";
}

export interface OutgoingMail {
  to: string;
  cc?: string;
  subject: string;
  text: string;
  attachments?: Attachment[];
}

/** Binding Cloudflare Email Service (`send_email`). Wymaga planu Workers Paid i domeny nadawcy na Cloudflare DNS. */
export interface EmailBinding {
  send(message: {
    from: string;
    to: string;
    cc?: string[];
    subject: string;
    text: string;
    attachments?: Attachment[];
  }): Promise<unknown>;
}

export interface MailEnv {
  EMAIL: EmailBinding;
  FROM_EMAIL: string;
  /** "false" = wysyłka naprawdę. Każda inna wartość: maile tylko trafiają do logów. */
  EMAIL_DRY_RUN?: string;
  /** "cloudflare" (domyślnie; binding Email Service, wymaga Workers Paid) albo "resend" (darmowy plan, klucz w RESEND_API_KEY). */
  MAIL_PROVIDER?: string;
  RESEND_API_KEY?: string;
}

export function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export async function sendMail(env: MailEnv, mail: OutgoingMail): Promise<void> {
  if (env.EMAIL_DRY_RUN !== "false") {
    console.log(
      `[DRY RUN] od: ${env.FROM_EMAIL}\ndo: ${mail.to}${mail.cc ? `\ndw: ${mail.cc}` : ""}\ntemat: ${mail.subject}\n\n${mail.text}\n\nzałączniki: ${mail.attachments?.length ?? 0}`,
    );
    return;
  }
  if (env.MAIL_PROVIDER === "resend") {
    // https://resend.com/docs/api-reference/emails/send-email (darmowy plan: 3000/mies., 100/dzień)
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: env.FROM_EMAIL,
        to: [mail.to],
        ...(mail.cc ? { cc: [mail.cc] } : {}),
        subject: mail.subject,
        text: mail.text,
        attachments: mail.attachments?.map((a) => ({ filename: a.filename, content: a.content })),
      }),
    });
    if (!res.ok) throw new Error(`resend ${res.status}: ${await res.text()}`);
    return;
  }
  await env.EMAIL.send({
    from: env.FROM_EMAIL,
    to: mail.to,
    ...(mail.cc ? { cc: [mail.cc] } : {}),
    subject: mail.subject,
    text: mail.text,
    attachments: mail.attachments,
  });
}
