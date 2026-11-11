import * as v from "valibot";
import {
  COORD_MAX,
  MARK_COLORS,
  MARK_TOOLS,
  MAX_SLIDE_ADDRESS_CHARS,
  MAX_SLIDE_POINTS,
  MAX_SLIDE_STROKES,
  MAX_STROKE_POINTS,
  type MarkColor,
  type MarkEvent,
  type MarkTool,
} from "./mirrorTypes";

/**
 * Saved marks (decision 105): the pen and arrow marks of each slide, kept in
 * this browser per document identity (the comments' key, decision 65) and
 * slide address, with the fingerprint of the text they were drawn on. The
 * IndexedDB side is in marksStore.ts; this file holds what does not need the
 * DOM, so the Node-run unit tests import it: the record's schema and caps,
 * the marks of one open document, and the observer that saves what the
 * layer reports.
 *
 * Read-back records are hostile input (rule 5). Only numbers, two picklists
 * and two strings that are compared for equality pass, and nothing here
 * ever builds markup.
 */

/** Slides with saved marks per document, and points over all of them. */
export const MAX_SAVED_SLIDES = 500;
export const MAX_DOCUMENT_POINTS = 100_000;
/** Numbers one read may hand to the parser, kept or refused: twice what a full document holds. */
export const MAX_PARSED_NUMBERS = 4 * MAX_DOCUMENT_POINTS;
/** The longest document key a record may carry (the comments' alias check uses the same). */
const MAX_DOCUMENT_KEY_CHARS = 4096;

export interface SavedStroke {
  tool: MarkTool;
  color: MarkColor;
  /** Flat grid points (x0, y0, x1, y1, ...), as the mirror carries them (decision 88). */
  points: readonly number[];
}

interface SavedSlide {
  /** The slide address, `<section-id>/<n>` (rule 7). */
  slide: string;
  /** The fingerprint of the slide's text when the marks were made (markKeys.ts). */
  text: string;
  strokes: readonly SavedStroke[];
}

/** One IndexedDB record: a slide of a document. */
export interface StoredSlide extends SavedSlide {
  doc: string;
}

/** The layer's key for a slide: its address and the fingerprint of its text. */
export const markKey = (address: string, fingerprint: string): string =>
  `${address}#${fingerprint}`;

/**
 * A list of at most `max` items. The length is checked first, so an
 * oversized hostile list is refused without walking it.
 */
function list<T extends v.GenericSchema>(max: number, item: T) {
  return v.pipe(
    v.custom<unknown[]>((value) => Array.isArray(value) && value.length <= max, "too long"),
    v.array(item),
  );
}

const Coord = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(COORD_MAX));

const StrokeSchema = v.pipe(
  v.strictObject({
    tool: v.picklist(MARK_TOOLS),
    color: v.picklist(MARK_COLORS),
    points: list(2 * MAX_STROKE_POINTS, Coord),
  }),
  v.check(({ tool, points }) => {
    if (points.length % 2 !== 0) return false;
    // Every tool but the pen is two corners (decision 110); a pen stroke has at least one point.
    return tool === "pen" ? points.length >= 2 : points.length === 4;
  }, "malformed stroke"),
);

const pointsOf = (strokes: readonly SavedStroke[]) =>
  strokes.reduce((sum, stroke) => sum + stroke.points.length / 2, 0);

const StoredSlideSchema = v.pipe(
  v.strictObject({
    doc: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_DOCUMENT_KEY_CHARS)),
    slide: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_SLIDE_ADDRESS_CHARS)),
    text: v.pipe(v.string(), v.regex(/^[0-9a-f]{1,8}$/)),
    strokes: v.pipe(list(MAX_SLIDE_STROKES, StrokeSchema), v.minLength(1)),
  }),
  v.check(({ strokes }) => pointsOf(strokes) <= MAX_SLIDE_POINTS, "too many points"),
);

/**
 * How many numbers a stored record's strokes hold, counted from the lists'
 * lengths alone (a walk over the strokes, never over a coordinate), or
 * `Infinity` when it is not a record with lists of strokes. Stops counting
 * past `limit`.
 */
function numbersIn(item: unknown, limit: number): number {
  const strokes = (item as { strokes?: unknown } | null)?.strokes;
  // A long list of strokes fails the schema by its length, before its items are read.
  if (!Array.isArray(strokes) || strokes.length > MAX_SLIDE_STROKES)
    return Number.POSITIVE_INFINITY;
  let sum = 0;
  for (const stroke of strokes as unknown[]) {
    const points = (stroke as { points?: unknown } | null)?.points;
    if (!Array.isArray(points)) return Number.POSITIVE_INFINITY;
    sum += points.length;
    if (sum > limit) break;
  }
  return sum;
}

