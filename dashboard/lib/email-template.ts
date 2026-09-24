/**
 * The campaign email — branded HTML plus a plain-text alternative.
 *
 * Tables and inline styles support older email clients such as Outlook.
 * The caller should send both the HTML and plain-text parts.
 */

/** Palette — kept in sync with app/globals.css and the worker's constants. */
const CREAM = "#f7f0de";
const CREAM_2 = "#fbf6ea";
const ORANGE = "#ef781c";
const INK = "#2d2d34";
const MUTE = "#968c78";
const LINE = "#e7ddc6";
const DARK = "#282a36";

/** Replace this with a publicly accessible HTTPS URL for your logo image. */
export const LOGO_URL = "https://www.nordicengros.com/cdn/shop/files/artwork_Mr_vector.png?v=1761570697";
export const LOGO_CID = "nordic-engros-logo";

/** Web fonts do not load in most mail clients; this stack is what actually renders. */
const FONT =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

export interface CampaignContent {
  /** Big headline inside the mail. */
  headline: string;
  /** The operator's message. Plain text; blank lines separate paragraphs. */
  body: string;
  /** Where the CTA button points (webshop or the catalogue collection). */
  ctaUrl: string;
  ctaLabel: string;
  /** Set when the catalogue PDF travels as an attachment. */
  attachmentName?: string | null;
  /** mailto: link used for both the footer link and List-Unsubscribe. */
  unsubscribeMailto: string;
  /** Hidden line shown in the inbox preview next to the subject. */
  preheader?: string;
}

export interface SenderIdentity {
  companyName: string;
  orgNr: string;
  address: string;
  email: string;
  website: string;
}

/** Footer identity. Norwegian commercial email is expected to carry the sender's
 * full legal details, and their presence is a mild positive for filters too.
 */
export function senderIdentity(): SenderIdentity {
  return {
    companyName: process.env.EMAIL_COMPANY_NAME || "Nordic Engros AS",
    orgNr: process.env.EMAIL_ORG_NR || "922 796 076",
    address: process.env.EMAIL_ADDRESS || "Oslo, Norge",
    email: process.env.EMAIL_REPLY_TO || "post@nordicengros.no",
    website: process.env.EMAIL_WEBSITE || "www.nordicengros.com",
  };
}

export function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Blank-line-separated plain text -> paragraphs. Single newlines become <br>. */
function paragraphs(body: string): string[] {
  return body
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
}

export function renderCampaign(
  c: CampaignContent,
): { html: string; text: string } {
  const who = senderIdentity();
  const paras = paragraphs(c.body);

  const bodyHtml = paras
    .map(
      (p) =>
        `<p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:${INK};">` +
        esc(p).replace(/\n/g, "<br>") +
        `</p>`,
    )
    .join("");

  const attachmentRow = c.attachmentName
    ? `<tr><td style="padding:0 32px 24px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"
               style="background:${CREAM};border:1px solid ${LINE};border-radius:12px;">
          <tr>
            <td style="padding:14px 18px;font-size:14px;color:${INK};font-family:${FONT};">
              <strong>Katalogen er vedlagt</strong> som PDF (${esc(c.attachmentName)}).
            </td>
          </tr>
        </table>
      </td></tr>`
    : "";

  // VML gives Outlook a rounded button. Other clients use the HTML anchor fallback.
  const ctaRow = c.ctaUrl
    ? `<tr><td align="center" style="padding:8px 32px 32px;">
        <!--[if mso]>
        <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml"
          xmlns:w="urn:schemas-microsoft-com:office:word"
          href="${esc(c.ctaUrl)}"
          style="height:52px;v-text-anchor:middle;width:300px;"
          arcsize="20%" strokecolor="${ORANGE}" fillcolor="${ORANGE}">
          <w:anchorlock/>
          <center style="color:${CREAM};font-family:Arial,sans-serif;font-size:14px;font-weight:bold;">
            ${esc(c.ctaLabel)}
          </center>
        </v:roundrect>
        <![endif]-->
        <!--[if !mso]><!-->
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="300" style="width:300px;">
          <tr>
            <td align="center" bgcolor="${ORANGE}" style="border-radius:12px;">
              <a href="${esc(c.ctaUrl)}"
                 style="display:block;padding:18px 12px;background:${ORANGE};
                        border-radius:12px;font-family:${FONT};font-size:14px;line-height:16px;
                        font-weight:bold;color:${CREAM};text-decoration:none;">
                ${esc(c.ctaLabel)}
              </a>
            </td>
          </tr>
        </table>
        <!--<![endif]-->
      </td></tr>`
    : "";

  const html = `<!doctype html>
<html lang="no">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<title>${esc(c.headline)}</title>
</head>
<body style="margin:0;padding:0;background:${CREAM};font-family:${FONT};">
<!-- preheader: shown next to the subject in the inbox list, hidden in the body -->
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(c.preheader ?? "")}</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${CREAM};">
  <tr>
    <td align="center" style="padding:24px 12px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600"
             style="width:600px;max-width:100%;background:${CREAM_2};border:1px solid ${LINE};border-radius:16px;overflow:hidden;">

        <tr>
          <td style="background:${CREAM};padding:24px 32px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td valign="middle" style="padding-right:12px;">
                  <img src="${esc(LOGO_URL)}" width="48" height="48" alt="Nordic Engros"
                       style="display:block;border:0;width:48px;height:48px;">
                </td>
                <td valign="middle">
                  <span style="font-family:${FONT};font-size:18px;font-weight:bold;color:${INK};letter-spacing:1px;">NORDIC</span>
                  <span style="font-family:${FONT};font-size:18px;font-weight:bold;color:${ORANGE};letter-spacing:3px;">&nbsp;ENGROS</span>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <tr>
          <td style="padding:32px 32px 8px;">
            <h1 style="margin:0 0 20px;font-family:${FONT};font-size:26px;line-height:1.25;color:${INK};">${esc(c.headline)}</h1>
            ${bodyHtml}
          </td>
        </tr>

        ${attachmentRow}
        ${ctaRow}

        <tr>
          <td style="border-top:1px solid ${LINE};padding:20px 32px 28px;font-family:${FONT};font-size:12px;line-height:1.6;color:${MUTE};">
            <strong style="color:${INK};">${esc(who.companyName)}</strong><br>
            Org. ${esc(who.orgNr)} · ${esc(who.address)}<br>
            ${esc(who.email)} · ${esc(who.website)}
            <br><br>
            Du får denne e-posten fordi du er kunde hos ${esc(who.companyName)}.<br>
            <a href="${esc(c.unsubscribeMailto)}" style="color:${MUTE};text-decoration:underline;">Meld deg av</a>
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>
</body>
</html>`;

  // Optional lines are null and get dropped; "" is a deliberate blank line and
  // must survive, or the text part arrives as one cramped block.
  const text = [
    "NORDIC ENGROS",
    "",
    c.headline,
    "",
    paras.join("\n\n"),
    "",
    c.attachmentName
      ? `Katalogen er vedlagt som PDF (${c.attachmentName}).`
      : null,
    c.ctaUrl ? `${c.ctaLabel}: ${c.ctaUrl}` : null,
    "",
    "—",
    who.companyName,
    `Org. ${who.orgNr} · ${who.address}`,
    `${who.email} · ${who.website}`,
    "",
    `Du får denne e-posten fordi du er kunde hos ${who.companyName}.`,
    `Meld deg av: ${c.unsubscribeMailto}`,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  return { html, text };
}
