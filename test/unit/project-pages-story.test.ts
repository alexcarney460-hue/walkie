// PROJECT-PAGES-1: the plain-English parts of the page, taken from the report turn's reply. A block may hold one <page> with a
// headline, a lede and two lists; it is cut out of the report text, read in one pass, and cleaned one string at a time with
// the report's own rules (no link, no join code, no secret, no key, no markup), then capped. What the model gets wrong costs
// only the page, never the report.
import { describe, expect, test } from "bun:test";
import { containsJoinCredential } from "../../src/protocol/join-credential.ts";
import { cleanStoryLine, parseStory, splitPage, STORY_CAPS, storyAsReport, type StoryParts } from "../../src/protocol/projects/page-story.ts";

const prefixes = ["POR", "OLD"];
const page = (inner: string) => `<page>\n${inner}\n</page>`;
const GOOD = [
  "<headline>The new portal is on track: sign-in is live and billing is next</headline>",
  "<lede>This page shows what the customer portal does today. Billing is still being built.</lede>",
  "<live-now>\n- Customers can sign in and see their shipments.\n- Staff can create customer accounts.\n</live-now>",
  "<landing-next>\n- Billing arrives next week.\n</landing-next>",
].join("\n");

describe("cutting the page out of a block", () => {
  test("a block with a page gives the report text without it, and the page", () => {
    const out = splitPage(`**On track.** Sign-in shipped.\n\n${page(GOOD)}\n`);
    expect(out.report).toBe("**On track.** Sign-in shipped.");
    expect(out.page).toBe(`\n${GOOD}\n`);
  });

  test("the page may come first, in the middle or last; the report keeps its own paragraphs", () => {
    expect(splitPage(`${page("x")}\nFirst.\n\nSecond.`).report).toBe("First.\n\nSecond.");
    expect(splitPage(`First.\n${page("x")}\nSecond.`).report).toBe("First.\nSecond.");
  });

  test("no page: the text is the report, untouched", () => {
    expect(splitPage("**On track.** Nothing else.")).toEqual({ report: "**On track.** Nothing else.", page: null });
  });

  test("a page that never closes is dropped with everything after its opener, so none of it lands in the report", () => {
    expect(splitPage("**On track.** Done.\n<page>\n<headline>Half a page")).toEqual({ report: "**On track.** Done.", page: null });
  });

  test("tags in any case or with spaces are read; a stray closer is dropped; the first complete page is the page, the others are removed", () => {
    expect(splitPage("A.\n<PAGE >one</Page >\nB.").page).toBe("one");
    expect(splitPage("A. </page> B.").report).toBe("A.  B.");
    const two = splitPage("A.\n<page>first</page>\nB.\n<page>second</page>");
    expect([two.report, two.page]).toEqual(["A.\nB.", "first"]);
  });

  test("a hostile reply costs next to nothing to cut", () => {
    const time = (f: () => unknown) => Math.min(...[1, 2, 3].map(() => { const t0 = performance.now(); f(); return performance.now() - t0; }));
    for (const text of ["<page>".repeat(100_000), "</page>".repeat(100_000), "<page>x</page>".repeat(50_000), `<page>${"<headline>".repeat(50_000)}`, `${"a ".repeat(2_000_000)}<page>`]) {
      expect(time(() => splitPage(text))).toBeLessThan(300);
    }
  });
});