/**
 * The slides of `doc` among stored records, in their order. A record that
 * fails the schema or belongs to another document is skipped alone; past
 * `MAX_SAVED_SLIDES` slides or `MAX_DOCUMENT_POINTS` points the rest are
 * skipped too. A record too big for a slide, or for what is left of the
 * document's points, is skipped before its coordinates are parsed, and the
 * reader stops once `MAX_PARSED_NUMBERS` numbers have gone to the parser,
 * whether their records passed or failed: a hostile profile cannot make it
 * walk millions of numbers (rule 5).
 */
export function readSlides(doc: string, records: unknown): SavedSlide[] {
  if (!Array.isArray(records)) return [];
  const kept: SavedSlide[] = [];
  const seen = new Set<string>();
  let points = 0;
  let parsed = 0;
  for (const item of records.slice(0, MAX_SAVED_SLIDES)) {
    if (points >= MAX_DOCUMENT_POINTS) break;
    const room = 2 * Math.min(MAX_SLIDE_POINTS, MAX_DOCUMENT_POINTS - points);
    const numbers = numbersIn(item, room);
    if (numbers > room) continue;
    // Records that fail late cost as much as those that pass, so the walk is bounded as a whole.
    if (parsed + numbers > MAX_PARSED_NUMBERS) break;
    parsed += numbers;
    // Pass or fail is all that is needed: the first refused stroke ends the parse, so a record
    // of strokes with thousands of unknown keys costs one walk, not one per stroke.
    const result = v.safeParse(StoredSlideSchema, item, { abortEarly: true });
    if (!result.success) continue;
    const { slide, text, strokes } = result.output;
    if (result.output.doc !== doc || seen.has(slide)) continue;
    const count = pointsOf(strokes);
    if (points + count > MAX_DOCUMENT_POINTS) continue;
    points += count;
    seen.add(slide);
    kept.push({ slide, text, strokes });
  }
  return kept;
}

/** Where saved marks live: IndexedDB (marksStore.ts), or memory where it is missing. */
export interface MarksStore {
  /** False when marks last only as long as the page. */
  readonly persistent: boolean;
  /** The raw records of `doc`, unvalidated. */
  load(doc: string): Promise<unknown>;
  put(record: StoredSlide): Promise<void>;
  remove(doc: string, slide: string): Promise<void>;
  clear(doc: string): Promise<void>;
}

const recordId = (doc: string, slide: string) => JSON.stringify([doc, slide]);

/** Marks for this page only, where IndexedDB is missing or blocked (and for tests). */
export function memoryMarksStore(): MarksStore {
  const records = new Map<string, StoredSlide>();
  return {
    persistent: false,
    load: async (doc) => [...records.values()].filter((r) => r.doc === doc),
    put: async (record) => {
      records.set(recordId(record.doc, record.slide), record);
    },
    remove: async (doc, slide) => {
      records.delete(recordId(doc, slide));
    },
    clear: async (doc) => {
      for (const [key, r] of records) if (r.doc === doc) records.delete(key);
    },
  };
}

export type MarksProblem = "full" | "failed";

/**
 * The saved marks of the open document. Reads are synchronous, from what
 * was loaded and saved since; every write goes to the store in order.
 */
export class DocumentMarks {
  private readonly slides = new Map<string, SavedSlide>();
  private points = 0;
  private saving: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<() => void>();
  private readonly told = new Set<MarksProblem>();

  private readonly store: MarksStore | null;

  /**
   * `store` is null when the stored marks could not be read: writing then
   * would replace them unseen. A key no record can carry is the same: the
   * marks stay on screen, nothing is saved, and the first one says so.
   */
  constructor(
    readonly doc: string,
    slides: readonly SavedSlide[],
    store: MarksStore | null,
    private readonly onProblem: (problem: MarksProblem) => void,
  ) {
    this.store = doc.length >= 1 && doc.length <= MAX_DOCUMENT_KEY_CHARS ? store : null;
    for (const slide of slides) {
      this.slides.set(slide.slide, slide);
      this.points += pointsOf(slide.strokes);
    }
  }

  /** How many slides have saved marks, whether or not their text still matches. */
  get size(): number {
    return this.slides.size;
  }

  /** The saved strokes of a slide, when its text is the one they were drawn on. */
  strokes(address: string, fingerprint: string): readonly SavedStroke[] {
    const saved = this.slides.get(address);
    return saved?.text === fingerprint ? saved.strokes : [];
  }

