// Legal text rendered by `/legal/:doc`.
//
// These are *first drafts* meant to ship with the household-sharing
// feature. They need legal review before going to production. The
// language is plain-English where possible — the DMCA section in
// particular is structured to track 17 U.S.C. §512(c) so that as soon
// as a DMCA agent is registered (separate workstream owned by Jon),
// the only update needed here is the agent's name + contact.
//
// Versioning:
//   - Bump CURRENT_TOS_VERSION in `household/api.ts` AND
//     `current_tos_version()` in supabase/migrations/*_tos.sql in lockstep
//     when the substantive obligations change. Cosmetic edits don't
//     require a bump (and shouldn't, because the bump invalidates every
//     user's acceptance and forces them through the gate again).

export const LEGAL_LAST_UPDATED = '2026-05-26';

export interface LegalDoc {
  slug: 'terms' | 'aup' | 'dmca' | 'privacy';
  title: string;
  summary: string;
  body: string;
}

export const TERMS: LegalDoc = {
  slug: 'terms',
  title: 'Terms of Service',
  summary:
    'Your obligations as a user, our obligations as a service, and the boundaries on both.',
  body: `
# Terms of Service

**Last updated:** ${LEGAL_LAST_UPDATED}

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
  cooldown before joining or creating another. The cooldown exists to
  prevent the household feature from being used as a back-door for
  content distribution.
- Sharing a collection with a household requires an attestation that
  you have the right to do so. The attestation is logged with your
  account ID and a timestamp, and is available to the platform for
  defending takedown disputes.

## 5. Public publishing rules

Public publishing requires:
- A separate, fresh attestation if the collection was previously only
  household-shared.
- That the collection is not a cookbook with an ISBN — these are
  treated by the Service as published works subject to publisher
  copyright, and cannot be made public.

## 6. DMCA and copyright

If you believe content on the Service infringes a copyright you hold,
see the [DMCA notice page](/legal/dmca) for the procedure. The Service
operates a repeat-infringer policy: accounts with confirmed
infringement may be permanently banned.

## 7. Termination

You may delete your account at any time. We may suspend or terminate
your account for: violation of these Terms, violation of the
[Acceptable Use Policy](/legal/aup), repeated or willful copyright
infringement, or activity that materially harms other users.

## 8. Disclaimers and liability

The Service is provided "as is" without warranties of any kind. To the
maximum extent permitted by law, CookYourBooks is not liable for
indirect or consequential damages. Nothing in these Terms limits
liability for fraud, willful misconduct, or anything else that can't
be limited under applicable law.

## 9. Changes to these Terms

We will give notice of substantive changes by requiring you to
re-accept the Terms before performing share / publish actions. Reading
and personal-use functionality remain available without re-acceptance.

## 10. Contact

Questions about these Terms: legal@cookyourbooks.app.
Copyright notices: dmca@cookyourbooks.app (see
[DMCA notice page](/legal/dmca)).
`.trim(),
};