describe("reading the page", () => {
  const read = (inner: string, screensAsked = false) => parseStory(inner, { prefixes, screensAsked });

  test("a headline, a lede and two lists", () => {
    expect(read(GOOD)).toEqual({
      headline: "The new portal is on track: sign-in is live and billing is next",
      lede: "This page shows what the customer portal does today. Billing is still being built.",
      live_now: ["Customers can sign in and see their shipments.", "Staff can create customer accounts."],
      landing_next: ["Billing arrives next week."],
    });
  });

  test("a list may be empty; a page needs a headline and a lede or it is nothing", () => {
    const noLists = read("<headline>Nothing is live yet, the team has just started</headline><lede>The project began this week and has no screens or features to show yet.</lede>");
    expect(noLists).toMatchObject({ live_now: [], landing_next: [] });
    expect(read("<lede>A lede without a headline is not a page, whatever else it has.</lede>")).toBeNull();
    expect(read("<headline>A headline without a lede is not a page either</headline>")).toBeNull();
    expect(read("<headline>x</headline><lede>short</lede>")).toBeNull();
    expect(read("")).toBeNull();
    expect(read("just some words")).toBeNull();
  });

  test("a list takes hyphen, star, bullet and numbered lines, and plain lines; blanks and repeats are skipped", () => {
    const got = read(`<headline>On track, with sign-in live and billing next</headline><lede>This page shows what the portal does today and what is next.</lede>
<live-now>
- One thing that works.
* Two things that work.
• Three things that work.
1. Four things that work.
2) Five things that work.
Six things that work.

- one thing that works.
</live-now>`);
    expect(got?.live_now).toEqual(["One thing that works.", "Two things that work.", "Three things that work.", "Four things that work.", "Five things that work.", "Six things that work."]);
  });

  test("the two list parts are found however a model spells their names: live-now, live_now, live now; landing-next, landing_next, landing next", () => {
    const head = "<headline>On track, with sign-in live and billing next</headline><lede>This page shows what the portal does today and what is next.</lede>";
    for (const [live, next] of [["live-now", "landing-next"], ["live_now", "landing_next"], ["Live Now", "Landing Next"], ["live now", "landing  next"], ["livenow", "landingnext"]] as const) {
      const got = read(`${head}<${live}>\n- It works.\n</${live}><${next}>\n- It comes.\n</${next}>`);
      expect([live, got?.live_now, got?.landing_next]).toEqual([live, ["It works."], ["It comes."]]);
    }
    // Not any word: a part that is not one of the five is not read, and its opener does not swallow the next part.
    expect(read(`${head}<live-then>\n- Nope.\n</live-then><landing-next>\n- It comes.\n</landing-next>`)).toMatchObject({ live_now: [], landing_next: ["It comes."] });
  });

  test("caps: a headline of 100 characters, a lede of 420, eight live bullets and six next bullets of 180, cut at a word with an ellipsis", () => {
    const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");
    const got = read(`<headline>${words(60)}</headline><lede>${words(200)}</lede>
<live-now>${Array.from({ length: 12 }, (_, i) => `- ${i} ${words(45)}`).join("\n")}</live-now>
<landing-next>${Array.from({ length: 9 }, (_, i) => `- ${i} ${words(45)}`).join("\n")}</landing-next>`) as StoryParts;
    expect(got.headline.length).toBeLessThanOrEqual(STORY_CAPS.headline);
    expect(got.headline.endsWith("…")).toBe(true);
    const whole = new Set(Array.from({ length: 60 }, (_, i) => `word${i}`));
    expect(whole.has(got.headline.slice(0, -1).split(" ").pop() as string)).toBe(true); // cut at a word, not inside one
    expect(got.lede.length).toBeLessThanOrEqual(STORY_CAPS.lede);
    expect(got.live_now).toHaveLength(STORY_CAPS.live);
    expect(got.landing_next).toHaveLength(STORY_CAPS.next);
    for (const item of [...got.live_now, ...got.landing_next]) expect(item.length).toBeLessThanOrEqual(STORY_CAPS.item);
    expect([STORY_CAPS.headline, STORY_CAPS.lede, STORY_CAPS.item, STORY_CAPS.live, STORY_CAPS.next, STORY_CAPS.screens]).toEqual([100, 420, 180, 8, 6, 140]);
  });

  test("the screens sentence is kept only when the daemon asked for it", () => {
    const inner = `${GOOD}\n<screens>Screens are out of date; none have been added yet.</screens>`;
    expect(read(inner, true)?.screens_note).toBe("Screens are out of date; none have been added yet.");
    expect(read(inner, false)).not.toHaveProperty("screens_note");
    expect(read(`${GOOD}\n<screens>   </screens>`, true)).not.toHaveProperty("screens_note");
    expect(read(`${GOOD}\n<screens>${"x ".repeat(200)}</screens>`, true)?.screens_note?.length).toBeLessThanOrEqual(STORY_CAPS.screens);
  });

  test("a part that is not closed is not read, and a part inside another part cannot smuggle text into the first", () => {
    expect(read(`<headline>On track with everything shipped on time</headline><lede>This page shows what the portal does today and what comes next.</lede><live-now>- never closed`)?.live_now).toEqual([]);
    const nested = read("<headline>On track with sign-in live <lede>smuggled</lede> and billing next</headline><lede>This page shows what the portal does today and what is next.</lede>");
    expect(nested?.headline).not.toContain("<");
    expect(nested?.lede).toBe("This page shows what the portal does today and what is next."); // the lede is the lede, not what sat inside the headline
  });

  test("the first of a part is the part", () => {
    const got = read(`${GOOD}<headline>A second headline that must not replace the first one</headline>`);
    expect(got?.headline).toContain("The new portal is on track");
  });

  test("only the start of a long page is read, and hostile input costs next to nothing", () => {
    const time = (f: () => unknown) => Math.min(...[1, 2, 3].map(() => { const t0 = performance.now(); f(); return performance.now() - t0; }));
    for (const text of [`<headline>${"a ".repeat(5_000_000)}`, "<live-now>".repeat(200_000), "- ".repeat(2_000_000), `${GOOD}${"\n- x".repeat(1_000_000)}`, "[a](".repeat(500_000)]) {
      expect(time(() => read(text))).toBeLessThan(300);
    }
    expect(read(`${GOOD}${"\n- x".repeat(1_000_000)}`)).not.toBeNull();
  });
});

