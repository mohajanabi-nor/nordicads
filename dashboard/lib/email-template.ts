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

/**
 * The dark variant — "Skifer". Derived from DARK, which the brand bar already
 * uses, so in dark mode the header belongs to the design instead of sitting on
 * top of it. The orange is lifted a little: #ef781c is tuned for cream and goes
 * muddy against a dark ground.
 */
const D_PAGE = "#0f1015";
const D_CARD = "#1a1c24";
const D_BAR = "#23262f";
const D_LINE = "#2f323d";
const D_NOTICE = "#20232b";
const D_FOOTER = "#15171d";
const D_HEADING = "#f0eef7";
const D_TEXT = "#c9c7d4";
const D_MUTE = "#8e8ca0";
const D_ORANGE = "#f2892f";
/** Dark ink on the orange button: white on #f2892f is under 3:1. */
const D_ON_ORANGE = "#141118";

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
        `<p class="body-text" style="margin:0 0 16px;font-size:16px;line-height:1.6;color:${INK};">` +
        esc(p).replace(/\n/g, "<br>") +
        `</p>`,
    )
    .join("");

  const attachmentRow = c.attachmentName
    ? `<tr><td style="padding:0 32px 24px;">
        <table role="presentation" class="notice" cellpadding="0" cellspacing="0" border="0" width="100%"
               style="background:${CREAM};border:1px solid ${LINE};border-radius:12px;">
          <tr>
            <td class="notice" style="padding:14px 18px;font-size:14px;color:${INK};font-family:${FONT};">
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
            <td class="cta-cell" align="center" bgcolor="${ORANGE}" style="border-radius:12px;">
              <a href="${esc(c.ctaUrl)}" class="cta"
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
<!--
  Light is the design; dark is a designed variant, not an accident.

  Forcing light did not work: Gmail on Android and some iOS clients ignore
  the color-scheme hint and invert the palette themselves, producing muddy cream
  and text colours nobody chose. Declaring support for both and supplying a dark
  palette means a client in dark mode renders OUR dark rather than inventing one.

  Inline styles stay light so the default is correct everywhere, including the
  older clients that read no CSS at all. The rules below only apply when the
  reader is actually in dark mode.
-->
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${esc(c.headline)}</title>
<style>
  :root { color-scheme: light dark; supported-color-schemes: light dark; }

  @media (prefers-color-scheme: dark) {
    .page      { background: ${D_PAGE} !important; }
    .card      { background: ${D_CARD} !important; border-color: ${D_LINE} !important; }
    .brand-bar { background: ${D_BAR} !important; }
    .brand-name     { color: #ffffff !important; }
    .brand-name-alt { color: ${D_ORANGE} !important; }
    .headline  { color: ${D_HEADING} !important; }
    .body-text { color: ${D_TEXT} !important; }
    .notice    { background: ${D_NOTICE} !important; border-color: ${D_LINE} !important; color: ${D_TEXT} !important; }
    .notice strong { color: ${D_HEADING} !important; }
    .cta       { background: ${D_ORANGE} !important; color: ${D_ON_ORANGE} !important; }
    .cta-cell  { background: ${D_ORANGE} !important; }
    .footer    { background: ${D_FOOTER} !important; border-color: ${D_LINE} !important; color: ${D_MUTE} !important; }
    .footer strong { color: ${D_HEADING} !important; }
    .footer a  { color: ${D_MUTE} !important; }
  }

  /* Outlook.com marks its dark mode with this attribute instead of honouring
     the media query, so the same palette is repeated under it. */
  [data-ogsc] .page      { background: ${D_PAGE} !important; }
  [data-ogsc] .card      { background: ${D_CARD} !important; border-color: ${D_LINE} !important; }
  [data-ogsc] .brand-bar { background: ${D_BAR} !important; }
  [data-ogsc] .brand-name     { color: #ffffff !important; }
  [data-ogsc] .brand-name-alt { color: ${D_ORANGE} !important; }
  [data-ogsc] .headline  { color: ${D_HEADING} !important; }
  [data-ogsc] .body-text { color: ${D_TEXT} !important; }
  [data-ogsc] .notice    { background: ${D_NOTICE} !important; border-color: ${D_LINE} !important; color: ${D_TEXT} !important; }
  [data-ogsc] .cta       { background: ${D_ORANGE} !important; color: ${D_ON_ORANGE} !important; }
  [data-ogsc] .footer    { background: ${D_FOOTER} !important; border-color: ${D_LINE} !important; color: ${D_MUTE} !important; }
  [data-ogsc] .footer a  { color: ${D_MUTE} !important; }
</style>
</head>
<body class="body" style="margin:0;padding:0;background:${CREAM};font-family:${FONT};">
<!-- preheader: shown next to the subject in the inbox list, hidden in the body -->
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(c.preheader ?? "")}</div>
<table role="presentation" class="page" cellpadding="0" cellspacing="0" border="0" width="100%" bgcolor="${CREAM}" style="background:${CREAM};">
  <tr>
    <td align="center" style="padding:24px 12px;">
      <table role="presentation" class="card" cellpadding="0" cellspacing="0" border="0" width="600"
             bgcolor="${CREAM_2}"
             style="width:600px;max-width:100%;background:${CREAM_2};border:1px solid ${LINE};border-radius:16px;overflow:hidden;">

        <tr>
          <td class="brand-bar" bgcolor="${DARK}" style="background:${DARK};padding:24px 32px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td valign="middle" style="padding-right:12px;">
                  <img src="${esc(LOGO_URL)}" width="48" height="48" alt="Nordic Engros"
                       style="display:block;border:0;width:48px;height:48px;">
                </td>
                <td valign="middle">
                  <span class="brand-name" style="font-family:${FONT};font-size:18px;font-weight:bold;color:#ffffff;letter-spacing:1px;">NORDIC</span>
                  <span class="brand-name-alt" style="font-family:${FONT};font-size:18px;font-weight:bold;color:${ORANGE};letter-spacing:3px;">&nbsp;ENGROS</span>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <tr>
          <td style="padding:32px 32px 8px;">
            <h1 class="headline" style="margin:0 0 20px;font-family:${FONT};font-size:26px;line-height:1.25;color:${INK};">${esc(c.headline)}</h1>
            ${bodyHtml}
          </td>
        </tr>

        ${attachmentRow}
        ${ctaRow}

        <tr>
          <td class="footer" style="border-top:1px solid ${LINE};padding:20px 32px 28px;font-family:${FONT};font-size:12px;line-height:1.6;color:${MUTE};">
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