export const AUP: LegalDoc = {
  slug: 'aup',
  title: 'Acceptable Use Policy',
  summary:
    'What you can and can\'t do with CookYourBooks. Violations risk account suspension or ban.',
  body: `
# Acceptable Use Policy

**Last updated:** ${LEGAL_LAST_UPDATED}

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

The legal facts: bare lists of ingredients are not copyrightable
(*Publications International v. Meredith*, 7th Cir. 1996), but the
expressive prose around recipes — headnotes, descriptions, the
instructions as written, photographs, and the cookbook's
selection-and-arrangement — is copyrightable. If you didn't write it
and don't have explicit permission, don't publish it.

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
  summary:
    'How to send a DMCA notice or counter-notice. Our designated agent for copyright notices.',
  body: `
# DMCA notice and takedown

**Last updated:** ${LEGAL_LAST_UPDATED}

CookYourBooks complies with the U.S. Digital Millennium Copyright Act
(DMCA), 17 U.S.C. §512. If you believe content on the Service
infringes a copyright you own or are authorized to enforce, you may
send a DMCA notice to our designated agent.

## Designated agent

> **Note:** Agent registration with the U.S. Copyright Office is in
> progress as part of the household-sharing release. The contact
> address below is operational. The registered-agent record on
> https://www.copyright.gov/dmca-directory will be updated as soon as
> the registration is complete.

| | |
|---|---|
| **Agent** | DMCA Agent, CookYourBooks |
| **Email** | dmca@cookyourbooks.app |
| **Postal** | (TBD — added on registration) |

## What to include in a notice

To be effective under §512(c)(3), your notice must include:

1. A physical or electronic signature of the copyright owner or an
   authorized representative.
2. Identification of the copyrighted work claimed to be infringed (or,
   for multiple works, a representative list).
3. Identification of the material that is claimed to be infringing,
   with information reasonably sufficient to permit us to locate it —
   ideally including a URL to the offending collection or recipe.
4. Your contact information: address, telephone number, and email.
5. A statement that you have a **good faith belief** that the use is
   not authorized by the copyright owner, its agent, or the law.
6. A statement that the information in the notice is **accurate**,
   and **under penalty of perjury**, that you are authorized to act
   on behalf of the owner of the copyright.

Templates that don't meet these elements may not qualify for §512
treatment and we may not be able to act on them. We respond to
properly-formed notices within 10 business days.

## Counter-notice procedure

If your content was removed in response to a notice and you believe
the removal was in error, you may send a counter-notice. A
counter-notice must include:

1. Your physical or electronic signature.
2. Identification of the material and its location before removal.
3. A statement under penalty of perjury that you have a good-faith
   belief that the material was removed as a result of mistake or
   misidentification.
4. Your name, address, and telephone number.
5. A statement that you consent to the jurisdiction of the federal
   court in the district where you reside (or, if you reside outside
   the U.S., the Northern District of California), and that you will
   accept service of process from the notifier or its agent.

If we receive a valid counter-notice, we forward it to the original
notifier. If the notifier does not file suit within 10–14 business
days, we may restore the content.

## Repeat-infringer policy

We maintain a repeat-infringer policy as required by §512(i). Accounts
with multiple confirmed infringement reports — or any single willful
infringement — are subject to permanent termination. We log every
DMCA action against an account in our audit trail.

## False notices

Knowingly making a materially false statement in a DMCA notice or
counter-notice may subject the sender to liability under §512(f) for
the rights holder's or user's damages, costs, and attorney fees.

## Trademark and other IP

DMCA covers copyright. For trademark or other IP claims, email
legal@cookyourbooks.app.
`.trim(),
};

export const PRIVACY: LegalDoc = {
  slug: 'privacy',
  title: 'Privacy policy',
  summary: 'What we collect, what we do with it, what we don\'t do.',
  body: `
# Privacy policy

**Last updated:** ${LEGAL_LAST_UPDATED}

> This policy is a first draft. It needs review against the actual
> data-flow audit before going to production. The household feature
> doesn't change the privacy posture materially — household members
> see each other's *display name* and *email* (the latter only if used
> as the display name) and any content explicitly shared into the
> household.

## What we collect

- **Account data**: email, password hash, display name.
- **Content you create**: recipes, collections, photos, notes.
- **Sync metadata**: last-synced timestamps so we don't refetch
  everything every time.
- **Audit log**: every household / sharing / attestation / ToS action,
  used to defend takedowns and investigate abuse. Retained
  indefinitely.

## What we don't collect

- Third-party analytics. (No GA, no Mixpanel, no Heap.)
- Behavioral targeting profiles.
- Your physical address.

## Household sharing visibility

When you join a household, other active members of that household can
see:
- Your display name.
- The collections you have explicitly shared with the household.
- The fact that you are a member (with your role and join date).

They cannot see your email, your private (un-shared) collections, or
your activity outside the household.

## Audit log

The audit log records every state-changing action you take in the
household feature: creating a household, accepting an invite, sharing
or unsharing a collection, accepting the ToS. The audit log is
visible to you (your own actions), to other members of your household
(actions in your shared household), and to platform admins. It is not
exposed to the public.

## Contact

privacy@cookyourbooks.app.
`.trim(),
};

export const DOCS: Record<string, LegalDoc> = {
  terms: TERMS,
  aup: AUP,
  dmca: DMCA,
  privacy: PRIVACY,
};
