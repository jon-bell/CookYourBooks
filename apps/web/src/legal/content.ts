// Legal text rendered by `/legal/:doc`.
//
// These are *first drafts* meant to ship with the household-sharing
// feature. They need legal review before going to production. The
// DMCA section is verbatim from the registered Copyright Agent
// (CopyByte, DMCA registration DMCA-1073402); the rest is house-drafted.
//
// Versioning:
//   - When substantive obligations change, bump ALL THREE in lockstep:
//       1. CURRENT_TOS_VERSION (below)
//       2. LEGAL_LAST_UPDATED (below)
//       3. current_tos_version() in supabase/migrations/*_tos.sql
//   - Cosmetic edits don't require a bump (and shouldn't, because the
//     bump invalidates every user's acceptance and forces them through
//     the gate again).

/** Current ToS version number. Bump together with LEGAL_LAST_UPDATED and
 *  the `current_tos_version()` Postgres function whenever substantive
 *  obligations change. Re-exported from `household/api.ts` for callers
 *  that only need the version number. */
export const CURRENT_TOS_VERSION = 1;

export const LEGAL_LAST_UPDATED = '2026-05-27';

export interface LegalDoc {
  slug: 'terms' | 'aup' | 'dmca' | 'privacy' | 'data-deletion';
  title: string;
  summary: string;
  body: string;
}

export const TERMS: LegalDoc = {
  slug: 'terms',
  title: 'Terms of Service',
  summary: 'Your obligations as a user, our obligations as a service, and the boundaries on both.',
  body: `
# Terms of Service

**Last updated:** ${LEGAL_LAST_UPDATED} · **Version:** ${CURRENT_TOS_VERSION}

These Terms of Service (the "Terms") govern your use of CookYourBooks
(the "Service"). By using the Service, you agree to these Terms.

## 1. Your account

You are responsible for keeping your account credentials secure and for
all activity that happens under your account. You must be at least 13
years old to use the Service. If you create an account on behalf of an
organization or household, you represent that you have authority to
bind the relevant people to these Terms.

## 2. Your content

You retain ownership of recipes, photos, notes, and other content you
upload ("Your Content"). You grant CookYourBooks a non-exclusive,
worldwide, royalty-free license to host, copy, transmit, and display
Your Content **solely for the purpose of operating the Service for you
and for the people you explicitly share it with** (your household or,
where you explicitly publish, the general public). This license is
revoked when you delete the content or your account.

## 3. Rights you must have

You must own Your Content or have all rights necessary to share it in
the way you're sharing it.

- **Personal use** (only you can see it): broadly permissible. The
  Service treats your private library the same way a notes app treats
  your personal notes.
- **Household sharing** (you and up to 5 other household members):
  permissible for content you own or have license to share with your
  household. Each household share requires a written attestation,
  logged in the audit trail.
- **Public publishing** (anyone with the URL can read): permissible
  only for content you wrote yourself, content explicitly licensed for
  redistribution (Creative Commons, public domain, etc.), or content
  you have written permission from the rights holder to redistribute.
  **Recipes from copyrighted cookbooks may not be made public.**

Violations are taken seriously. See the
[Acceptable Use Policy](/legal/aup) for details.

## 4. Household sharing rules

- A user may belong to at most one household at a time.
- A household may contain at most 6 active members.
- After leaving or being removed from a household, there is a 7-day
  cooldown before joining or creating another.
- Sharing a collection with a household requires an attestation that
  you have the right to do so. The attestation is logged with your
  account ID and a timestamp, and is available to the platform for
  defending takedown disputes.

## 5. Public publishing rules

Public publishing requires:
- A separate, fresh attestation if the collection was previously only
  household-shared. Attestations expire after 5 minutes; if the Service
  prompts you to re-attest before completing a publish action, this is why.
- That the collection is not a cookbook with an ISBN — these are
  treated by the Service as published works subject to publisher
  copyright, and cannot be made public.

## 6. DMCA and copyright

If you believe content on the Service infringes a copyright you hold,
see the [DMCA notice page](/legal/dmca) for the procedure. The Service
operates a repeat-infringer policy: accounts with confirmed
infringement may be permanently banned.

## 7. Termination

You may delete your account at any time. Retention periods after
deletion are described in the [Privacy Policy](/legal/privacy). We may
suspend or terminate your account for: violation of these Terms,
violation of the [Acceptable Use Policy](/legal/aup), repeated or
willful copyright infringement, or activity that materially harms
other users.

## 8. Disclaimers and liability

The Service is provided "as is" without warranties of any kind. To the
maximum extent permitted by law, CookYourBooks is not liable for
indirect or consequential damages. Nothing in these Terms limits
liability for fraud, willful misconduct, or anything else that can't
be limited under applicable law.

## 9. Changes to these Terms

Substantive changes — those that alter your obligations or ours — will
increment the Terms version number shown at the top of this page. When
the version changes, the Service will require you to re-accept before
performing share / publish actions. Reading and personal-use
functionality remain available without re-acceptance. Cosmetic edits
(grammar, formatting) do not change the version.

## 10. Contact

Questions about these Terms: legal@cookyourbooks.app.
Copyright notices: see [DMCA notice page](/legal/dmca) for the
registered Copyright Agent's address and the required notice format.
`.trim(),
};

