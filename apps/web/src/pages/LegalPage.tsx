import type React from 'react';
import { Link, useParams } from 'react-router-dom';
import { DOCS, LEGAL_LAST_UPDATED } from '../legal/content.js';

/**
 * Renders one of the legal documents (Terms, AUP, DMCA, Privacy) as a
 * plain markdown page. We intentionally don't pull in a full markdown
 * library — a 30-line renderer is enough to handle the markdown
 * subset these documents use (headings, paragraphs, lists, tables,
 * bold, inline code, links, blockquotes).
 *
 * Routes:
 *   /legal           → index linking to each doc
 *   /legal/terms     → ToS
 *   /legal/aup       → Acceptable Use
 *   /legal/dmca      → DMCA
 *   /legal/privacy   → Privacy
 */
export function LegalPage() {
  const { doc } = useParams();
  if (!doc) {
    return (
      <section className="space-y-3">
        <h1 className="text-2xl font-semibold">Legal</h1>
        <p className="text-stone-600 dark:text-stone-400">Last updated: {LEGAL_LAST_UPDATED}</p>
        <ul className="list-disc pl-5 space-y-1">
          {Object.values(DOCS).map((d) => (
            <li key={d.slug}>
              <Link to={`/legal/${d.slug}`} className="underline">
                {d.title}
              </Link>
              <span className="text-stone-500 dark:text-stone-400"> — {d.summary}</span>
            </li>
          ))}
        </ul>
      </section>
    );
  }
  const found = DOCS[doc];
  if (!found) {
    return (
      <p className="text-stone-600 dark:text-stone-400">
        No such legal document.{' '}
        <Link to="/legal" className="underline">Index</Link>.
      </p>
    );
  }
  return (
    <article
      data-testid={`legal-${found.slug}`}
      className="prose prose-stone dark:prose-invert max-w-3xl"
    >
      <MarkdownView body={found.body} />
      <footer className="not-prose mt-8 pt-4 border-t border-stone-200 dark:border-stone-700 text-sm">
        <Link to="/legal" className="underline">All legal documents</Link>
      </footer>
    </article>
  );
}

// ---------- Minimal markdown rendering ----------
//
// The legal-document subset uses: `#`/`##` headings, paragraphs, `-`
// bullet lists, `>` blockquotes, pipe tables, **bold**, [text](url),
// `inline code`. Enough to render cleanly without a markdown
// dependency. Pages are static so we don't worry about
// dangerouslySetInnerHTML pulling user content.

function MarkdownView({ body }: { body: string }) {
  const blocks = body.split(/\n{2,}/);
  return (
    <>
      {blocks.map((block, i) => renderBlock(block.trim(), i))}
    </>
  );
}

function renderBlock(block: string, key: number): React.ReactElement | null {
  if (!block) return null;
  if (block.startsWith('# ')) return <h1 key={key}>{inline(block.slice(2))}</h1>;
  if (block.startsWith('## ')) return <h2 key={key}>{inline(block.slice(3))}</h2>;
  if (block.startsWith('### ')) return <h3 key={key}>{inline(block.slice(4))}</h3>;
  if (block.startsWith('> ')) {
    return (
      <blockquote key={key}>
        {block
          .split('\n')
          .map((line) => line.replace(/^>\s?/, ''))
          .map((line, j) => (
            <p key={j}>{inline(line)}</p>
          ))}
      </blockquote>
    );
  }
  if (/^\|.*\|$/.test(block.split('\n')[0] ?? '')) {
    const rows = block.split('\n').map((r) => r.split('|').slice(1, -1).map((c) => c.trim()));
    if (rows.length < 2) return <p key={key}>{inline(block)}</p>;
    return (
      <table key={key}>
        <tbody>
          {rows
            .filter((row) => !row.every((c) => /^-+$/.test(c)))
            .map((row, j) => (
              <tr key={j}>
                {row.map((cell, k) => (
                  <td key={k}>{inline(cell)}</td>
                ))}
              </tr>
            ))}
        </tbody>
      </table>
    );
  }
  if (block.startsWith('- ') || block.startsWith('1. ')) {
    const ordered = block.startsWith('1. ');
    const items = block.split('\n').map((line) => line.replace(/^(\d+\.|-)\s+/, ''));
    return ordered ? (
      <ol key={key}>
        {items.map((it, j) => (
          <li key={j}>{inline(it)}</li>
        ))}
      </ol>
    ) : (
      <ul key={key}>
        {items.map((it, j) => (
          <li key={j}>{inline(it)}</li>
        ))}
      </ul>
    );
  }
  return <p key={key}>{inline(block)}</p>;
}

function inline(text: string): React.ReactElement[] {
  // Replace **bold**, [text](url), `code`. Order matters: do links first
  // since their syntax contains characters that would confuse the others.
  const out: Array<string | React.ReactElement> = [text];
  function passReplace(re: RegExp, build: (m: RegExpExecArray) => React.ReactElement) {
    const next: typeof out = [];
    for (const piece of out) {
      if (typeof piece !== 'string') {
        next.push(piece);
        continue;
      }
      let last = 0;
      let m: RegExpExecArray | null;
      const local = new RegExp(re.source, re.flags);
      while ((m = local.exec(piece))) {
        if (m.index > last) next.push(piece.slice(last, m.index));
        next.push(build(m));
        last = m.index + m[0]!.length;
      }
      if (last < piece.length) next.push(piece.slice(last));
    }
    out.length = 0;
    out.push(...next);
  }
  passReplace(/\[([^\]]+)\]\(([^)]+)\)/g, (m) => (
    <Link key={`l-${m.index}`} to={m[2]!} className="underline">
      {m[1]}
    </Link>
  ));
  passReplace(/\*\*([^*]+)\*\*/g, (m) => <strong key={`b-${m.index}`}>{m[1]}</strong>);
  passReplace(/`([^`]+)`/g, (m) => <code key={`c-${m.index}`}>{m[1]}</code>);
  return out.map((piece, i) =>
    typeof piece === 'string' ? <span key={i}>{piece}</span> : piece,
  );
}
