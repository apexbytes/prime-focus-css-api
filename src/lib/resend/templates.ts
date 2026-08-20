import { env } from '../../config/index.js';

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/**
 * Plain template literals rather than a templating engine: there are four
 * transactional emails, all of them short, and every value below is
 * HTML-escaped at the point of interpolation.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function layout(heading: string, body: string): string {
  return `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:24px;background:#f5f6f8;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2430;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:8px;border:1px solid #e4e7ec;">
      <tr><td style="padding:28px 32px 8px;">
        <p style="margin:0 0 4px;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#6b7280;">Prime Focus Support</p>
        <h1 style="margin:0 0 16px;font-size:20px;line-height:1.35;">${escapeHtml(heading)}</h1>
      </td></tr>
      <tr><td style="padding:0 32px 28px;font-size:15px;line-height:1.6;">${body}</td></tr>
      <tr><td style="padding:0 32px 28px;font-size:12px;line-height:1.5;color:#6b7280;border-top:1px solid #e4e7ec;padding-top:16px;">
        This is an automated message from the Prime Focus customer support system.
        If you were not expecting it, please contact your administrator.
      </td></tr>
    </table>
  </body>
</html>`;
}

function button(url: string, label: string): string {
  return `<p style="margin:24px 0;">
    <a href="${escapeHtml(url)}" style="display:inline-block;padding:11px 20px;background:#1f2430;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:600;">${escapeHtml(label)}</a>
  </p>
  <p style="margin:0;font-size:13px;color:#6b7280;">If the button does not work, paste this link into your browser:<br />
    <span style="word-break:break-all;">${escapeHtml(url)}</span>
  </p>`;
}

export function invitationEmail(input: {
  fullName: string;
  inviterName: string;
  roleName: string;
  acceptUrl: string;
  expiresInHours: number;
}): RenderedEmail {
  const heading = 'You have been invited to Prime Focus Support';
  const html = layout(
    heading,
    `<p style="margin:0 0 12px;">Hello ${escapeHtml(input.fullName)},</p>
     <p style="margin:0 0 12px;">${escapeHtml(input.inviterName)} has invited you to the Prime Focus customer support system as
       <strong>${escapeHtml(input.roleName)}</strong>.</p>
     <p style="margin:0;">Set your password to activate the account. This invitation expires in ${input.expiresInHours} hours.</p>
     ${button(input.acceptUrl, 'Accept invitation')}`,
  );

  return {
    subject: heading,
    html,
    text: [
      `Hello ${input.fullName},`,
      '',
      `${input.inviterName} has invited you to the Prime Focus customer support system as ${input.roleName}.`,
      `Set your password to activate the account. This invitation expires in ${input.expiresInHours} hours.`,
      '',
      input.acceptUrl,
    ].join('\n'),
  };
}

export function loginOtpEmail(input: {
  fullName: string;
  code: string;
  ttlMinutes: number;
  ip?: string | undefined;
}): RenderedEmail {
  const heading = 'Your Prime Focus Support login code';
  const origin = input.ip
    ? `<p style="margin:0 0 12px;color:#6b7280;font-size:13px;">Requested from ${escapeHtml(input.ip)}.</p>`
    : '';
  const html = layout(
    heading,
    `<p style="margin:0 0 12px;">Hello ${escapeHtml(input.fullName)},</p>
     <p style="margin:0 0 8px;">Use this code to finish signing in:</p>
     <p style="margin:0 0 16px;font-size:32px;font-weight:700;letter-spacing:.22em;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">${escapeHtml(input.code)}</p>
     <p style="margin:0 0 12px;">It expires in ${input.ttlMinutes} minutes and can be used once.</p>
     ${origin}
     <p style="margin:0;"><strong>If you did not try to sign in, change your password immediately and tell your administrator.</strong></p>`,
  );

  return {
    subject: heading,
    html,
    text: [
      `Hello ${input.fullName},`,
      '',
      `Your login code is ${input.code}`,
      `It expires in ${input.ttlMinutes} minutes and can be used once.`,
      input.ip ? `Requested from ${input.ip}.` : '',
      '',
      'If you did not try to sign in, change your password immediately and tell your administrator.',
    ]
      .filter(Boolean)
      .join('\n'),
  };
}

/**
 * Confirms to a customer that their query is now tracked.
 *
 * Leads with the reference, because that is the one thing they may need to quote
 * back, and echoes their own words so they can see *which* query this is when
 * they have raised more than one.
 */