  /** The same for the layer's key (`markKey`), which holds the address and the fingerprint. */
  forKey(key: string, address: string): readonly SavedStroke[] {
    const saved = this.slides.get(address);
    return saved && markKey(address, saved.text) === key ? saved.strokes : [];
  }

  /**
   * Saves what a slide shows now; no strokes deletes its record. Returns
   * false, and keeps the slide's last saved marks, when the slide or the
   * document would pass a cap.
   */
  put(address: string, fingerprint: string, strokes: readonly SavedStroke[]): boolean {
    // The empty key is no document (marks that are never kept): nothing to hold, nothing to say.
    if (this.doc === "") return false;
    // An address no record can carry is a failed save, not a full one.
    if (address.length > MAX_SLIDE_ADDRESS_CHARS) {
      this.tell("failed");
      return false;
    }
    const kept = strokes.map(({ tool, color, points }) => ({ tool, color, points: [...points] }));
    const before = this.slides.get(address);
    const points = this.points - (before ? pointsOf(before.strokes) : 0) + pointsOf(kept);
    const record: StoredSlide = { doc: this.doc, slide: address, text: fingerprint, strokes: kept };
    const fits =
      kept.length === 0 ||
      ((before !== undefined || this.slides.size < MAX_SAVED_SLIDES) &&
        points <= MAX_DOCUMENT_POINTS &&
        // The key was checked when this was built; a long one must not read as "full".
        v.is(StoredSlideSchema, { ...record, doc: "-" }));
    if (!fits) {
      this.tell("full");
      return false;
    }
    this.points = points;
    if (kept.length === 0) this.slides.delete(address);
    else this.slides.set(address, { slide: address, text: fingerprint, strokes: kept });
    this.write((store) =>
      kept.length === 0 ? store.remove(this.doc, address) : store.put(record),
    );
    this.changed();
    return true;
  }

  /** Deletes every saved mark of the document; false when the store did not. */
  async clear(): Promise<boolean> {
    this.slides.clear();
    this.points = 0;
    this.changed();
    let done = this.store !== null;
    this.write((store) =>
      store.clear(this.doc).catch((error: unknown) => {
        done = false;
        throw error;
      }),
    );
    await this.settled();
    return done;
  }

  /** Resolves when every write asked for so far has finished. */
  settled(): Promise<void> {
    return this.saving;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private write(act: (store: MarksStore) => Promise<void>) {
    const { store } = this;
    if (!store) {
      this.tell("failed");
      return;
    }
    this.saving = this.saving.then(() => act(store)).catch(() => this.tell("failed"));
  }

  private changed() {
    for (const listener of this.listeners) listener();
  }

  /** Each problem is told once per document, not on every stroke. */
  private tell(problem: MarksProblem) {
    if (this.told.has(problem)) return;
    this.told.add(problem);
    this.onProblem(problem);
  }
}

/**
 * The saved marks of `doc`. A store that cannot read them gives a document
 * that saves nothing, so the marks there are never replaced unseen.
 */
export async function loadMarks(
  store: MarksStore,
  doc: string,
  onProblem: (problem: MarksProblem) => void,
  /** The key `doc` had before decision 120: its records move to `doc` once, when `doc` has none. */
  legacy: string | null = null,
): Promise<DocumentMarks> {
  let slides: SavedSlide[];
  try {
    slides = readSlides(doc, await store.load(doc));
  } catch {
    return new DocumentMarks(doc, [], null, onProblem);
  }
  if (slides.length === 0 && legacy !== null && legacy !== doc) {
    try {
      const old = readSlides(legacy, await store.load(legacy));
      if (old.length > 0) {
        for (const slide of old) await store.put({ doc, ...slide });
        await store.clear(legacy);
        slides = old;
      }
    } catch {
      // The old records stay; the next open tries again.
    }
  }
  return new DocumentMarks(doc, slides, store, onProblem);
}

/**
 * An annotation-layer observer that saves what the slide on screen shows
 * after each change the presenter makes (a stroke, undo, redo, the eraser,
 * Clear marks). A change of slide (`reset`) changes nothing to save. A
 * rebuild reports the slides whose marks it dropped from memory; those
 * records stay, because a resize that moved page breaks drops them too.
 */
export function marksSaver(
  marks: () => DocumentMarks | null,
  fingerprint: (address: string) => string | undefined,
): (event: MarkEvent) => void {
  let shown: string | null = null;
  return (event) => {
    if (event.kind !== "marks") return;
    if (event.reset) {
      shown = event.slide;
      return;
    }
    if (event.slide !== shown) return;
    const print = fingerprint(event.slide);
    if (print === undefined) return;
    marks()?.put(
      event.slide,
      print,
      event.strokes.map(({ tool, color, points }) => ({ tool, color, points })),
    );
  };
}