export const AUP: LegalDoc = {
  slug: 'aup',
  title: 'Acceptable Use Policy',
  summary:
    "What you can and can't do with CookYourBooks. Violations risk account suspension or ban.",
  body: `
# Acceptable Use Policy

**Last updated:** ${LEGAL_LAST_UPDATED} · **Version:** ${CURRENT_TOS_VERSION}

This Acceptable Use Policy (the "AUP") describes content and behavior
that is not allowed on CookYourBooks. The AUP supplements the
[Terms of Service](/legal/terms) and is enforced together with them.

## 1. Zero tolerance: copyright infringement

CookYourBooks operates a zero-tolerance policy on copyright
infringement. The following are not permitted:

- Publishing recipes copied from copyrighted cookbooks, magazines, or
  websites without the rights holder's permission.
- Sharing the contents of an entire copyrighted cookbook with a
  household-sized group on the theory that "it's just family" — the
  household feature is for content you own the rights to share, not a
  loophole for redistribution.
- Uploading images, photographs, or cover art you do not have the
  rights to.

Confirmed copyright violations result in:
1. Removal of the offending content.
2. Suspension or permanent ban of the user account.
3. Cooperation with the rights holder's DMCA process where
   applicable.

A note on what is and isn't copyrightable: bare lists of ingredients
are generally not protected by copyright, but the expressive prose
around recipes — headnotes, descriptions, the instructions as written,
photographs, and the cookbook's overall selection and arrangement — is.
If you didn't write it and don't have explicit permission from the
rights holder, don't publish it.

## 2. Household sharing — what counts as a household

The "household" feature is designed for actual households: people who
share physical space and would reasonably share a cookbook on a shelf
together. It is not designed for:

- Friend groups distributed across the country.
- Members of a club, association, or other affinity group.
- Public communities labeled as "households."
- Multi-account rings used to pool copyrighted content.

We don't currently require address verification, but we reserve the
right to investigate suspected abuse and to suspend accounts of users
using "household" as a content-distribution euphemism.

## 3. Behavior toward other users

The following are not permitted:

- Harassment, threats, or targeted abuse.
- Doxxing — publishing other users' personal information.
- Spam, mass-marketing, or impersonation.
- Using the report system to harass a user (the report system has
  per-user rate limits and abuse-reporting volume is itself a signal).

## 4. Platform integrity

The following are not permitted:

- Attempting to circumvent security measures (rate limits, CAPTCHA,
  RLS policies).
- Reverse-engineering the Service to extract other users' data.
- Automated scraping of public content for commercial use.
- Creating accounts to evade a previous suspension.

## 5. Reporting violations

Use the in-app **Report** button on any public collection or recipe.
Reports go to an admin queue. For copyright violations, the DMCA
process at [/legal/dmca](/legal/dmca) is the formal channel; the
in-app report is a faster informal route and is appropriate for most
cases.

## 6. Appeals

If your account is suspended or content is removed and you believe
this was in error, reply to the moderation email you received and
provide an explanation. Appeals are reviewed by a human.
`.trim(),
};