export function ticketAcknowledgementEmail(input: {
  fullName: string;
  reference: string;
  subject: string;
  productName: string;
  body: string;
}): RenderedEmail {
  // The customer wrote this text; it is echoed back, so it must be escaped.
  const excerpt = input.body.length > 600 ? `${input.body.slice(0, 600).trimEnd()}…` : input.body;

  const heading = 'We have received your query';
  const html = layout(
    heading,
    `<p style="margin:0 0 12px;">Hello ${escapeHtml(input.fullName)},</p>
     <p style="margin:0 0 12px;">Thank you for contacting Prime Focus Support about
       <strong>${escapeHtml(input.productName)}</strong>. Your query is now being tracked and a member of
       our team will be in touch.</p>
     <p style="margin:0 0 20px;padding:12px 16px;background:#f5f6f8;border-radius:6px;">
       Your reference is <strong style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">${escapeHtml(input.reference)}</strong>
     </p>
     <p style="margin:0 0 6px;font-size:13px;color:#6b7280;">What you sent us:</p>
     <blockquote style="margin:0 0 16px;padding:0 0 0 12px;border-left:3px solid #e4e7ec;color:#4b5563;white-space:pre-wrap;">${escapeHtml(excerpt)}</blockquote>
     <p style="margin:0;">You can reply to this email to add anything further — it will be added to the
       same query, so there is no need to start a new one.</p>`,
  );

  return {
    subject: `[${input.reference}] We have received your query`,
    html,
    text: [
      `Hello ${input.fullName},`,
      '',
      `Thank you for contacting Prime Focus Support about ${input.productName}.`,
      'Your query is now being tracked and a member of our team will be in touch.',
      '',
      `Your reference is ${input.reference}`,
      '',
      'What you sent us:',
      excerpt,
      '',
      'You can reply to this email to add anything further — it will be added to the same',
      'query, so there is no need to start a new one.',
    ].join('\n'),
  };
}

export function passwordResetEmail(input: {
  fullName: string;
  resetUrl: string;
  ttlMinutes: number;
}): RenderedEmail {
  const heading = 'Reset your Prime Focus Support password';
  const html = layout(
    heading,
    `<p style="margin:0 0 12px;">Hello ${escapeHtml(input.fullName)},</p>
     <p style="margin:0;">A password reset was requested for your account. The link below expires in ${input.ttlMinutes} minutes and can be used once. If you did not request it, you can ignore this email.</p>
     ${button(input.resetUrl, 'Reset password')}`,
  );

  return {
    subject: heading,
    html,
    text: [
      `Hello ${input.fullName},`,
      '',
      `A password reset was requested for your account. This link expires in ${input.ttlMinutes} minutes and can be used once.`,
      '',
      input.resetUrl,
      '',
      'If you did not request it, you can ignore this email.',
    ].join('\n'),
  };
}

export function passwordChangedEmail(input: { fullName: string; at: Date }): RenderedEmail {
  const heading = 'Your Prime Focus Support password was changed';
  const when = input.at.toISOString();
  const html = layout(
    heading,
    `<p style="margin:0 0 12px;">Hello ${escapeHtml(input.fullName)},</p>
     <p style="margin:0 0 12px;">Your password was changed at ${escapeHtml(when)}. All other sessions and trusted devices were signed out.</p>
     <p style="margin:0;"><strong>If this was not you, contact your administrator immediately.</strong></p>`,
  );

  return {
    subject: heading,
    html,
    text: [
      `Hello ${input.fullName},`,
      '',
      `Your password was changed at ${when}. All other sessions and trusted devices were signed out.`,
      '',
      'If this was not you, contact your administrator immediately.',
    ].join('\n'),
  };
}

/** Absolute link into the agent console. */
export function webUrl(path: string, params: Record<string, string> = {}): string {
  const url = new URL(path, env.APP_WEB_URL);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}
