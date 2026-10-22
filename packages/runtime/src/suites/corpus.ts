import Database from "better-sqlite3";
import { Type } from "typebox";
import type { WorkTool } from "../tools/work-tool.ts";

export const PAGE_CHARS = 8000;
export const LIST_PAGE = 50;
export const HITS = 10;
const MAX_WORDS = 12;

/**
 * Common English function words: articles, pronouns, auxiliaries, prepositions, conjunctions and wh-words. Their posting lists cover most of
 * a large corpus, so an OR query with them is slow, and BM25 gives them almost no weight. "may" is kept (the month).
 */
export const STOPWORDS: ReadonlySet<string> = new Set(
  ("a an the " +
    "i me my mine myself we us our ours ourselves you your yours yourself yourselves he him his himself she her hers herself it its itself " +
    "they them their theirs themselves this that these those " +
    "am is are was were be been being have has had having do does did doing will would shall should can could might must " +
    "of in on at by for with about against between into through during before after above below to from up down out off over under upon " +
    "within without onto toward towards across along among around behind beyond near since until via " +
    "and or but nor so yet if then than because as while although though whether both either neither " +
    "what which who whom whose when where why how " +
    "not no there here also very just any some all each such only own same too other").split(" "),
);

/**
 * Any text → an FTS5 query of quoted words joined by OR, so agent input can never be FTS5 syntax.
 * Stopwords are dropped before the word cap; a query of stopwords only keeps its words ("The Who").
 */
export function ftsQuery(q: string): string | null {
  const words = [...new Set(q.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])];
  const content = words.filter((w) => !STOPWORDS.has(w));
  const kept = (content.length ? content : words).slice(0, MAX_WORDS);
  return kept.length ? kept.map((w) => `"${w}"`).join(" OR ") : null;
}

const pages = (len: number, size: number) => Math.max(1, Math.ceil(len / size));

export class Corpus {
  private db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path, { readonly: true, fileMustExist: true });
  }

  search(q: string): { id: string; title: string; snippet: string }[] {
    const query = ftsQuery(q);
    if (!query) throw new Error("The query has no words.");
    return this.db
      .prepare(
        `SELECT d.id AS id, d.title AS title, snippet(docs_fts, 1, '', '', ' … ', 24) AS snippet
         FROM docs_fts JOIN docs d ON d.rowid = docs_fts.rowid
         WHERE docs_fts MATCH ? ORDER BY rank LIMIT ${HITS}`,
      )
      .all(query) as { id: string; title: string; snippet: string }[];
  }

  page(id: string, page: number): string {
    const doc = this.db.prepare("SELECT title, body FROM docs WHERE id = ?").get(id) as { title: string; body: string } | undefined;
    if (!doc) throw new Error(`There is no document "${id}".`);
    const n = pages(doc.body.length, PAGE_CHARS);
    if (!Number.isInteger(page) || page < 1 || page > n) throw new Error(`Document ${id} has pages 1 to ${n}.`);
    return `Document ${id}: ${doc.title} (page ${page} of ${n})\n\n${doc.body.slice((page - 1) * PAGE_CHARS, page * PAGE_CHARS)}`;
  }

  list(page: number): string {
    const total = (this.db.prepare("SELECT COUNT(*) AS c FROM docs").get() as { c: number }).c;
    const n = pages(total, LIST_PAGE);
    if (!Number.isInteger(page) || page < 1 || page > n) throw new Error(`The list has pages 1 to ${n}.`);
    const rows = this.db.prepare("SELECT id, title FROM docs ORDER BY ord LIMIT ? OFFSET ?").all(LIST_PAGE, (page - 1) * LIST_PAGE) as { id: string; title: string }[];
    const a = (page - 1) * LIST_PAGE + 1;
    return [`Documents ${a}–${a + rows.length - 1} of ${total} (page ${page} of ${n}):`, ...rows.map((r) => `[${r.id}] ${r.title}`)].join("\n");
  }

  close(): void {
    this.db.close();
  }
}

export type CorpusToolName = "search" | "read_doc" | "list_docs";

export function corpusTools(c: Corpus, names: CorpusToolName[]): WorkTool[] {
  const all: Record<CorpusToolName, WorkTool> = {
    search: {
      name: "search",
      description: `Search the document collection by keywords. Returns the ${HITS} best matches with their ids and a snippet.`,
      parameters: Type.Object({ query: Type.String() }),
      run: async (a: { query: string }) => {
        const hits = c.search(a.query);
        if (hits.length === 0) return "No documents match.";
        return hits.map((h, i) => `${i + 1}. [${h.id}] ${h.title}\n   ${h.snippet.replace(/\s+/g, " ").trim()}`).join("\n");
      },
    },
    read_doc: {
      name: "read_doc",
      description: `Read one page (about 2,000 tokens) of a document by its id. Pages start at 1.`,
      parameters: Type.Object({ id: Type.String(), page: Type.Optional(Type.Integer()) }),
      run: async (a: { id: string; page?: number }) => c.page(a.id, a.page ?? 1),
    },
    list_docs: {
      name: "list_docs",
      description: `List the documents in order, ${LIST_PAGE} per page, with their ids and titles. Pages start at 1.`,
      parameters: Type.Object({ page: Type.Optional(Type.Integer()) }),
      run: async (a: { page?: number }) => c.list(a.page ?? 1),
    },
  };
  return names.map((n) => all[n]);
}