export const DMCA: LegalDoc = {
  slug: 'dmca',
  title: 'DMCA notice & takedown',
  summary: 'How to send a DMCA notice. Our designated Copyright Agent for §512 notices.',
  body: `
# DMCA notice and takedown

**Last updated:** ${LEGAL_LAST_UPDATED}

Cook Your Books respects the intellectual property rights of others. Per the DMCA, we will respond expeditiously to claims of copyright infringement on the Site if submitted to our Copyright Agent as described below. Upon receipt of a notice alleging copyright infringement, We will take whatever action it deems appropriate within its sole discretion, including removal of the allegedly infringing materials and termination of access for repeat infringers of copyright-protected content.

If you believe that your intellectual property rights have been violated by us or by a third party who has uploaded materials to our website, please provide the following information to the designated Copyright Agent listed below:

- A description of the copyrighted work or other intellectual property that you claim has been infringed;
- A description of where the material that you claim is infringing is located on the Site;
- An address, telephone number, and email address where we can contact you and, if different, an email address where the alleged infringing party, if not we, can contact you;
- A statement that you have a good-faith belief that the use is not authorized by the copyright owner or other intellectual property rights owner, by its agent, or by law;
- A statement by you under penalty of perjury that the information in your notice is accurate and that you are the copyright or intellectual property owner or are authorized to act on the owner's behalf;
- Your electronic or physical signature.

Cook Your Books may request additional information before removing any allegedly infringing material. In the event we remove the allegedly infringing materials, we will immediately notify the person responsible for posting such materials that we removed or disabled access to the materials. We may also provide the responsible person with your email address so that the person may respond to your allegations.

Pursuant to 17 U.S.C. 512(c). Cook Your Books designated Copyright Agent is:

Jonathan Bailey
CopyByte
3157 Gentilly Blvd Suite # 2254
New Orleans, LA 70122
Phone: 1-504-356-4555
Email: cyb-dmca@copybyte.com
`.trim(),
};