describe("cleaning one string", () => {
  const clean = (s: string, max = 180) => cleanStoryLine(s, max, prefixes);

  test("markdown and markup are plain text: markers, headings, links keep their words, tags go", () => {
    expect(clean("**Sign-in** is _live_ and `works`")).toBe("Sign-in is live and works");
    expect(clean("## Heading words here")).toBe("Heading words here");
    expect(clean("See [the plan](https://example.com/plan?x=1) for more")).toBe("See the plan for more");
    expect(clean("This <b>bold</b> <i>claim</i> holds")).toBe("This bold claim holds");
    expect(clean("<script>alert(1)</script>Sign-in works")).toBe("alert(1)Sign-in works");
    expect(clean("[click](javascript:alert(1)) to continue")).toBe("click to continue");
  });

  test("no link survives, in any spelling a person would click or paste", () => {
    for (const text of ["go to https://evil.example/login now", "go to HTTP://EVIL.EXAMPLE now", "go to www.evil.example now", "go to ftp://evil.example/x now", "mail mailto:a@evil.example now", "run javascript:alert(1) now", "see data:text/html;base64,PHNjcmlwdD4= now"]) {
      const out = clean(text);
      expect(out).not.toMatch(/https?:|www\.|ftp:|mailto:|javascript:|data:/i);
      expect(out).toMatch(/^(go to|mail|run|see) .*now$/);
    }
    // A link's address is taken out before the text around it is judged, however it is padded.
    expect(clean("a [b](  https://evil.example  ) c")).toBe("a b c");
  });

  test("control, zero-width and direction-changing characters are removed, so a line reads as it looks", () => {
    expect(clean("pri​cing pa‮ge\u0007 shipped⁠")).toBe("pricing page shipped");
    expect(clean("line one\nline two\ttabbed")).toBe("line one line two tabbed");
  });

  test("card keys of the team's projects, current and earlier, are removed with what they leave empty", () => {
    expect(clean("POR-12 sign-in shipped (POR-13-7f3a09c1) and OLD-4 too")).toBe("sign-in shipped and too");
    expect(clean("POR-12")).toBeNull();
    expect(clean("ABC-12 is another team's key and stays")).toBe("ABC-12 is another team's key and stays");
  });

  test("a secret is redacted, a join code removes the whole string, a plain wk1 (a week) stays", () => {
    const secret = clean("the key is sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAA ok") as string;
    expect(secret).not.toContain("sk-ant-api03");
    expect(clean(`the invite wk1${"B".repeat(50)} was shared`)).toBeNull();
    expect(clean(`the invite w​k1${"B".repeat(50)} was shared`)).toBeNull();
    expect(clean(`wk1 ${"B ".repeat(45)} shared`)).toBeNull();
    const week = clean("The wk1 launch checklist for the new pricing page rollout was finished early by the team") as string;
    expect(week).toContain("wk-1");
    expect(containsJoinCredential(week)).toBe(false);
  });

  test("a disguise (an accent that composes with its letter, a blank-looking filler) cannot keep a join code or a card key in a line", () => {
    const code = `wk1${"aB3-".repeat(10)}`;
    // "a" and a combining acute read as one letter, which breaks the run of code characters the daemon's own check looks for.
    expect(clean(`the invite ${code.slice(0, 4)}\u0301${code.slice(4)} was shared`)).toBeNull();
    // A Hangul filler shows nothing and is not a space, so the daemon's check does not strip it either.
    expect(clean(`the invite ${code.slice(0, 9)}\u3164${code.slice(9)} was shared`)).toBeNull();
    const keyed = clean("POR\u3164-12 sign-in shipped") as string;
    expect(keyed).not.toContain("12");
    expect(keyed).toContain("sign-in shipped");
    // Honest accents are left as written.
    expect(clean("The café menu and the São Paulo office are live")).toBe("The café menu and the São Paulo office are live");
  });

  test("whatever comes out can be posted: the daemon's own join-code check passes every string", () => {
    for (const s of ["fine words", `wk1${"Q".repeat(60)}`, "week wk1 and wk12", `x wk1 ${"a1b2 ".repeat(12)}`]) {
      const out = clean(s);
      expect(out === null || !containsJoinCredential(out)).toBe(true);
    }
  });

  test("spacing is tidied, the length is capped at a word with an ellipsis, and nothing at all is null", () => {
    expect(clean("  many    spaces \n here  ")).toBe("many spaces here");
    expect(clean("one two three four five six", 15)).toBe("one two three…");
    expect(clean("x".repeat(300), 20)).toHaveLength(20);
    expect(clean("   ")).toBeNull();
    expect(clean("")).toBeNull();
    expect(clean("**  **")).toBeNull();
  });

  test("an astral character is never cut in half", () => {
    const out = clean(`${"a".repeat(18)}😀😀😀`, 20) as string;
    expect(out.length).toBeLessThanOrEqual(20);
    expect(out).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/); // no high surrogate without its low one
    expect(out).not.toMatch(/(?<![\ud800-\udbff])[\udc00-\udfff]/);
  });
});

describe("a report made from the page alone", () => {
  const story: StoryParts = {
    headline: "On track: sign-in is live", lede: "This page shows what the portal does today.",
    live_now: ["Customers can sign in."], landing_next: ["Billing is next."],
  };
  test("when a block has a good page but no usable report text, the post is made from the page", () => {
    expect(storyAsReport(story)).toBe("**On track: sign-in is live**\n\nThis page shows what the portal does today.\n\n**Live now**\n- Customers can sign in.\n\n**Landing next**\n- Billing is next.");
  });
  test("an empty list says so", () => {
    expect(storyAsReport({ ...story, live_now: [], landing_next: [] })).toContain("**Live now**\n- Nothing yet.\n\n**Landing next**\n- Nothing yet.");
  });
});