export const PRIVACY: LegalDoc = {
  slug: 'privacy',
  title: 'Privacy policy',
  summary: 'What we collect, what we do with it, and your rights under GDPR and CCPA.',
  body: `
# Privacy policy

**Last updated:** ${LEGAL_LAST_UPDATED}

> **[CONFIRM before launch]** The placeholders marked \`[CONFIRM: …]\` below
> require a human decision (legal entity name/address, retention durations,
> DPO/EU-rep appointment). Replace them before bumping CURRENT_TOS_VERSION.

## Who we are

CookYourBooks ("we", "us", "our") is the data controller for personal data
processed through this Service. **[CONFIRM: legal entity name, registered
address, and jurisdiction.]** Questions about this policy:
privacy@cookyourbooks.app.

## What we collect and why

We collect only what we need to run the Service. The table below lists each
category, what we use it for, and the legal basis under the GDPR.

| Category | Examples | Purpose | GDPR lawful basis |
|---|---|---|---|
| Account data | Email, password hash, display name, Google OAuth subject | Creating and securing your account | Performance of contract |
| Content | Recipes, collections, photos, notes, OCR upload images | Delivering the Service | Performance of contract |
| Sync metadata | Last-sync timestamps per topic | Efficient incremental sync so we don't refetch everything | Performance of contract |
| Audit log | Household / sharing / attestation / ToS actions with timestamps | Defending takedowns; investigating abuse | Legitimate interest |
| Telemetry | Sentry error events, 10%-sampled performance traces, error-only session replay (Supabase user UUID only; text/inputs/media masked) | Debugging and reliability | Legitimate interest |
| Google OAuth token | Issued by Google at sign-in | Authenticating your account via Google | Consent (you initiate the OAuth flow) |

**What we do not collect:**
- Third-party analytics or behavioral profiling (no GA, Mixpanel, Heap, etc.).
- Your physical address.
- Any data from the OCR feature that you process yourself (see below).

## OCR / photo import

When you use the import-from-photo feature, images are sent **directly from
your browser to the LLM provider you configure** (e.g., Google Gemini or an
OpenAI-compatible endpoint). Your images and your API key do not transit our
infrastructure. Your provider's own privacy policy governs how they handle
that data. We store only the structured recipe data that comes back.

## Local storage and browser data

The Service stores data locally in your browser:

- **IndexedDB** — your recipe library, synced from Supabase, for offline access.
- **localStorage** — OCR settings (provider, model, prompt) under
  \`cookyourbooks.ocr.v1\`; a debug flag under \`cookyourbooks.sync.consoleMirror\`.
- **Session storage / cookies** — your Supabase auth session token.

No advertising or analytics cookies are used. The cookies we set are strictly
necessary for the Service to function; no cookie banner is legally required.

## Household sharing visibility

When you join a household, other active members can see:
- Your display name.
- The collections you have explicitly shared with the household.
- The fact that you are a member (with your role and join date).

They cannot see your email, your private (un-shared) collections, or your
activity outside the household.

## Audit log

The audit log records every state-changing action you take in the household
feature: creating a household, accepting an invite, sharing or unsharing a
collection, and accepting the Terms. The log is visible to you (your own
actions), to other members of your household (actions in your shared
household), and to platform admins. It is not exposed to the public.

Audit logs are retained **indefinitely** as required for takedown defense and
abuse investigation.

## Subprocessors

We share data only with the vendors listed below. All are US-based.

| Vendor | Role | Transfer basis (EEA users) |
|---|---|---|
| Supabase | Database, file storage, auth, realtime, edge functions | Standard Contractual Clauses (Supabase DPA) |
| Vercel | Web hosting | EU-US Data Privacy Framework (Vercel is DPF-certified) |
| Google | OAuth sign-in only | EU-US Data Privacy Framework (Google is DPF-certified) |
| CookYourBooks (self-hosted Sentry) | Error events, performance traces, error-only session replay | Controller-to-controller SCCs between us and EEA users |

The user-configured LLM provider for OCR is not our subprocessor — you
contract with them directly and data flows from your browser to them.

## Data retention

| Data | Retention |
|---|---|
| Active account data | Held for the lifetime of your account |
| Deleted account — content and sync data | Hard-deleted immediately when you delete your account in-app. The auth identity, profile, recipe collections, recipes, import history, conversion rules, household memberships, and all related rows cascade-delete in the same database transaction. |
| Audit log | Retained indefinitely with the actor link set to NULL after deletion (legitimate-interest carve-out for takedown defense and abuse investigation). |
| Sentry telemetry events | **[CONFIRM: 30 or 90 days per your Sentry project settings]** |
| OCR import artifacts (uploaded images) | **[CONFIRM: retention policy for Storage bucket]** |

## International data transfers

All subprocessors are based in the United States. If you are in the
European Economic Area, the United Kingdom, or Switzerland, your data is
transferred to the US on the bases listed in the subprocessor table above
(DPF certification or SCCs). For the self-hosted Sentry instance, which
operates on infrastructure we control, the applicable transfer mechanism is
Standard Contractual Clauses between us and you as the data subject.

## Your rights under GDPR

If you are in the EEA, UK, or Switzerland, you have the right to:

- **Access** the personal data we hold about you.
- **Rectify** inaccurate data.
- **Erase** your data ("right to be forgotten") — in-app account deletion
  initiates erasure subject to the retention periods above.
- **Portability** — export your recipe library via the in-app export.
- **Restrict** processing in certain circumstances.
- **Object** to processing based on legitimate interest.
- **Withdraw consent** for consent-based processing (Google OAuth, OCR).
- **Lodge a complaint** with your national supervisory authority.

To exercise these rights, use the in-app account settings or email
privacy@cookyourbooks.app. We respond within 30 days per Art. 12(3) GDPR.

**[CONFIRM: DPO appointment — either appoint a DPO and provide contact
details here, or confirm that Art. 37 GDPR does not require one (i.e., the
processing is not large-scale, systematic, or of special categories).]**

**[CONFIRM: EU Representative — if you have no establishment in the EEA,
Art. 27 GDPR may require appointing an EU representative. Confirm whether
this applies and, if so, add their details here.]**

## Your rights under CCPA / CPRA

If you are a California resident, you have the right to:

- **Know** what personal information we collect, use, and share.
- **Delete** your personal information (subject to exceptions, e.g., the
  audit log retained for legal defense).
- **Correct** inaccurate personal information.
- **Opt out of sale or sharing** — we do not sell personal information, and
  we do not share it for cross-context behavioral advertising.

To exercise these rights, email privacy@cookyourbooks.app or use in-app
account deletion. We will not discriminate against you for exercising them.

*California Shine the Light (Cal. Civ. Code § 1798.83):* We do not disclose
personal information to third parties for their own direct marketing purposes.

## Children's privacy

You must be at least 13 years old to use the Service (per the [Terms of
Service](/legal/terms)). In EU member states where the applicable minimum age
under Art. 8 GDPR is 16, you must be at least 16. If we become aware that an
account holder is below the applicable minimum age, we will delete the account
and its data promptly.

## Security and breach notification

We implement appropriate technical and organisational measures to protect your
data, including row-level security on all database tables, encryption at rest
via Supabase, and TLS for all data in transit.

In the event of a personal data breach, we will notify the relevant supervisory
authority within 72 hours where feasible (GDPR Art. 33), and will notify
affected users without undue delay where the breach is likely to result in high
risk to their rights and freedoms (GDPR Art. 34 / CCPA § 1798.82).

## Changes to this policy

Material changes — those that affect how we collect or use your data — will
update the **Last updated** date above. We will give you reasonable notice
of significant changes (e.g., by email or an in-app notice) before they take
effect. Continued use of the Service after the effective date constitutes
acceptance of the revised policy.

## Contact

For privacy-related questions, requests, or complaints:
privacy@cookyourbooks.app.
`.trim(),
};

export const DATA_DELETION: LegalDoc = {
  slug: 'data-deletion',
  title: 'How to delete your CookYourBooks account and data',
  summary:
    'Step-by-step instructions for permanently deleting your account, recipes, and sync data.',
  body: `
# How to delete your CookYourBooks account and data

**Last updated:** ${LEGAL_LAST_UPDATED}

This page is the canonical "data deletion instructions" reference for
third-party platforms (Meta App Review, Google Play Data safety, App
Store privacy disclosures) and for users exercising their GDPR Article
17 ("right to be forgotten") or CCPA / CPRA deletion rights.

## In-app deletion (recommended)

If you can sign in to CookYourBooks, this is the fastest path:

1. Open CookYourBooks (web at <https://www.cookyourbooks.app/> or the
   iOS app from TestFlight / the App Store) and sign in.
2. Tap your avatar / name in the top-right corner → **Settings**.
3. Scroll to the **Danger Zone** section.
4. Tap **Delete account** and confirm.

What gets deleted, in the same database transaction:

- Your authentication identity (email/password or Google OAuth subject).
- Your profile (display name, avatar reference).
- All of your recipe collections, recipes, ingredients, instructions,
  and any conversion rules you defined.
- Your full import history (uploaded photos, OCR scans, drafts, video
  link imports), along with the underlying objects in storage.
- Your household memberships and any shares you initiated.
- Your settings (OCR provider/key reference, theme, household
  preferences).
- All local sync state on the device the moment you next open the app
  while signed out.

The user-supplied API keys for OCR / video providers (Gemini, etc.)
are stored encrypted in Supabase Vault and the references are removed
in the same transaction; the encryption keys are rotated on a separate
schedule documented in the Privacy Policy.

## Email request (no sign-in needed)

If you've lost access to your account, or you signed up but never
opened the app, email **privacy@cookyourbooks.app** from the address
you registered with. Include:

- The email address tied to the account.
- Confirmation that you want to delete the account and all associated
  data.

We respond within 30 days per GDPR Art. 12(3). In practice it's
usually same-day.

## What we retain after deletion

A small set of records survive deletion because the law requires it
or because they no longer identify you:

- **Audit log of moderation actions** (e.g., DMCA takedowns, account
  suspensions for abuse). Retained for the statutory limitations
  period as legal defense.
- **Aggregated, anonymized usage metrics** that contain no identifier
  linkable back to you.

All of this is described in detail in the [Privacy
Policy](/legal/privacy) under "Retention."

## Third-party data we don't control

A few flows in the app hand data to third parties; deleting your
CookYourBooks account does **not** automatically delete data those
parties may hold:

- **Google sign-in:** managed by Google. Revoke at
  <https://myaccount.google.com/permissions>.
- **Apple sign-in:** managed by Apple. Revoke at System Settings →
  Apple ID → Sign in with Apple.
- **Your OCR / video-provider keys (Gemini, etc.):** if you supplied
  your own key, calls go directly to the provider. Manage / revoke
  the key in the provider's own console.
- **Public Instagram captions fetched via Meta's Graph oEmbed:** when
  you imported an Instagram recipe via "Share to CookYourBooks", Meta
  served us the post's public caption. Meta's logs of that request are
  governed by Meta's policies, not ours.

## Questions

Email **privacy@cookyourbooks.app**.
`.trim(),
};

export const DOCS: Record<LegalDoc['slug'], LegalDoc> = {
  terms: TERMS,
  aup: AUP,
  dmca: DMCA,
  privacy: PRIVACY,
  'data-deletion': DATA_DELETION,
};
